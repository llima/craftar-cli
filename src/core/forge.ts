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

/** True when the Forge is a git checkout with uncommitted changes. False when it is not a repo. */
export async function gitDirty(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "status", "--porcelain"]);
    return stdout.trim().length > 0;
  } catch {
    return false;
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
