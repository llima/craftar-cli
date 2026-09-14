import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { parseFrontmatter } from "../core/frontmatter.js";
import { exists, listFiles, typeFolder, FORGE_MANIFEST } from "../core/forge.js";
import { findSecrets, secretValueKind } from "../core/secrets.js";
import { hashNormalized, stripBom, toLf } from "../core/text.js";
import type { Ingredient, Profile, Recipe, Target } from "../schema/index.js";

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

export async function importClaudeCode(opts: ImportOptions): Promise<ImportReport> {
  const ws = path.resolve(opts.workspaceRoot);
  const forge = path.resolve(opts.forgeRoot);
  const report: ImportReport = { created: [], reused: [], variants: [], rejected: [], recipes: [], profile: opts.profileName, warnings: [] };
  const claudeDir = path.join(ws, ".claude");
  if (!(await exists(claudeDir))) throw new Error(`${claudeDir} not found — is this a Claude Code workspace?`);

  await fs.mkdir(forge, { recursive: true });
  const manifest = path.join(forge, FORGE_MANIFEST);
  if (!(await exists(manifest))) {
    await fs.writeFile(manifest, YAML.stringify({ name: path.basename(forge), schema: 1, description: "Craftar Forge — shared harness ingredients, recipes and client profiles." }));
    report.created.push(FORGE_MANIFEST);
  }

  const origin = (rel: string) => ({ workspace: path.basename(ws), path: rel.replace(/\\/g, "/") });
  const refs = { base: [] as string[], stacks: new Map<string, string[]>(), steering: [] as string[] };
  const ruleNames: string[] = [];
  const scopedRules = new Map<string, string>(); // rule name → fileMatchPattern

  /* ---- Kiro steering gives us inclusion modes and hand-written steering ---- */
  const steeringDir = path.join(ws, ".kiro", "steering");
  const steeringMeta = new Map<string, { inclusion: string; fileMatchPattern?: string; generated: boolean; text: string }>();
  if (await exists(steeringDir)) {
    for (const f of await fs.readdir(steeringDir)) {
      if (!f.endsWith(".md")) continue;
      const text = toLf(stripBom(await fs.readFile(path.join(steeringDir, f), "utf8")));
      const { data, body } = parseFrontmatter<{ inclusion?: string; fileMatchPattern?: string }>(text);
      steeringMeta.set(f.replace(/\.md$/, ""), {
        inclusion: data.inclusion ?? "always",
        fileMatchPattern: data.fileMatchPattern,
        generated: GENERATED_BANNER.test(body.slice(0, 300)),
        text,
      });
    }
  }

  /* ---- rules ---- */
  for (const f of await safeList(path.join(claudeDir, "rules"))) {
    if (!f.endsWith(".md")) continue;
    const name = f.replace(/\.md$/, "");
    const text = toLf(stripBom(await fs.readFile(path.join(claudeDir, "rules", f), "utf8")));
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
    const ref = await writeIngredient(forge, meta, { "rule.md": text }, opts.profileName, report);
    if (!ref) continue;
    ruleNames.push(ref.split("/")[1]);
    if (meta.inclusion === "fileMatch") scopedRules.set(ref, sm?.fileMatchPattern ?? "");
    else refs.base.push(ref);
  }

  /* ---- agents ---- */
  const agentBodies = new Map<string, string>();
  for (const f of await safeList(path.join(claudeDir, "agents"))) {
    if (!f.endsWith(".md")) continue;
    const text = await fs.readFile(path.join(claudeDir, "agents", f), "utf8");
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
    const ref = await writeIngredient(forge, meta, { "agent.md": body }, opts.profileName, report);
    if (!ref) continue;
    agentBodies.set(ref, (data.description ?? "") + "\n" + body);
    refs.base.push(ref);
  }

  /* ---- commands ---- */
  for (const f of await safeList(path.join(claudeDir, "commands"))) {
    if (!f.endsWith(".md")) continue;
    const text = await fs.readFile(path.join(claudeDir, "commands", f), "utf8");
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
    addRef(refs.base, await writeIngredient(forge, meta, { "command.md": body }, opts.profileName, report));
  }

  /* ---- skills ---- */
  const skillsDir = path.join(claudeDir, "skills");
  if (await exists(skillsDir)) {
    for (const e of await fs.readdir(skillsDir, { withFileTypes: true })) {
      if (e.name === ".gitkeep") continue;
      if (e.isDirectory()) {
        const files: Record<string, string | Buffer> = {};
        for (const rel of await listFiles(path.join(skillsDir, e.name))) {
          const abs = path.join(skillsDir, e.name, rel);
          files[rel] = /\.(md|txt|json|ya?ml|ps1|py|sh|js|ts)$/i.test(rel) ? toLf(stripBom(await fs.readFile(abs, "utf8"))) : await fs.readFile(abs);
        }
        if (!files["SKILL.md"]) {
          report.warnings.push(`skill dir ${e.name} has no SKILL.md; skipped`);
          continue;
        }
        const meta: Ingredient = { type: "skill", name: e.name, layout: "dir", targets: "*", tags: [], origin: origin(`.claude/skills/${e.name}/`) };
        addRef(refs.base, await writeIngredient(forge, meta, files, opts.profileName, report));
      } else if (e.name.endsWith(".md")) {
        const text = toLf(stripBom(await fs.readFile(path.join(skillsDir, e.name), "utf8")));
        const meta: Ingredient = { type: "skill", name: e.name.replace(/\.md$/, ""), layout: "file", targets: "*", tags: [], origin: origin(`.claude/skills/${e.name}`) };
        addRef(refs.base, await writeIngredient(forge, meta, { "SKILL.md": text }, opts.profileName, report));
      }
    }
  }

  /* ---- scripts & hooks ---- */
  for (const kind of ["scripts", "hooks"] as const) {
    for (const f of await safeList(path.join(claudeDir, kind))) {
      if (f === ".gitkeep" || f.startsWith("__pycache__") || f.endsWith(".pyc")) continue;
      const abs = path.join(claudeDir, kind, f);
      if (!(await fs.stat(abs)).isFile()) continue;
      const content = /\.(ps1|py|sh|js|ts|cjs|mjs|json|md|txt|ya?ml)$/i.test(f) ? toLf(stripBom(await fs.readFile(abs, "utf8"))) : await fs.readFile(abs);
      const meta: Ingredient = {
        type: kind === "scripts" ? "script" : "hook",
        name: f.replace(/\.[^.]+$/, "").toLowerCase(),
        files: [f],
        targets: ["claude-code"],
        tags: [],
        origin: origin(`.claude/${kind}/${f}`),
      } as Ingredient;
      addRef(refs.base, await writeIngredient(forge, meta, { [f]: content }, opts.profileName, report));
    }
  }

  /* ---- MCP servers ---- */
  const mcpFile = path.join(ws, ".mcp.json");
  if (await exists(mcpFile)) {
    const json = JSON.parse(stripBom(await fs.readFile(mcpFile, "utf8")));
    for (const [name, server] of Object.entries<any>(json.mcpServers ?? {})) {
      const meta: Ingredient = { type: "mcp", name, server, targets: "*", tags: [], origin: origin(".mcp.json") };
      addRef(refs.base, await writeIngredient(forge, meta, {}, opts.profileName, report));
    }
  }

  /* ---- hand-written Kiro steering (no Claude counterpart) ---- */
  for (const [name, sm] of steeringMeta) {
    if (ruleNames.includes(name) || sm.generated) continue;
    if (name === "commands") continue;
    const meta: Ingredient = { type: "steering", name, file: "steering.md", targets: ["kiro"], tags: ["client"], origin: origin(`.kiro/steering/${name}.md`) };
    addRef(refs.steering, await writeIngredient(forge, meta, { "steering.md": sm.text }, opts.profileName, report));
  }

  /* ---- recipes ---- */
  const recipesDir = path.join(forge, "recipes");
  await fs.mkdir(recipesDir, { recursive: true });
  const isVariant = (ref: string) => report.variants.some((v) => v.name === ref);
  const suffixIf = (name: string, ingredients: string[]) => (ingredients.some(isVariant) ? `${name}--${opts.profileName}` : name);

  const stackRecipes: string[] = [];
  for (const [ruleRef, pattern] of scopedRules) {
    const ruleName = ruleRef.split("/")[1].replace(/--.*$/, "");
    const agents = [...agentBodies].filter(([ref, body]) => agentBelongsTo(ref.split("/")[1], ruleName, body)).map(([ref]) => ref);
    for (const a of agents) refs.base = refs.base.filter((r) => r !== a);
    const ingredients = [ruleRef, ...agents];
    const recipeName = suffixIf(`stack-${ruleName}`, ingredients);
    await writeRecipe(recipesDir, { name: recipeName, description: `Conventions + reviewer for repos matching ${pattern}`, extends: [], ingredients, params: {} }, report);
    stackRecipes.push(recipeName);
  }

  const baseIngredients = unique(refs.base);
  const baseName = suffixIf("base", baseIngredients);
  await writeRecipe(recipesDir, { name: baseName, description: "Always-on conventions, commands, agents, scripts and MCP servers.", extends: [], ingredients: baseIngredients, params: {} }, report);
  const profileRecipes = [baseName, ...stackRecipes];
  if (refs.steering.length) {
    const n = `${opts.profileName}-steering`;
    await writeRecipe(recipesDir, { name: n, description: `Hand-written Kiro steering specific to ${opts.profileName}.`, extends: [], ingredients: refs.steering, params: {} }, report);
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
  const profDir = path.join(forge, "profiles", opts.profileName);
  await fs.mkdir(profDir, { recursive: true });
  await fs.writeFile(path.join(profDir, "profile.yaml"), YAML.stringify(profile));
  report.created.push(`profiles/${opts.profileName}/profile.yaml`);

  if (opts.writeWorkspaceConfig) {
    const rel = path.relative(ws, forge).replace(/\\/g, "/") || ".";
    await fs.writeFile(path.join(ws, "craftar.yaml"), YAML.stringify({ forge: rel, profile: opts.profileName, targets }));
    report.created.push("craftar.yaml (workspace)");
  }
  return report;
}

/**
 * A reviewer agent belongs to the stack of a scoped rule when its name is derived from the rule name
 * (`backend-oaf-reviewer` ← `backend-oaf`, `frontend-reviewer` ← `frontend-angular`) and it cites the rule.
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
function secretIn(meta: Ingredient, files: Record<string, string | Buffer>): string | null {
  const origin = meta.origin?.path ?? `${meta.type}/${meta.name}`;
  const raw = "frontmatterRaw" in meta ? meta.frontmatterRaw : undefined;
  // Bodies of agents and commands start after `---`, the raw block and the closing `---`.
  const bodyOffset = raw ? raw.split("\n").length + 2 : 0;
  const texts: { where: string; text: string; offset: number }[] = [];
  if (raw) texts.push({ where: origin, text: raw, offset: 1 });
  for (const [rel, content] of Object.entries(files)) {
    const where = meta.type === "skill" && meta.layout === "dir" ? `${origin}${rel}` : origin;
    // A Buffer with no NUL byte is treated as text (e.g. non-allowlisted extensions such
    // as .pem or .bat are still read as Buffer by the importer); a NUL byte marks it binary.
    if (typeof content === "string") texts.push({ where, text: content, offset: bodyOffset });
    else if (!content.includes(0)) texts.push({ where, text: content.toString("utf8"), offset: bodyOffset });
  }
  for (const t of texts) {
    const hit = findSecrets(t.text)[0];
    if (hit) return `secret-like value (${hit.kind}) in ${t.where} line ${hit.line + t.offset}`;
  }
  if (meta.type === "mcp") {
    // Walk every field of the server config, not just env/args: headers, url, command, etc.
    // can carry a token too. Entropy stays reserved for env/args; every other field is
    // checked against known patterns only.
    const server = meta.server as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(server)) {
      const hit = secretInServerField(meta.name, key, value, key === "env" || key === "args");
      if (hit) return hit;
    }
  }
  return null;
}

/** Recursively scan one MCP server field for a secret-like value, building a dotted/bracketed path. */
function secretInServerField(server: string, path: string, value: unknown, useEntropy: boolean): string | null {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const hit = secretInServerField(server, `${path}[${i}]`, v, useEntropy);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const hit = secretInServerField(server, `${path}.${k}`, v, useEntropy);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value !== "string" && typeof value !== "number") return null;
  const kind = useEntropy ? secretValueKind(String(value)) : (findSecrets(String(value))[0]?.kind ?? null);
  return kind ? `secret-like value (${kind}) in .mcp.json → mcpServers.${server}.${path}` : null;
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
  forge: string,
  meta: Ingredient,
  files: Record<string, string | Buffer>,
  profile: string,
  report: ImportReport,
): Promise<string | null> {
  const secret = secretIn(meta, files);
  if (secret) {
    report.rejected.push({ name: `${meta.type}/${meta.name}`, reason: secret });
    return null;
  }
  const folder = typeFolder(meta.type);
  let name = meta.name;
  let dir = path.join(forge, "ingredients", folder, name);
  const fingerprint = fingerprintOf(meta, files);

  if (await exists(path.join(dir, "ingredient.yaml"))) {
    const existing = await fingerprintDir(dir);
    if (existing === fingerprint) {
      report.reused.push(`${meta.type}/${name}`);
      return `${meta.type}/${name}`;
    }
    const as = meta.name;
    name = `${meta.name}--${profile}`;
    dir = path.join(forge, "ingredients", folder, name);
    report.variants.push({ name: `${meta.type}/${name}`, reason: `differs from ${meta.type}/${as} already in the Forge` });
    meta = { ...meta, name, as } as Ingredient;
  } else {
    report.created.push(`${meta.type}/${name}`);
  }

  await fs.mkdir(dir, { recursive: true });
  const yamlMeta: Record<string, unknown> = { ...meta };
  if (yamlMeta.targets === "*") yamlMeta.targets = "*";
  await fs.writeFile(path.join(dir, "ingredient.yaml"), YAML.stringify(yamlMeta, { lineWidth: 0 }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return `${meta.type}/${name}`;
}

function fingerprintOf(meta: Ingredient, files: Record<string, string | Buffer>): string {
  const m: Record<string, unknown> = { ...meta };
  delete m.origin;
  delete m.name;
  delete m.as;
  const parts = [JSON.stringify(m, Object.keys(m).sort())];
  for (const k of Object.keys(files).sort()) parts.push(k, hashNormalized(files[k]));
  return hashNormalized(parts.join(" "));
}

async function fingerprintDir(dir: string): Promise<string> {
  const meta = YAML.parse(await fs.readFile(path.join(dir, "ingredient.yaml"), "utf8"));
  const files: Record<string, Buffer> = {};
  for (const rel of await listFiles(dir)) if (rel !== "ingredient.yaml") files[rel] = await fs.readFile(path.join(dir, rel));
  return fingerprintOf(meta, files);
}

async function writeRecipe(dir: string, recipe: Recipe, report: ImportReport): Promise<void> {
  const file = path.join(dir, `${recipe.name}.yaml`);
  const clean = JSON.parse(JSON.stringify(recipe)); // drop undefined
  if (await exists(file)) {
    const prev = YAML.parse(await fs.readFile(file, "utf8"));
    clean.ingredients = unique([...(prev.ingredients ?? []), ...clean.ingredients]);
  }
  await fs.writeFile(file, YAML.stringify(clean));
  report.recipes.push(recipe.name);
}
