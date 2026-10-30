/**
 * P4 tests for promote's `occupied()` function improvements:
 * - A symlink to a directory at the variant path is refused with an explicit message
 * - lstat errors other than ENOENT should propagate (fail-closed)
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";
import { removeWithRetry } from "./helpers/fs.js";
import { profile, recipe, rule, scenario } from "./helpers/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "craftar-test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "craftar-test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
});

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "maintenance.auto", "false"]);
  execFileSync("git", ["-C", dir, "config", "gc.auto", "0"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"], { env: gitEnv() });
}

describe.skipIf(process.platform === "win32")("promote occupied() P4 improvements", () => {
  // Symlink test requires symlink support (Linux/macOS, not Windows)
  it("(1) symlink to directory at variant path is refused explicitly", async () => {
    // Set up a Forge with two profiles (acme, globex):
    // - acme has a variant a--acme that names the base
    // - globex uses a separate recipe that resolves only the base
    // When promoting rule/a ← acme, the old base needs to become a--globex for globex.
    const s = await scenario(
      {
        ingredients: [rule("a", "base text\n")],
        recipes: [
          recipe("acme-recipe", ["rule/a--acme"]),  // acme's recipe uses the variant
          recipe("globex-recipe", ["rule/a"]),     // globex's recipe uses the base
        ],
        profiles: [profile("acme", ["acme-recipe"]), profile("globex", ["globex-recipe"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);

    // Create the acme variant (so acme has something to promote)
    await fs.mkdir(path.join(s.forgeRoot, "ingredients/rules/a--acme"), { recursive: true });
    await fs.writeFile(
      path.join(s.forgeRoot, "ingredients/rules/a--acme/ingredient.yaml"),
      "type: rule\nname: a--acme\nas: a\nfile: rule.md\ntargets: '*'\n",
    );
    await fs.writeFile(path.join(s.forgeRoot, "ingredients/rules/a--acme/rule.md"), "variant text\n");

    // Create a symlink at the would-be globex variant path pointing to a real directory
    const targetDir = path.join(s.forgeRoot, "ingredients/rules/target-for-link");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.symlink(targetDir, path.join(s.forgeRoot, "ingredients/rules/a--globex"));

    gitInit(s.forgeRoot);

    // forge promote should refuse because a--globex is a symlink to a directory
    const r = runCli(["forge", "promote", "rule/a", "--profile", "acme", "--forge", s.forgeRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("is a symbolic link");
    expect(r.stderr).toContain("a--globex");
  });
});
