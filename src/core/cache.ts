import { promises as fs } from "node:fs";
import path from "node:path";
import { LockBusyError, type LockTiming } from "./home-lock.js";
import { namedCacheKeys, readRegistry } from "./registry.js";
import type { Registry } from "../schema/index.js";
import {
  cacheDir,
  cacheKey,
  classifyForge,
  inspectCache,
  pruneTrees,
  removeEntry,
  removeLeftover,
  withPruneLock,
  type CacheSnapshot,
  type GitRunner,
} from "./remote.js";
import { readWorkspaceConfig } from "./sync.js";

/** Build the "whole entries kept" warning from a reason (used by two code paths). */
const wholeEntriesWarning = (reason: string) => `whole entries kept: ${reason} — nothing can tell which ones are used`;

/*
 * The Forge cache pruner (spec 26 §5.1): removes orphan/incomplete entries, trees unused for 14 days,
 * and leftover removal directories. Returns data and never prints; never writes or deletes through
 * `fs` itself — only through remote.ts.
 */

export type PruneKind = "entry" | "tree" | "leftover";
export type PruneReason = "orphan" | "incomplete" | "unused" | "interrupted";
export type KeptReason = "named" | "busy" | "held-open" | "unchecked";

export interface PruneRemoved {
  path: string;
  kind: PruneKind;
  reason: PruneReason;
  bytes: number;
}

export interface PruneKept {
  path: string;
  reason: KeptReason;
  namedBy: string[];
}

/** The `--json` contract of `craftar cache prune` (spec 26 §4.5): keys in this order. */
export interface PruneReport {
  home: string;
  dryRun: boolean;
  removed: PruneRemoved[];
  kept: PruneKept[];
  freedBytes: number;
  warnings: string[];
}

export interface PruneResult {
  report: PruneReport;
  /** For the text header (§4.4) — not part of the contract; null when there is no `forges/`. */
  header: { forges: string; entries: number; bytes: number } | null;
}

export interface PruneOptions extends LockTiming {
  dryRun: boolean;
  /** The workspace whose Forge counts as used besides the registry (§4.1), or null. */
  workspace: string | null;
  /** A non-empty CRAFTAR_NO_REGISTRY, read by the CLI. */
  registryOff: boolean;
  /** When an unused tree goes (14 days, Ruling 4); tests shorten it. */
  cleanupMs?: number;
  git?: GitRunner;
  /** Test hook: passed to `removeEntry`. */
  rename?: (from: string, to: string) => Promise<void>;
  /** Test hook: awaited after each `refresh()` of the prune lock, before the step it precedes. */
  beforeStep?: () => Promise<void>;
}

export async function pruneCache(home: string, opts: PruneOptions): Promise<PruneResult> {
  home = path.resolve(home);
  const forgesDir = path.join(home, "forges");
  const rel = (dir: string) => path.relative(home, dir).split(path.sep).join("/");

  // Step 1: No forges/ → empty report with header null (before the lock, §4.2 step 0).
  if ((await cacheDir(home)) === "absent") {
    return {
      report: { home, dryRun: opts.dryRun, removed: [], kept: [], freedBytes: 0, warnings: [] },
      header: null,
    };
  }

  const cleanupMs = opts.cleanupMs ?? 14 * 24 * 60 * 60 * 1000;

  // The actual prune work: under the prune lock for a run, no lock for dry-run.
  // Everything after the "no forges/" check runs under the prune lock (§4.2 step 0).
  const doPrune = async (lock: { refresh: () => Promise<void>; bytes: number }) => {
    const start = Date.now();

    // Step 2: Determine naming info (§4.2 step 2) — under the lock so a waiting prune sees the state
    // after the one that held the lock finishes.
    let whyNot: string | null = null;
    let reg: Registry | null = null;
    let checked: { key: string; path: string } | null = null;

    if (opts.registryOff) {
      whyNot = "CRAFTAR_NO_REGISTRY is set";
    } else {
      try {
        reg = await readRegistry(home);
      } catch {
        whyNot = "the registry cannot be read";
      }
    }

    if (opts.workspace !== null && whyNot === null) {
      const given = path.resolve(opts.workspace);
      const root = await fs.realpath(given).catch(() => given);
      try {
        const merged = await readWorkspaceConfig(given);
        if (classifyForge(merged.config.forge) === "url") {
          checked = { key: cacheKey(merged.config.forge.trim()), path: root };
        }
      } catch {
        whyNot = "the checked craftar.yaml does not read";
      }
    }

    const named = whyNot === null ? namedCacheKeys(reg!, checked) : new Map<string, string[]>();

    // Step 3: Snapshot the cache — under the lock.
    let snapshot: CacheSnapshot;
    try {
      snapshot = await inspectCache(home);
    } catch (e) {
      throw new Error(`cannot read ${forgesDir}: ${(e as Error).message}`);
    }
    // Header bytes is the whole of forges/ (snapshot.bytes) minus the prune.lock this run holds:
    // the lock is in forges/ during the snapshot but is not part of the cache content.
    const headerBytes = snapshot.bytes - lock.bytes;
    const header = { forges: forgesDir, entries: snapshot.entries.length, bytes: headerBytes };

    const removed: PruneRemoved[] = [];
    const kept: PruneKept[] = [];
    const warnings: string[] = [];
    let recheckWarningAdded = false; // Ensures the warning is added at most once.

    if (whyNot !== null) {
      warnings.push(wholeEntriesWarning(whyNot));
    }

    const step = async () => {
      await lock.refresh();
      await opts.beforeStep?.();
    };

    // Track which entries were removed vs kept (and not busy) for tree pruning.
    const removedEntries = new Set<string>();
    const busyEntries = new Set<string>();

    // Step 4–5: Process whole entries in snapshot order (sorted by key).
    for (const e of snapshot.entries) {
      await step();
      const entryRelPath = rel(e.dir);

      // If whyNot is set, keep every entry as unchecked.
      if (whyNot !== null) {
        kept.push({ path: entryRelPath, reason: "unchecked", namedBy: [] });
        continue;
      }

      // Determine if prunable: !fetched (incomplete) or !named (orphan).
      const prunable = !e.fetched || !named.has(e.key);
      const reason: PruneReason = !e.fetched ? "incomplete" : "orphan";

      if (!prunable) {
        kept.push({ path: entryRelPath, reason: "named", namedBy: named.get(e.key)! });
        continue;
      }

      // Prunable.
      if (opts.dryRun) {
        removed.push({ path: entryRelPath, kind: "entry", reason, bytes: e.bytes });
        removedEntries.add(e.key);
        continue;
      }

      // For a run: call removeEntry with a re-check callback.
      let recheckFailed = false;
      let finalReason = reason;
      let recheckNamed: Map<string, string[]> | null = null; // Captured from the re-check callback.

      const stillPrunable = async (now: { fetched: boolean }): Promise<boolean> => {
        let reg2: Registry;
        try {
          reg2 = await readRegistry(home);
        } catch {
          recheckFailed = true;
          return false;
        }
        recheckNamed = namedCacheKeys(reg2, checked);
        finalReason = !now.fetched ? "incomplete" : "orphan";
        return !now.fetched || !recheckNamed.has(e.key);
      };

      const outcome = await removeEntry(e.dir, stillPrunable, {
        waitMs: opts.waitMs,
        pollMs: opts.pollMs,
        staleMs: opts.staleMs,
        rename: opts.rename,
      });

      for (const w of outcome.warnings) warnings.push(w);

      if (outcome.outcome === "removed") {
        removed.push({ path: entryRelPath, kind: "entry", reason: finalReason, bytes: e.bytes });
        removedEntries.add(e.key);
      } else if (outcome.outcome === "kept") {
        if (recheckFailed) {
          kept.push({ path: entryRelPath, reason: "unchecked", namedBy: [] });
          // Add warning only once per run.
          if (!recheckWarningAdded) {
            warnings.push(wholeEntriesWarning("the registry cannot be read"));
            recheckWarningAdded = true;
          }
        } else {
          // Use the namedBy values captured from the re-check, which ran under the lock.
          // When recheckFailed is false, stillPrunable ran successfully and set recheckNamed.
          const namedBy = recheckNamed!.get(e.key) ?? [];
          kept.push({ path: entryRelPath, reason: "named", namedBy });
        }
      } else if (outcome.outcome === "busy") {
        kept.push({ path: entryRelPath, reason: "busy", namedBy: named.get(e.key) ?? [] });
        busyEntries.add(e.key);
        warnings.push(`${e.key} is in use (held by PID ${outcome.holder}) — kept`);
      } else if (outcome.outcome === "held-open") {
        kept.push({ path: entryRelPath, reason: "held-open", namedBy: named.get(e.key) ?? [] });
      }
    }

    // Step 6: Trees (§4.2 step 5) — for every entry not removed and not kept busy.
    for (const e of snapshot.entries) {
      if (removedEntries.has(e.key) || busyEntries.has(e.key)) continue;

      await step();

      if (opts.dryRun) {
        // Report trees that would be removed (unused for >= cleanupMs).
        for (const t of e.trees) {
          if (t.lastUse !== null && t.lastUse < start - cleanupMs) {
            removed.push({
              path: `${rel(e.dir)}/trees/${t.commit}`,
              kind: "tree",
              reason: "unused",
              bytes: t.bytes,
            });
          }
        }
        continue;
      }

      // For a run: call pruneTrees.
      const { removed: pruned, busy } = await pruneTrees(e.dir, {
        git: opts.git,
        cleanupMs,
        waitMs: opts.waitMs,
        pollMs: opts.pollMs,
        staleMs: opts.staleMs,
      });
      for (const t of pruned) {
        removed.push({
          path: `${rel(e.dir)}/trees/${t.commit}`,
          kind: "tree",
          reason: "unused",
          bytes: t.bytes,
        });
      }
      if (busy) {
        warnings.push(`${e.key} is in use (held by PID ${busy.holder}) — its trees kept`);
      }
    }

    // Step 7: Removal directories (§4.2 step 6).
    for (const r of snapshot.removing) {
      await step();
      const rRelPath = rel(r.dir);

      if (opts.dryRun) {
        removed.push({ path: rRelPath, kind: "leftover", reason: "interrupted", bytes: r.bytes });
        continue;
      }

      const warn = await removeLeftover(r.dir);
      if (warn === null) {
        removed.push({ path: rRelPath, kind: "leftover", reason: "interrupted", bytes: r.bytes });
      } else {
        warnings.push(warn);
      }
    }

    const freedBytes = removed.reduce((sum, r) => sum + r.bytes, 0);

    return {
      report: { home, dryRun: opts.dryRun, removed, kept, freedBytes, warnings },
      header,
    };
  };

  // Under prune lock for a run, no lock for dry-run.
  if (opts.dryRun) {
    // No lock for dry-run; refresh is a no-op, bytes is 0.
    return doPrune({ refresh: async () => {}, bytes: 0 });
  } else {
    return withPruneLock(home, opts, doPrune);
  }
}
