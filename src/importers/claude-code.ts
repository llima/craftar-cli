import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { parseFrontmatter } from "../core/frontmatter.js";
import { exists, listFiles, parseYaml, typeFolder, FORGE_MANIFEST } from "../core/forge.js";
import { manifestWithSections } from "../core/manifest-edit.js";
import { decodeForScan, findSecrets, hasUtf16Bom, secretValueKind } from "../core/secrets.js";
import { stripBom, toLf } from "../core/text.js";
import { fingerprintDir, fingerprintOf, type DirReader } from "../core/fingerprint.js";
import { FORGE_SCHEMA_SECTIONS, IngredientSchema, ProfileSchema, RecipeSchema, WorkspaceConfigSchema, type Ingredient, type McpServer, type Profile, type Sections, type Target } from "../schema/index.js";
import { isDeepStrictEqual } from "node:util";
import { resolve, type Resolution } from "../core/resolve.js";
import { classifyForge, credentialFault } from "../core/remote.js";
import { parseWorkspaceYaml } from "../core/workspace-yaml.js";
import { editYamlText } from "../core/yaml-edit.js";
import { resolvedBy } from "../core/param-writes.js";
import { decide, forgeBefore, pin, sourceKeys, workspaceParams, workspaceSections, type RunContext } from "./decide.js";
import { renderMap } from "../core/template-import.js";
import { firstMarkerLine } from "../core/sections.js";
import { bodyFile } from "../core/extract.js";
import { GENERATED_BANNER, kiroReport, type KiroReport } from "./kiro-report.js";
import { deepMerge } from "../core/merge.js";
import { outName } from "../emitters/shared.js";
import { parseYamlText } from "../core/yaml-read.js";

export interface ImportOptions {
  workspaceRoot: string;
  forgeRoot: string;
  profileName: string;
  /** Also write craftar.yaml into the workspace. */
  writeWorkspaceConfig?: boolean;
  /** Also compute the Kiro part of the report, from the flushed Forge (spec 29 §4.2). */
  report?: boolean;
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
    report.kiro = await kiroReport({ workspaceRoot: opts.workspaceRoot, forgeRoot: opts.forgeRoot, profile: opts.profileName, targets: planned.targets });
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
    created: [], reused: [], variants: [], rejected: [], recipes: [], profile: opts.profileName, warnings: [], rendered: [], inferred: [], params: [], sectioned: [], sections: [], recipeSplits: [],
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
  const read = (meta: Ingredient, files: Record<string, string | Buffer>, scan: Record<string, string>, after: (ref: string) => void, skip?: () => boolean) =>
    queue.push({ meta, files, scan, after, skip });
  const refs = { base: [] as string[], stacks: new Map<string, string[]>(), steering: [] as string[] };
  const ruleNames: string[] = [];
  const scopedRules = new Map<string, string>(); // rule name → fileMatchPattern

  /* ---- Kiro steering gives us inclusion modes and hand-written steering ---- */
  const steeringDir = path.join(ws, ".kiro", "steering");
  const steeringMeta = new Map<string, { inclusion: string; fileMatchPattern?: string; generated: boolean; text: string; scan?: string }>();
  if (await exists(steeringDir)) {
    for (const f of (await fs.readdir(steeringDir)).sort()) {
      if (!f.endsWith(".md")) continue;
      const src = await readSource(path.join(steeringDir, f));
      const text = toLf(stripBom(src.text));
      const { data, body } = parseFrontmatter<{ inclusion?: string; fileMatchPattern?: string }>(text);
      steeringMeta.set(f.replace(/\.md$/, ""), {
        inclusion: data.inclusion ?? "always",
        fileMatchPattern: data.fileMatchPattern,
        generated: GENERATED_BANNER.test(body.slice(0, 300)),
        text,
        scan: src.scan,
      });
    }
  }

  /* ---- rules ---- */
  for (const f of await safeList(path.join(claudeDir, "rules"))) {
    if (!f.endsWith(".md")) continue;
    const name = f.replace(/\.md$/, "");
    const src = await readSource(path.join(claudeDir, "rules", f));
    const text = toLf(stripBom(src.text));
    const sm = steeringMeta.get(name);
    const meta: Ingredient = {
      type: "rule",
      name,
      inclusion: (sm?.inclusion as any) ?? "always",
      fileMatchPattern: sm?.fileMatchPattern,
      file: "rule.md",
      targets: "*",
      tags: [],
      origin: origin(`.claude/rules/${f}`),
    };
    read(meta, { "rule.md": text }, scanOf("rule.md", src), (ref) => {
      ruleNames.push(ref.split("/")[1]);
      if (meta.inclusion === "fileMatch") scopedRules.set(ref, sm?.fileMatchPattern ?? "");
      else refs.base.push(ref);
    });
  }

  /* ---- agents ---- */
  const agentBodies = new Map<string, string>();
  for (const f of await safeList(path.join(claudeDir, "agents"))) {
    if (!f.endsWith(".md")) continue;
    const src = await readSource(path.join(claudeDir, "agents", f));
    const text = src.text;
    const { data, body, raw } = parseFrontmatter<Record<string, string>>(text, { loose: true });
    const name = (data.name || f.replace(/\.md$/, "")).trim();
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
      origin: origin(`.claude/agents/${f}`),
    };
    read(meta, { "agent.md": body }, scanOf("agent.md", src), (ref) => {
      agentBodies.set(ref, (data.description ?? "") + "\n" + body);
      refs.base.push(ref);
    });
  }

  /* ---- commands ---- */
  for (const f of await safeList(path.join(claudeDir, "commands"))) {
    if (!f.endsWith(".md")) continue;
    const src = await readSource(path.join(claudeDir, "commands", f));
    const text = src.text;
    const { data, body, raw } = parseFrontmatter<Record<string, string>>(text, { loose: true });
    const meta: Ingredient = {
      type: "command",
      name: f.replace(/\.md$/, ""),
      description: data.description?.trim(),
      argumentHint: data["argument-hint"]?.trim() || undefined,
      allowedTools: data["allowed-tools"]?.trim() || undefined,
      file: "command.md",
      frontmatterRaw: raw ?? undefined,
      targets: "*",
      tags: [],
      origin: origin(`.claude/commands/${f}`),
    };
    read(meta, { "command.md": body }, scanOf("command.md", src), (ref) => addRef(refs.base, ref));
  }

  /* ---- skills ---- */
  const skillsDir = path.join(claudeDir, "skills");
  if (await exists(skillsDir)) {
    // Sorted, so the decision order — and which of two sources is "the later one" — is reproducible (spec 10 §14 Q6).
    for (const e of (await fs.readdir(skillsDir, { withFileTypes: true })).sort((x, y) => x.name.localeCompare(y.name))) {
      if (e.name === ".gitkeep") continue;
      if (e.isDirectory()) {
        const files: Record<string, string | Buffer> = {};
        const scan: Record<string, string> = {};
        for (const rel of await listFiles(path.join(skillsDir, e.name))) {
          const abs = path.join(skillsDir, e.name, rel);
          if (/\.(md|txt|json|ya?ml|ps1|py|sh|js|ts)$/i.test(rel)) {
            const src = await readSource(abs);
            files[rel] = toLf(stripBom(src.text));
            Object.assign(scan, scanOf(rel, src));
          } else files[rel] = await fs.readFile(abs);
        }
        if (!files["SKILL.md"]) {
          report.warnings.push(`skill dir ${e.name} has no SKILL.md; skipped`);
          continue;
        }
        const meta: Ingredient = { type: "skill", name: e.name, layout: "dir", targets: "*", tags: [], origin: origin(`.claude/skills/${e.name}/`) };
        read(meta, files, scan, (ref) => addRef(refs.base, ref));
      } else if (e.name.endsWith(".md")) {
        const src = await readSource(path.join(skillsDir, e.name));
        const text = toLf(stripBom(src.text));
        const meta: Ingredient = { type: "skill", name: e.name.replace(/\.md$/, ""), layout: "file", targets: "*", tags: [], origin: origin(`.claude/skills/${e.name}`) };
        read(meta, { "SKILL.md": text }, scanOf("SKILL.md", src), (ref) => addRef(refs.base, ref));
      }
    }
  }

  /* ---- scripts & hooks ---- */
  for (const kind of ["scripts", "hooks"] as const) {
    for (const f of await safeList(path.join(claudeDir, kind))) {
      if (f === ".gitkeep" || f.startsWith("__pycache__") || f.endsWith(".pyc")) continue;
      const abs = path.join(claudeDir, kind, f);
      if (!(await fs.stat(abs)).isFile()) continue;
      const src = /\.(ps1|py|sh|js|ts|cjs|mjs|json|md|txt|ya?ml)$/i.test(f) ? await readSource(abs) : null;
      const content = src ? toLf(stripBom(src.text)) : await fs.readFile(abs);
      const meta: Ingredient = {
        type: kind === "scripts" ? "script" : "hook",
        name: f.replace(/\.[^.]+$/, "").toLowerCase(),
        files: [f],
        targets: ["claude-code"],
        tags: [],
        origin: origin(`.claude/${kind}/${f}`),
      } as Ingredient;
      read(meta, { [f]: content }, src ? scanOf(f, src) : {}, (ref) => addRef(refs.base, ref));
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
      const meta: Ingredient = { type: "mcp", name, server, targets: "*", tags: [], origin: origin(".mcp.json") };
      read(meta, {}, {}, (ref) => addRef(refs.base, ref));
    }
  }

  /* ---- hand-written Kiro steering (no Claude counterpart) ---- */
  // Whether a steering file is hand-written depends on the rules decided before it, so the check runs at decision time.
  for (const [name, sm] of steeringMeta) {
    const meta: Ingredient = { type: "steering", name, file: "steering.md", targets: ["kiro"], tags: ["client"], origin: origin(`.kiro/steering/${name}.md`) };
    read(meta, { "steering.md": sm.text }, scanOf("steering.md", sm), (ref) => addRef(refs.steering, ref), () => ruleNames.includes(name) || sm.generated || name === "commands");
  }

  /* ---- what the importing profile renders (spec 10 §6.1, §6.8 step 2) ---- */
  const loaded = await forgeBefore(forge, manifestOnDisk);
  const existing = await existingProfile(forge, opts.profileName, loaded);
  const readWs = (abs: string) => fs.readFile(abs, "utf8");
  const ctx: RunContext = {
    P: Object.assign(Object.create(null), existing.params),
    W: await workspaceParams(ws, readWs),
    PS: structuredClone(existing.sections),
    WS: await workspaceSections(ws, readWs),
    pinned: new Map(),
    forge: loaded,
    markedBase: false,
  };
  // F9 (§6.5): a source rejected for a secret or skipped is never decided. Its base stays in the Forge-wide scan (b),
  // and its text leaves the literal check (c). `ruleNames` fills only as rules are decided, so each set errs on its
  // safe side for a steering file a rule of its name may shadow: out of `runBases`, still in `others`.
  const queuedRules = new Set(queue.filter((q) => q.meta.type === "rule").map((q) => q.meta.name));
  const mayBeSkipped = (q: Source) => q.skip?.() || (q.meta.type === "steering" && queuedRules.has(q.meta.name));
  const clean = queue.filter((q) => !secretIn(q.meta, q.files, q.scan));
  const runBases = new Set(clean.filter((q) => !mayBeSkipped(q)).map((q) => `${q.meta.type}/${q.meta.name}`));
  const mayBeDecided = clean.filter((q) => !q.skip?.());
  const literal: Array<{ ref: string; source: string; meta: Ingredient; files: Record<string, string | Buffer> }> = [];

  /* ---- decide, in read order ---- */
  for (const src of queue) {
    if (src.skip?.()) continue;
    const others = mayBeDecided.filter((q) => q !== src).map((q) => ({ ref: `${q.meta.type}/${q.meta.name}`, meta: q.meta, files: q.files }));
    const ref = await writeIngredient(stage, src.meta, src.files, opts.profileName, report, src.scan, { ctx, others, runBases, literal });
    if (ref) src.after(ref);
  }

  // I3: a created or variant ingredient is the workspace text itself; a key the profile now sets would change it at sync.
  // I11 first (spec 11 §6.9): a column-0 marker in that text would be read as structure, so sync could not reproduce it.
  for (const l of literal) {
    const marker = markerIn(l.meta, l.files, l.source);
    if (marker) throw new Error(`import: ${marker.where} holds a section marker on line ${marker.line} — sync would not reproduce it; indent it or remove it, and re-run`);
    const map = renderMap(l.meta, ctx.P, ctx.W);
    const key = [...sourceKeys(l.meta, l.files)].find((k) => Object.hasOwn(map, k));
    if (key) throw new Error(`import: ${l.source} holds {{${key}}} literally, but profile ${opts.profileName} sets ${key} — sync would render it`);
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
  const recipeOpts: RecipeOptions = { stage, dir: recipesDir, profile: opts.profileName, forge: ctx.forge, report, currentRules: currentRuleOrder(ctx.forge, opts.profileName) };

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
  const targets: Target[] = ["claude-code"];
  if (await exists(path.join(ws, ".kiro"))) targets.push("kiro");
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

/** First secret-like value in an ingredient about to be imported, described by location only. */
function secretIn(meta: Ingredient, files: Record<string, string | Buffer>, scan: Record<string, string> = {}): string | null {
  const origin = meta.origin?.path ?? `${meta.type}/${meta.name}`;
  const raw = "frontmatterRaw" in meta ? meta.frontmatterRaw : undefined;
  // Bodies of agents and commands start after `---`, the raw block and the closing `---`.
  const bodyOffset = raw ? raw.split("\n").length + 2 : 0;
  const texts: { where: string; text: string; offset: number }[] = [];
  if (raw) texts.push({ where: origin, text: raw, offset: 1 });
  for (const [rel, content] of Object.entries(files)) {
    const where = meta.type === "skill" && meta.layout === "dir" ? `${origin}${rel}` : origin;
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
    const where = meta.type === "skill" && meta.layout === "dir" ? `${origin}${rel}` : origin;
    texts.push({ where, text, offset: 0 });
  }
  for (const t of texts) {
    const hit = findSecrets(t.text)[0];
    if (hit) return `secret-like value (${hit.kind}) in ${t.where} line ${hit.line + t.offset}`;
  }
  if (meta.type === "mcp") {
    // Walk every field of the server config, not just env/args: headers, url, command, etc.
    // can carry a token too. Entropy stays reserved for env/args; every other field is
    // checked against known patterns only.
    const server: Record<string, unknown> = meta.server;
    for (const [key, value] of Object.entries(server)) {
      const hit = secretInServerField(meta.name, key, value, key === "env" || key === "args");
      if (hit) return hit;
    }
  }
  return null;
}

/** Recursively scan one MCP server field for a secret-like value, building a dotted/bracketed field path. */
function secretInServerField(server: string, field: string, value: unknown, useEntropy: boolean): string | null {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const hit = secretInServerField(server, `${field}[${i}]`, v, useEntropy);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const hit = secretInServerField(server, `${field}.${k}`, v, useEntropy);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value !== "string" && typeof value !== "number") return null;
  const kind = useEntropy ? secretValueKind(String(value)) : (findSecrets(String(value))[0]?.kind ?? null);
  return kind ? `secret-like value (${kind}) in .mcp.json → mcpServers.${server}.${field}` : null;
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
  run?: { ctx: RunContext; others: Array<{ ref: string; meta: Ingredient; files: Record<string, string | Buffer> }>; runBases: Set<string>; literal: Array<{ ref: string; source: string; meta: Ingredient; files: Record<string, string | Buffer> }> },
): Promise<string | null> {
  const secret = secretIn(meta, files, scan);
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
  if (await stage.exists(path.join(dir, "ingredient.yaml"))) {
    let why: string | undefined;
    const d = run ? await decide(run.ctx, dir, stage.reader(), ref, sourceMeta, files, fingerprint, run.others, run.runBases) : { kind: "literal" as const, warn: "" };
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
    }
    const as = meta.name;
    name = `${meta.name}--${profile}`;
    dir = path.join(forge, "ingredients", folder, name);
    report.variants.push({ name: `${meta.type}/${name}`, reason: `differs from ${meta.type}/${as} already in the Forge${why ? ` (${why})` : ""}` });

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
    run.literal.push({ ref: `${meta.type}/${name}`, source, meta: sourceMeta, files });
  }

  // Build the YAML preserving key order. For MCP, authEnv sits immediately before server.
  const yamlMeta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === "authEnv") continue;
    // authEnv is emitted with server because only an mcp metadata can hold it (the schema refuses it elsewhere).
    if (k === "server" && "authEnv" in meta) yamlMeta.authEnv = meta.authEnv;
    yamlMeta[k] = v;
  }
  stage.write(path.join(dir, "ingredient.yaml"), YAML.stringify(yamlMeta, { lineWidth: 0 }));
  for (const [rel, content] of Object.entries(files)) stage.write(path.join(dir, rel), content);
  return `${meta.type}/${name}`;
}

/**
 * The ingredient as the Forge will load it back. An ingredient that would not load (a non-string MCP
 * `env` value, a name that is not slug-like) fails the whole import, naming its source, before the
 * first write — 0.2.4 wrote a Forge no command could load (spec 07, Ruling 6).
 */
function validateImported(meta: Ingredient): Ingredient {
  const r = IngredientSchema.safeParse(meta);
  if (r.success) return r.data;
  const source = meta.origin?.path ?? `${meta.type}/${meta.name}`;
  throw new Error(`${source} (${meta.type}/${meta.name}) does not fit the ingredient schema: ${r.error.message}`);
}

interface RecipeOptions {
  stage: ForgeStage;
  dir: string;
  profile: string;
  forge: import("../core/forge.js").Forge | null;
  report: ImportReport;
  /** The rules the profile resolves today, in resolution order; null for a new profile (spec 10 §14 Q10). */
  currentRules: string[] | null;
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
  if (holdsVariant) return writeOwnedRecipe(o, owned, list, description);
  const file = await recipeFile(o, name);
  if (!(await o.stage.exists(file))) {
    o.stage.write(file, recipeText(name, description, list));
    o.report.recipes.push(name);
    return name;
  }
  const existing = parseYaml(file, stripBom(await o.stage.readText(file)), RecipeSchema).ingredients;
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
async function recipeFile(o: RecipeOptions, name: string): Promise<string> {
  const file = path.join(o.dir, `${name}.yaml`);
  for (const f of await o.stage.reader().list(o.dir)) {
    if (f.includes("/") || !/\.ya?ml$/.test(f)) continue;
    const abs = path.join(o.dir, f);
    const declared = parseYaml(abs, stripBom(await o.stage.readText(abs)), RecipeSchema).name;
    if (abs === file && declared !== name) throw new Error(`import: recipes/${f} is recipe ${declared} — import writes recipe ${name} there`);
    if (abs !== file && declared === name) throw new Error(`import: recipe ${name} is recipes/${f} — import writes recipes/${name}.yaml`);
  }
  return file;
}

/** The recipes a profile resolves inside the Forge; fails closed — a profile that does not resolve counts as using everything. */
function recipesOf(forge: import("../core/forge.js").Forge, profile: string): { has(name: string): boolean } {
  try {
    return new Set(resolve(forge, WorkspaceConfigSchema.parse({ forge: ".", profile })).recipes);
  } catch {
    return { has: () => true };
  }
}

/**
 * The importing profile's params and sections before the run (`P`, `PS`; spec 10 §6.1, spec 11 §6.7), and I4: import writes
 * `profiles/<p>/profile.yaml`, so a profile named `<p>` elsewhere, or that file naming another
 * profile, would leave two files for one name.
 */
async function existingProfile(
  forge: string,
  profile: string,
  loaded: import("../core/forge.js").Forge | null,
): Promise<{ params: Record<string, unknown>; sections: Sections }> {
  if (!loaded) return { params: {}, sections: {} };
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
  return { params: { ...(p?.params ?? {}) }, sections: p?.sections ?? {} };
}

/**
 * I11 (spec 11 §4.5): the first column-0 section marker (or near miss) in a body file of a
 * created or variant source, which sync would read as structure. The line counts from the top of
 * the workspace file, as the secret scan's does: an agent or command body starts after its frontmatter.
 */
function markerIn(meta: Ingredient, files: Record<string, string | Buffer>, source: string): { where: string; line: number } | null {
  const raw = "frontmatterRaw" in meta ? meta.frontmatterRaw : undefined;
  const offset = raw ? raw.split("\n").length + 2 : 0;
  for (const [rel, content] of Object.entries(files)) {
    // the importer builds meta and file keys itself, with canonical names
    if (!bodyFile(meta, rel, null)) continue;
    const line = firstMarkerLine(toLf(stripBom(typeof content === "string" ? content : content.toString("utf8"))));
    if (line !== null) return { where: meta.type === "skill" && meta.layout === "dir" ? `${source}${rel}` : source, line: line + offset };
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
  if (!loaded.success) throw i9(`it no longer loads: ${loaded.error.message}`);
  return { abs, content, action: content === raw ? "unchanged" : "edited", keptRemote };
}
