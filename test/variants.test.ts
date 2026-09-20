import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { loadForge } from "../src/core/forge.js";
import { diffIngredients, listVariants, profileOf } from "../src/core/variants.js";
import { makeForge, rule, tmpDir, type ForgeSpec } from "./helpers/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function forgeWith(ingredients: NonNullable<ForgeSpec["ingredients"]>) {
  const root = await tmpDir();
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  await makeForge(root, { ingredients });
  return loadForge(root);
}

describe("profileOf", () => {
  it("takes the profile after the base name, even when the profile contains --", () => {
    expect(profileOf({ name: "workflow--acme--eu", as: "workflow" })).toBe("acme--eu");
    expect(profileOf({ name: "workflow" })).toBeNull();
    expect(profileOf({ name: "workflow--", as: "workflow" })).toBeNull();
  });
});

describe("listVariants", () => {
  it("breaks distance ties by ref, so the order does not depend on the filesystem", async () => {
    const forge = await forgeWith([
      rule("zeta", "a\nb\n"),
      rule("zeta--acme", "a\nB\n", { as: "zeta" }),
      rule("alpha", "a\nb\n"),
      rule("alpha--acme", "a\nB\n", { as: "alpha" }),
    ]);
    expect((await listVariants(forge)).groups.map((g) => g.base)).toEqual(["rule/alpha", "rule/zeta"]);
  });

  it("lists only bases that have variants, sorted by ascending distance", async () => {
    const forge = await forgeWith([
      rule("alone", "only one\n"),
      rule("small", "a\nb\nc\n"),
      rule("small--acme", "a\nB\nc\n", { as: "small" }),
      rule("big", "1\n2\n3\n4\n5\n"),
      rule("big--acme", "1\nX\nY\nZ\n5\n", { as: "big" }),
    ]);
    const { groups } = await listVariants(forge);
    expect(groups.map((g) => g.base)).toEqual(["rule/small", "rule/big"]);
    expect(groups[0].variants[0]).toMatchObject({ ref: "rule/small--acme", profile: "acme" });
    expect(groups[0].variants[0].distance).toMatchObject({ lines: 2, hunks: 1 });
  });

  it("counts a one-sided file by its lines, not by diffing it against an empty string", async () => {
    const forge = await forgeWith([
      rule("base", "shared\n"),
      {
        meta: { type: "rule", name: "base--acme", as: "base" },
        files: { "rule.md": "shared\n", "extra.md": "one\ntwo" },
      },
    ]);
    const { groups } = await listVariants(forge);
    expect(groups[0].variants[0].distance).toMatchObject({ lines: 2, hunks: 1 });
  });

  it("counts a one-sided file with an interior blank line, which the old path undercounted", async () => {
    const forge = await forgeWith([
      rule("blank", "shared\n"),
      {
        meta: { type: "rule", name: "blank--acme", as: "blank" },
        files: { "rule.md": "shared\n", "extra.md": "a\n\nb" },
      },
    ]);
    const { groups } = await listVariants(forge);
    expect(groups[0].variants[0].distance).toMatchObject({ lines: 3, hunks: 1 });
  });

  it("flags a body-identical variant whose metadata differs", async () => {
    const forge = await forgeWith([rule("x", "same\n"), rule("x--acme", "same\n", { as: "x", targets: ["kiro"] })]);
    const { groups: [group] } = await listVariants(forge);
    expect(group.variants[0].distance).toMatchObject({ lines: 0, hunks: 0, metaDiffers: true, identicalAfterNormalization: false });
  });

  it("flags a variant that differs only in line endings or a BOM", async () => {
    const forge = await forgeWith([rule("x", "one\ntwo\n"), rule("x--acme", "﻿one\r\ntwo\r\n", { as: "x" })]);
    const { groups: [group] } = await listVariants(forge);
    expect(group.variants[0].distance).toMatchObject({ lines: 0, hunks: 0, metaDiffers: false, identicalAfterNormalization: true });
  });

  it("does not list an ingredient that has no variant", async () => {
    const forge = await forgeWith([rule("alone", "x\n")]);
    expect((await listVariants(forge)).groups).toEqual([]);
  });

  it("counts a one-sided file toward distance and sorts variants within a group", async () => {
    const forge = await forgeWith([
      rule("x", "a\nb\nc\n"),
      rule("x--acme--eu", "a\nB\nc\n", { as: "x" }),
      { meta: { type: "rule", name: "x--acme", as: "x" }, files: { "rule.md": "a\nb\nc\n", "extra.md": "one\ntwo\nthree\n" } },
    ]);
    const { groups } = await listVariants(forge);
    expect(groups).toHaveLength(1);
    expect(groups[0].variants.map((v) => [v.profile, v.distance.lines, v.distance.hunks])).toEqual([
      ["acme--eu", 2, 1],
      ["acme", 3, 1],
    ]);
  });

  it("reveals a variant whose base is not in the Forge instead of skipping it", async () => {
    const forge = await forgeWith([rule("orphan--acme", "body\n", { as: "orphan" })]);
    const { groups, orphans } = await listVariants(forge);
    expect(groups).toEqual([]);
    expect(orphans).toEqual([{ ref: "rule/orphan--acme", profile: "acme", missingBase: "rule/orphan" }]);
  });

  it("treats an empty profile as no variant, so it is neither a group nor an orphan", async () => {
    const forge = await forgeWith([rule("y", "body\n"), rule("y--", "other\n", { as: "y" })]);
    const { groups, orphans } = await listVariants(forge);
    expect(groups).toEqual([]);
    expect(orphans).toEqual([]);
  });
});

describe("diffIngredients", () => {
  it("pairs files by relative path and reports one-sided files without diffing them", async () => {
    const forge = await forgeWith([
      { meta: { type: "skill", name: "deploy", layout: "dir" }, files: { "SKILL.md": "step one\n", "shared.md": "same\n" } },
      {
        meta: { type: "skill", name: "deploy--acme", as: "deploy", layout: "dir" },
        files: { "SKILL.md": "step ONE\n", "shared.md": "same\n", "extra.md": "only here\n" },
      },
    ]);
    const d = await diffIngredients(forge.ingredients.get("skill/deploy")!, forge.ingredients.get("skill/deploy--acme")!);
    expect(d.files.map((f) => f.file)).toEqual(["SKILL.md"]);
    expect(d.files[0].hunks[0].kind).toBe("inline");
    expect(d.onlyInVariant).toEqual(["extra.md"]);
    expect(d.onlyInBase).toEqual([]);
  });

  it("calls an appended paragraph a block", async () => {
    const forge = await forgeWith([rule("x", "intro\n"), rule("x--acme", "intro\nextra paragraph\n", { as: "x" })]);
    const d = await diffIngredients(forge.ingredients.get("rule/x")!, forge.ingredients.get("rule/x--acme")!);
    expect(d.files[0].hunks.map((h) => h.kind)).toEqual(["block"]);
  });
});
