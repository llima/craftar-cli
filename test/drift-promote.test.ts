import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";
import { loadWorkspace, plan, readLock, status, apply } from "../src/core/sync.js";
import { profile, recipe, rule, scenario, tmpDir, makeWorkspace } from "./helpers/forge.js";

// Spec 30e: drift promote with variant outcome, gate and proof (one profile, one target).

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const A = ".claude/rules/a.md";
const B = ".claude/rules/b.md";
const C = ".claude/rules/c.md";

/** Git environment variables for predictable commits. */
const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "craftar-test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "craftar-test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
});

/** Initialize a git repo with one commit. */
function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "maintenance.auto", "false"]);
  execFileSync("git", ["-C", dir, "config", "gc.auto", "0"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"], { env: gitEnv() });
}

/** Git porcelain output for the Forge. */
const porcelain = (dir: string) => execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });

/** Add and commit all changes. */
function gitCommit(dir: string, msg: string): void {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", msg], { env: gitEnv() });
}

/** Three rules, one profile, claude-code only. Returns what scenario returns plus helpers. */
async function F() {
  const s = await scenario(
    {
      ingredients: [rule("a", "A one\nA two\n"), rule("b", "B one\nB two\n"), rule("c", "C one\n")],
      recipes: [recipe("base", ["rule/a", "rule/b", "rule/c"])],
      profiles: [profile("acme", ["base"])],
    },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  return {
    ...s,
    ws: s.wsRoot,
    read: (rel: string) => fs.readFile(path.join(s.wsRoot, rel), "utf8"),
    forgeRead: (rel: string) => fs.readFile(path.join(s.forgeRoot, rel), "utf8"),
    lock: async () => JSON.parse(await fs.readFile(path.join(s.wsRoot, "craftar.lock"), "utf8")) as { files: Array<{ path: string; hash: string; target: string; ingredient: string }> },
    lockBytes: () => fs.readFile(path.join(s.wsRoot, "craftar.lock")),
    driftA: () => fs.appendFile(path.join(s.wsRoot, A), "hand a\n"),
    driftB: () => fs.appendFile(path.join(s.wsRoot, B), "hand b\n"),
    orphanDriftC: async () => {
      await fs.appendFile(path.join(s.wsRoot, C), "hand c\n");
      await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), YAML.stringify(recipe("base", ["rule/a", "rule/b"])));
    },
    updateB: () => fs.writeFile(path.join(s.forgeRoot, "ingredients/rules/b/rule.md"), "B one\nB changed\n"),
  };
}

/** List directories in os.tmpdir() matching craftar-promote-* */
async function scratchDirs(): Promise<string[]> {
  const entries = await fs.readdir(os.tmpdir());
  return entries.filter((e) => e.startsWith("craftar-promote-"));
}

describe("cli — drift promote", () => {
  it("1. variant, recipe edited in place", async () => {
    const f = await F();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await f.driftA();
    const lockBefore = await f.lockBytes();
    const scratchBefore = await scratchDirs();

    const P = ["drift", "promote", A, "--workspace", f.ws];
    const r = runCli(P);

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      `promote ${A} → rule/a--acme (variant, profile acme)\n` +
        "  wrote  ingredients/rules/a--acme/ingredient.yaml\n" +
        "  wrote  ingredients/rules/a--acme/rule.md\n" +
        "  edited recipes/base.yaml (ingredients)\n" +
        "  proved: this workspace plans the file on disk; 2 other file(s) unchanged\n" +
        "  next sync: nothing to sync\n" +
        "  no other registered workspace reads this Forge\n" +
        "  the Forge is not committed — review with git, then commit and push it\n",
    );

    // Variant files created
    expect(await f.forgeRead("ingredients/rules/a--acme/rule.md")).toBe("A one\nA two\nhand a\n");
    expect(YAML.parse(await f.forgeRead("ingredients/rules/a--acme/ingredient.yaml"))).toEqual({
      type: "rule",
      name: "a--acme",
      as: "a",
      inclusion: "always",
      file: "rule.md",
      targets: "*",
      tags: [],
      origin: { workspace: "ws", path: ".claude/rules/a.md" },
    });

    // Recipe edited in place
    expect(YAML.parse(await f.forgeRead("recipes/base.yaml")).ingredients).toEqual(["rule/a--acme", "rule/b", "rule/c"]);

    // Base untouched
    expect(await f.forgeRead("ingredients/rules/a/rule.md")).toBe("A one\nA two\n");

    // Git status shows the expected changes
    expect(porcelain(f.forgeRoot)).toBe(" M recipes/base.yaml\n?? ingredients/rules/a--acme/\n");

    // Workspace: lock and a.md unchanged
    expect((await f.lockBytes()).equals(lockBefore)).toBe(true);
    expect(await f.read(A)).toBe("A one\nA two\nhand a\n");

    // Status now reads everything as unchanged
    const st = runCli(["status", "--workspace", f.ws]);
    expect(st.code).toBe(0);
    expect(st.stdout).toBe(
      "craftar status — profile acme · recipes base\n" +
        "  unchanged 3\n" +
        `  unchanged     ${A}\n` +
        `  unchanged     ${B}\n` +
        `  unchanged     ${C}\n`,
    );

    // No scratch directory left
    expect(await scratchDirs()).toEqual(scratchBefore);
  });

  it("2. --dry-run", async () => {
    const f = await F();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await f.driftA();
    const scratchBefore = await scratchDirs();

    const P = ["drift", "promote", A, "--workspace", f.ws, "--dry-run"];
    const r = runCli(P);

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      `promote ${A} → rule/a--acme (variant, profile acme)\n` +
        "  would write ingredients/rules/a--acme/ingredient.yaml\n" +
        "  would write ingredients/rules/a--acme/rule.md\n" +
        "  would edit recipes/base.yaml (ingredients)\n" +
        "  proved: this workspace plans the file on disk; 2 other file(s) unchanged\n" +
        "  next sync: nothing to sync\n" +
        "  no other registered workspace reads this Forge\n" +
        "  dry run — the Forge was not written\n",
    );

    // Forge untouched
    expect(porcelain(f.forgeRoot)).toBe("");

    // No scratch directory left
    expect(await scratchDirs()).toEqual(scratchBefore);
  });

  it("3. the recipe's comment survives", async () => {
    const f = await F();
    // Before gitInit, write the recipe with a comment
    await fs.writeFile(path.join(f.forgeRoot, "recipes/base.yaml"), "name: base\ningredients:\n  - rule/a # the first\n  - rule/b\n  - rule/c\n");
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await f.driftA();

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(0);

    // The comment is preserved
    expect(await f.forgeRead("recipes/base.yaml")).toBe("name: base\ningredients:\n  - rule/a--acme # the first\n  - rule/b\n  - rule/c\n");
  });

  it("4. D4 — three cases: unmanaged, clean, orphan-drift", async () => {
    // Test 1: unmanaged
    {
      const f = await F();
      gitInit(f.forgeRoot);
      expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
      await f.driftA();

      const r1 = runCli(["drift", "promote", "nope.md", "--workspace", f.ws]);
      expect(r1.code).toBe(1);
      expect(r1.stdout).toBe("");
      expect(r1.stderr).toBe(
        "error: nope.md is not a file craftar manages in this workspace — pass the workspace-relative path as `craftar status` prints it (forward slashes)\n",
      );
      expect(porcelain(f.forgeRoot)).toBe("");
    }

    // Test 2: Clean (unchanged)
    {
      const f = await F();
      gitInit(f.forgeRoot);
      expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
      await f.driftA(); // Only drift A

      const r2 = runCli(["drift", "promote", B, "--workspace", f.ws]);
      expect(r2.code).toBe(1);
      expect(r2.stdout).toBe("");
      expect(r2.stderr).toBe(`error: ${B} is not drifted (unchanged) — nothing to promote\n`);
      expect(porcelain(f.forgeRoot)).toBe("");
    }

    // Test 3: Orphan-drift
    {
      const f = await F();
      expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
      await f.orphanDriftC();
      gitInit(f.forgeRoot); // Git init after the recipe change

      const r3 = runCli(["drift", "promote", C, "--workspace", f.ws]);
      expect(r3.code).toBe(1);
      expect(r3.stdout).toBe("");
      expect(r3.stderr).toBe(`error: ${C} is no longer produced by the Forge — nothing to promote into; \`craftar drift discard ${C}\` removes it\n`);
      expect(porcelain(f.forgeRoot)).toBe("");
    }
  });

  it("5. D3 — not a git repository", async () => {
    const f = await F();
    // No gitInit!
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await f.driftA();

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    const realForge = await fs.realpath(f.forgeRoot);
    expect(r.stderr).toBe(`error: ${realForge} is not a git repository with at least one commit — promote needs git to undo its edit\n`);

    // No variant directory was created (the Forge was never a git repo, so no porcelain check)
    await expect(fs.stat(path.join(f.forgeRoot, "ingredients/rules/a--acme"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("6. D2 (path Forge) — --forge points at a different directory", async () => {
    const f = await F();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await f.driftA();

    // Create a second Forge that is NOT a copy - make a new Forge with different content
    const otherDir = await tmpDir("craftar-other-forge-");
    cleanups.push(() => fs.rm(otherDir, { recursive: true, force: true }));
    // Create a minimal forge structure
    await fs.mkdir(path.join(otherDir, "ingredients", "rules", "x"), { recursive: true });
    await fs.writeFile(path.join(otherDir, "craftar.forge.yaml"), YAML.stringify({ name: "other", schema: 1 }));
    await fs.writeFile(path.join(otherDir, "ingredients", "rules", "x", "ingredient.yaml"), YAML.stringify({ type: "rule", name: "x" }));
    await fs.writeFile(path.join(otherDir, "ingredients", "rules", "x", "rule.md"), "x\n");
    await fs.mkdir(path.join(otherDir, "recipes"), { recursive: true });
    await fs.writeFile(path.join(otherDir, "recipes", "base.yaml"), YAML.stringify({ name: "base", ingredients: ["rule/x"] }));
    await fs.mkdir(path.join(otherDir, "profiles", "other"), { recursive: true });
    await fs.writeFile(path.join(otherDir, "profiles", "other", "profile.yaml"), YAML.stringify({ name: "other", recipes: ["base"], targets: ["claude-code"] }));
    gitInit(otherDir);

    const r = runCli(["drift", "promote", A, "--workspace", f.ws, "--forge", otherDir]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    const realForge = await fs.realpath(f.forgeRoot);
    expect(r.stderr).toBe(`error: --forge ${otherDir} is not this workspace's Forge (${realForge})\n`);

    // Both Forges untouched
    expect(porcelain(f.forgeRoot)).toBe("");
    expect(porcelain(otherDir)).toBe("");
  });

  it("7. D1 — remote Forge without --forge", async () => {
    const f = await F();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await f.driftA();

    // Rewrite craftar.yaml to point at a URL
    await fs.writeFile(path.join(f.ws, "craftar.yaml"), YAML.stringify({ forge: "https://example.com/acme/forge.git", profile: "acme" }));

    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const forgesBefore = await fs.readdir(home).catch(() => []);

    const r = runCli(["drift", "promote", A, "--workspace", f.ws], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: the Forge of this workspace is remote, read from a cache craftar never writes — pass `--forge <your clone>`\n");

    // No forges/ entry created
    const forgesAfter = await fs.readdir(home).catch(() => []);
    expect(forgesAfter).toEqual(forgesBefore);
  });

  it("8. D7 (forge changed) — Forge changed since the last sync", async () => {
    const f = await F();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await f.driftA();
    // Change the Forge after the sync
    await fs.writeFile(path.join(f.forgeRoot, "ingredients/rules/a/rule.md"), "A one\nA forge\n");
    gitCommit(f.forgeRoot, "change a");

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      `error: the Forge changed rule/a since the last sync (${A}: drift, forge changed) — a variant taken from the disk would undo that change for profile acme; sync the rest, redo the edit on top, and promote again\n`,
    );
  });

  it("9. D8 — skill file missing on disk", async () => {
    const s = await scenario(
      {
        ingredients: [
          { meta: { type: "skill", name: "s", layout: "dir" }, files: { "SKILL.md": "skill\n", "notes.md": "notes\n" } },
          rule("b", "B\n"),
        ],
        recipes: [recipe("base", ["skill/s", "rule/b"])],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);

    // Append to SKILL.md, delete notes.md
    await fs.appendFile(path.join(s.wsRoot, ".claude/skills/s/SKILL.md"), "edited\n");
    await fs.rm(path.join(s.wsRoot, ".claude/skills/s/notes.md"));

    const r = runCli(["drift", "promote", ".claude/skills/s/SKILL.md", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: .claude/skills/s/notes.md of skill/s is missing on disk — restore it with `craftar sync` first\n");
  });

  it("10. a skill travels whole, a hand-added file is named", async () => {
    const s = await scenario(
      {
        ingredients: [{ meta: { type: "skill", name: "s", layout: "dir" }, files: { "SKILL.md": "skill\n", "notes.md": "notes\n" } }],
        recipes: [recipe("base", ["skill/s"])],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);

    // Append to both files, add a hand file
    await fs.appendFile(path.join(s.wsRoot, ".claude/skills/s/SKILL.md"), "edited skill\n");
    await fs.appendFile(path.join(s.wsRoot, ".claude/skills/s/notes.md"), "edited notes\n");
    await fs.writeFile(path.join(s.wsRoot, ".claude/skills/s/extra.md"), "extra content\n");

    const r = runCli(["drift", "promote", ".claude/skills/s/SKILL.md", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "promote .claude/skills/s/SKILL.md → skill/s--acme (variant, profile acme)\n" +
        "  wrote  ingredients/skills/s--acme/ingredient.yaml\n" +
        "  wrote  ingredients/skills/s--acme/SKILL.md\n" +
        "  wrote  ingredients/skills/s--acme/notes.md\n" +
        "  warn .claude/skills/s/extra.md is not a file craftar generated — not promoted\n" +
        "  edited recipes/base.yaml (ingredients)\n" +
        "  proved: this workspace plans the file on disk; 0 other file(s) unchanged\n" +
        "  next sync: nothing to sync\n" +
        "  no other registered workspace reads this Forge\n" +
        "  the Forge is not committed — review with git, then commit and push it\n",
    );

    // Variant files match disk
    expect(await fs.readFile(path.join(s.forgeRoot, "ingredients/skills/s--acme/SKILL.md"), "utf8")).toBe("skill\nedited skill\n");
    expect(await fs.readFile(path.join(s.forgeRoot, "ingredients/skills/s--acme/notes.md"), "utf8")).toBe("notes\nedited notes\n");

    // extra.md not in the Forge
    await expect(fs.stat(path.join(s.forgeRoot, "ingredients/skills/s--acme/extra.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("11. D9 — secret in the promoted file", async () => {
    const f = await F();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    // Append something that looks like a secret (assembled to avoid accidental literal)
    await fs.appendFile(path.join(f.ws, A), "token: " + "ghp_" + "x".repeat(36) + "\n");

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    // The stderr starts and ends as specified, and does not contain the secret
    expect(r.stderr.startsWith("error: rule/a looks like it holds a secret (")).toBe(true);
    expect(r.stderr.endsWith(") — nothing was written\n")).toBe(true);
    expect(r.stderr.includes("ghp_")).toBe(false);
  });

  it("12. D11 — section marker in the promoted file", async () => {
    const f = await F();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await fs.appendFile(path.join(f.ws, A), "<!-- craftar:section x -->\n");

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`error: ${A}:3 holds a section marker — a variant body cannot hold one; remove it and promote again\n`);
  });

  it("13. D13 (exists) — variant directory already exists", async () => {
    const f = await F();
    // Create the variant ingredient before gitInit (so it's committed)
    await fs.mkdir(path.join(f.forgeRoot, "ingredients/rules/a--acme"), { recursive: true });
    await fs.writeFile(
      path.join(f.forgeRoot, "ingredients/rules/a--acme/ingredient.yaml"),
      YAML.stringify({ type: "rule", name: "a--acme", as: "a", inclusion: "always", file: "rule.md", targets: "*", tags: [] }),
    );
    await fs.writeFile(path.join(f.forgeRoot, "ingredients/rules/a--acme/rule.md"), "old variant\n");
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await f.driftA();

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: ingredients/rules/a--acme already exists in the Forge — promote does not overwrite it\n");
  });

  it("14. D13 (ignored) — variant path is ignored by git", async () => {
    const f = await F();
    await fs.writeFile(path.join(f.forgeRoot, ".gitignore"), "ingredients/rules/a--acme/\n");
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await f.driftA();

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: ingredients/rules/a--acme/ingredient.yaml is ignored by git — git could not show or undo it\n");
  });

  it("15. D14 — three sub-cases on recipe file", async () => {
    const realpath = async (f: Awaited<ReturnType<typeof F>>) => fs.realpath(f.forgeRoot);

    // Case 1: modified and uncommitted
    {
      const f = await F();
      gitInit(f.forgeRoot);
      expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
      await f.driftA();
      await fs.appendFile(path.join(f.forgeRoot, "recipes/base.yaml"), "# modified\n");

      const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      const root = await realpath(f);
      expect(r.stderr).toBe(`error: drift promote can only change files git can restore — 1 path(s) under ${root} are not:\n  recipes/base.yaml is not held by git (modified)\n`);
      await expect(fs.stat(path.join(f.forgeRoot, "ingredients/rules/a--acme"))).rejects.toMatchObject({ code: "ENOENT" });
    }

    // Case 2: untracked
    {
      const f = await F();
      gitInit(f.forgeRoot);
      execFileSync("git", ["-C", f.forgeRoot, "rm", "--cached", "recipes/base.yaml"]);
      // Commit the removal without re-adding (gitCommit uses add -A which would re-add the file)
      execFileSync("git", ["-C", f.forgeRoot, "commit", "-q", "-m", "remove recipe from index"], { env: gitEnv() });
      expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
      await f.driftA();

      const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      const root = await realpath(f);
      expect(r.stderr).toBe(`error: drift promote can only change files git can restore — 1 path(s) under ${root} are not:\n  recipes/base.yaml is not held by git (untracked)\n`);
      await expect(fs.stat(path.join(f.forgeRoot, "ingredients/rules/a--acme"))).rejects.toMatchObject({ code: "ENOENT" });
    }

    // Case 3: assume-unchanged
    {
      const f = await F();
      gitInit(f.forgeRoot);
      execFileSync("git", ["-C", f.forgeRoot, "update-index", "--assume-unchanged", "recipes/base.yaml"]);
      expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
      await f.driftA();

      const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      const root = await realpath(f);
      expect(r.stderr).toBe(`error: drift promote can only change files git can restore — 1 path(s) under ${root} are not:\n  recipes/base.yaml is not held by git (assume-unchanged)\n`);
      await expect(fs.stat(path.join(f.forgeRoot, "ingredients/rules/a--acme"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("16. D15 (the proof bites) — workspace disables the variant", async () => {
    const f = await F();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await f.driftA();
    const scratchBefore = await scratchDirs();

    // Add an override that disables the variant that will be created
    const cfg = YAML.parse(await fs.readFile(path.join(f.ws, "craftar.yaml"), "utf8"));
    cfg.overrides = { ingredients: { disable: ["rule/a--acme"] } };
    await fs.writeFile(path.join(f.ws, "craftar.yaml"), YAML.stringify(cfg));

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: promote could not be proved for this workspace: the planned files would change (3 → 2) — the Forge was left untouched\n");
    expect(porcelain(f.forgeRoot)).toBe("");
    expect(await scratchDirs()).toEqual(scratchBefore);
  });

  it("17. a late write failure names the restore (unit, no CLI)", async () => {
    const f = await F();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await f.driftA();

    // Import planPromote and applyPromote dynamically to avoid issues if the module doesn't exist yet
    const { planPromote, applyPromote } = await import("../src/importers/drift-promote.js");
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));

    const plan = await planPromote({
      workspaceRoot: f.ws,
      forgeDir: null,
      path: A,
      home,
      env: process.env,
    });

    // Create a FILE where the directory should be created
    await fs.writeFile(path.join(f.forgeRoot, "ingredients/rules/a--acme"), "blocker");

    const journal: Array<{ abs: string; created: boolean }> = [];
    await expect(applyPromote(plan, journal)).rejects.toThrow();

    // The journal should show attempted writes
    expect(journal.length).toBeGreaterThan(0);
    // recipes/base.yaml should not have been touched (recipe is written AFTER ingredient)
    expect(await f.forgeRead("recipes/base.yaml")).toBe(
      YAML.stringify({ name: "base", ingredients: ["rule/a", "rule/b", "rule/c"] }),
    );
  });

  it("17b. CLI late-failure: stdout is empty, stderr shows lateFailure message", async () => {
    // This test produces a late failure by making the variant directory writable but the file inside read-only
    // Only works on Linux/macOS; skip on Windows
    if (process.platform === "win32") return;

    const f = await F();
    gitInit(f.forgeRoot);
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    expect(runCli(["sync", "--workspace", f.ws], { env: { CRAFTAR_HOME: home } }).code).toBe(0);
    await f.driftA();

    // Create a read-only rules folder so that mkdir fails during apply
    const rulesDir = path.join(f.forgeRoot, "ingredients/rules");
    await fs.chmod(rulesDir, 0o555);
    cleanups.push(async () => {
      try {
        await fs.chmod(rulesDir, 0o755);
      } catch { /* ignore */ }
    });

    const r = runCli(["drift", "promote", A, "--workspace", f.ws], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    // stderr should contain lateFailure message
    const forgeReal = await fs.realpath(f.forgeRoot);
    expect(r.stderr).toContain(`drift promote had already started changing the Forge (${forgeReal}) when this failed:`);
    expect(r.stderr).toContain("ingredients/rules/a--acme");
    expect(r.stderr).toContain("recover with:");
    expect(r.stderr).toContain("git -C");
  });

  it("18. promote never registers and never touches the lock", async () => {
    const f = await F();
    gitInit(f.forgeRoot);
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));

    // Sync to register the workspace
    expect(runCli(["sync", "--workspace", f.ws], { env: { CRAFTAR_HOME: home } }).code).toBe(0);
    const registryBefore = await fs.readFile(path.join(home, "registry.json"));
    const lockBefore = await f.lockBytes();

    await f.driftA();
    expect(runCli(["drift", "promote", A, "--workspace", f.ws], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    // Registry and lock unchanged
    const registryAfter = await fs.readFile(path.join(home, "registry.json"));
    expect(registryAfter.equals(registryBefore)).toBe(true);
    expect((await f.lockBytes()).equals(lockBefore)).toBe(true);
  });

  it("19. D5 (kiro with hint) — kiro file with claude-code path available", async () => {
    // Profile targets claude-code and kiro, drift on .kiro/steering/a.md
    const s = await scenario(
      {
        ingredients: [rule("a", "A one\nA two\n")],
        recipes: [recipe("base", ["rule/a"])],
        profiles: [profile("acme", ["base"], ["claude-code", "kiro"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);

    // Hand-edit the kiro file
    await fs.appendFile(path.join(s.wsRoot, ".kiro/steering/a.md"), "hand edit\n");
    const lockBefore = await fs.readFile(path.join(s.wsRoot, "craftar.lock"));

    const r = runCli(["drift", "promote", ".kiro/steering/a.md", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: .kiro/steering/a.md is a kiro file — promote reads only what the claude-code target wrote; edit and promote `.claude/rules/a.md` instead\n");
    expect(porcelain(s.forgeRoot)).toBe("");
    expect((await fs.readFile(path.join(s.wsRoot, "craftar.lock"))).equals(lockBefore)).toBe(true);
  });

  it("20. D5 (kiro without hint) — kiro file with kiro-only targets", async () => {
    // Profile targets kiro only, drift on .kiro/steering/a.md
    const s = await scenario(
      {
        ingredients: [rule("a", "A one\nA two\n")],
        recipes: [recipe("base", ["rule/a"])],
        profiles: [profile("acme", ["base"], ["kiro"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);

    // Hand-edit the kiro file
    await fs.appendFile(path.join(s.wsRoot, ".kiro/steering/a.md"), "hand edit\n");
    const lockBefore = await fs.readFile(path.join(s.wsRoot, "craftar.lock"));

    const r = runCli(["drift", "promote", ".kiro/steering/a.md", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: .kiro/steering/a.md is a kiro file — promote reads only what the claude-code target wrote\n");
    expect(porcelain(s.forgeRoot)).toBe("");
    expect((await fs.readFile(path.join(s.wsRoot, "craftar.lock"))).equals(lockBefore)).toBe(true);
  });

  it("21. D5 (agents-md) — AGENTS.md file", async () => {
    // Profile targets claude-code and agents-md, drift on AGENTS.md
    const s = await scenario(
      {
        ingredients: [rule("a", "A one\nA two\n")],
        recipes: [recipe("base", ["rule/a"])],
        profiles: [profile("acme", ["base"], ["claude-code", "agents-md"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);

    // Hand-edit AGENTS.md
    await fs.appendFile(path.join(s.wsRoot, "AGENTS.md"), "hand edit\n");
    const lockBefore = await fs.readFile(path.join(s.wsRoot, "craftar.lock"));

    const r = runCli(["drift", "promote", "AGENTS.md", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: AGENTS.md holds several rules in one file — promote reads only what the claude-code target wrote\n");
    expect(porcelain(s.forgeRoot)).toBe("");
    expect((await fs.readFile(path.join(s.wsRoot, "craftar.lock"))).equals(lockBefore)).toBe(true);
  });

  it("22. D6 — .mcp.json file", async () => {
    // An mcp ingredient in the recipe, drift on .mcp.json
    const s = await scenario(
      {
        ingredients: [rule("a", "A\n"), { meta: { type: "mcp", name: "srv", server: { command: "npx", args: ["srv"] } } }],
        recipes: [recipe("base", ["rule/a", "mcp/srv"])],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);

    // Hand-edit .mcp.json
    const mcpPath = path.join(s.wsRoot, ".mcp.json");
    const mcpContent = JSON.parse(await fs.readFile(mcpPath, "utf8"));
    mcpContent.mcpServers.srv.args = ["srv-edited"];
    await fs.writeFile(mcpPath, JSON.stringify(mcpContent, null, 2));
    const lockBefore = await fs.readFile(path.join(s.wsRoot, "craftar.lock"));

    const r = runCli(["drift", "promote", ".mcp.json", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: .mcp.json holds every mcp ingredient in one file — edit the mcp ingredient in the Forge\n");
    expect(porcelain(s.forgeRoot)).toBe("");
    expect((await fs.readFile(path.join(s.wsRoot, "craftar.lock"))).equals(lockBefore)).toBe(true);
  });
});

// Step 30f: recipe placement, existing variant, three targets

/** Two profiles sharing `base`. */
async function M() {
  const s = await scenario(
    {
      ingredients: [rule("a", "A one\nA two\n"), rule("b", "B one\nB two\n"), rule("c", "C one\n")],
      recipes: [recipe("base", ["rule/a", "rule/b", "rule/c"])],
      profiles: [profile("acme", ["base"]), profile("globex", ["base"])],
    },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  return {
    ...s,
    ws: s.wsRoot,
    read: (rel: string) => fs.readFile(path.join(s.wsRoot, rel), "utf8"),
    forgeRead: (rel: string) => fs.readFile(path.join(s.forgeRoot, rel), "utf8"),
    lockBytes: () => fs.readFile(path.join(s.wsRoot, "craftar.lock")),
    driftA: () => fs.appendFile(path.join(s.wsRoot, A), "hand a\n"),
  };
}

/** Three targets profile. */
async function T() {
  const s = await scenario(
    {
      ingredients: [rule("a", "A one\nA two\n"), rule("b", "B one\nB two\n"), rule("c", "C one\n")],
      recipes: [recipe("base", ["rule/a", "rule/b", "rule/c"])],
      profiles: [profile("acme", ["base"], ["claude-code", "kiro", "agents-md"])],
    },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  return {
    ...s,
    ws: s.wsRoot,
    read: (rel: string) => fs.readFile(path.join(s.wsRoot, rel), "utf8"),
    forgeRead: (rel: string) => fs.readFile(path.join(s.forgeRoot, rel), "utf8"),
    lockBytes: () => fs.readFile(path.join(s.wsRoot, "craftar.lock")),
    driftA: () => fs.appendFile(path.join(s.wsRoot, A), "hand a\n"),
    driftB: () => fs.appendFile(path.join(s.wsRoot, B), "hand b\n"),
    driftC: () => fs.appendFile(path.join(s.wsRoot, C), "hand c\n"),
  };
}

describe("cli — drift promote (step 30f)", () => {
  it("23. case 2 — recipe forked for this profile, profile edited", async () => {
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const f = await M();
    gitInit(f.forgeRoot);
    // Sync acme workspace
    expect(runCli(["sync", "--workspace", f.ws], { env: { CRAFTAR_HOME: home } }).code).toBe(0);
    // Create and sync a globex workspace so status can confirm it's unchanged
    const ws2 = path.join(f.root, "ws2");
    await makeWorkspace(ws2, f.forgeRoot, { config: { profile: "globex" } });
    expect(runCli(["sync", "--workspace", ws2], { env: { CRAFTAR_HOME: home } }).code).toBe(0);
    const baseYamlBefore = await f.forgeRead("recipes/base.yaml");
    const globexProfileBefore = await f.forgeRead("profiles/globex/profile.yaml");

    await f.driftA();
    const lockBefore = await f.lockBytes();

    const r = runCli(["drift", "promote", A, "--workspace", f.ws], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    // Note: no "no other registered workspace" line because ws2 (globex) is registered.
    // Globex is unchanged (uses original base recipe), so no impact line for same-profile.
    expect(r.stdout).toBe(
      `promote ${A} → rule/a--acme (variant, profile acme)\n` +
        "  wrote  ingredients/rules/a--acme/ingredient.yaml\n" +
        "  wrote  ingredients/rules/a--acme/rule.md\n" +
        "  wrote  recipes/base--acme.yaml\n" +
        "  edited profiles/acme/profile.yaml (recipes)\n" +
        "  proved: this workspace plans the file on disk; 2 other file(s) unchanged\n" +
        "  next sync: nothing to sync\n" +
        "  the Forge is not committed — review with git, then commit and push it\n",
    );

    // The forked recipe has the correct content
    expect(YAML.parse(await f.forgeRead("recipes/base--acme.yaml"))).toEqual({ name: "base--acme", ingredients: ["rule/a--acme", "rule/b", "rule/c"] });

    // The original base recipe is untouched
    expect(await f.forgeRead("recipes/base.yaml")).toBe(baseYamlBefore);

    // Profile acme now uses base--acme
    expect(YAML.parse(await f.forgeRead("profiles/acme/profile.yaml")).recipes).toEqual(["base--acme"]);

    // Profile globex is untouched
    expect(await f.forgeRead("profiles/globex/profile.yaml")).toBe(globexProfileBefore);

    // A workspace of globex reads status all unchanged
    const st2 = runCli(["status", "--workspace", ws2]);
    expect(st2.code).toBe(0);
    expect(st2.stdout).toBe(
      "craftar status — profile globex · recipes base\n" +
        "  unchanged 3\n" +
        `  unchanged     ${A}\n` +
        `  unchanged     ${B}\n` +
        `  unchanged     ${C}\n`,
    );
  });

  it("24. case 2 keeps the slot", async () => {
    // Profile acme with recipes: ["pre", "base", "post"]
    const s = await scenario(
      {
        ingredients: [
          rule("a", "A one\n"),
          rule("b", "B one\n"),
          rule("c", "C one\n"),
          rule("p", "P rule\n"),
          rule("q", "Q rule\n"),
        ],
        recipes: [
          recipe("pre", ["rule/p"]),
          recipe("base", ["rule/a", "rule/b", "rule/c"]),
          recipe("post", ["rule/q"]),
        ],
        profiles: [
          profile("acme", ["pre", "base", "post"]),
          profile("globex", ["pre", "base", "post"]),
        ],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    await fs.appendFile(path.join(s.wsRoot, A), "hand a\n");

    const r = runCli(["drift", "promote", A, "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);

    // Profile's recipes keep the slot order
    expect(YAML.parse(await fs.readFile(path.join(s.forgeRoot, "profiles/acme/profile.yaml"), "utf8")).recipes).toEqual(["pre", "base--acme", "post"]);
  });

  it("25. D13 for the recipe file", async () => {
    const f = await M();
    // Create recipes/base--acme.yaml before gitInit (a recipe nobody uses)
    await fs.writeFile(path.join(f.forgeRoot, "recipes/base--acme.yaml"), YAML.stringify({ name: "base--acme", ingredients: [] }));
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await f.driftA();

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: recipes/base--acme.yaml already exists in the Forge — promote does not overwrite it\n");
  });

  it("26. D17 — extends chain", async () => {
    // Recipe `top` extends `base`; both profiles use `["top"]`
    const s = await scenario(
      {
        ingredients: [rule("a", "A one\n")],
        recipes: [
          recipe("base", ["rule/a"]),
          { name: "top", extends: ["base"], ingredients: [] },
        ],
        profiles: [
          profile("acme", ["top"]),
          profile("globex", ["top"]),
        ],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    await fs.appendFile(path.join(s.wsRoot, A), "hand a\n");

    const r = runCli(["drift", "promote", A, "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: recipe base reaches this workspace through top → base — promote does not fork a recipe chain; re-import the workspace or edit the recipes by hand\n");
    expect(porcelain(s.forgeRoot)).toBe("");
  });

  it("27. D17 — recipes.add", async () => {
    // Recipe `extra` in no profile; ws craftar.yaml has recipes: { add: ["extra"] }
    const s = await scenario(
      {
        ingredients: [rule("a", "A\n"), rule("c", "C\n")],
        recipes: [
          recipe("base", ["rule/a"]),
          recipe("extra", ["rule/c"]),
        ],
        profiles: [
          profile("acme", ["base"]),
          profile("globex", ["base"]),
        ],
      },
      { config: { profile: "acme", recipes: { add: ["extra"] } } },
    );
    cleanups.push(s.cleanup);
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    await fs.appendFile(path.join(s.wsRoot, C), "hand c\n");

    const r = runCli(["drift", "promote", C, "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: recipe extra reaches this workspace through recipes.add (craftar.yaml) — promote does not fork a recipe chain; re-import the workspace or edit the recipes by hand\n");
    expect(porcelain(s.forgeRoot)).toBe("");
  });

  it("28. D17 — listed and extended", async () => {
    // acme and globex both ["base", "top"] with top extending base
    const s = await scenario(
      {
        ingredients: [rule("a", "A one\n")],
        recipes: [
          recipe("base", ["rule/a"]),
          { name: "top", extends: ["base"], ingredients: [] },
        ],
        profiles: [
          profile("acme", ["base", "top"]),
          profile("globex", ["base", "top"]),
        ],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    await fs.appendFile(path.join(s.wsRoot, A), "hand a\n");

    const r = runCli(["drift", "promote", A, "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: recipe base reaches this workspace through top → base — promote does not fork a recipe chain; re-import the workspace or edit the recipes by hand\n");
    expect(porcelain(s.forgeRoot)).toBe("");
  });

  it("29. variant-updated", async () => {
    // Run test 1's promote, commit the Forge, sync, append again
    const f = await F();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await f.driftA();
    expect(runCli(["drift", "promote", A, "--workspace", f.ws]).code).toBe(0);
    gitCommit(f.forgeRoot, "first promote");
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await fs.appendFile(path.join(f.ws, A), "hand again\n");

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      `promote ${A} → rule/a--acme (variant-updated, profile acme)\n` +
        "  edited ingredients/rules/a--acme/rule.md\n" +
        "  proved: this workspace plans the file on disk; 2 other file(s) unchanged\n" +
        "  next sync: nothing to sync\n" +
        "  no other registered workspace reads this Forge\n" +
        "  the Forge is not committed — review with git, then commit and push it\n",
    );

    // The variant rule.md is updated
    expect(await f.forgeRead("ingredients/rules/a--acme/rule.md")).toBe("A one\nA two\nhand a\nhand again\n");

    // No a--acme--acme directory
    await expect(fs.stat(path.join(f.forgeRoot, "ingredients/rules/a--acme--acme"))).rejects.toMatchObject({ code: "ENOENT" });

    // Git porcelain shows exactly the rule.md modified
    expect(porcelain(f.forgeRoot)).toBe(" M ingredients/rules/a--acme/rule.md\n");
  });

  it("30. D10 — another profile resolves the variant", async () => {
    // Forge where globex's recipe lists rule/a--acme (built by hand, committed) and acme resolves it too
    const s = await scenario(
      {
        ingredients: [
          rule("a", "A one\n"),
          { meta: { type: "rule", name: "a--acme", as: "a", inclusion: "always", file: "rule.md", targets: "*", tags: [] }, files: { "rule.md": "variant\n" } },
        ],
        recipes: [
          recipe("base", ["rule/a--acme"]), // both use the variant directly
        ],
        profiles: [
          profile("acme", ["base"]),
          profile("globex", ["base"]),
        ],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    await fs.appendFile(path.join(s.wsRoot, A), "hand a\n");

    const r = runCli(["drift", "promote", A, "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: rule/a--acme is also used by profile globex — its files would change there\n");
    expect(porcelain(s.forgeRoot)).toBe("");
  });

  it("31. another profile's variant → new variant for this profile", async () => {
    // Forge with rule/a, a hand-built rule/a--globex (as: a), recipe shared → ["rule/a--globex"] used by BOTH
    const s = await scenario(
      {
        ingredients: [
          rule("a", "A base\n"),
          { meta: { type: "rule", name: "a--globex", as: "a", inclusion: "always", file: "rule.md", targets: "*", tags: [] }, files: { "rule.md": "G one\n" } },
        ],
        recipes: [
          recipe("shared", ["rule/a--globex"]),
        ],
        profiles: [
          profile("acme", ["shared"]),
          profile("globex", ["shared"]),
        ],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    await fs.appendFile(path.join(s.wsRoot, A), "hand acme\n");

    const r = runCli(["drift", "promote", A, "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");

    // A new variant a--acme was created
    const variantMeta = YAML.parse(await fs.readFile(path.join(s.forgeRoot, "ingredients/rules/a--acme/ingredient.yaml"), "utf8"));
    expect(variantMeta.name).toBe("a--acme");
    expect(variantMeta.as).toBe("a");

    // The forked recipe shared--acme references the new variant
    expect(YAML.parse(await fs.readFile(path.join(s.forgeRoot, "recipes/shared--acme.yaml"), "utf8")).ingredients).toEqual(["rule/a--acme"]);

    // The old variant is byte-equal
    expect(await fs.readFile(path.join(s.forgeRoot, "ingredients/rules/a--globex/rule.md"), "utf8")).toBe("G one\n");

    // No a--globex--acme directory
    await expect(fs.stat(path.join(s.forgeRoot, "ingredients/rules/a--globex--acme"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("32. a base whose `as` differs from its name", async () => {
    // Rule ingredient { type: "rule", name: "a-src", as: "a" }
    const s = await scenario(
      {
        ingredients: [
          { meta: { type: "rule", name: "a-src", as: "a", inclusion: "always", file: "rule.md", targets: "*", tags: [] }, files: { "rule.md": "A base\n" } },
        ],
        recipes: [
          recipe("base", ["rule/a-src"]),
        ],
        profiles: [
          profile("acme", ["base"]),
          profile("globex", ["base"]),
        ],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    await fs.appendFile(path.join(s.wsRoot, A), "hand a\n");

    const r = runCli(["drift", "promote", A, "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);

    // The variant is rule/a--acme (as: "a"), NOT a-src--acme
    const variantMeta = YAML.parse(await fs.readFile(path.join(s.forgeRoot, "ingredients/rules/a--acme/ingredient.yaml"), "utf8"));
    expect(variantMeta.name).toBe("a--acme");
    expect(variantMeta.as).toBe("a");
  });
});

// Step 30f: three targets tests
describe("cli — drift promote (three targets)", () => {
  it("33. dependents", async () => {
    const f = await T();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);

    // Save synced AGENTS.md for later comparison
    const agentsMd = await f.read("AGENTS.md");

    await f.driftA();

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    // Whole stdout pinned — the shared home's registry has no workspace for this fresh Forge
    expect(r.stdout).toBe(
      `promote ${A} → rule/a--acme (variant, profile acme)\n` +
        "  wrote  ingredients/rules/a--acme/ingredient.yaml\n" +
        "  wrote  ingredients/rules/a--acme/rule.md\n" +
        "  edited recipes/base.yaml (ingredients)\n" +
        "  proved: this workspace plans the file on disk; 4 other file(s) unchanged\n" +
        "  also changes .kiro/steering/a.md, AGENTS.md\n" +
        "  next sync: 2 update — run `craftar sync`\n" +
        "  no other registered workspace reads this Forge\n" +
        "  the Forge is not committed — review with git, then commit and push it\n",
    );

    // Commit nothing, sync
    const s = runCli(["sync", "--workspace", f.ws]);
    expect(s.code).toBe(0);

    // Both contain "hand a" exactly once
    const newKiroA = await f.read(".kiro/steering/a.md");
    const newAgentsMd = await f.read("AGENTS.md");
    expect(newKiroA.split("\n").filter((l: string) => l.replace("\r", "") === "hand a").length).toBe(1);
    expect(newAgentsMd.split("\n").filter((l: string) => l.replace("\r", "") === "hand a").length).toBe(1);

    // AGENTS.md before vs after differs ONLY by that one inserted line
    const withoutHandA = newAgentsMd.replace("hand a\n", "");
    expect(withoutHandA).toBe(agentsMd);
  });

  it("34. the last always-on rule, with a scoped rule after it", async () => {
    // F's rule c made scoped
    const s = await scenario(
      {
        ingredients: [
          rule("a", "A one\nA two\n"),
          rule("b", "B one\nB two\n"),
          { meta: { type: "rule", name: "c", inclusion: "fileMatch", fileMatchPattern: "src/**", file: "rule.md", targets: "*", tags: [] }, files: { "rule.md": "C one\n" } },
        ],
        recipes: [recipe("base", ["rule/a", "rule/b", "rule/c"])],
        profiles: [profile("acme", ["base"], ["claude-code", "kiro", "agents-md"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);

    // Get the ## Scoped rules section of AGENTS.md
    const agentsMdBefore = await fs.readFile(path.join(s.wsRoot, "AGENTS.md"), "utf8");
    const scopedIdx = agentsMdBefore.indexOf("## Scoped rules");
    const scopedTail = scopedIdx >= 0 ? agentsMdBefore.slice(scopedIdx) : "";

    // Drift on b (the last always-on rule)
    await fs.appendFile(path.join(s.wsRoot, B), "hand b\n");

    const r = runCli(["drift", "promote", B, "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);

    // After sync, the ## Scoped rules tail is unchanged
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    const agentsMdAfter = await fs.readFile(path.join(s.wsRoot, "AGENTS.md"), "utf8");
    const scopedIdxAfter = agentsMdAfter.indexOf("## Scoped rules");
    const scopedTailAfter = scopedIdxAfter >= 0 ? agentsMdAfter.slice(scopedIdxAfter) : "";
    expect(scopedTailAfter).toBe(scopedTail);
  });

  it("35. a scoped rule the file only points at", async () => {
    // Drift on c in the scoped Forge from test 34
    const s = await scenario(
      {
        ingredients: [
          rule("a", "A one\n"),
          { meta: { type: "rule", name: "c", inclusion: "fileMatch", fileMatchPattern: "src/**", file: "rule.md", targets: "*", tags: [] }, files: { "rule.md": "C one\n" } },
        ],
        recipes: [recipe("base", ["rule/a", "rule/c"])],
        profiles: [profile("acme", ["base"], ["claude-code", "kiro", "agents-md"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);

    // Get AGENTS.md bytes before
    const agentsMdBefore = await fs.readFile(path.join(s.wsRoot, "AGENTS.md"));

    // Drift on c
    await fs.appendFile(path.join(s.wsRoot, C), "hand c\n");

    const r = runCli(["drift", "promote", C, "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");

    // stdout's also changes line is exactly .kiro/steering/c.md (no AGENTS.md)
    expect(r.stdout).toContain("  also changes .kiro/steering/c.md\n");
    expect(r.stdout).not.toContain("AGENTS.md");

    // After sync, AGENTS.md is byte-equal
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    const agentsMdAfter = await fs.readFile(path.join(s.wsRoot, "AGENTS.md"));
    expect(agentsMdAfter.equals(agentsMdBefore)).toBe(true);
  });

  it("36. D5 — promote .kiro/steering/a.md", async () => {
    const f = await T();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);

    // Drift the kiro file
    await fs.appendFile(path.join(f.ws, ".kiro/steering/a.md"), "hand kiro\n");

    const r = runCli(["drift", "promote", ".kiro/steering/a.md", "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`error: .kiro/steering/a.md is a kiro file — promote reads only what the claude-code target wrote; edit and promote \`.claude/rules/a.md\` instead\n`);
  });

  it("37. D5 — promote AGENTS.md", async () => {
    const f = await T();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);

    // Drift AGENTS.md
    await fs.appendFile(path.join(f.ws, "AGENTS.md"), "hand agents\n");

    const r = runCli(["drift", "promote", "AGENTS.md", "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: AGENTS.md holds several rules in one file — promote reads only what the claude-code target wrote\n");
  });

  it("38. D6 — .mcp.json", async () => {
    const s = await scenario(
      {
        ingredients: [
          rule("a", "A\n"),
          { meta: { type: "mcp", name: "srv", server: { command: "npx", args: ["srv"] } } },
        ],
        recipes: [recipe("base", ["rule/a", "mcp/srv"])],
        profiles: [profile("acme", ["base"], ["claude-code", "kiro", "agents-md"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);

    // Hand-edit .mcp.json
    const mcpPath = path.join(s.wsRoot, ".mcp.json");
    const mcpContent = JSON.parse(await fs.readFile(mcpPath, "utf8"));
    mcpContent.mcpServers.srv.args = ["srv-edited"];
    await fs.writeFile(mcpPath, JSON.stringify(mcpContent, null, 2));

    const r = runCli(["drift", "promote", ".mcp.json", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: .mcp.json holds every mcp ingredient in one file — edit the mcp ingredient in the Forge\n");
  });
});

// Step 30f: agentsBound unit tests
describe("agentsBound (unit)", () => {
  it("39. D16 bound function", async () => {
    const { agentsBound } = await import("../src/importers/drift-promote.js");

    const p0 = "H\n<!-- rule: a -->\nA\n\n<!-- rule: b -->\nB\n\n## Scoped rules\n- x\n";

    // p1 same with A → A\nhand → true
    expect(agentsBound(p0, p0.replace("A\n\n", "A\nhand\n\n"), "a")).toBe(true);

    // p1 with B changed while N = "a" → false
    expect(agentsBound(p0, p0.replace("B\n\n", "Bchanged\n\n"), "a")).toBe(false);

    // p1 with the two rule blocks swapped → false
    const swapped = "H\n<!-- rule: b -->\nB\n\n<!-- rule: a -->\nA\n\n## Scoped rules\n- x\n";
    expect(agentsBound(p0, swapped, "a")).toBe(false);

    // N = "b", p1 with B → B\nhand → true
    expect(agentsBound(p0, p0.replace("B\n\n", "B\nhand\n\n"), "b")).toBe(true);

    // N = "b", p1 with - x → - y → false
    expect(agentsBound(p0, p0.replace("- x", "- y"), "b")).toBe(false);

    // N = "c" (no marker), p1 === p0 → true
    expect(agentsBound(p0, p0, "c")).toBe(true);

    // N = "c" (no marker), p1 different anywhere → false
    expect(agentsBound(p0, p0 + "extra", "c")).toBe(false);
  });

  it("39b. agentsBound EOL normalization — CRLF compares equal to LF", async () => {
    const { agentsBound } = await import("../src/importers/drift-promote.js");

    const p0Lf = "H\n<!-- rule: a -->\nA\n\n<!-- rule: b -->\nB\n\n## Scoped rules\n- x\n";
    const p0Crlf = p0Lf.replace(/\n/g, "\r\n");

    // A change within rule a is allowed, even when one side is CRLF
    const p1Lf = p0Lf.replace("A\n\n", "A\nhand\n\n");
    expect(agentsBound(p0Crlf, p1Lf, "a")).toBe(true);
    expect(agentsBound(p0Lf, p1Lf.replace(/\n/g, "\r\n"), "a")).toBe(true);

    // No marker for "c": p0 CRLF === p1 LF with same logical content
    expect(agentsBound(p0Crlf, p0Lf, "c")).toBe(true);
  });

  it("39c. CRLF AGENTS.md on disk — promote succeeds as the LF case does", async () => {
    // Three-target fixture: AGENTS.md has rule markers
    const f = await T();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);

    // Rewrite AGENTS.md with CRLF line endings
    const agentsMdPath = path.join(f.ws, "AGENTS.md");
    const agentsLf = await fs.readFile(agentsMdPath, "utf8");
    const agentsCrlf = agentsLf.replace(/\n/g, "\r\n");
    await fs.writeFile(agentsMdPath, agentsCrlf);

    // Status should say unchanged for AGENTS.md (EOL-normalized hash)
    const st = runCli(["status", "--workspace", f.ws]);
    expect(st.code).toBe(0);
    expect(st.stdout).toContain("unchanged     AGENTS.md");

    // Drift rule a
    await f.driftA();

    // Promote should succeed (code 0), same as LF case
    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    // The report should have the same structure as the LF case (test 33)
    expect(r.stdout).toContain("  also changes .kiro/steering/a.md, AGENTS.md\n");
    expect(r.stdout).toContain("  next sync: 2 update — run `craftar sync`\n");
  });
});


// Step 30g: params and sections outcomes, flattened, D12

/** A templated rule — fixture P. */
async function P() {
  const s = await scenario(
    {
      ingredients: [
        {
          meta: {
            type: "rule",
            name: "a",
            params: { "scm.org": { default: "acme-org" } },
          },
          files: { "rule.md": "Org: {{scm.org}}\nA two\n" },
        },
        rule("b", "B one\n"),
      ],
      recipes: [recipe("base", ["rule/a", "rule/b"])],
      profiles: [profile("acme", ["base"], ["claude-code"], { params: { "scm.org": "acme-org" } })],
    },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  return {
    ...s,
    ws: s.wsRoot,
    read: (rel: string) => fs.readFile(path.join(s.wsRoot, rel), "utf8"),
    forgeRead: (rel: string) => fs.readFile(path.join(s.forgeRoot, rel), "utf8"),
    lockBytes: () => fs.readFile(path.join(s.wsRoot, "craftar.lock")),
  };
}

/** A sectioned rule — fixture S. */
async function S() {
  const s = await scenario(
    {
      ingredients: [
        rule("a", "S one\n<!-- craftar:section flavors -->\ndefault flavor\n<!-- /craftar:section -->\nS end\n"),
        rule("b", "B one\n"),
      ],
      recipes: [recipe("base", ["rule/a", "rule/b"])],
      profiles: [profile("acme", ["base"])],
    },
    { config: { profile: "acme" } },
  );
  // Set schema: 2 for sections
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 2 }));
  cleanups.push(s.cleanup);
  return {
    ...s,
    ws: s.wsRoot,
    read: (rel: string) => fs.readFile(path.join(s.wsRoot, rel), "utf8"),
    forgeRead: (rel: string) => fs.readFile(path.join(s.forgeRoot, rel), "utf8"),
    lockBytes: () => fs.readFile(path.join(s.wsRoot, "craftar.lock")),
  };
}

describe("cli — drift promote (step 30g: params/sections)", () => {
  it("40. (P+G check) the synced .claude/rules/a.md is the rendered text", async () => {
    const f = await P();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    expect(await f.read(A)).toBe("Org: acme-org\nA two\n");
  });

  it("41. params — edit only the placeholder value → outcome params", async () => {
    const f = await P();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    expect(await f.read(A)).toBe("Org: acme-org\nA two\n");
    await fs.writeFile(path.join(f.ws, A), "Org: globex-org\nA two\n");
    const lockBefore = await f.lockBytes();

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      `promote ${A} → profile acme (params)\n` +
        "  edited profiles/acme/profile.yaml (params)\n" +
        `  param scm.org: "acme-org" → "globex-org"\n` +
        "  proved: this workspace plans the file on disk; 1 other file(s) unchanged\n" +
        "  next sync: nothing to sync\n" +
        "  no other registered workspace reads this Forge\n" +
        "  the Forge is not committed — review with git, then commit and push it\n",
    );

    // Profile now has the new value
    expect(YAML.parse(await f.forgeRead("profiles/acme/profile.yaml")).params).toEqual({ "scm.org": "globex-org" });

    // Forge porcelain shows only the profile edited
    expect(porcelain(f.forgeRoot)).toBe(" M profiles/acme/profile.yaml\n");

    // No variant directory created
    await expect(fs.stat(path.join(f.forgeRoot, "ingredients/rules/a--acme"))).rejects.toMatchObject({ code: "ENOENT" });

    // ingredients/ byte-equal
    const ingBefore = await fs.readdir(path.join(f.forgeRoot, "ingredients/rules"));
    expect(ingBefore.sort()).toEqual(["a", "b"]);
    // Lock unchanged
    expect((await f.lockBytes()).equals(lockBefore)).toBe(true);
  });

  it("42. an edit outside the placeholder is a variant, flattened", async () => {
    const f = await P();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    // Edit with the current param value AND extra text
    await fs.writeFile(path.join(f.ws, A), "Org: acme-org\nA two\nhand\n");

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      `promote ${A} → rule/a--acme (variant, profile acme)\n` +
        "  wrote  ingredients/rules/a--acme/ingredient.yaml\n" +
        "  wrote  ingredients/rules/a--acme/rule.md\n" +
        "  edited recipes/base.yaml (ingredients)\n" +
        "  flattened: 1 param(s) (scm.org)\n" +
        "  proved: this workspace plans the file on disk; 1 other file(s) unchanged\n" +
        "  next sync: nothing to sync\n" +
        "  no other registered workspace reads this Forge\n" +
        "  the Forge is not committed — review with git, then commit and push it\n",
    );

    // The variant's rule.md is the rendered text, no {{
    expect(await f.forgeRead("ingredients/rules/a--acme/rule.md")).toBe("Org: acme-org\nA two\nhand\n");

    // The variant's ingredient.yaml has NO params key
    const variantMeta = YAML.parse(await f.forgeRead("ingredients/rules/a--acme/ingredient.yaml"));
    expect(Object.hasOwn(variantMeta, "params")).toBe(false);
    expect(variantMeta).toEqual({
      type: "rule",
      name: "a--acme",
      as: "a",
      inclusion: "always",
      file: "rule.md",
      targets: "*",
      tags: [],
      origin: { workspace: "ws", path: ".claude/rules/a.md" },
    });
  });

  it("43. D12, param — workspace overrides.params sets the key", async () => {
    const f = await P();
    gitInit(f.forgeRoot);
    // Add overrides.params to craftar.yaml
    const cfg = YAML.parse(await fs.readFile(path.join(f.ws, "craftar.yaml"), "utf8"));
    cfg.overrides = { params: { "scm.org": "ws-org" } };
    await fs.writeFile(path.join(f.ws, "craftar.yaml"), YAML.stringify(cfg));
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    // Verify it synced with the workspace override
    expect(await f.read(A)).toBe("Org: ws-org\nA two\n");
    // Append extra text to trigger a variant outcome
    await fs.appendFile(path.join(f.ws, A), "hand\n");

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      `error: rule/a takes param "scm.org" from this workspace's overrides (craftar.yaml) — a variant would silently stop applying it; edit craftar.yaml, or remove the override and sync first\n`,
    );
    expect(porcelain(f.forgeRoot)).toBe("");
  });

  it("44. (S+G check) the synced .claude/rules/a.md has sections expanded", async () => {
    const f = await S();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    expect(await f.read(A)).toBe("S one\ndefault flavor\nS end\n");
  });

  it("45. sections — edit only the section content → outcome sections", async () => {
    const f = await S();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    expect(await f.read(A)).toBe("S one\ndefault flavor\nS end\n");
    await fs.writeFile(path.join(f.ws, A), "S one\nacme flavor\nS end\n");
    const lockBefore = await f.lockBytes();

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      `promote ${A} → profile acme (sections)\n` +
        "  edited profiles/acme/profile.yaml (sections)\n" +
        "  section rule/a flavors: 1 line(s)\n" +
        "  proved: this workspace plans the file on disk; 1 other file(s) unchanged\n" +
        "  next sync: nothing to sync\n" +
        "  no other registered workspace reads this Forge\n" +
        "  the Forge is not committed — review with git, then commit and push it\n",
    );

    // Profile now has the section value (with trailing newline as canonicalValue adds)
    expect(YAML.parse(await f.forgeRead("profiles/acme/profile.yaml")).sections).toEqual({ "rule/a": { flavors: "acme flavor\n" } });

    // Forge porcelain shows only the profile edited
    expect(porcelain(f.forgeRoot)).toBe(" M profiles/acme/profile.yaml\n");

    // No variant directory
    await expect(fs.stat(path.join(f.forgeRoot, "ingredients/rules/a--acme"))).rejects.toMatchObject({ code: "ENOENT" });
    // Lock unchanged
    expect((await f.lockBytes()).equals(lockBefore)).toBe(true);
  });

  it("46. an edit outside the section is a variant, flattened, with the unused-value warning", async () => {
    const f = await S();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    // First: run test 45's promote to set the profile's section value
    await fs.writeFile(path.join(f.ws, A), "S one\nacme flavor\nS end\n");
    expect(runCli(["drift", "promote", A, "--workspace", f.ws]).code).toBe(0);
    gitCommit(f.forgeRoot, "section promote");
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    // Now append extra text after S end
    await fs.appendFile(path.join(f.ws, A), "hand\n");

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      `promote ${A} → rule/a--acme (variant, profile acme)\n` +
        "  wrote  ingredients/rules/a--acme/ingredient.yaml\n" +
        "  wrote  ingredients/rules/a--acme/rule.md\n" +
        "  edited recipes/base.yaml (ingredients)\n" +
        "  flattened: 1 section(s) (flavors)\n" +
        "  warn profile acme still sets section rule/a flavors, which rule/a--acme no longer holds — every plan will warn until it is removed\n" +
        "  proved: this workspace plans the file on disk; 1 other file(s) unchanged\n" +
        "  next sync: nothing to sync\n" +
        "  no other registered workspace reads this Forge\n" +
        "  the Forge is not committed — review with git, then commit and push it\n",
    );
  });

  it("47. D12, section — workspace overrides.sections sets the section", async () => {
    const f = await S();
    gitInit(f.forgeRoot);
    // Add overrides.sections to craftar.yaml
    const cfg = YAML.parse(await fs.readFile(path.join(f.ws, "craftar.yaml"), "utf8"));
    cfg.overrides = { sections: { "rule/a": { flavors: "ws flavor\n" } } };
    await fs.writeFile(path.join(f.ws, "craftar.yaml"), YAML.stringify(cfg));
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    // Verify it synced with the workspace override
    expect(await f.read(A)).toBe("S one\nws flavor\nS end\n");
    // Append extra text to trigger a variant outcome
    await fs.appendFile(path.join(f.ws, A), "hand\n");

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      `error: rule/a takes section "flavors" from this workspace's overrides (craftar.yaml) — a variant would silently stop applying it; edit craftar.yaml, or remove the override and sync first\n`,
    );
    expect(porcelain(f.forgeRoot)).toBe("");
  });

  it("48. G1: a key only a recipe defaults is compared literally → variant", async () => {
    // Rule a with {{scm.org}} but NO ingredient params, recipe base with params: { "scm.org": { default: "acme-org" } }
    const s = await scenario(
      {
        ingredients: [
          { meta: { type: "rule", name: "a" }, files: { "rule.md": "Org: {{scm.org}}\n" } },
          rule("b", "B one\n"),
        ],
        recipes: [recipe("base", ["rule/a", "rule/b"], { params: { "scm.org": { default: "acme-org" } } })],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // The synced file has the recipe default
    expect(await fs.readFile(path.join(s.wsRoot, A), "utf8")).toBe("Org: acme-org\n");
    // Change it to a different value
    await fs.writeFile(path.join(s.wsRoot, A), "Org: globex-org\n");
    const profileBefore = await fs.readFile(path.join(s.forgeRoot, "profiles/acme/profile.yaml"));

    const r = runCli(["drift", "promote", A, "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    // The first line should show variant outcome, never params
    expect(r.stdout.startsWith(`promote ${A} → rule/a--acme (variant, profile acme)\n`)).toBe(true);
    // Profile is byte-equal (no params were written)
    expect((await fs.readFile(path.join(s.forgeRoot, "profiles/acme/profile.yaml"))).equals(profileBefore)).toBe(true);
  });
});

// Step 30h: other workspaces impact check and --json output

describe("cli — drift promote (step 30h: impact check)", () => {
  it("50. reported, not refused — two workspaces of one profile", async () => {
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const f = await F();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    // Create a second workspace on the same profile
    const ws2 = path.join(f.root, "ws2");
    await makeWorkspace(ws2, f.forgeRoot, { config: { profile: "acme" } });
    expect(runCli(["sync", "--workspace", ws2], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    await f.driftA();
    const realWs2 = await fs.realpath(ws2);

    const P = ["drift", "promote", A, "--workspace", f.ws];
    const r = runCli(P, { env: { CRAFTAR_HOME: home } });

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      `promote ${A} → rule/a--acme (variant, profile acme)\n` +
        "  wrote  ingredients/rules/a--acme/ingredient.yaml\n" +
        "  wrote  ingredients/rules/a--acme/rule.md\n" +
        "  edited recipes/base.yaml (ingredients)\n" +
        "  proved: this workspace plans the file on disk; 2 other file(s) unchanged\n" +
        "  next sync: nothing to sync\n" +
        `  1 other workspace(s) of profile acme read this Forge: ${realWs2} — 1 update\n` +
        "  the Forge is not committed — review with git, then commit and push it\n",
    );
  });

  it("51. --json output", async () => {
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const f = await F();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    // Create a second workspace on the same profile
    const ws2 = path.join(f.root, "ws2");
    await makeWorkspace(ws2, f.forgeRoot, { config: { profile: "acme" } });
    expect(runCli(["sync", "--workspace", ws2], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    await f.driftA();
    const realWs = await fs.realpath(f.ws);
    const realWs2 = await fs.realpath(ws2);
    const realForge = await fs.realpath(f.forgeRoot);

    const P = ["drift", "promote", A, "--workspace", f.ws, "--json"];
    const r = runCli(P, { env: { CRAFTAR_HOME: home } });

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toEqual({
      workspace: realWs,
      forge: realForge,
      profile: "acme",
      dryRun: false,
      path: ".claude/rules/a.md",
      ingredient: "rule/a",
      outcome: "variant",
      promoted: "rule/a--acme",
      written: [
        { path: "ingredients/rules/a--acme/ingredient.yaml", action: "created" },
        { path: "ingredients/rules/a--acme/rule.md", action: "created" },
        { path: "recipes/base.yaml", action: "edited" },
      ],
      params: [],
      sections: [],
      flattened: { params: [], sections: [] },
      dependents: [],
      nextSync: { counts: {} },
      impact: {
        registry: "read",
        workspaces: [
          { path: realWs2, profile: "acme", match: "path", via: null, ref: null, state: "changed", counts: { update: 1 }, error: null },
        ],
      },
      warnings: [],
    });
    // Verify key order
    expect(Object.keys(parsed)).toEqual([
      "workspace",
      "forge",
      "profile",
      "dryRun",
      "path",
      "ingredient",
      "outcome",
      "promoted",
      "written",
      "params",
      "sections",
      "flattened",
      "dependents",
      "nextSync",
      "impact",
      "warnings",
    ]);

    // --json --dry-run
    gitCommit(f.forgeRoot, "promote");
    expect(runCli(["sync", "--workspace", f.ws], { env: { CRAFTAR_HOME: home } }).code).toBe(0);
    await fs.appendFile(path.join(f.ws, A), "again\n");

    const r2 = runCli(["drift", "promote", A, "--workspace", f.ws, "--json", "--dry-run"], { env: { CRAFTAR_HOME: home } });
    expect(r2.code).toBe(0);
    const parsed2 = JSON.parse(r2.stdout);
    expect(parsed2.dryRun).toBe(true);
    expect(parsed2.written.length).toBeGreaterThan(0);
    expect(porcelain(f.forgeRoot)).toBe("");
  });

  it("52. the promoting workspace is not in impact.workspaces", async () => {
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const f = await F();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws], { env: { CRAFTAR_HOME: home } }).code).toBe(0);
    await f.driftA();

    const P = ["drift", "promote", A, "--workspace", f.ws, "--json"];
    const r = runCli(P, { env: { CRAFTAR_HOME: home } });

    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.impact.workspaces).toEqual([]);
  });

  it("53. D16 another profile", async () => {
    // Fixture M: two profiles sharing base; W2 on globex with recipes: { add: ["solo"] }
    // Recipe `solo` lists rule/a, and only profile `acme` resolves it from its OWN layer
    // So when acme promotes rule/a (editing solo.yaml in place), globex which adds solo should change
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));

    const s = await scenario(
      {
        ingredients: [rule("a", "A one\nA two\n"), rule("b", "B one\nB two\n"), rule("c", "C one\n")],
        recipes: [
          recipe("base-rest", ["rule/b", "rule/c"]),
          recipe("solo", ["rule/a"]),
          { name: "base", ingredients: ["rule/a", "rule/b", "rule/c"] },
        ],
        profiles: [
          profile("acme", ["base-rest", "solo"]),
          profile("globex", ["base"]),
        ],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    // Create W2 on globex with recipes.add: ["solo"] — so it also resolves solo
    const ws2 = path.join(s.root, "ws2");
    await makeWorkspace(ws2, s.forgeRoot, { config: { profile: "globex", recipes: { add: ["solo"] } } });
    expect(runCli(["sync", "--workspace", ws2], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    const lockBefore = await fs.readFile(path.join(s.wsRoot, "craftar.lock"));
    await fs.appendFile(path.join(s.wsRoot, A), "hand a\n");

    const realWs2 = await fs.realpath(ws2);

    const r = runCli(["drift", "promote", A, "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`error: promote would change ${realWs2} (profile globex): ${A} — the Forge was left untouched\n`);
    expect(porcelain(s.forgeRoot)).toBe("");
    expect((await fs.readFile(path.join(s.wsRoot, "craftar.lock"))).equals(lockBefore)).toBe(true);
  });

  it("54. D16 same profile, outside — workspace disables rule/a", async () => {
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const f = await F();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    // Create ws2 with rule/a disabled
    const ws2 = path.join(f.root, "ws2");
    await makeWorkspace(ws2, f.forgeRoot, { config: { profile: "acme", overrides: { ingredients: { disable: ["rule/a"] } } } });
    expect(runCli(["sync", "--workspace", ws2], { env: { CRAFTAR_HOME: home } }).code).toBe(0);
    // Verify a.md does not exist in ws2
    await expect(fs.stat(path.join(ws2, A))).rejects.toMatchObject({ code: "ENOENT" });

    const lockBefore = await fs.readFile(path.join(f.ws, "craftar.lock"));
    await f.driftA();
    const realWs2 = await fs.realpath(ws2);

    const r = runCli(["drift", "promote", A, "--workspace", f.ws], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`error: promote would change ${realWs2} beyond rule/a: ${A} — the Forge was left untouched\n`);
    expect(porcelain(f.forgeRoot)).toBe("");
    expect((await fs.readFile(path.join(f.ws, "craftar.lock"))).equals(lockBefore)).toBe(true);
  });

  it("55. D16 same profile, override — variant outcome is refused when ws2 fills the section", async () => {
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const f = await S();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    // Create ws2 with overrides.sections for rule/a
    const ws2 = path.join(f.root, "ws2");
    await makeWorkspace(ws2, f.forgeRoot, { config: { profile: "acme", overrides: { sections: { "rule/a": { flavors: "w2\n" } } } } });
    expect(runCli(["sync", "--workspace", ws2], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    const lockBefore = await f.lockBytes();
    // Trigger a variant outcome by appending text after the section
    await fs.appendFile(path.join(f.ws, A), "hand\n");
    const realWs2 = await fs.realpath(ws2);

    const r = runCli(["drift", "promote", A, "--workspace", f.ws], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`error: ${realWs2} fills rule/a from its own overrides — a variant would silently stop applying them there; the Forge was left untouched\n`);
    expect(porcelain(f.forgeRoot)).toBe("");
    expect((await f.lockBytes()).equals(lockBefore)).toBe(true);
  });

  it("55b. D16 same profile, override — sections outcome (not variant) IS allowed when override keeps applying", async () => {
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const f = await S();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    // Create ws2 with overrides.sections for rule/a
    const ws2 = path.join(f.root, "ws2");
    await makeWorkspace(ws2, f.forgeRoot, { config: { profile: "acme", overrides: { sections: { "rule/a": { flavors: "w2\n" } } } } });
    expect(runCli(["sync", "--workspace", ws2], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    // Trigger a sections outcome by editing only the section content
    await fs.writeFile(path.join(f.ws, A), "S one\nacme flavor\nS end\n");
    const realWs2 = await fs.realpath(ws2);

    const r = runCli(["drift", "promote", A, "--workspace", f.ws], { env: { CRAFTAR_HOME: home } });
    // A sections outcome is allowed because the override in ws2 still applies
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    // Whole stdout pinned — ws2 sees update from the profile section change but its override wins
    expect(r.stdout).toBe(
      `promote ${A} → profile acme (sections)\n` +
        "  edited profiles/acme/profile.yaml (sections)\n" +
        "  section rule/a flavors: 1 line(s)\n" +
        "  proved: this workspace plans the file on disk; 1 other file(s) unchanged\n" +
        "  next sync: nothing to sync\n" +
        `  1 other workspace(s) of profile acme read this Forge: ${realWs2} — unchanged\n` +
        "  the Forge is not committed — review with git, then commit and push it\n",
    );
  });

  it("55c. D16 same profile, X beside variant — sibling with recipes.add listing rule/a", async () => {
    // Create a Forge where rule/a is in base, but also an "extra" recipe that lists rule/a
    // When ws2 adds "extra", it will still resolve rule/a from base AND have rule/a in extra
    // After promote creates rule/a--acme, ws2 would have both rule/a (from extra) and rule/a--acme
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));

    const s = await scenario(
      {
        ingredients: [rule("a", "A one\n"), rule("b", "B one\n"), rule("c", "C one\n")],
        recipes: [
          recipe("base", ["rule/a", "rule/b", "rule/c"]),
          { name: "extra", ingredients: ["rule/a"], extends: [] }, // Another recipe also lists rule/a
        ],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);

    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    // Create ws2 with recipes.add: [extra] - now ws2 resolves rule/a from BOTH base and extra
    const ws2 = path.join(s.root, "ws2");
    await makeWorkspace(ws2, s.forgeRoot, { config: { profile: "acme", recipes: { add: ["extra"], remove: [] } } });
    expect(runCli(["sync", "--workspace", ws2], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    // Drift rule/a in main workspace
    await fs.appendFile(path.join(s.wsRoot, A), "hand a\n");
    const lockBefore = await fs.readFile(path.join(s.wsRoot, "craftar.lock"));
    const realWs2 = await fs.realpath(ws2);

    // Promote should be refused: after promote, ws2 would resolve BOTH rule/a (from extra) and rule/a--acme (from base--acme)
    const r = runCli(["drift", "promote", A, "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`error: promote would change ${realWs2} beyond rule/a: ${A} — the Forge was left untouched\n`);
    expect(porcelain(s.forgeRoot)).toBe("");
    expect((await fs.readFile(path.join(s.wsRoot, "craftar.lock"))).equals(lockBefore)).toBe(true);
  });

  it("55d. a same-profile sibling whose AGENTS.md changes only inside rule N is reported, not refused", async () => {
    // Three-target fixture: AGENTS.md has rule markers
    // ws2 disables rule/c, so its AGENTS.md is different from ws1's
    // When we promote rule/a, ws2's AGENTS.md changes inside rule/a's section (allowed)
    // A change OUTSIDE that section can occur (see 55d2); the bound check catches it.
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));

    const f = await T();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    // Create ws2 with rule/c disabled — its AGENTS.md has different content (no rule c)
    const ws2 = path.join(f.root, "ws2");
    await makeWorkspace(ws2, f.forgeRoot, { config: { profile: "acme", overrides: { ingredients: { disable: ["rule/c"] } } } });
    expect(runCli(["sync", "--workspace", ws2], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    // Verify ws2's AGENTS.md doesn't have rule c
    const ws2AgentsMd = await fs.readFile(path.join(ws2, "AGENTS.md"), "utf8");
    expect(ws2AgentsMd).not.toContain("<!-- rule: c -->");
    expect(ws2AgentsMd).toContain("<!-- rule: a -->");

    // Drift rule/a — this should be allowed for AGENTS.md changes within rule/a's section
    await f.driftA();

    // This promote should succeed because:
    // - ws2's AGENTS.md will change only within rule/a's section (agentsBound = true)
    // - ws2 doesn't resolve rule/a from another recipe (no X beside variant issue)
    const r = runCli(["drift", "promote", A, "--workspace", f.ws], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    // ws2 should show as changed (update for a.md + AGENTS.md)
    expect(r.stdout).toContain("1 other workspace(s) of profile acme read this Forge:");
  });

  it("55d2. D16 a same-profile sibling that disables rule/a and targets only agents-md — AGENTS.md change is refused", async () => {
    // A sibling with targets: [agents-md] and overrides.ingredients.disable: [rule/a]
    // When we promote rule/a, the sibling's AGENTS.md would gain rule/a — a change OUTSIDE its (nonexistent) section
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));

    // Create a fixture with rule/a and rule/b
    const s = await scenario(
      {
        ingredients: [rule("a", "A one\nA two\n"), rule("b", "B one\n")],
        recipes: [recipe("base", ["rule/a", "rule/b"])],
        profiles: [profile("acme", ["base"], ["claude-code", "kiro", "agents-md"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    // Create ws2: targets [agents-md] only, and disables rule/a
    const ws2 = path.join(s.root, "ws2");
    await makeWorkspace(ws2, s.forgeRoot, {
      config: {
        profile: "acme",
        targets: ["agents-md"],
        overrides: { ingredients: { disable: ["rule/a"] } },
      },
    });
    expect(runCli(["sync", "--workspace", ws2], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    // ws2's AGENTS.md should NOT have rule/a
    const ws2AgentsMd = await fs.readFile(path.join(ws2, "AGENTS.md"), "utf8");
    expect(ws2AgentsMd).not.toContain("<!-- rule: a -->");
    expect(ws2AgentsMd).toContain("<!-- rule: b -->");

    // Drift rule/a from ws1
    await fs.appendFile(path.join(s.wsRoot, A), "hand a\n");
    const lockBefore = await fs.readFile(path.join(s.wsRoot, "craftar.lock"));

    // Promoting rule/a should be REFUSED: ws2's AGENTS.md would gain rule/a (outside the section bounds)
    const r = runCli(["drift", "promote", A, "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      `error: promote would change ${ws2} beyond rule/a: AGENTS.md — the Forge was left untouched\n`,
    );
    // Forge untouched
    expect(porcelain(s.forgeRoot)).toBe("");
    // Lock unchanged
    expect((await fs.readFile(path.join(s.wsRoot, "craftar.lock"))).equals(lockBefore)).toBe(true);
  });

  it("55e. two recipes both Case 2 — profile edited twice through stage", async () => {
    // Two recipes both used by acme, both listing rule/a, but also used by another profile
    // So they're Case 2: each forks, and the profile's recipes list is edited twice
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));

    const s = await scenario(
      {
        ingredients: [rule("a", "A one\n"), rule("b", "B one\n"), rule("c", "C one\n")],
        recipes: [
          recipe("base", ["rule/a", "rule/b"]),
          recipe("extra", ["rule/a", "rule/c"]),
        ],
        profiles: [
          profile("acme", ["base", "extra"]),
          profile("globex", ["base", "extra"]), // both profiles use both recipes
        ],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);

    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    // Drift rule/a
    await fs.appendFile(path.join(s.wsRoot, A), "hand a\n");

    const r = runCli(["drift", "promote", A, "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");

    // Both recipes should be forked
    const baseAcme = YAML.parse(await fs.readFile(path.join(s.forgeRoot, "recipes/base--acme.yaml"), "utf8"));
    const extraAcme = YAML.parse(await fs.readFile(path.join(s.forgeRoot, "recipes/extra--acme.yaml"), "utf8"));
    expect(baseAcme.ingredients).toEqual(["rule/a--acme", "rule/b"]);
    expect(extraAcme.ingredients).toEqual(["rule/a--acme", "rule/c"]);

    // Profile should now use both forked recipes
    const profileContent = YAML.parse(await fs.readFile(path.join(s.forgeRoot, "profiles/acme/profile.yaml"), "utf8"));
    expect(profileContent.recipes).toEqual(["base--acme", "extra--acme"]);
  });

  it("55f. script with multiple files — all files promoted", async () => {
    // A script ingredient with two files: run.sh and config.json
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));

    const s = await scenario(
      {
        ingredients: [
          {
            meta: {
              type: "script",
              name: "deploy",
              files: ["run.sh", "config.json"],
              targets: ["claude-code"],
              tags: [],
            },
            files: { "run.sh": "#!/bin/bash\necho deploy\n", "config.json": '{"env":"prod"}' },
          },
        ],
        recipes: [recipe("base", ["script/deploy"])],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);

    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    // Verify both files exist
    expect(await fs.readFile(path.join(s.wsRoot, ".claude/scripts/run.sh"), "utf8")).toBe("#!/bin/bash\necho deploy\n");
    expect(await fs.readFile(path.join(s.wsRoot, ".claude/scripts/config.json"), "utf8")).toBe('{"env":"prod"}');

    // Drift run.sh
    await fs.writeFile(path.join(s.wsRoot, ".claude/scripts/run.sh"), "#!/bin/bash\necho deploy-edited\n");

    const r = runCli(["drift", "promote", ".claude/scripts/run.sh", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");

    // The variant directory should have BOTH files
    const variantDir = path.join(s.forgeRoot, "ingredients/scripts/deploy--acme");
    expect(await fs.readFile(path.join(variantDir, "run.sh"), "utf8")).toBe("#!/bin/bash\necho deploy-edited\n");
    expect(await fs.readFile(path.join(variantDir, "config.json"), "utf8")).toBe('{"env":"prod"}');

    // The ingredient.yaml should list both files
    const variantMeta = YAML.parse(await fs.readFile(path.join(variantDir, "ingredient.yaml"), "utf8"));
    expect(variantMeta.files).toEqual(["run.sh", "config.json"]);
  });

  it("56. registry off", async () => {
    const f = await F();
    gitInit(f.forgeRoot);
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));

    expect(runCli(["sync", "--workspace", f.ws], { env: { CRAFTAR_HOME: home } }).code).toBe(0);
    await f.driftA();

    const P = ["drift", "promote", A, "--workspace", f.ws, "--dry-run"];
    const r = runCli(P, { env: { CRAFTAR_HOME: home, CRAFTAR_NO_REGISTRY: "1" } });

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    // Whole stdout pinned — registry: off triggers the warning
    expect(r.stdout).toBe(
      `promote ${A} → rule/a--acme (variant, profile acme)\n` +
        "  would write ingredients/rules/a--acme/ingredient.yaml\n" +
        "  would write ingredients/rules/a--acme/rule.md\n" +
        "  would edit recipes/base.yaml (ingredients)\n" +
        "  proved: this workspace plans the file on disk; 2 other file(s) unchanged\n" +
        "  next sync: nothing to sync\n" +
        "  warn other workspaces could not be checked (registry: off)\n" +
        "  dry run — the Forge was not written\n",
    );

    // --json (also with --dry-run to avoid changing state)
    const P2 = ["drift", "promote", A, "--workspace", f.ws, "--json", "--dry-run"];
    const r2 = runCli(P2, { env: { CRAFTAR_HOME: home, CRAFTAR_NO_REGISTRY: "1" } });
    expect(r2.code).toBe(0);
    const parsed = JSON.parse(r2.stdout);
    expect(parsed.impact).toEqual({ registry: "off", workspaces: [] });
  });

  it("57. URL Forge + --forge <clone>", async () => {
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));

    // Use remoteForge helper to create a bare repo with file:// URL
    const { remoteForge } = await import("./helpers/remote.js");
    const rf = await remoteForge({
      ingredients: [rule("a", "A one\nA two\n"), rule("b", "B one\nB two\n"), rule("c", "C one\n")],
      recipes: [recipe("base", ["rule/a", "rule/b", "rule/c"])],
      profiles: [profile("acme", ["base"])],
    });
    cleanups.push(rf.cleanup);

    // Create a workspace whose forge: is the URL
    const root = await tmpDir("craftar-ws-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, "craftar.yaml"), `forge: ${rf.url}\nprofile: acme\n`);
    expect(runCli(["sync", "--workspace", root], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    // Clone the Forge separately
    const cloneDir = await tmpDir("craftar-clone-");
    cleanups.push(() => fs.rm(cloneDir, { recursive: true, force: true }));
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["clone", "-q", rf.bare, cloneDir], { env: gitEnv() });
    // Disable git maintenance in clone
    execFileSync("git", ["-C", cloneDir, "config", "maintenance.auto", "false"]);
    execFileSync("git", ["-C", cloneDir, "config", "gc.auto", "0"]);

    // Drift on a
    await fs.appendFile(path.join(root, A), "hand a\n");

    // Get recursive listing of forges/ before promote — names, sizes and mtimes
    const forgesDir = path.join(home, "forges");
    async function recursiveListing(dir: string): Promise<Array<{ name: string; size: number; mtimeMs: number }>> {
      const result: Array<{ name: string; size: number; mtimeMs: number }> = [];
      const walk = async (d: string, prefix: string) => {
        for (const entry of await fs.readdir(d)) {
          const p = path.join(d, entry);
          const stat = await fs.stat(p);
          result.push({ name: prefix + entry, size: stat.size, mtimeMs: stat.mtimeMs });
          if (stat.isDirectory()) await walk(p, prefix + entry + "/");
        }
      };
      await walk(dir, "");
      return result.sort((a, b) => a.name.localeCompare(b.name));
    }
    const listingBefore = await recursiveListing(forgesDir);

    const P = ["drift", "promote", A, "--workspace", root, "--forge", cloneDir];
    const r = runCli(P, { env: { CRAFTAR_HOME: home } });

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    // Check the last two stdout lines
    const lines = r.stdout.trim().split("\n");
    expect(lines[lines.length - 2]).toBe("  the Forge is not committed — review with git, then commit and push it");
    expect(lines[lines.length - 1]).toBe("  push the Forge for sync to see this");

    // The clone shows the changes
    expect(porcelain(cloneDir)).toBe(" M recipes/base.yaml\n?? ingredients/rules/a--acme/\n");

    // The forges/ listing is unchanged (no fetch, no tree built, no .used stamp moved)
    const listingAfter = await recursiveListing(forgesDir);
    expect(listingAfter).toEqual(listingBefore);
  });

  it("57b. URL Forge + --forge pointing at unrelated directory → D2", async () => {
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));

    const { remoteForge } = await import("./helpers/remote.js");
    const rf = await remoteForge({
      ingredients: [rule("a", "A one\n")],
      recipes: [recipe("base", ["rule/a"])],
      profiles: [profile("acme", ["base"])],
    });
    cleanups.push(rf.cleanup);

    const root = await tmpDir("craftar-ws-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, "craftar.yaml"), `forge: ${rf.url}\nprofile: acme\n`);
    expect(runCli(["sync", "--workspace", root], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    // Create an unrelated git directory
    const unrelatedDir = await tmpDir("craftar-unrelated-");
    cleanups.push(() => fs.rm(unrelatedDir, { recursive: true, force: true }));
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q", unrelatedDir], { env: gitEnv() });
    execFileSync("git", ["-C", unrelatedDir, "config", "maintenance.auto", "false"]);
    execFileSync("git", ["-C", unrelatedDir, "config", "gc.auto", "0"]);
    await fs.writeFile(path.join(unrelatedDir, "README.md"), "unrelated\n");
    execFileSync("git", ["-C", unrelatedDir, "add", "-A"]);
    execFileSync("git", ["-C", unrelatedDir, "commit", "-q", "-m", "init"], { env: gitEnv() });

    await fs.appendFile(path.join(root, A), "hand a\n");

    const r = runCli(["drift", "promote", A, "--workspace", root, "--forge", unrelatedDir], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`error: --forge ${unrelatedDir} is not a clone of this workspace's Forge — none of its git remotes matches\n`);
  });

  // Step 30r1: symlink refusal tests
  it("R1. symlink recipe file (--dry-run) — refused, outside file unchanged", async () => {
    const f = await F();
    // Create an outside directory and file
    const outsideDir = path.join(f.root, "outside");
    await fs.mkdir(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, "base.yaml");
    await fs.writeFile(outsideFile, await fs.readFile(path.join(f.forgeRoot, "recipes/base.yaml")));
    const outsideBefore = await fs.readFile(outsideFile);

    // Replace recipes/base.yaml with a symlink to the outside file
    await fs.rm(path.join(f.forgeRoot, "recipes/base.yaml"));
    try {
      await fs.symlink(outsideFile, path.join(f.forgeRoot, "recipes/base.yaml"));
    } catch (e) {
      // On Windows without privilege, symlink throws EPERM
      if ((e as NodeJS.ErrnoException).code === "EPERM") {
        // The test cannot create symlinks; assert the EPERM and return
        expect((e as NodeJS.ErrnoException).code).toBe("EPERM");
        return;
      }
      throw e;
    }
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await f.driftA();

    const r = runCli(["drift", "promote", A, "--workspace", f.ws, "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "error: recipes/base.yaml is a symbolic link in the Forge — promote does not write through a link; replace it with the file and commit\n",
    );
    // Outside file unchanged
    expect((await fs.readFile(outsideFile)).equals(outsideBefore)).toBe(true);
    // Forge porcelain empty
    expect(porcelain(f.forgeRoot)).toBe("");
  });

  it("R2. symlink recipe file (no --dry-run) — refused, outside file unchanged", async () => {
    const f = await F();
    // Create an outside directory and file
    const outsideDir = path.join(f.root, "outside");
    await fs.mkdir(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, "base.yaml");
    await fs.writeFile(outsideFile, await fs.readFile(path.join(f.forgeRoot, "recipes/base.yaml")));
    const outsideBefore = await fs.readFile(outsideFile);

    // Replace recipes/base.yaml with a symlink to the outside file
    await fs.rm(path.join(f.forgeRoot, "recipes/base.yaml"));
    try {
      await fs.symlink(outsideFile, path.join(f.forgeRoot, "recipes/base.yaml"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") {
        expect((e as NodeJS.ErrnoException).code).toBe("EPERM");
        return;
      }
      throw e;
    }
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await f.driftA();

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "error: recipes/base.yaml is a symbolic link in the Forge — promote does not write through a link; replace it with the file and commit\n",
    );
    // Outside file unchanged
    expect((await fs.readFile(outsideFile)).equals(outsideBefore)).toBe(true);
    // Forge porcelain empty
    expect(porcelain(f.forgeRoot)).toBe("");
  });

  it("R3. symlink directory (junction) — refused naming the ancestor", async () => {
    // Test that a symlinked ancestor of a staged path (new variant directory) is refused
    const f = await F();
    // First sync normally so the files exist in the workspace (before gitInit)
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    
    // Create an outside directory and copy ingredients there BEFORE git init
    const outsideDir = path.join(f.root, "outside");
    await fs.mkdir(outsideDir, { recursive: true });
    // Copy the entire ingredients directory to outside
    await fs.cp(
      path.join(f.forgeRoot, "ingredients"),
      path.join(outsideDir, "ingredients"),
      { recursive: true }
    );

    // Replace ingredients with a junction to the outside directory's ingredients BEFORE git init
    await fs.rm(path.join(f.forgeRoot, "ingredients"), { recursive: true });
    try {
      await fs.symlink(path.join(outsideDir, "ingredients"), path.join(f.forgeRoot, "ingredients"), "junction");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") {
        expect((e as NodeJS.ErrnoException).code).toBe("EPERM");
        return;
      }
      throw e;
    }
    
    // Now gitInit - this commits the symlink state
    gitInit(f.forgeRoot);
    
    // Now sync - this should work because the Forge still loads through the symlink
    expect(runCli(["sync", "--workspace", f.ws], { env: { CRAFTAR_HOME: home } }).code).toBe(0);
    await f.driftA();
    
    const outsideListing = (await fs.readdir(path.join(outsideDir, "ingredients/rules"))).sort();
    const lockBefore = await f.lockBytes();

    const r = runCli(["drift", "promote", A, "--workspace", f.ws], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "error: ingredients is a symbolic link in the Forge — promote does not read a linked recipes, ingredients or profiles directory; replace it with the directory and commit\n",
    );
    // Outside directory listing unchanged (no new a--acme dir)
    expect((await fs.readdir(path.join(outsideDir, "ingredients/rules"))).sort()).toEqual(outsideListing);
    // Forge porcelain empty
    expect(porcelain(f.forgeRoot)).toBe("");
    // Lock unchanged
    expect((await f.lockBytes()).equals(lockBefore)).toBe(true);
  });

  it("R4. copyForgeForProof — skips .git, dereferences file links inside the Forge, refuses non-regular files and root dir links", async () => {
    const { copyForgeForProof } = await import("../src/importers/drift-promote.js");
    const f = await F();
    gitInit(f.forgeRoot);

    // Create a harmless file link inside the Forge (pointing inside the Forge)
    const linkTarget = path.join(f.forgeRoot, "ingredients/rules/a/rule.md");
    const linkPath = path.join(f.forgeRoot, "inside-link.md");
    try {
      await fs.symlink(linkTarget, linkPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") {
        // On Windows without privilege, just verify copyForgeForProof exists and returns
        const scratchDir = await tmpDir("craftar-scratch-");
        cleanups.push(() => fs.rm(scratchDir, { recursive: true, force: true }));
        await copyForgeForProof(f.forgeRoot, scratchDir);
        // .git should not exist
        await expect(fs.stat(path.join(scratchDir, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      throw e;
    }

    const scratchDir = await tmpDir("craftar-scratch-");
    cleanups.push(() => fs.rm(scratchDir, { recursive: true, force: true }));
    await copyForgeForProof(f.forgeRoot, scratchDir);

    // .git should not exist in scratch
    await expect(fs.stat(path.join(scratchDir, ".git"))).rejects.toMatchObject({ code: "ENOENT" });

    // inside-link.md in scratch should be a regular file (dereferenced), not a link
    const stat = await fs.lstat(path.join(scratchDir, "inside-link.md"));
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
  });

  it("58. forge: overridden in craftar.local.yaml", async () => {
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));

    const { remoteForge } = await import("./helpers/remote.js");
    const rf = await remoteForge({
      ingredients: [rule("a", "A one\nA two\n")],
      recipes: [recipe("base", ["rule/a"])],
      profiles: [profile("acme", ["base"])],
    });
    cleanups.push(rf.cleanup);

    // Clone locally
    const cloneDir = await tmpDir("craftar-clone-");
    cleanups.push(() => fs.rm(cloneDir, { recursive: true, force: true }));
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["clone", "-q", rf.bare, cloneDir], { env: gitEnv() });
    execFileSync("git", ["-C", cloneDir, "config", "maintenance.auto", "false"]);
    execFileSync("git", ["-C", cloneDir, "config", "gc.auto", "0"]);

    // Create workspace: craftar.yaml points at URL, craftar.local.yaml overrides to local path
    const root = await tmpDir("craftar-ws-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeWorkspace(root, rf.url, { config: { profile: "acme" } });
    await fs.writeFile(path.join(root, "craftar.local.yaml"), YAML.stringify({ forge: cloneDir }));
    expect(runCli(["sync", "--workspace", root], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    await fs.appendFile(path.join(root, A), "hand a\n");

    // No --forge needed: the merged config's forge is a path
    const P = ["drift", "promote", A, "--workspace", root];
    const r = runCli(P, { env: { CRAFTAR_HOME: home } });

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    // Verify the clone has the changes
    expect(porcelain(cloneDir)).toBe(" M recipes/base.yaml\n?? ingredients/rules/a--acme/\n");
  });
});


// Commit 1 tests: params/sections with dependents, gitUnheld tests for params outcome

/** Fixture P3 — a templated rule with three targets. */
async function P3() {
  const s = await scenario(
    {
      ingredients: [
        {
          meta: {
            type: "rule",
            name: "a",
            params: { "scm.org": { default: "acme-org" } },
          },
          files: { "rule.md": "Org: {{scm.org}}\nA two\n" },
        },
        rule("b", "B one\n"),
      ],
      recipes: [recipe("base", ["rule/a", "rule/b"])],
      profiles: [profile("acme", ["base"], ["claude-code", "kiro", "agents-md"], { params: { "scm.org": "acme-org" } })],
    },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  return {
    ...s,
    ws: s.wsRoot,
    read: (rel: string) => fs.readFile(path.join(s.wsRoot, rel), "utf8"),
    forgeRead: (rel: string) => fs.readFile(path.join(s.forgeRoot, rel), "utf8"),
    lockBytes: () => fs.readFile(path.join(s.wsRoot, "craftar.lock")),
  };
}

describe("cli — drift promote (commit 1: params with dependents)", () => {
  it("59. params outcome with three targets — dependents allowed and reported", async () => {
    const f = await P3();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    expect(await f.read(A)).toBe("Org: acme-org\nA two\n");
    await fs.writeFile(path.join(f.ws, A), "Org: globex-org\nA two\n");
    const lockBefore = await f.lockBytes();

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      `promote ${A} → profile acme (params)\n` +
        "  edited profiles/acme/profile.yaml (params)\n" +
        `  param scm.org: "acme-org" → "globex-org"\n` +
        "  proved: this workspace plans the file on disk; 2 other file(s) unchanged\n" +
        "  also changes .kiro/steering/a.md, AGENTS.md\n" +
        "  next sync: 2 update — run `craftar sync`\n" +
        "  no other registered workspace reads this Forge\n" +
        "  the Forge is not committed — review with git, then commit and push it\n",
    );

    // Profile now has the new value
    expect(YAML.parse(await f.forgeRead("profiles/acme/profile.yaml")).params).toEqual({ "scm.org": "globex-org" });

    // Forge porcelain shows only the profile edited
    expect(porcelain(f.forgeRoot)).toBe(" M profiles/acme/profile.yaml\n");

    // No variant directory created
    await expect(fs.stat(path.join(f.forgeRoot, "ingredients/rules/a--acme"))).rejects.toMatchObject({ code: "ENOENT" });

    // Lock unchanged
    expect((await f.lockBytes()).equals(lockBefore)).toBe(true);
  });

  it("60. D14 on profile.yaml for params outcome — modified and uncommitted", async () => {
    const f = await P3();
    gitInit(f.forgeRoot);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await fs.writeFile(path.join(f.ws, A), "Org: globex-org\nA two\n");
    const lockBefore = await f.lockBytes();

    // Modify the profile file without committing
    await fs.appendFile(path.join(f.forgeRoot, "profiles/acme/profile.yaml"), "# modified\n");

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    const realForge = await fs.realpath(f.forgeRoot);
    expect(r.stderr).toBe(
      `error: drift promote can only change files git can restore — 1 path(s) under ${realForge} are not:\n` +
        "  profiles/acme/profile.yaml is not held by git (modified)\n",
    );
    expect((await f.lockBytes()).equals(lockBefore)).toBe(true);
  });

  it("61. D14 on profile.yaml for params outcome — untracked", async () => {
    const f = await P3();
    gitInit(f.forgeRoot);
    // Remove profile.yaml from the index (untrack it)
    execFileSync("git", ["-C", f.forgeRoot, "rm", "--cached", "profiles/acme/profile.yaml"]);
    execFileSync("git", ["-C", f.forgeRoot, "commit", "-q", "-m", "untrack profile"], { env: gitEnv() });
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await fs.writeFile(path.join(f.ws, A), "Org: globex-org\nA two\n");
    const lockBefore = await f.lockBytes();

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    const realForge = await fs.realpath(f.forgeRoot);
    expect(r.stderr).toBe(
      `error: drift promote can only change files git can restore — 1 path(s) under ${realForge} are not:\n` +
        "  profiles/acme/profile.yaml is not held by git (untracked)\n",
    );
    expect((await f.lockBytes()).equals(lockBefore)).toBe(true);
  });

  it("62. D14 on profile.yaml for params outcome — assume-unchanged", async () => {
    const f = await P3();
    gitInit(f.forgeRoot);
    execFileSync("git", ["-C", f.forgeRoot, "update-index", "--assume-unchanged", "profiles/acme/profile.yaml"]);
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await fs.writeFile(path.join(f.ws, A), "Org: globex-org\nA two\n");
    const lockBefore = await f.lockBytes();

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    const realForge = await fs.realpath(f.forgeRoot);
    expect(r.stderr).toBe(
      `error: drift promote can only change files git can restore — 1 path(s) under ${realForge} are not:\n` +
        "  profiles/acme/profile.yaml is not held by git (assume-unchanged)\n",
    );
    expect((await f.lockBytes()).equals(lockBefore)).toBe(true);
  });

  // === Commit 2: copyForgeForProof symlink handling ===

  it("R4a. copyForgeForProof — directory link outside the Forge is NOT copied", async () => {
    const { copyForgeForProof } = await import("../src/importers/drift-promote.js");
    const f = await F();
    gitInit(f.forgeRoot);

    // Create a symlink to a directory outside the Forge
    const outsideDir = await tmpDir("outside-dir-");
    cleanups.push(() => fs.rm(outsideDir, { recursive: true, force: true }));
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "secret data");

    const linkPath = path.join(f.forgeRoot, "outside-link");
    try {
      await fs.symlink(outsideDir, linkPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") {
        // Windows without privilege — skip
        return;
      }
      throw e;
    }

    const scratchDir = await tmpDir("craftar-scratch-");
    cleanups.push(() => fs.rm(scratchDir, { recursive: true, force: true }));

    // Should NOT throw, and should NOT copy the outside directory
    await copyForgeForProof(f.forgeRoot, scratchDir);

    // The link should not be in the scratch
    await expect(fs.access(path.join(scratchDir, "outside-link"))).rejects.toMatchObject({ code: "ENOENT" });
    // Forge manifest should still be copied
    await expect(fs.access(path.join(scratchDir, "craftar.forge.yaml"))).resolves.toBeUndefined();
  });

  it("R4b. copyForgeForProof — dangling link throws refusal", async () => {
    const { copyForgeForProof } = await import("../src/importers/drift-promote.js");
    const f = await F();
    gitInit(f.forgeRoot);

    const linkPath = path.join(f.forgeRoot, "dangling-link.md");
    try {
      await fs.symlink(path.join(f.forgeRoot, "does-not-exist.md"), linkPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") {
        // Windows without privilege — skip
        return;
      }
      throw e;
    }

    const scratchDir = await tmpDir("craftar-scratch-");
    cleanups.push(() => fs.rm(scratchDir, { recursive: true, force: true }));

    await expect(copyForgeForProof(f.forgeRoot, scratchDir)).rejects.toThrow(
      "dangling-link.md is a symbolic link out of the Forge, or to nothing — promote cannot copy the Forge to prove its edit; fix or remove it",
    );
  });

  it("R4c. copyForgeForProof — link to '.' (directory link) is skipped, not ELOOP", async () => {
    const { copyForgeForProof } = await import("../src/importers/drift-promote.js");
    const f = await F();
    gitInit(f.forgeRoot);

    const linkPath = path.join(f.forgeRoot, "self-link");
    try {
      await fs.symlink(".", linkPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") {
        // Windows without privilege — skip
        return;
      }
      throw e;
    }

    const scratchDir = await tmpDir("craftar-scratch-");
    cleanups.push(() => fs.rm(scratchDir, { recursive: true, force: true }));

    // Should NOT throw ELOOP — directory links are skipped
    await copyForgeForProof(f.forgeRoot, scratchDir);

    // The self-link should not be in the scratch (directory links are skipped)
    await expect(fs.access(path.join(scratchDir, "self-link"))).rejects.toMatchObject({ code: "ENOENT" });
    // Forge manifest should still be copied
    await expect(fs.access(path.join(scratchDir, "craftar.forge.yaml"))).resolves.toBeUndefined();
  });

  it("R4d. copyForgeForProof — file link pointing outside the Forge throws refusal", async () => {
    const { copyForgeForProof } = await import("../src/importers/drift-promote.js");
    const f = await F();
    gitInit(f.forgeRoot);

    // Create a file outside the Forge
    const outsideFile = path.join(f.forgeRoot, "..", "outside-file.md");
    await fs.writeFile(outsideFile, "outside content");
    cleanups.push(() => fs.rm(outsideFile, { force: true }));

    const linkPath = path.join(f.forgeRoot, "outside-file-link.md");
    try {
      await fs.symlink(outsideFile, linkPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") {
        // Windows without privilege — skip
        return;
      }
      throw e;
    }

    const scratchDir = await tmpDir("craftar-scratch-");
    cleanups.push(() => fs.rm(scratchDir, { recursive: true, force: true }));

    await expect(copyForgeForProof(f.forgeRoot, scratchDir)).rejects.toThrow(
      "outside-file-link.md is a symbolic link out of the Forge, or to nothing — promote cannot copy the Forge to prove its edit; fix or remove it",
    );
  });

  it("63. CLI: outside directory link → promote succeeds, nothing copied", async () => {
    const f = await F();
    gitInit(f.forgeRoot);

    // Create a symlink to a directory outside the Forge (e.g., a temp dir)
    const outsideDir = await tmpDir("outside-dir-");
    cleanups.push(() => fs.rm(outsideDir, { recursive: true, force: true }));
    await fs.writeFile(path.join(outsideDir, "big-file.txt"), "big data ".repeat(1000));

    const linkPath = path.join(f.forgeRoot, "outside-dir-link");
    try {
      await fs.symlink(outsideDir, linkPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") {
        // Windows without privilege — skip
        return;
      }
      throw e;
    }

    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await fs.writeFile(path.join(f.ws, A), "A edited\n");

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(0);
    // Promote succeeds - the outside directory link is skipped
    expect(r.stdout).toContain("promote .claude/rules/a.md → rule/a--acme (variant, profile acme)");
    expect(r.stderr).toBe("");
    // Forge was written to
    expect(porcelain(f.forgeRoot)).not.toBe("");
  });

  it("64. CLI: dangling link → refusal, exit 1, Forge untouched, no scratch left", async () => {
    const f = await F();
    gitInit(f.forgeRoot);

    const linkPath = path.join(f.forgeRoot, "dangling.md");
    try {
      await fs.symlink(path.join(f.forgeRoot, "gone.md"), linkPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") {
        // Windows without privilege — skip
        return;
      }
      throw e;
    }

    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await fs.writeFile(path.join(f.ws, A), "A edited\n");
    const lockBefore = await f.lockBytes();
    // Capture porcelain BEFORE promote - the dangling link is untracked
    const porcelainBefore = porcelain(f.forgeRoot);

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "error: dangling.md is a symbolic link out of the Forge, or to nothing — promote cannot copy the Forge to prove its edit; fix or remove it\n",
    );
    // Forge untouched — porcelain same as before
    expect(porcelain(f.forgeRoot)).toBe(porcelainBefore);
    // Lock unchanged
    expect((await f.lockBytes()).equals(lockBefore)).toBe(true);

    // No craftar-promote-* scratch left in os.tmpdir()
    const osTemp = await import("node:os");
    const tmpContents = await fs.readdir(osTemp.tmpdir());
    const promoteLeftovers = tmpContents.filter((n) => n.startsWith("craftar-promote-"));
    expect(promoteLeftovers).toEqual([]);
  });

  it("65. CLI: link to '.' → promote succeeds (not ELOOP)", async () => {
    const f = await F();
    gitInit(f.forgeRoot);

    const linkPath = path.join(f.forgeRoot, "loop-link");
    try {
      await fs.symlink(".", linkPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") {
        // Windows without privilege — skip
        return;
      }
      throw e;
    }

    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    await fs.writeFile(path.join(f.ws, A), "A edited\n");

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(0);
    // Promote succeeds - directory link is skipped
    expect(r.stdout).toContain("promote .claude/rules/a.md → rule/a--acme (variant, profile acme)");
    expect(r.stderr).toBe("");
    // Forge was written to
    expect(porcelain(f.forgeRoot)).not.toBe("");
  });

  // === Commit 4: agent with edited frontmatter ===

  it("66. an agent with edited frontmatter travels as a variant", async () => {
    // Spec §9 item 9: agent ingredient with frontmatter, edit description + body, promote
    const agentPath = ".claude/agents/helper.md";
    const s = await scenario(
      {
        ingredients: [
          {
            meta: {
              type: "agent",
              name: "helper",
              description: "Original description",
              tools: ["Read", "Grep"],
              model: "sonnet",
              frontmatterRaw: "name: helper\ndescription: Original description\ntools: Read, Grep\nmodel: sonnet",
            },
            files: { "agent.md": "\nOriginal body\n" },
          },
        ],
        recipes: [recipe("base", ["agent/helper"])],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);

    // Verify the synced file has the frontmatter
    const synced = await fs.readFile(path.join(s.wsRoot, agentPath), "utf8");
    expect(synced).toContain("name: helper");
    expect(synced).toContain("Original description");
    expect(synced).toContain("Original body");

    // Edit the description in the frontmatter AND the body line
    const edited = `---
name: helper
description: Edited description
tools: Read, Grep
model: sonnet
---

Edited body
`;
    await fs.writeFile(path.join(s.wsRoot, agentPath), edited);
    const lockBefore = await fs.readFile(path.join(s.wsRoot, "craftar.lock"));

    const r = runCli(["drift", "promote", agentPath, "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    // Check stdout contains the expected output
    expect(r.stdout).toContain(`promote ${agentPath} → agent/helper--acme (variant, profile acme)`);
    expect(r.stdout).toContain("wrote  ingredients/agents/helper--acme/ingredient.yaml");
    expect(r.stdout).toContain("wrote  ingredients/agents/helper--acme/agent.md");
    expect(r.stdout).toContain("proved: this workspace plans the file on disk");

    // Check the variant's ingredient.yaml
    const variantMeta = YAML.parse(
      await fs.readFile(path.join(s.forgeRoot, "ingredients/agents/helper--acme/ingredient.yaml"), "utf8"),
    );
    expect(variantMeta).toEqual({
      type: "agent",
      name: "helper--acme",
      file: "agent.md",
      description: "Edited description",
      tools: ["Read", "Grep"],
      model: "sonnet",
      frontmatterRaw: "name: helper\ndescription: Edited description\ntools: Read, Grep\nmodel: sonnet",
      as: "helper",
      targets: "*",
      tags: [],
      origin: {
        workspace: "ws",
        path: agentPath,
      },
    });

    // Check the variant's body file
    const variantBody = await fs.readFile(path.join(s.forgeRoot, "ingredients/agents/helper--acme/agent.md"), "utf8");
    expect(variantBody).toBe("\nEdited body\n");

    // Check that craftar status says unchanged for the agent file (the proof's claim)
    const statusR = runCli(["status", "--workspace", s.wsRoot, "--json"]);
    expect(statusR.code).toBe(0);
    const statusJ = JSON.parse(statusR.stdout);
    const agentStatus = statusJ.statuses.find((st: { path: string }) => st.path === agentPath);
    expect(agentStatus?.state).toBe("unchanged");
  });
});


// Commit 1: copyForgeForProof refuses non-regular files and root directory links, profile label derived from real file

describe("copyForgeForProof — non-regular files and root directory links (commit 1)", () => {
  it("R5. copyForgeForProof refuses a FIFO (unit)", async () => {
    // On Windows there is no FIFO; the test must early-return on win32
    if (process.platform === "win32") {
      // Windows has no FIFO; skip
      return;
    }
    const { copyForgeForProof } = await import("../src/importers/drift-promote.js");
    const f = await F();
    gitInit(f.forgeRoot);

    // Create a FIFO at the Forge root
    const fifoPath = path.join(f.forgeRoot, "fifo");
    execFileSync("mkfifo", [fifoPath]);
    cleanups.push(() => fs.rm(fifoPath, { force: true }));

    const scratchDir = await tmpDir("craftar-scratch-");
    cleanups.push(() => fs.rm(scratchDir, { recursive: true, force: true }));

    // The call should reject promptly (not hang), with the refusal message
    await expect(copyForgeForProof(f.forgeRoot, scratchDir)).rejects.toThrow(
      "fifo is not a regular file — promote cannot copy the Forge to prove its edit; remove it",
    );
  });

  it("R6a. copyForgeForProof refuses root directory link: ingredients", async () => {
    const { copyForgeForProof } = await import("../src/importers/drift-promote.js");
    const f = await F();
    
    // Create an outside directory to hold the ingredients
    const outsideDir = await tmpDir("outside-ing-");
    cleanups.push(() => fs.rm(outsideDir, { recursive: true, force: true }));
    
    // Move ingredients to outside and replace with junction
    await fs.rename(path.join(f.forgeRoot, "ingredients"), path.join(outsideDir, "ingredients"));
    try {
      await fs.symlink(path.join(outsideDir, "ingredients"), path.join(f.forgeRoot, "ingredients"), "junction");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") {
        return; // Windows without privilege
      }
      throw e;
    }
    gitInit(f.forgeRoot);

    const scratchDir = await tmpDir("craftar-scratch-");
    cleanups.push(() => fs.rm(scratchDir, { recursive: true, force: true }));

    await expect(copyForgeForProof(f.forgeRoot, scratchDir)).rejects.toThrow(
      "ingredients is a symbolic link in the Forge — promote does not read a linked recipes, ingredients or profiles directory; replace it with the directory and commit",
    );
  });

  it("R6b. copyForgeForProof refuses root directory link: recipes", async () => {
    const { copyForgeForProof } = await import("../src/importers/drift-promote.js");
    const f = await F();
    
    const outsideDir = await tmpDir("outside-rec-");
    cleanups.push(() => fs.rm(outsideDir, { recursive: true, force: true }));
    
    await fs.rename(path.join(f.forgeRoot, "recipes"), path.join(outsideDir, "recipes"));
    try {
      await fs.symlink(path.join(outsideDir, "recipes"), path.join(f.forgeRoot, "recipes"), "junction");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") {
        return;
      }
      throw e;
    }
    gitInit(f.forgeRoot);

    const scratchDir = await tmpDir("craftar-scratch-");
    cleanups.push(() => fs.rm(scratchDir, { recursive: true, force: true }));

    await expect(copyForgeForProof(f.forgeRoot, scratchDir)).rejects.toThrow(
      "recipes is a symbolic link in the Forge — promote does not read a linked recipes, ingredients or profiles directory; replace it with the directory and commit",
    );
  });

  it("R6c. copyForgeForProof refuses root directory link: profiles", async () => {
    const { copyForgeForProof } = await import("../src/importers/drift-promote.js");
    const f = await F();
    
    const outsideDir = await tmpDir("outside-pro-");
    cleanups.push(() => fs.rm(outsideDir, { recursive: true, force: true }));
    
    await fs.rename(path.join(f.forgeRoot, "profiles"), path.join(outsideDir, "profiles"));
    try {
      await fs.symlink(path.join(outsideDir, "profiles"), path.join(f.forgeRoot, "profiles"), "junction");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") {
        return;
      }
      throw e;
    }
    gitInit(f.forgeRoot);

    const scratchDir = await tmpDir("craftar-scratch-");
    cleanups.push(() => fs.rm(scratchDir, { recursive: true, force: true }));

    await expect(copyForgeForProof(f.forgeRoot, scratchDir)).rejects.toThrow(
      "profiles is a symbolic link in the Forge — promote does not read a linked recipes, ingredients or profiles directory; replace it with the directory and commit",
    );
  });

  it("R7. CLI: linked profiles directory → exit 1 with params outcome, Forge and link target untouched, no scratch left", async () => {
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    
    // P fixture: a templated rule with params outcome
    const s = await scenario(
      {
        ingredients: [
          {
            meta: {
              type: "rule",
              name: "a",
              params: { "scm.org": { default: "acme-org" } },
            },
            files: { "rule.md": "Org: {{scm.org}}\nA two\n" },
          },
          rule("b", "B one\n"),
        ],
        recipes: [recipe("base", ["rule/a", "rule/b"])],
        profiles: [profile("acme", ["base"], ["claude-code"], { params: { "scm.org": "acme-org" } })],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    
    // Move profiles to outside and replace with junction
    const outsideDir = await tmpDir("outside-pro-cli-");
    cleanups.push(() => fs.rm(outsideDir, { recursive: true, force: true }));
    await fs.rename(path.join(s.forgeRoot, "profiles"), path.join(outsideDir, "profiles"));
    try {
      await fs.symlink(path.join(outsideDir, "profiles"), path.join(s.forgeRoot, "profiles"), "junction");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") {
        return;
      }
      throw e;
    }
    gitInit(s.forgeRoot);
    
    const outsideListing = (await fs.readdir(path.join(outsideDir, "profiles"))).sort();
    expect(runCli(["sync", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } }).code).toBe(0);
    
    // Trigger params outcome: change only the param value
    await fs.writeFile(path.join(s.wsRoot, A), "Org: globex-org\nA two\n");
    const lockBefore = await fs.readFile(path.join(s.wsRoot, "craftar.lock"));
    const scratchBefore = await scratchDirs();
    
    const r = runCli(["drift", "promote", A, "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "error: profiles is a symbolic link in the Forge — promote does not read a linked recipes, ingredients or profiles directory; replace it with the directory and commit\n",
    );
    // Outside profiles listing unchanged
    expect((await fs.readdir(path.join(outsideDir, "profiles"))).sort()).toEqual(outsideListing);
    // Forge porcelain empty
    expect(porcelain(s.forgeRoot)).toBe("");
    // Lock unchanged
    expect((await fs.readFile(path.join(s.wsRoot, "craftar.lock"))).equals(lockBefore)).toBe(true);
    // No scratch left
    expect(await scratchDirs()).toEqual(scratchBefore);
  });
});

describe("profile label from real file (commit 1)", () => {
  it("R8a. params outcome with profile in client-a directory → report shows profiles/client-a/profile.yaml", async () => {
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    
    // Create a fixture where profile 'acme' lives in directory 'client-a'
    const root = await tmpDir("craftar-fixture-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");
    
    // Build forge by hand with profile in client-a directory
    await fs.mkdir(path.join(forgeRoot, "ingredients", "rules", "a"), { recursive: true });
    await fs.writeFile(path.join(forgeRoot, "ingredients", "rules", "a", "ingredient.yaml"),
      YAML.stringify({ type: "rule", name: "a", params: { "scm.org": { default: "acme-org" } } }));
    await fs.writeFile(path.join(forgeRoot, "ingredients", "rules", "a", "rule.md"), "Org: {{scm.org}}\nA two\n");
    await fs.mkdir(path.join(forgeRoot, "recipes"), { recursive: true });
    await fs.writeFile(path.join(forgeRoot, "recipes", "base.yaml"), YAML.stringify({ name: "base", ingredients: ["rule/a"] }));
    // Profile acme lives in profiles/client-a/ directory
    await fs.mkdir(path.join(forgeRoot, "profiles", "client-a"), { recursive: true });
    await fs.writeFile(path.join(forgeRoot, "profiles", "client-a", "profile.yaml"),
      YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code"], params: { "scm.org": "acme-org" } }));
    await fs.writeFile(path.join(forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test", schema: 1 }));
    
    gitInit(forgeRoot);
    
    // Create workspace
    await makeWorkspace(wsRoot, forgeRoot, { config: { profile: "acme" } });
    expect(runCli(["sync", "--workspace", wsRoot], { env: { CRAFTAR_HOME: home } }).code).toBe(0);
    
    // Trigger params outcome
    await fs.writeFile(path.join(wsRoot, A), "Org: globex-org\nA two\n");
    
    const r = runCli(["drift", "promote", A, "--workspace", wsRoot], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      `promote ${A} → profile acme (params)\n` +
        "  edited profiles/client-a/profile.yaml (params)\n" +
        `  param scm.org: "acme-org" → "globex-org"\n` +
        "  proved: this workspace plans the file on disk; 0 other file(s) unchanged\n" +
        "  next sync: nothing to sync\n" +
        "  no other registered workspace reads this Forge\n" +
        "  the Forge is not committed — review with git, then commit and push it\n",
    );
  });

  it("R8b. case-2 recipe fork with profile in client-a directory → report shows profiles/client-a/profile.yaml", async () => {
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    
    // Create a fixture where profile 'acme' lives in directory 'client-a'
    // and there's a second profile 'beta' so case 2 applies (recipe fork)
    const root = await tmpDir("craftar-fixture-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const wsRoot = path.join(root, "ws");
    
    // Build forge by hand
    await fs.mkdir(path.join(forgeRoot, "ingredients", "rules", "a"), { recursive: true });
    await fs.writeFile(path.join(forgeRoot, "ingredients", "rules", "a", "ingredient.yaml"),
      YAML.stringify({ type: "rule", name: "a" }));
    await fs.writeFile(path.join(forgeRoot, "ingredients", "rules", "a", "rule.md"), "A one\n");
    await fs.mkdir(path.join(forgeRoot, "recipes"), { recursive: true });
    await fs.writeFile(path.join(forgeRoot, "recipes", "base.yaml"), YAML.stringify({ name: "base", ingredients: ["rule/a"] }));
    // Profile acme in client-a directory
    await fs.mkdir(path.join(forgeRoot, "profiles", "client-a"), { recursive: true });
    await fs.writeFile(path.join(forgeRoot, "profiles", "client-a", "profile.yaml"),
      YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code"] }));
    // Profile beta in client-b directory (so case 2 applies: base is shared)
    await fs.mkdir(path.join(forgeRoot, "profiles", "client-b"), { recursive: true });
    await fs.writeFile(path.join(forgeRoot, "profiles", "client-b", "profile.yaml"),
      YAML.stringify({ name: "beta", recipes: ["base"], targets: ["claude-code"] }));
    await fs.writeFile(path.join(forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test", schema: 1 }));
    
    gitInit(forgeRoot);
    
    // Create workspace
    await makeWorkspace(wsRoot, forgeRoot, { config: { profile: "acme" } });
    expect(runCli(["sync", "--workspace", wsRoot], { env: { CRAFTAR_HOME: home } }).code).toBe(0);
    
    // Drift rule a
    await fs.appendFile(path.join(wsRoot, A), "hand a\n");
    
    const r = runCli(["drift", "promote", A, "--workspace", wsRoot], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      `promote ${A} → rule/a--acme (variant, profile acme)\n` +
        "  wrote  ingredients/rules/a--acme/ingredient.yaml\n" +
        "  wrote  ingredients/rules/a--acme/rule.md\n" +
        "  wrote  recipes/base--acme.yaml\n" +
        "  edited profiles/client-a/profile.yaml (recipes)\n" +
        "  proved: this workspace plans the file on disk; 0 other file(s) unchanged\n" +
        "  next sync: nothing to sync\n" +
        "  no other registered workspace reads this Forge\n" +
        "  the Forge is not committed — review with git, then commit and push it\n",
    );
  });
});
