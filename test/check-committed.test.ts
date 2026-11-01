/**
 * Spec 49 Part B: `sync --check --committed [rev]` and `--index` compare the plan with what git holds.
 * Real git, in temporary repositories; nothing leaves the machine.
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { apply, loadWorkspace, plan, status } from "../src/core/sync.js";
import { diskSource, gitSource } from "../src/core/workspace-source.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, profile, recipe, rule, tmpDir, writeFiles } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";
import { remoteForge } from "./helpers/remote.js";
import { TSX_LOADER } from "./helpers/tsx-loader.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

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

const RULE = ".claude/rules/a.md";
const FORGE = { ingredients: [rule("a", "body a\n"), rule("b", "body b\n")], recipes: [recipe("base", ["rule/a", "rule/b"])], profiles: [profile("acme", ["base"])] };

/** A repository with a synced, committed workspace: at its root, or at `sub` below it. */
async function committed(sub = ".", config = "") {
  const root = await tmpDir();
  cleanups.push(() => removeWithRetry(root));
  const forge = path.join(root, "forge");
  await makeForge(forge, FORGE);
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  git(repo, "init", "-q");
  const ws = path.join(repo, sub);
  await fs.mkdir(ws, { recursive: true });
  await writeFiles(ws, { "craftar.yaml": `forge: ${path.relative(ws, forge).replace(/\\/g, "/")}\nprofile: acme\n${config}` });
  expect(runCli(["sync", "--workspace", ws]).code).toBe(0);
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "synced");
  return { root, forge, repo, ws };
}

const check = (ws: string, ...args: string[]) => runCli(["sync", "--check", "--workspace", ws, ...args]);

describe("sync --check --committed", () => {
  it("passes a commit in sync with its own closing line, whatever the folder holds", async () => {
    const { ws, repo } = await committed();
    await fs.writeFile(path.join(ws, RULE), "hand edit on disk only\n");
    expect(check(ws).code).toBe(1);
    const r = check(ws, "--committed");
    expect(r.code).toBe(0);
    const short = git(repo, "rev-parse", "HEAD").trim().slice(0, 8);
    expect(r.stdout).toContain(`commit ${short} in sync`);
    expect(r.stdout).not.toContain("workspace in sync");
  });
  it("reads a file on disk and absent from the commit as new, exit 1", async () => {
    const { ws, repo } = await committed();
    git(repo, "rm", "-q", "--cached", RULE);
    git(repo, "commit", "-qm", "dropped");
    expect(check(ws).code).toBe(0);
    const r = check(ws, "--committed");
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(new RegExp(`new\\s+${RULE.replace(/\./g, "\\.")}`));
  });
  it("reads a hand edit only in the commit as drift, exit 1", async () => {
    const { ws, repo } = await committed();
    const good = await fs.readFile(path.join(ws, RULE));
    await fs.writeFile(path.join(ws, RULE), "hand edit\n");
    git(repo, "add", RULE);
    git(repo, "commit", "-qm", "edit");
    await fs.writeFile(path.join(ws, RULE), good);
    expect(check(ws).code).toBe(0);
    const r = check(ws, "--committed");
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/drift/);
  });
  it("takes a revision, not only HEAD", async () => {
    const { ws, repo } = await committed();
    const first = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "rm", "-q", "--cached", RULE);
    git(repo, "commit", "-qm", "dropped");
    expect(check(ws, "--committed").code).toBe(1);
    expect(check(ws, "--committed", first).code).toBe(0);
    expect(check(ws, "--committed", "HEAD~1").code).toBe(0);
  });
  it("uses the commit's craftar.yaml and lock, not the disk's", async () => {
    const { ws } = await committed();
    const yaml = await fs.readFile(path.join(ws, "craftar.yaml"), "utf8");
    await fs.writeFile(path.join(ws, "craftar.yaml"), yaml.replace("profile: acme", "profile: nobody"));
    await fs.writeFile(path.join(ws, "craftar.lock"), "not json");
    expect(check(ws, "--committed").code).toBe(0);
  });
  it("does not read craftar.local.yaml, and says so", async () => {
    const { ws } = await committed();
    await writeFiles(ws, { "craftar.local.yaml": "profile: nobody\n" });
    const r = check(ws, "--committed");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("craftar.local.yaml is not read");
  });
  it("works for a workspace in a subdirectory and in a linked worktree", async () => {
    const { repo, root } = await committed("acme/harness");
    const tree = path.join(root, "linked");
    git(repo, "worktree", "add", "-q", tree);
    const r = check(path.join(tree, "acme/harness"), "--committed");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("in sync");
  });
  it("reads a commit's refused lock path as a refusal", async () => {
    const { ws, repo } = await committed();
    const lock = JSON.parse(await fs.readFile(path.join(ws, "craftar.lock"), "utf8"));
    lock.files[0].path = "../outside.md";
    await fs.writeFile(path.join(ws, "craftar.lock"), JSON.stringify(lock));
    git(repo, "add", "craftar.lock");
    git(repo, "commit", "-qm", "bad lock");
    const r = check(ws, "--committed");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("is outside the workspace");
  });
  it("writes nothing to the workspace", async () => {
    const { ws, repo } = await committed();
    const before = git(repo, "status", "--porcelain");
    const lockBefore = await fs.readFile(path.join(ws, "craftar.lock"));
    expect(check(ws, "--committed").code).toBe(0);
    expect(git(repo, "status", "--porcelain")).toBe(before);
    expect(await fs.readFile(path.join(ws, "craftar.lock"))).toEqual(lockBefore);
  });
  it("does not start a filter, a textconv or an fsmonitor", async () => {
    const { repo, ws } = await committed();
    const record = path.join(repo, ".git", "ran");
    const script = path.join(repo, ".git", "record.sh");
    await fs.writeFile(script, `#!/bin/sh\necho ran >> "${record.replace(/\\/g, "/")}"\ncat\n`, { mode: 0o755 });
    const quoted = script.replace(/\\/g, "/");
    git(repo, "config", "filter.x.clean", quoted);
    git(repo, "config", "filter.x.smudge", quoted);
    git(repo, "config", "diff.x.textconv", quoted);
    git(repo, "config", "core.fsmonitor", quoted);
    await fs.appendFile(path.join(repo, ".git/info/attributes"), "* filter=x diff=x\n").catch(async () => {
      await writeFiles(repo, { ".git/info/attributes": "* filter=x diff=x\n" });
    });
    expect(check(ws, "--committed").code).toBe(0);
    await expect(fs.access(record)).rejects.toThrow();
  });
});

describe("refusals", () => {
  it("--committed without --check", async () => {
    const { ws } = await committed();
    const r = runCli(["sync", "--committed", "--workspace", ws]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("need --check");
    expect(runCli(["sync", "--index", "--workspace", ws]).code).toBe(1);
  });
  it("both at once, and --unavailable-ok alone", async () => {
    const { ws } = await committed();
    expect(check(ws, "--committed", "--index").stderr).toContain("exclusive");
    expect(check(ws, "--unavailable-ok").stderr).toContain("needs --committed or --index");
  });
  it("off a repository", async () => {
    const dir = await tmpDir();
    cleanups.push(() => removeWithRetry(dir));
    const r = check(dir, "--committed");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("git repository");
  });
  it("an unknown revision, one starting with -, and a value not shaped like a revision is not printed", async () => {
    const { ws } = await committed();
    expect(check(ws, "--committed=nope").stderr).toContain("unknown revision nope");
    const dashed = check(ws, "--committed=--foo");
    expect(dashed.code).toBe(1);
    expect(dashed.stderr).toContain("unknown revision");
    const token = "a b\u001b[31m";
    const odd = check(ws, `--committed=${token}`);
    expect(odd.code).toBe(1);
    expect(odd.stderr).not.toContain(token);
  });
  it("a commit with no craftar.yaml is refused without --unavailable-ok and passes with it", async () => {
    const { ws, repo } = await committed();
    git(repo, "rm", "-q", "--cached", "craftar.yaml");
    git(repo, "commit", "-qm", "gone");
    const r = check(ws, "--committed");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("this commit has no craftar.yaml");
    const ok = check(ws, "--committed", "--unavailable-ok");
    expect(ok.code).toBe(0);
    expect(ok.stderr).toContain("not checked: this commit has no craftar.yaml");
  });
  it("an object that is not a commit is refused without --unavailable-ok and passes with it; an unknown revision never does", async () => {
    const { ws, repo } = await committed();
    const blob = git(repo, "rev-parse", `HEAD:craftar.yaml`).trim();
    expect(check(ws, `--committed=${blob}`).code).toBe(1);
    const ok = check(ws, `--committed=${blob}`, "--unavailable-ok");
    expect(ok.code).toBe(0);
    expect(ok.stderr).toContain("is not a commit");
    expect(check(ws, "--committed=nope", "--unavailable-ok").code).toBe(1);
  });
  it("a tag peels to its commit", async () => {
    const { ws, repo } = await committed();
    git(repo, "tag", "-a", "v1", "-m", "v1");
    expect(check(ws, "--committed=v1").code).toBe(0);
  });
});

describe("--unavailable-ok", () => {
  it("passes a path Forge that is gone, and fails without it", async () => {
    const { ws, forge } = await committed();
    await removeWithRetry(forge);
    expect(check(ws, "--committed").code).toBe(1);
    const r = check(ws, "--committed", "--unavailable-ok");
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("not checked: Forge not found at");
  });
  it("still fails out of sync", async () => {
    const { ws, repo } = await committed();
    git(repo, "rm", "-q", "--cached", RULE);
    git(repo, "commit", "-qm", "dropped");
    const r = check(ws, "--committed", "--unavailable-ok");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("1 file(s) out of sync");
  });
  it("still fails a malformed Forge", async () => {
    const { ws, forge } = await committed();
    await fs.writeFile(path.join(forge, "craftar.forge.yaml"), "name: x\nschema: 99\n");
    const r = check(ws, "--committed", "--unavailable-ok");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("craftar.forge.yaml");
    expect(r.stderr).not.toContain("not checked");
  });
  it("still fails a craftar.yaml that does not read", async () => {
    const { ws, repo } = await committed();
    await fs.writeFile(path.join(ws, "craftar.yaml"), "profile: acme\n");
    git(repo, "add", "craftar.yaml");
    git(repo, "commit", "-qm", "no forge");
    const r = check(ws, "--committed", "--unavailable-ok");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("invalid craftar.yaml");
  });
  it("passes a remote Forge with no cached copy under --offline", async () => {
    const rf = await remoteForge(FORGE);
    cleanups.push(rf.cleanup);
    const home = await tmpDir();
    cleanups.push(() => removeWithRetry(home));
    const dir = await tmpDir();
    cleanups.push(() => removeWithRetry(dir));
    git(dir, "init", "-q");
    await writeFiles(dir, { "craftar.yaml": `forge: ${rf.url}\nprofile: acme\n` });
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "i");
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--check", "--committed", "--offline", "--workspace", dir], { env }).code).toBe(1);
    const r = runCli(["sync", "--check", "--committed", "--offline", "--unavailable-ok", "--workspace", dir], { env });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("not checked:");
  });
  it("reads a remote Forge's cached copy offline, as sync --check --offline does", async () => {
    const rf = await remoteForge(FORGE);
    cleanups.push(rf.cleanup);
    const home = await tmpDir();
    cleanups.push(() => removeWithRetry(home));
    const dir = await tmpDir();
    cleanups.push(() => removeWithRetry(dir));
    git(dir, "init", "-q");
    await writeFiles(dir, { "craftar.yaml": `forge: ${rf.url}\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", dir], { env }).code).toBe(0);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "i");
    const r = runCli(["sync", "--check", "--committed", "--offline", "--workspace", dir], { env });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("in sync");
  });
});

describe("sync --check --index", () => {
  it("reads a staged file and ignores an unstaged one", async () => {
    const { ws, repo } = await committed();
    await fs.writeFile(path.join(ws, RULE), "unstaged\n");
    expect(check(ws, "--index").code).toBe(0);
    git(repo, "add", RULE);
    const r = check(ws, "--index");
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/drift/);
  });
  it("closes with its own line", async () => {
    const { ws } = await committed();
    expect(check(ws, "--index").stdout).toContain("index in sync");
  });
  it("reads a removal from the index as new", async () => {
    const { ws, repo } = await committed();
    git(repo, "rm", "-q", "--cached", RULE);
    const r = check(ws, "--index");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("1 file(s) out of sync");
  });
  it("refuses a merge conflict below the workspace", async () => {
    const { ws, repo } = await committed();
    const main = git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim();
    git(repo, "checkout", "-q", "-b", "other");
    await fs.writeFile(path.join(ws, RULE), "other\n");
    git(repo, "commit", "-qam", "other");
    git(repo, "checkout", "-q", main);
    await fs.writeFile(path.join(ws, RULE), "main\n");
    git(repo, "commit", "-qam", "main");
    try {
      git(repo, "merge", "-q", "other");
    } catch {
      // the conflict is what this test wants
    }
    const r = check(ws, "--index");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("merge conflict");
  });
});

describe("gitSource", () => {
  it("reads a planned path by any spelling, and a line feed in a path shifts no answer", async () => {
    const { ws } = await committed("sub");
    const s = await gitSource(ws, { rev: "HEAD" });
    try {
      const want = await fs.readFile(path.join(ws, RULE));
      expect(await s.read(RULE)).toEqual(want);
      expect(await s.read(`./${RULE}`)).toEqual(want);
      expect(await s.read(`/${RULE}`)).toEqual(want);
      expect(await s.read(`.claude/x/../rules/a.md`)).toEqual(want);
      expect(await s.read(`.claude/rules/a.md\nHEAD:craftar.yaml`)).toBeNull();
      expect(await s.read(RULE)).toEqual(want);
    } finally {
      await s.close();
    }
  });
  it("answers exists for a directory, with or without a trailing slash; read of it is null", async () => {
    const { ws } = await committed();
    const s = await gitSource(ws, { rev: "HEAD" });
    try {
      expect(await s.exists(".claude/rules")).toBe(true);
      expect(await s.exists(".claude/rules/")).toBe(true);
      expect(await s.exists(RULE)).toBe(true);
      expect(await s.exists(".claude/nope")).toBe(false);
      expect(await s.read(".claude/rules")).toBeNull();
    } finally {
      await s.close();
    }
  });
  it("climbs nowhere", async () => {
    const { ws } = await committed("sub");
    await writeFiles(path.dirname(ws), { outside: "x\n" });
    const repo = path.dirname(ws);
    git(repo, "add", "outside");
    git(repo, "commit", "-qm", "o");
    const s = await gitSource(ws, { rev: "HEAD" });
    try {
      expect(await s.read("../outside")).toBeNull();
      expect(await s.exists("../outside")).toBe(false);
    } finally {
      await s.close();
    }
  });
  it.skipIf(process.platform === "win32")("reads a symbolic link and a gitlink as absent, and bytes as bytes", async () => {
    const { ws, repo } = await committed();
    await fs.symlink("craftar.yaml", path.join(ws, "lnk"));
    const bytes = Buffer.from([0xff, 0x00, 0x0a, 0x0d]);
    await fs.writeFile(path.join(ws, "bin"), bytes);
    git(repo, "add", "lnk", "bin");
    const blob = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "update-index", "--add", "--cacheinfo", `160000,${blob},gl`);
    git(repo, "commit", "-qm", "odd");
    const s = await gitSource(ws, { rev: "HEAD" });
    try {
      expect(await s.read("lnk")).toBeNull();
      expect(await s.read("gl")).toBeNull();
      expect(await s.read("bin")).toEqual(bytes);
    } finally {
      await s.close();
    }
  });
  it("finds the repository from the nearest directory when the workspace is not on disk", async () => {
    const { repo } = await committed("acme/harness");
    git(repo, "checkout", "-q", "--detach");
    const ws = path.join(repo, "acme", "harness");
    const head = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "rm", "-rq", "acme");
    git(repo, "commit", "-qm", "no workspace");
    await expect(fs.access(ws)).rejects.toThrow();
    const without = runCli(["sync", "--check", "--committed", "--unavailable-ok", "--workspace", ws]);
    expect(without.code).toBe(0);
    expect(without.stderr).toContain("this commit has no craftar.yaml");
    // An older commit still has it, though its directory is not on disk here.
    const s = await gitSource(ws, { rev: head });
    try {
      expect((await s.read("craftar.yaml"))?.toString()).toContain("profile: acme");
    } finally {
      await s.close();
    }
  });
  it("is refused by apply()", async () => {
    const { ws } = await committed();
    const w = await loadWorkspace(ws);
    const p = await plan(w);
    const st = await status(w, p, null);
    w.source = await gitSource(ws, { rev: "HEAD" });
    try {
      await expect(apply(w, p, st)).rejects.toThrow("cannot be written");
      w.source = diskSource(ws);
      await expect(apply(w, p, st, { dryRun: true })).resolves.toBeDefined();
    } finally {
      await w.source.close();
    }
  });
});

describe.skipIf(process.platform === "win32")("from a real git hook", () => {
  const CLI = path.resolve(__dirname, "../src/cli.ts");
  const hook = async (repo: string, name: string, line: string, out: string) => {
    const file = path.join(repo, ".git", "hooks", name);
    await fs.writeFile(file, `#!/bin/sh\nCRAFTAR_NO_REGISTRY=1 "${process.execPath}" --import "${TSX_LOADER}" "${CLI}" ${line} > "${out}" 2>&1\necho "exit=$?" >> "${out}"\nexit 0\n`, { mode: 0o755 });
  };
  it("in a linked worktree, for a workspace in a subdirectory, reads that workspace", async () => {
    const { repo, root } = await committed("acme/harness");
    const tree = path.join(root, "linked");
    git(repo, "worktree", "add", "-q", tree);
    const out = path.join(root, "hook.out");
    await hook(repo, "pre-commit", `sync --check --index --workspace acme/harness`, out);
    await fs.writeFile(path.join(tree, "other.txt"), "x\n");
    git(tree, "add", "other.txt");
    git(tree, "commit", "-qm", "c");
    const text = await fs.readFile(out, "utf8");
    expect(text).toContain("index in sync");
    expect(text).toContain("exit=0");
  });
  it("reads the index of a partial commit", async () => {
    const { repo, ws, root } = await committed();
    const out = path.join(root, "hook.out");
    await hook(repo, "pre-commit", `sync --check --index`, out);
    // Staged, and left out of the partial commit: the hook's index does not hold it.
    await fs.writeFile(path.join(ws, RULE), "staged\n");
    git(repo, "add", RULE);
    await fs.writeFile(path.join(ws, "other.txt"), "x\n");
    git(repo, "add", "other.txt");
    git(repo, "commit", "-qm", "partial", "other.txt");
    const text = await fs.readFile(out, "utf8");
    expect(text).toContain("index in sync");
  });
  it("under pre-push, reads the pushed commit", async () => {
    const { repo, root } = await committed();
    const bare = path.join(root, "bare.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    const out = path.join(root, "hook.out");
    const sha = git(repo, "rev-parse", "HEAD").trim();
    await hook(repo, "pre-push", `sync --check --committed ${sha}`, out);
    git(repo, "push", "-q", bare, "HEAD:refs/heads/x");
    const text = await fs.readFile(out, "utf8");
    expect(text).toContain(`commit ${sha.slice(0, 8)} in sync`);
  });
});
