/**
 * Spec 49 Part C: an optional git hook that runs `sync --check` over what is pushed or committed. Only a person typing
 * `craftar git-hooks install` writes one (Ruling 1), inside the repository only; `sync` never reads, updates or removes it,
 * and it is recorded nowhere, the stated exception to "only paths in the lock are written". The hook starts only the
 * `craftar` of PATH, never `npx`, and a program under the repository or found through a relative entry counts as none (Ruling 4).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { LOCK_FILE, loadForgeFor, plan, readLock, readWorkspaceConfig, type MergedConfig } from "./sync.js";
import { gitIsRepo, gitRead, realpathOfNearest } from "./forge.js";
import { execProgram, onPath } from "./proc.js";
import { classifyForge, isUnderOrEqual } from "./remote.js";
import { findSecrets } from "./secrets.js";
import { locateWorkspace } from "./workspace-source.js";

export const HOOK_NAMES = ["pre-push", "pre-commit"] as const;
export type HookName = (typeof HOOK_NAMES)[number];

export const BACKUP_SUFFIX = ".craftar-backup";
const MARKER = /^# craftar git-hooks \d+ workspace='([^']*)' — /;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** The one rule of a `<dir>` in a hook: it goes single-quoted into a shell script, and it is read back from a file. */
const usableDir = (dir: string) => !dir.includes("'") && !CONTROL.test(dir);

/** The hook, LF, no BOM (spec 49 §6.3). */
export function hookScript(name: HookName, dir: string, opts: { blockWhenUnavailable: boolean }): string {
  const ok = opts.blockWhenUnavailable ? "" : " --unavailable-ok";
  const head = [
    "#!/bin/sh",
    `# craftar git-hooks 1 workspace='${dir}' — written by craftar git-hooks install; craftar git-hooks uninstall removes it`,
    "p=$(command -v craftar 2>/dev/null) || p=",
    'case "$p" in',
    `  "$PWD"/*|'') p= ;;`,
    "  /*|[A-Za-z]:*) ;;",
    "  *) p= ;;",
    "esac",
    'if [ -z "$p" ]; then',
    '  echo "craftar not found on PATH — sync not checked" >&2',
    "  exit 0",
    "fi",
  ];
  const body =
    name === "pre-push"
      ? [
          "status=0",
          "seen=",
          "while read -r _ sha _ _; do",
          '  case "$sha" in *[!0]*) ;; *) continue ;; esac',
          '  case " $seen " in *" $sha "*) continue ;; esac',
          '  seen="$seen $sha"',
          `  "$p" sync --check --committed "$sha" --workspace '${dir}'${ok} </dev/null || status=1`,
          "done",
          "exit $status",
        ]
      : [`"$p" sync --check --index --workspace '${dir}'${ok} </dev/null`];
  return `${[...head, ...body].join("\n")}\n`;
}

/**
 * The marker of a hook file, or null: a hook under a tracked `core.hooksPath` is the repository's text, so what does not
 * parse, or a `<dir>` that breaks the rule or holds a token, reads as no marker and is never printed.
 */
export function readHookMarker(text: string): { workspace: string } | null {
  const line = text.split("\n")[1] ?? "";
  const m = MARKER.exec(line);
  if (!m || !usableDir(m[1]) || findSecrets(m[1]).length > 0) return null;
  return { workspace: m[1] };
}

export class GitHooksRefusal extends Error {}

export interface HooksPlace {
  /** The real hooks directory. */
  dir: string;
  /** The label: never a path outside the repository. */
  label: ".git/hooks" | "core.hooksPath (inside the repository)" | "core.hooksPath (outside the repository)";
  inside: boolean;
  /** The workspace's path from the repository's root; `.` at the root. */
  workspaceDir: string;
  /** The repository's real top. */
  top: string;
}

/** Where the hooks are (spec 49 §6.2, steps 1 and 2); it refuses nothing but a directory that is no repository with a work tree. */
export async function locateHooks(root: string): Promise<HooksPlace> {
  const { start, prefix } = await locateWorkspace(root).catch(() => ({ start: null, prefix: "" }));
  if (start === null || !(await gitIsRepo(start))) throw new GitHooksRefusal("git-hooks needs a workspace in a git repository with a work tree (git not found counts)");
  const ask = async (...args: string[]) => (await execProgram("git", [...gitRead(start), ...args])).stdout.replace(/\r?\n$/, "");
  const answer = await ask("rev-parse", "--git-path", "hooks");
  const dir = await realpathOfNearest(path.resolve(start, answer));
  const top = await fs.realpath(await ask("rev-parse", "--path-format=absolute", "--show-toplevel"));
  const common = await fs.realpath(await ask("rev-parse", "--path-format=absolute", "--git-common-dir"));
  const inside = isUnderOrEqual(dir, top) || isUnderOrEqual(dir, common);
  const configured = await ask("config", "--get", "core.hooksPath").then((v) => v !== "", () => false);
  const label = !configured ? ".git/hooks" : inside ? "core.hooksPath (inside the repository)" : "core.hooksPath (outside the repository)";
  return { dir, label, inside, workspaceDir: prefix.replace(/\/$/, "") || ".", top };
}

const OUTSIDE = (dir: string) =>
  `core.hooksPath is outside the repository, so a hook there would run for every repository that inherits it: craftar writes nothing there. Add the line by hand: craftar sync --check --committed <sha> --workspace '${dir}'`;

type Found = { kind: "absent" } | { kind: "other" } | { kind: "marked"; workspace: string };

async function foundAt(file: string): Promise<Found> {
  const stat = await fs.lstat(file).catch(() => null);
  if (stat === null) return { kind: "absent" };
  if (!stat.isFile()) return { kind: "other" };
  const marker = readHookMarker(await fs.readFile(file, "utf8"));
  return marker === null ? { kind: "other" } : { kind: "marked", workspace: marker.workspace };
}

export interface InstallResult {
  place: HooksPlace;
  written: HookName[];
  backedUp: HookName[];
  notes: string[];
}

/** `git-hooks install` (spec 49 §6.2, §6.4): every refusal comes before the first write, of either hook. */
export async function installHooks(
  root: string,
  names: readonly HookName[],
  opts: { force: boolean; blockWhenUnavailable: boolean; home?: string },
): Promise<InstallResult> {
  const place = await locateHooks(root);
  let merged: MergedConfig;
  try {
    merged = await readWorkspaceConfig(root);
  } catch (e) {
    throw new GitHooksRefusal(e instanceof Error ? e.message : String(e));
  }
  if (!place.inside) throw new GitHooksRefusal(OUTSIDE(place.workspaceDir));
  const { forge } = merged.config;
  if (classifyForge(forge) === "path" && isUnderOrEqual(place.dir, await realpathOfNearest(path.resolve(root, forge))))
    throw new GitHooksRefusal("the hooks directory is inside the Forge: a Forge write has to be gated on git, and this is not one");
  if (!usableDir(place.workspaceDir)) throw new GitHooksRefusal("the workspace's path holds a quote or a control character, which a hook cannot name");
  const stat = await fs.lstat(place.dir).catch(() => null);
  if (stat !== null && !stat.isDirectory()) throw new GitHooksRefusal("the hooks path exists and is not a directory");

  const notes: string[] = [];
  // Step 5: `sync` writes there too, and a hook is no file of the lock.
  const held = new Set<string>();
  try {
    const p = await plan(await loadForgeFor(root, merged, { mode: "no-fetch", home: opts.home }));
    for (const f of p.files) held.add(f.path.toLowerCase());
  } catch {
    notes.push(`the Forge could not be read: the hook's path was compared with ${LOCK_FILE} alone`);
  }
  const lock = await readLock(root).catch(() => null);
  for (const e of lock?.files ?? []) held.add(e.path.toLowerCase());
  const realRoot = await realpathOfNearest(root);
  const backedUp: HookName[] = [];
  for (const name of names) {
    const file = path.join(place.dir, name);
    if (held.has(path.relative(realRoot, file).split(path.sep).join("/").toLowerCase())) throw new GitHooksRefusal(`${name}: craftar writes that path from the Forge, so a hook cannot live there`);
    const found = await foundAt(file);
    if (found.kind === "marked" && found.workspace !== place.workspaceDir) throw new GitHooksRefusal(`${name} is installed for workspace ${found.workspace} of this repository: one hook per repository (--force does not change that)`);
    if (found.kind === "other") {
      if (!opts.force) throw new GitHooksRefusal(`${name} exists and is not craftar's: pass --force to keep it as ${name}${BACKUP_SUFFIX}`);
      if (await fs.lstat(file + BACKUP_SUFFIX).then(() => true, () => false)) throw new GitHooksRefusal(`${name}${BACKUP_SUFFIX} already exists: move it first`);
      backedUp.push(name);
    }
  }
  if (place.label !== ".git/hooks") notes.push("core.hooksPath is inside the repository: if it is tracked, this hook reaches everyone who clones it — review before committing");
  if (merged.fromLocalFile) notes.push("forge: comes from craftar.local.yaml, which a check over a commit does not read: name the Forge in craftar.yaml, or every push is refused");

  await fs.mkdir(place.dir, { recursive: true });
  for (const name of names) {
    const file = path.join(place.dir, name);
    if (backedUp.includes(name)) await fs.rename(file, file + BACKUP_SUFFIX);
    const tmp = `${file}.craftar-${process.pid}.tmp`;
    await fs.writeFile(tmp, hookScript(name, place.workspaceDir, { blockWhenUnavailable: opts.blockWhenUnavailable }), { flag: "wx", mode: 0o755 });
    try {
      await fs.rename(tmp, file);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
  }
  return { place, written: [...names], backedUp, notes };
}

export interface UninstallResult {
  removed: HookName[];
  left: HookName[];
  backups: string[];
}

/** `git-hooks uninstall` (spec 49 §6.4): reads no `craftar.yaml`, since a hook that blocks on a bad one has to be removable. */
export async function uninstallHooks(root: string, named: readonly HookName[]): Promise<UninstallResult> {
  const place = await locateHooks(root);
  if (!place.inside) throw new GitHooksRefusal(OUTSIDE(place.workspaceDir));
  const names = named.length > 0 ? named : HOOK_NAMES;
  const removing: HookName[] = [];
  const left: HookName[] = [];
  for (const name of names) {
    const found = await foundAt(path.join(place.dir, name));
    if (found.kind === "absent") continue;
    if (found.kind === "marked" && found.workspace === place.workspaceDir) removing.push(name);
    else if (named.length > 0) throw new GitHooksRefusal(`${name} is not this workspace's hook: nothing removed`);
    else left.push(name);
  }
  const backups: string[] = [];
  for (const name of removing) {
    await fs.rm(path.join(place.dir, name));
    if (await fs.lstat(path.join(place.dir, name + BACKUP_SUFFIX)).then(() => true, () => false)) backups.push(name + BACKUP_SUFFIX);
  }
  return { removed: removing, left, backups };
}

export interface HooksStatus {
  hooksDir: HooksPlace["label"];
  hooks: Array<{ name: HookName; state: "installed" | "other" | "absent"; workspace: string | null }>;
}

/** `git-hooks status`, a tooling contract under `--json`; it reads, and names no path. */
export async function hooksStatus(root: string): Promise<HooksStatus & { workspaceDir: string }> {
  const place = await locateHooks(root);
  const hooks: HooksStatus["hooks"] = [];
  for (const name of HOOK_NAMES) {
    const found = await foundAt(path.join(place.dir, name));
    hooks.push(
      found.kind === "marked"
        ? { name, state: "installed", workspace: found.workspace }
        : { name, state: found.kind, workspace: null },
    );
  }
  return { hooksDir: place.label, hooks, workspaceDir: place.workspaceDir };
}

/** What the hook's own rule would find, approximately: a relative entry ahead of an absolute one is not seen (spec 49 §6.5). */
export async function hookFindsCraftar(top: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const found = await onPath("craftar", env);
  return found !== null && !isUnderOrEqual(found, top);
}
