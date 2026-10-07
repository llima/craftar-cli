import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { TARGETS, type Lock, type WorkspaceConfig } from "../schema/index.js";
import { planRecipeEdit } from "./recipe-edit.js";
import { classifyForge, credentialFault } from "./remote.js";
import { LOCAL_FILE, loadWorkspaceConfig, plan, readLock, status, type FileStatus, type LoadOptions, type Plan, type Workspace } from "./sync.js";
import { localKeys, parseWorkspaceYaml, type LocalKey } from "./workspace-yaml.js";

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

export async function planInit(root: string, input: InitInput, opts: LoadOptions = {}): Promise<InitPlan> {
  root = path.resolve(root);
  const adds = input.addRecipes ?? [];
  const removes = input.removeRecipes ?? [];
  const recipeFlags = adds.length > 0 || removes.length > 0;

  // N3 first: nothing below may print the value.
  if (credentialFault(input.forge))
    throw new Error("--forge holds credentials in the URL — remove them and let git authenticate (credential helper, SSH agent; see README › Remote Forge)");
  for (const t of input.targets ?? [])
    if (!(TARGETS as readonly string[]).includes(t)) throw new Error(`unknown target "${t}" (${TARGETS.join(", ")})`);
  const remote = classifyForge(input.forge) === "url";
  if (input.ref !== undefined && !remote) throw new Error("--ref goes with a remote Forge — a path Forge is read as its working tree");
  const both = adds.find((n) => removes.includes(n));
  if (both !== undefined) throw new Error(`recipe "${both}" is both added and removed`);

  // N10: a local key the merge would let win over a flag init writes.
  const local = await localKeys(root);
  const given: Record<LocalKey, boolean> = {
    forge: true,
    ref: input.ref !== undefined,
    profile: true,
    recipes: recipeFlags,
    targets: input.targets !== undefined,
  };
  const clash = local.find((k) => given[k]);
  if (clash) throw new Error(`${LOCAL_FILE} sets ${clash}, which would replace ${FLAG[clash]} — move it aside and re-run init`);

  const forge = remote ? input.forge : path.relative(root, path.resolve(input.forge)).replace(/\\/g, "/") || ".";
  const base: Record<string, unknown> = { forge };
  if (input.ref !== undefined) base.ref = input.ref;
  base.profile = input.profile;
  if (input.targets !== undefined) base.targets = input.targets;

  const localFile = path.join(root, LOCAL_FILE);
  const localText = await fs.readFile(localFile, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  const localDoc = localText === null ? null : (parseWorkspaceYaml(LOCAL_FILE, localText) ?? {});
  const loaded = await loadWorkspaceConfig(root, base, localDoc, { ...opts, mode: "sync" });

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
