import { promises as fs } from "node:fs";
import { concreteProfiles } from "./profile-extends.js";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { IngredientSchema, RecipeSchema, WorkspaceConfigSchema, type Ingredient } from "../schema/index.js";
import { exists, listFiles, parseYaml, type Forge } from "./forge.js";
import { resolve, type Resolution } from "./resolve.js";
import { note, type WriteJournal } from "./unify.js";
import { editYamlText } from "./yaml-edit.js";

// The pieces the Forge writers that move or rename an ingredient share: `forge promote` (spec 29 §4.4) and
// `forge localize` / `forge share` (spec 51 §5). Each takes the command's name for its messages.

/** Every profile's resolution with no workspace layer — the part decidable in the Forge; a profile that does not resolve maps to its error. */
export function resolveAll(forge: Forge): Map<string, Resolution | Error> {
  const out = new Map<string, Resolution | Error>();
  // Spec 54 §5.7 (D14): over the concrete profiles — an abstract one is proved through the children that extend it.
  for (const q of concreteProfiles(forge).sort()) {
    try {
      out.set(q, resolve(forge, WorkspaceConfigSchema.parse({ forge: ".", profile: q })));
    } catch (e) {
      out.set(q, e instanceof Error ? e : new Error(String(e)));
    }
  }
  return out;
}

/** The recipe files under `<root>/<dir>` (the root's `recipes`, by default) by declared name, as `loadForge` keys them (last file wins). */
export async function recipeFiles(root: string, dir = "recipes"): Promise<Map<string, { abs: string; stem: string; raw: string }>> {
  const at = path.join(root, dir);
  const out = new Map<string, { abs: string; stem: string; raw: string }>();
  if (!(await exists(at))) return out;
  for (const f of await fs.readdir(at)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const abs = path.join(at, f);
    const raw = await fs.readFile(abs, "utf8");
    out.set(parseYaml(abs, raw, RecipeSchema).name, { abs, stem: f.replace(/\.ya?ml$/, ""), raw });
  }
  return out;
}

/**
 * Whether something stands where a new directory would go: anything but nothing, or a directory holding no file.
 * Throws on lstat errors other than ENOENT (fail-closed), with a message naming `label` (forge-relative POSIX path).
 */
export async function occupied(dir: string, label: string, command: string): Promise<boolean> {
  let stat;
  try {
    stat = await fs.lstat(dir);
  } catch (e) {
    // Only ENOENT means "not occupied"; other errors (EACCES, EIO, etc.) fail closed.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    const code = (e as NodeJS.ErrnoException).code ?? "unknown";
    throw new Error(`${command}: cannot read ${label} (${code})`);
  }
  if (!stat.isDirectory()) return true;
  try {
    return (await listFiles(dir)).length > 0;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "unknown";
    throw new Error(`${command}: cannot read ${label} (${code})`);
  }
}

/** Replace the plain scalar entries equal to `old` in the sequence under `key`; says how many it replaced. */
export function swapEntry(doc: YAML.Document, key: string, old: string, value: string): number {
  const seq = doc.get(key, true);
  if (!YAML.isSeq(seq)) return 0;
  let n = 0;
  for (const item of seq.items) {
    if (YAML.isScalar(item) && item.value === old) {
      item.value = value;
      n++;
    }
  }
  return n;
}

export const unreadable = (label: string, what: string, command: string) =>
  new Error(`${command}: cannot edit ${label} in place (the edit does not read back as exactly ${what}) — reformat it by hand, commit, and re-run`);

/** An `ingredient.yaml` with `name` set and `as` set or removed, in place; read back through the schema. */
export function ingredientText(raw: string, label: string, meta: Ingredient, name: string, as: string | null, command: string): string {
  const text = editYamlText(raw, { command, label, keys: ["name", "as"] }, (doc) => {
    doc.set("name", name);
    if (as === null) doc.delete("as");
    else doc.set("as", as);
  });
  const { as: _dropped, ...rest } = meta as Ingredient & { as?: string };
  const expected = as === null ? { ...rest, name } : { ...rest, name, as };
  if (!isDeepStrictEqual(parseYaml(label, text, IngredientSchema), IngredientSchema.parse(expected))) {
    throw unreadable(label, as === null ? "name set and as removed" : "name and as set", command);
  }
  return text;
}

/** One file a Forge edit writes; `created` when nothing is there today. */
export interface ForgeWrite {
  abs: string;
  content: string | Buffer;
  created: boolean;
}

/**
 * Put an edit's files under `root` (the Forge `from`, or its scratch copy), deleting what it removes and the
 * directories that leaves empty — deepest first, never at or above the second level of the tree.
 */
export async function writeEdits(from: string, root: string, edit: { writes: ForgeWrite[]; removes: string[] }, journal?: WriteJournal): Promise<void> {
  const at = (abs: string) => path.join(root, path.relative(from, abs));
  for (const w of edit.writes) {
    const abs = at(w.abs);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await note(journal, abs);
    await fs.writeFile(abs, w.content);
  }
  for (const r of edit.removes) {
    const abs = at(r);
    journal?.push({ abs, created: false });
    await fs.rm(abs);
  }
  const dirs = [...new Set(edit.removes.map((r) => path.dirname(at(r))))].sort((a, b) => b.length - a.length);
  for (let dir of dirs) {
    while (path.relative(root, dir).split(path.sep).length > 2 && (await exists(dir)) && (await fs.readdir(dir)).length === 0) {
      await fs.rmdir(dir);
      dir = path.dirname(dir);
    }
  }
}
