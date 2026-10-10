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

    // Print the synced AGENTS.md and .kiro/steering/a.md for result.txt
    const agentsMd = await f.read("AGENTS.md");
    const kiroA = await f.read(".kiro/steering/a.md");
    console.log("--- AGENTS.md (synced) ---");
    console.log(agentsMd);
    console.log("--- .kiro/steering/a.md (synced) ---");
    console.log(kiroA);

    await f.driftA();

    const r = runCli(["drift", "promote", A, "--workspace", f.ws]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    // Check it has the dependent paths and the next sync line
    expect(r.stdout).toContain("  also changes .kiro/steering/a.md, AGENTS.md\n");
    expect(r.stdout).toContain("  next sync: 2 update — run `craftar sync`\n");

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

  it("55. D16 same profile, override — sections outcome is refused when ws2 fills the section", async () => {
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
    // The report should show ws2 with update (it sees the profile value change but its override wins)
    expect(r.stdout).toContain(`1 other workspace(s) of profile acme read this Forge: ${realWs2}`);
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
    expect(r.stdout).toContain("  warn other workspaces could not be checked (registry: off)\n");
    expect(r.stdout).not.toContain("no other registered workspace");

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

    // List forges/ entries before
    const forgesDir = path.join(home, "forges");
    const forgesBefore = await fs.readdir(forgesDir).catch(() => []);
    const statsBefore = new Map<string, number>();
    for (const entry of forgesBefore) {
      const stat = await fs.stat(path.join(forgesDir, entry)).catch(() => null);
      if (stat) statsBefore.set(entry, stat.mtimeMs);
    }

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
    const forgesAfter = await fs.readdir(forgesDir).catch(() => []);
    expect(forgesAfter.sort()).toEqual(forgesBefore.sort());
    for (const entry of forgesAfter) {
      const stat = await fs.stat(path.join(forgesDir, entry)).catch(() => null);
      if (stat && statsBefore.has(entry)) {
        expect(stat.mtimeMs).toBe(statsBefore.get(entry));
      }
    }
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