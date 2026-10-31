/**
 * Spec 49 Part A: which files craftar generates does git ignore. Read by a writing sync, `sync --check` and `doctor`; it is
 * not a plan warning, because `plan()` is read by every surface and `doctor` reports a cause once (§2.7).
 */
import { gitIsRepo, ignoredPaths } from "./forge.js";
import { findSecrets } from "./secrets.js";
import { LOCK_FILE, type Plan, type Workspace } from "./sync.js";

export interface GeneratedIgnored {
  /** One line per ignored path, in `ignoredLine`'s words. */
  lines: string[];
  /** `mayBeIgnored` entries that name no generated path: as written when shaped like a path, else by position. */
  stale: string[];
  /** git stopped before answering for every path (a path beyond a symbolic link). */
  unchecked: boolean;
  inRepo: boolean;
  /** `forge:` comes from `craftar.local.yaml`, and the plan already says not to commit these files (§4.5). */
  silenced: boolean;
}

export const UNCHECKED_LINE = "some generated paths could not be checked against git's ignore rules";
export const IGNORED_FIX = "fix the rule, or git add -f, or list the path under mayBeIgnored in craftar.yaml";
export const staleLine = (entries: string[]): string => `mayBeIgnored names a path craftar does not generate: ${entries.join(", ")}`;

export function ignoredLine(file: string, rule: string): string {
  return `${file} is generated, but git ignores it (${rule}) — it will not reach a commit; fix the rule or git add -f`;
}

/** The value is the user's and reaches a terminal: as in `shownName`, only what is shaped like what it claims to be is printed. */
function shownEntry(entry: string, index: number): string {
  return /^[\w.@+\-/]{1,200}$/.test(entry) && findSecrets(entry).length === 0 ? entry : `#${index + 1}`;
}

export async function generatedIgnored(ws: Workspace, p: Plan): Promise<GeneratedIgnored> {
  const nothing = { lines: [], stale: [], unchecked: false };
  if (!(await gitIsRepo(ws.root))) return { ...nothing, inRepo: false, silenced: false };
  if (ws.origin.fromLocalFile) return { ...nothing, inRepo: true, silenced: true };
  const generated = [...p.files.map((f) => f.path), LOCK_FILE];
  const allowed = new Set(ws.config.mayBeIgnored ?? []);
  const { ignored, unchecked } = await ignoredPaths(ws.root, generated.filter((f) => !allowed.has(f)));
  return {
    lines: ignored.map((i) => ignoredLine(i.path, i.rule)),
    stale: (ws.config.mayBeIgnored ?? []).flatMap((f, i) => (generated.includes(f) ? [] : [shownEntry(f, i)])),
    unchecked,
    inRepo: true,
    silenced: false,
  };
}
