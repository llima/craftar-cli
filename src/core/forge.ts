import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ForgeManifestSchema,
  IngredientSchema,
  ProfileSchema,
  RecipeSchema,
  type ForgeManifest,
  type Ingredient,
  type IngredientRef,
  type Profile,
  type Recipe,
} from "../schema/index.js";

const execFileP = promisify(execFile);

export interface LoadedIngredient {
  ref: IngredientRef;
  dir: string;
  meta: Ingredient;
}

export interface Forge {
  root: string;
  manifest: ForgeManifest;
  ingredients: Map<IngredientRef, LoadedIngredient>;
  recipes: Map<string, Recipe>;
  profiles: Map<string, Profile>;
  /** HEAD commit when the Forge is a git checkout, else null. */
  commit: string | null;
}

export const FORGE_MANIFEST = "craftar.forge.yaml";

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readYaml<T>(file: string, schema: { parse: (v: unknown) => T }): Promise<T> {
  const text = await fs.readFile(file, "utf8");
  try {
    return schema.parse(YAML.parse(text) ?? {});
  } catch (e) {
    throw new Error(`invalid ${path.relative(process.cwd(), file)}: ${(e as Error).message}`);
  }
}

export async function loadForge(root: string): Promise<Forge> {
  root = path.resolve(root);
  const manifestPath = path.join(root, FORGE_MANIFEST);
  if (!(await exists(manifestPath))) throw new Error(`not a Forge: ${manifestPath} not found`);
  const manifest = await readYaml(manifestPath, ForgeManifestSchema);

  const ingredients = new Map<IngredientRef, LoadedIngredient>();
  const ingRoot = path.join(root, "ingredients");
  if (await exists(ingRoot)) {
    for (const typeDir of await fs.readdir(ingRoot, { withFileTypes: true })) {
      if (!typeDir.isDirectory()) continue;
      const typeName = typeDir.name; // plural folder: rules, agents, …
      for (const ingDir of await fs.readdir(path.join(ingRoot, typeName), { withFileTypes: true })) {
        if (!ingDir.isDirectory()) continue;
        const dir = path.join(ingRoot, typeName, ingDir.name);
        const metaFile = path.join(dir, "ingredient.yaml");
        if (!(await exists(metaFile))) continue;
        const meta = await readYaml(metaFile, IngredientSchema);
        const ref = `${meta.type}/${meta.name}` as IngredientRef;
        if (ingredients.has(ref)) throw new Error(`duplicate ingredient ${ref} (${dir})`);
        ingredients.set(ref, { ref, dir, meta });
      }
    }
  }

  const recipes = new Map<string, Recipe>();
  const recRoot = path.join(root, "recipes");
  if (await exists(recRoot)) {
    for (const f of await fs.readdir(recRoot)) {
      if (!/\.ya?ml$/.test(f)) continue;
      const r = await readYaml(path.join(recRoot, f), RecipeSchema);
      recipes.set(r.name, r);
    }
  }

  const profiles = new Map<string, Profile>();
  const profRoot = path.join(root, "profiles");
  if (await exists(profRoot)) {
    for (const d of await fs.readdir(profRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const f = path.join(profRoot, d.name, "profile.yaml");
      if (!(await exists(f))) continue;
      const p = await readYaml(f, ProfileSchema);
      profiles.set(p.name, p);
    }
  }

  return { root, manifest, ingredients, recipes, profiles, commit: await gitHead(root) };
}

async function gitHead(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "rev-parse", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Whether `dir` sits inside a git working tree at all — true even for a freshly `git init`-ed
 * repository with no commits yet, unlike `gitHead`/`Forge.commit`, which is `null` in both that
 * case and the no-`.git`-at-all case. A caller that needs to tell the two apart (a refusal whose
 * wording depends on which is true) calls this in addition to checking `commit === null`.
 */
export async function gitIsRepo(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * True when the Forge has uncommitted changes — and also when `git status` cannot be run at all.
 * By the time this is called the directory is known to be a git repository (`forge.commit !== null`
 * is checked first), so a failure here is anomalous, and an anomaly is not evidence of a clean
 * tree. Failing closed costs a confusing refusal; failing open costs a deletion from a Forge with
 * no lock.
 */
export async function gitDirty(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "status", "--porcelain"]);
    return stdout.trim().length > 0;
  } catch {
    return true;
  }
}

export interface UnheldPath {
  /** Repo-relative path as git reports it (or the path asked about, when git itself failed). */
  path: string;
  reason: "ignored" | "untracked" | "modified" | "git failed";
}

/**
 * Ruling 37: the entries under `paths` (absolute, all inside the Forge `root`) that git does not
 * fully hold — ignored, untracked or modified — where an overwrite or a deletion could not be
 * undone. `gitDirty` alone is not enough: plain `git status --porcelain` omits ignored files and
 * obeys `status.showUntrackedFiles=no`, so a Forge ignored by its enclosing repo, or an ignored
 * file inside a variant, passes it. `--ignored --untracked-files=all` surfaces both. Fails closed
 * like `gitDirty`: when git cannot answer, every path counts as not held.
 */
export async function gitUnheld(root: string, paths: string[]): Promise<UnheldPath[]> {
  if (paths.length === 0) return [];
  const rel = paths.map((p) => path.relative(root, p).split(path.sep).join("/") || ".");
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", root, "status", "--porcelain", "-z", "--ignored", "--untracked-files=all", "--", ...rel],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const out: UnheldPath[] = [];
    const entries = stdout.split("\0");
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.length < 4) continue;
      const xy = e.slice(0, 2);
      out.push({ path: e.slice(3), reason: xy === "!!" ? "ignored" : xy === "??" ? "untracked" : "modified" });
      // A rename or copy carries its original path as the next NUL-separated field.
      if (xy[0] === "R" || xy[0] === "C") i++;
    }
    return out;
  } catch {
    return rel.map((p) => ({ path: p, reason: "git failed" as const }));
  }
}

/** Plural folder name for an ingredient type (rules/, agents/, …). */
export function typeFolder(type: Ingredient["type"]): string {
  return type === "mcp" ? "mcp" : `${type}s`;
}

export async function readIngredientText(ing: LoadedIngredient, file: string): Promise<string> {
  return fs.readFile(path.join(ing.dir, file), "utf8");
}

/** Recursively list files under a directory, relative to it, sorted. */
export async function listFiles(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, r)));
    else out.push(r);
  }
  return out.sort();
}
