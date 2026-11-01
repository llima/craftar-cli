/**
 * Spec 49 Part C: `craftar git-hooks`. Real git in temporary repositories; a real push goes to a local bare repository.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { hookScript, installHooks, readHookMarker } from "../src/core/git-hooks.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, profile, recipe, rule, tmpDir, writeFiles } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";
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
const FORGE = { ingredients: [rule("a", "body a\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] };

/** A repository with a synced, committed workspace: at its root, or at `sub` below it. */
async function committed(sub = ".") {
  const root = await fs.realpath(await tmpDir());
  cleanups.push(() => removeWithRetry(root));
  const forge = path.join(root, "forge");
  await makeForge(forge, FORGE);
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  git(repo, "init", "-q");
  const ws = path.join(repo, sub);
  await fs.mkdir(ws, { recursive: true });
  await writeFiles(ws, { "craftar.yaml": `forge: ${path.relative(ws, forge).replace(/\\/g, "/")}\nprofile: acme\n` });
  expect(runCli(["sync", "--workspace", ws]).code).toBe(0);
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "synced");
  return { root, forge, repo, ws };
}

/** A PATH entry holding `git` and nothing else, so a craftar installed on the machine cannot answer. */
async function gitOnly(root: string): Promise<string> {
  const dir = path.join(root, "only-git");
  await fs.mkdir(dir, { recursive: true });
  const real = execFileSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" }).split(/\r?\n/)[0];
  if (process.platform === "win32") await fs.copyFile(real, path.join(dir, "git.exe"));
  else await fs.symlink(real, path.join(dir, "git"));
  return dir;
}

const hooks = (...args: string[]) => runCli(["git-hooks", ...args]);
const hookFile = (repo: string, name = "pre-push") => path.join(repo, ".git", "hooks", name);
const read = (f: string) => fs.readFile(f, "utf8");
const gone = (f: string) => expect(fs.lstat(f)).rejects.toThrow();

describe("hookScript and readHookMarker", () => {
  it("writes LF, the marker on the second line, and only the craftar of PATH", () => {
    const text = hookScript("pre-push", "acme/harness", { blockWhenUnavailable: false });
    expect(text).not.toContain("\r");
    expect(text.split("\n")[0]).toBe("#!/bin/sh");
    expect(text.split("\n")[1]).toMatch(/^# craftar git-hooks 1 workspace='acme\/harness' — /);
    expect(text).toContain("command -v craftar");
    expect(text).not.toContain("npx");
    expect(text).toContain(`"$p" sync --check --committed "$sha" --workspace 'acme/harness' --unavailable-ok </dev/null`);
  });
  it("pre-commit reads the index, and --block-when-unavailable leaves the flag out", () => {
    expect(hookScript("pre-commit", ".", { blockWhenUnavailable: false })).toContain(`"$p" sync --check --index --workspace '.' --unavailable-ok </dev/null`);
    expect(hookScript("pre-push", ".", { blockWhenUnavailable: true })).not.toContain("--unavailable-ok");
  });
  it("reads back what it wrote", () => {
    expect(readHookMarker(hookScript("pre-push", "a b/c", { blockWhenUnavailable: false }))).toEqual({ workspace: "a b/c" });
  });
  it("reads no marker from what does not parse, and never takes a value that breaks the rule", () => {
    const token = "ghp_" + "x".repeat(36);
    for (const text of [
      "#!/bin/sh\necho hi\n",
      "#!/bin/sh\n# craftar git-hooks workspace='a' — x\n",
      "# craftar git-hooks 1 workspace='a' — on the first line\n",
      "#!/bin/sh\n# craftar git-hooks 1 workspace='a\u001b[31m' — x\n",
      `#!/bin/sh\n# craftar git-hooks 1 workspace='${token}' — x\n`,
      "#!/bin/sh\n# craftar git-hooks 1 workspace='https://u:s3cret@host/x' — x\n",
      "#!/bin/sh\n# craftar git-hooks 1 workspace='a\u202eb' — x\n",
      "#!/bin/sh\n# craftar git-hooks 1 workspace='a'b' — x\n",
    ]) expect(readHookMarker(text)).toBeNull();
  });
});

describe("install", () => {
  it("writes pre-push by default, mode 0755, and says where", async () => {
    const { repo, ws } = await committed();
    const r = hooks("install", "--workspace", ws);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(".git/hooks/pre-push");
    const text = await read(hookFile(repo));
    expect(readHookMarker(text)).toEqual({ workspace: "." });
    if (process.platform !== "win32") expect((await fs.stat(hookFile(repo))).mode & 0o777).toBe(0o755);
    await gone(hookFile(repo, "pre-commit"));
    expect(git(repo, "status", "--porcelain")).toBe("");
  });
  it("writes what the flags name, and the workspace's path from the root", async () => {
    const { repo, ws } = await committed("acme/harness");
    expect(hooks("install", "--pre-commit", "--pre-push", "--workspace", ws).code).toBe(0);
    expect(readHookMarker(await read(hookFile(repo, "pre-commit")))).toEqual({ workspace: "acme/harness" });
    expect(readHookMarker(await read(hookFile(repo, "pre-push")))).toEqual({ workspace: "acme/harness" });
  });
  it("rewrites its own hook", async () => {
    const { repo, ws } = await committed();
    hooks("install", "--workspace", ws);
    expect(hooks("install", "--block-when-unavailable", "--workspace", ws).code).toBe(0);
    expect(await read(hookFile(repo))).not.toContain("--unavailable-ok");
  });
  it("from a linked worktree, writes into the common directory", async () => {
    const { repo, root } = await committed();
    const tree = path.join(root, "linked");
    git(repo, "worktree", "add", "-q", tree);
    expect(hooks("install", "--workspace", tree).code).toBe(0);
    expect(readHookMarker(await read(hookFile(repo)))).toEqual({ workspace: "." });
  });
  it("creates a hooks directory that does not exist", async () => {
    const { repo, ws } = await committed();
    await fs.rm(path.join(repo, ".git/hooks"), { recursive: true, force: true });
    expect(hooks("install", "--workspace", ws).code).toBe(0);
    await expect(fs.access(hookFile(repo))).resolves.toBeUndefined();
  });
  it("refuses a hooks path that is a file", async () => {
    const { repo, ws } = await committed();
    await writeFiles(repo, { hk: "x\n" });
    git(repo, "config", "core.hooksPath", "hk");
    const r = hooks("install", "--workspace", ws);
    expect(r.code).toBe(1);
    expect(await read(path.join(repo, "hk"))).toBe("x\n");
  });
  describe("core.hooksPath", () => {
    it("inside the repository: written, and it says who it can reach", async () => {
      const { repo, ws } = await committed();
      git(repo, "config", "core.hooksPath", ".githooks");
      const r = hooks("install", "--workspace", ws);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("reaches everyone who clones it");
      expect(readHookMarker(await read(path.join(repo, ".githooks/pre-push")))).toEqual({ workspace: "." });
    });
    it("outside the repository: refused with the line to add by hand, --force or not, nothing written", async () => {
      const { repo, ws, root } = await committed();
      const out = path.join(root, "global-hooks");
      git(repo, "config", "core.hooksPath", out);
      for (const args of [[], ["--force"]]) {
        const r = hooks("install", ...args, "--workspace", ws);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("craftar sync --check --committed");
        expect(r.stderr).not.toContain(out);
      }
      await gone(out);
    });
    it("reaching outside through a link: refused", async () => {
      const { repo, ws, root } = await committed();
      const out = path.join(root, "away");
      await fs.mkdir(out);
      await fs.symlink(out, path.join(repo, "hk"), "junction");
      git(repo, "config", "core.hooksPath", "hk");
      expect(hooks("install", "--workspace", ws).code).toBe(1);
      await gone(path.join(out, "pre-push"));
    });
    it("holding a .. segment: refused, since git walks it through a link where a lexical answer would not", async () => {
      const { repo, ws, root } = await committed();
      const out = path.join(root, "away");
      await fs.mkdir(out);
      await fs.symlink(out, path.join(repo, "lnk"), "junction");
      git(repo, "config", "core.hooksPath", "lnk/../hk");
      expect(hooks("install", "--workspace", ws).code).toBe(1);
      await gone(path.join(repo, "hk/pre-push"));
    });
    it("from the global configuration: refused though it lands inside the repository", async () => {
      const { repo, ws } = await committed();
      await fs.writeFile(process.env.GIT_CONFIG_GLOBAL!, `[core]\n\thooksPath = ${path.join(repo, "hk").replace(/\\/g, "/")}\n`);
      try {
        const r = hooks("install", "--workspace", ws);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("every repository");
        await gone(path.join(repo, "hk/pre-push"));
      } finally {
        await fs.writeFile(process.env.GIT_CONFIG_GLOBAL!, "");
      }
    });
    it(".git/hooks itself a link out: refused in its own words, labelled apart", async () => {
      const { repo, ws, root } = await committed();
      const out = path.join(root, "away");
      await fs.mkdir(out);
      await fs.rm(path.join(repo, ".git/hooks"), { recursive: true, force: true });
      await fs.symlink(out, path.join(repo, ".git/hooks"), "junction");
      const r = hooks("install", "--workspace", ws);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(".git/hooks");
      expect(r.stderr).not.toContain("core.hooksPath");
      await gone(path.join(out, "pre-push"));
      expect(JSON.parse(hooks("status", "--json", "--workspace", ws).stdout).hooksDir).toBe(".git/hooks (outside the repository)");
    });
    it("a file in the way of the hooks path: a refusal in its own words, no path", async () => {
      const { repo, ws, root } = await committed();
      await writeFiles(repo, { f: "x\n" });
      git(repo, "config", "core.hooksPath", "f/hk");
      const r = hooks("install", "--workspace", ws);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("hooks path");
      expect(r.stderr).not.toContain(root);
    });
    it("through a dangling link: a refusal that names no path", async () => {
      const { repo, ws, root } = await committed();
      const out = path.join(root, "outside-dir");
      await fs.mkdir(out);
      await fs.symlink(path.join(out, "nothing"), path.join(out, "dangling"));
      git(repo, "config", "core.hooksPath", path.join(out, "dangling/hk"));
      for (const args of [["install"], ["uninstall"], ["status", "--json"]]) {
        const r = hooks(...args, "--workspace", ws);
        expect(r.stderr + r.stdout).not.toContain(out);
        expect(r.code).toBe(1);
      }
    });
    it("~/hk: refused, nothing written in the home", async () => {
      const { repo, ws, root } = await committed();
      const home = path.join(root, "home");
      await fs.mkdir(home);
      git(repo, "config", "core.hooksPath", "~/hk");
      const r = runCli(["git-hooks", "install", "--workspace", ws], { env: { HOME: home, USERPROFILE: home } });
      expect(r.code).toBe(1);
      await gone(path.join(home, "hk"));
    });
    it("empty: refused, so no hook lands at the top of the tree", async () => {
      const { repo, ws } = await committed();
      git(repo, "config", "core.hooksPath", "");
      expect(hooks("install", "--workspace", ws).code).toBe(1);
      await gone(path.join(repo, "pre-push"));
    });
    it("a workspace inside its Forge's repository still has its hooks in .git", async () => {
      const { repo, ws } = await committed("ws");
      await fs.writeFile(path.join(ws, "craftar.yaml"), "forge: ..\nprofile: acme\n");
      await makeForge(repo, FORGE);
      expect(hooks("install", "--workspace", ws).code).toBe(0);
      await expect(fs.access(hookFile(repo))).resolves.toBeUndefined();
    });
    it("inside a path Forge: refused, --force or not", async () => {
      const { repo, ws } = await committed("ws");
      await makeForge(path.join(repo, "inner"), FORGE);
      await fs.writeFile(path.join(ws, "craftar.yaml"), "forge: ../inner\nprofile: acme\n");
      git(repo, "config", "core.hooksPath", "inner/hk");
      for (const args of [[], ["--force"]]) {
        const r = hooks("install", ...args, "--workspace", ws);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("inside the Forge");
      }
      await gone(path.join(repo, "inner/hk/pre-push"));
    });
    it("a hook path the plan writes: refused, without case", async () => {
      const { repo, ws, forge } = await committed();
      await makeForge(forge, {
        ingredients: [...FORGE.ingredients, { meta: { type: "hook", name: "guard", files: ["PRE-PUSH"], targets: ["claude-code"] }, files: { "PRE-PUSH": "#!/bin/sh\n" } }],
        recipes: [recipe("base", ["rule/a", "hook/guard"])],
        profiles: FORGE.profiles,
      });
      git(repo, "config", "core.hooksPath", ".claude/hooks");
      const r = hooks("install", "--workspace", ws);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("craftar writes that path");
      await gone(path.join(ws, ".claude/hooks/pre-push"));
    });
    it("a hook path only the lock holds: refused", async () => {
      const { repo, ws } = await committed();
      git(repo, "config", "core.hooksPath", ".claude/rules");
      const lock = JSON.parse(await read(path.join(ws, "craftar.lock")));
      lock.files.push({ ...lock.files[0], path: ".claude/rules/pre-push" });
      await fs.writeFile(path.join(ws, "craftar.lock"), JSON.stringify(lock));
      const r = hooks("install", "--workspace", ws);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("craftar writes that path");
    });
    it("with the Forge gone, compares the lock alone and says so", async () => {
      const { repo, ws, forge } = await committed();
      await removeWithRetry(forge);
      const r = hooks("install", "--workspace", ws);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("compared with craftar.lock alone");
      await expect(fs.access(hookFile(repo))).resolves.toBeUndefined();
    });
  });
  describe("an existing hook", () => {
    const theirs = "#!/bin/sh\necho theirs\n";
    it("no marker: refused, untouched, naming --force", async () => {
      const { repo, ws } = await committed();
      await fs.writeFile(hookFile(repo), theirs);
      const r = hooks("install", "--workspace", ws);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--force");
      expect(await read(hookFile(repo))).toBe(theirs);
      await gone(`${hookFile(repo)}.craftar-backup`);
    });
    it("--force keeps it as a backup, and an existing backup refuses", async () => {
      const { repo, ws } = await committed();
      await fs.writeFile(hookFile(repo), theirs);
      expect(hooks("install", "--force", "--workspace", ws).code).toBe(0);
      expect(await read(`${hookFile(repo)}.craftar-backup`)).toBe(theirs);
      expect(readHookMarker(await read(hookFile(repo)))).not.toBeNull();
      await fs.writeFile(hookFile(repo), "#!/bin/sh\necho second\n");
      const r = hooks("install", "--force", "--workspace", ws);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("craftar-backup");
      expect(await read(`${hookFile(repo)}.craftar-backup`)).toBe(theirs);
      expect(await read(hookFile(repo))).toBe("#!/bin/sh\necho second\n");
    });
    it("a refusal of one hook writes neither", async () => {
      const { repo, ws } = await committed();
      await fs.writeFile(hookFile(repo, "pre-commit"), theirs);
      expect(hooks("install", "--pre-push", "--pre-commit", "--workspace", ws).code).toBe(1);
      await gone(hookFile(repo));
    });
    it("a marked hook for another workspace: refused, --force or not, naming it", async () => {
      const { repo, ws } = await committed("one");
      await fs.mkdir(path.join(repo, "two"));
      await fs.copyFile(path.join(ws, "craftar.yaml"), path.join(repo, "two/craftar.yaml"));
      expect(hooks("install", "--workspace", path.join(repo, "two")).code).toBe(0);
      for (const args of [[], ["--force"]]) {
        const r = hooks("install", ...args, "--workspace", ws);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("workspace two");
      }
      expect(readHookMarker(await read(hookFile(repo)))).toEqual({ workspace: "two" });
    });
  });
  it("refuses a workspace path it could not read back from the hook", async () => {
    const token = "ghp_" + "x".repeat(36);
    const { repo } = await committed(token);
    const r = hooks("install", "--workspace", path.join(repo, token));
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain(token);
    await gone(hookFile(repo));
  });
  it("warns of a hooks directory in the working tree whatever makes it so, and not of one under .git", async () => {
    const { repo, ws } = await committed();
    git(repo, "config", "core.hooksPath", ".git/custom");
    const under = hooks("install", "--workspace", ws);
    expect(under.code).toBe(0);
    expect(under.stdout).not.toContain("reaches everyone");
    hooks("uninstall", "--workspace", ws);
    git(repo, "config", "--unset", "core.hooksPath");
    await fs.rm(path.join(repo, ".git/hooks"), { recursive: true, force: true });
    await fs.mkdir(path.join(repo, "tools"));
    await fs.symlink(path.join(repo, "tools"), path.join(repo, ".git/hooks"), "junction");
    const linked = hooks("install", "--workspace", ws);
    expect(linked.code).toBe(0);
    expect(linked.stdout).toContain("reaches everyone");
  });
  it.runIf(process.platform === "win32")("on win32, doctor agrees with the hook: the first craftar is the one", async () => {
    const { ws, repo, root } = await committed();
    hooks("install", "--workspace", ws);
    const planted = path.join(repo, "planted");
    const bin = path.join(root, "bin");
    await writeFiles(planted, { craftar: "#!/bin/sh\n" });
    await writeFiles(bin, { craftar: "#!/bin/sh\n" });
    const onlyGit = await gitOnly(root);
    const check = (...entries: string[]) => {
      const PATH = [...entries, onlyGit].join(path.delimiter);
      return JSON.parse(runCli(["doctor", "--json", "--workspace", ws], { env: { PATH, Path: PATH } }).stdout).checks.find((c: { id: string }) => c.id === "git-hooks").level;
    };
    expect(check(planted, bin)).toBe("warn");
    expect(check(bin, planted)).toBe("ok");
    await fs.rm(path.join(bin, "craftar"));
    await writeFiles(bin, { "craftar.cmd": "@echo off\n" });
    expect(check(bin)).toBe("warn");
  });
  it.skipIf(process.platform === "win32")("is executable whatever the umask", async () => {
    const { repo, ws } = await committed();
    const cli = path.resolve(__dirname, "../src/cli.ts");
    execFileSync("sh", ["-c", `umask 0177; exec "${process.execPath}" --import "${TSX_LOADER}" "${cli}" git-hooks install --workspace "${ws}"`], { stdio: "pipe" });
    expect((await fs.stat(hookFile(repo))).mode & 0o777).toBe(0o755);
  });
  it("a write that fails leaves the existing hook in place and no temporary file", async () => {
    const { repo, ws } = await committed();
    const theirs = "#!/bin/sh\necho theirs\n";
    await fs.writeFile(hookFile(repo), theirs);
    // The temporary file of the second hook is already there: `wx` fails after the first was prepared.
    const blocker = `${hookFile(repo, "pre-commit")}.craftar-${process.pid}.tmp`;
    await fs.writeFile(blocker, "x");
    await expect(installHooks(ws, ["pre-push", "pre-commit"], { force: true, blockWhenUnavailable: false })).rejects.toThrow("nothing changed");
    await fs.rm(blocker);
    expect(await read(hookFile(repo))).toBe(theirs);
    await gone(`${hookFile(repo)}.craftar-backup`);
    await gone(hookFile(repo, "pre-commit"));
    expect((await fs.readdir(path.join(repo, ".git/hooks"))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
  describe("refusals before anything", () => {
    it("off a repository, in a bare one, with no craftar.yaml, or one that does not read", async () => {
      const dir = await tmpDir();
      cleanups.push(() => removeWithRetry(dir));
      expect(hooks("install", "--workspace", dir).stderr).toContain("git repository");
      git(dir, "init", "-q", "--bare");
      expect(hooks("install", "--workspace", dir).stderr).toContain("git repository");
      const { repo, ws } = await committed();
      await fs.rm(path.join(ws, "craftar.yaml"));
      expect(hooks("install", "--workspace", ws).code).toBe(1);
      await fs.writeFile(path.join(ws, "craftar.yaml"), "profile: acme\n");
      expect(hooks("install", "--workspace", ws).code).toBe(1);
      await gone(hookFile(repo));
    });
    it("a workspace path with a quote or a control character", async () => {
      const { repo, root } = await committed();
      const odd = path.join(repo, "it's");
      await fs.mkdir(odd);
      await fs.copyFile(path.join(repo, "craftar.yaml"), path.join(odd, "craftar.yaml"));
      await fs.writeFile(path.join(odd, "craftar.yaml"), `forge: ${path.relative(odd, path.join(root, "forge")).replace(/\\/g, "/")}\nprofile: acme\n`);
      const r = hooks("install", "--workspace", odd);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("quote");
      await gone(hookFile(repo));
    });
    it("warns when forge: comes from craftar.local.yaml", async () => {
      const { ws } = await committed();
      await writeFiles(ws, { "craftar.local.yaml": "forge: ../../forge\n" });
      const r = hooks("install", "--workspace", ws);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("craftar.local.yaml");
    });
  });
});

describe("uninstall", () => {
  it("removes its own, every one with no flag; says so with none", async () => {
    const { repo, ws } = await committed();
    hooks("install", "--pre-push", "--pre-commit", "--workspace", ws);
    expect(hooks("uninstall", "--workspace", ws).code).toBe(0);
    await gone(hookFile(repo));
    await gone(hookFile(repo, "pre-commit"));
    const again = hooks("uninstall", "--workspace", ws);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("no hook");
  });
  it("names a hook by flag: that one alone", async () => {
    const { repo, ws } = await committed();
    hooks("install", "--pre-push", "--pre-commit", "--workspace", ws);
    expect(hooks("uninstall", "--pre-commit", "--workspace", ws).code).toBe(0);
    await gone(hookFile(repo, "pre-commit"));
    await expect(fs.access(hookFile(repo))).resolves.toBeUndefined();
  });
  it("an unmarked hook: refused when named, listed and left otherwise", async () => {
    const { repo, ws } = await committed();
    await fs.writeFile(hookFile(repo), "#!/bin/sh\n");
    expect(hooks("uninstall", "--pre-push", "--workspace", ws).code).toBe(1);
    const r = hooks("uninstall", "--workspace", ws);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("pre-push");
    await expect(fs.access(hookFile(repo))).resolves.toBeUndefined();
  });
  it("another workspace's hook counts as unmarked", async () => {
    const { repo, ws } = await committed("one");
    await fs.mkdir(path.join(repo, "two"));
    await fs.copyFile(path.join(ws, "craftar.yaml"), path.join(repo, "two/craftar.yaml"));
    hooks("install", "--workspace", path.join(repo, "two"));
    expect(hooks("uninstall", "--pre-push", "--workspace", ws).code).toBe(1);
    expect(hooks("uninstall", "--workspace", ws).code).toBe(0);
    await expect(fs.access(hookFile(repo))).resolves.toBeUndefined();
  });
  it("names the backup and leaves it", async () => {
    const { repo, ws } = await committed();
    await fs.writeFile(hookFile(repo), "#!/bin/sh\necho theirs\n");
    hooks("install", "--force", "--workspace", ws);
    const r = hooks("uninstall", "--workspace", ws);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("pre-push.craftar-backup");
    await gone(hookFile(repo));
    await expect(fs.access(`${hookFile(repo)}.craftar-backup`)).resolves.toBeUndefined();
  });
  it("under a core.hooksPath outside the repository: refused, removes nothing", async () => {
    const { repo, ws, root } = await committed();
    const out = path.join(root, "global");
    await fs.mkdir(out);
    await fs.writeFile(path.join(out, "pre-push"), hookScript("pre-push", ".", { blockWhenUnavailable: false }));
    git(repo, "config", "core.hooksPath", out);
    expect(hooks("uninstall", "--workspace", ws).code).toBe(1);
    await expect(fs.access(path.join(out, "pre-push"))).resolves.toBeUndefined();
  });
  it("works with a malformed craftar.yaml, and from a branch without the workspace's directory", async () => {
    const { repo, ws } = await committed("acme/harness");
    hooks("install", "--pre-push", "--pre-commit", "--workspace", ws);
    await fs.writeFile(path.join(ws, "craftar.yaml"), ": : :\n");
    expect(hooks("uninstall", "--pre-commit", "--workspace", ws).code).toBe(0);
    await gone(hookFile(repo, "pre-commit"));
    await fs.rm(path.join(repo, "acme"), { recursive: true });
    expect(hooks("uninstall", "--workspace", ws).code).toBe(0);
    await gone(hookFile(repo));
  });
});

describe("status", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("fails closed on a hooks directory it cannot read", async () => {
    const { repo, ws } = await committed();
    hooks("install", "--workspace", ws);
    const dir = path.join(repo, ".git/hooks");
    await fs.chmod(dir, 0);
    try {
      const r = hooks("status", "--workspace", ws);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("cannot read");
      expect(hooks("uninstall", "--workspace", ws).code).toBe(1);
      const c = JSON.parse(runCli(["doctor", "--json", "--workspace", ws]).stdout).checks.filter((x: { id: string }) => x.id === "git-hooks");
      expect(c[0].level).toBe("warn");
    } finally {
      await fs.chmod(dir, 0o755);
    }
  });
  it("--json is the contract, and never prints a path outside", async () => {
    const { repo, ws, root } = await committed();
    hooks("install", "--workspace", ws);
    await fs.writeFile(hookFile(repo, "pre-commit"), "#!/bin/sh\n");
    expect(JSON.parse(hooks("status", "--json", "--workspace", ws).stdout)).toEqual({
      hooksDir: ".git/hooks",
      hooks: [
        { name: "pre-push", state: "installed", workspace: "." },
        { name: "pre-commit", state: "other", workspace: null },
      ],
    });
    git(repo, "config", "core.hooksPath", ".githooks");
    expect(JSON.parse(hooks("status", "--json", "--workspace", ws).stdout)).toEqual({
      hooksDir: "core.hooksPath (inside the repository)",
      hooks: [
        { name: "pre-push", state: "absent", workspace: null },
        { name: "pre-commit", state: "absent", workspace: null },
      ],
    });
    const out = path.join(root, "global");
    git(repo, "config", "core.hooksPath", out);
    const r = hooks("status", "--json", "--workspace", ws);
    expect(JSON.parse(r.stdout).hooksDir).toBe("core.hooksPath (outside the repository)");
    expect(r.stdout).not.toContain(out);
    expect(hooks("status", "--workspace", ws).stdout).toContain("pre-push");
  });
});

describe("doctor", () => {
  const checks = (ws: string, env: NodeJS.ProcessEnv = {}) =>
    JSON.parse(runCli(["doctor", "--json", "--workspace", ws], { env }).stdout).checks.filter((c: { id: string }) => c.id === "git-hooks");
  it("is absent with no marked hook", async () => {
    const { repo, ws } = await committed();
    expect(checks(ws)).toEqual([]);
    await fs.writeFile(hookFile(repo), "#!/bin/sh\n");
    expect(checks(ws)).toEqual([]);
  });
  it("warns when the hook would find no craftar, and is ok when it would", async () => {
    const { ws, root } = await committed();
    hooks("install", "--workspace", ws);
    const onlyGit = await gitOnly(root);
    const without = checks(ws, { PATH: onlyGit, Path: onlyGit });
    expect(without[0].level).toBe("warn");
    expect(without[0].message).toContain("craftar");
    const bin = path.join(root, "bin");
    // Extensionless, as an npm global install also leaves on Windows, where a bare name is what `sh` finds.
    await writeFiles(bin, { craftar: "#!/bin/sh\n" });
    await fs.chmod(path.join(bin, "craftar"), 0o755);
    const both = [bin, onlyGit].join(path.delimiter);
    const withIt = checks(ws, { PATH: both, Path: both });
    expect(withIt[0].level).toBe("ok");
    expect(withIt[0].message).toContain("pre-push");
  });
  it("warns when a marked hook names another workspace", async () => {
    const { repo, ws } = await committed("one");
    await fs.mkdir(path.join(repo, "two"));
    await fs.copyFile(path.join(ws, "craftar.yaml"), path.join(repo, "two/craftar.yaml"));
    hooks("install", "--workspace", path.join(repo, "two"));
    const c = checks(ws);
    expect(c.some((x: { level: string; message: string }) => x.level === "warn" && x.message.includes("workspace two"))).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("a real push", () => {
  const CLI = path.resolve(__dirname, "../src/cli.ts");
  /** A `craftar` on an absolute PATH entry that runs this checkout. */
  async function onPathCraftar(dir: string) {
    await writeFiles(dir, { craftar: `#!/bin/sh\nCRAFTAR_NO_REGISTRY=1 exec "${process.execPath}" --import "${TSX_LOADER}" "${CLI}" "$@"\n` });
    await fs.chmod(path.join(dir, "craftar"), 0o755);
    return { PATH: `${dir}${path.delimiter}${process.env.PATH}` };
  }
  const push = (repo: string, env: NodeJS.ProcessEnv, ...args: string[]) => {
    const r = spawnSync("git", ["push", ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } });
    return { code: r.status, text: `${r.stdout}${r.stderr}` };
  };
  const remote = (root: string) => {
    const bare = path.join(root, "bare.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    return bare;
  };
  it("is blocked out of sync, passes in sync, skips a deleted ref, and --no-verify bypasses", async () => {
    const { repo, ws, root } = await committed();
    const bare = remote(root);
    const env = await onPathCraftar(path.join(root, "bin"));
    hooks("install", "--workspace", ws);
    expect(push(repo, env, bare, "HEAD:refs/heads/good").code).toBe(0);
    git(repo, "rm", "-q", "--cached", RULE);
    git(repo, "commit", "-qm", "dropped");
    const blocked = push(repo, env, bare, "HEAD:refs/heads/bad");
    expect(blocked.code).not.toBe(0);
    expect(blocked.text).toContain("out of sync");
    expect(() => execFileSync("git", ["rev-parse", "--verify", "-q", "refs/heads/bad"], { cwd: bare, stdio: "pipe" })).toThrow();
    expect(push(repo, env, bare, ":refs/heads/good").code).toBe(0);
    expect(push(repo, env, "--no-verify", bare, "HEAD:refs/heads/bad").code).toBe(0);
  });
  it("checks a repeated SHA once", async () => {
    const { repo, ws, root } = await committed();
    const bare = remote(root);
    const bin = path.join(root, "bin");
    const record = path.join(root, "calls");
    await writeFiles(bin, { craftar: `#!/bin/sh\necho "$*" >> "${record}"\n` });
    await fs.chmod(path.join(bin, "craftar"), 0o755);
    hooks("install", "--workspace", ws);
    expect(push(repo, { PATH: `${bin}${path.delimiter}${process.env.PATH}` }, bare, "HEAD:refs/heads/a", "HEAD:refs/heads/b").code).toBe(0);
    expect((await read(record)).trim().split("\n")).toHaveLength(1);
  });
  it("passes with no craftar on PATH, and does not run one under the repository or by a relative entry", async () => {
    const { repo, ws, root } = await committed();
    const bare = remote(root);
    hooks("install", "--workspace", ws);
    const record = path.join(root, "ran");
    const planted = path.join(repo, "planted");
    await writeFiles(planted, { craftar: `#!/bin/sh\necho ran >> "${record}"\nexit 1\n` });
    await fs.chmod(path.join(planted, "craftar"), 0o755);
    const base = process.env.PATH;
    for (const entry of [planted, "planted"]) {
      const r = push(repo, { PATH: `${entry}${path.delimiter}${base}` }, bare, `HEAD:refs/heads/x${entry.length}`);
      expect(r.code).toBe(0);
      expect(r.text).toContain("craftar not found on PATH");
    }
    await gone(record);
    const none = push(repo, { PATH: await gitOnly(root) }, bare, "HEAD:refs/heads/none");
    expect(none.code).toBe(0);
    expect(none.text).toContain("craftar not found on PATH");
  });
  it("under pre-commit, reads the index", async () => {
    const { repo, ws, root } = await committed();
    const env = await onPathCraftar(path.join(root, "bin"));
    hooks("install", "--pre-commit", "--workspace", ws);
    await fs.writeFile(path.join(ws, RULE), "hand edit\n");
    git(repo, "add", RULE);
    expect(() => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "edit"], { cwd: repo, stdio: "pipe", env: { ...process.env, ...env } })).toThrow();
  });
  it("--block-when-unavailable blocks a Forge that cannot be had; without it, passes", async () => {
    const { repo, ws, root, forge } = await committed();
    const bare = remote(root);
    const env = await onPathCraftar(path.join(root, "bin"));
    hooks("install", "--workspace", ws);
    await removeWithRetry(forge);
    expect(push(repo, env, bare, "HEAD:refs/heads/a").code).toBe(0);
    git(repo, "commit", "-qm", "e", "--allow-empty");
    await fs.rm(hookFile(repo));
    await makeForge(forge, FORGE);
    hooks("install", "--block-when-unavailable", "--workspace", ws);
    await removeWithRetry(forge);
    expect(push(repo, env, bare, "HEAD:refs/heads/b").code).not.toBe(0);
  });
});
