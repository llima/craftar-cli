import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { parseFrontmatter } from "../core/frontmatter.js";
import { exists, listFiles, typeFolder, FORGE_MANIFEST } from "../core/forge.js";
import { decodeForScan, findSecrets, hasUtf16Bom, secretValueKind } from "../core/secrets.js";
import { stripBom, toLf } from "../core/text.js";
import { fingerprintDir, fingerprintOf, type DirReader } from "../core/fingerprint.js";
import { IngredientSchema, type Ingredient, type McpServer, type Profile, type Recipe, type Target } from "../schema/index.js";
import { resolvedBy } from "../core/param-writes.js";
import { decide, forgeBefore, pin, sourceKeys, workspaceParams, type RunContext } from "./decide.js";
import { renderMap } from "../core/template-import.js";

export interface ImportOptions {
  workspaceRoot: string;
  forgeRoot: string;
  profileName: string;
  /** Also write craftar.yaml into the workspace. */
  writeWorkspaceConfig?: boolean;
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
  /** Reused because the render matched and used at least one value (spec 10 §6.2). */
  rendered: { name: string; keys: string[] }[];
  /** Reused through an inference: every hole's proved value (spec 10 §6.3). */
  inferred: { name: string; values: Record<string, string> }[];
  /** The profile change, in the order it was accepted; `old` is null for an added key. */
  params: { key: string; old: string | null; value: string; from: string }[];
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

const GENERATED_BANNER = /<!--\s*GENERATED from /;

/**
 * Import a Claude Code workspace into a Forge. The run happens in two phases: every read,
 * comparison and check that can throw runs first against an in-memory stage, and only then are the
 * staged files written. A failure in the first phase therefore leaves the Forge untouched, and the
 * error says so; a failure while writing names the paths already written.
 */
export async function importClaudeCode(opts: ImportOptions): Promise<ImportReport> {
  const stage = new ForgeStage(path.resolve(opts.forgeRoot));
  let planned: { report: ImportReport; targets: Target[] };
  try {
    planned = await planImport(opts, stage);
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\nThe Forge was left untouched.`, { cause: e });
  }
  await stage.flush();
  const { report, targets } = planned;
  if (opts.writeWorkspaceConfig) {
    const ws = path.resolve(opts.workspaceRoot);
    const rel = path.relative(ws, stage.root).replace(/\\/g, "/") || ".";
    await fs.writeFile(path.join(ws, "craftar.yaml"), YAML.stringify({ forge: rel, profile: opts.profileName, targets }));
    report.created.push("craftar.yaml (workspace)");
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

async function planImport(opts: ImportOptions, stage: ForgeStage): Promise<{ report: ImportReport; targets: Target[] }> {
  const ws = path.resolve(opts.workspaceRoot);
  const forge = stage.root;
  const report: ImportReport = {
    created: [], reused: [], variants: [], rejected: [], recipes: [], profile: opts.profileName, warnings: [], rendered: [], inferred: [], params: [],
  };
  const claudeDir = path.join(ws, ".claude");
  if (!(await exists(claudeDir))) throw new Error(`${claudeDir} not found — is this a Claude Code workspace?`);

  const manifest = path.join(forge, FORGE_MANIFEST);
  const manifestOnDisk = manifest;
  if (!(await stage.exists(manifest))) {
    stage.write(manifest, YAML.stringify({ name: path.basename(forge), schema: 1, description: "Craftar Forge — shared harness ingredients, recipes and client profiles." }));
    report.created.push(FORGE_MANIFEST);
  }

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
    for (const f of await fs.readdir(steeringDir)) {
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
    for (const e of await fs.readdir(skillsDir, { withFileTypes: true })) {
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
  const ctx: RunContext = {
    P: Object.assign(Object.create(null), await existingProfileParams(forge, opts.profileName, loaded)),
    W: await workspaceParams(ws, (abs) => fs.readFile(abs, "utf8")),
    pinned: new Map(),
    forge: loaded,
  };
  const runBases = new Set(queue.map((q) => `${q.meta.type}/${q.meta.name}`));
  const literal: Array<{ ref: string; source: string; meta: Ingredient; files: Record<string, string | Buffer> }> = [];

  /* ---- decide, in read order ---- */
  for (const src of queue) {
    if (src.skip?.()) continue;
    const others = queue.filter((q) => q !== src).map((q) => ({ ref: `${q.meta.type}/${q.meta.name}`, meta: q.meta, files: q.files }));
    const ref = await writeIngredient(stage, src.meta, src.files, opts.profileName, report, src.scan, { ctx, others, runBases, literal });
    if (ref) src.after(ref);
  }

  // I3: a created or variant ingredient is the workspace text itself; a key the profile now sets would change it at sync.
  for (const l of literal) {
    const map = renderMap(l.meta, ctx.P, ctx.W);
    const key = [...sourceKeys(l.meta, l.files)].find((k) => Object.hasOwn(map, k));
    if (key) throw new Error(`import: ${l.source} holds {{${key}}} literally, but profile ${opts.profileName} sets ${key} — sync would render it`);
  }

  /* ---- recipes ---- */
  const recipesDir = path.join(forge, "recipes");
  const isVariant = (ref: string) => report.variants.some((v) => v.name === ref);
  const suffixIf = (name: string, ingredients: string[]) => (ingredients.some(isVariant) ? `${name}--${opts.profileName}` : name);

  const stackRecipes: string[] = [];
  for (const [ruleRef, pattern] of scopedRules) {
    const ruleName = ruleRef.split("/")[1].replace(/--.*$/, "");
    const agents = [...agentBodies].filter(([ref, body]) => agentBelongsTo(ref.split("/")[1], ruleName, body)).map(([ref]) => ref);
    for (const a of agents) refs.base = refs.base.filter((r) => r !== a);
    const ingredients = [ruleRef, ...agents];
    const recipeName = suffixIf(`stack-${ruleName}`, ingredients);
    await writeRecipe(stage, recipesDir, { name: recipeName, description: `Conventions + reviewer for repos matching ${pattern}`, extends: [], ingredients, params: {} }, report);
    stackRecipes.push(recipeName);
  }

  const baseIngredients = unique(refs.base);
  const baseName = suffixIf("base", baseIngredients);
  await writeRecipe(stage, recipesDir, { name: baseName, description: "Always-on conventions, commands, agents, scripts and MCP servers.", extends: [], ingredients: baseIngredients, params: {} }, report);
  const profileRecipes = [baseName, ...stackRecipes];
  if (refs.steering.length) {
    const n = `${opts.profileName}-steering`;
    await writeRecipe(stage, recipesDir, { name: n, description: `Hand-written Kiro steering specific to ${opts.profileName}.`, extends: [], ingredients: refs.steering, params: {} }, report);
    profileRecipes.push(n);
  }

  /* ---- profile ---- */
  const targets: Target[] = ["claude-code"];
  if (await exists(path.join(ws, ".kiro"))) targets.push("kiro");
  const profile: Profile = {
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
    params: {},
    repos: [],
  };
  stage.write(path.join(forge, "profiles", opts.profileName, "profile.yaml"), YAML.stringify(profile));
  report.created.push(`profiles/${opts.profileName}/profile.yaml`);
  return { report, targets };
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
      if (d.rendered) report.rendered.push({ name: ref, keys: d.rendered });
      if (d.inferred) report.inferred.push({ name: ref, values: d.inferred });
      for (const x of d.delta ?? []) report.params.push({ ...x, from: ref });
      return ref;
    } else {
      why = d.why;
    }
    const as = meta.name;
    name = `${meta.name}--${profile}`;
    dir = path.join(forge, "ingredients", folder, name);
    report.variants.push({ name: `${meta.type}/${name}`, reason: `differs from ${meta.type}/${as} already in the Forge${why ? ` (${why})` : ""}` });
    meta = { ...meta, name, as } as Ingredient;
    validateImported(meta); // the variant name must be slug-like too (a `--profile` with a space is not)
    // I8: rewriting an existing variant another profile resolves would change its files there.
    if (run?.ctx.forge && (await stage.exists(path.join(dir, "ingredient.yaml"))) && (await fingerprintDir(dir, stage.reader())) !== fingerprintOf(validateImported(meta), files)) {
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

  const yamlMeta: Record<string, unknown> = { ...meta };
  if (yamlMeta.targets === "*") yamlMeta.targets = "*";
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

async function writeRecipe(stage: ForgeStage, dir: string, recipe: Recipe, report: ImportReport): Promise<void> {
  const file = path.join(dir, `${recipe.name}.yaml`);
  const clean = JSON.parse(JSON.stringify(recipe)); // drop undefined
  if (await stage.exists(file)) {
    const prev = YAML.parse(await stage.readText(file));
    clean.ingredients = unique([...(prev.ingredients ?? []), ...clean.ingredients]);
  }
  stage.write(file, YAML.stringify(clean));
  report.recipes.push(recipe.name);
}

/**
 * The importing profile's params before the run (`P`, spec 10 §6.1), and I4: import writes
 * `profiles/<p>/profile.yaml`, so a profile named `<p>` elsewhere, or that file naming another
 * profile, would leave two files for one name.
 */
async function existingProfileParams(forge: string, profile: string, loaded: import("../core/forge.js").Forge | null): Promise<Record<string, unknown>> {
  if (!loaded) return {};
  const dir = path.join(forge, "profiles");
  for (const d of (await exists(dir)) ? await fs.readdir(dir, { withFileTypes: true }) : []) {
    if (!d.isDirectory()) continue;
    const abs = path.join(dir, d.name, "profile.yaml");
    if (!(await exists(abs))) continue;
    const name = (YAML.parse(stripBom(await fs.readFile(abs, "utf8"))) ?? {}).name;
    if ((name === profile) !== (d.name === profile)) {
      throw new Error(`import: profile ${profile} is profiles/${d.name}/profile.yaml — import writes profiles/${profile}/profile.yaml`);
    }
  }
  return { ...(loaded.profiles.get(profile)?.params ?? {}) };
}
