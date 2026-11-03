import { promises as fs } from "node:fs";
import path from "node:path";

/*
 * The cache-entry label by real path (spec 39's no-snapshot rule), in a module that imports nothing of craftar's, so that
 * `forge.ts` — which `remote.ts` imports — can label a path too. `remote.ts` re-exports every name here.
 */

/**
 * What is printed in place of a cache key no clean registry row vouches for — an orphan, every entry
 * when the registry is off or unreadable. Spec 39 §3.
 */
export const UNVOUCHED_HIDDEN = "(a cache entry name — not shown)";

/**
 * Whether `child` is under `parent` (or equal), segment-wise — `path.relative` compares without case on win32, as `samePath` does.
 * Given `platform` `darwin` or `win32`, both sides are compared without case whatever the running platform: a volume there
 * is case-insensitive by default, so a path in another case may name the same place. With no `platform` nothing changes.
 */
export function isUnderOrEqual(child: string, parent: string, platform?: NodeJS.Platform): boolean {
  const fold = platform === "darwin" || platform === "win32";
  const rel = fold ? path.relative(parent.toLowerCase(), child.toLowerCase()) : path.relative(parent, child);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(".." + path.sep)) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * The real path of the nearest ancestor of `abs` (itself included) that `fs.realpath` resolves, with the rest appended as
 * written; `null` when none does. Unlike `realpathOfNearest` it walks past any failure — a dangling link, a loop, a component
 * it cannot inspect — since it only decides how a path is shown, never whether it may be written. No link target is read.
 */
async function nearestReal(abs: string): Promise<string | null> {
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return null;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/**
 * `p` as a message prints it: as given unless it lands under `<home>/forges`, then `<home>/forges/` with `UNVOUCHED_HIDDEN`
 * in place of the entry and the rest of the real path after it. Where it lands is decided by real paths — the nearest
 * ancestor that resolves on each side — so a home reached through any link, a relative spelling, an entry that is itself a
 * dangling link (its name in the part that does not resolve) and a home with no `forges/` yet are all seen, while a folder
 * named `forges` elsewhere keeps its name (0.40.1). A part past a link that does not resolve is compared as written.
 */
export async function shownByRealPath(p: string, home: string): Promise<string> {
  const forges = path.join(path.resolve(home), "forges");
  const [real, forgesReal] = await Promise.all([nearestReal(path.resolve(p)), nearestReal(forges)]);
  if (real === null || forgesReal === null || !isUnderOrEqual(real, forgesReal)) return p;
  const rel = path.relative(forgesReal, real);
  return rel === "" ? forges : path.join(forges, UNVOUCHED_HIDDEN, ...rel.split(path.sep).slice(1));
}

/** Why `realpathOfNearest` could not resolve a path: `at` is the component it stopped at, as given — the message prints it. */
export class CannotResolveError extends Error {
  constructor(
    readonly at: string,
    readonly what: "cannot be inspected" | "exists but cannot be resolved",
    readonly code: string,
  ) {
    super(`${at} ${what} (${code})`);
  }
}

/**
 * The text of an error caught from `realpathOfNearest`, with the path it names shown by `shownByRealPath`; any other error's
 * message as it is. Callers still pass the result through `hideUnderCaches`.
 */
export async function shownCannotResolve(e: unknown, home: string): Promise<string> {
  if (e instanceof CannotResolveError) return `${await shownByRealPath(e.at, home)} ${e.what} (${e.code})`;
  return e instanceof Error ? e.message : String(e);
}
