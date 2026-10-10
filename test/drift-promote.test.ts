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

    // Forge directory listing unchanged
    const before = await fs.readdir(f.forgeRoot, { recursive: true });
    expect(before).not.toContain("a--acme");
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
      expect(r.stderr.startsWith(`error: drift promote can only change files git can restore — 1 path(s) under ${root} are not:\n`)).toBe(true);
      expect(r.stderr).toContain("recipes/base.yaml is not held by git (modified)");
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
      const root = await realpath(f);
      expect(r.stderr.startsWith(`error: drift promote can only change files git can restore — 1 path(s) under ${root} are not:\n`)).toBe(true);
      expect(r.stderr).toContain("recipes/base.yaml is not held by git (untracked)");
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
      const root = await realpath(f);
      expect(r.stderr.startsWith(`error: drift promote can only change files git can restore — 1 path(s) under ${root} are not:\n`)).toBe(true);
      expect(r.stderr).toContain("recipes/base.yaml is not held by git (assume-unchanged)");
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
});
