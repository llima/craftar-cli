import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { loadForge } from "../src/core/forge.js";
import { planBasePromotion, type BasePromotion } from "../src/core/promote.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";
import { git, gitEnv } from "./helpers/remote.js";

// Task 33k — forge promote with recipes selected by a profile's integrations block.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const variant = (name: string, of: string, body: string, extra: Record<string, unknown> = {}) => rule(name, body, { as: of, ...extra });

/** A committed Forge at the specified schema, with a home for the CLI. */
async function forgeAt(schema: number, spec: ForgeSpec) {
  const root = await tmpDir("craftar-integrations-promote-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const forge = path.join(root, "forge");
  const home = path.join(root, "home");
  await makeForge(forge, spec);
  await fs.writeFile(path.join(forge, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
  git(forge, "init", "-q", "-b", "main");
  git(forge, "add", "-A");
  git(forge, "commit", "-q", "-m", "forge");
  const cli = (args: string[]) => runCli(args, { env: { CRAFTAR_HOME: home } });
  return { root, forge, home, cli };
}

/** Snapshot of all Forge files except .git/, for verifying nothing was written. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string, rel: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && e.name !== ".git") await walk(path.join(d, e.name), p);
      else if (e.isFile()) out[p] = (await fs.readFile(path.join(d, e.name))).toString("hex");
    }
  };
  await walk(dir, "");
  return out;
}

// Common Forge:
// - ingredients: rule/x (base), rule/x--acme (variant with as: x, different body)
// - recipe acme-rules with ingredients: [rule/x--acme]
// - profile acme with recipes: [acme-rules]
// - recipe pm-jira with ingredients: [rule/x]
// - profile globex with recipes: [base] and integrations: { pm: { kind: jira } }
// (an empty recipes list is allowed, but we use [base] to have globex resolve something)
const BASE_SPEC: ForgeSpec = {
  ingredients: [
    rule("x", "base text\n"),
    variant("x--acme", "x", "acme text\n"),
    rule("other", "other\n"),
  ],
  recipes: [
    recipe("base", ["rule/other"]),
    recipe("acme-rules", ["rule/x--acme"]),
    recipe("pm-jira", ["rule/x"]),
  ],
  profiles: [
    profile("acme", ["acme-rules"], ["claude-code"]),
    profile("globex", ["base"], ["claude-code"], { integrations: { pm: { kind: "jira" } } }),
  ],
};

describe("forge promote — integrations block", () => {
  it("1. schema 3, block-selected recipe names the base — planBasePromotion rejects with the integrations message", async () => {
    const f = await forgeAt(3, BASE_SPEC);
    const forge = await loadForge(f.forge);
    const before = await snapshot(f.forge);
    const message = await planBasePromotion(forge, "rule/x", "acme").then(
      () => "no refusal",
      (e: Error) => e.message,
    );
    expect(message).toBe(
      "forge promote: profile globex selects recipe pm-jira (which names rule/x) through integrations.pm — promote cannot repoint a recipe a block selects by editing a recipes list; edit the Forge by hand",
    );
    expect(await snapshot(f.forge)).toEqual(before);
  });

  it("2. same through the CLI — exits 1, stderr is 'error: ' + message, stdout empty, nothing written", async () => {
    const f = await forgeAt(3, BASE_SPEC);
    const before = await snapshot(f.forge);
    const r = f.cli(["forge", "promote", "rule/x", "--profile", "acme", "--forge", f.forge]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      "error: forge promote: profile globex selects recipe pm-jira (which names rule/x) through integrations.pm — promote cannot repoint a recipe a block selects by editing a recipes list; edit the Forge by hand\n",
    );
    expect(r.stdout).toBe("");
    expect(git(f.forge, "status", "--porcelain")).toBe("");
    expect(await snapshot(f.forge)).toEqual(before);
  });

  it("3. schema 3, reached through a selected recipe's extends — rejects with the extends chain message", async () => {
    // pm-jira has extends: [shared], no ingredients naming the base; recipe shared has ingredients: [rule/x]
    const spec: ForgeSpec = {
      ingredients: [
        rule("x", "base text\n"),
        variant("x--acme", "x", "acme text\n"),
        rule("other", "other\n"),
      ],
      recipes: [
        recipe("base", ["rule/other"]),
        recipe("acme-rules", ["rule/x--acme"]),
        recipe("shared", ["rule/x"]),
        recipe("pm-jira", [], { extends: ["shared"] }),
      ],
      profiles: [
        profile("acme", ["acme-rules"], ["claude-code"]),
        profile("globex", ["base"], ["claude-code"], { integrations: { pm: { kind: "jira" } } }),
      ],
    };
    const f = await forgeAt(3, spec);
    const forge = await loadForge(f.forge);
    const before = await snapshot(f.forge);
    const message = await planBasePromotion(forge, "rule/x", "acme").then(
      () => "no refusal",
      (e: Error) => e.message,
    );
    expect(message).toBe(
      "forge promote: profile globex reaches recipe shared (which names rule/x) through pm-jira → shared — promote would have to copy that chain; edit the Forge by hand",
    );
    expect(await snapshot(f.forge)).toEqual(before);
  });

  it("4. gate control, schema 2 — the block is not read, globex does not resolve pm-jira, planBasePromotion resolves with profiles: []", async () => {
    const f = await forgeAt(2, BASE_SPEC);
    const forge = await loadForge(f.forge);
    // At schema 2 the integrations block is ignored, so globex resolves only [base] which does not name rule/x.
    // acme resolves acme-rules which has the variant. No other profile resolves the base.
    const promotion = await planBasePromotion(forge, "rule/x", "acme");
    // No profile.yaml edits needed — only acme has the variant, and no other profile resolves the base.
    expect(promotion.profiles).toEqual([]);
    // Also verify the rest of the structure is as expected (the old base is discarded)
    expect(promotion.base).toBe("rule/x");
    expect(promotion.profile).toBe("acme");
    expect(promotion.removed).toBe("rule/x--acme");
    expect(promotion.created).toEqual([]);
    expect(promotion.discarded).toBe(true);
  });

  it("5. schema 3, profile both lists and selects the same recipe — promote refused, exits 1, Forge unchanged", async () => {
    // A profile that both lists a recipe in its written `recipes` and selects the same recipe through its
    // `integrations` block (schema 3). forge promote of a variant of an ingredient in that recipe, another
    // profile on the base.
    const spec: ForgeSpec = {
      ingredients: [
        rule("x", "base text\n"),
        variant("x--double", "x", "double text\n"),
        rule("other", "other\n"),
      ],
      recipes: [
        recipe("base", ["rule/other"]),
        recipe("double-rules", ["rule/x--double"]),
        recipe("pm-jira", ["rule/x"]),
      ],
      profiles: [
        // Profile that BOTH lists pm-jira in recipes AND selects it through integrations
        profile("double", ["pm-jira", "double-rules"], ["claude-code"], { integrations: { pm: { kind: "jira" } } }),
        // Another profile on the base
        profile("other", ["pm-jira"], ["claude-code"]),
      ],
    };
    const f = await forgeAt(3, spec);
    const before = await snapshot(f.forge);
    const r = f.cli(["forge", "promote", "rule/x", "--profile", "double", "--forge", f.forge]);
    // exit 1: the proof refuses because double resolves rule/x itself (from pm-jira via both routes)
    expect(r.code).toBe(1);
    // The refusal: the Forge is inconsistent — double resolves rule/x itself, writing one file from two ingredients
    expect(r.stderr).toBe(
      "error: forge promote: profile double resolves rule/x itself — the Forge is inconsistent (it would write one file from two ingredients); remove one from its recipes by hand, commit, and re-run\n",
    );
    expect(r.stdout).toBe("");
    // The Forge should be unchanged
    expect(git(f.forge, "status", "--porcelain")).toBe("");
    expect(await snapshot(f.forge)).toEqual(before);
  });
});
