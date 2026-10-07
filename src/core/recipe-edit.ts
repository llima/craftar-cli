import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import type { Forge } from "./forge.js";
import { WorkspaceConfigSchema, type WorkspaceConfig } from "../schema/index.js";
import { recipeOrder, resolve } from "./resolve.js";
import { editYamlText } from "./yaml-edit.js";
import { parseWorkspaceYaml } from "./workspace-yaml.js";

/**
 * `craftar add recipe` / `craftar remove recipe` (spec 22): the edit of `craftar.yaml`'s
 * `recipes.add` / `recipes.remove`, planned and written as text. Pure: no disk, no console.
 */

export type RecipeOp = "add" | "remove";

export interface RecipeLists {
  add: string[];
  remove: string[];
}

export interface RecipeEdit {
  /** The lists to write; the original ones when nothing changed. */
  recipes: RecipeLists;
  /** False when the final lists hold what the original ones held (§3.3). */
  changed: boolean;
  /** One reason per name, in the order given — only when every name was a no-op on its own. */
  reasons: string[];
}

/**
 * Applies §3.1–§3.2 to each name in order, on one copy of the lists, then checks the whole result
 * through `resolve()` (§3.3). Throws R2–R4, R7, and R5 for a resolve failure.
 */
export function planRecipeEdit(
  forge: Forge,
  config: WorkspaceConfig,
  op: RecipeOp,
  names: string[],
  opts: { replace?: boolean } = {},
): RecipeEdit {
  const profile = forge.profiles.get(config.profile);
  if (!profile) throw new Error(`profile "${config.profile}" not found in Forge (${[...forge.profiles.keys()].join(", ") || "none"})`);
  const original: RecipeLists = { add: [...config.recipes.add], remove: [...config.recipes.remove] };
  const lists: RecipeLists = { add: [...original.add], remove: [...original.remove] };

  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`recipe "${name}" is named twice`);
    seen.add(name);
  }
  const known = (name: string) => forge.recipes.has(name);
  const notFound = (name: string) =>
    new Error(`recipe "${name}" not found in this Forge (${[...forge.recipes.keys()].sort().join(", ") || "none"})`);
  for (const name of names) {
    // A remove may clean an unknown name out of a list (§14 item 9); anything else must exist.
    const cleanup = op === "remove" && (lists.add.includes(name) || lists.remove.includes(name));
    if (!known(name) && !cleanup) throw notFound(name);
  }

  const top = () => [...profile.recipes, ...lists.add].filter((r) => !lists.remove.includes(r) && known(r));
  // The "resolved" walk: through `extends`, without the slot check, over the names the Forge holds (§3.1).
  const order = () => recipeOrder(forge, top(), `profile ${profile.name}`);
  const without = (list: string[], name: string) => {
    const i = list.indexOf(name);
    if (i >= 0) list.splice(i, 1);
    return i >= 0;
  };

  const removeOne = (name: string): boolean => {
    // An unknown name is only cleaned out of the list that holds it (§14 item 9).
    if (!known(name)) return [without(lists.add, name), without(lists.remove, name)].some(Boolean);
    let touched = without(lists.add, name);
    if (profile.recipes.includes(name) && !lists.remove.includes(name)) {
      lists.remove.push(name);
      touched = true;
    }
    const now = order();
    if (now.includes(name)) {
      // R4: the first top-level recipe, in recipe order, whose `extends` chain reaches the name.
      const by = top()
        .sort((a, b) => now.indexOf(a) - now.indexOf(b))
        .find((r) => r !== name && recipeOrder(forge, [r], r).includes(name));
      throw new Error(`recipe "${name}" comes in through "${by}" (extends) — remove "${by}", or change the Forge`);
    }
    return touched;
  };

  const addOne = (name: string): boolean => {
    let touched = without(lists.remove, name);
    if (!order().includes(name)) {
      lists.add.push(name);
      touched = true;
    }
    // The slot check runs for every name, also one that changed nothing (§3.2).
    const slot = forge.recipes.get(name)!.slot;
    if (slot) {
      const holders = order().filter((r) => r !== name && forge.recipes.get(r)!.slot === slot);
      if (holders.length && !opts.replace)
        throw new Error(`recipe "${name}" occupies slot "${slot}", held by "${holders[0]}" — pass --replace to swap them`);
      for (const holder of holders) if (removeOne(holder)) touched = true;
    }
    return touched;
  };

  const noops: string[] = [];
  for (const name of names) {
    const touched = op === "add" ? addOne(name) : removeOne(name);
    if (!touched) noops.push(op === "add" ? `${name} is already in use` : `${name} is not in use`);
  }

  const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
  const changed = !(same(lists.add, original.add) && same(lists.remove, original.remove));
  const recipes = changed ? lists : original;
  // R5: the whole result resolves — an unchanged configuration too (§3.3).
  resolve(forge, { ...config, recipes });
  return { recipes, changed, reasons: !changed && noops.length === names.length ? noops : [] };
}

/** Line 1 of the output, after `craftar.yaml: ` (§3.3). Empty when no list changed. */
export function recipeDiffLine(before: RecipeLists, after: RecipeLists): string {
  const part = (key: keyof RecipeLists) => {
    const added = after[key].filter((n) => !before[key].includes(n)).map((n) => `+ ${n}`);
    const deleted = before[key].filter((n) => !after[key].includes(n)).map((n) => `- ${n}`);
    const entries = [...added, ...deleted];
    return entries.length ? `recipes.${key} ${entries.join(", ")}` : null;
  };
  return [part("add"), part("remove")].filter((p) => p !== null).join("; ");
}

/**
 * The text edit of `craftar.yaml` (§5.1–§5.2): through `editYamlText`, editing the items of an
 * existing sequence in place so its style and comments stay, then read back as the original with
 * exactly `recipes.add` / `recipes.remove` replaced, and loaded through `WorkspaceConfigSchema`.
 */
export function editRecipesText(raw: string, after: RecipeLists, command: string): string {
  const refuse = (why: string) => new Error(`${command}: cannot edit craftar.yaml in place (${why}) — reformat it by hand and re-run`);
  const before = (parseWorkspaceYaml("craftar.yaml", raw) ?? {}) as Record<string, unknown>;
  const beforeRecipes = (before.recipes ?? {}) as Record<string, unknown>;
  let content: string;
  try {
    content = editYamlText(raw, { command, label: "craftar.yaml", keys: ["recipes"] }, (doc) => {
      const node = doc.get("recipes", true);
      if (!YAML.isMap(node)) {
        const fresh: Record<string, string[]> = {};
        for (const key of ["add", "remove"] as const) if (after[key].length) fresh[key] = after[key];
        doc.set("recipes", doc.createNode(fresh));
        return;
      }
      for (const key of ["add", "remove"] as const) {
        const seq = node.get(key, true);
        if (YAML.isSeq(seq)) {
          const kept = new Map<string, unknown>();
          for (const item of seq.items) if (YAML.isScalar(item)) kept.set(String(item.value), item);
          // Keep each surviving item's own node (and comment); append the new ones.
          seq.items = after[key].map((n) => kept.get(n) ?? doc.createNode(n));
        } else if (after[key].length) {
          node.set(key, doc.createNode(after[key]));
        }
      }
    });
  } catch (e) {
    throw refuse((e as Error).message.replace(/^.*in place \((.*)\) — .*$/s, "$1"));
  }
  const expected: Record<string, unknown> = { ...beforeRecipes };
  for (const key of ["add", "remove"] as const) if (key in beforeRecipes || after[key].length) expected[key] = after[key];
  const read = parseWorkspaceYaml("craftar.yaml", content) as Record<string, unknown>;
  if (!isDeepStrictEqual(read, { ...before, recipes: expected })) throw refuse("the edit does not read back as exactly recipes.add and recipes.remove set");
  const loaded = WorkspaceConfigSchema.safeParse(read);
  if (!loaded.success) throw refuse(`it no longer loads: ${loaded.error.message}`);
  return content;
}
