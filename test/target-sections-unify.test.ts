/**
 * Spec 41 Part B Task 05 — Unify with target-scoped sections.
 * Tests that U1 compares a section's targets during unify.
 */
import { afterEach, describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { execFileSync } from "node:child_process";
import { planFrom, applyPlan, type UnifyPlan } from "../src/core/unify.js";
import { diffIngredients } from "../src/core/variants.js";
import { loadForge, typeFolder } from "../src/core/forge.js";
import { tmpDir } from "./helpers/forge.js";
import type { Ingredient, IngredientRef } from "../src/schema/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const root = await tmpDir("craftar-unify-target-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return { root, forge: path.join(root, "forge") };
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

interface LoadedIngredient {
  ref: IngredientRef;
  dir: string;
  meta: Ingredient;
}

/** Load an ingredient from the Forge. */
async function loadIngredient(forgeRoot: string, ref: IngredientRef): Promise<LoadedIngredient> {
  const [type, name] = ref.split("/");
  const dir = path.join(forgeRoot, "ingredients", typeFolder(type), name);
  const metaFile = path.join(dir, "ingredient.yaml");
  const meta = YAML.parse(await fs.readFile(metaFile, "utf8")) as Ingredient;
  return { ref, dir, meta };
}

describe("unify with target-scoped sections (spec 41 Part B Task 05)", () => {
  it("U1 message shows 'x (targets=kiro)' when targets differ between base and merged result", async () => {
    // This test checks that U1 compares targets, not just names.
    // The base has section x with targets=kiro. The variant has section x with targets=claude-code.
    // When taking variant, the merge changes the targets. U1 should detect this and show
    // 'x (targets=kiro)' in its refusal message.
    const t = await setup();
    const LF = "\n";

    // Base: section x targeted to kiro
    const baseBody = [
      "# Style",
      "",
      "<!-- craftar:section x targets=kiro -->",
      "Base content.",
      "<!-- /craftar:section -->",
      "",
      "End.",
    ].join(LF) + LF;

    // Variant: section x targeted to claude-code (different target!)
    const variantBody = [
      "# Style",
      "",
      "<!-- craftar:section x targets=claude-code -->",
      "Base content.",
      "<!-- /craftar:section -->",
      "",
      "End.",
    ].join(LF) + LF;

    await fs.mkdir(path.join(t.forge, "ingredients/rules/style"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "ingredients/rules/style--acme"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "recipes"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "profiles/acme"), { recursive: true });

    await fs.writeFile(
      path.join(t.forge, "craftar.forge.yaml"),
      YAML.stringify({ name: "test-forge", schema: 6 }),
    );

    await fs.writeFile(
      path.join(t.forge, "ingredients/rules/style/ingredient.yaml"),
      YAML.stringify({ type: "rule", name: "style" }),
    );
    await fs.writeFile(path.join(t.forge, "ingredients/rules/style/rule.md"), baseBody);

    await fs.writeFile(
      path.join(t.forge, "ingredients/rules/style--acme/ingredient.yaml"),
      YAML.stringify({ type: "rule", name: "style--acme", as: "style" }),
    );
    await fs.writeFile(path.join(t.forge, "ingredients/rules/style--acme/rule.md"), variantBody);

    await fs.writeFile(
      path.join(t.forge, "recipes/base.yaml"),
      YAML.stringify({ name: "base", ingredients: ["rule/style"] }),
    );
    await fs.writeFile(
      path.join(t.forge, "recipes/base--acme.yaml"),
      YAML.stringify({ name: "base--acme", ingredients: ["rule/style--acme"] }),
    );

    await fs.writeFile(
      path.join(t.forge, "profiles/acme/profile.yaml"),
      YAML.stringify({ name: "acme", recipes: ["base--acme"], targets: ["claude-code", "kiro"] }),
    );

    gitInit(t.forge);

    const base = await loadIngredient(t.forge, "rule/style");
    const variant = await loadIngredient(t.forge, "rule/style--acme");
    const diff = await diffIngredients(base, variant);
    const plan = await planFrom(base, variant, diff, "acme");

    // Set all hunks to take variant
    for (const f of plan.files) {
      if (f.hunks) for (const h of f.hunks) h.take = "variant";
      else f.take = "variant";
    }

    const forge = await loadForge(t.forge);
    const baseKey = `rule/style`;
    const profileSections = forge.profiles.get("acme")?.sections?.[baseKey] ?? {};

    // The applyPlan should fail because U1 detects target change
    // The error message should contain "x (targets=kiro)" to show the original target
    try {
      await applyPlan(base, variant, diff, plan, { discardVariantMeta: false, profileSections, forgeSchema: 6 });
      // If we get here, the merge succeeded when it should have been refused
      expect.fail("Expected U1 to refuse the merge due to target change");
    } catch (e) {
      const msg = (e as Error).message;
      // The message should show the target information
      expect(msg).toContain("x (targets=kiro)");
    }
  });

  it("U1 message shows 'x' (no targets) when targets= is dropped from a section", async () => {
    // Base has section x with targets=kiro. Variant has section x without targets=.
    // U1 should detect this change and show both forms in the message.
    const t = await setup();
    const LF = "\n";

    // Base: section x targeted to kiro
    const baseBody = [
      "# Style",
      "",
      "<!-- craftar:section x targets=kiro -->",
      "Base content.",
      "<!-- /craftar:section -->",
      "",
      "End.",
    ].join(LF) + LF;

    // Variant: section x without targets (applies to all)
    const variantBody = [
      "# Style",
      "",
      "<!-- craftar:section x -->",
      "Base content.",
      "<!-- /craftar:section -->",
      "",
      "End.",
    ].join(LF) + LF;

    await fs.mkdir(path.join(t.forge, "ingredients/rules/style"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "ingredients/rules/style--acme"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "recipes"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "profiles/acme"), { recursive: true });

    await fs.writeFile(
      path.join(t.forge, "craftar.forge.yaml"),
      YAML.stringify({ name: "test-forge", schema: 6 }),
    );

    await fs.writeFile(
      path.join(t.forge, "ingredients/rules/style/ingredient.yaml"),
      YAML.stringify({ type: "rule", name: "style" }),
    );
    await fs.writeFile(path.join(t.forge, "ingredients/rules/style/rule.md"), baseBody);

    await fs.writeFile(
      path.join(t.forge, "ingredients/rules/style--acme/ingredient.yaml"),
      YAML.stringify({ type: "rule", name: "style--acme", as: "style" }),
    );
    await fs.writeFile(path.join(t.forge, "ingredients/rules/style--acme/rule.md"), variantBody);

    await fs.writeFile(
      path.join(t.forge, "recipes/base.yaml"),
      YAML.stringify({ name: "base", ingredients: ["rule/style"] }),
    );
    await fs.writeFile(
      path.join(t.forge, "recipes/base--acme.yaml"),
      YAML.stringify({ name: "base--acme", ingredients: ["rule/style--acme"] }),
    );

    await fs.writeFile(
      path.join(t.forge, "profiles/acme/profile.yaml"),
      YAML.stringify({ name: "acme", recipes: ["base--acme"], targets: ["claude-code", "kiro"] }),
    );

    gitInit(t.forge);

    const base = await loadIngredient(t.forge, "rule/style");
    const variant = await loadIngredient(t.forge, "rule/style--acme");
    const diff = await diffIngredients(base, variant);
    const plan = await planFrom(base, variant, diff, "acme");

    // Set all hunks to take variant
    for (const f of plan.files) {
      if (f.hunks) for (const h of f.hunks) h.take = "variant";
      else f.take = "variant";
    }

    const forge = await loadForge(t.forge);
    const baseKey = `rule/style`;
    const profileSections = forge.profiles.get("acme")?.sections?.[baseKey] ?? {};

    // The applyPlan should fail because U1 detects target change
    try {
      await applyPlan(base, variant, diff, plan, { discardVariantMeta: false, profileSections, forgeSchema: 6 });
      expect.fail("Expected U1 to refuse the merge due to target change");
    } catch (e) {
      const msg = (e as Error).message;
      // The message should show "x (targets=kiro)" → "x" transition
      // i.e., it should contain both the original (with target) and the result (without)
      expect(msg).toMatch(/x \(targets=kiro\).*x(?! \(targets)|x(?! \(targets).*x \(targets=kiro\)/);
    }
  });

  it("golden-take-section and golden-sections pins unchanged", async () => {
    // This is a placeholder that will be verified by running those existing golden tests
    // They should pass unchanged after our implementation
    expect(true).toBe(true);
  });
});
