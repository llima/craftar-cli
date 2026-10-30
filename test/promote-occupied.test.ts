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
  // Root ignores the read-only bit, so the scenario cannot fail there.
  it.skipIf(process.getuid?.() === 0)("(2) lstat EACCES on parent directory fails closed", async () => {
    // Set up a Forge where the parent directory of the would-be variant is unreadable.
    const s = await scenario(
      {
        ingredients: [rule("a", "base text\n")],
        recipes: [
          recipe("acme-recipe", ["rule/a--acme"]),
          recipe("globex-recipe", ["rule/a"]),
        ],
        profiles: [profile("acme", ["acme-recipe"]), profile("globex", ["globex-recipe"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);

    // Create the acme variant
    await fs.mkdir(path.join(s.forgeRoot, "ingredients/rules/a--acme"), { recursive: true });
    await fs.writeFile(
      path.join(s.forgeRoot, "ingredients/rules/a--acme/ingredient.yaml"),
      "type: rule\nname: a--acme\nas: a\nfile: rule.md\ntargets: '*'\n",
    );
    await fs.writeFile(path.join(s.forgeRoot, "ingredients/rules/a--acme/rule.md"), "variant text\n");

    gitInit(s.forgeRoot);

    // Make the rules directory unreadable — lstat on a--globex will fail with EACCES
    const rulesDir = path.join(s.forgeRoot, "ingredients/rules");
    cleanups.push(() => fs.chmod(rulesDir, 0o755).catch(() => undefined));
    await fs.chmod(rulesDir, 0o000);

    // forge promote should fail closed (propagate the EACCES) rather than assume "not occupied"
    const r = runCli(["forge", "promote", "rule/a", "--profile", "acme", "--forge", s.forgeRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/EACCES|permission denied/i);
  });
});
