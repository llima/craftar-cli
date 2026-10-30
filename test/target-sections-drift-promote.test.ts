/**
 * Spec 41 Part B Task 05 — Drift promote with target-scoped sections.
 * Tests that drift promote infers a section only when it reaches the importing target.
 */
import { afterEach, describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { execFileSync } from "node:child_process";
import { applyPromote, planPromote } from "../src/importers/drift-promote.js";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { tmpDir } from "./helpers/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const root = await tmpDir("craftar-drift-promote-target-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return { root, forge: path.join(root, "forge"), ws: (name: string) => path.join(root, name) };
}

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

/** Sync a workspace to disk. */
async function syncWorkspace(wsRoot: string): Promise<void> {
  const ws = await loadWorkspace(wsRoot);
  const p = await plan(ws);
  const st = await status(ws, p, await readLock(ws.root));
  await apply(ws, p, st, {});
}

/**
 * Creates a schema-6 Forge with rule `style` having two target-scoped sections:
 * - `k` targets=kiro: only for kiro
 * - `c` targets=claude-code: only for claude-code
 */
async function schemaWithTargetedSections(t: { forge: string; ws: (name: string) => string }) {
  const LF = "\n";
  const openK = "<!-- craftar:section k targets=kiro -->";
  const openC = "<!-- craftar:section c targets=claude-code -->";
  const close = "<!-- /craftar:section -->";

  // rule/style with two target-scoped sections
  const styleBody = [
    "# Style",
    "",
    openK,
    "Kiro default content.",
    close,
    "",
    openC,
    "Claude default content.",
    close,
    "",
    "End.",
  ].join(LF) + LF;

  // Create the Forge structure
  await fs.mkdir(path.join(t.forge, "ingredients/rules/style"), { recursive: true });
  await fs.mkdir(path.join(t.forge, "recipes"), { recursive: true });
  await fs.mkdir(path.join(t.forge, "profiles/acme"), { recursive: true });

  // Write craftar.forge.yaml with schema 6
  await fs.writeFile(
    path.join(t.forge, "craftar.forge.yaml"),
    YAML.stringify({ name: "test-forge", schema: 6 }),
  );

  // Write ingredient
  await fs.writeFile(
    path.join(t.forge, "ingredients/rules/style/ingredient.yaml"),
    YAML.stringify({ type: "rule", name: "style" }),
  );
  await fs.writeFile(path.join(t.forge, "ingredients/rules/style/rule.md"), styleBody);

  // Write recipe
  await fs.writeFile(
    path.join(t.forge, "recipes/base.yaml"),
    YAML.stringify({ name: "base", ingredients: ["rule/style"] }),
  );

  // Write profile
  await fs.writeFile(
    path.join(t.forge, "profiles/acme/profile.yaml"),
    YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code", "kiro"] }),
  );

  // Initialize git in the Forge (drift promote requires a git repo)
  gitInit(t.forge);

  // Create workspace with craftar.yaml
  const wsRoot = t.ws("acme");
  await fs.mkdir(wsRoot, { recursive: true });
  await fs.writeFile(
    path.join(wsRoot, "craftar.yaml"),
    YAML.stringify({ forge: "../forge", profile: "acme" }),
  );

  return { forgeRoot: t.forge, wsRoot, styleBody };
}

describe("drift promote with target-scoped sections (spec 41 Part B Task 05)", () => {
  it("hand edit inside 'c' section of .claude/rules/style.md promotes into profile's sections; Forge's rule.md keeps both markers", async () => {
    const t = await setup();
    const { forgeRoot, wsRoot, styleBody } = await schemaWithTargetedSections(t);

    // Sync the workspace
    await syncWorkspace(wsRoot);

    // Hand-edit the .claude/rules/style.md file — change only the 'c' section
    const claudeRule = path.join(wsRoot, ".claude/rules/style.md");
    const content = await fs.readFile(claudeRule, "utf8");
    const edited = content.replace("Claude default content.", "Edited Claude content.");
    await fs.writeFile(claudeRule, edited);

    // Promote the drift
    const result = await planPromote({
      workspaceRoot: wsRoot,
      forgeDir: null, // use workspace's Forge
      path: ".claude/rules/style.md",
      home: path.join(t.root, ".craftar"),
      env: { ...process.env, CRAFTAR_NO_REGISTRY: "1" },
    });

    // Should be a sections outcome, not variant
    expect(result.outcome).toBe("sections");
    expect(result.sections).toEqual([{ key: "rule/style", name: "c", lines: 1, value: "Edited Claude content.\n" }]);

    // Apply the promote to actually write the profile
    await applyPromote(result);

    // The Forge's rule.md should still have both markers with targets=
    const forgeRule = await fs.readFile(path.join(forgeRoot, "ingredients/rules/style/rule.md"), "utf8");
    expect(forgeRule).toBe(styleBody); // Unchanged!
    expect(forgeRule).toContain("<!-- craftar:section k targets=kiro -->");
    expect(forgeRule).toContain("<!-- craftar:section c targets=claude-code -->");

    // The profile should have the new section value
    const profile = YAML.parse(await fs.readFile(path.join(forgeRoot, "profiles/acme/profile.yaml"), "utf8"));
    expect(profile.sections).toEqual({ "rule/style": { c: "Edited Claude content.\n" } });
  });
});
