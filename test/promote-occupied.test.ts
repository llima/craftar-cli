/**
 * Tests for promote's `occupied()` function improvements:
 * - lstat and listFiles errors should report with a clear message
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";
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

describe.skipIf(process.platform === "win32")("promote occupied() error messages", () => {
  // Root ignores the read-only bit, so the scenario cannot fail there.
  it.skipIf(process.getuid?.() === 0)("unreadable directory inside the base is refused in words", async () => {
    const s = await scenario(
      {
        ingredients: [rule("workflow", "base text\n"), rule("workflow--acme", "variant text\n", { as: "workflow" })],
        recipes: [recipe("acme-recipe", ["rule/workflow--acme"]), recipe("globex-recipe", ["rule/workflow"])],
        profiles: [profile("acme", ["acme-recipe"]), profile("globex", ["globex-recipe"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    const sub = path.join(s.forgeRoot, "ingredients/rules/workflow/sub");
    await fs.mkdir(sub);
    cleanups.push(() => fs.chmod(sub, 0o755).catch(() => undefined));
    await fs.chmod(sub, 0o000);
    gitInit(s.forgeRoot);

    const r = runCli(["forge", "promote", "rule/workflow", "--profile", "acme", "--forge", s.forgeRoot, "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("forge promote: cannot read ingredients/rules/workflow (EACCES)");
    expect(r.stderr).not.toContain("scandir");
  });

  it.skipIf(process.getuid?.() === 0)("unreadable directory at would-be variant path reports with clear message", async () => {
    // Set up a Forge where the would-be variant path is an unreadable directory.
    const s = await scenario(
      {
        ingredients: [rule("workflow", "base text\n")],
        recipes: [
          recipe("acme-recipe", ["rule/workflow--acme"]),
          recipe("globex-recipe", ["rule/workflow"]),
        ],
        profiles: [profile("acme", ["acme-recipe"]), profile("globex", ["globex-recipe"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);

    // Create the acme variant
    await fs.mkdir(path.join(s.forgeRoot, "ingredients/rules/workflow--acme"), { recursive: true });
    await fs.writeFile(
      path.join(s.forgeRoot, "ingredients/rules/workflow--acme/ingredient.yaml"),
      "type: rule\nname: workflow--acme\nas: workflow\nfile: rule.md\ntargets: '*'\n",
    );
    await fs.writeFile(path.join(s.forgeRoot, "ingredients/rules/workflow--acme/rule.md"), "variant text\n");

    // Create the would-be globex variant path as an empty directory, then make it unreadable
    const variantDir = path.join(s.forgeRoot, "ingredients/rules/workflow--globex");
    await fs.mkdir(variantDir, { recursive: true });
    cleanups.push(() => fs.chmod(variantDir, 0o755).catch(() => undefined));
    await fs.chmod(variantDir, 0o000);

    gitInit(s.forgeRoot);

    // forge promote should fail with a clear message, not a raw scandir error
    const r = runCli(["forge", "promote", "rule/workflow", "--profile", "acme", "--forge", s.forgeRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("forge promote: cannot read ingredients/rules/workflow--globex (EACCES)");
    expect(r.stderr).not.toContain("scandir");
    // Should not expose the absolute Forge path
    expect(r.stderr).not.toContain(s.forgeRoot);
  });
});
