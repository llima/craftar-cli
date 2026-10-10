import path from "node:path";
import YAML from "yaml";
import { TARGETS, type Lock, type WorkspaceConfig } from "../schema/index.js";
import { planRecipeEdit } from "./recipe-edit.js";
import { classifyForge, credentialFault } from "./remote.js";
import {
  LOCAL_FILE,
  loadWorkspaceConfig,
  mergeWorkspaceConfig,
  plan,
  readLock,
  status,
  workspaceOf,
  type FileStatus,
  type LoadedForge,
  type LoadOptions,
  type Plan,
  type Workspace,
} from "./sync.js";
import { readLocalFile, type LocalKey } from "./workspace-yaml.js";

/**
 * `craftar init` (spec 23): steps 2–7 of §4.2 — the flag checks, the local-file check, the configuration
 * in memory, the Forge load, the recipe flags, the plan. Never writes, never prints: the command writes
 * `craftar.yaml` only after this returns, so every refusal leaves the directory as it was.
 */

export interface InitInput {
  /** `--forge`: a URL, or a directory (relative to the current directory). */
  forge: string;
  profile: string;
  ref?: string;
  targets?: string[];
  addRecipes?: string[];
  removeRecipes?: string[];
  replace?: boolean;
  /** A Forge already loaded: `planInit` reuses it instead of loading again (spec 28 §5.2).
   * A path Forge is loaded with the ref the workspace will have (`loadForgeSource(root, source, ref)`),
   * so its ignored-ref warning travels in `loaded.warnings`. */
  loaded?: LoadedForge;
}

export interface InitPlan {
  ws: Workspace;
  plan: Plan;
  lock: Lock | null;
  statuses: FileStatus[];
  /** The `craftar.yaml` to write: only the keys init sets, in the order forge, ref, profile, recipes, targets. */
  text: string;
  /** One line per recipe call whose every name changed nothing: spec 22's reasons, joined. */
  notes: string[];
  /** Where the targets come from, for the first line of the output (§4.4). */
  targetsFrom: "flag" | "local" | "profile";
}

/** The flag each local key would replace (N10). */
const FLAG: Record<LocalKey, string> = {
  forge: "--forge",
  ref: "--ref",
  profile: "--profile",
  recipes: "--add-recipe / --remove-recipe",
  targets: "--targets",
};

/**
 * The expression `planInit` uses to turn `--forge` into `craftar.yaml › forge`:
 * a URL as given; a directory as the POSIX path from `root`, `"."` when equal.
 */
export function forgeSource(root: string, forge: string): string {
  if (classifyForge(forge) === "url") return forge;
  return path.relative(root, path.resolve(forge)).replace(/\\/g, "/") || ".";
}

/**
 * N3, N7, N11, N6 with today's messages and today's order.
 * Each checked only when its flag is there: N3 and N11 need `forge` (N11 = `ref` given and `forge` given and not a URL).
 */
export function checkInitFlags(given: {
  forge?: string;
  ref?: string;
  targets?: string[];
  addRecipes?: string[];
  removeRecipes?: string[];
}): void {
  // N3: credentials in forge (only when forge is given)
  if (given.forge !== undefined && credentialFault(given.forge))
    throw new Error("--forge holds credentials in the URL — remove them and let git authenticate (credential helper, SSH agent; see README › Remote Forge)");

  // N7: unknown target
  for (const t of given.targets ?? [])
    if (!(TARGETS as readonly string[]).includes(t)) throw new Error(`unknown target "${t}" (${TARGETS.join(", ")})`);

  // N11: ref with path Forge (only when both forge and ref are given)
  if (given.forge !== undefined && given.ref !== undefined && classifyForge(given.forge) !== "url")
    throw new Error("--ref goes with a remote Forge — a path Forge is read as its working tree");

  // N6: recipe both added and removed
  const adds = given.addRecipes ?? [];
  const removes = given.removeRecipes ?? [];
  const both = adds.find((n) => removes.includes(n));
  if (both !== undefined) throw new Error(`recipe "${both}" is both added and removed`);
}

/**
 * N10 with today's message; `forge` and `profile` always count as given.
 */
export function checkLocalKeys(
  local: LocalKey[],
  given: { ref: boolean; recipes: boolean; targets: boolean },
): void {
  // forge and profile always count as given
  const flagGiven: Record<LocalKey, boolean> = {
    forge: true,
    ref: given.ref,
    profile: true,
    recipes: given.recipes,
    targets: given.targets,
  };
  const clash = local.find((k) => flagGiven[k]);
  if (clash) throw new Error(`${LOCAL_FILE} sets ${clash}, which would replace ${FLAG[clash]} — move it aside and re-run init`);
}

/**
 * The line `src/cli.ts` builds inline today:
 * `forge <forge> · profile <profile> · recipes <a → b> · targets <t, u><from>`
 * with `<from>` one of `""`, ` (from craftar.local.yaml)`, ` (from the profile)`.
 * No leading spaces in the returned string; `src/cli.ts` prints `"  " + initLine(init)`.
 */
export function initLine(init: InitPlan): string {
  const { ws, plan: p, targetsFrom } = init;
  const from = { flag: "", local: " (from craftar.local.yaml)", profile: " (from the profile)" }[targetsFrom];
  return `forge ${ws.config.forge} · profile ${ws.config.profile} · recipes ${p.resolution.recipes.join(" → ")} · targets ${p.resolution.targets.join(", ")}${from}`;
}

export interface InitOptions extends LoadOptions {
  /** The local file already read: used instead of calling `readLocalFile` (spec 28 §5.2). */
  local?: { doc: unknown | null; keys: LocalKey[] };
}

export async function planInit(root: string, input: InitInput, opts: InitOptions = {}): Promise<InitPlan> {
  root = path.resolve(root);
  const adds = input.addRecipes ?? [];
  const removes = input.removeRecipes ?? [];
  const recipeFlags = adds.length > 0 || removes.length > 0;

  // Flag checks (N3, N7, N11, N6)
  checkInitFlags({
    forge: input.forge,
    ref: input.ref,
    targets: input.targets,
    addRecipes: input.addRecipes,
    removeRecipes: input.removeRecipes,
  });

  // N10: a local key the merge would let win over a flag init writes.
  const { doc: localDoc, keys: local } = opts.local ?? (await readLocalFile(root));
  checkLocalKeys(local, {
    ref: input.ref !== undefined,
    recipes: recipeFlags,
    targets: input.targets !== undefined,
  });

  const forge = forgeSource(root, input.forge);
  const base: Record<string, unknown> = { forge };
  if (input.ref !== undefined) base.ref = input.ref;
  base.profile = input.profile;
  if (input.targets !== undefined) base.targets = input.targets;

  let loaded: Workspace;
  if (input.loaded) {
    // Build the Workspace from the provided Forge (spec 28 §5.2)
    const merged = mergeWorkspaceConfig(base, localDoc);

    // Refuse a `loaded` that is not the configuration's Forge — a programming error
    // Check after merge so credentials are refused first by mergeWorkspaceConfig
    if (input.loaded.origin.source !== merged.config.forge) {
      // Neither value is printed when credentialFault flags it — but merge refuses first
      throw new Error(`planInit: the loaded Forge is "${input.loaded.origin.source}", not "${merged.config.forge}"`);
    }
    // Remote only: ref must match
    if (input.loaded.origin.kind === "remote") {
      const expectedRef = merged.config.ref ?? null;
      if (input.loaded.origin.ref !== expectedRef) {
        throw new Error(`planInit: the loaded Forge is at ref ${JSON.stringify(input.loaded.origin.ref)}, not ${JSON.stringify(expectedRef)}`);
      }
    }

    loaded = workspaceOf(root, merged, input.loaded);
  } else {
    loaded = await loadWorkspaceConfig(root, base, localDoc, { ...opts, mode: "sync" });
  }

  // Removes first, then adds, each one spec 22 call (§13 item 3).
  let config: WorkspaceConfig = loaded.config;
  const notes: string[] = [];
  for (const [op, names] of [["remove", removes], ["add", adds]] as const) {
    if (!names.length) continue;
    const edit = planRecipeEdit(loaded.forge, config, op, names, { replace: input.replace === true });
    config = { ...config, recipes: edit.recipes };
    if (edit.reasons.length) notes.push(edit.reasons.join(", "));
  }
  const ws: Workspace = { ...loaded, config };
  const p = await plan(ws);
  const lock = await readLock(root);
  const statuses = await status(ws, p, lock);

  const doc: Record<string, unknown> = { forge };
  if (input.ref !== undefined) doc.ref = input.ref;
  doc.profile = input.profile;
  if (recipeFlags) {
    const recipes: Record<string, string[]> = {};
    if (config.recipes.add.length) recipes.add = config.recipes.add;
    if (config.recipes.remove.length) recipes.remove = config.recipes.remove;
    if (Object.keys(recipes).length) doc.recipes = recipes;
  }
  if (input.targets !== undefined) doc.targets = input.targets;

  const targetsFrom = input.targets !== undefined ? "flag" : local.includes("targets") ? "local" : "profile";
  return { ws, plan: p, lock, statuses, text: YAML.stringify(doc), notes, targetsFrom };
}
