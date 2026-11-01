/**
 * Spec 49 Part B §2.4, §5.2, §5.5: location variables are removed from the environment when craftar
 * starts git, so a craftar command run from a git hook sees its own repository, not the hook's caller.
 *
 * Every test uses real git repositories in temporary directories; nothing leaves the machine.
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execProgram, LOCATION_VARIABLES, onPath, openProgram } from "../src/core/proc.js";
import { GIT_LOCAL_ENV } from "../src/core/clone.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, scenario, tmpDir, writeFiles } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";
import { remoteForge } from "./helpers/remote.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// Clear location variables from process.env to avoid interference from the developer's environment (§2.4).
const CLEARED = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE",
  "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE",
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

const WIN = process.platform === "win32";

/** Create a git repository with one commit, returning its directory and HEAD. */
async function repo(name: string): Promise<{ dir: string; head: string }> {
  const dir = await tmpDir(`craftar-loc-${name}-`);
  cleanups.push(() => removeWithRetry(dir));
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "init", "-q", "-b", "main", dir], { encoding: "utf8" });
  execFileSync("git", ["-C", dir, "config", "maintenance.auto", "false"], { encoding: "utf8" });
  execFileSync("git", ["-C", dir, "config", "gc.auto", "0"], { encoding: "utf8" });
  await writeFiles(dir, { "README.md": `# ${name}\n` });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-C", dir, "add", "README.md"], { encoding: "utf8" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-C", dir, "commit", "-qm", "init"], { encoding: "utf8" });
  const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { dir, head };
}

describe("location variables are removed for git children", () => {
  it("1. execProgram('git', ['-C', forge, 'rev-parse', 'HEAD'], { env: { ...process.env, GIT_DIR: <other> } }) returns forge's HEAD", async () => {
    const forge = await repo("forge");
    const other = await repo("other");
    const { stdout } = await execProgram("git", ["-C", forge.dir, "rev-parse", "HEAD"], {
      env: { ...process.env, GIT_DIR: path.join(other.dir, ".git") },
    });
    expect(stdout.trim()).toBe(forge.head);
  });

  it("2. the same with the absolute path of git (onPath)", async () => {
    const forge = await repo("forge");
    const other = await repo("other");
    const gitPath = await onPath("git", process.env);
    expect(gitPath).not.toBeNull();
    const { stdout } = await execProgram(gitPath!, ["-C", forge.dir, "rev-parse", "HEAD"], {
      env: { ...process.env, GIT_DIR: path.join(other.dir, ".git") },
    });
    expect(stdout.trim()).toBe(forge.head);
  });

  it("3. GIT_WORK_TREE and GIT_INDEX_FILE set to another repository are ignored without keepIndexFile", async () => {
    const forge = await repo("forge");
    const other = await repo("other");
    // Add a file to forge so its index has something
    await writeFiles(forge.dir, { "a.txt": "forge file\n" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-C", forge.dir, "add", "a.txt"], { encoding: "utf8" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-C", forge.dir, "commit", "-qm", "a"], { encoding: "utf8" });
    // Add different files to other
    await writeFiles(other.dir, { "b.txt": "other file\n" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-C", other.dir, "add", "b.txt"], { encoding: "utf8" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-C", other.dir, "commit", "-qm", "b"], { encoding: "utf8" });

    const { stdout } = await execProgram("git", ["-C", forge.dir, "ls-files", "-s"], {
      env: { ...process.env, GIT_WORK_TREE: other.dir, GIT_INDEX_FILE: path.join(other.dir, ".git/index") },
    });
    // Should show forge's files, not other's
    expect(stdout).toContain("a.txt");
    expect(stdout).not.toContain("b.txt");
  });

  it("4. with keepIndexFile: true, an alternate index is read; GIT_DIR is still removed", async () => {
    const forge = await repo("forge");
    const other = await repo("other");
    // Create a subdirectory in forge
    await fs.mkdir(path.join(forge.dir, "sub"), { recursive: true });
    await writeFiles(forge.dir, { "sub/file.txt": "sub file\n" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-C", forge.dir, "add", "sub/file.txt"], { encoding: "utf8" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-C", forge.dir, "commit", "-qm", "sub"], { encoding: "utf8" });

    // Create an alternate index with a different tree (use read-tree to build it)
    const altIndex = path.join(forge.dir, "alt-index");
    // First build a tree with just README.md
    execFileSync("git", ["-C", forge.dir, "read-tree", "--index-output", altIndex, "HEAD~1"], { encoding: "utf8" });

    // Test 4a: absolute index path, run from the root so paths match
    const r1 = await execProgram("git", ["-C", forge.dir, "ls-files", "-s"], {
      env: { ...process.env, GIT_INDEX_FILE: altIndex, GIT_DIR: path.join(other.dir, ".git") },
      keepIndexFile: true,
    });
    // Should NOT contain sub/file.txt because the alt index is from HEAD~1
    expect(r1.stdout).not.toContain("sub/file.txt");
    // Should contain README.md
    expect(r1.stdout).toContain("README.md");

    // Test 4b: relative index path (relative to cwd)
    const relIndex = path.relative(process.cwd(), altIndex);
    const r2 = await execProgram("git", ["-C", forge.dir, "ls-files", "-s"], {
      env: { ...process.env, GIT_INDEX_FILE: relIndex, GIT_DIR: path.join(other.dir, ".git") },
      keepIndexFile: true,
    });
    expect(r2.stdout).not.toContain("sub/file.txt");
    expect(r2.stdout).toContain("README.md");

    // Test that GIT_DIR is removed: rev-parse --show-prefix from sub should be sub/
    const r3 = await execProgram("git", ["-C", path.join(forge.dir, "sub"), "rev-parse", "--show-prefix"], {
      env: { ...process.env, GIT_INDEX_FILE: altIndex, GIT_DIR: path.join(other.dir, ".git") },
      keepIndexFile: true,
    });
    expect(r3.stdout.trim()).toBe("sub/");
  });

  it("5. GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0 reach git", async () => {
    const forge = await repo("forge");
    const { stdout } = await execProgram("git", ["-C", forge.dir, "config", "--get", "acme.key"], {
      env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "acme.key", GIT_CONFIG_VALUE_0: "v" },
    });
    expect(stdout.trim()).toBe("v");
  });

  it("6. a program not named git keeps GIT_DIR", async () => {
    const { stdout } = await execProgram(process.execPath, ["-e", "console.log(process.env.GIT_DIR)"], {
      env: { ...process.env, GIT_DIR: "x" },
    });
    expect(stdout.trim()).toBe("x");
  });

  it("7. LOCATION_VARIABLES plus config vars equals git rev-parse --local-env-vars, and equals GIT_LOCAL_ENV", async () => {
    const { stdout } = await execProgram("git", ["rev-parse", "--local-env-vars"]);
    const fromGit = new Set(stdout.trim().split("\n").filter(Boolean));
    const ourSet = new Set([...LOCATION_VARIABLES, "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"]);
    expect(ourSet).toEqual(fromGit);
    expect(new Set(GIT_LOCAL_ENV)).toEqual(fromGit);
  });
});

describe("openProgram", () => {
  it("8. cat-file --batch returns exact bytes; close() resolves 0; ENOENT for a program on no absolute PATH entry", async () => {
    const r = await repo("forge");
    const bytes = Buffer.from([0xff, 0x00, 0x0a]);
    const blob = path.join(r.dir, "bytes.bin");
    await fs.writeFile(blob, bytes);
    const oid = execFileSync("git", ["-C", r.dir, "hash-object", "-w", "bytes.bin"], { encoding: "utf8" }).trim();
    const child = await openProgram("git", ["-C", r.dir, "cat-file", "--batch"]);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stdin.write(`${oid}\n`);
    expect(await child.close()).toBe(0);
    expect(Buffer.concat(chunks).equals(Buffer.concat([Buffer.from(`${oid} blob 3\n`), bytes, Buffer.from("\n")]))).toBe(true);
    await expect(openProgram("craftar-no-such-program", [], { env: { PATH: "" } })).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("CLI with location variables set", () => {
  it("9. path Forge in its own repo: sync ignores GIT_DIR from caller", async () => {
    const forge = await repo("forge");
    const other = await repo("other");
    // Set up forge as a proper Forge
    await writeFiles(forge.dir, {
      "craftar.forge.yaml": "name: test-forge\nschema: 1\n",
      "ingredients/rules/style/ingredient.yaml": "type: rule\nname: style\n",
      "ingredients/rules/style/rule.md": "# Style\n",
      "recipes/base.yaml": "name: base\ningredients:\n  - rule/style\n",
      "profiles/acme/profile.yaml": "name: acme\nrecipes:\n  - base\ntargets:\n  - claude-code\n",
    });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-C", forge.dir, "add", "-A"], { encoding: "utf8" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-C", forge.dir, "commit", "-qm", "forge"], { encoding: "utf8" });
    const forgeHead = execFileSync("git", ["-C", forge.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    // Create a workspace
    const ws = await tmpDir("craftar-ws-");
    cleanups.push(() => removeWithRetry(ws));
    await writeFiles(ws, {
      "craftar.yaml": `forge: ${forge.dir}\nprofile: acme\n`,
    });

    // Snapshot other repo before
    const otherConfigBefore = await fs.readFile(path.join(other.dir, ".git/config"));
    const otherHeadBefore = await fs.readFile(path.join(other.dir, ".git/HEAD"));

    // Run sync with GIT_DIR pointing to another repo
    const r = runCli(["sync", "--workspace", ws], {
      env: { GIT_DIR: path.join(other.dir, ".git") },
    });
    expect(r.code).toBe(0);

    // Check the lock records the forge's HEAD, not other's
    const lock = JSON.parse(await fs.readFile(path.join(ws, "craftar.lock"), "utf8"));
    expect(lock.forge.commit).toBe(forgeHead);

    // Check other repo is unchanged
    const otherConfigAfter = await fs.readFile(path.join(other.dir, ".git/config"));
    const otherHeadAfter = await fs.readFile(path.join(other.dir, ".git/HEAD"));
    expect(otherConfigAfter).toEqual(otherConfigBefore);
    expect(otherHeadAfter).toEqual(otherHeadBefore);
  });

  it("10. remote Forge: sync ignores GIT_DIR, third repo unchanged", async () => {
    const other = await repo("other");
    // Create a remote forge
    const rf = await remoteForge({
      ingredients: [rule("style", "# Style\n")],
      recipes: [recipe("base", ["rule/style"])],
      profiles: [profile("acme", ["base"])],
    });
    cleanups.push(rf.cleanup);

    // Create CRAFTAR_HOME
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => removeWithRetry(home));

    // Create workspace
    const ws = await tmpDir("craftar-ws-");
    cleanups.push(() => removeWithRetry(ws));
    await writeFiles(ws, {
      "craftar.yaml": `forge: ${rf.url}\nprofile: acme\n`,
    });

    // Snapshot other repo state
    const worktreesBefore = execFileSync("git", ["-C", other.dir, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    const refsBefore = execFileSync("git", ["-C", other.dir, "for-each-ref"], { encoding: "utf8" });

    // Run sync
    const r = runCli(["sync", "--workspace", ws], {
      env: { GIT_DIR: path.join(other.dir, ".git"), CRAFTAR_HOME: home },
    });
    expect(r.code).toBe(0);

    // Check the lock has the remote forge's HEAD
    const lock = JSON.parse(await fs.readFile(path.join(ws, "craftar.lock"), "utf8"));
    const remoteHead = execFileSync("git", ["-C", rf.bare, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(lock.forge.commit).toBe(remoteHead);

    // Check other repo is unchanged (no new ref, no new worktree)
    const worktreesAfter = execFileSync("git", ["-C", other.dir, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    const refsAfter = execFileSync("git", ["-C", other.dir, "for-each-ref"], { encoding: "utf8" });
    expect(worktreesAfter).toBe(worktreesBefore);
    expect(refsAfter).toBe(refsBefore);
  });
});
