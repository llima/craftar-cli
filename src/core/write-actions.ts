/**
 * Spec 40 Part A — the writing half of `sync`, `init`, `drift discard`, `add recipe` and `remove recipe`,
 * shared by the CLI and `craftar mcp --allow-writes`. Loads nothing, prints nothing, writes only through
 * `apply()`, `register()` and the one in-place write of `craftar.yaml`.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { InitIo } from "./init-flow.js";
import { yesNo } from "./init-flow.js";
import { consentFor, readRegistry, register, registryFile } from "./registry.js";
import { classifyForge } from "./remote.js";
import { explainSkip, forgeLine, nextSyncLine } from "./report.js";
import { editRecipesText, planRecipeEdit, recipeDiffLine, type RecipeLists, type RecipeOp } from "./recipe-edit.js";
import {
  apply,
  loadForgeFor,
  plan,
  readLock,
  status,
  unsetDeclared,
  unsetRefusal,
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
import type { Lock, WriteConsent } from "../schema/index.js";
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

/**
 * The writers the MCP server uses under `--allow-writes` (spec 40 §5.3).
 * Each method receives what `mcp-protocol.ts` can pass without value imports.
 */
export interface McpWriters {
  /**
   * Check consent for a writing tool call (spec 40 §5.5 step 2).
   * Returns null if consent is valid, or an error message string if:
   * - the registry is off (`WRITES_NEED_REGISTRY`)
   * - the registry cannot be read (`REGISTRY_UNREADABLE`)
   * - no consent is recorded (`WRITES_NOT_ALLOWED`)
   * - consent is for a different forge/ref/profile (`CONSENT_STALE`)
   */
  consent(root: string, pin: Pin): Promise<string | null>;

  /**
   * Classify the Forge (spec 40 §5.5 step 3): "remote" | "path".
   */
  classifyForge(root: string, merged: MergedConfig): Promise<"remote" | "path">;

  /**
   * The `sync` tool (spec 40 §5.5): load, plan, run syncWorkspace.
   * Refuses an unset declared parameter. Never overwrites drift.
   */
  sync(
    root: string,
    merged: MergedConfig,
    fetch: boolean,
    opts: { home: string; git?: LoadOptions["git"] },
  ): Promise<SyncToolResult>;

  /**
   * The `add_recipe` tool (spec 40 §5.5): load, editRecipes("add", ...).
   */
  addRecipe(
    root: string,
    merged: MergedConfig,
    names: string[],
    replace: boolean,
    opts: { home: string; git?: LoadOptions["git"] },
  ): Promise<RecipeToolResult>;

  /**
   * The `remove_recipe` tool (spec 40 §5.5): load, editRecipes("remove", ...).
   */
  removeRecipe(
    root: string,
    merged: MergedConfig,
    names: string[],
    opts: { home: string; git?: LoadOptions["git"] },
  ): Promise<RecipeToolResult>;
}

/**
 * Build the `McpWriters` for `craftar mcp --allow-writes` (spec 40 §5.3).
 */
export function mcpWriters(home: string, registryOff: boolean): McpWriters {
  return {
    async consent(root: string, pin: Pin): Promise<string | null> {
      // Import the error constants lazily to avoid a circular dependency
      const {
        WRITES_NEED_REGISTRY,
        WRITES_NOT_ALLOWED,
        CONSENT_STALE,
        REGISTRY_UNREADABLE,
      } = await import("./mcp-protocol.js");

      if (registryOff) return WRITES_NEED_REGISTRY;

      let reg;
      try {
        reg = await readRegistry(home);
      } catch {
        return REGISTRY_UNREADABLE;
      }

      const consent = await consentFor(reg, root);
      if (consent === null) return WRITES_NOT_ALLOWED;

      // Check that consent matches the pin
      const staleKeys: string[] = [];
      if (consent.forge.source !== pin.forge) staleKeys.push("forge");
      if (consent.forge.ref !== pin.ref) staleKeys.push("ref");
      if (consent.profile !== pin.profile) staleKeys.push("profile");
      if (staleKeys.length > 0) return CONSENT_STALE(staleKeys);

      return null;
    },

    async classifyForge(_root: string, merged: MergedConfig): Promise<"remote" | "path"> {
      return classifyForge(merged.config.forge) === "url" ? "remote" : "path";
    },

    async sync(
      root: string,
      merged: MergedConfig,
      fetch: boolean,
      opts: { home: string; git?: LoadOptions["git"] },
    ): Promise<SyncToolResult> {
      const ws = await loadForgeFor(root, merged, { home: opts.home, git: opts.git, mode: fetch ? "read" : "no-fetch" });
      const p = await plan(ws);

      // Refuse when a declared parameter has no value
      const unset = unsetDeclared(p);
      if (unset.length) {
        throw new Error(unsetRefusal(unset));
      }

      const lock = await readLock(root);
      const statuses = await status(ws, p, lock);

      const outcome = await syncWorkspace(ws, p, statuses, lock, {
        home,
        registryOff,
        // Never overwriteDrift: sync skips hand-edited files
        // Never overwritePaths: ditto
        // Never dryRun: the tool writes
      });

      return {
        profile: ws.config.profile,
        recipes: [...p.resolution.recipes],
        targets: [...p.resolution.targets],
        forge: outcome.forgeLine,
        written: outcome.result.written,
        removed: outcome.result.removed.map((path) => ({ path, reason: "orphan: no longer produced by the Forge" })),
        skipped: outcome.result.skipped.map((s) => ({ path: s.path, state: s.state, reason: explainSkip(s) })),
        warnings: p.warnings,
        registry: registryOff ? "off" : outcome.registry ? "not updated" : "updated",
      };
    },

    async addRecipe(
      root: string,
      merged: MergedConfig,
      names: string[],
      replace: boolean,
      opts: { home: string; git?: LoadOptions["git"] },
    ): Promise<RecipeToolResult> {
      const ws = await loadForgeFor(root, merged, { home: opts.home, git: opts.git, mode: "no-fetch" });
      const outcome = await editRecipes(ws, "add", names, { replace });

      if (!outcome.changed) {
        return {
          changed: false,
          reasons: outcome.reasons,
          craftarYaml: null,
          recipes: null,
          nextSync: null,
          warnings: [],
        };
      }

      return {
        changed: true,
        reasons: outcome.reasons,
        craftarYaml: recipeDiffLine(outcome.before, outcome.after),
        recipes: outcome.next?.recipes ?? null,
        nextSync: outcome.next ? nextSyncLine(outcome.next.statuses, outcome.next.unset) : null,
        warnings: outcome.next?.warnings ?? [],
      };
    },

    async removeRecipe(
      root: string,
      merged: MergedConfig,
      names: string[],
      opts: { home: string; git?: LoadOptions["git"] },
    ): Promise<RecipeToolResult> {
      const ws = await loadForgeFor(root, merged, { home: opts.home, git: opts.git, mode: "no-fetch" });
      const outcome = await editRecipes(ws, "remove", names);

      if (!outcome.changed) {
        return {
          changed: false,
          reasons: outcome.reasons,
          craftarYaml: null,
          recipes: null,
          nextSync: null,
          warnings: [],
        };
      }

      return {
        changed: true,
        reasons: outcome.reasons,
        craftarYaml: recipeDiffLine(outcome.before, outcome.after),
        recipes: outcome.next?.recipes ?? null,
        nextSync: outcome.next ? nextSyncLine(outcome.next.statuses, outcome.next.unset) : null,
        warnings: outcome.next?.warnings ?? [],
      };
    },
  };
}
