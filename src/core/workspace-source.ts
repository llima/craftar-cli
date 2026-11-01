/**
 * Where a check reads the workspace's files (spec 49 §5.2): the disk, a commit, or the index. `sync --check --committed`
 * and `--index` hand `plan()`, `readLock()` and `status()` a git source, so what they compare is what git holds.
 * Nothing here writes, and `apply()` refuses a source that is not the disk.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { gitIsRepo, gitRead } from "./forge.js";
import { execProgram, openProgram, streamProgram, type OpenedProgram } from "./proc.js";
import { findSecrets } from "./secrets.js";
import { climbsOut } from "./text.js";

export interface WorkspaceSource {
  kind: "disk" | "git";
  /** The file's bytes, or null when it is absent or not a regular file. */
  read(rel: string): Promise<Buffer | null>;
  /** Whether anything is at the path, a directory included (as an `lstat` answers). */
  exists(rel: string): Promise<boolean>;
  close(): Promise<void>;
}

export function diskSource(root: string): WorkspaceSource {
  return {
    kind: "disk",
    async read(rel) {
      try {
        return await fs.readFile(path.join(root, rel));
      } catch {
        return null;
      }
    },
    exists: (rel) => fs.lstat(path.join(root, rel)).then(() => true, () => false),
    close: async () => {},
  };
}

export type GitSourceSpec = { rev: string } | { index: true };

/** A refusal of the check itself, before any Forge load (spec 49 §5.1). */
export class GitSourceRefusal extends Error {}

/** A revision that exists and is not a commit: `--unavailable-ok` passes it (spec 49 §5.4). */
export class NotACommitError extends GitSourceRefusal {
  constructor(readonly commit: string) {
    super(`${commit} is not a commit`);
  }
}

export interface GitSource extends WorkspaceSource {
  kind: "git";
  /** What the closing line and the `no craftar.yaml` line call it. */
  label: { name: "commit"; short: string } | { name: "index" };
}

// The value reaches a terminal and a CI log: as `shownName`, only what is shaped like what it claims to be is printed.
const shownRevision = (rev: string) => (/^[\w./@^~+][\w./@^~+-]{0,199}$/.test(rev) && findSecrets(rev).length === 0 ? rev : "(not shown)");

/** A git version as numbers; [0, 0] when it cannot be read, so every version-gated flag is left out. */
async function gitVersion(): Promise<[number, number]> {
  const { stdout } = await execProgram("git", ["--version"]);
  const m = /(\d+)\.(\d+)/.exec(stdout);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

const atLeast = (v: [number, number], major: number, minor: number) => v[0] > major || (v[0] === major && v[1] >= minor);

async function nearestDirectory(dir: string): Promise<string> {
  for (let d = dir; ; d = path.dirname(d)) {
    const stat = await fs.stat(d).catch(() => null);
    if (stat?.isDirectory()) return d;
    if (path.dirname(d) === d) return d;
  }
}

/**
 * The commit or the index as a source. Every git call runs under `gitRead`, so no `core.fsmonitor` or hook is started,
 * and reads objects, so no filter or textconv either. The location variables are gone except, here alone,
 * `GIT_INDEX_FILE`: a `pre-commit` of a partial commit has its own index (spec 49 §5.5).
 */
export async function gitSource(root: string, spec: GitSourceSpec): Promise<GitSource> {
  // The workspace need not exist on disk: a branch without its directory is still a commit to read.
  const start = await nearestDirectory(root);
  if (!(await gitIsRepo(start))) throw new GitSourceRefusal("--committed and --index need a workspace in a git repository with a work tree (git not found counts)");
  const version = await gitVersion();
  // --no-lazy-fetch needs git 2.45: without it, a partial clone's missing blob would be fetched.
  const lazy = atLeast(version, 2, 45) ? ["--no-lazy-fetch"] : [];
  const base = [...lazy, ...gitRead(start)];
  const { stdout: prefixOut } = await execProgram("git", [...base, "rev-parse", "--show-prefix"]);
  // Only the line ending: a directory can start with a space, and a wrong prefix reads as `no craftar.yaml`.
  const atStart = prefixOut.replace(/\r?\n$/, "");
  const rest = path.relative(start, root).split(path.sep).join("/");
  const prefix = rest === "" ? atStart : `${atStart}${rest}/`;

  const entries = new Map<string, { mode: string; oid: string }>();
  let label: GitSource["label"];
  if ("rev" in spec) {
    const commit = await resolveCommit(base, spec.rev, atLeast(version, 2, 30));
    label = { name: "commit", short: commit.slice(0, 8) };
    const listed = await streamProgram("git", [...base, "ls-tree", "-r", "-z", "--full-tree", commit], { input: "" });
    if (listed.code !== 0) throw new GitSourceRefusal(`cannot read commit ${label.short}`);
    for (const row of listed.stdout.split("\0")) {
      const m = /^(\d+) \w+ ([0-9a-f]+)\t(.*)$/s.exec(row);
      if (m && m[3].startsWith(prefix)) entries.set(m[3], { mode: m[1], oid: m[2] });
    }
  } else {
    label = { name: "index" };
    const listed = await streamProgram("git", [...base, "ls-files", "-s", "-z", "--full-name"], { input: "", keepIndexFile: true });
    if (listed.code !== 0) throw new GitSourceRefusal("cannot read the index");
    for (const row of listed.stdout.split("\0")) {
      const m = /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s.exec(row);
      if (!m || !m[4].startsWith(prefix)) continue;
      if (m[3] !== "0") throw new GitSourceRefusal("the index holds a merge conflict");
      entries.set(m[4], { mode: m[1], oid: m[2] });
    }
  }

  // Git answers `missing` for `sub/./x`, and such a spelling keeps its output path; a lock path with a line feed must
  // not shift the batch. So a path is looked up in the listing and asked for by the id it gave, never by itself.
  const full = (rel: string) => path.posix.normalize(`${prefix}${rel}`).replace(/^\/+/, "");
  const batch = new CatFile([...base, "cat-file", "--batch"], "rev" in spec ? {} : { keepIndexFile: true });
  return {
    kind: "git",
    label,
    async read(rel) {
      if (climbsOut(rel)) return null;
      const entry = entries.get(full(rel));
      // A symbolic link's blob holds its target and a gitlink has no blob: craftar writes neither.
      if (!entry || entry.mode === "120000" || entry.mode === "160000") return null;
      return batch.read(entry.oid);
    },
    async exists(rel) {
      if (climbsOut(rel)) return false;
      const key = full(rel).replace(/\/+$/, "");
      if (entries.has(key)) return true;
      for (const k of entries.keys()) if (k.startsWith(`${key}/`)) return true;
      return false;
    },
    close: () => batch.close(),
  };
}

async function resolveCommit(base: string[], rev: string, endOfOptions: boolean): Promise<string> {
  const shown = shownRevision(rev);
  if (rev.startsWith("-")) throw new GitSourceRefusal(`unknown revision ${shown}`);
  const verify = async (spelled: string): Promise<string | null> => {
    try {
      const args = [...base, "rev-parse", "--verify", "-q", ...(endOfOptions ? ["--end-of-options"] : []), spelled];
      return (await execProgram("git", args)).stdout.trim() || null;
    } catch {
      return null;
    }
  };
  const exists = await verify(rev);
  if (exists === null) throw new GitSourceRefusal(`unknown revision ${shown}`);
  const commit = await verify(`${rev}^{commit}`);
  if (commit === null) throw new NotACommitError(exists.slice(0, 8));
  return commit;
}

/** One `cat-file --batch` child, opened on the first read, answering one request at a time. */
class CatFile {
  private child: OpenedProgram | null = null;
  private held = Buffer.alloc(0);
  private wake: (() => void) | null = null;
  private ended = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly args: string[],
    private readonly opts: { keepIndexFile?: boolean },
  ) {}

  read(oid: string): Promise<Buffer> {
    const answer = this.queue.then(() => this.ask(oid));
    this.queue = answer.catch(() => {});
    return answer;
  }

  private async ask(oid: string): Promise<Buffer> {
    if (this.child === null) {
      this.child = await openProgram("git", this.args, this.opts);
      this.child.stdout.on("data", (d: Buffer) => {
        this.held = Buffer.concat([this.held, d]);
        this.wake?.();
      });
      this.child.stdout.on("end", () => {
        this.ended = true;
        this.wake?.();
      });
    }
    this.child.stdin.write(`${oid}\n`);
    const header = (await this.take((b) => (b.indexOf(0x0a) < 0 ? null : b.indexOf(0x0a) + 1))).toString("utf8").trim();
    const m = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    // A partial clone's blob reads `missing`: a failure, not a file that is `new` (spec 49 §7).
    if (!m) throw new GitSourceRefusal(`cannot read object ${oid.slice(0, 8)} from git`);
    const size = Number(m[1]);
    const body = await this.take((b) => (b.length >= size + 1 ? size + 1 : null));
    return body.subarray(0, size);
  }

  private async take(need: (held: Buffer) => number | null): Promise<Buffer> {
    for (;;) {
      const n = need(this.held);
      if (n !== null) {
        const out = this.held.subarray(0, n);
        this.held = this.held.subarray(n);
        return out;
      }
      if (this.ended) throw new GitSourceRefusal("git stopped answering");
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }

  async close(): Promise<void> {
    await this.child?.close();
  }
}
