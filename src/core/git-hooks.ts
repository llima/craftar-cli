/**
 * Spec 49 Part C: an optional git hook that runs `sync --check` over what is pushed or committed. Only a person typing
 * `craftar git-hooks install` writes one (Ruling 1), inside the repository only; `sync` never reads, updates or removes it,
 * and it is recorded nowhere, the stated exception to "only paths in the lock are written". The hook starts only the
 * `craftar` of PATH, never `npx`, and a program under the repository or found through a relative entry counts as none (Ruling 4).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { LOCK_FILE, loadForgeFor, plan, readLock, readWorkspaceConfig, type MergedConfig } from "./sync.js";
import { gitIsRepo, gitRead, realpathOfNearest, TERMINAL_UNSAFE } from "./forge.js";
import { execProgram, lookupEntries, onPath } from "./proc.js";
import { classifyForge, isUnderOrEqual, urlCredentialIn } from "./remote.js";
import { findSecrets } from "./secrets.js";
import { locateWorkspace } from "./workspace-source.js";

export const HOOK_NAMES = ["pre-push", "pre-commit"] as const;
export type HookName = (typeof HOOK_NAMES)[number];

export const BACKUP_SUFFIX = ".craftar-backup";
const MARKER = /^# craftar git-hooks \d+ workspace='([^']*)' — /;
const WIN = process.platform === "win32";
/** A marker is read from a file only the first few KB of which can matter. */
const MARKER_BYTES = 4096;

/** The one rule of a `<dir>` in a hook: it goes single-quoted into a shell script, and it is read back from a file. */
const usableDir = (dir: string) => !dir.includes("'") && !TERMINAL_UNSAFE.test(dir);

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
  if (!m || !usableDir(m[1]) || findSecrets(m[1]).length > 0 || urlCredentialIn(m[1])) return null;
  return { workspace: m[1] };
}

export class GitHooksRefusal extends Error {}

/** A hook that cannot be read: said, never read as absent (spec 49 §6.5). */
export class HooksUnreadable extends GitHooksRefusal {}

export interface HooksPlace {
  /** The real hooks directory. */
  dir: string;
  /** The label: never a path outside the repository. */
  label: ".git/hooks" | ".git/hooks (outside the repository)" | "core.hooksPath (inside the repository)" | "core.hooksPath (outside the repository)";
  inside: boolean;
  /** Why it is not inside: the words of a refusal. */
  outside: string;
  /** The hooks live in the repository's git directory, not its working tree. */
  inGitDir: boolean;
  /** The workspace's path from the repository's root; `.` at the root. */
  workspaceDir: string;
  /** The repository's real top. */
  top: string;
}

/** Where the hooks are (spec 49 §6.2, steps 1 and 2); it refuses nothing but a directory that is no repository with a work tree. */
export async function locateHooks(root: string): Promise<HooksPlace> {
  const { start, prefix } = await locateWorkspace(root).catch(() => ({ start: null, prefix: "" }));
  if (start === null || !(await gitIsRepo(start))) throw new GitHooksRefusal("git-hooks needs a workspace in a git repository with a work tree (git not found counts)");
  const askAt = async (at: string, ...args: string[]) => (await execProgram("git", [...gitRead(at), ...args])).stdout.replace(/\r?\n$/, "");
  const top = await fs.realpath(await askAt(start, "rev-parse", "--path-format=absolute", "--show-toplevel"));
  const common = await fs.realpath(await askAt(start, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  // From the top, so a `..` in the answer is the configuration's and not this directory's.
  const answer = await askAt(top, "rev-parse", "--git-path", "hooks");
  // A dangling link throws with its path in the message, and that path can be outside the repository.
  const dir = await realpathOfNearest(path.resolve(top, answer)).catch(() => {
    throw new GitHooksRefusal("the hooks path passes through a link that does not resolve");
  });
  const scoped = await askAt(top, "config", "--show-scope", "--get", "core.hooksPath").catch(() => "");
  const configured = scoped !== "";
  const allRepos = /^(global|system)\s/.test(scoped);
  // The kernel walks `lnk/../hk` through the link and a lexical resolve does not: such a path cannot be vouched for.
  const climbs = configured && answer.split(/[\\/]/).includes("..");
  const inGitDir = isUnderOrEqual(dir, common);
  const empty = /^\w+\s*$/.test(scoped);
  const inside = !allRepos && !climbs && !empty && (isUnderOrEqual(dir, top) || inGitDir);
  const label = configured ? (inside ? "core.hooksPath (inside the repository)" : "core.hooksPath (outside the repository)") : inside ? ".git/hooks" : ".git/hooks (outside the repository)";
  const outside = !configured
    ? ".git/hooks is a link out of the repository"
    : empty
      ? "core.hooksPath is empty, which puts hooks at the top of the working tree"
    : allRepos
      ? "core.hooksPath comes from a configuration every repository reads, so a hook there would run for every repository"
      : climbs
        ? "core.hooksPath holds a `..` segment, which git can walk through a link out of the repository"
        : "core.hooksPath is outside the repository, so a hook there would run for every repository that inherits it";
  return { dir, label, inside, outside, inGitDir, workspaceDir: prefix.replace(/\/$/, "") || ".", top };
}

function outsideRefusal(place: HooksPlace): GitHooksRefusal {
  const line = usableDir(place.workspaceDir) ? `craftar sync --check --committed <sha> --workspace '${place.workspaceDir}'` : "craftar sync --check --committed <sha>";
  return new GitHooksRefusal(`${place.outside}: craftar writes nothing there. Add the line by hand: ${line}`);
}

type Found = { kind: "absent" } | { kind: "other" } | { kind: "marked"; workspace: string };

async function foundAt(file: string, name: string): Promise<Found> {
  let handle: fs.FileHandle | null = null;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) return { kind: "other" };
    handle = await fs.open(file, "r");
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(MARKER_BYTES), 0, MARKER_BYTES, 0);
    const marker = readHookMarker(buffer.subarray(0, bytesRead).toString("utf8"));
    return marker === null ? { kind: "other" } : { kind: "marked", workspace: marker.workspace };
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    throw new HooksUnreadable(`cannot read the ${name} hook (${String(code)})`);
  } finally {
    await handle?.close();
  }
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
  if (!place.inside) throw outsideRefusal(place);
  const { forge } = merged.config;
  // A workspace inside its Forge's repository still has its hooks in `.git`, which is no file of the Forge.
  if (!place.inGitDir && classifyForge(forge) === "path" && isUnderOrEqual(place.dir, await realpathOfNearest(path.resolve(root, forge))))
    throw new GitHooksRefusal("the hooks directory is inside the Forge: a Forge write has to be gated on git, and this is not one");
  // The file has to give the workspace back, or craftar could not recognise or remove the hook it wrote.
  if (!usableDir(place.workspaceDir)) throw new GitHooksRefusal("the workspace's path holds a quote or a control character, which a hook cannot name");
  if (readHookMarker(hookScript("pre-push", place.workspaceDir, { blockWhenUnavailable: false }))?.workspace !== place.workspaceDir) throw new GitHooksRefusal("the workspace's path looks like a credential or a token, which a hook would not read back");
  const stat = await fs.lstat(place.dir).catch((e: { code?: unknown }) => (e.code === "ENOTDIR" ? "blocked" : null));
  if (stat === "blocked" || (stat !== null && !stat.isDirectory())) throw new GitHooksRefusal("the hooks path exists and is not a directory, or a file stands in its way");

  const notes: string[] = [];
  // Step 5: `sync` writes there too, and a hook is no file of the lock.
  const held = new Set<string>();
  let forgeRead = true;
  try {
    const p = await plan(await loadForgeFor(root, merged, { mode: "no-fetch", home: opts.home }));
    for (const f of p.files) held.add(f.path.toLowerCase());
  } catch {
    forgeRead = false;
  }
  const lock = await readLock(root).catch(() => null);
  if (!forgeRead) notes.push(lock === null ? `neither the Forge nor ${LOCK_FILE} could be read: the hook's path was compared with nothing` : `the Forge could not be read: the hook's path was compared with ${LOCK_FILE} alone`);
  for (const e of lock?.files ?? []) held.add(e.path.toLowerCase());
  const realRoot = await realpathOfNearest(root);
  const backedUp: HookName[] = [];
  for (const name of names) {
    const file = path.join(place.dir, name);
    if (held.has(path.relative(realRoot, file).split(path.sep).join("/").toLowerCase())) throw new GitHooksRefusal(`${name}: craftar writes that path from the Forge, so a hook cannot live there`);
    const found = await foundAt(file, name);
    if (found.kind === "marked" && found.workspace !== place.workspaceDir) throw new GitHooksRefusal(`${name} is installed for workspace ${found.workspace} of this repository: one hook per repository (--force does not change that)`);
    if (found.kind === "other") {
      if (!opts.force) throw new GitHooksRefusal(`${name} exists and is not craftar's: pass --force to keep it as ${name}${BACKUP_SUFFIX}`);
      if (await fs.lstat(file + BACKUP_SUFFIX).then(() => true, () => false)) throw new GitHooksRefusal(`${name}${BACKUP_SUFFIX} already exists: move it first`);
      backedUp.push(name);
    }
  }
  if (!place.inGitDir) notes.push("the hooks directory is inside the repository's working tree: if it is tracked, this hook reaches everyone who clones it — review before committing");
  if (merged.fromLocalFile) notes.push("forge: comes from craftar.local.yaml, which a check over a commit does not read: name the Forge in craftar.yaml, or every push is refused");

  // Every new file exists before any hook moves: a failure then leaves the hooks where they were.
  const tmps = new Map<HookName, string>();
  const dropTmps = () => Promise.all([...tmps.values()].map((t) => fs.rm(t, { force: true })));
  try {
    await fs.mkdir(place.dir, { recursive: true });
    for (const name of names) {
      const tmp = `${path.join(place.dir, name)}.craftar-${process.pid}.tmp`;
      await fs.writeFile(tmp, hookScript(name, place.workspaceDir, { blockWhenUnavailable: opts.blockWhenUnavailable }), { flag: "wx", mode: 0o755 }).catch((e: { code?: unknown }) => {
        // `wx` lost to a file already there: that one is not ours to remove.
        if (e.code !== "EEXIST") tmps.set(name, tmp);
        throw e;
      });
      tmps.set(name, tmp);
      // `mode` above is subject to umask, and git does not run a hook it cannot execute.
      if (!WIN) await fs.chmod(tmp, 0o755);
    }
  } catch (e) {
    await dropTmps();
    throw new GitHooksRefusal(`cannot write the hook (${String((e as { code?: unknown }).code)}): nothing changed`);
  }
  const done: HookName[] = [];
  for (const name of names) {
    const file = path.join(place.dir, name);
    const moved = backedUp.includes(name);
    try {
      if (moved) await fs.rename(file, file + BACKUP_SUFFIX);
      await fs.rename(tmps.get(name)!, file);
      done.push(name);
    } catch (e) {
      if (moved) await fs.rename(file + BACKUP_SUFFIX, file).catch(() => {});
      await dropTmps();
      throw new GitHooksRefusal(`cannot write ${name} (${String((e as { code?: unknown }).code)}): ${done.length > 0 ? `${done.join(", ")} written${done.some((d) => backedUp.includes(d)) ? ", the old one kept as its .craftar-backup" : ""}, ` : ""}the existing ${name} is where it was`);
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
  if (!place.inside) throw outsideRefusal(place);
  const names = named.length > 0 ? named : HOOK_NAMES;
  const removing: HookName[] = [];
  const left: HookName[] = [];
  for (const name of names) {
    const found = await foundAt(path.join(place.dir, name), name);
    if (found.kind === "absent") continue;
    if (found.kind === "marked" && found.workspace === place.workspaceDir) removing.push(name);
    else if (named.length > 0) throw new GitHooksRefusal(`${name} is not this workspace's hook: nothing removed`);
    else left.push(name);
  }
  const backups: string[] = [];
  for (const [i, name] of removing.entries()) {
    await fs.rm(path.join(place.dir, name)).catch((e: { code?: unknown }) => {
      throw new GitHooksRefusal(`cannot remove ${name} (${String(e.code)})${i > 0 ? `: ${removing.slice(0, i).join(", ")} removed` : ""}`);
    });
    if (await fs.lstat(path.join(place.dir, name + BACKUP_SUFFIX)).then(() => true, () => false)) backups.push(name + BACKUP_SUFFIX);
  }
  return { removed: removing, left, backups };
}

export interface HooksStatus {
  hooksDir: HooksPlace["label"];
  hooks: Array<{ name: HookName; state: "installed" | "other" | "absent"; workspace: string | null }>;
}

/** `git-hooks status`, a tooling contract under `--json`; it reads, and names no path. */
export async function hooksStatus(root: string): Promise<HooksStatus & { workspaceDir: string; top: string }> {
  const place = await locateHooks(root);
  const hooks: HooksStatus["hooks"] = [];
  for (const name of HOOK_NAMES) {
    const found = await foundAt(path.join(place.dir, name), name);
    hooks.push(
      found.kind === "marked"
        ? { name, state: "installed", workspace: found.workspace }
        : { name, state: found.kind, workspace: null },
    );
  }
  return { hooksDir: place.label, hooks, workspaceDir: place.workspaceDir, top: place.top };
}

/**
 * What the hook's own rule would find, approximately: a relative entry ahead of an absolute one is not seen (spec 49 §6.5).
 * On win32 an npm global install leaves an extensionless shim, which `sh` finds and `onPath` would not start.
 */
export async function hookFindsCraftar(top: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!WIN) {
    const found = await onPath("craftar", env);
    return found !== null && !isUnderOrEqual(found, top);
  }
  // As the hook does: the first entry with a bare `craftar` is the answer, and under the repository it counts as none.
  for (const entry of lookupEntries(env)) {
    const stat = await fs.stat(path.join(entry, "craftar")).catch(() => null);
    if (stat?.isFile()) return !isUnderOrEqual(entry, top);
  }
  return false;
}
