/**
 * Spec 40 Part A — the writing half of `sync`, `init`, `drift discard`, `add recipe` and `remove recipe`,
 * shared by the CLI and `craftar mcp --allow-writes`. `syncWorkspace` and `editRecipes` load nothing,
 * print nothing, write only through `apply()`, `register()` and the one in-place write of `craftar.yaml`.
 * `mcpWriters` loads the workspace's Forge for a writing tool call.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { InitIo } from "./init-flow.js";
import { yesNo } from "./init-flow.js";
import { consentFor, readRegistry, register, registryFile } from "./registry.js";
import { classifyForge } from "./remote.js";
import { cachedCopyLine, explainSkip, forgeLine, nextSyncLine } from "./report.js";
import { editRecipesText, planRecipeEdit, recipeDiffLine, type RecipeLists, type RecipeOp } from "./recipe-edit.js";
import {
  apply,
  loadForgeFor,
  plan,
  readLock,
  status,
  unsetDeclared,
  unsetRefusal,
  orphanReason,
  WORKSPACE_FILE,
  LOCAL_FILE,
  type ApplyOptions,
  type ApplyResult,
  type FileStatus,
  type LoadOptions,
  type MergedConfig,
  type Plan,
  type UnsetParam,
  type Workspace,
} from "./sync.js";
import { hashNormalized } from "./text.js";
import { localKeys } from "./workspace-yaml.js";
import type { Lock } from "../schema/index.js";
import type { Pin } from "./mcp-protocol.js";

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

/* ------------------------------------------------------------------ */
/* confirmWrites                                                       */
/* ------------------------------------------------------------------ */

/**
 * The question of `craftar mcp allow-writes` (spec 40 §5.2 step 4): `[no]` — Enter, n, no and an input that ended are no,
 * y and yes are yes (yesNo, the init flow's parser), anything else is asked again.
 */
export async function confirmWrites(io: Pick<InitIo, "confirm" | "say">): Promise<boolean> {
  for (;;) {
    const answer = await io.confirm("Let craftar mcp --allow-writes write here [no]: ");
    if (answer === null || answer.trim() === "") return false;
    const yn = yesNo(answer);
    if (yn !== null) return yn;
    io.say("answer yes or no");
  }
}


/* ------------------------------------------------------------------ */
/* McpWriters (spec 40 Part B §5.3–§5.6)                               */
/* ------------------------------------------------------------------ */

/**
 * The `sync` tool result (spec 40 §5.6).
 */
export interface SyncToolResult {
  profile: string;
  recipes: string[];
  targets: string[];
  forge: string | null;
  written: string[];
  removed: Array<{ path: string; reason: string }>;
  skipped: Array<{ path: string; state: string; reason: string }>;
  warnings: string[];
  registry: "updated" | "not updated" | "off";
}

/** The `sync` result (spec 40 §5.6) — one builder, shared by `craftar mcp`'s `sync` tool and `craftar ui`'s write routes. */
export function syncToolResult(
  ws: Workspace,
  p: Plan,
  statuses: readonly FileStatus[],
  outcome: SyncOutcome,
  registryOff: boolean,
  discarded?: string,
): SyncToolResult {
  return {
    profile: ws.config.profile,
    recipes: [...p.resolution.recipes],
    targets: [...p.resolution.targets],
    forge: outcome.forgeLine,
    written: outcome.result.written,
    removed: outcome.result.removed.map((path) => ({
      path,
      reason: path === discarded ? "hand-edited orphan: discarded" : orphanReason(p, statuses, path),
    })),
    skipped: outcome.result.skipped.map((s) => ({ path: s.path, state: s.state, reason: explainSkip(s) })),
    warnings: p.warnings,
    registry: registryOff ? "off" : outcome.registry ? "not updated" : "updated",
  };
}

/**
 * The `add_recipe` / `remove_recipe` tool result (spec 40 §5.6).
 */
export interface RecipeToolResult {
  changed: boolean;
  reasons: string[];
  craftarYaml: string | null;
  recipes: string[] | null;
  nextSync: string | null;
  warnings: string[];
}

/** Consent result codes: "ok" when consent is valid, or a code for callWrite to map to a message. */
export type ConsentCode = "ok" | "registry-off" | "unreadable" | "none" | { stale: Array<"forge" | "ref" | "profile"> };

/**
 * The writers the MCP server uses under `--allow-writes` (spec 40 §5.3).
 * Each method receives what `mcp-protocol.ts` can pass without value imports.
 */
export interface McpWriters {
  /** Check consent for a writing tool call (spec 40 §5.5 step 2). Returns a code for callWrite to map to a message. */
  consent(root: string, pin: Pin): Promise<ConsentCode>;

  /** Whether the Forge is remote (a git URL) rather than a path. */
  isRemote(forge: string): boolean;

  /** The `sync` tool (spec 40 §5.5): load, plan, run syncWorkspace. Refuses unset declared params. Never overwrites drift. */
  sync(
    root: string,
    merged: MergedConfig,
    opts: { git?: LoadOptions["git"] },
  ): Promise<SyncToolResult>;

  /** The `add_recipe` or `remove_recipe` tool (spec 40 §5.5): load, editRecipes. */
  editRecipes(
    root: string,
    merged: MergedConfig,
    op: RecipeOp,
    names: string[],
    opts: { replace?: boolean; fetch: boolean; git?: LoadOptions["git"] },
  ): Promise<RecipeToolResult>;
}

/**
 * Build the `McpWriters` for `craftar mcp --allow-writes` (spec 40 §5.3).
 */
export function mcpWriters(home: string, registryOff: boolean): McpWriters {
  return {
    async consent(root: string, pin: Pin): Promise<ConsentCode> {
      if (registryOff) return "registry-off";

      let reg;
      try {
        reg = await readRegistry(home);
      } catch {
        return "unreadable";
      }

      const consent = await consentFor(reg, root);
      if (consent === null) return "none";

      const stale: Array<"forge" | "ref" | "profile"> = [];
      if (consent.forge.source !== pin.forge) stale.push("forge");
      if (consent.forge.ref !== pin.ref) stale.push("ref");
      if (consent.profile !== pin.profile) stale.push("profile");
      if (stale.length > 0) return { stale };

      return "ok";
    },

    isRemote(forge: string): boolean {
      return classifyForge(forge) === "url";
    },

    async sync(
      root: string,
      merged: MergedConfig,
      opts: { git?: LoadOptions["git"] },
    ): Promise<SyncToolResult> {
      const ws = await loadForgeFor(root, merged, { home, git: opts.git, mode: "sync", fetchHint: "mcp" });
      const p = await plan(ws);

      const unset = unsetDeclared(p);
      if (unset.length) throw new Error(unsetRefusal(unset));

      const lock = await readLock(root);
      const statuses = await status(ws, p, lock);

      const outcome = await syncWorkspace(ws, p, statuses, lock, { home, registryOff });

      return syncToolResult(ws, p, statuses, outcome, registryOff);
    },

    async editRecipes(
      root: string,
      merged: MergedConfig,
      op: RecipeOp,
      names: string[],
      opts: { replace?: boolean; fetch: boolean; git?: LoadOptions["git"] },
    ): Promise<RecipeToolResult> {
      const ws = await loadForgeFor(root, merged, { home, git: opts.git, mode: opts.fetch ? "read" : "no-fetch" });
      const outcome = await editRecipes(ws, op, names, { replace: opts.replace });

      const cached = cachedCopyLine(ws, opts.fetch);
      const loadWarnings = cached === null ? [...ws.warnings] : [cached, ...ws.warnings];

      if (!outcome.changed) {
        return {
          changed: false,
          reasons: outcome.reasons,
          craftarYaml: null,
          recipes: null,
          nextSync: null,
          warnings: loadWarnings,
        };
      }

      return {
        changed: true,
        reasons: outcome.reasons,
        craftarYaml: recipeDiffLine(outcome.before, outcome.after),
        recipes: outcome.next?.recipes ?? null,
        nextSync: outcome.next ? nextSyncLine(outcome.next.statuses, outcome.next.unset) : null,
        warnings: [...loadWarnings, ...(outcome.next?.warnings ?? [])],
      };
    },
  };
}
