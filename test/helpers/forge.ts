import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

export interface IngredientSpec {
  meta: Record<string, unknown> & { type: string; name: string };
  files?: Record<string, string | Buffer>;
}

export interface ForgeSpec {
  ingredients?: IngredientSpec[];
  recipes?: Array<Record<string, unknown> & { name: string }>;
  profiles?: Array<Record<string, unknown> & { name: string }>;
}

export interface WorkspaceSpec {
  /** craftar.yaml; `forge` defaults to the relative path of the scenario Forge. */
  config: Record<string, unknown>;
  /** craftar.local.yaml, written only when present. */
  local?: Record<string, unknown>;
  /** Files already on disk in the workspace (workspace-relative, POSIX). */
  files?: Record<string, string | Buffer>;
}

export function tmpDir(prefix = "craftar-test-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeFiles(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

const folder = (type: string) => (type === "mcp" ? "mcp" : `${type}s`);

export async function makeForge(root: string, spec: ForgeSpec): Promise<void> {
  await writeFiles(root, { "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 1 }) });
  for (const ing of spec.ingredients ?? []) {
    const dir = path.join(root, "ingredients", folder(ing.meta.type), ing.meta.name);
    await writeFiles(dir, { "ingredient.yaml": YAML.stringify(ing.meta), ...(ing.files ?? {}) });
  }
  for (const r of spec.recipes ?? []) await writeFiles(root, { [`recipes/${r.name}.yaml`]: YAML.stringify(r) });
  for (const p of spec.profiles ?? []) await writeFiles(root, { [`profiles/${p.name}/profile.yaml`]: YAML.stringify(p) });
}

export async function makeWorkspace(root: string, forgeRoot: string, spec: WorkspaceSpec): Promise<void> {
  const config = { forge: path.relative(root, forgeRoot).replace(/\\/g, "/"), ...spec.config };
  await writeFiles(root, { "craftar.yaml": YAML.stringify(config) });
  if (spec.local) await writeFiles(root, { "craftar.local.yaml": YAML.stringify(spec.local) });
  await writeFiles(root, spec.files ?? {});
}

/** A temp dir holding `forge/` and `ws/`. Call `cleanup()` in afterEach. */
export async function scenario(forge: ForgeSpec, ws: WorkspaceSpec) {
  const root = await tmpDir();
  const forgeRoot = path.join(root, "forge");
  const wsRoot = path.join(root, "ws");
  await makeForge(forgeRoot, forge);
  await makeWorkspace(wsRoot, forgeRoot, ws);
  return { root, forgeRoot, wsRoot, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

export const rule = (name: string, body: string, extra: Record<string, unknown> = {}): IngredientSpec => ({
  meta: { type: "rule", name, ...extra },
  files: { "rule.md": body },
});

export const recipe = (name: string, ingredients: string[], extra: Record<string, unknown> = {}) => ({ name, ingredients, ...extra });

export const profile = (name: string, recipes: string[], targets: string[] = ["claude-code"], extra: Record<string, unknown> = {}) => ({
  name,
  recipes,
  targets,
  ...extra,
});
