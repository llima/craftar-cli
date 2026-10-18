import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cloneRepos, destinationFault, findGit, listRepos, planClone, type DestinationContext } from "../src/core/clone.js";
import type { RepoEntry } from "../src/core/repos.js";
import type { RunRequest } from "../src/core/proc.js";
import { tmpDir } from "./helpers/forge.js";

// Spec 37 §5.1 *Destination*, §5.2 and §10 — C5 in each of its forms, the listing's states, planClone's refusals
// (C3–C5, R1–R3), findGit, and cloneRepos with a recording runner. No test runs git: the runner is injected.

const WIN = process.platform === "win32";
const DIR_LINK = WIN ? "junction" : "dir";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function scratch(prefix = "craftar-clone-"): Promise<string> {
  const dir = await fs.realpath(await tmpDir(prefix));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const entry = (name: string, extra: Partial<RepoEntry> = {}): RepoEntry => ({ name, url: `https://git.example.com/acme/${name}.git`, path: name, ref: null, ...extra });
/** A workspace and a Forge beside it (not under it), the usual layout. */
async function layout(): Promise<{ root: string; forge: string; ctx: DestinationContext }> {
  const parent = await scratch();
  const root = path.join(parent, "ws");
  const forge = path.join(parent, "forge");
  await fs.mkdir(root);
  await fs.mkdir(forge);
  return { root, forge, ctx: { planned: [".claude/rules/a.md", "AGENTS.md", "docs/guide.md"], lockPaths: [], forgeDir: forge } };
}
async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(path.relative(dir, p) + (e.isDirectory() ? "/" : e.isSymbolicLink() ? "@" : ""));
      if (e.isDirectory()) await walk(p);
    }
  }
  await walk(dir);
  return out.sort();
}

describe("destinationFault — C5, in §5.1's order", () => {
  it("a destination that does not exist and passes every check: null; a parent that does not exist either", async () => {
    const { root, ctx } = await layout();
    expect(await destinationFault(root, entry("api"), ctx)).toBeNull();
    expect(await destinationFault(root, entry("web", { path: "apps/web" }), ctx)).toBeNull();
  });
  it("already exists — a file, an empty directory, a dangling link (lstat, before any resolution)", async () => {
    const { root, ctx } = await layout();
    await fs.writeFile(path.join(root, "api"), "x");
    await fs.mkdir(path.join(root, "web"));
    await fs.symlink(path.join(root, "nowhere"), path.join(root, "dang"), DIR_LINK);
    const before = await snapshot(root);
    for (const n of ["api", "web", "dang"])
      expect(await destinationFault(root, entry(n), ctx)).toBe(`${n} already exists in the workspace — move it, or leave the clone out`);
    expect(await snapshot(root)).toEqual(before);
  });
  it("a file sync writes — equal to a planned path, or holding one, in any letter case; and a path the lock records", async () => {
    const { root, ctx } = await layout();
    expect(await destinationFault(root, entry("agents", { path: "AGENTS.md" }), ctx)).toBe("AGENTS.md is a file sync writes");
    expect(await destinationFault(root, entry("docs"), ctx)).toBe("docs is a file sync writes");
    expect(await destinationFault(root, entry("d", { path: "Docs" }), ctx)).toBe("Docs is a file sync writes");
    expect(await destinationFault(root, entry("g", { path: "docs/guide.md" }), ctx)).toBe("docs/guide.md is a file sync writes");
    expect(await destinationFault(root, entry("old"), { ...ctx, lockPaths: ["old/readme.md"] })).toBe("old is a file sync writes");
    expect(await destinationFault(root, entry("doc"), ctx)).toBeNull();
  });
  it("inside the Forge — a Forge directory under the workspace", async () => {
    const { root, ctx } = await layout();
    const forge = path.join(root, "forge");
    await fs.mkdir(forge);
    expect(await destinationFault(root, entry("x", { path: "forge/x" }), { ...ctx, forgeDir: forge })).toBe("forge/x lies inside the Forge");
    expect(await destinationFault(root, entry("y"), { ...ctx, forgeDir: forge })).toBeNull();
  });
  it("inside the Forge — every destination of a workspace that lies inside its Forge", async () => {
    const forge = await scratch();
    const root = path.join(forge, "clients", "acme");
    await fs.mkdir(root, { recursive: true });
    const ctx = { planned: [], lockPaths: [], forgeDir: forge };
    expect(await destinationFault(root, entry("api"), ctx)).toBe("api lies inside the Forge");
  });
  it(`a parent that is a link out of the workspace (${DIR_LINK})`, async () => {
    const { root, ctx } = await layout();
    const out = await scratch();
    await fs.symlink(out, path.join(root, "apps"), DIR_LINK);
    const before = await snapshot(root);
    expect(await destinationFault(root, entry("web", { path: "apps/web" }), ctx)).toBe("apps/web leaves the workspace through a link");
    expect(await snapshot(root)).toEqual(before);
  });
  it(`a parent that is a link to a directory inside the workspace (${DIR_LINK}): allowed`, async () => {
    const { root, ctx } = await layout();
    await fs.mkdir(path.join(root, "real"));
    await fs.symlink(path.join(root, "real"), path.join(root, "apps"), DIR_LINK);
    expect(await destinationFault(root, entry("web", { path: "apps/web" }), ctx)).toBeNull();
  });
  it("a parent that is a regular file: not a directory, the ancestor as the profile spells it", async () => {
    const { root, ctx } = await layout();
    await fs.writeFile(path.join(root, "apps"), "x");
    expect(await destinationFault(root, entry("web", { path: "apps/web" }), ctx)).toBe("apps is not a directory");
    expect(await destinationFault(root, entry("w", { path: "apps/x/web" }), ctx)).toBe("apps is not a directory");
  });
  it.skipIf(WIN)("a parent that is a link to a file outside the workspace: leaves the workspace (containment first) — not run on Windows", async () => {
    const { root, ctx } = await layout();
    const out = await scratch();
    await fs.writeFile(path.join(out, "f"), "x");
    await fs.symlink(path.join(out, "f"), path.join(root, "apps"), "file");
    expect(await destinationFault(root, entry("web", { path: "apps/web" }), ctx)).toBe("apps/web leaves the workspace through a link");
  });
  it(`a parent that is a dangling link (${DIR_LINK}): realpathOfNearest's own message, naming the component`, async () => {
    const { root, ctx } = await layout();
    await fs.symlink(path.join(root, "gone"), path.join(root, "apps"), DIR_LINK);
    const m = await destinationFault(root, entry("web", { path: "apps/web" }), ctx);
    expect(m).toMatch(new RegExp(`^${path.join(root, "apps").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (exists but cannot be resolved|cannot be inspected) \\([A-Z]+\\)$`));
  });
  it("a workspace directory that does not exist yet: no false C5", async () => {
    const parent = await scratch();
    const forge = path.join(parent, "forge");
    await fs.mkdir(forge);
    const root = path.join(parent, "new", "ws");
    expect(await destinationFault(root, entry("api"), { planned: [], lockPaths: [], forgeDir: forge })).toBeNull();
    expect(await destinationFault(root, entry("web", { path: "apps/web" }), { planned: [], lockPaths: [], forgeDir: forge })).toBeNull();
  });
  it(`a workspace that does not exist yet under a link elsewhere (${DIR_LINK}): both sides resolve through it, no false C5`, async () => {
    const parent = await scratch();
    const elsewhere = await scratch();
    const forge = path.join(parent, "forge");
    await fs.mkdir(forge);
    await fs.symlink(elsewhere, path.join(parent, "via"), DIR_LINK);
    const root = path.join(parent, "via", "ws");
    expect(await destinationFault(root, entry("api"), { planned: [], lockPaths: [], forgeDir: forge })).toBeNull();
  });
});

describe("listRepos — present, missing, blocked", () => {
  it("each entry with its state, in order; blocked carries C5's reason; nothing written", async () => {
    const { root, ctx } = await layout();
    await fs.mkdir(path.join(root, "api"));
    const entries = [entry("api"), entry("web", { path: "apps/web", ref: "release" }), entry("docs")];
    const before = await snapshot(root);
    expect(await listRepos(root, entries, ctx)).toEqual([
      { ...entries[0], state: "present", reason: null },
      { ...entries[1], state: "missing", reason: null },
      { ...entries[2], state: "blocked", reason: "docs is a file sync writes" },
    ]);
    expect(await snapshot(root)).toEqual(before);
  });
  it("present wins over a file sync writes: a destination that holds sync's files reads present", async () => {
    const { root, ctx } = await layout();
    await fs.mkdir(path.join(root, "docs"));
    expect((await listRepos(root, [entry("docs")], ctx))[0]).toMatchObject({ state: "present", reason: null });
  });
});

describe("planClone — C3, C4, C5 and R1–R3, before anything", () => {
  const profile = (repos: unknown[]) => ({ name: "acme", repos }) as never;
  const repo = (name: string, extra: Record<string, unknown> = {}) => ({ name, url: `https://git.example.com/acme/${name}.git`, ...extra });
  const NO_ENTRIES = "nothing to clone; drop --clone";
  it("C3: no entry — the caller's wording", async () => {
    const { root, ctx } = await layout();
    await expect(planClone(root, profile([]), ctx, { present: "refuse", noEntries: NO_ENTRIES })).rejects.toThrow(
      /^profile acme lists no repositories — nothing to clone; drop --clone$/,
    );
    await expect(planClone(root, profile([]), ctx, { present: "skip", noEntries: "nothing to clone" })).rejects.toThrow(/^profile acme lists no repositories — nothing to clone$/);
  });
  it("C4: the block does not read — profileRepos' message", async () => {
    const { root, ctx } = await layout();
    await expect(planClone(root, profile([{ name: "a" }]), ctx, { present: "refuse", noEntries: NO_ENTRIES })).rejects.toThrow(/^profile acme: repos\[0\]: url is missing$/);
  });
  it("C5 (init, present: refuse): an existing destination, checked for every entry before anything", async () => {
    const { root, ctx } = await layout();
    await fs.mkdir(path.join(root, "web"));
    await expect(planClone(root, profile([repo("api"), repo("web")]), ctx, { present: "refuse", noEntries: NO_ENTRIES })).rejects.toThrow(
      /^cannot clone web: web already exists in the workspace — move it, or leave the clone out$/,
    );
  });
  it("init: every entry passes — the entries, in order, none skipped", async () => {
    const { root, ctx } = await layout();
    const r = await planClone(root, profile([repo("api"), repo("web", { path: "apps/web" })]), ctx, { present: "refuse", noEntries: NO_ENTRIES });
    expect(r.entries.map((e) => e.name)).toEqual(["api", "web"]);
    expect(r.skipped).toEqual([]);
  });
  it("repos clone (present: skip): a present entry is skipped, a missing one cloned", async () => {
    const { root, ctx } = await layout();
    await fs.mkdir(path.join(root, "api"));
    const r = await planClone(root, profile([repo("api"), repo("web")]), ctx, { present: "skip", noEntries: "nothing to clone" });
    expect(r.entries.map((e) => e.name)).toEqual(["web"]);
    expect(r.skipped.map((e) => e.name)).toEqual(["api"]);
  });
  it("repos clone: one blocked entry stops the run, named or not (C5)", async () => {
    const { root, ctx } = await layout();
    await expect(planClone(root, profile([repo("api"), repo("docs")]), ctx, { present: "skip", noEntries: "nothing to clone" })).rejects.toThrow(
      /^cannot clone docs: docs is a file sync writes$/,
    );
  });
  it("names: only those, in the profile's order; compared without case", async () => {
    const { root, ctx } = await layout();
    const r = await planClone(root, profile([repo("api"), repo("web"), repo("cli")]), ctx, { present: "skip", noEntries: "x", names: ["CLI", "api"] });
    expect(r.entries.map((e) => e.name)).toEqual(["api", "cli"]);
  });
  it("R1: a name that is not an entry — printed only when it is shaped like a repository name", async () => {
    const { root, ctx } = await layout();
    const p = profile([repo("api")]);
    await expect(planClone(root, p, ctx, { present: "skip", noEntries: "x", names: ["web"] })).rejects.toThrow(/^profile acme has no repository web$/);
    const MARK = "zq" + "mark";
    const e = await planClone(root, p, ctx, { present: "skip", noEntries: "x", names: [`$(${MARK})`] }).catch((x: Error) => x);
    expect((e as Error).message).toBe("profile acme: a name given is not a repository name");
  });
  it("R3: a name given twice, compared without case — after R1", async () => {
    const { root, ctx } = await layout();
    await expect(planClone(root, profile([repo("api")]), ctx, { present: "skip", noEntries: "x", names: ["api", "API"] })).rejects.toThrow(/^api is given twice$/);
    await expect(planClone(root, profile([repo("api")]), ctx, { present: "skip", noEntries: "x", names: ["nope", "nope"] })).rejects.toThrow(/^profile acme has no repository nope$/);
  });
  it("R2: a name given that is present — also under present: skip", async () => {
    const { root, ctx } = await layout();
    await fs.mkdir(path.join(root, "apps", "web"), { recursive: true });
    await expect(planClone(root, profile([repo("web", { path: "apps/web" })]), ctx, { present: "skip", noEntries: "x", names: ["web"] })).rejects.toThrow(
      /^web is present at apps\/web — nothing to clone$/,
    );
  });
});

describe("findGit — onPath, nothing else", () => {
  const EXE = WIN ? ".exe" : "";
  it("an absolute path from a PATH that holds one; null from an empty PATH and from a relative entry only", async () => {
    const dir = await scratch();
    const git = path.join(dir, "git" + EXE);
    await fs.copyFile(process.execPath, git);
    await fs.chmod(git, 0o755);
    expect(await findGit({ PATH: dir })).toBe(git);
    expect(await findGit({ PATH: "" })).toBeNull();
    expect(await findGit({ PATH: "relative-bin" })).toBeNull();
  });
  it("a git reachable only through a relative PATH entry is not found, though the file is there", async () => {
    // Under the checkout's node_modules/.cache (ignored by git): on the current directory's drive, so a relative
    // spelling exists on win32 too — a temp dir may sit on another drive, where path.relative gives an absolute path.
    const dir = path.join(process.cwd(), "node_modules", ".cache", `craftar-findgit-${process.pid}-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.copyFile(process.execPath, path.join(dir, "git" + EXE));
    await fs.chmod(path.join(dir, "git" + EXE), 0o755);
    const rel = path.relative(process.cwd(), dir);
    expect(path.isAbsolute(rel)).toBe(false);
    expect(await findGit({ PATH: rel })).toBeNull();
    expect(await findGit({ PATH: dir })).toBe(path.join(dir, "git" + EXE));
  });
});

describe("cloneRepos — one runner call per entry, in order, sequential", () => {
  const GIT = WIN ? "C:\\Program Files\\Git\\cmd\\git.exe" : "/usr/bin/git";
  function recorder(codes: Array<number | null | "reject">, onCall?: (req: RunRequest) => Promise<void>) {
    const calls: RunRequest[] = [];
    let running = 0;
    let overlapped = false;
    const run = async (req: RunRequest) => {
      if (running > 0) overlapped = true;
      running++;
      calls.push(req);
      await new Promise((r) => setTimeout(r, 5));
      if (onCall) await onCall(req);
      running--;
      const c = codes[calls.length - 1];
      if (c === "reject") throw Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
      return { code: c === undefined ? 0 : c };
    };
    return { run, calls, overlapped: () => overlapped };
  }
  it("program, arguments, working directory and environment; GIT_TERMINAL_PROMPT=0 only off a terminal", async () => {
    const { root } = await layout();
    const entries = [entry("api"), entry("web", { path: "apps/web", ref: "release" })];
    for (const stdinIsTty of [false, true]) {
      const r = recorder([0, 0]);
      const out = await cloneRepos(root, entries, { git: GIT, env: { MARKER_VAR: "kept", PATH: "/usr/bin" }, stdinIsTty }, r.run);
      expect(out.map((o) => o.outcome)).toEqual(["cloned", "cloned"]);
      expect(r.overlapped()).toBe(false);
      expect(r.calls.map((c) => [c.file, c.cwd, c.stdin])).toEqual([
        [GIT, root, "inherit"],
        [GIT, root, "inherit"],
      ]);
      expect(r.calls[0].args).toEqual(["clone", "--no-recurse-submodules", "--", entries[0].url, "api"]);
      expect(r.calls[1].args).toEqual(["clone", "--no-recurse-submodules", "--branch=release", "--", entries[1].url, "apps/web"]);
      for (const c of r.calls) {
        expect(c.env.MARKER_VAR).toBe("kept");
        expect(c.env.GIT_ALLOW_PROTOCOL).toBe("https:ssh");
        expect(c.env.GIT_TERMINAL_PROMPT).toBe(stdinIsTty ? undefined : "0");
      }
    }
  });
  it("git's repository-local variables inherited from the caller are not handed to git (git rev-parse --local-env-vars) — they would move the checkout or its parts out of the checked destination (review rounds 1–2)", async () => {
    const { root } = await layout();
    const LOCAL = ["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR"];
    const env: NodeJS.ProcessEnv = { MARKER_VAR: "kept", GIT_SSH_COMMAND: "ssh -i key", GIT_ASKPASS: "/bin/askpass" };
    for (const k of LOCAL) env[k] = "/elsewhere";
    const r = recorder([0]);
    await cloneRepos(root, [entry("api")], { git: GIT, env, stdinIsTty: true }, r.run);
    for (const k of LOCAL) expect(r.calls[0].env[k], k).toBeUndefined();
    expect(r.calls[0].env.MARKER_VAR).toBe("kept");
    expect(r.calls[0].env.GIT_SSH_COMMAND).toBe("ssh -i key");
    expect(r.calls[0].env.GIT_ASKPASS).toBe("/bin/askpass");
  });
  it("an inherited GIT_ALLOW_PROTOCOL never widens the transports: git always gets https:ssh (review round 3 blocker)", async () => {
    const { root } = await layout();
    for (const stdinIsTty of [false, true]) {
      const r = recorder([0]);
      await cloneRepos(root, [entry("api")], { git: GIT, env: { GIT_ALLOW_PROTOCOL: "ext:file:https:ssh", MARKER_VAR: "kept" }, stdinIsTty }, r.run);
      expect(r.calls[0].env.GIT_ALLOW_PROTOCOL).toBe("https:ssh");
      expect(r.calls[0].env.MARKER_VAR).toBe("kept");
    }
  });
  it.runIf(WIN)("on win32 an inherited git_allow_protocol in another case does not reach git beside craftar's", async () => {
    const { root } = await layout();
    const r = recorder([0]);
    await cloneRepos(root, [entry("api")], { git: GIT, env: { git_allow_protocol: "ext:file" }, stdinIsTty: true }, r.run);
    expect(Object.entries(r.calls[0].env).filter(([k]) => k.toUpperCase() === "GIT_ALLOW_PROTOCOL")).toEqual([["GIT_ALLOW_PROTOCOL", "https:ssh"]]);
  });
  it.runIf(WIN)("on win32 a repository-local variable is dropped whatever its case (Git_Dir)", async () => {
    const { root } = await layout();
    const r = recorder([0]);
    await cloneRepos(root, [entry("api")], { git: GIT, env: { Git_Dir: "C:\\elsewhere\\.git" }, stdinIsTty: true }, r.run);
    expect(Object.keys(r.calls[0].env).filter((k) => k.toUpperCase() === "GIT_DIR")).toEqual([]);
  });
  it("a failure in the middle: cloned, failed (git exited 128), cloned — the next entry still tried", async () => {
    const { root } = await layout();
    const r = recorder([0, 128, 0]);
    const out = await cloneRepos(root, [entry("a"), entry("b"), entry("c")], { git: GIT, env: {}, stdinIsTty: false }, r.run);
    expect(out.map((o) => [o.entry.name, o.outcome, o.outcome === "failed" ? o.reason : null])).toEqual([
      ["a", "cloned", null],
      ["b", "failed", "git exited 128"],
      ["c", "cloned", null],
    ]);
  });
  it("a signal (no exit code) and a runner that rejects: failed, worded, the next entry still tried", async () => {
    const { root } = await layout();
    const r = recorder([null, "reject", 0]);
    const out = await cloneRepos(root, [entry("a"), entry("b"), entry("c")], { git: GIT, env: {}, stdinIsTty: false }, r.run);
    expect(out.map((o) => (o.outcome === "failed" ? o.reason : o.outcome))).toEqual(["git was ended by a signal", "git could not be started", "cloned"]);
  });
  it("a destination created between the plan and the clone, and a parent replaced by a link out: failed, no runner call", async () => {
    const { root } = await layout();
    const out = await scratch();
    const r = recorder([0, 0, 0], async (req) => {
      if (req.args.at(-1) === "first") {
        await fs.mkdir(path.join(root, "second"));
        await fs.symlink(out, path.join(root, "apps"), DIR_LINK);
      }
    });
    const res = await cloneRepos(root, [entry("first"), entry("second"), entry("third", { path: "apps/third" })], { git: GIT, env: {}, stdinIsTty: false }, r.run);
    expect(res.map((o) => (o.outcome === "failed" ? o.reason : o.outcome))).toEqual(["cloned", "already exists", "leaves the workspace through a link"]);
    expect(r.calls.length).toBe(1);
  });
});
