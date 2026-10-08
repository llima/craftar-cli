import { promises as fs } from "node:fs";
import path from "node:path";
import { exists } from "./forge.js";
import { LockBusyError, type LockTiming } from "./home-lock.js";
import { namedCacheKeys, readRegistry } from "./registry.js";
import type { Registry } from "../schema/index.js";
import {
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

  // Step 1: No forges/ → empty report with header null.
  if (!(await exists(forgesDir))) {
    return {
      report: { home, dryRun: opts.dryRun, removed: [], kept: [], freedBytes: 0, warnings: [] },
      header: null,
    };
  }

  const cleanupMs = opts.cleanupMs ?? 14 * 24 * 60 * 60 * 1000;
  const start = Date.now();

  // Step 2: Determine naming info (§4.2 step 2).
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

  // Step 3: Snapshot the cache (before taking the lock, so header.bytes is correct).
  let snapshot: CacheSnapshot;
  try {
    snapshot = await inspectCache(home);
  } catch (e) {
    throw new Error(`cannot read ${forgesDir}: ${(e as Error).message}`);
  }
  const header = { forges: forgesDir, entries: snapshot.entries.length, bytes: snapshot.bytes };

  const removed: PruneRemoved[] = [];
  const kept: PruneKept[] = [];
  const warnings: string[] = [];

  if (whyNot !== null) {
    warnings.push(`whole entries kept: ${whyNot} — nothing can tell which ones are used`);
  }

  // The actual prune work: under the prune lock for a run, no lock for dry-run.
  const doPrune = async (refresh: () => Promise<void>) => {
    const step = async () => {
      await refresh();
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

      const stillPrunable = async (): Promise<boolean> => {
        let reg2: Registry;
        try {
          reg2 = await readRegistry(home);
        } catch {
          recheckFailed = true;
          return false;
        }
        const named2 = namedCacheKeys(reg2, checked);
        const fetched2 = await exists(path.join(e.dir, "fetched"));
        finalReason = !fetched2 ? "incomplete" : "orphan";
        return !fetched2 || !named2.has(e.key);
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
          // Add warning only once for recheck failures.
          if (!warnings.some((w) => w.includes("the registry cannot be read"))) {
            warnings.push("whole entries kept: the registry cannot be read — nothing can tell which ones are used");
          }
        } else {
          // Re-read named to get correct namedBy.
          let reg2: Registry;
          try {
            reg2 = await readRegistry(home);
          } catch {
            kept.push({ path: entryRelPath, reason: "unchecked", namedBy: [] });
            continue;
          }
          const named2 = namedCacheKeys(reg2, checked);
          kept.push({ path: entryRelPath, reason: "named", namedBy: named2.get(e.key) ?? [] });
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
      try {
        const pruned = await pruneTrees(e.dir, {
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
      } catch (err) {
        if (err instanceof LockBusyError) {
          warnings.push(`${e.key} is in use (held by PID ${err.holder}) — its trees kept`);
        } else {
          throw err;
        }
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

  // Step 2: Under prune lock for a run, no lock for dry-run.
  if (opts.dryRun) {
    // No lock for dry-run; refresh is a no-op.
    return doPrune(async () => {});
  } else {
    return withPruneLock(home, opts, doPrune);
  }
}
