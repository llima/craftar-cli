/**
 * Spec 49 Part A: `sync` and `doctor` say when git ignores a file craftar generates.
 * The real `git` runs here, on repositories in temporary directories; nothing leaves the machine.
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runDoctor, workspaceReport } from "../src/core/doctor.js";
import { ignoredPaths, shownRule } from "../src/core/forge.js";
import { streamProgram } from "../src/core/proc.js";
import { generatedIgnored } from "../src/core/generated-ignored.js";
import { loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { syncToolResult, syncWorkspace } from "../src/core/write-actions.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, scenario, tmpDir, writeFiles } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// A rule in the developer's own git configuration must not reach these tests: `.claude/` ignored globally is plausible.
// Nor a run from inside a git hook: under its GIT_DIR, this file's `git config` would write into the developer's repository.
const CLEARED = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_PREFIX",
  "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE",
  "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
];
const SAVED = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "XDG_CONFIG_HOME", "GIT_CEILING_DIRECTORIES", ...CLEARED].map((k) => [k, process.env[k]] as const);
let hermetic: string;
beforeAll(async () => {
  hermetic = await tmpDir();
  await writeFiles(hermetic, { gitconfig: "" });
  process.env.GIT_CONFIG_GLOBAL = path.join(hermetic, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.XDG_CONFIG_HOME = hermetic;
  // A TMPDIR inside a repository must not make "not in a repository" false.
  process.env.GIT_CEILING_DIRECTORIES = await fs.realpath(os.tmpdir());
  for (const k of CLEARED) delete process.env[k];
});
afterAll(async () => {
  for (const [k, v] of SAVED) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await removeWithRetry(hermetic);
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const RULE_FILE = ".claude/rules/a.md";

/** A workspace of one rule, a git repository unless `repo` is false. */
async function ws(opts: { repo?: boolean; config?: Record<string, unknown>; local?: Record<string, unknown> } = {}) {
  const s = await scenario(
    { ingredients: [rule("a", "body\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] },
    { config: { profile: "acme", ...opts.config }, local: opts.local },
  );
  cleanups.push(() => removeWithRetry(s.root));
  if (opts.repo !== false) git(s.wsRoot, "init", "-q");
  return s.wsRoot;
}

const repo = async () => {
  const dir = await tmpDir();
  cleanups.push(() => removeWithRetry(dir));
  git(dir, "init", "-q");
  return dir;
};

describe("shownRule", () => {
  it("shows a source in the tree as written", () => {
    expect(shownRule(".gitignore", "1", ".claude/", null)).toBe(".gitignore:1 .claude/");
    expect(shownRule("sub/.gitignore", "3", "x", null)).toBe("sub/.gitignore:3 x");
  });
  it("shows the common directory's exclude file as .git/info/exclude", () => {
    expect(shownRule("/r/.git/info/exclude", "7", ".claude/", "/r/.git")).toBe(".git/info/exclude:7 .claude/");
  });
  it("never prints another absolute path", () => {
    const text = shownRule("/home/someone/.gitignore_global", "12", "zzz/", "/r/.git");
    expect(text).toBe("core.excludesFile:12 zzz/");
    // An exclude file of another repository is not this one's.
    expect(shownRule("/other/.git/info/exclude", "2", "x", "/r/.git")).toBe("core.excludesFile:2 x");
  });
  it("removes control characters from the pattern", () => {
    expect(shownRule(".gitignore", "1", "a\u001b[31mb\u0085c\u0007", null)).toBe(".gitignore:1 a[31mbc");
  });
  it("removes a bidirectional override from the pattern", () => {
    expect(shownRule(".gitignore", "1", "a\u202eb\u2066c", null)).toBe(".gitignore:1 abc");
  });
  it("never prints a relative source that climbs out of the tree", () => {
    expect(shownRule("../secret/.gitignore", "1", "x", null)).toBe("core.excludesFile:1 x");
    expect(shownRule("a/../../.gitignore", "1", "x", null)).toBe("core.excludesFile:1 x");
  });
  it("leaves out a pattern that holds a token of a known format", () => {
    const token = "ghp_" + "x".repeat(36);
    const text = shownRule(".gitignore", "4", token, null);
    expect(text).toBe(".gitignore:4");
    expect(text).not.toContain(token);
  });
});

describe("streamProgram", () => {
  it("writes stdin and resolves with the code and stdout of a failing program", async () => {
    const r = await streamProgram(
      process.execPath,
      ["-e", "process.stdin.on('data',d=>process.stdout.write(d));process.stdin.on('end',()=>{process.exitCode=3})"],
      { input: "hello" },
    );
    expect(r).toMatchObject({ code: 3, stdout: "hello" });
  });
  it("rejects with ENOENT for a program on no absolute PATH entry", async () => {
    await expect(streamProgram("craftar-no-such-program", [], { input: "", env: { PATH: "" } })).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("ignoredPaths", () => {
  it("reports a rule in .gitignore, in .git/info/exclude and in core.excludesFile", async () => {
    const dir = await repo();
    await writeFiles(dir, { ".gitignore": "a/\n" });
    await fs.appendFile(path.join(dir, ".git/info/exclude"), "b/\n");
    const global = await tmpDir();
    cleanups.push(() => removeWithRetry(global));
    await writeFiles(global, { ignore: "c/\n" });
    git(dir, "config", "core.excludesFile", path.join(global, "ignore"));
    const r = await ignoredPaths(dir, ["a/f", "b/f", "c/f", "d/f"]);
    expect(r.unchecked).toBe(false);
    expect(r.ignored.map((i) => i.path)).toEqual(["a/f", "b/f", "c/f"]);
    expect(r.ignored[0].rule).toBe(".gitignore:1 a/");
    expect(r.ignored[1].rule).toMatch(/^\.git\/info\/exclude:\d+ b\/$/);
    expect(r.ignored[2].rule).toBe("core.excludesFile:1 c/");
    expect(JSON.stringify(r)).not.toContain(global);
  });
  it("does not report a negated rule or a tracked file, though git lists the first with exit 0", async () => {
    const dir = await repo();
    await writeFiles(dir, { ".gitignore": "keep/*\n!keep/b\ntracked\n", tracked: "x\n" });
    git(dir, "add", "-f", "tracked");
    const r = await ignoredPaths(dir, ["keep/b", "tracked"]);
    expect(r).toEqual({ ignored: [], unchecked: false });
    expect((await ignoredPaths(dir, ["keep/a"])).ignored.map((i) => i.path)).toEqual(["keep/a"]);
  });
  it("shows the exclude file of a linked worktree as .git/info/exclude", async () => {
    const dir = await repo();
    await writeFiles(dir, { f: "x\n" });
    git(dir, "add", "f");
    git(dir, "commit", "-qm", "i");
    await fs.appendFile(path.join(dir, ".git/info/exclude"), ".claude/\n");
    const wt = await tmpDir();
    cleanups.push(() => removeWithRetry(wt));
    const tree = path.join(wt, "t");
    git(dir, "worktree", "add", "-q", tree);
    const r = await ignoredPaths(tree, [".claude/x"]);
    expect(r.ignored[0].rule).toMatch(/^\.git\/info\/exclude:\d+ \.claude\/$/);
  });
  it("answers for a path spelled ./x, /x or a/../x, and names it as spelled", async () => {
    const dir = await repo();
    await writeFiles(dir, { ".gitignore": "x\n" });
    const r = await ignoredPaths(dir, ["./x", "/x", "a/../x"]);
    expect(r.unchecked).toBe(false);
    expect(r.ignored.map((i) => i.path).sort()).toEqual(["./x", "/x", "a/../x"].sort());
  });
  it("is empty and not unchecked off a repository, and with git not found", async () => {
    const dir = await tmpDir();
    cleanups.push(() => removeWithRetry(dir));
    expect(await ignoredPaths(dir, ["x"])).toEqual({ ignored: [], unchecked: false });
    // In a repository, so that git not being found is what answers.
    expect(await ignoredPaths(await repo(), ["x"], { PATH: "" })).toEqual({ ignored: [], unchecked: false });
  });
  it.skipIf(process.platform === "win32")("keeps the paths before a symbolic link and says unchecked", async () => {
    const dir = await repo();
    await writeFiles(dir, { ".gitignore": "a\n", "real/f": "x\n" });
    await fs.symlink("real", path.join(dir, "lnk"));
    const r = await ignoredPaths(dir, ["a", "lnk/f", "z"]);
    expect(r.unchecked).toBe(true);
    expect(r.ignored.map((i) => i.path)).toEqual(["a"]);
  });
  // Linux proves the guard: on win32 git cannot start this script, so the test would pass with nothing proved.
  it.skipIf(process.platform === "win32")("does not start a core.fsmonitor", async () => {
    const dir = await repo();
    const record = path.join(dir, "fsmonitor-ran");
    const hook = path.join(dir, "fsm.js");
    await fs.writeFile(hook, `require("node:fs").writeFileSync(${JSON.stringify(record)}, "x")\n`);
    const script = path.join(dir, "fsm.sh");
    await fs.writeFile(script, `#!/bin/sh\n"${process.execPath}" "${hook}"\nexit 1\n`, { mode: 0o755 });
    git(dir, "config", "core.fsmonitor", script);
    await writeFiles(dir, { ".gitignore": "a\n" });
    await ignoredPaths(dir, ["a"]);
    await expect(fs.access(record)).rejects.toThrow();
  });
});

describe("generatedIgnored", () => {
  const gi = async (root: string) => {
    const w = await loadWorkspace(root);
    return generatedIgnored(w, await plan(w));
  };
  it("names a generated path and craftar.lock", async () => {
    const root = await ws();
    await writeFiles(root, { ".gitignore": ".claude/\ncraftar.lock\n" });
    const r = await gi(root);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toBe(`${RULE_FILE} is generated, but git ignores it (.gitignore:1 .claude/) — it will not reach a commit; fix the rule or git add -f`);
    expect(r.lines[1]).toContain("craftar.lock is generated, but git ignores it (.gitignore:2 craftar.lock)");
  });
  it("is silent for a path mayBeIgnored lists, and names an entry that generates nothing", async () => {
    const root = await ws({ config: { mayBeIgnored: [RULE_FILE, "nope.md"] } });
    await writeFiles(root, { ".gitignore": ".claude/\n" });
    const r = await gi(root);
    expect(r.lines).toEqual([]);
    expect(r.stale).toEqual(["nope.md"]);
  });
  it("is silent when forge: comes from craftar.local.yaml", async () => {
    const root = await ws({ local: { forge: "../forge" } });
    await writeFiles(root, { ".gitignore": ".claude/\n" });
    const r = await gi(root);
    expect(r).toMatchObject({ lines: [], unchecked: false, inRepo: true, silenced: true });
  });
  it("reads the rules of a workspace in a subdirectory of the repository", async () => {
    const dir = await repo();
    const s = await scenario(
      { ingredients: [rule("a", "body\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] },
      { config: { profile: "acme" } },
    );
    cleanups.push(() => removeWithRetry(s.root));
    const inner = path.join(dir, "acme", "harness");
    await fs.mkdir(path.dirname(inner), { recursive: true });
    await fs.cp(s.wsRoot, inner, { recursive: true });
    const forge = path.relative(inner, s.forgeRoot).replace(/\\/g, "/");
    await writeFiles(inner, { "craftar.yaml": `forge: ${forge}\nprofile: acme\n`, ".gitignore": "craftar.lock\n" });
    await writeFiles(dir, { ".gitignore": ".claude/\n" });
    const r = await gi(inner);
    expect(r.lines[0]).toContain(`${RULE_FILE} is generated, but git ignores it (.gitignore:1 .claude/)`);
    expect(r.lines[1]).toContain("craftar.lock is generated, but git ignores it (acme/harness/.gitignore:1 craftar.lock)");
  });
  it("names an odd mayBeIgnored entry by its position, never its text", async () => {
    const token = "ghp_" + "x".repeat(36);
    const root = await ws({ config: { mayBeIgnored: [RULE_FILE, token, "a\u001b[31mb", "fine/path.md"] } });
    const r = await gi(root);
    expect(r.stale).toEqual(["#2", "#3", "fine/path.md"]);
    expect(JSON.stringify(r)).not.toContain(token);
  });
  it("says it is not in a repository", async () => {
    expect(await gi(await ws({ repo: false }))).toMatchObject({ lines: [], inRepo: false });
  });
});

describe("the surfaces", () => {
  const LINE = `${RULE_FILE} is generated, but git ignores it (.gitignore:1 .claude/)`;
  const ignoredWs = async () => {
    const root = await ws();
    await writeFiles(root, { ".gitignore": ".claude/\n" });
    return root;
  };

  it("sync writes the file and warns; --dry-run warns too", async () => {
    const root = await ignoredWs();
    const dry = runCli(["sync", "--dry-run", "--workspace", root]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain(`warn ${LINE}`);
    const r = runCli(["sync", "--workspace", root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`warn ${LINE}`);
    await expect(fs.access(path.join(root, RULE_FILE))).resolves.toBeUndefined();
  });
  it("sync --check warns and keeps its exit code", async () => {
    const root = await ignoredWs();
    runCli(["sync", "--workspace", root]);
    const r = runCli(["sync", "--check", "--workspace", root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`warn ${LINE}`);
    expect(r.stdout).toContain("workspace in sync");
  });
  it("sync writes neither an ignore file nor anything else about the rule", async () => {
    const root = await ignoredWs();
    runCli(["sync", "--workspace", root]);
    expect(await fs.readFile(path.join(root, ".gitignore"), "utf8")).toBe(".claude/\n");
  });
  it("status and diff say nothing of it", async () => {
    const root = await ignoredWs();
    runCli(["sync", "--workspace", root]);
    expect(runCli(["status", "--workspace", root]).stdout).not.toContain("git ignores it");
    expect(runCli(["diff", "--workspace", root]).stdout).not.toContain("git ignores it");
  });
  it("the sync result the MCP tool and the page answer with carries the line in warnings, with no new key", async () => {
    const root = await ignoredWs();
    const w = await loadWorkspace(root);
    const p = await plan(w);
    const lock = await readLock(root);
    const st = await status(w, p, lock);
    const outcome = await syncWorkspace(w, p, st, lock, { home: await tmpHome(), registryOff: true });
    const result = syncToolResult(w, p, st, outcome, true);
    expect(result.warnings.some((x) => x.startsWith(LINE))).toBe(true);
    expect(Object.keys(result)).toEqual(["profile", "recipes", "targets", "forge", "written", "removed", "skipped", "warnings", "registry"]);
  });
  it("doctor warns with the fix, and doctor --strict exits 1", async () => {
    const root = await ignoredWs();
    const r = runCli(["doctor", "--workspace", root, "--json"]);
    const checks = JSON.parse(r.stdout).checks.filter((c: { id: string }) => c.id === "generated-ignored");
    const line = checks.find((c: { message: string }) => c.message.startsWith(LINE));
    expect(line).toMatchObject({ scope: "workspace", level: "warn" });
    expect(line.fix).toBe("fix the rule, or git add -f, or list the path under mayBeIgnored in craftar.yaml");
    expect(runCli(["doctor", "--strict", "--workspace", root]).code).toBe(1);
  });
  it("doctor has one ok line when nothing is ignored, and no line off a repository", async () => {
    const checks = async (root: string) =>
      (await runDoctor({ version: "t", workspace: root, fetch: false, strict: false, home: await tmpHome(), registryOff: true, gitVersion: async () => "t", dotnetVersion: async () => null }))
        .checks.filter((c) => c.id === "generated-ignored");
    const inRepo = await checks(await ws());
    expect(inRepo.map((c) => c.level)).toEqual(["ok"]);
    expect(await checks(await ws({ repo: false }))).toEqual([]);
  });
  it("doctor warns for a mayBeIgnored entry that generates nothing, and not over what mayBeIgnored lists", async () => {
    const root = await ws({ config: { mayBeIgnored: [RULE_FILE, "nope.md"] } });
    await writeFiles(root, { ".gitignore": ".claude/\n" });
    const checks = JSON.parse(runCli(["doctor", "--workspace", root, "--json"]).stdout).checks.filter((c: { id: string }) => c.id === "generated-ignored");
    expect(checks).toHaveLength(1);
    expect(checks[0].level).toBe("warn");
    expect(checks[0].message).toBe("mayBeIgnored names a path craftar does not generate: nope.md");
  });
  it.skipIf(process.platform === "win32")("doctor warns when a generated folder is a symbolic link, so --strict exits 1", async () => {
    const root = await ws();
    await fs.mkdir(path.join(root, "real"));
    await fs.symlink("real", path.join(root, ".claude"));
    const r = runCli(["doctor", "--strict", "--workspace", root, "--json"]);
    const checks = JSON.parse(r.stdout).checks.filter((c: { id: string }) => c.id === "generated-ignored");
    expect(checks.map((c: { message: string }) => c.message)).toContain("some generated paths could not be checked against git's ignore rules");
    expect(r.code).toBe(1);
  });
  it("doctor --strict exits 0 once the ignored path is listed under mayBeIgnored", async () => {
    const root = await ws({ config: { mayBeIgnored: [RULE_FILE, "craftar.lock"] } });
    await writeFiles(root, { ".gitignore": ".claude/\ncraftar.lock\n" });
    const line = JSON.parse(runCli(["doctor", "--workspace", root, "--json"]).stdout).checks.filter((c: { id: string }) => c.id === "generated-ignored");
    expect(line.map((c: { level: string }) => c.level)).toEqual(["ok"]);
    runCli(["sync", "--workspace", root]);
    expect(runCli(["doctor", "--strict", "--workspace", root]).stdout).not.toContain("git ignores it");
  });
  it("doctor says it did not check when forge: comes from craftar.local.yaml", async () => {
    const root = await ws({ local: { forge: "../forge" } });
    await writeFiles(root, { ".gitignore": ".claude/\n" });
    const line = JSON.parse(runCli(["doctor", "--workspace", root, "--json"]).stdout).checks.filter((c: { id: string }) => c.id === "generated-ignored");
    expect(line).toMatchObject([{ level: "ok", message: "not checked: forge: comes from craftar.local.yaml" }]);
  });
  it("the doctor tool's narrowed report keeps the check", async () => {
    const root = await ws();
    await writeFiles(root, { ".gitignore": ".claude/\n" });
    const report = await runDoctor({ version: "t", workspace: root, fetch: false, strict: false, home: await tmpHome(), registryOff: true, gitVersion: async () => "t", dotnetVersion: async () => null });
    expect(workspaceReport(report).checks.some((c) => c.id === "generated-ignored" && c.level === "warn")).toBe(true);
  });
  it("a workspace with nothing ignored prints no line", async () => {
    const root = await ws();
    expect(runCli(["sync", "--workspace", root]).stdout).not.toContain("git ignores it");
  });
  it("an older-shaped craftar.yaml with no mayBeIgnored still loads", async () => {
    const w = await loadWorkspace(await ws());
    expect(w.config.mayBeIgnored).toBeUndefined();
  });
});

async function tmpHome(): Promise<string> {
  const dir = await tmpDir();
  cleanups.push(() => removeWithRetry(dir));
  return dir;
}
