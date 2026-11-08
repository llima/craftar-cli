import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";
import { hermeticGit } from "./helpers/hermetic-git.js";
import { removeWithRetry } from "./helpers/fs.js";
import { atLeastWin32 } from "./helpers/timeouts.js";

// Spec 62 — `craftar setup`, the flags form, end to end through the real CLI and a real git in temporary directories.

hermeticGit();

const IDENTITY = {
  GIT_AUTHOR_NAME: "craftar-test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "craftar-test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const T = atLeastWin32(60_000);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function sandbox() {
  const root = await fs.realpath(await tmpDir("craftar-setup-cli-"));
  cleanups.push(() => removeWithRetry(root));
  const home = path.join(root, "home");
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => runCli(args, { cwd: root, env: { CRAFTAR_HOME: home, ...IDENTITY, ...env } });
  return { root, home, run };
}

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "").trim() };
};

/** Every file under `dir` with a hash of its bytes, so a refusal can be shown to change nothing. */
async function tree(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  let ents;
  try {
    ents = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(`${r}/`, ...(await tree(dir, r)));
    else out.push(`${r} ${createHash("sha256").update(await fs.readFile(path.join(dir, r))).digest("hex")}`);
  }
  return out.sort();
}

const states = (run: (a: string[]) => { stdout: string }, ws: string) =>
  (JSON.parse(run(["status", "--json", "--workspace", ws]).stdout) as { statuses: { state: string }[] }).statuses.map((f) => f.state);

describe("craftar setup — the flags form", () => {
  it("creates the Forge, one commit with no remote, and starts the workspace with the starter rule (§10.1 item 1)", async () => {
    const { root, run } = await sandbox();
    const r = run(["setup", "--forge-dir", "acme-forge", "--profile", "acme", "--workspace", "ws"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const forge = path.join(root, "acme-forge");
    expect(git(forge, "rev-list", "--count", "HEAD").out).toBe("1");
    expect(git(forge, "log", "-1", "--format=%s").out).toBe("chore: create Forge with craftar setup");
    expect(git(forge, "remote").out).toBe("");
    expect(git(forge, "status", "--porcelain").out).toBe("");
    expect(await fs.readFile(path.join(forge, "craftar.forge.yaml"), "utf8")).toContain("name: acme-forge\nschema: 1\n");
    const ws = path.join(root, "ws");
    expect(await fs.readFile(path.join(ws, "craftar.yaml"), "utf8")).toBe("forge: ../acme-forge\nprofile: acme\n");
    await fs.access(path.join(ws, "craftar.lock"));
    expect(await fs.readFile(path.join(ws, ".claude/rules/project-conventions.md"), "utf8")).toContain("# Project conventions");
    expect(r.stdout).toMatch(/git: initial commit [0-9a-f]{7,} \(no remote\)/);
    expect(states(run, ws).every((s) => s === "unchanged")).toBe(true);
  }, T);

  it("imports a workspace holding .claude/ and its first sync adopts it (§10.1 item 2, test 5)", async () => {
    const { root, run } = await sandbox();
    await writeFiles(path.join(root, "ws"), { ".claude/rules/workflow.md": "# Workflow\n" });
    const r = run(["setup", "--forge-dir", "f", "--name", "team-forge", "--profile", "acme", "--workspace", "ws", "--import"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const forge = path.join(root, "f");
    expect(await fs.readFile(path.join(forge, "craftar.forge.yaml"), "utf8")).toContain("name: team-forge\n");
    await expect(fs.access(path.join(forge, "ingredients/rules/project-conventions"))).rejects.toThrow();
    const committed = git(forge, "ls-files").out.split("\n");
    expect(committed).toContain("ingredients/rules/workflow/rule.md");
    expect(committed).toContain("profiles/acme/profile.yaml");
    expect(git(forge, "status", "--porcelain").out).toBe("");
    expect(await fs.readFile(path.join(root, "ws/.claude/rules/workflow.md"), "utf8")).toBe("# Workflow\n");
    expect(states(run, path.join(root, "ws")).every((s) => s === "unchanged")).toBe(true);
  }, T);

  it("declares the lowest schema the targets need, and notes a starter no target writes (S12)", async () => {
    const { root, run } = await sandbox();
    const r = run(["setup", "--forge-dir", "f", "--profile", "acme", "--targets", "opencode"]);
    expect(r.code).toBe(0);
    expect(await fs.readFile(path.join(root, "f/craftar.forge.yaml"), "utf8")).toContain("schema: 18\n");
    expect(r.stdout).toContain("the starter rule reaches no file for these targets");
    const codex = run(["setup", "--forge-dir", "g", "--profile", "acme", "--targets", "codex"]);
    expect(codex.stdout).toContain("the starter rule reaches no file for these targets");
    const kiro = run(["setup", "--forge-dir", "h", "--profile", "acme", "--targets", "kiro,cursor"]);
    expect(kiro.stdout).not.toContain("reaches no file");
    expect(await fs.readFile(path.join(root, "h/craftar.forge.yaml"), "utf8")).toContain("schema: 15\n");
  }, T);

  it("--no-git writes no repository; --no-starter writes the skeleton and the first sync writes nothing (test 10)", async () => {
    const { root, run } = await sandbox();
    const a = run(["setup", "--forge-dir", "f", "--profile", "acme", "--no-git"]);
    expect(a.code).toBe(0);
    await expect(fs.access(path.join(root, "f/.git"))).rejects.toThrow();
    expect(a.stdout).toContain("git: none (--no-git)");
    const b = run(["setup", "--forge-dir", "g", "--profile", "acme", "--no-starter", "--workspace", "ws"]);
    expect(b.code).toBe(0);
    expect(await fs.readFile(path.join(root, "g/recipes/.gitkeep"), "utf8")).toBe("");
    expect(await fs.readFile(path.join(root, "g/ingredients/.gitkeep"), "utf8")).toBe("");
    expect(b.stdout).toContain("wrote 0");
  }, T);

  it("fills a Forge directory that exists and is empty", async () => {
    const { root, run } = await sandbox();
    await fs.mkdir(path.join(root, "f"));
    const r = run(["setup", "--forge-dir", "f", "--profile", "acme"]);
    expect(r.code).toBe(0);
    expect(git(path.join(root, "f"), "rev-list", "--count", "HEAD").out).toBe("1");
  }, T);
});

describe("craftar setup — refusals before any write (§4.3, test 3)", () => {
  const cases: Array<[string, (root: string) => Promise<void>, string[], RegExp, NodeJS.ProcessEnv?]> = [
    ["S1 profile", async () => {}, ["--forge-dir", "f", "--profile", "Acme"], /is not a profile name/],
    ["S1 name", async () => {}, ["--forge-dir", "f", "--profile", "acme", "--name", "Bad Name"], /--name: .* is not a Forge name/],
    ["S1 workspace twice", async () => {}, ["--forge-dir", "f", "--profile", "acme", "--workspace", "w", "--workspace", "w"], /--workspace w is given twice/],
    ["S2 nest", async () => {}, ["--forge-dir", "w/f", "--profile", "acme", "--workspace", "w"], /the Forge and a workspace cannot nest/],
    ["S3 not empty", async (root) => writeFiles(path.join(root, "f"), { "x.txt": "x" }), ["--forge-dir", "f", "--profile", "acme"], /exists and is not empty/],
    ["S3 a file", async (root) => writeFiles(root, { f: "x" }), ["--forge-dir", "f", "--profile", "acme"], /exists and is not empty/],
    ["S4 cache tree", async (root) => fs.mkdir(path.join(root, "home/forges"), { recursive: true }).then(() => undefined), ["--forge-dir", "home/forges/x", "--profile", "acme"], /forges/],
    ["S5 gemini", async () => {}, ["--forge-dir", "f", "--profile", "acme", "--targets", "gemini"], /gemini target was removed/],
    ["S5 unknown", async () => {}, ["--forge-dir", "f", "--profile", "acme", "--targets", "vim"], /unknown target "vim"/],
    ["S6 no git", async () => {}, ["--forge-dir", "f", "--profile", "acme"], /git is needed/, { PATH: "", Path: "" }],
    ["S7 started", async (root) => writeFiles(path.join(root, "w"), { "craftar.yaml": "forge: x\nprofile: y\n" }), ["--forge-dir", "f", "--profile", "acme", "--workspace", "w"], /craftar.yaml already exists/],
    ["S8 .claude without a choice", async (root) => writeFiles(path.join(root, "w"), { ".claude/rules/a.md": "a\n" }), ["--forge-dir", "f", "--profile", "acme", "--workspace", "w"], /holds .claude\/ — pass --import/],
    ["S9 two imports", async (root) => {
      await writeFiles(path.join(root, "w"), { ".claude/rules/a.md": "a\n" });
      await writeFiles(path.join(root, "v"), { ".claude/rules/b.md": "b\n" });
    }, ["--forge-dir", "f", "--profile", "acme", "--workspace", "w", "--workspace", "v", "--import"], /setup imports one workspace/],
    ["S11 targets with import", async (root) => writeFiles(path.join(root, "w"), { ".claude/rules/a.md": "a\n" }), ["--forge-dir", "f", "--profile", "acme", "--workspace", "w", "--import", "--targets", "kiro"], /--targets cannot be combined with --import/],
  ];
  for (const [label, prepare, args, words, env] of cases) {
    it(label, async () => {
      const { root, run } = await sandbox();
      await prepare(root);
      const before = await tree(root);
      const r = run(["setup", ...args], env);
      expect(r.code, r.stdout).toBe(1);
      expect(r.stderr).toMatch(words);
      expect(await tree(root)).toEqual(before);
    }, T);
  }

  it("off a terminal with a required flag missing: refused before anything is read", async () => {
    const { root, home, run } = await sandbox();
    const r = run(["setup", "--profile", "acme"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--forge-dir and --profile are required when craftar setup does not run in a terminal");
    await expect(fs.access(home)).rejects.toThrow();
    expect(await tree(root)).toEqual([]);
  }, T);
});

describe.skipIf(process.platform === "win32")("craftar setup — a failure after the first write (§4.8, test 7)", () => {
  it("a refusing pre-commit hook: exit 1, the files listed, the undo printed, no workspace started", async () => {
    const { root, run } = await sandbox();
    await writeFiles(path.join(root, "hooks"), { "pre-commit": "#!/bin/sh\nexit 1\n" });
    await fs.chmod(path.join(root, "hooks/pre-commit"), 0o755);
    const r = run(["setup", "--forge-dir", "it's $f", "--profile", "acme", "--workspace", "ws"], {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: path.join(root, "hooks"),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("setup had already started writing the Forge");
    expect(r.stderr).toContain("  profiles/acme/profile.yaml");
    expect(r.stderr).toContain("  .git");
    const forge = path.join(root, "it's $f");
    expect(r.stderr).toContain(`  rm -rf '${forge.replace(/'/g, `'\\''`)}'`);
    await expect(fs.access(path.join(root, "ws"))).rejects.toThrow();
    // The printed undo works as printed.
    const undo = r.stderr.split("\n").find((l) => l.startsWith("  rm -rf "))!.trim();
    expect(spawnSync("sh", ["-c", undo], { cwd: root }).status).toBe(0);
    await expect(fs.access(forge)).rejects.toThrow();
  }, T);
});

describe("craftar with no arguments (§4.6)", () => {
  it("off a terminal prints commander's help with no setup hint, exit code unchanged", async () => {
    const { run } = await sandbox();
    const r = run([]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain("setup [options]");
    expect(r.stdout + r.stderr).not.toContain("new here?");
  }, T);
});

describe("craftar setup — review round 1", () => {
  it("prints import's summary, a rejected ingredient included (nothing dropped silently)", async () => {
    const { root, run } = await sandbox();
    const token = "ghp_" + "x".repeat(36);
    await writeFiles(path.join(root, "ws"), { ".claude/rules/workflow.md": "# Workflow\n", ".claude/rules/sec.md": `token ${token}\n` });
    const r = run(["setup", "--forge-dir", "f", "--profile", "acme", "--workspace", "ws", "--import"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/1 rejected/);
    expect(r.stdout).toMatch(/rejected rule\/sec — secret-like value/);
    expect(r.stdout + r.stderr).not.toContain(token);
  }, T);

  it("an import refusal comes before any write: the Forge directory is never created", async () => {
    const { root, run } = await sandbox();
    await writeFiles(path.join(root, "ws"), { ".claude/rules/r.md": "<!-- craftar:section tone -->\nx\n<!-- /craftar:section -->\n" });
    const before = await tree(root);
    const r = run(["setup", "--forge-dir", "f", "--profile", "acme", "--workspace", "ws", "--import"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^error: setup: the new Forge would not load and plan — /);
    expect(r.stderr).not.toContain("left untouched");
    expect(r.stderr).not.toContain("craftar-setup-proof-");
    expect(await tree(root)).toEqual(before);
  }, T);

  it("a Forge name YAML would read as a number is quoted, and the Forge loads", async () => {
    const { root, run } = await sandbox();
    const r = run(["setup", "--forge-dir", "123", "--profile", "acme"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(await fs.readFile(path.join(root, "123/craftar.forge.yaml"), "utf8")).toMatch(/^name: "123"\n/);
  }, T);

  it("S6 asks git outside any enclosing repository: an identity only an outer repository holds does not count (test 4)", async () => {
    const { root, run } = await sandbox();
    expect(git(root, "init", "-q").code).toBe(0);
    expect(git(root, "config", "user.name", "outer").code).toBe(0);
    expect(git(root, "config", "user.email", "outer@example.invalid").code).toBe(0);
    const before = await tree(root);
    const r = run(["setup", "--forge-dir", "f", "--profile", "acme"], {
      // Unset (spawnSync drops an undefined value), so only configuration can give the identity.
      GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined, EMAIL: undefined,
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.useConfigOnly", GIT_CONFIG_VALUE_0: "true",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("git is needed to create the Forge's first commit");
    expect(await tree(root)).toEqual(before);
  }, T);

  it("a global ignore rule for .gitkeep and autocrlf with safecrlf do not stop the commit (test 9)", async () => {
    const { root, run } = await sandbox();
    await writeFiles(root, { "global-ignore": ".gitkeep\n" });
    const r = run(["setup", "--forge-dir", "my forge", "--profile", "acme", "--no-starter"], {
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "core.excludesFile", GIT_CONFIG_VALUE_0: path.join(root, "global-ignore"),
      GIT_CONFIG_KEY_1: "core.autocrlf", GIT_CONFIG_VALUE_1: "true",
      GIT_CONFIG_KEY_2: "core.safecrlf", GIT_CONFIG_VALUE_2: "true",
    });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const files = git(path.join(root, "my forge"), "ls-files").out.split("\n");
    expect(files).toContain("recipes/.gitkeep");
    expect(files).toContain("ingredients/.gitkeep");
  }, T);

  it("a workspace path that is a file is refused before any write (S7, init's N9)", async () => {
    const { root, run } = await sandbox();
    await writeFiles(root, { blocked: "x" });
    const before = await tree(root);
    const r = run(["setup", "--forge-dir", "f", "--profile", "acme", "--workspace", "w1", "--workspace", "blocked"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/cannot use .*blocked as a workspace: it is not a directory/);
    expect(await tree(root)).toEqual(before);
  }, T);
});

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("craftar setup — a write that fails before anything exists", () => {
  it("is a plain refusal, with no undo block", async () => {
    const { root, run } = await sandbox();
    await fs.mkdir(path.join(root, "ro"));
    await fs.chmod(path.join(root, "ro"), 0o555);
    cleanups.push(() => fs.chmod(path.join(root, "ro"), 0o755));
    const r = run(["setup", "--forge-dir", "ro/f", "--profile", "acme", "--no-git"]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain("undo with");
    expect(r.stderr).not.toContain("had already started");
  }, T);

  it("a workspace that cannot start says which were started and how to finish; the Forge is kept; exit 1", async () => {
    const { root, run } = await sandbox();
    await fs.mkdir(path.join(root, "ro2"));
    await fs.chmod(path.join(root, "ro2"), 0o555);
    cleanups.push(() => fs.chmod(path.join(root, "ro2"), 0o755));
    const r = run(["setup", "--forge-dir", "f", "--profile", "acme", "--workspace", "w1", "--workspace", "ro2/w2"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/setup created the Forge and started .*w1; .*ro2\/w2 was not started — fix the cause and run craftar init --forge/);
    expect(r.stdout).not.toContain("next: edit the Forge");
    await fs.access(path.join(root, "w1/craftar.lock"));
    expect(git(path.join(root, "f"), "rev-list", "--count", "HEAD").out).toBe("1");
  }, T);
});
