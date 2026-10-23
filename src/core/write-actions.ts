/**
 * Spec 40 Part A — the writing half of `sync`, `init`, `drift discard`, `add recipe` and `remove recipe`,
 * shared by the CLI and `craftar mcp --allow-writes`. Loads nothing, prints nothing, writes only through
 * `apply()`, `register()` and the one in-place write of `craftar.yaml`.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { register, registryFile } from "./registry.js";
import { forgeLine } from "./report.js";
import { editRecipesText, planRecipeEdit, type RecipeLists, type RecipeOp } from "./recipe-edit.js";
import {
  apply,
  plan,
  readLock,
  status,
  unsetDeclared,
  WORKSPACE_FILE,
  LOCAL_FILE,
  type ApplyOptions,
  type ApplyResult,
  type FileStatus,
  type Plan,
  type UnsetParam,
  type Workspace,
} from "./sync.js";
import { hashNormalized } from "./text.js";
import { localKeys } from "./workspace-yaml.js";
import type { Lock } from "../schema/index.js";

/* ------------------------------------------------------------------ */
/* syncWorkspace                                                       */
/* ------------------------------------------------------------------ */

export interface SyncOutcome {
  result: ApplyResult;
  /** A registry that could not be written: its file and the error's message (the CLI prints them; MCP does not). */
  registry: { file: string; message: string } | null;
  /** The header line naming a remote Forge; null for a path Forge. */
  forgeLine: string | null;
}

export async function syncWorkspace(
  ws: Workspace,
  p: Plan,
  statuses: FileStatus[],
  lock: Lock | null,
  opts: ApplyOptions & { home: string; registryOff: boolean },
): Promise<SyncOutcome> {
  const r = await apply(ws, p, statuses, opts);
  let registry: SyncOutcome["registry"] = null;
  if (!opts.dryRun && !opts.registryOff) {
    try {
      await register(opts.home, ws, p);
    } catch (e) {
      registry = {
        file: registryFile(opts.home),
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }
  return { result: r, registry, forgeLine: forgeLine(ws, lock) };
}

/* ------------------------------------------------------------------ */
/* editRecipes                                                         */
/* ------------------------------------------------------------------ */

export interface RecipeOutcome {
  changed: boolean;
  /** planRecipeEdit's reasons (non-empty only when nothing changed). */
  reasons: string[];
  before: RecipeLists;
  after: RecipeLists;
  /** When changed: the edited workspace's resolved recipes, its statuses and unset params, and the plan warnings past ws.warnings. */
  next: { recipes: string[]; statuses: FileStatus[]; unset: UnsetParam[]; warnings: string[] } | null;
}

export async function editRecipes(
  ws: Workspace,
  op: RecipeOp,
  names: string[],
  opts: { replace?: boolean } = {},
): Promise<RecipeOutcome> {
  // R1: arrays replace across layers, so an edit of craftar.yaml would not take effect (spec 22 Ruling 1).
  if ((await localKeys(ws.root)).includes("recipes")) {
    throw new Error(
      `${LOCAL_FILE} sets recipes, which replaces ${WORKSPACE_FILE}'s lists — edit it by hand, or remove its recipes key and re-run`,
    );
  }

  const edit = planRecipeEdit(ws.forge, ws.config, op, names, { replace: opts.replace === true });

  if (!edit.changed) {
    return {
      changed: false,
      reasons: edit.reasons,
      before: ws.config.recipes,
      after: edit.recipes,
      next: null,
    };
  }

  const file = path.join(ws.root, WORKSPACE_FILE);
  const content = editRecipesText(await fs.readFile(file, "utf8"), edit.recipes, `${op} recipe`);

  // The report is computed before the write, so a plan that fails leaves craftar.yaml untouched (§5.2 step 4).
  const next: Workspace = { ...ws, config: { ...ws.config, recipes: edit.recipes } };
  const p = await plan(next);
  const st = await status(next, p, await readLock(ws.root));
  const unset = unsetDeclared(p);
  await fs.writeFile(file, content);

  return {
    changed: true,
    reasons: edit.reasons,
    before: ws.config.recipes,
    after: edit.recipes,
    next: {
      recipes: [...p.resolution.recipes],
      statuses: st,
      unset,
      warnings: p.warnings.slice(ws.warnings.length),
    },
  };
}

/* ------------------------------------------------------------------ */
/* statusDigest                                                        */
/* ------------------------------------------------------------------ */

/**
 * sha256 (64 hex) over what a status showed: each row's path, state, planned bytes and disk bytes
 * (spec 40 §3, §4.1, §16 item 17).
 */
export async function statusDigest(ws: Workspace, statuses: FileStatus[]): Promise<string> {
  const rows: string[] = [];

  // Sort by path (plain < comparison)
  const sorted = [...statuses].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const s of sorted) {
    const planned = s.planned ? hashNormalized(s.planned.content) : "-";
    let disk: string;
    try {
      disk = hashNormalized(await fs.readFile(path.join(ws.root, s.path)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        disk = "-";
      } else {
        throw e;
      }
    }
    rows.push(`${s.path}\0${s.state}\0${planned}\0${disk}`);
  }

  const joined = rows.join("\n");
  return createHash("sha256").update(joined, "utf8").digest("hex");
}
