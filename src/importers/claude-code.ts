import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { parseFrontmatter } from "../core/frontmatter.js";
import { exists, listFiles, parseYaml, typeFolder, FORGE_MANIFEST, readIngredientText } from "../core/forge.js";
import { manifestWithSections } from "../core/manifest-edit.js";
import { decodeForScan, findSecrets, hasUtf16Bom } from "../core/secrets.js";
import { registrationCitations, serverSecret, windowsOnlyLauncher, launcherImportWarning } from "../core/mcp-server.js";
import { errorText, schemaFault } from "../core/schema-fault.js";
import { stripBom, toLf } from "../core/text.js";
import { fingerprintDir, fingerprintOf, type DirReader } from "../core/fingerprint.js";
import { FORGE_SCHEMA_SECTIONS, IngredientSchema, ProfileSchema, RecipeSchema, TARGETS, WorkspaceConfigSchema, type Ingredient, type McpServer, type Profile, type Sections, type Target } from "../schema/index.js";
import { isDeepStrictEqual } from "node:util";
import { readsPrimary, resolve, sectionKey, type Resolution } from "../core/resolve.js";
import { readsRulesIndex, RULES_INDEX_KEY, RULES_INDEX_LINE } from "../core/rules-index.js";
import { effectiveProfile } from "../core/integrations.js";
import { classifyForge, credentialFault } from "../core/remote.js";
import { parseWorkspaceYaml } from "../core/workspace-yaml.js";
import { editYamlText } from "../core/yaml-edit.js";
import { resolvedBy } from "../core/param-writes.js";
import { decide, forgeBefore, pin, registrationCarry, sourceKeys, valuesAt, workspaceParams, workspaceSections, workspaceTargets, type RunContext } from "./decide.js";
import { providedByBlock } from "./provided.js";
import { citedKeys, expandedTexts, readBase, renderMap, renderedFingerprint, type ImportBase } from "../core/template-import.js";
import { firstMarkerLine, readsTargetSections } from "../core/sections.js";
import { bodyFile } from "../core/extract.js";
import { GENERATED_BANNER, kiroReport, textLines, type KiroReport } from "./kiro-report.js";
import { preferKiro } from "./prefer-kiro.js";
import { agentsMdOnly as isAgentsMdOnly, appliesTo, buildRuleLookup, expandRulesIndex, flatSkillWarning, outName, resolveRuleRefs, type RuleLookup } from "../emitters/shared.js";
import { CAPABILITIES } from "../core/capabilities.js";
import { deepMerge } from "../core/merge.js";
import { AGENTS_MD_PRIMARY_KEY } from "../emitters/agents-md.js";
import { parseYamlText } from "../core/yaml-read.js";
import { note, type WriteJournal } from "../core/unify.js";

export interface ImportOptions {
  workspaceRoot: string;
  forgeRoot: string;
  profileName: string;
  /** Also write craftar.yaml into the workspace. */
  writeWorkspaceConfig?: boolean;
  /** Also compute the Kiro part of the report, from the flushed Forge (spec 29 §4.2). */
  report?: boolean;
  /** Rules to read from `.kiro/steering/<name>.md` instead of `.claude/rules/<name>.md` (spec 29 §4.3), already parsed. */
  preferKiro?: string[];
}

export interface ImportReport {
  created: string[];
  reused: string[];
  variants: { name: string; reason: string }[];
  /** Ingredients not imported because they hold a secret-like value (reason names the location, never the value). */
  rejected: { name: string; reason: string }[];
  recipes: string[];
  profile: string;
  warnings: string[];
  /** Reused because the render matched and used at least one value (spec 10 §6.2); `sections`, the ones a value filled (spec 11 §4.3). */
  rendered: { name: string; keys: string[]; sections?: string[] }[];
  /** Reused through an inference: every hole's proved value (spec 10 §6.3). */
  inferred: { name: string; values: Record<string, string> }[];
  /** The profile change, in the order it was accepted; `old` is null for an added key. */
  params: { key: string; old: string | null; value: string; from: string }[];
  /** Reused through a section inference: every open section it assigned (spec 11 §6.8). */
  sectioned: { name: string; sections: string[] }[];
  /** The section change `Δs`, in the order it was accepted; `old` is null when the profile did not set it (spec 11 §6.9). */
  sections: { key: string; name: string; old: string | null; value: string; from: string }[];
  /** Shared recipes this run did not use for the profile, and the owned recipe it used instead (spec 10 §6.7). */
  recipeSplits: { shared: string; owned: string; reason: string }[];
  /** Sources left to an integration recipe: not scanned, not compared, not written (spec 33 §5.3). */
  leftToRecipes: { recipe: string; slot: string; refs: string[] }[];
  /** What happened to profiles/<p>/profile.yaml. */
  profileWrite: { path: string; action: "created" | "edited" | "unchanged"; fields: string[] };
  /** What happened to craftar.forge.yaml: created, bumped to `schema: 2`, or left alone (spec 11 §6.14). */
  manifestWrite: "created" | "edited" | "unchanged";
  /** What happened to the workspace's craftar.yaml; null without --write-config. */
  configWrite: "created" | "edited" | "unchanged" | null;
  /** A remote `forge` craftar.yaml already named, kept as written by --write-config (spec 13 §4.5); else null. */
  configForgeKept: string | null;
  /** The Kiro part of the report (spec 29 §4.2); the key is absent unless the `report` option asked for it. */
  kiro?: KiroReport;
  /**
   * The rules taken from their steering file (spec 29 §4.3), one per named rule that was decided: `ref` as decided, the
   * two workspace files and their line counts, and whether the text built differs from the rule file's. The key is
   * absent unless the `preferKiro` option named a rule.
   */
  preferKiro?: { ref: string; source: string; steeringLines: number; rule: string; ruleLines: number; differs: boolean }[];
}

/** Rules that every workspace shares by intent — they seed the `base` recipe. */
const BASE_RULES = new Set([
  "README",
  "workflow",
  "commit-conventions",
  "commit-identity",
  "branch-and-pr",
  "review-posture",
  "worktrees",
  "repo-discovery",
  "handoff",
  "kiro-execution",
  "frontend-visual-verification",
]);

/**
 * Import a Claude Code workspace into a Forge. The run happens in two phases: every read,
 * comparison and check that can throw runs first against an in-memory stage, and only then are the
 * staged files written. A failure in the first phase therefore leaves the Forge untouched, and the
 * error says so; a failure while writing names the paths already written.
 */
export async function importClaudeCode(opts: ImportOptions): Promise<ImportReport> {
  const stage = new ForgeStage(path.resolve(opts.forgeRoot));
  let planned: { report: ImportReport; targets: Target[]; config: PlannedConfig | null };
  try {
    planned = await planImport(opts, stage);
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\nThe Forge was left untouched.`, { cause: e });
  }
  await stage.flush();
  const { report, config } = planned;
  if (config && config.action !== "unchanged") {
    try {
      await fs.writeFile(config.abs, config.content);
    } catch (e) {
      throw new Error(
        `The Forge was written in full and the import succeeded; writing craftar.yaml failed (${e instanceof Error ? e.message : String(e)}) — ` +
          `fix the cause and re-run with --write-config, or edit craftar.yaml by hand.`,
        { cause: e },
      );
    }
  }
  if (config?.action === "created") report.created.push("craftar.yaml (workspace)");
  // Spec 29 §4.2: after the flush, and never able to fail an import that succeeded.
  if (opts.report) {
    const preferred = (report.preferKiro ?? []).map((x) => x.source.replace(/^\.kiro\/steering\//, "").replace(/\.md$/, ""));
    report.kiro = await kiroReport({ workspaceRoot: opts.workspaceRoot, forgeRoot: opts.forgeRoot, profile: opts.profileName, targets: planned.targets, preferred });
    if (report.kiro.kind === "not-computed") report.warnings.push(`import report: Kiro sections not computed: ${report.kiro.message}`);
  }
  return report;
}

/** One ingredient read from the workspace, not yet decided (spec 10 §3, *Source*). */
interface Source {
  meta: Ingredient;
  files: Record<string, string | Buffer>;
  scan: Record<string, string>;
  after: (ref: string) => void;
  skip?: () => boolean;
  /** Lines of the source file above the text in `files`, when it is not the file's own top (a rule read from its steering mirror). */
  lineOffset?: number;
  /** The source target for section projection (spec 41 Part B §5.2): "claude-code" for .claude/ sources, "kiro" for --prefer-kiro. */
  sourceTarget?: "claude-code" | "kiro";
}

interface PlannedConfig {
  abs: string;
  content: string;
  action: "created" | "edited" | "unchanged";
  /** The remote `forge` kept as written, when there was one. */
  keptRemote: string | null;
}

async function planImport(opts: ImportOptions, stage: ForgeStage): Promise<{ report: ImportReport; targets: Target[]; config: PlannedConfig | null }> {
  const ws = path.resolve(opts.workspaceRoot);
  const forge = stage.root;
  const report: ImportReport = {
    created: [], reused: [], variants: [], rejected: [], recipes: [], profile: opts.profileName, warnings: [], rendered: [], inferred: [], params: [], sectioned: [], sections: [], recipeSplits: [], leftToRecipes: [],
    profileWrite: { path: `profiles/${opts.profileName}/profile.yaml`, action: "unchanged", fields: [] },
    manifestWrite: "unchanged",
    configWrite: null,
    configForgeKept: null,
  };
  const claudeDir = path.join(ws, ".claude");
  if (!(await exists(claudeDir))) throw new Error(`${claudeDir} not found — is this a Claude Code workspace?`);

  // The manifest is staged after the decisions (spec 11 §6.13 step 7): its schema depends on them.
  const manifestOnDisk = path.join(forge, FORGE_MANIFEST);

  const origin = (rel: string) => ({ workspace: path.basename(ws), path: rel.replace(/\\/g, "/") });
  // Two passes (spec 10 §6.8): every source is read first, in today's order, then decided in that
  // order. `after` does the bookkeeping today's code did right after each decision.
  const queue: Source[] = [];
  const read = (meta: Ingredient, files: Record<string, string | Buffer>, scan: Record<string, string>, after: (ref: string) => void, skip?: () => boolean, sourceTarget?: "claude-code" | "kiro") =>
    queue.push({ meta, files, scan, after, skip, sourceTarget });
  const refs = { base: [] as string[], stacks: new Map<string, string[]>(), steering: [] as string[] };
  const ruleNames: string[] = [];
  const scopedRules = new Map<string, string>(); // rule name → fileMatchPattern

  /* ---- Kiro steering gives us inclusion modes and hand-written steering ---- */
  const steeringDir = path.join(ws, ".kiro", "steering");
  const steeringMeta = new Map<string, { inclusion: string; fileMatchPattern?: string; generated: boolean; setsInclusion: boolean; text: string; scan?: string }>();
  if (await exists(steeringDir)) {
    for (const f of (await fs.readdir(steeringDir)).sort()) {
      if (!f.endsWith(".md")) continue;
      const src = await readSource(path.join(steeringDir, f));
      const text = toLf(stripBom(src.text));
      const { data, body, raw } = parseFrontmatter<{ inclusion?: string; fileMatchPattern?: string }>(text);
      steeringMeta.set(f.replace(/\.md$/, ""), {
        inclusion: data.inclusion ?? "always",
        fileMatchPattern: data.fileMatchPattern,
        generated: GENERATED_BANNER.test(body.slice(0, 300)),
        setsInclusion: raw !== null && data.inclusion !== undefined,
        text,
        scan: src.scan,
      });
    }
  }

  /* ---- rules ---- */
  for (const f of await safeList(path.join(claudeDir, "rules"))) {
    if (!f.endsWith(".md")) continue;
    const name = f.replace(/\.md$/, "");
    const sm = steeringMeta.get(name);
    const emitted = await readEmitted(claudeDir, "rule", f, origin, sm ? { inclusion: sm.inclusion, fileMatchPattern: sm.fileMatchPattern, generated: sm.generated, setsInclusion: sm.setsInclusion } : undefined);
    if (!emitted) continue;
    // Copy any warnings from readEmitted into the report
    if (emitted.warnings) {
      for (const w of emitted.warnings) report.warnings.push(w);
    }
    const ruleMeta = emitted.meta as Ingredient & { inclusion: string; fileMatchPattern?: string | string[] };
    read(emitted.meta, emitted.files, emitted.scan, (ref) => {
      // The output name: a variant's ref is <name>--<profile>, and the steering file it mirrors is <name> (spec 29 §19.6).
      ruleNames.push(name);
      // Use the rule's own fileMatchPattern (from paths: or from steering), joined with comma for stack recipe
      if (ruleMeta.inclusion === "fileMatch") {
        const pattern = ruleMeta.fileMatchPattern;
        const patternStr = Array.isArray(pattern) ? pattern.join(",") : pattern ?? "";
        scopedRules.set(ref, patternStr);
      } else {
        refs.base.push(ref);
      }
    });
  }

  /* ---- agents ---- */
  const agentBodies = new Map<string, string>();
  for (const f of await safeList(path.join(claudeDir, "agents"))) {
    if (!f.endsWith(".md")) continue;
    const emitted = await readEmitted(claudeDir, "agent", f, origin);
    if (!emitted) continue;
    const agentMeta = emitted.meta as Ingredient & { description?: string };
    read(emitted.meta, emitted.files, emitted.scan, (ref) => {
      agentBodies.set(ref, (agentMeta.description ?? "") + "\n" + (emitted.files["agent.md"] as string));
      refs.base.push(ref);
    });
  }

  /* ---- commands ---- */
  for (const f of await safeList(path.join(claudeDir, "commands"))) {
    if (!f.endsWith(".md")) continue;
    const emitted = await readEmitted(claudeDir, "command", f, origin);
    if (!emitted) continue;
    read(emitted.meta, emitted.files, emitted.scan, (ref) => addRef(refs.base, ref));
  }

  /* ---- skills ---- */
  const skillsDir = path.join(claudeDir, "skills");
  if (await exists(skillsDir)) {
    // Sorted, so the decision order — and which of two sources is "the later one" — is reproducible (spec 10 §14 Q6).
    for (const e of (await fs.readdir(skillsDir, { withFileTypes: true })).sort((x, y) => x.name.localeCompare(y.name))) {
      if (e.name === ".gitkeep") continue;
      const emitted = await readEmitted(claudeDir, "skill", e.name, origin);
      if (!emitted) {
        if (e.isDirectory()) report.warnings.push(`skill dir ${e.name} has no SKILL.md; skipped`);
        continue;
      }
      read(emitted.meta, emitted.files, emitted.scan, (ref) => addRef(refs.base, ref));
    }
  }

  // Warn about flat skills (spec 44 §5): after skills are read, warn if any have layout: file
  const flatSkillNames = queue
    .filter((q) => q.meta.type === "skill" && q.meta.layout === "file")
    .map((q) => outName(q.meta))
    .sort();
  if (flatSkillNames.length > 0) {
    report.warnings.push(flatSkillWarning(flatSkillNames, "import"));
  }

  /* ---- scripts & hooks ---- */
  for (const kind of ["scripts", "hooks"] as const) {
    const type = kind === "scripts" ? "script" : "hook";
    // Read each file and group by the base name (lowercased) that readEmitted gives
    const emittedList: EmittedSource[] = [];
    for (const f of await safeList(path.join(claudeDir, kind))) {
      if (f === ".gitkeep" || f.startsWith("__pycache__") || f.endsWith(".pyc")) continue;
      const emitted = await readEmitted(claudeDir, type, f, origin);
      if (!emitted) continue;
      emittedList.push(emitted);
    }
    // Group by ingredient name (lowercased base name)
    const groups = new Map<string, EmittedSource[]>();
    for (const e of emittedList) {
      const name = e.meta.name; // already lowercased by readEmitted
      const list = groups.get(name) ?? [];
      list.push(e);
      groups.set(name, list);
    }
    // Queue one ingredient per group
    for (const [name, parts] of groups) {
      // Case collision check: do any two files in the group have names equal ignoring case?
      const allFiles = parts.flatMap((p) => (p.meta as { files?: string[] }).files ?? []);
      const seenLower = new Map<string, string>(); // lowercase → original
      let collision: { a: string; b: string } | null = null;
      for (const f of allFiles) {
        const lower = f.toLowerCase();
        const prev = seenLower.get(lower);
        if (prev !== undefined && prev !== f) {
          // Collision: two different file names map to same lowercase
          const [a, b] = [prev, f].sort();
          collision = { a, b };
          break;
        }
        seenLower.set(lower, f);
      }
      if (collision) {
        report.rejected.push({
          name: `${type}/${name}`,
          reason: `files ${collision.a} and ${collision.b} differ only in case — they would collide on a case-insensitive checkout`,
        });
        continue;
      }
      const merged = mergeEmitted(parts);
      // Copy any warnings from mergeEmitted into the report
      if (merged.warnings) {
        for (const w of merged.warnings) report.warnings.push(w);
      }
      read(merged.meta, merged.files, merged.scan, (ref) => addRef(refs.base, ref));
    }
  }

  /* ---- MCP servers ---- */
  const mcpFile = path.join(ws, ".mcp.json");
  if (await exists(mcpFile)) {
    const raw = await fs.readFile(mcpFile, "utf8");
    let json: { mcpServers?: Record<string, unknown> };
    try {
      json = JSON.parse(stripBom(raw));
    } catch {
      throw new Error(".mcp.json is not valid JSON — fix the file and re-run import");
    }
    const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
    if (!isPlainObject(json) || ("mcpServers" in json && !isPlainObject(json.mcpServers))) {
      throw new Error(".mcp.json has no valid mcpServers object — fix the file and re-run import");
    }
    for (const [name, server] of Object.entries(json.mcpServers ?? {}) as [string, McpServer][]) {
      if (!isPlainObject(server)) {
        throw new Error(`.mcp.json server "${name}" is not an object — fix the file and re-run import`);
      }
      const winLetter = windowsOnlyLauncher(server);
      if (winLetter !== null) report.warnings.push(launcherImportWarning(name, winLetter));
      const meta: Ingredient = { type: "mcp", name, server, targets: "*", tags: [], origin: origin(".mcp.json") };
      read(meta, {}, {}, (ref) => addRef(refs.base, ref));
    }
  }

  /* ---- hand-written Kiro steering (no Claude counterpart) ---- */
  // Whether a steering file is hand-written depends on the rules decided before it, so the check runs at decision time.
  for (const [name, sm] of steeringMeta) {
    const meta: Ingredient = { type: "steering", name, file: "steering.md", targets: ["kiro"], tags: ["client"], origin: origin(`.kiro/steering/${name}.md`) };
    read(meta, { "steering.md": sm.text }, scanOf("steering.md", sm), (ref) => addRef(refs.steering, ref), () => ruleNames.includes(name) || sm.generated || name === "commands", "kiro");
  }

  /* ---- what the importing profile renders (spec 10 §6.1, §6.8 step 2) ---- */
  const loaded = await forgeBefore(forge, manifestOnDisk);
  const existing = await existingProfile(forge, opts.profileName, loaded);
  for (const w of existing.warnings) report.warnings.push(w);
  const readWs = (abs: string) => fs.readFile(abs, "utf8");

  // Detect targets this workspace writes (spec 41 Part B §5.2's variant warnings).
  const detected: Target[] = ["claude-code"];
  if (await exists(path.join(ws, ".kiro"))) detected.push("kiro");

  // Compute writtenTargets only at schema 6 (the variant warnings only fire there).
  async function writtenTargetsFor(): Promise<readonly Target[]> {
    const profileTargets = loaded?.profiles.get(opts.profileName)?.targets ?? [];
    // Union of profile targets and detected targets, in TARGETS order.
    const union = TARGETS.filter((t) => profileTargets.includes(t) || detected.includes(t));
    try {
      if (opts.writeWorkspaceConfig) {
        // With --write-config, craftar.yaml will be set to `detected`, so the next sync writes
        // craftar.local.yaml's targets when that file sets them, else detected.
        const localTargets = await workspaceTargets(ws, readWs, "import", ["craftar.local.yaml"]);
        return localTargets ?? detected;
      } else {
        // Without the flag, the workspace's targets (craftar.yaml's, else craftar.local.yaml's),
        // else the union of profile targets and detected targets.
        const wsTargets = await workspaceTargets(ws, readWs);
        return wsTargets ?? union;
      }
    } catch {
      // An invalid targets value must not fail the import — only a warning's wording depends on it.
      return opts.writeWorkspaceConfig ? detected : union;
    }
  }
  const writtenTargets = readsTargetSections(loaded?.manifest ?? { schema: 1 }) ? await writtenTargetsFor() : [];

  const ctx: RunContext = {
    P: Object.assign(Object.create(null), existing.params),
    W: await workspaceParams(ws, readWs),
    PS: structuredClone(existing.sections),
    WS: await workspaceSections(ws, readWs),
    pinned: new Map(),
    forge: loaded,
    markedBase: false,
    primaryRefs: null,
    sourceTarget: "claude-code",
    writtenTargets,
  };

  // Resolve the profile once, before the --prefer-kiro pass.
  // The result is used by primaryFor, PK6, and the index expansion step.
  // null when the profile is new or the Forge is below the gate.
  type CachedResolution = { ok: true; resolution: Resolution; lookup: RuleLookup } | { ok: false; error: unknown } | null;
  let cachedResolution: CachedResolution = null;
  if (loaded && loaded.profiles.has(opts.profileName)) {
    try {
      const { resolution, lookup } = await resolveForImport(loaded, opts.profileName, ctx, ws, readWs);
      cachedResolution = { ok: true, resolution, lookup };
    } catch (e) {
      cachedResolution = { ok: false, error: e };
    }
  }

  const primary = primaryFor(loaded, opts.profileName, ctx, cachedResolution);
  ctx.primaryRefs = primary?.refs ?? null;
  /* ---- what the block provides is left to its recipe (spec 33 §5.3) ---- */
  // Computed before --prefer-kiro so a named rule left to its recipe can be warned and skipped.
  let provided: Map<string, { recipe: string; slot: string; refs: string[] }>;
  try {
    provided = loaded?.profiles.has(opts.profileName) ? providedByBlock(loaded, opts.profileName) : new Map();
  } catch (e) {
    throw new Error(`import: profile ${opts.profileName} does not resolve (${errorText(e)}) — fix the Forge and re-run`);
  }

  /* ---- --prefer-kiro: the named rules take their text from the steering mirror (spec 29 §4.3) ---- */
  // Before the secret scan and every decision, so the text built is scanned and decided like any source. The names are
  // looked up in what was read, never joined into a path.
  if (opts.preferKiro?.length) {
    const preferred: NonNullable<ImportReport["preferKiro"]> = (report.preferKiro = []);
    const rules = new Map(queue.filter((q) => q.meta.type === "rule").map((q) => [q.meta.name, q]));
    const handSteering = new Set([...steeringMeta].filter(([n, sm]) => !rules.has(n) && !sm.generated && n !== "commands").map(([n]) => n));
    // The banner sync would write for this workspace: the importing profile's resolved `kiro.banner`, under the workspace's own.
    const set = Object.hasOwn(ctx.W, "kiro.banner") ? ctx.W["kiro.banner"] : resolvedParam(loaded, opts.profileName, "kiro.banner", existing.params);
    const banner = set === undefined || set === null ? null : String(set);

    // PK6 (spec 44 §4.7): at schema >= 7, check for {{craftar.rules.index}} in the resolved rule.
    // If the profile exists, resolve it to find variants; otherwise check the base rule directly.
    // Fail-closed (spec 44 §4.8): when the profile does not resolve, throw ONLY when some rule base
    // the profile would be compared with holds the placeholder; otherwise proceed with no index step.
    // NOTE: For new profiles, we don't fail early here — the per-name check in the loop below
    // will catch rules that hold the placeholder with a more specific error message.
    let pk6Resolution: { resolution: Resolution; lookup: RuleLookup } | null = null;
    if (loaded && readsRulesIndex(loaded.manifest) && cachedResolution) {
      if (cachedResolution.ok) {
        pk6Resolution = cachedResolution;
      } else {
        // Fail-closed for the preferred rules only (the other rules meet §4.8's check below).
        const ruleWithPlaceholder = await indexHolderInQueue(loaded, new Set(opts.preferKiro.map((n) => `rule/${n}`)), opts.profileName);
        if (ruleWithPlaceholder) {
          throw new Error(`import: profile ${opts.profileName} does not resolve on its own (${errorText(cachedResolution.error)}) and ${ruleWithPlaceholder} holds {{craftar.rules.index}} — fix the Forge and re-run`);
        }
        // No --prefer-kiro rule holds the placeholder: proceed with no index step, let the import continue
      }
    }

    for (const name of opts.preferKiro) {
      // A rule left to its recipe is not compared: warn and skip (spec 33 V1 part 2).
      const providedKey = `rule/${name}`;
      if (provided.has(providedKey)) {
        const p = provided.get(providedKey)!;
        // `ref` is the Forge ref — the first entry of the provided entry's `refs` whose type is `rule`.
        const ref = p.refs.find((r) => r.startsWith("rule/")) ?? providedKey;
        report.warnings.push(`--prefer-kiro ${name}: ${ref} is left to recipe ${p.recipe} (integrations.${p.slot}) — nothing to prefer; its steering file was not used`);
        continue;
      }

      // PK6 (spec 44 §4.7): if the resolved ingredient for this rule holds {{craftar.rules.index}}, refuse.
      // This check comes before PK3/PK4 so it catches the gate case first.
      // When the profile exists, check the resolved ingredient (which may be a variant).
      // When the profile doesn't exist but the Forge does, check the base rule directly.
      if (loaded && readsRulesIndex(loaded.manifest)) {
        let body: string | null = null;
        if (pk6Resolution) {
          // Profile exists: check the resolved ingredient (may be a variant)
          const resolved = pk6Resolution.resolution.ingredients.find(
            (i) => i.meta.type === "rule" && (i.meta.name === name || ("as" in i.meta && i.meta.as === name)),
          );
          if (resolved && resolved.meta.type === "rule") {
            body = await readIngredientText(resolved, resolved.meta.file);
          }
        } else {
          // Profile doesn't exist: check the base rule directly from the Forge
          const baseRef = `rule/${name}` as const;
          const base = loaded.ingredients.get(baseRef);
          if (base && base.meta.type === "rule") {
            body = await readIngredientText(base, base.meta.file);
          }
        }
        if (body !== null && RULES_INDEX_LINE.test(body)) {
          throw new Error(
            `--prefer-kiro ${name}: the rule the profile resolves holds {{craftar.rules.index}} — ` +
              `its steering text holds the generated list, which import would freeze`,
          );
        }
      }

      const q = rules.get(name);
      if (!q) throw new Error(`import: --prefer-kiro ${name}: there is no .claude/rules/${name}.md — --prefer-kiro takes rules; a steering file with no rule is already imported as steering`);
      const sm = steeringMeta.get(name);
      if (!sm) throw new Error(`import: --prefer-kiro ${name}: there is no .kiro/steering/${name}.md to prefer`);
      const ruleText = q.files["rule.md"] as string;
      // The Claude file as written: a split rule's fence counts toward its lines
      const ruleRaw = "frontmatterRaw" in q.meta ? q.meta.frontmatterRaw : undefined;
      const ruleFileText = ruleRaw !== undefined ? `---\n${ruleRaw}\n---\n${ruleText}` : ruleText;
      const { text, offset } = preferKiro({ name, steering: sm.text, rules: new Set(rules.keys()), handSteering, banner });
      const source = `.kiro/steering/${name}.md`;
      q.files = { "rule.md": text };
      q.scan = scanOf("rule.md", sm);
      q.lineOffset = offset;
      q.meta = { ...q.meta, origin: origin(source) };
      q.sourceTarget = "kiro"; // Spec 41 Part B §5.2: prefer-kiro rules infer from kiro's view of the sections
      // A steering body written before rules kept their frontmatter apart still holds the fence: the
      // text then carries it, as it did, and the rule's own copy is dropped so the file is not written twice.
      if ("frontmatterRaw" in q.meta && q.meta.frontmatterRaw !== undefined && parseFrontmatter(text).raw !== null) {
        const { frontmatterRaw: _dropped, ...rest } = q.meta;
        q.meta = rest as Ingredient;
      }
      const after = q.after;
      q.after = (ref) => {
        after(ref);
        // What sync will write to .claude/rules/<name>.md: if frontmatterRaw is still present, the fence
        // wraps the body; otherwise the body alone (it may carry its own fence).
        const raw = "frontmatterRaw" in q.meta ? (q.meta as { frontmatterRaw?: string }).frontmatterRaw : undefined;
        const written = raw !== undefined ? `---\n${raw}\n---\n${text}` : text;
        preferred.push({ ref, source, steeringLines: textLines(sm.text), rule: `.claude/rules/${name}.md`, ruleLines: textLines(ruleFileText), differs: written !== ruleFileText });
      };
    }
  }
  // Filter the queue in place: skip every source whose `<type>/<outName>` is a key of `provided`.
  // For each skipped rule, push its name to `ruleNames` so the steering check does not import it.
  // Track recipes in the order the first skipped source of each was read (queue order).
  const recipeOrder: string[] = [];
  const recipeData = new Map<string, { slot: string; refs: string[] }>();
  // Iterate forward through queue to record order, but splice backward to avoid index issues.
  const toSplice: number[] = [];
  for (let i = 0; i < queue.length; i++) {
    const src = queue[i];
    const key = `${src.meta.type}/${outName(src.meta)}`;
    const p = provided.get(key);
    if (p) {
      toSplice.push(i);
      if (src.meta.type === "rule") ruleNames.push(src.meta.name);
      // Track the recipe in the order the first skipped source of each was read.
      if (!recipeData.has(p.recipe)) {
        recipeOrder.push(p.recipe);
        recipeData.set(p.recipe, { slot: p.slot, refs: [] });
      }
      // Add refs (unique, in resolution order from providedByBlock).
      const entry = recipeData.get(p.recipe)!;
      for (const r of p.refs) if (!entry.refs.includes(r)) entry.refs.push(r);
    }
  }
  // Splice in reverse order to avoid index shifting.
  for (let i = toSplice.length - 1; i >= 0; i--) {
    queue.splice(toSplice[i], 1);
  }
  // Build the report in the order the first skipped source of each recipe was read.
  for (const recipe of recipeOrder) {
    const { slot, refs } = recipeData.get(recipe)!;
    report.leftToRecipes.push({ recipe, slot, refs });
  }
  // F9 (§6.5): a source rejected for a secret or skipped is never decided. Its base stays in the Forge-wide scan (b),
  // and its text leaves the literal check (c). `ruleNames` fills only as rules are decided, so each set errs on its
  // safe side for a steering file a rule of its name may shadow: out of `runBases`, still in `others`.
  const queuedRules = new Set(queue.filter((q) => q.meta.type === "rule").map((q) => q.meta.name));
  const queuedIndexable = new Set(queue.filter((q) => q.meta.type === "rule" || q.meta.type === "steering").map((q) => `${q.meta.type}/${q.meta.name}`));
  const mayBeSkipped = (q: Source) => q.skip?.() || (q.meta.type === "steering" && queuedRules.has(q.meta.name));
  const clean = queue.filter((q) => !secretIn(q.meta, q.files, q.scan, q.lineOffset));
  const runBases = new Set(clean.filter((q) => !mayBeSkipped(q)).map((q) => `${q.meta.type}/${q.meta.name}`));
  const mayBeDecided = clean.filter((q) => !q.skip?.());
  const literal: Array<{ ref: string; source: string; meta: Ingredient; files: Record<string, string | Buffer>; lineOffset?: number }> = [];

  // Spec 44 §4.8: at schema >= 7, build the index expansion function for rule re-import comparison.
  // The function expands {{craftar.rules.index}} using the Forge's resolved ingredients.
  // Fail-closed: when the profile does not resolve, throw ONLY when a rule base the profile would
  // be compared with holds the placeholder (spec 44 §4.8: "a base the importing profile would be compared with").
  let indexExpand: ((text: string, target: "claude-code" | "kiro") => string) | undefined;
  if (loaded && readsRulesIndex(loaded.manifest)) {
    if (cachedResolution) {
      if (cachedResolution.ok) {
        const { resolution, lookup } = cachedResolution;
        indexExpand = (text: string, target: "claude-code" | "kiro") => expandRulesIndex(text, target, lookup, resolution).text;
      } else {
        // Fail-closed: check only the rules this import compares, not all rules in the Forge
        const ruleWithPlaceholder = await indexHolderInQueue(loaded, queuedIndexable, opts.profileName);
        if (ruleWithPlaceholder) {
          throw new Error(`import: profile ${opts.profileName} does not resolve on its own (${errorText(cachedResolution.error)}) and ${ruleWithPlaceholder} holds {{craftar.rules.index}} — fix the Forge and re-run`);
        }
        // No base this import compares holds the placeholder: proceed with no index step, let the import continue
      }
    } else {
      // A new profile: fail closed only when an ingredient this import compares holds the placeholder
      const ruleWithPlaceholder = await indexHolderInQueue(loaded, queuedIndexable, opts.profileName);
      if (ruleWithPlaceholder) {
        throw new Error(`import: profile ${opts.profileName} is not in the Forge and ${ruleWithPlaceholder} holds {{craftar.rules.index}} — import cannot compare that base as sync writes it; create the profile first (craftar init --new-profile ${opts.profileName} --no-sync in another directory), then re-run`);
      }
    }
  }

  /* ---- decide, in read order ---- */
  for (const src of queue) {
    if (src.skip?.()) continue;
    const others = mayBeDecided.filter((q) => q !== src).map((q) => ({ ref: `${q.meta.type}/${q.meta.name}`, meta: q.meta, files: q.files }));
    // Spec 41 Part B §5.2: use the source's target for section projection (kiro for --prefer-kiro, else claude-code)
    ctx.sourceTarget = src.sourceTarget ?? "claude-code";
    const ref = await writeIngredient(stage, src.meta, src.files, opts.profileName, report, src.scan, { ctx, others, runBases, literal, lineOffset: src.lineOffset, indexExpand });
    if (ref) src.after(ref);
  }
  // Reset sourceTarget to claude-code for any remaining operations
  ctx.sourceTarget = "claude-code";

  // I3: a created or variant ingredient is the workspace text itself; a key the profile now sets would change it at sync.
  // I11 first (spec 11 §6.9): a column-0 marker in that text would be read as structure, so sync could not reproduce it.
  for (const l of literal) {
    const marker = markerIn(l.meta, l.files, l.source, l.lineOffset);
    if (marker) throw new Error(`import: ${marker.where} holds a section marker on line ${marker.line} — sync would not reproduce it; indent it or remove it, and re-run`);
    const map = renderMap(l.meta, ctx.P, ctx.W);
    const key = [...sourceKeys(l.meta, l.files)].find((k) => Object.hasOwn(map, k));
    if (key) {
      // Spec 33 §5.3: say "integrations set" when the key is one the block gives (not overridden by params).
      const who = existing.blockKeys.includes(key) ? `profile ${opts.profileName}'s integrations set` : `profile ${opts.profileName} sets`;
      throw new Error(`import: ${l.source} holds {{${key}}} literally, but ${who} ${key} — sync would render it`);
    }
  }

  // Spec 27 §5.3: report a declaration a profile loses — the run's MCP refs keyed by server name.
  const afterMcp = new Map<string, { ref: string; authEnv?: string[] }>();
  for (const ref of [...report.reused, ...report.variants.map((v) => v.name), ...report.created].filter((r) => r.startsWith("mcp/"))) {
    // Read the final ingredient as written/reused.
    const ingredientFile = path.join(forge, "ingredients", typeFolder("mcp"), ref.slice(4), "ingredient.yaml");
    if (await stage.exists(ingredientFile)) {
      const ing = parseYaml(ingredientFile, await stage.readText(ingredientFile), IngredientSchema);
      if (ing.type === "mcp") {
        const serverName = outName(ing);
        afterMcp.set(serverName, { ref, authEnv: ing.authEnv });
      }
    }
  }
  // What the importing profile resolved before the run — only when the profile already exists.
  // A profile new to the Forge has no *before*, so no lost-declaration warning.
  if (loaded && loaded.profiles.has(opts.profileName)) {
    let resolved: Resolution | null = null;
    try {
      resolved = resolve(loaded, WorkspaceConfigSchema.parse({ forge: ".", profile: opts.profileName }));
    } catch (e) {
      // The profile exists in the Forge but does not resolve (e.g. two recipes on one slot).
      // Only warn when the Forge declares authEnv somewhere — otherwise 0.17.4 was silent (spec 27 §10 criterion 2).
      const forgeDeclaresAuthEnv = [...loaded.ingredients.values()].some((ing) => ing.meta.type === "mcp" && ing.meta.authEnv && ing.meta.authEnv.length > 0);
      if (forgeDeclaresAuthEnv) {
        const msg = e instanceof Error ? e.message.replace(/[\r\n]+/g, " ") : String(e);
        report.warnings.push(`profile ${opts.profileName} did not resolve before this import (${msg}) — authEnv declarations were not compared`);
      }
    }
    if (resolved) {
      const beforeMcp = new Map<string, { ref: string; authEnv?: string[] }>();
      for (const ing of resolved.ingredients) {
        if (ing.meta.type === "mcp") beforeMcp.set(outName(ing.meta), { ref: ing.ref, authEnv: ing.meta.authEnv });
      }
      for (const [serverName, before] of beforeMcp) {
        const after = afterMcp.get(serverName);
        if (!after) continue; // Server gone from workspace or rejected — nothing lost in the Forge.
        const afterNames = after.authEnv ?? [];
        const lost = (before.authEnv ?? []).filter((n) => !afterNames.includes(n));
        if (lost.length > 0) {
          report.warnings.push(`mcp/${serverName}: ${lost.join(", ")} declared by ${before.ref} is not declared by ${after.ref}`);
        }
      }
    }
  }

  /* ---- recipes ---- */
  const recipesDir = path.join(forge, "recipes");
  const isVariant = (ref: string) => report.variants.some((v) => v.name === ref);
  const recipeOpts: RecipeOptions = { stage, dir: recipesDir, profile: opts.profileName, forge: ctx.forge, report, currentRules: currentRuleOrder(ctx.forge, opts.profileName), agentsMdOnly: primary?.agentsMdOnly ?? new Set() };

  const stackRecipes: string[] = [];
  for (const [ruleRef, pattern] of scopedRules) {
    const ruleName = ruleRef.split("/")[1].replace(/--.*$/, "");
    const agents = [...agentBodies].filter(([ref, body]) => agentBelongsTo(ref.split("/")[1], ruleName, body)).map(([ref]) => ref);
    for (const a of agents) refs.base = refs.base.filter((r) => r !== a);
    const ingredients = [ruleRef, ...agents];
    stackRecipes.push(await placeRecipe(recipeOpts, `stack-${ruleName}`, ingredients, `Conventions + reviewer for repos matching ${pattern}`, ingredients.some(isVariant)));
  }

  const baseIngredients = unique(refs.base);
  const baseName = await placeRecipe(recipeOpts, "base", baseIngredients, "Always-on conventions, commands, agents, scripts and MCP servers.", baseIngredients.some(isVariant));
  const profileRecipes = [baseName, ...stackRecipes];
  if (refs.steering.length) {
    const n = `${opts.profileName}-steering`;
    await writeOwnedRecipe(recipeOpts, n, refs.steering, `Hand-written Kiro steering specific to ${opts.profileName}.`);
    profileRecipes.push(n);
  }

  /* ---- profile ---- */
  const targets = detected; // Computed earlier for writtenTargets.
  const profile: ImportedProfile = {
    name: opts.profileName,
    description: `Imported from ${path.basename(ws)} on ${new Date().toISOString().slice(0, 10)}.`,
    recipes: profileRecipes,
    targets,
    language: {},
    identity: {},
    scm: await sniffScm(claudeDir),
    naming: {},
    frontend: {},
    executor: (await exists(path.join(claudeDir, "rules", "kiro-execution.md"))) ? { kind: "kiro", terminal: "orca" } : {},
    integrations: {},
    // A new profile holds the values this run inferred, in acceptance order (spec 10 §6.6).
    params: Object.fromEntries(report.params.map((x) => [x.key, ctx.P[x.key]])),
    // …and the section values it inferred, only when there are some: a profile without them keeps today's bytes (spec 11 §6.10).
    ...(report.sections.length ? { sections: sectionChange(report, ctx) } : {}),
    repos: [],
  };
  await writeProfile(stage, forge, opts.profileName, profile, ctx, report);
  report.manifestWrite = await stageManifest(stage, forge, report.sections.length > 0 || ctx.markedBase);
  // Listed first, where it was when the manifest was staged at the start of the run.
  if (report.manifestWrite === "created") report.created.unshift(FORGE_MANIFEST);
  const config = opts.writeWorkspaceConfig ? await planConfig(ws, forge, opts.profileName, targets) : null;
  report.configWrite = config?.action ?? null;
  report.configForgeKept = config?.keptRemote ?? null;
  return { report, targets, config };
}

/**
 * The Forge as the import run sees it: the files on disk overlaid with the files this run has staged.
 * Nothing touches the disk until `flush()`, so every check that can throw runs before the first write.
 * Reads go through the overlay so that a later step sees an earlier step's output exactly as the
 * write-as-you-go importer did (two scripts that map to one ingredient name, for instance).
 */
export class ForgeStage {
  private readonly files = new Map<string, string | Buffer>();
  constructor(readonly root: string) {}

  write(abs: string, content: string | Buffer): void {
    this.files.set(abs, content);
  }

  async exists(abs: string): Promise<boolean> {
    return this.files.has(abs) || (await exists(abs));
  }

  async readText(abs: string): Promise<string> {
    const staged = this.files.get(abs);
    if (staged === undefined) return fs.readFile(abs, "utf8");
    return Buffer.isBuffer(staged) ? staged.toString("utf8") : staged;
  }

  /** A `fingerprintDir` reader over the overlay: staged files win over files on disk at the same path. */
  reader(): DirReader {
    return {
      readText: (abs) => this.readText(abs),
      readBytes: async (abs) => {
        const staged = this.files.get(abs);
        if (staged === undefined) return fs.readFile(abs);
        return Buffer.isBuffer(staged) ? staged : Buffer.from(staged, "utf8");
      },
      list: async (dir) => {
        const prefix = dir + path.sep;
        const staged = [...this.files.keys()].filter((k) => k.startsWith(prefix)).map((k) => path.relative(dir, k).split(path.sep).join("/"));
        return [...new Set([...staged, ...((await exists(dir)) ? await listFiles(dir) : [])])].sort();
      },
    };
  }

  /** Write every staged file. A failure here names what was already written, since the Forge is no longer untouched. */
  async flush(): Promise<void> {
    const written: string[] = [];
    try {
      await fs.mkdir(this.root, { recursive: true });
      for (const [abs, content] of this.files) {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content);
        written.push(path.relative(this.root, abs).split(path.sep).join("/"));
      }
    } catch (e) {
      const already = written.length ? `already written: ${written.join(", ")}` : "nothing was written yet";
      throw new Error(`${e instanceof Error ? e.message : String(e)}\nThe import failed while writing into the Forge (${already}); restore or remove those paths before re-running.`, { cause: e });
    }
  }

  /** Staged paths in staging order, Forge-relative with `/`; `created` is false when the path exists on disk under `root`. */
  async entries(): Promise<Array<{ rel: string; abs: string; created: boolean }>> {
    const result: Array<{ rel: string; abs: string; created: boolean }> = [];
    for (const [abs] of this.files) {
      const rel = path.relative(this.root, abs).split(path.sep).join("/");
      const created = !(await exists(abs));
      result.push({ rel, abs, created });
    }
    return result;
  }

  /** Write every staged file under another root (same relative paths), in the order given by `order` (a comparator over `rel`), noting each in `journal` before it is touched. */
  async flushTo(root: string, opts?: { order?: (a: string, b: string) => number; journal?: WriteJournal }): Promise<void> {
    // Build entries in staging order
    const entries: Array<{ rel: string; content: string | Buffer }> = [];
    for (const [abs, content] of this.files) {
      const rel = path.relative(this.root, abs).split(path.sep).join("/");
      entries.push({ rel, content });
    }
    // Sort if order given
    if (opts?.order) {
      entries.sort((a, b) => opts.order!(a.rel, b.rel));
    }
    // Write each entry to the target root
    for (const { rel, content } of entries) {
      const targetAbs = path.join(root, rel);
      await note(opts?.journal, targetAbs);
      await fs.mkdir(path.dirname(targetAbs), { recursive: true });
      await fs.writeFile(targetAbs, content);
    }
  }
}

export interface EmittedSource {
  meta: Ingredient;
  files: Record<string, string | Buffer>;
  scan: Record<string, string>;
  /** Warnings from reading the source (e.g., paths: disagrees with steering). */
  warnings?: string[];
}

/**
 * Merge multiple EmittedSource parts that share a base name into one ingredient.
 * The meta of `parts[0]` is kept with `files` listing every file from all parts in order;
 * `files` and `scan` are the unions of all parts; `warnings` are concatenated (key omitted when empty).
 */
export function mergeEmitted(parts: EmittedSource[]): EmittedSource {
  if (parts.length === 0) throw new Error("mergeEmitted: parts must not be empty");
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const mergedMeta = { ...first.meta } as Ingredient & { files?: string[] };
  // Build the files list from each part's meta.files (not from their files map keys, to preserve original order)
  const filesList: string[] = [];
  for (const p of parts) {
    const partFiles = (p.meta as { files?: string[] }).files ?? [];
    for (const f of partFiles) filesList.push(f);
  }
  mergedMeta.files = filesList;
  const mergedFiles: Record<string, string | Buffer> = {};
  for (const p of parts) Object.assign(mergedFiles, p.files);
  const mergedScan: Record<string, string> = {};
  for (const p of parts) Object.assign(mergedScan, p.scan);
  const mergedWarnings: string[] = [];
  for (const p of parts) if (p.warnings) mergedWarnings.push(...p.warnings);
  return { meta: mergedMeta, files: mergedFiles, scan: mergedScan, ...(mergedWarnings.length > 0 ? { warnings: mergedWarnings } : {}) };
}

/**
 * A Claude rule's `paths:`, read from its raw frontmatter. `present` says the key is there; `value` is set only
 * when it is usable — a non-empty string, or a non-empty list of non-empty strings. YAML is tried first; when it
 * refuses the block (an unquoted `**` reads as an alias), the key is read by lines as Claude Code writes it: an
 * inline value, or `- item` lines below, each unquoted and without a trailing ` # comment`.
 */
export function rulePaths(rawText: string | null): { present: boolean; value?: string | string[] } {
  if (rawText === null) return { present: false };
  const raw = toLf(rawText);
  // A glob is one line: a block scalar's text is not one
  const glob = (i: unknown): i is string => typeof i === "string" && i.length > 0 && !i.includes("\n");
  const usable = (p: unknown): p is string | string[] => glob(p) || (Array.isArray(p) && p.length > 0 && p.every(glob));
  try {
    const data = parseYamlText("frontmatter", raw);
    if (data === null || typeof data !== "object" || !Object.hasOwn(data, "paths")) return { present: false };
    const p = (data as Record<string, unknown>).paths;
    return usable(p) ? { present: true, value: p } : { present: true };
  } catch {
    const lines = raw.split("\n");
    const at = lines.findIndex((l) => /^paths:(\s|$)/.test(l));
    if (at === -1) return { present: false };
    const scalar = (v: string): string | null => {
      const t = v.trim();
      const q = /^(["'])(.*)\1(\s+#.*)?$/.exec(t);
      if (q) return q[2];
      if (/^["']/.test(t)) return null; // an unclosed or mismatched quote
      return t.replace(/\s+#.*$/, "");
    };
    const inline = lines[at].slice("paths:".length);
    if (inline.trim() !== "" && !/^\s*#/.test(inline)) {
      const v = /^\s*[[{|>]/.test(inline) ? null : scalar(inline);
      return v ? { present: true, value: v } : { present: true };
    }
    const items: string[] = [];
    let indent: string | null = null; // every item at the first one's indent, which may be the key's own
    for (const line of lines.slice(at + 1)) {
      if (line.trim() === "" || /^\s*#/.test(line)) continue;
      if (/^\S/.test(line) && !/^-\s/.test(line)) break; // the next key
      const item = /^(\s*)-\s+(.*)$/.exec(line);
      if (item && indent === null) indent = item[1];
      const v = item && item[1] === indent ? scalar(item[2]) : null;
      if (!v) return { present: true };
      items.push(v);
    }
    return items.length ? { present: true, value: items } : { present: true };
  }
}

/**
 * One ingredient as import reads it from a workspace's `.claude/` tree. `rel` is the path under
 * `.claude/<folder>/` (a file, or a skill's directory name). Returns `null` where `planImport`
 * skips: a skill directory without `SKILL.md`, a non-file under scripts/hooks.
 */
export async function readEmitted(
  claudeDir: string,
  type: "rule" | "agent" | "command" | "skill" | "script" | "hook",
  rel: string,
  origin: (rel: string) => { workspace: string; path: string },
  steering?: { inclusion: string; fileMatchPattern?: string; generated?: boolean; setsInclusion?: boolean },
): Promise<EmittedSource | null> {
  if (type === "rule") {
    const name = rel.replace(/\.md$/, "");
    const src = await readSource(path.join(claudeDir, "rules", rel));
    const text = toLf(stripBom(src.text));
    const parsed = parseFrontmatter<{ paths?: unknown }>(text);
    const warnings: string[] = [];

    const pathsResult = rulePaths(parsed.raw);
    const hasPaths = pathsResult.present;
    const pathsValue = pathsResult.value;
    const pathsUsable = pathsValue !== undefined;

    // Determine scope by precedence:
    // 1. hand-written steering with frontmatter inclusion → use steering
    // 2. usable paths: → use paths
    // 3. generated steering → use steering
    // 4. else "always"
    let inclusion: "always" | "fileMatch" | "manual" | "auto" = "always";
    let fileMatchPattern: string | string[] | undefined;
    let frontmatterRaw: string | undefined;

    // When paths: is usable, split it out whoever sets the scope (so kiro/AGENTS.md don't carry the paths: block)
    // — unless the file ends at its closing fence with no newline, which the split could not write back.
    const useFrontmatter = pathsUsable && text.startsWith(`---\n${parsed.raw}\n---\n`);
    if (useFrontmatter) {
      frontmatterRaw = parsed.raw ?? undefined;
    }

    // Helper to check if steering scope differs from paths scope.
    // The kiro emitter writes a list as a comma-joined string, so we compare the steering pattern
    // (which is always a string) against the paths value joined by comma.
    const scopeDiffers = (steeringInclusion: string | undefined, steeringPattern: string | string[] | undefined): boolean => {
      if (!pathsUsable || pathsValue === undefined) return false;
      if (steeringInclusion !== "fileMatch") return true;
      // Compared as the kiro emitter writes a list: joined by ","
      const joined = (p: string | string[] | undefined) => (Array.isArray(p) ? p.join(",") : p);
      return joined(steeringPattern) !== joined(pathsValue);
    };

    if (steering && !steering.generated && steering.setsInclusion) {
      // Case 1: hand-written steering with inclusion set - use steering's scope
      inclusion = steering.inclusion as "always" | "fileMatch" | "manual" | "auto";
      fileMatchPattern = steering.fileMatchPattern;

      // Warn if paths: differs from steering
      if (pathsUsable && scopeDiffers(steering.inclusion, steering.fileMatchPattern)) {
        warnings.push(`rule ${name}: .kiro/steering/${name}.md and paths: in .claude/rules/${name}.md disagree; the steering file's scope is kept`);
      }
    } else if (pathsUsable && pathsValue !== undefined) {
      // Case 2: usable paths: in rule
      inclusion = "fileMatch";
      fileMatchPattern = pathsValue;

      // Warn about steering
      if (steering) {
        if (!steering.setsInclusion) {
          // steering without inclusion set
          warnings.push(`rule ${name}: .kiro/steering/${name}.md sets no inclusion; scope taken from paths: in .claude/rules/${name}.md`);
        } else if (steering.generated && scopeDiffers(steering.inclusion, steering.fileMatchPattern)) {
          // generated steering with different scope
          warnings.push(`rule ${name}: the generated .kiro/steering/${name}.md disagrees with paths: in .claude/rules/${name}.md; scope taken from paths:`);
        }
      }
    } else if (steering && steering.generated) {
      // Case 3: generated steering
      inclusion = steering.inclusion as "always" | "fileMatch" | "manual" | "auto";
      fileMatchPattern = steering.fileMatchPattern;
    } else if (steering) {
      // Case 4: any steering file (hand-written, may have no inclusion) - use its pattern as main did
      inclusion = steering.inclusion as "always" | "fileMatch" | "manual" | "auto";
      fileMatchPattern = steering.fileMatchPattern;
    }
    // else Case 5: no steering file at all → "always" (default)

    // Warn about unusable paths (the scope then follows the rest of the precedence)
    if (hasPaths && !pathsUsable) {
      warnings.push(`rule ${name}: paths: in .claude/rules/${name}.md is not a string or a list of strings; ignored`);
    }

    const meta: Ingredient = {
      type: "rule",
      name,
      inclusion,
      fileMatchPattern,
      file: "rule.md",
      ...(frontmatterRaw !== undefined ? { frontmatterRaw } : {}),
      targets: "*",
      tags: [],
      origin: origin(`.claude/rules/${rel}`),
    };

    // If using frontmatter (paths: is usable), store the body only; otherwise store whole text
    const ruleContent = useFrontmatter ? parsed.body : text;

    return { meta, files: { "rule.md": ruleContent }, scan: scanOf("rule.md", src), ...(warnings.length ? { warnings } : {}) };
  }

  if (type === "agent") {
    const src = await readSource(path.join(claudeDir, "agents", rel));
    const text = src.text;
    const { data, body, raw } = parseFrontmatter<Record<string, string>>(text, { loose: true });
    const name = (data.name || rel.replace(/\.md$/, "")).trim();
    const meta: Ingredient = {
      type: "agent",
      name,
      description: data.description?.trim(),
      tools: splitList(data.tools),
      model: data.model?.trim() || undefined,
      file: "agent.md",
      frontmatterRaw: raw ?? undefined,
      targets: "*",
      tags: [],
      origin: origin(`.claude/agents/${rel}`),
    };
    return { meta, files: { "agent.md": body }, scan: scanOf("agent.md", src) };
  }

  if (type === "command") {
    const src = await readSource(path.join(claudeDir, "commands", rel));
    const text = src.text;
    const { data, body, raw } = parseFrontmatter<Record<string, string>>(text, { loose: true });
    const meta: Ingredient = {
      type: "command",
      name: rel.replace(/\.md$/, ""),
      description: data.description?.trim(),
      argumentHint: data["argument-hint"]?.trim() || undefined,
      allowedTools: data["allowed-tools"]?.trim() || undefined,
      file: "command.md",
      frontmatterRaw: raw ?? undefined,
      targets: "*",
      tags: [],
      origin: origin(`.claude/commands/${rel}`),
    };
    return { meta, files: { "command.md": body }, scan: scanOf("command.md", src) };
  }

  if (type === "skill") {
    const skillDir = path.join(claudeDir, "skills", rel);
    const stat = await fs.lstat(skillDir).catch(() => null);
    if (!stat) return null;

    if (stat.isDirectory()) {
      const files: Record<string, string | Buffer> = {};
      const scan: Record<string, string> = {};
      for (const fileRel of await listFiles(skillDir)) {
        const abs = path.join(skillDir, fileRel);
        if (/\.(md|txt|json|ya?ml|ps1|py|sh|js|ts)$/i.test(fileRel)) {
          const src = await readSource(abs);
          files[fileRel] = toLf(stripBom(src.text));
          Object.assign(scan, scanOf(fileRel, src));
        } else {
          files[fileRel] = await fs.readFile(abs);
        }
      }
      if (!files["SKILL.md"]) return null;
      const meta: Ingredient = {
        type: "skill",
        name: rel,
        layout: "dir",
        targets: "*",
        tags: [],
        origin: origin(`.claude/skills/${rel}/`),
      };
      return { meta, files, scan };
    } else if (rel.endsWith(".md")) {
      const src = await readSource(skillDir);
      const text = toLf(stripBom(src.text));
      const meta: Ingredient = {
        type: "skill",
        name: rel.replace(/\.md$/, ""),
        layout: "file",
        targets: "*",
        tags: [],
        origin: origin(`.claude/skills/${rel}`),
      };
      return { meta, files: { "SKILL.md": text }, scan: scanOf("SKILL.md", src) };
    }
    return null;
  }

  if (type === "script" || type === "hook") {
    const kind = type === "script" ? "scripts" : "hooks";
    const abs = path.join(claudeDir, kind, rel);
    // fs.stat throws on a dangling link (ENOENT) — spec 30r1 §3.4 says we must let it throw
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return null;

    const src = /\.(ps1|py|sh|js|ts|cjs|mjs|json|md|txt|ya?ml)$/i.test(rel) ? await readSource(abs) : null;
    const content = src ? toLf(stripBom(src.text)) : await fs.readFile(abs);
    const meta: Ingredient = {
      type,
      name: rel.replace(/\.[^.]+$/, "").toLowerCase(),
      files: [rel],
      targets: ["claude-code"],
      tags: [],
      origin: origin(`.claude/${kind}/${rel}`),
    } as Ingredient;
    return { meta, files: { [rel]: content }, scan: src ? scanOf(rel, src) : {} };
  }

  return null;
}

/**
 * A reviewer agent belongs to the stack of a scoped rule when its name is derived from the rule name
 * (`backend-api-reviewer` ← `backend-api`, `frontend-reviewer` ← `frontend-angular`) and it cites the rule.
 * Generic agents such as `docs-author` stay in `base` even when they mention a stack rule.
 */
function agentBelongsTo(agentName: string, ruleName: string, body: string): boolean {
  const cites = body.includes(`.claude/rules/${ruleName}.md`);
  const stem = ruleName.split("-")[0];
  return agentName.startsWith(ruleName) || (agentName.startsWith(stem + "-") && cites);
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function addRef(list: string[], ref: string | null): void {
  if (ref) list.push(ref);
}

/** Where a rule's `frontmatterRaw` was read: its Claude file, whatever file its body came from. */
function rawSource(meta: Ingredient): string | null {
  return meta.type === "rule" ? `.claude/rules/${outName(meta)}.md` : null;
}

/** A rule whose body was taken from its steering file (`--prefer-kiro`): the body's lines are that file's. */
function bodyFromSteering(meta: Ingredient): boolean {
  return meta.type === "rule" && (meta.origin?.path ?? "").startsWith(".kiro/steering/");
}

/**
 * The file path to report in a rejection message (secret, marker).
 * - For skill dir layout: base ends with `/`, so returns `base + rel`.
 * - For grouped scripts/hooks (files.length > 1): returns `dirname(base) + "/" + rel`.
 * - Otherwise: returns `base` unchanged.
 */
function fileWhere(meta: Ingredient, base: string, rel: string): string {
  if (meta.type === "skill" && meta.layout === "dir") return `${base}${rel}`;
  if ((meta.type === "script" || meta.type === "hook") && meta.files && meta.files.length > 1) {
    return `${path.posix.dirname(base)}/${rel}`;
  }
  return base;
}

/** First secret-like value in an ingredient about to be imported, described by location only. */
export function secretIn(meta: Ingredient, files: Record<string, string | Buffer>, scan: Record<string, string> = {}, lineOffset = 0): string | null {
  const origin = meta.origin?.path ?? `${meta.type}/${meta.name}`;
  const raw = "frontmatterRaw" in meta ? meta.frontmatterRaw : undefined;
  // Bodies of agents, commands and split rules start after `---`, the raw block and the closing `---`; `lineOffset`
  // is for a text that starts lower in its source file for another reason (spec 29 §4.3). A rule's raw block is
  // always its Claude file's, while its body may come from a steering file (`--prefer-kiro`).
  const rawWhere = rawSource(meta) ?? origin;
  const bodyOffset = raw && !bodyFromSteering(meta) ? raw.split("\n").length + 2 : lineOffset;
  const texts: { where: string; text: string; offset: number }[] = [];
  if (raw) texts.push({ where: rawWhere, text: raw, offset: 1 });
  for (const [rel, content] of Object.entries(files)) {
    const where = fileWhere(meta, origin, rel);
    // A Buffer (non-allowlisted extensions such as .pem or .bat) goes through decodeForScan:
    // a UTF-16 BOM is decoded as UTF-16, otherwise a NUL byte marks it binary and unscanned.
    if (typeof content === "string") texts.push({ where, text: content, offset: bodyOffset });
    else {
      const text = decodeForScan(content);
      if (text !== null) texts.push({ where, text, offset: 0 });
    }
  }
  // UTF-16 sources read on the text path: their stored text is mojibake no pattern matches,
  // so the whole source file, decoded correctly, is scanned too (lines count from its top).
  for (const [rel, text] of Object.entries(scan)) {
    const where = fileWhere(meta, origin, rel);
    texts.push({ where, text, offset: 0 });
  }
  for (const t of texts) {
    const hit = findSecrets(t.text)[0];
    if (hit) return `secret-like value (${hit.kind}) in ${t.where} line ${hit.line + t.offset}`;
  }
  if (meta.type === "mcp") {
    const hit = serverSecret(meta.name, meta.server);
    if (hit) return hit;
  }
  return null;
}

/**
 * Read a source file as UTF-8 text, exactly as import always has — the stored text does not
 * change. When the bytes carry a UTF-16 BOM, that UTF-8 read is mojibake no secret pattern can
 * match, so the correctly decoded text comes back alongside, for the secret scan only.
 */
async function readSource(abs: string): Promise<{ text: string; scan?: string }> {
  const bytes = await fs.readFile(abs);
  return { text: bytes.toString("utf8"), scan: hasUtf16Bom(bytes) ? (decodeForScan(bytes) ?? undefined) : undefined };
}

/** The extra scan entry for one stored file, when its source needed a UTF-16 decode. */
function scanOf(rel: string, src: { scan?: string }): Record<string, string> {
  return src.scan === undefined ? {} : { [rel]: src.scan };
}

function splitList(v?: string): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function safeList(dir: string): Promise<string[]> {
  return (await exists(dir)) ? (await fs.readdir(dir)).sort() : [];
}

async function sniffScm(claudeDir: string): Promise<Profile["scm"]> {
  let text = "";
  for (const f of await safeList(path.join(claudeDir, "commands"))) text += await fs.readFile(path.join(claudeDir, "commands", f), "utf8");
  if (/az repos pr create|dev\.azure\.com/.test(text)) return { kind: "azure-devops", prTool: /az repos pr create/.test(text) ? "az" : "rest" };
  if (/\bgh pr create\b/.test(text)) return { kind: "github", prTool: "gh" };
  return {};
}

/**
 * Write an ingredient dir. When an ingredient of the same name already exists in the Forge:
 * identical content → reuse; different content → write a `<name>--<profile>` variant and report it,
 * so the human decides whether to parameterize or keep a client-specific copy.
 */
async function writeIngredient(
  stage: ForgeStage,
  meta: Ingredient,
  files: Record<string, string | Buffer>,
  profile: string,
  report: ImportReport,
  scan: Record<string, string> = {},
  run?: { ctx: RunContext; others: Array<{ ref: string; meta: Ingredient; files: Record<string, string | Buffer> }>; runBases: Set<string>; literal: Array<{ ref: string; source: string; meta: Ingredient; files: Record<string, string | Buffer>; lineOffset?: number }>; lineOffset?: number; indexExpand?: (text: string, target: "claude-code" | "kiro") => string },
): Promise<string | null> {
  const secret = secretIn(meta, files, scan, run?.lineOffset);
  if (secret) {
    report.rejected.push({ name: `${meta.type}/${meta.name}`, reason: secret });
    return null;
  }
  const forge = stage.root;
  const folder = typeFolder(meta.type);
  let name = meta.name;
  let dir = path.join(forge, "ingredients", folder, name);
  // Hash what the Forge will load back, the way fingerprintDir hashes the other side.
  const fingerprint = fingerprintOf(validateImported(meta), files);

  const ref = `${meta.type}/${name}`;
  const source = meta.origin?.path ?? ref;
  const sourceMeta = validateImported(meta);
  // The authEnv to carry into a variant — from the decision (spec 27 §5.3).
  let variantAuthEnv: string[] | undefined;
  // The registration and cited params to carry into a hook variant — from the decision (spec 43 §7.2 row 10).
  let variantRegistration: unknown[] | undefined;
  let variantRegistrationParams: Record<string, { default?: string | number | boolean; description?: string }> | undefined;
  if (await stage.exists(path.join(dir, "ingredient.yaml"))) {
    let why: string | undefined;
    const d = run ? await decide(run.ctx, dir, stage.reader(), ref, sourceMeta, files, fingerprint, run.others, run.runBases, run.indexExpand) : { kind: "literal" as const, warn: "" };
    if (d.kind === "literal") {
      if (d.warn) report.warnings.push(d.warn);
      if ((await fingerprintDir(dir, stage.reader())) === fingerprint) {
        report.reused.push(ref);
        return ref;
      }
    } else if (d.kind === "reuse") {
      report.reused.push(ref);
      if (d.rendered || d.renderedSections) report.rendered.push({ name: ref, keys: d.rendered ?? [], ...(d.renderedSections ? { sections: d.renderedSections } : {}) });
      if (d.inferred) report.inferred.push({ name: ref, values: d.inferred });
      for (const x of d.delta ?? []) report.params.push({ ...x, from: ref });
      if (d.sectioned) report.sectioned.push({ name: ref, sections: d.sectioned });
      for (const x of d.sectionDelta ?? []) report.sections.push({ ...x, from: ref });
      return ref;
    } else {
      why = d.why;
      // Capture the base's authEnv for a new variant (spec 27 §5.3).
      variantAuthEnv = d.authEnv;
      // Capture the base's registration and cited params for a new hook variant (spec 43 §7.2 row 10).
      variantRegistration = d.registration;
      variantRegistrationParams = d.registrationParams;
    }
    const as = meta.name;
    name = `${meta.name}--${profile}`;
    // Warn about sections this variant leaves out or holds as plain text (spec 41 Part B §5.2).
    if (run?.ctx) {
      const parseOpts = { targets: readsTargetSections(run.ctx.forge?.manifest ?? { schema: 1 }) };
      const base = await readBase(dir, stage.reader(), forge, parseOpts);
      const owner = run.ctx.sourceTarget;
      // The targets this workspace writes that the variant applies to and supports.
      const writes = run.ctx.writtenTargets.filter(
        (t) => appliesTo(meta.targets ?? "*", t) && CAPABILITIES[t][meta.type].state !== "unsupported",
      );
      for (const [, parsed] of base.parsed) {
        for (const s of parsed.sections) {
          if (s.targets && !(s.targets as readonly string[]).includes(owner)) {
            // Section for other targets — left out of this variant.
            const affected = (s.targets as readonly string[]).filter((t) => writes.includes(t as Target));
            if (affected.length > 0) {
              report.warnings.push(`${meta.type}/${name}: made from the ${owner} file, it leaves out section ${s.name} (targets=${s.targets.join(",")}) — sync writes ${affected.join(", ")} without it`);
            }
          } else if (s.targets && (s.targets as readonly string[]).includes(owner)) {
            // Section for this target but not all — held as plain text in the variant.
            const others = writes.filter((t) => !(s.targets as readonly string[]).includes(t));
            if (others.length > 0) {
              report.warnings.push(`${meta.type}/${name}: made from the ${owner} file, it holds section ${s.name} (targets=${s.targets.join(",")}) as plain text — sync writes it to ${others.join(", ")} too`);
            }
          }
        }
      }
    }
    // Spec 44 §4.8: an existing rule or steering variant that holds the placeholder is compared as sync writes it, its
    // list expanded — the comparison decide() makes for a base (`renderedFingerprint`, which drops `name` and `as`).
    // Unchanged, it is kept as it is; changed in the workspace, import refuses rather than write the list over it.
    const variantDir = path.join(forge, "ingredients", folder, name);
    const indexTarget = meta.type === "rule" ? "claude-code" : meta.type === "steering" ? "kiro" : undefined;
    if (run?.ctx.forge && readsRulesIndex(run.ctx.forge.manifest) && run.indexExpand && indexTarget && (await stage.exists(path.join(variantDir, "ingredient.yaml")))) {
      const v = await readBase(variantDir, stage.reader(), forge, { targets: readsTargetSections(run.ctx.forge.manifest) });
      if ([...v.texts.values()].some((t) => RULES_INDEX_LINE.test(t))) {
        const key = sectionKey(v.meta);
        const S: Record<string, string> = { ...valuesAt(run.ctx.PS, key), ...valuesAt(run.ctx.WS, key) };
        const map = renderMap(v.meta, run.ctx.P, run.ctx.W);
        const expand = run.indexExpand;
        // What the workspace cannot show is taken from the source, as import writes it: the `description`, the
        // `targets` and `tags` (no target writes them into the file) and the name of the body file.
        const srcBody = sourceMeta.type === "rule" || sourceMeta.type === "steering" ? path.posix.normalize(sourceMeta.file) : undefined;
        const varBody = v.meta.type === "rule" || v.meta.type === "steering" ? path.posix.normalize(v.meta.file) : undefined;
        const rekey = <T>(m: Map<string, T>): Map<string, T> =>
          new Map([...m].map(([rel, x]) => [srcBody !== undefined && rel === varBody ? srcBody : rel, x]));
        const seen: ImportBase = {
          ...v,
          meta: { ...v.meta, description: sourceMeta.description, targets: sourceMeta.targets, tags: sourceMeta.tags, ...(sourceMeta.type === "rule" || sourceMeta.type === "steering" ? { file: sourceMeta.file } : {}) } as Ingredient,
          texts: rekey(v.texts),
          parsed: rekey(v.parsed),
        };
        for (const k of ["description", "targets", "tags"] as const) if ((seen.meta as Record<string, unknown>)[k] === undefined) delete (seen.meta as Record<string, unknown>)[k];
        const rendered = renderedFingerprint(seen, map, S, run.ctx.forge.manifest.schema, run.ctx.primaryRefs ?? undefined, run.ctx.sourceTarget, (t) => expand(t, indexTarget));
        if (rendered !== fingerprint) {
          throw new Error(`import: ${meta.type}/${name} holds {{${RULES_INDEX_KEY}}} and the workspace's ${source} differs from what sync writes from it — edit the variant in the Forge, then re-run`);
        }
        report.variants.push({ name: `${meta.type}/${name}`, reason: `unchanged ${meta.type}/${as} variant holding {{${RULES_INDEX_KEY}}}` });
        // F9: a kept variant pins every key it cites, under every target (decide()'s citedAll).
        pin(run.ctx, [...citedKeys(expandedTexts(v, S))], map);
        return `${meta.type}/${name}`;
      }
    }
    dir = variantDir;
    report.variants.push({ name: `${meta.type}/${name}`, reason: `differs from ${meta.type}/${as} already in the Forge${why ? ` (${why})` : ""}` });

    // A base holding {{craftar.rules.index}} that becomes a new variant: the list is frozen there (spec 44 §4.8)
    // The variant now has the expanded (frozen) list instead of the dynamic placeholder.
    if (run?.ctx && run.ctx.forge && readsRulesIndex(run.ctx.forge.manifest) && (meta.type === "rule" || meta.type === "steering")) {
      const parseOpts = { targets: readsTargetSections(run.ctx.forge.manifest) };
      const baseDir = path.join(forge, "ingredients", folder, as);
      if (await stage.exists(path.join(baseDir, "ingredient.yaml"))) {
        const baseForPlaceholder = await readBase(baseDir, stage.reader(), forge, parseOpts);
        for (const [, text] of baseForPlaceholder.texts) {
          if (RULES_INDEX_LINE.test(text)) {
            report.warnings.push(
              `import: ${meta.type}/${name} holds the generated list of ${meta.type}/${as} — {{craftar.rules.index}} is frozen there; put the placeholder back in the variant, or delete it to use the base`
            );
            break;
          }
        }
      }
    }

    // Spec 27 §5.3: an existing variant's authEnv decides; a new one inherits the base's.
    const variantFile = path.join(dir, "ingredient.yaml");
    if (meta.type === "mcp") {
      if (await stage.exists(variantFile)) {
        const existingMeta = parseYaml(variantFile, await stage.readText(variantFile), IngredientSchema);
        if (existingMeta.type === "mcp" && existingMeta.authEnv) {
          meta = { ...meta, authEnv: existingMeta.authEnv } as Ingredient;
        }
      } else if (variantAuthEnv) {
        meta = { ...meta, authEnv: variantAuthEnv } as Ingredient;
      }
    }
    // Spec 43 §7.2 row 10: an existing hook variant's registration decides; a new one inherits the base's.
    // Also carry params entries the registration cites: base's when base declares, else variant's own when variant declares.
    if (meta.type === "hook") {
      if (await stage.exists(variantFile)) {
        const existingMeta = parseYaml(variantFile, await stage.readText(variantFile), IngredientSchema);
        if (existingMeta.type === "hook" && existingMeta.registration) {
          meta = { ...meta, registration: existingMeta.registration } as Ingredient;
          // For params: for each key the variant's registration cites, take the base's entry when base declares it;
          // otherwise take the existing variant's own entry when the variant declares it; otherwise nothing.
          const baseDir = path.join(forge, "ingredients", folder, meta.name);
          const baseFile = path.join(baseDir, "ingredient.yaml");
          const baseMeta = (await stage.exists(baseFile)) ? parseYaml(baseFile, await stage.readText(baseFile), IngredientSchema) : null;
          const baseParams = baseMeta?.type === "hook" ? baseMeta.params : undefined;
          const variantParams = existingMeta.params;
          // Merge base and variant params for citations: a key is "declared" if either side declares it.
          // Use the type expected by registrationCitations (it only checks key existence).
          type ParamDecl = { default?: string | number | boolean; description?: string };
          const mergedParams: Record<string, ParamDecl> = { ...variantParams, ...baseParams };
          const variantMetaForCitations = { ...existingMeta, params: mergedParams };
          const citedDeclared = registrationCitations(variantMetaForCitations).filter((c) => c.declared).map((c) => c.key);
          if (citedDeclared.length > 0) {
            const keptParams: Record<string, { default?: string | number | boolean; description?: string }> = {};
            for (const k of citedDeclared) {
              // Prefer base's entry; fall back to variant's own entry
              if (baseParams && Object.hasOwn(baseParams, k)) keptParams[k] = baseParams[k];
              else if (variantParams && Object.hasOwn(variantParams, k)) keptParams[k] = variantParams[k];
            }
            if (Object.keys(keptParams).length > 0) {
              meta = { ...meta, params: keptParams } as Ingredient;
            }
          }
        }
      } else {
        // NEW hook variant: inherit registration from base.
        // variantRegistration/variantRegistrationParams come from decide()'s "variant" answer;
        // when undefined (literal path), read the base's ingredient.yaml and call registrationCarry().
        let regToApply = variantRegistration;
        let paramsToApply = variantRegistrationParams;
        if (regToApply === undefined) {
          // Literal path: decide() answered "literal", so we didn't get registration from it.
          // Read the base's ingredient.yaml and compute registration carry (spec 43 §7.2 row 10).
          const baseDir = path.join(forge, "ingredients", folder, meta.name);
          const baseFile = path.join(baseDir, "ingredient.yaml");
          if (await stage.exists(baseFile)) {
            const baseMeta = parseYaml(baseFile, await stage.readText(baseFile), IngredientSchema);
            const carry = registrationCarry(baseMeta);
            regToApply = carry.registration;
            paramsToApply = carry.registrationParams;
          }
        }
        if (regToApply) {
          meta = { ...meta, registration: regToApply } as Ingredient;
        }
        if (paramsToApply) {
          meta = { ...meta, params: paramsToApply } as Ingredient;
        }
      }
    }
    meta = { ...meta, name, as } as Ingredient;
    validateImported(meta); // the variant name must be slug-like too (a `--profile` with a space is not)

    // I8: rewriting an existing variant another profile resolves would change its files there.
    if (run?.ctx.forge && (await stage.exists(variantFile)) && (await fingerprintDir(dir, stage.reader())) !== fingerprintOf(validateImported(meta), files)) {
      for (const q of run.ctx.forge.profiles.keys()) {
        if (q !== profile && resolvedBy(run.ctx.forge, q).has(`${meta.type}/${name}`)) {
          throw new Error(`import: ${meta.type}/${name} is also used by profile ${q} — its files would change there`);
        }
      }
    }
  } else {
    report.created.push(`${meta.type}/${name}`);
  }
  if (run) {
    pin(run.ctx, sourceKeys(sourceMeta, files), renderMap(sourceMeta, run.ctx.P, run.ctx.W));
    run.literal.push({ ref: `${meta.type}/${name}`, source, meta: sourceMeta, files, lineOffset: run.lineOffset });
  }

  // Build the YAML preserving key order. For MCP, authEnv sits immediately before server.
  // For hooks, registration sits after files (spec 43 §7.2 row 10).
  const yamlMeta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === "authEnv") continue;
    if (k === "registration") continue;
    // authEnv is emitted with server because only an mcp metadata can hold it (the schema refuses it elsewhere).
    if (k === "server" && "authEnv" in meta) yamlMeta.authEnv = meta.authEnv;
    // registration is emitted after files for hooks (spec 43 §7.2 row 10).
    if (k === "files" && meta.type === "hook" && "registration" in meta) {
      yamlMeta[k] = v;
      yamlMeta.registration = meta.registration;
      continue;
    }
    yamlMeta[k] = v;
  }
  stage.write(path.join(dir, "ingredient.yaml"), YAML.stringify(yamlMeta, { lineWidth: 0 }));
  for (const [rel, content] of Object.entries(files)) stage.write(path.join(dir, rel), content);

  // For script and hook, warn about leftover files in the directory
  if (meta.type === "script" || meta.type === "hook") {
    const diskFiles = await stage.reader().list(dir);
    const plannedFiles = new Set(["ingredient.yaml", ...Object.keys(files)]);
    for (const diskRel of diskFiles) {
      if (!plannedFiles.has(diskRel)) {
        const relDir = path.relative(forge, dir).split(path.sep).join("/");
        report.warnings.push(`${relDir}/${diskRel} is not in the files of ${meta.type}/${name} — sync does not write it; remove it by hand`);
      }
    }
  }

  return `${meta.type}/${name}`;
}

/**
 * The ingredient as the Forge will load it back. An ingredient that would not load (a non-string MCP
 * `env` value, a name that is not slug-like) fails the whole import, naming its source, before the
 * first write — 0.2.4 wrote a Forge no command could load (spec 07, Ruling 6).
 */
export function validateImported(meta: Ingredient): Ingredient {
  const r = IngredientSchema.safeParse(meta);
  if (r.success) return r.data;
  const source = meta.origin?.path ?? `${meta.type}/${meta.name}`;
  throw new Error(`${source} (${meta.type}/${meta.name}) does not fit the ingredient schema: ${schemaFault(r.error)}`);
}

export interface RecipeOptions {
  stage: ForgeStage;
  dir: string;
  profile: string;
  forge: import("../core/forge.js").Forge | null;
  report: ImportReport;
  /** The rules the profile resolves today, in resolution order; null for a new profile (spec 10 §14 Q10). */
  currentRules: string[] | null;
  /** Under agents-md.primary, the rules the importing workspace holds in AGENTS.md alone (spec 41 §4.10); empty otherwise. */
  agentsMdOnly: ReadonlySet<string>;
}

/**
 * Under agents-md.primary a rule the workspace holds in AGENTS.md alone has no file import reads, yet the workspace has it
 * (spec 41 §4.10): a recipe that lists it keeps it, each such entry placed after the entry it follows in the recipe.
 */
function keepAgentsMdOnly(existing: string[], list: string[], only: ReadonlySet<string>): string[] {
  if (!only.size) return list;
  const out = [...list];
  let prev = -1;
  for (const x of existing) {
    const at = out.indexOf(x);
    if (at >= 0) prev = at;
    else if (only.has(x)) out.splice(++prev, 0, x);
  }
  return out;
}

function currentRuleOrder(forge: import("../core/forge.js").Forge | null, profile: string): string[] | null {
  if (!forge?.profiles.has(profile)) return null;
  try {
    return resolve(forge, WorkspaceConfigSchema.parse({ forge: ".", profile })).ingredients.map((i) => i.ref).filter((r) => r.startsWith("rule/"));
  } catch {
    return null;
  }
}

/**
 * `swap(p)` (spec 11 §6.15, Rulings 9 and 23): a variant ref of the importing profile, `T/N--<p>`,
 * read as its base `T/N` when the run's computed list holds the base and not the variant — the
 * re-import replaced the variant by its base, which therefore takes the variant's slot. Another
 * profile's variant is never swapped.
 */
function swapRef(ref: string, profile: string, list: string[]): string {
  const suffix = `--${profile}`;
  if (!ref.endsWith(suffix)) return ref;
  const base = ref.slice(0, -suffix.length);
  return list.includes(base) && !list.includes(ref) ? base : ref;
}

const recipeText = (name: string, description: string, ingredients: string[]) =>
  YAML.stringify(JSON.parse(JSON.stringify({ name, description, extends: [], ingredients, params: {} }))); // today's bytes

/**
 * Where a shared recipe's computed list goes (spec 10 §6.7, Ruling 7): a shared recipe is never
 * edited and never widened for one client. It is used only when its ingredients equal the list as
 * a set — and, for a profile that already exists, in the same relative rule order, so AGENTS.md
 * does not reorder (Q10). Otherwise the profile gets its own `<name>--<profile>`.
 */
async function placeRecipe(o: RecipeOptions, name: string, list: string[], description: string, holdsVariant: boolean): Promise<string> {
  const owned = `${name}--${o.profile}`;
  const read = async (file: string) => parseYaml(file, stripBom(await o.stage.readText(file)), RecipeSchema).ingredients;
  if (holdsVariant) {
    // Under agents-md.primary the shared recipe's rules held in AGENTS.md alone join the owned list (spec 41 §4.10); with the
    // mode off the shared file is not read here, as before.
    if (o.agentsMdOnly.size) {
      const file = await recipeFile(o, name);
      if (await o.stage.exists(file)) list = keepAgentsMdOnly(await read(file), list, o.agentsMdOnly);
    }
    return writeOwnedRecipe(o, owned, list, description);
  }
  const file = await recipeFile(o, name);
  if (!(await o.stage.exists(file))) {
    o.stage.write(file, recipeText(name, description, list));
    o.report.recipes.push(name);
    return name;
  }
  const existing = await read(file);
  list = keepAgentsMdOnly(existing, list, o.agentsMdOnly);
  const rules = (xs: string[]) => xs.filter((x) => x.startsWith("rule/"));
  const lacks = existing.find((x) => !list.includes(x));
  const extra = list.find((x) => !existing.includes(x));
  // Q10: an existing profile moves to R only if R orders its rules as the profile resolves them today, so AGENTS.md keeps its order.
  // A variant this run replaced by its base is compared as that base, in its slot (spec 11 §6.15).
  const current = o.currentRules?.map((r) => swapRef(r, o.profile, list)) ?? null;
  const reorders = current !== null && JSON.stringify(rules(existing)) !== JSON.stringify(current.filter((r) => existing.includes(r)));
  if (!lacks && !extra && !reorders) {
    o.report.recipes.push(name);
    return name;
  }
  const reason = lacks
    ? `${name} lists ${lacks}, which this workspace lacks`
    : extra
      ? `this workspace has ${extra}, which ${name} lacks`
      : `${name} orders its rules differently`;
  o.report.recipeSplits.push({ shared: name, owned, reason });
  return writeOwnedRecipe(o, owned, list, description);
}

/**
 * A recipe the importing profile owns holds exactly this workspace's list: a new one is written
 * as today; an existing one is edited in place — entries kept in their order, a variant this run
 * replaced by its base swapped for the base where it stands (spec 11 §6.15), dropped ones removed,
 * new ones appended — refused if another profile resolves it (I7) or it cannot be edited in place (I2).
 */
async function writeOwnedRecipe(o: RecipeOptions, name: string, list: string[], description: string): Promise<string> {
  const file = await recipeFile(o, name);
  o.report.recipes.push(name);
  if (!(await o.stage.exists(file))) {
    o.stage.write(file, recipeText(name, description, list));
    return name;
  }
  const raw = await o.stage.readText(file);
  const before = parseYaml(file, stripBom(raw), RecipeSchema);
  list = keepAgentsMdOnly(before.ingredients, list, o.agentsMdOnly);
  // Each existing entry in order: kept, swapped for its base in place, or dropped; then the rest of the list appended.
  const inPlace = (x: string): string | null => {
    if (list.includes(x)) return x;
    const b = swapRef(x, o.profile, list);
    return b !== x && !before.ingredients.includes(b) ? b : null;
  };
  const kept = before.ingredients.map(inPlace).filter((x): x is string => x !== null);
  const next = [...kept, ...list.filter((x) => !kept.includes(x))];
  if (JSON.stringify(next) === JSON.stringify(before.ingredients)) return name;
  if (o.forge) {
    for (const q of o.forge.profiles.keys()) {
      if (q !== o.profile && recipesOf(o.forge, q).has(name)) throw new Error(`import: recipe ${name} is also used by profile ${q} — its ingredients would change there`);
    }
  }
  const label = `recipes/${name}.yaml`;
  const content = editYamlText(raw, { command: "import", label, keys: ["ingredients"] }, (doc) => {
    const seq = doc.get("ingredients", true);
    if (!YAML.isSeq(seq)) {
      doc.set("ingredients", next);
      return;
    }
    // The scalar node is replaced where it stands (unify's replaceSeqEntry), so a comment on it stays.
    seq.items = seq.items.flatMap((it) => {
      const v = String(YAML.isScalar(it) ? it.value : it);
      const to = inPlace(v);
      if (to === null) return [];
      if (to === v) return [it];
      if (YAML.isScalar(it)) {
        it.value = to;
        return [it];
      }
      return [doc.createNode(to)];
    });
    for (const x of next.slice(kept.length)) seq.items.push(doc.createNode(x));
  });
  const after = RecipeSchema.safeParse(parseYamlText(label, content) ?? {});
  if (!after.success || !isDeepStrictEqual(after.data, { ...before, ingredients: next })) {
    throw new Error(`import: cannot edit ${label} in place (the edit does not read back as exactly the new ingredients) — reformat it by hand, commit, and re-run`);
  }
  o.stage.write(file, content);
  return name;
}

/**
 * `recipes/<name>.yaml`, the file import reads and writes for recipe `<name>`. loadForge keys
 * recipes by their `name` field, not by file, so a recipe `<name>` in another file, or that file
 * declaring another name, would leave two recipes under one name and loadForge would keep one.
 * Refused before the first write, as I4 refuses the same split for a profile.
 */
export async function recipeFile(o: Pick<RecipeOptions, "stage" | "dir">, name: string, command = "import"): Promise<string> {
  const file = path.join(o.dir, `${name}.yaml`);
  for (const f of await o.stage.reader().list(o.dir)) {
    if (f.includes("/") || !/\.ya?ml$/.test(f)) continue;
    const abs = path.join(o.dir, f);
    const declared = parseYaml(abs, stripBom(await o.stage.readText(abs)), RecipeSchema).name;
    if (abs === file && declared !== name) throw new Error(`${command}: recipes/${f} is recipe ${declared} — ${command} writes recipe ${name} there`);
    if (abs !== file && declared === name) throw new Error(`${command}: recipe ${name} is recipes/${f} — ${command} writes recipes/${name}.yaml`);
  }
  return file;
}

/** A parameter as the profile resolves it in the Forge before the run — recipe defaults under its own `params`; the profile's own when it is new or does not resolve. */
function resolvedParam(forge: import("../core/forge.js").Forge | null, profile: string, key: string, own: Record<string, unknown>): unknown {
  if (forge?.profiles.has(profile)) {
    try {
      return resolve(forge, WorkspaceConfigSchema.parse({ forge: ".", profile })).params[key];
    } catch {
      // falls through: a profile that does not resolve still has its own value
    }
  }
  return Object.hasOwn(own, key) ? own[key] : undefined;
}

/** The recipes a profile resolves inside the Forge, or null when `resolve` throws — the profile does not resolve. */
export function resolvedRecipes(forge: import("../core/forge.js").Forge, profile: string): Set<string> | null {
  try {
    return new Set(resolve(forge, WorkspaceConfigSchema.parse({ forge: ".", profile })).recipes);
  } catch {
    return null;
  }
}

/** The recipes a profile resolves inside the Forge; fails closed — a profile that does not resolve counts as using everything. */
export function recipesOf(forge: import("../core/forge.js").Forge, profile: string): { has(name: string): boolean } {
  return resolvedRecipes(forge, profile) ?? { has: () => true };
}

/**
 * The importing profile's effective params and sections before the run (`P`, `PS`; spec 10 §6.1, spec 11 §6.7,
 * spec 33 §5.3), and `blockKeys` — the `integrations.*` keys whose value comes from the block (spec 33 design.md
 * item 12). I4: import writes `profiles/<p>/profile.yaml`, so a profile named `<p>` elsewhere, or that file
 * naming another profile, would leave two files for one name.
 */
async function existingProfile(
  forge: string,
  profile: string,
  loaded: import("../core/forge.js").Forge | null,
): Promise<{ params: Record<string, unknown>; sections: Sections; blockKeys: string[]; warnings: string[] }> {
  if (!loaded) return { params: {}, sections: {}, blockKeys: [], warnings: [] };
  const dir = path.join(forge, "profiles");
  for (const d of (await exists(dir)) ? await fs.readdir(dir, { withFileTypes: true }) : []) {
    if (!d.isDirectory()) continue;
    const abs = path.join(dir, d.name, "profile.yaml");
    if (!(await exists(abs))) continue;
    const name = parseYaml(abs, stripBom(await fs.readFile(abs, "utf8")), ProfileSchema).name;
    if ((name === profile) !== (d.name === profile)) {
      throw new Error(`import: profile ${profile} is profiles/${d.name}/profile.yaml — import writes profiles/${profile}/profile.yaml`);
    }
  }
  const p = loaded.profiles.get(profile);
  if (!p) return { params: {}, sections: {}, blockKeys: [], warnings: [] };
  try {
    const eff = effectiveProfile(loaded, p);
    return { params: { ...eff.params }, sections: p.sections, blockKeys: eff.blockKeys, warnings: eff.warnings };
  } catch (e) {
    throw new Error(`import: profile ${profile} does not resolve (${errorText(e)}) — fix the Forge and re-run`);
  }
}

/**
 * I11 (spec 11 §4.5): the first column-0 section marker (or near miss) in a body file of a
 * created or variant source, which sync would read as structure. The line counts from the top of
 * the workspace file, as the secret scan's does: an agent or command body starts after its frontmatter.
 */
export function markerIn(meta: Ingredient, files: Record<string, string | Buffer>, source: string, lineOffset = 0): { where: string; line: number } | null {
  const raw = "frontmatterRaw" in meta ? meta.frontmatterRaw : undefined;
  const offset = raw && !bodyFromSteering(meta) ? raw.split("\n").length + 2 : lineOffset;
  for (const [rel, content] of Object.entries(files)) {
    // the importer builds meta and file keys itself, with canonical names
    if (!bodyFile(meta, rel, null)) continue;
    const line = firstMarkerLine(toLf(stripBom(typeof content === "string" ? content : content.toString("utf8"))));
    if (line !== null) {
      return { where: fileWhere(meta, source, rel), line: line + offset };
    }
  }
  return null;
}

/**
 * The profile a run computes. `sections` is optional: a profile import creates holds the key only
 * when the run wrote a section value, so a new profile keeps today's bytes (spec 11 §5.2).
 */
type ImportedProfile = Omit<Profile, "sections"> & { sections?: Profile["sections"] };

/** `Δs` as a sections map, each value the run's final one, in acceptance order (spec 11 §6.10). */
function sectionChange(report: ImportReport, ctx: RunContext): Sections {
  const out: Sections = {};
  for (const x of report.sections) out[x.key] = { ...(out[x.key] ?? {}), [x.name]: ctx.PS[x.key][x.name] };
  return out;
}

/** Recipe entries import owns in a profile's `recipes`: the ones it computes and replaces (spec 10 §6.6, §14 Q4). */
const importOwned = (name: string, profile: string) =>
  name === "base" || name === `base--${profile}` || name === `${profile}-steering` || (/^stack-/.test(name) && (!name.includes("--") || name.endsWith(`--${profile}`)));

/**
 * Write `profiles/<p>/profile.yaml` (spec 10 §6.6, Ruling 2): a new profile as today; an existing
 * one edited in place — `params` gains this run's values, `recipes` gets the computed entries in
 * place of the ones import owns, `targets` gains missing ones — every other field, comment and
 * line kept. I1 when it cannot be edited in place.
 */
async function writeProfile(stage: ForgeStage, forge: string, name: string, computed: ImportedProfile, ctx: RunContext, report: ImportReport): Promise<void> {
  const file = path.join(forge, "profiles", name, "profile.yaml");
  const label = `profiles/${name}/profile.yaml`;
  if (!(await stage.exists(file))) {
    stage.write(file, YAML.stringify(computed));
    report.created.push(label);
    report.profileWrite = { path: label, action: "created", fields: [] };
    return;
  }
  const raw = await stage.readText(file);
  const before = parseYaml(file, stripBom(raw), ProfileSchema);
  const values = Object.fromEntries(report.params.map((x) => [x.key, String(ctx.P[x.key])]));
  const sectionValues = sectionChange(report, ctx);
  const firstOwned = before.recipes.findIndex((r) => importOwned(r, name));
  const kept = before.recipes.filter((r) => !importOwned(r, name));
  const at = firstOwned === -1 ? kept.length : before.recipes.slice(0, firstOwned).filter((r) => !importOwned(r, name)).length;
  const recipes = [...kept.slice(0, at), ...computed.recipes, ...kept.slice(at)];
  const targets = [...before.targets, ...computed.targets.filter((t) => !before.targets.includes(t))];
  const fields = [
    ...(Object.keys(values).length ? ["params"] : []),
    ...(report.sections.length ? ["sections"] : []),
    ...(JSON.stringify(recipes) !== JSON.stringify(before.recipes) ? ["recipes"] : []),
    ...(targets.length !== before.targets.length ? ["targets"] : []),
  ];
  if (!fields.length) {
    report.profileWrite = { path: label, action: "unchanged", fields: [] };
    return;
  }
  const content = editYamlText(raw, { command: "import", label, keys: ["params", "sections", "recipes", "targets"] }, (doc) => {
    for (const [k, v] of Object.entries(values)) doc.setIn(["params", k], v);
    for (const [key, byName] of Object.entries(sectionValues)) for (const [n, v] of Object.entries(byName)) doc.setIn(["sections", key, n], v);
    if (fields.includes("recipes")) {
      const seq = doc.get("recipes", true);
      if (YAML.isSeq(seq)) {
        const nodes = seq.items.filter((it) => !importOwned(String(YAML.isScalar(it) ? it.value : it), name));
        seq.items = [...nodes.slice(0, at), ...computed.recipes.map((r) => doc.createNode(r)), ...nodes.slice(at)];
      } else doc.set("recipes", recipes);
    }
    if (fields.includes("targets")) {
      const seq = doc.get("targets", true);
      if (YAML.isSeq(seq)) for (const t of targets.slice(before.targets.length)) seq.items.push(doc.createNode(t));
      else doc.set("targets", targets);
    }
  });
  const after = ProfileSchema.safeParse(parseYamlText(label, content) ?? {});
  const expected = { ...before, recipes, targets, params: { ...before.params, ...values }, sections: deepMerge(before.sections, sectionValues) };
  if (!after.success || !isDeepStrictEqual(after.data, expected)) {
    throw new Error(`import: cannot edit ${label} in place (the edit does not read back as exactly the intended change) — reformat it by hand, commit, and re-run`);
  }
  stage.write(file, content);
  report.profileWrite = { path: label, action: "edited", fields };
  for (const x of report.params) {
    const was = before.params[x.key] === undefined ? "" : ` (was ${JSON.stringify(String(before.params[x.key]))})`;
    report.warnings.push(`profile ${name} now sets ${x.key} to ${JSON.stringify(values[x.key])}${was} — every workspace on ${name} renders it at its next sync; import cannot reach them`);
  }
  for (const x of report.sections) {
    report.warnings.push(`profile ${name} now sets section ${x.name} of ${x.key} — every workspace on ${name} renders it at its next sync; import cannot reach them`);
  }
}

/**
 * `craftar.forge.yaml` (spec 11 §6.14, Rulings 7 and 22). A run that writes a section value, or
 * decides a source against a base holding a marker, leaves a Forge an older CLI must refuse, so it
 * needs `schema: 2`. A missing manifest is staged with the schema the run needs — with `1`, today's
 * bytes. An existing `schema: 1` (or none) is bumped in place through the round-trip gate, checked
 * before the flush like the profile and the recipes; I13 when it cannot be. Nothing lowers a schema.
 */
async function stageManifest(stage: ForgeStage, forge: string, needs: boolean): Promise<ImportReport["manifestWrite"]> {
  const abs = path.join(forge, FORGE_MANIFEST);
  if (!(await stage.exists(abs))) {
    const schema = needs ? FORGE_SCHEMA_SECTIONS : 1;
    stage.write(abs, YAML.stringify({ name: path.basename(forge), schema, description: "Craftar Forge — shared harness ingredients, recipes and client profiles." }));
    return "created";
  }
  if (!needs) return "unchanged";
  const raw = await stage.readText(abs);
  const content = manifestWithSections(raw, "import");
  if (content === null) return "unchanged";
  stage.write(abs, content);
  return "edited";
}

/**
 * `--write-config` (spec 10 §6.9, Ruling 8): a new or empty craftar.yaml is written as today; an
 * existing one is edited in place — `forge`, `profile` and `targets` set, everything else, comments
 * included, kept. Checked here, before the Forge flush; I9 when it cannot be edited in place.
 */
async function planConfig(ws: string, forge: string, profile: string, targets: Target[]): Promise<PlannedConfig> {
  const abs = path.join(ws, "craftar.yaml");
  const rel = path.relative(ws, forge).replace(/\\/g, "/") || ".";
  const fresh = YAML.stringify({ forge: rel, profile, targets });
  const raw = (await exists(abs)) ? await fs.readFile(abs, "utf8") : null;
  // Read as a mapping; the shape is checked below (not a mapping → refused, then WorkspaceConfigSchema).
  const before = (raw === null ? null : parseWorkspaceYaml("craftar.yaml", raw)) as Record<string, unknown> | null | undefined;
  if (raw === null || before === null || before === undefined) return { abs, content: fresh, action: "created", keptRemote: null };
  const i9 = (why: string) => new Error(`import: cannot edit craftar.yaml in place (${why}) — reformat it by hand and re-run`);
  if (typeof before !== "object" || Array.isArray(before)) throw i9("it is not a YAML mapping");
  // A remote Forge stays what the team named (spec 13 §4.5): import writes the local clone, and sync reads
  // the URL once the Forge is pushed. The report prints the URL, so a credential in it is refused first (§4.3).
  const existing: unknown = before.forge;
  if (typeof existing === "string" && credentialFault(existing))
    throw new Error("craftar.yaml › forge holds credentials in the URL — remove them and let git authenticate (credential helper, SSH agent; see README › Remote Forge)");
  const keptRemote = typeof existing === "string" && classifyForge(existing) === "url" ? existing : null;
  const forgeValue = keptRemote ?? rel;
  let content: string;
  try {
    content = editYamlText(raw, { command: "import", label: "craftar.yaml", keys: [] }, (doc) => {
      if (keptRemote === null) doc.set("forge", rel);
      doc.set("profile", profile);
      if (JSON.stringify(before.targets) !== JSON.stringify(targets)) doc.set("targets", targets);
    });
  } catch (e) {
    throw i9((e as Error).message.replace(/^.*in place \((.*)\) — .*$/s, "$1"));
  }
  const after = parseWorkspaceYaml("craftar.yaml", content);
  if (!isDeepStrictEqual(after, { ...before, forge: forgeValue, profile, targets })) throw i9("the edit does not read back as exactly forge, profile and targets set");
  const loaded = WorkspaceConfigSchema.safeParse(after);
  if (!loaded.success) throw i9(`it no longer loads: ${schemaFault(loaded.error)}`);
  return { abs, content, action: content === raw ? "unchanged" : "edited", keptRemote };
}

/**
 * Resolve the importing profile on its own (spec 44 §4.7, §4.8): the Forge as loaded, the profile, the workspace's overrides
 * and targets. Used by PK6 (the prefer-kiro rules-index gate), the re-import comparison step, and primaryFor. Returns the
 * resolution with its lookup, or throws when the profile does not resolve on its own.
 */
async function resolveForImport(
  loaded: import("../core/forge.js").Forge,
  profile: string,
  ctx: RunContext,
  ws: string,
  read: (abs: string) => Promise<string>,
): Promise<{ resolution: Resolution; lookup: RuleLookup }> {
  if (!loaded.profiles.has(profile)) throw new Error(`profile ${profile} is not in the Forge`);
  const targets = await workspaceTargets(ws, read);
  const config = WorkspaceConfigSchema.parse({ forge: ".", profile, ...(targets ? { targets } : {}), overrides: { params: ctx.W, sections: ctx.WS } });
  const resolution = resolve(loaded, config);
  const lookup = buildRuleLookup(resolution.ingredients, resolution);
  return { resolution, lookup };
}

/**
 * What agents-md.primary changed for the importing workspace (spec 41 §4.10): the rewording the claude-code emitter applied, so a
 * re-import compares each base as sync wrote it, and the rules the workspace holds in AGENTS.md alone, so a recipe that lists
 * them is not split for lacking them; null when the Forge is below schema 5 or the mode is off. Decided by `resolve()` over
 * the Forge as loaded, the importing profile, and the workspace's overrides and targets — every layer the mode reads, recipe
 * defaults included. When the key is set somewhere and the profile does not resolve on its own, fails closed: nothing has
 * been written yet.
 */
function primaryFor(
  loaded: import("../core/forge.js").Forge | null,
  profile: string,
  ctx: RunContext,
  cachedResolution: { ok: true; resolution: Resolution; lookup: RuleLookup } | { ok: false; error: unknown } | null,
): { refs: NonNullable<RunContext["primaryRefs"]>; agentsMdOnly: Set<string> } | null {
  if (!loaded || !readsPrimary(loaded.manifest)) return null;
  const own = loaded.profiles.get(profile)?.params ?? {};
  const setSomewhere =
    Object.hasOwn(own, AGENTS_MD_PRIMARY_KEY) ||
    Object.hasOwn(ctx.W, AGENTS_MD_PRIMARY_KEY) ||
    [...loaded.recipes.values()].some((r) => r.params[AGENTS_MD_PRIMARY_KEY]?.default !== undefined);

  // Use the cached resolution if available
  if (cachedResolution === null) {
    // New profile (not in Forge) — fail closed if the key is set somewhere
    if (!setSomewhere) return null;
    throw new Error(`import: profile ${profile} does not resolve on its own (${errorText(new Error("profile " + profile + " is not in the Forge"))}) — agents-md.primary needs it to compare the bases; fix the Forge and re-run`);
  }
  if (!cachedResolution.ok) {
    // Profile doesn't resolve
    if (!setSomewhere) return null;
    throw new Error(`import: profile ${profile} does not resolve on its own (${errorText(cachedResolution.error)}) — agents-md.primary needs it to compare the bases; fix the Forge and re-run`);
  }
  const { resolution, lookup } = cachedResolution;
  if (!resolution.primary) return null;
  const agentsMdOnly = new Set(resolution.ingredients.filter((i) => isAgentsMdOnly(i.meta, resolution)).map((i) => i.ref));
  return { refs: (text, citing) => resolveRuleRefs(text, citing, lookup, resolution.targets).text, agentsMdOnly };
}

/**
 * The first rule or steering ingredient this import would compare that holds the rules index placeholder (spec 44
 * §4.8), in ref order: for each queued source `<type>/<name>`, the base `<type>/<name>` and the importing profile's
 * variant `<type>/<name>--<profile>` — what the profile resolves for that name, read when it cannot be resolved.
 */
async function indexHolderInQueue(
  loaded: import("../core/forge.js").Forge,
  queued: Set<string>,
  profile: string,
): Promise<string | null> {
  const refs = [...queued].flatMap((r) => [r, `${r}--${profile}`]).sort();
  for (const ref of refs) {
    const ing = loaded.ingredients.get(ref as `rule/${string}` | `steering/${string}`);
    if (ing && (ing.meta.type === "rule" || ing.meta.type === "steering") && RULES_INDEX_LINE.test(await readIngredientText(ing, ing.meta.file))) return ref;
  }
  return null;
}

