import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { FORGE_SCHEMA_LOCAL_OVERRIDE } from "../../src/schema/index.js";
import { loadWorkspace, plan, type Plan } from "../../src/core/sync.js";
import { runCli } from "./cli.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./forge.js";
import { git } from "./remote.js";

/** Spec 56's fixtures: case 1, case 2 and an override already in place, in synthetic names. */

export const S = FORGE_SCHEMA_LOCAL_OVERRIDE;

export const localRule = (p: string, name: string, body: string, extra: Record<string, unknown> = {}) => ({
  [`profiles/${p}/ingredients/rules/${name}/ingredient.yaml`]: YAML.stringify({ type: "rule", name, ...extra }),
  [`profiles/${p}/ingredients/rules/${name}/rule.md`]: body,
});
export const localRecipe = (p: string, name: string, ingredients: string[]) => ({
  [`profiles/${p}/recipes/${name}.yaml`]: YAML.stringify({ name, ingredients }),
});

/** Case 2 — rule/y is a root base other clients resolve; acme holds its own variant. */
export const CASE2: ForgeSpec = {
  ingredients: [rule("style", "# Style\n"), rule("y", "# Y shared\n"), rule("y--acme", "# Y for acme\n", { as: "y" })],
  recipes: [recipe("base", ["rule/style", "rule/y"]), recipe("base--acme", ["rule/style", "rule/y--acme"])],
  profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"]), profile("initech", ["base"])],
};
/** Case 1 — rule/x is acme's text at the root; x-shared (as: x) is globex's and initech's. */
export const CASE1: ForgeSpec = {
  ingredients: [rule("style", "# Style\n"), rule("x", "# X for acme\n"), rule("x-shared", "# X shared\n", { as: "x" })],
  recipes: [recipe("base", ["rule/style", "rule/x-shared"]), recipe("base--acme", ["rule/style", "rule/x"])],
  profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"]), profile("initech", ["base"])],
};
/** An override already in place: acme's local rule/y over the root rule/y, reached by the shared root recipe. */
export const OVERRIDDEN: ForgeSpec = {
  ingredients: [rule("style", "# Style\n"), rule("y", "# Y shared\n")],
  recipes: [recipe("base", ["rule/style", "rule/y"])],
  profiles: [profile("acme", ["base"]), profile("globex", ["base"])],
};
export const OVERRIDE_FILES = localRule("acme", "y", "# Y for acme\n");

export interface Built {
  root: string;
  forge: string;
  ws: Record<string, string>;
}

/**
 * A Forge at `schema` (spec 56's gate by default) holding `extra` files, committed in git when `git` is set, and a synced
 * (so registered) workspace for each of `workspaces`, configured as given.
 */
export async function build(
  cleanups: string[],
  spec: ForgeSpec,
  opts: { schema?: number; extra?: Record<string, string>; git?: boolean; workspaces?: Array<{ name: string; config: Record<string, unknown>; sync?: boolean }> } = {},
): Promise<Built> {
  const root = await tmpDir("craftar-local-override-");
  cleanups.push(root);
  const forge = path.join(root, "forge");
  await makeForge(forge, spec);
  await fs.writeFile(path.join(forge, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: opts.schema ?? S }));
  if (opts.extra) await writeFiles(forge, opts.extra);
  if (opts.git !== false) {
    git(forge, "init", "-q", "-b", "main");
    git(forge, "add", "-A");
    git(forge, "commit", "-q", "-m", "forge");
  }
  const ws: Record<string, string> = {};
  for (const w of opts.workspaces ?? []) {
    const dir = path.join(root, w.name);
    await makeWorkspace(dir, forge, { config: w.config });
    if (w.sync !== false) {
      const r = runCli(["sync", "--workspace", dir]);
      if (r.code !== 0) throw new Error(`sync of ${w.name} failed: ${r.stderr}`);
    }
    ws[w.name] = dir;
  }
  return { root, forge, ws };
}

/** The plan of a fresh, unsynced workspace of `profile` over `forge`. */
export async function planFor(root: string, forge: string, profileName: string, config: Record<string, unknown> = {}): Promise<Plan> {
  const dir = await fs.mkdtemp(path.join(root, `plan-${profileName}-`));
  await makeWorkspace(dir, forge, { config: { profile: profileName, ...config } });
  return plan(await loadWorkspace(dir));
}

/** The planned text of one file. */
export function fileOf(p: Plan, rel: string): string {
  const f = p.files.find((x) => x.path === rel);
  if (!f) throw new Error(`no planned file ${rel}`);
  return Buffer.isBuffer(f.content) ? f.content.toString("utf8") : String(f.content);
}

/** Every planned file's bytes, by path. */
export function bytesOf(p: Plan): Record<string, string> {
  return Object.fromEntries(p.files.map((f) => [f.path, Buffer.isBuffer(f.content) ? f.content.toString("hex") : Buffer.from(String(f.content)).toString("hex")]));
}
