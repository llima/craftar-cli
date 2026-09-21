import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { exists, gitDirty, loadForge, type Forge } from "../src/core/forge.js";
import { applyPlan, planFrom, rewriteRecipes, writeUnified } from "../src/core/unify.js";
import { diffIngredients } from "../src/core/variants.js";
import { UnifyPlanSchema } from "../src/schema/index.js";
import { makeForge, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";

const execFileP = promisify(execFile);

// Spelled out rather than embedded as a raw character: a glyph no diff viewer, editor or
// re-encoding shows should not be load-bearing in a test for byte fidelity.
const BOM = String.fromCharCode(0xfeff);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const valid = {
  schema: 1,
  base: "rule/workflow",
  profile: "acme",
  variant: "rule/workflow--acme",
  baseFingerprint: "aaa",
  variantFingerprint: "bbb",
  files: [
    { file: "rule.md", hunks: [{ hunk: 1, at: "lines 2–3", take: "variant" }] },
    { file: "extra.md", onlyIn: "variant", take: "base" },
  ],
};

describe("UnifyPlanSchema", () => {
  it("accepts a plan with a paired file and a one-sided file", () => {
    const p = UnifyPlanSchema.parse(valid);
    expect(p.files[0].hunks?.[0].take).toBe("variant");
    expect(p.files[1].onlyIn).toBe("variant");
  });

  it("rejects an unknown take", () => {
    const bad = structuredClone(valid);
    bad.files[0].hunks![0].take = "whatever";
    expect(() => UnifyPlanSchema.parse(bad)).toThrow();
  });

  it("rejects a schema version it does not know", () => {
    expect(() => UnifyPlanSchema.parse({ ...valid, schema: 2 })).toThrow();
  });
});

describe("gitDirty", () => {
  it("is false for a committed tree and true once a file changes", async () => {
    const dir = await tmpDir("craftar-git-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, "a.txt"), "one\n");
    await execFileP("git", ["-C", dir, "init", "-q"]);
    await execFileP("git", ["-C", dir, "add", "-A"]);
    await execFileP("git", ["-C", dir, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"]);
    expect(await gitDirty(dir)).toBe(false);
    await fs.writeFile(path.join(dir, "a.txt"), "two\n");
    expect(await gitDirty(dir)).toBe(true);
  });

  it("reports dirty when git cannot report at all", async () => {
    const missing = path.join(await tmpDir("craftar-git-"), "does-not-exist");
    expect(await gitDirty(missing)).toBe(true);
  });
});

function fakeDiff() {
  return {
    files: [
      { file: "rule.md", hunks: [
        { kind: "inline" as const, a: { start: 2, lines: ["old"] }, b: { start: 2, lines: ["new"] } },
        { kind: "block" as const, a: { start: 5, lines: [] }, b: { start: 5, lines: ["added"] } },
      ] },
    ],
    onlyInBase: ["gone.md"],
    onlyInVariant: ["extra.md"],
  };
}

describe("planFrom", () => {
  it("defaults every decision to keep and echoes where each hunk is", async () => {
    const BASE_DIR = await tmpDir();
    cleanups.push(() => fs.rm(BASE_DIR, { recursive: true, force: true }));
    await writeFiles(BASE_DIR, { "ingredient.yaml": "type: rule\nname: workflow\n" });

    const VARIANT_DIR = await tmpDir();
    cleanups.push(() => fs.rm(VARIANT_DIR, { recursive: true, force: true }));
    await writeFiles(VARIANT_DIR, { "ingredient.yaml": "type: rule\nname: workflow--acme\nas: workflow\n" });

    const plan = await planFrom(
      { ref: "rule/workflow", dir: BASE_DIR, meta: { type: "rule", name: "workflow" } } as never,
      { ref: "rule/workflow--acme", dir: VARIANT_DIR, meta: { type: "rule", name: "workflow--acme", as: "workflow" } } as never,
      fakeDiff() as never,
      "acme",
    );
    expect(plan.schema).toBe(1);
    expect(plan.base).toBe("rule/workflow");
    expect(plan.variant).toBe("rule/workflow--acme");
    expect(plan.profile).toBe("acme");
    const paired = plan.files.find((f) => f.file === "rule.md")!;
    expect(paired.hunks!.map((h) => h.take)).toEqual(["keep", "keep"]);
    expect(paired.hunks!.map((h) => h.hunk)).toEqual([1, 2]);
    expect(paired.hunks![0].at).toBe("lines 2–2");
    expect(paired.hunks![1].at).toBe("after line 4");
    expect(plan.files.find((f) => f.file === "gone.md")).toMatchObject({ onlyIn: "base", take: "keep" });
    expect(plan.files.find((f) => f.file === "extra.md")).toMatchObject({ onlyIn: "variant", take: "keep" });
  });
});

/** Two temp ingredient directories (base + variant--profile), loaded and diffed for real. */
async function scenario(baseFiles: Record<string, string>, variantFiles: Record<string, string>) {
  const baseDir = await tmpDir();
  cleanups.push(() => fs.rm(baseDir, { recursive: true, force: true }));
  await writeFiles(baseDir, { "ingredient.yaml": "type: rule\nname: workflow\n", ...baseFiles });

  const variantDir = await tmpDir();
  cleanups.push(() => fs.rm(variantDir, { recursive: true, force: true }));
  await writeFiles(variantDir, { "ingredient.yaml": "type: rule\nname: workflow--acme\nas: workflow\n", ...variantFiles });

  const base = { ref: "rule/workflow", dir: baseDir, meta: { type: "rule", name: "workflow" } } as never;
  const variant = { ref: "rule/workflow--acme", dir: variantDir, meta: { type: "rule", name: "workflow--acme", as: "workflow" } } as never;
  const diff = await diffIngredients(base, variant);
  return { base, variant, diff };
}

describe("applyPlan — paired files", () => {
  it("takes the variant's side for a chosen hunk and the base's for the rest", async () => {
    // base   rule.md: "a\nold\nc\n"
    // variant rule.md: "a\nnew\nc\n"
    const { base, variant, diff } = await scenario({ "rule.md": "a\nold\nc\n" }, { "rule.md": "a\nnew\nc\n" });
    const plan = await planFrom(base, variant, diff, "acme");
    plan.files[0].hunks![0].take = "variant";
    const r = await applyPlan(base, variant, diff, plan);
    expect(r.write["rule.md"]).toBe("a\nnew\nc\n");
    expect(r.unresolved).toBe(0);
    expect(r.resolved).toBe(true);
  });

  it("writes nothing for a hunk left at keep, and stays unresolved", async () => {
    const { base, variant, diff } = await scenario({ "rule.md": "a\nold\nc\n" }, { "rule.md": "a\nnew\nc\n" });
    const plan = await planFrom(base, variant, diff, "acme");
    const r = await applyPlan(base, variant, diff, plan);
    expect(r.write).toEqual({});
    expect(r.unresolved).toBe(1);
    expect(r.resolved).toBe(false);
  });

  it("keeps the base's line endings even when the variant's differ", async () => {
    const { base, variant, diff } = await scenario({ "rule.md": "a\r\nold\r\n" }, { "rule.md": "a\nnew\n" });
    const plan = await planFrom(base, variant, diff, "acme");
    plan.files[0].hunks![0].take = "variant";
    const r = await applyPlan(base, variant, diff, plan);
    expect(r.write["rule.md"]).toBe("a\r\nnew\r\n");
  });

  it("takes the final-newline state from whichever side won the last hunk", async () => {
    const { base, variant, diff } = await scenario({ "rule.md": "a\nb\n" }, { "rule.md": "a\nb" });
    const plan = await planFrom(base, variant, diff, "acme");
    plan.files[0].hunks![0].take = "variant";
    const r = await applyPlan(base, variant, diff, plan);
    expect(r.write["rule.md"]).toBe("a\nb");
  });

  it("keeps the base's final newline when the base wins the last hunk", async () => {
    const { base, variant, diff } = await scenario({ "rule.md": "a\nb\n" }, { "rule.md": "a\nb" });
    const plan = await planFrom(base, variant, diff, "acme");
    plan.files[0].hunks![0].take = "base";
    const r = await applyPlan(base, variant, diff, plan);
    expect(r.write).toEqual({}); // taking the base changes nothing
    expect(r.resolved).toBe(true);
  });

  it("applies a pure addition at a.start without dropping a base line", async () => {
    const { base, variant, diff } = await scenario({ "rule.md": "a\nb\n" }, { "rule.md": "a\nb\nc\n" });
    const plan = await planFrom(base, variant, diff, "acme");
    plan.files[0].hunks![0].take = "variant";
    const r = await applyPlan(base, variant, diff, plan);
    expect(r.write["rule.md"]).toBe("a\nb\nc\n");
  });

  it("keeps the base's BOM", async () => {
    const { base, variant, diff } = await scenario({ "rule.md": `${BOM}a\nold\n` }, { "rule.md": "a\nnew\n" });
    const plan = await planFrom(base, variant, diff, "acme");
    plan.files[0].hunks![0].take = "variant";
    const r = await applyPlan(base, variant, diff, plan);
    expect(r.write["rule.md"]).toBe(`${BOM}a\nnew\n`);
  });

  it("does not let a middle hunk decide the final newline when the base itself has none", async () => {
    // The changed line (2) sits between two unchanged lines; line 3 ("c") is identical on both
    // sides and neither side terminates it with a newline. The winning hunk never touches line
    // 3, so the merge must fall back to the base's own eofNewline instead of treating "the last
    // hunk in the array" as "the hunk that reaches the end of the file".
    const { base, variant, diff } = await scenario({ "rule.md": "a\nb\nc" }, { "rule.md": "a\nX\nc" });
    const plan = await planFrom(base, variant, diff, "acme");
    plan.files[0].hunks![0].take = "variant";
    const r = await applyPlan(base, variant, diff, plan);
    expect(r.write["rule.md"]).toBe("a\nX\nc");
  });

  // Fix round 1, Finding 1 (Ruling 7): the final newline comes from the winning side's own file,
  // not from the winning hunk's `noEofNewline` flag — that flag has nothing to say when the
  // winning side contributes no lines, as here: a pure removal taken as `variant`.
  it("takes the final newline from the winning side's own text when that side contributes no lines", async () => {
    const { base, variant, diff } = await scenario({ "rule.md": "a\nb\nc" }, { "rule.md": "a\nb\n" });
    const plan = await planFrom(base, variant, diff, "acme");
    plan.files[0].hunks![0].take = "variant";
    const r = await applyPlan(base, variant, diff, plan);
    expect(r.write["rule.md"]).toBe("a\nb\n");
  });

  // Fix round 1, Finding 2: an all-lines-removed merge is the empty string, not a lone "\n".
  it("leaves an emptied file empty, not a lone newline", async () => {
    const { base, variant, diff } = await scenario({ "rule.md": "x\n" }, { "rule.md": "" });
    const plan = await planFrom(base, variant, diff, "acme");
    plan.files[0].hunks![0].take = "variant";
    const r = await applyPlan(base, variant, diff, plan);
    expect(r.write["rule.md"]).toBe("");
  });

  // Fix round 1, Finding 3: two separate hunks in the same file, used by both tests below.
  function twoHunkScenario() {
    return scenario({ "rule.md": "a\nold1\nb\nold2\nc\n" }, { "rule.md": "a\nnew1\nb\nnew2\nc\n" });
  }

  it("refuses a plan whose hunk decisions no longer match the diff's hunk count", async () => {
    const { base, variant, diff } = await twoHunkScenario();
    const plan = await planFrom(base, variant, diff, "acme");
    // Hand-edited down to one decision for a file the diff still says has two hunks.
    plan.files[0].hunks = [{ hunk: 2, at: plan.files[0].hunks![1].at, take: "variant" }];
    await expect(applyPlan(base, variant, diff, plan)).rejects.toThrow();
  });

  it("binds each decision to the hunk index it names, even listed out of order", async () => {
    const { base, variant, diff } = await twoHunkScenario();
    const plan = await planFrom(base, variant, diff, "acme");
    // Reordered in the array: hunk 2's decision comes first, hunk 1's second.
    plan.files[0].hunks = [
      { hunk: 2, at: plan.files[0].hunks![1].at, take: "variant" },
      { hunk: 1, at: plan.files[0].hunks![0].at, take: "base" },
    ];
    const r = await applyPlan(base, variant, diff, plan);
    expect(r.write["rule.md"]).toBe("a\nold1\nb\nnew2\nc\n");
    expect(r.resolved).toBe(true);
    expect(r.unresolved).toBe(0);
  });

  // Fix round 1, Finding 4: an all-`keep` plan must not round-trip the base through
  // splitLines/withEol — that silently re-terminates a base with mixed line endings.
  it("leaves a mixed-EOL base untouched when every hunk is left at keep", async () => {
    const { base, variant, diff } = await scenario({ "rule.md": "a\r\nold\nc\n" }, { "rule.md": "a\nnew\nc\n" });
    const plan = await planFrom(base, variant, diff, "acme"); // every decision defaults to keep
    const r = await applyPlan(base, variant, diff, plan);
    expect(r.write).toEqual({});
  });

  // Earlier review: the fix that skips merging a paired file with no `variant` decision moved the
  // merge itself inside an `if`, but the `unresolved` count sits outside it. Pin both counters so
  // a future refactor that moves the counter inside the skip regresses loudly, not silently —
  // `resolved` is what gates deleting the variant's directory.
  it("reports unresolved equal to the hunk count, and resolved: false, when a paired file is left entirely at keep", async () => {
    const { base, variant, diff } = await twoHunkScenario();
    const plan = await planFrom(base, variant, diff, "acme"); // every decision defaults to keep
    const r = await applyPlan(base, variant, diff, plan);
    expect(r.write).toEqual({});
    expect(r.unresolved).toBe(2);
    expect(r.resolved).toBe(false);
  });

  // Earlier review: `PlanFileSchema` leaves both `hunks` and `onlyIn` optional, so a hand-edited
  // plan can drop both. Spec §6 puts the contradiction check on the engine, not on zod — it must
  // throw rather than silently doing nothing (no write, no remove, not even counted unresolved).
  it("throws on a plan entry with neither hunk decisions nor a side", async () => {
    const { base, variant, diff } = await scenario({ "rule.md": "a\nold\nc\n" }, { "rule.md": "a\nnew\nc\n" });
    const plan = await planFrom(base, variant, diff, "acme");
    plan.files.push({ file: "mystery.md", take: "variant" });
    await expect(applyPlan(base, variant, diff, plan)).rejects.toThrow(/mystery\.md/);
  });
});

describe("applyPlan — one-sided files", () => {
  it("copies a variant-only file into the base when taken", async () => {
    const { base, variant, diff } = await scenario({ "rule.md": "x\n" }, { "rule.md": "x\n", "extra.md": "hello\n" });
    const plan = await planFrom(base, variant, diff, "acme");
    plan.files.find((f) => f.file === "extra.md")!.take = "variant";
    const r = await applyPlan(base, variant, diff, plan);
    expect(r.write["extra.md"]).toBe("hello\n");
    expect(r.remove).toEqual([]);
  });

  it("discards a variant-only file when the base is taken", async () => {
    const { base, variant, diff } = await scenario({ "rule.md": "x\n" }, { "rule.md": "x\n", "extra.md": "hello\n" });
    const plan = await planFrom(base, variant, diff, "acme");
    plan.files.find((f) => f.file === "extra.md")!.take = "base";
    const r = await applyPlan(base, variant, diff, plan);
    expect(r.write).toEqual({});
    expect(r.remove).toEqual([]);
    expect(r.resolved).toBe(true);
  });

  it("removes a base-only file when the variant is taken", async () => {
    const { base, variant, diff } = await scenario({ "rule.md": "x\n", "gone.md": "bye\n" }, { "rule.md": "x\n" });
    const plan = await planFrom(base, variant, diff, "acme");
    plan.files.find((f) => f.file === "gone.md")!.take = "variant";
    const r = await applyPlan(base, variant, diff, plan);
    expect(r.remove).toEqual(["gone.md"]);
    expect(r.write).toEqual({});
  });

  it("leaves a base-only file alone when the base is taken", async () => {
    const { base, variant, diff } = await scenario({ "rule.md": "x\n", "gone.md": "bye\n" }, { "rule.md": "x\n" });
    const plan = await planFrom(base, variant, diff, "acme");
    plan.files.find((f) => f.file === "gone.md")!.take = "base";
    const r = await applyPlan(base, variant, diff, plan);
    expect(r.remove).toEqual([]);
    expect(r.write).toEqual({});
  });

  it("stays unresolved while any one-sided file is still keep", async () => {
    const { base, variant, diff } = await scenario({ "rule.md": "x\n" }, { "rule.md": "x\n", "extra.md": "hello\n" });
    const plan = await planFrom(base, variant, diff, "acme");
    const r = await applyPlan(base, variant, diff, plan);
    expect(r.unresolved).toBe(1);
    expect(r.resolved).toBe(false);
  });
});

describe("writeUnified", () => {
  it("writes changed files and removes the ones the plan deleted", async () => {
    const { base } = await scenario({ "rule.md": "x\n", "gone.md": "bye\n" }, { "rule.md": "x\n" });
    const touched = await writeUnified(base, { write: { "rule.md": "y\n" }, remove: ["gone.md"], resolved: true, unresolved: 0 });
    expect(touched).toEqual(["gone.md", "rule.md"]);
    expect(await fs.readFile(path.join(base.dir, "rule.md"), "utf8")).toBe("y\n");
    expect(await exists(path.join(base.dir, "gone.md"))).toBe(false);
  });

  it("never touches ingredient.yaml", async () => {
    const { base } = await scenario({ "rule.md": "x\n" }, { "rule.md": "x\n" });
    const before = await fs.readFile(path.join(base.dir, "ingredient.yaml"), "utf8");
    await writeUnified(base, { write: { "rule.md": "y\n" }, remove: [], resolved: true, unresolved: 0 });
    expect(await fs.readFile(path.join(base.dir, "ingredient.yaml"), "utf8")).toBe(before);
  });
});

/** A Forge built from a spec and loaded for real, so the test can reload after a rewrite. */
async function forgeWith(spec: ForgeSpec): Promise<Forge> {
  const root = await tmpDir();
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  await makeForge(root, spec);
  return loadForge(root);
}

describe("rewriteRecipes", () => {
  it("replaces the variant reference with the base in every recipe", async () => {
    const forge = await forgeWith({
      ingredients: [rule("workflow", "a\n"), rule("workflow--acme", "b\n", { as: "workflow" })],
      recipes: [recipe("base--acme", ["rule/workflow--acme", "rule/other"])],
      profiles: [profile("acme", ["base--acme"])],
    });
    const out = await rewriteRecipes(forge, "rule/workflow", "rule/workflow--acme", "acme");
    expect(out.rewritten).toEqual(["base--acme"]);
    const reloaded = await loadForge(forge.root);
    expect(reloaded.recipes.get("base--acme")!.ingredients).toEqual(["rule/workflow", "rule/other"]);
  });

  it("deletes a suffixed recipe that became identical to its sibling and repoints the profile", async () => {
    const forge = await forgeWith({
      ingredients: [rule("workflow", "a\n"), rule("workflow--acme", "b\n", { as: "workflow" })],
      recipes: [
        recipe("base", ["rule/workflow", "rule/other"]),
        recipe("base--acme", ["rule/workflow--acme", "rule/other"]),
      ],
      profiles: [profile("acme", ["base--acme"])],
    });
    const out = await rewriteRecipes(forge, "rule/workflow", "rule/workflow--acme", "acme");
    expect(out.deleted).toEqual(["base--acme"]);
    expect(out.profileRepointed).toEqual(["base--acme -> base"]);
    const reloaded = await loadForge(forge.root);
    expect(reloaded.recipes.has("base--acme")).toBe(false);
    expect(reloaded.profiles.get("acme")!.recipes).toEqual(["base"]);
  });

  it("leaves a suffixed recipe alone when it has no unsuffixed sibling", async () => {
    const forge = await forgeWith({
      ingredients: [rule("workflow", "a\n"), rule("workflow--acme", "b\n", { as: "workflow" })],
      recipes: [recipe("solo--acme", ["rule/workflow--acme"])],
      profiles: [profile("acme", ["solo--acme"])],
    });
    const out = await rewriteRecipes(forge, "rule/workflow", "rule/workflow--acme", "acme");
    expect(out.deleted).toEqual([]);
    const reloaded = await loadForge(forge.root);
    expect(reloaded.recipes.get("solo--acme")!.ingredients).toEqual(["rule/workflow"]);
    expect(reloaded.profiles.get("acme")!.recipes).toEqual(["solo--acme"]);
  });

  it("does not delete a sibling whose ingredients differ beyond the variant", async () => {
    const forge = await forgeWith({
      ingredients: [rule("workflow", "a\n"), rule("workflow--acme", "b\n", { as: "workflow" })],
      recipes: [
        recipe("base", ["rule/workflow"]),
        recipe("base--acme", ["rule/workflow--acme", "rule/extra"]),
      ],
      profiles: [profile("acme", ["base--acme"])],
    });
    const out = await rewriteRecipes(forge, "rule/workflow", "rule/workflow--acme", "acme");
    expect(out.deleted).toEqual([]);
  });
});

/**
 * Loads a Forge from hand-written files rather than `makeForge`, so a test can put a recipe or
 * profile under a filename/dirname that disagrees with its own `name` field, or control raw
 * bytes (comments, EOL, BOM) precisely. `rewriteRecipes` never touches `ingredients/`, so these
 * scenarios skip writing ingredient directories entirely.
 */
async function bareForge(files: Record<string, string>): Promise<Forge> {
  const root = await tmpDir();
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  await writeFiles(root, { "craftar.forge.yaml": "name: test-forge\nschema: 1\n", ...files });
  return loadForge(root);
}

describe("rewriteRecipes — file identity, byte fidelity and safety (Rulings 9, 10, 12, 13, 14)", () => {
  it("finds a recipe by its `name` field, not its filename, and never touches a same-named decoy", async () => {
    const forge = await bareForge({
      // The real "base--acme" recipe lives in a file named after something else (Ruling 9).
      "recipes/team.yaml": "name: base--acme\ningredients:\n  - rule/workflow--acme\n  - rule/other # kept\n",
      // A decoy file *named* base--acme.yaml but declaring a different `name` — a filename-based
      // lookup (`<name>.yaml`) would find and misuse this one instead of scanning for the field.
      "recipes/base--acme.yaml": "name: solo\ningredients:\n  - rule/other\n",
      "profiles/acme/profile.yaml": "name: acme\nrecipes:\n  - base--acme\n",
    });
    const out = await rewriteRecipes(forge, "rule/workflow", "rule/workflow--acme", "acme");
    expect(out.rewritten).toEqual(["base--acme"]);

    const teamText = await fs.readFile(path.join(forge.root, "recipes/team.yaml"), "utf8");
    expect(teamText).toContain("rule/workflow\n");
    expect(teamText).not.toContain("rule/workflow--acme");
    // The comment on the untouched sibling entry, in the same file, survives the edit.
    expect(teamText).toContain("# kept");

    const decoyText = await fs.readFile(path.join(forge.root, "recipes/base--acme.yaml"), "utf8");
    expect(decoyText).toBe("name: solo\ningredients:\n  - rule/other\n");
  });

  it("repoints a profile keeping exactly the keys and comment it started with — no zod defaults materialised", async () => {
    const forge = await bareForge({
      "recipes/base.yaml": "name: base\ningredients:\n  - rule/workflow\n",
      "recipes/base--acme.yaml": "name: base--acme\ningredients:\n  - rule/workflow--acme\n",
      // Only two keys on disk — ProfileSchema materialises ten (targets, language, identity...).
      "profiles/acme/profile.yaml": "name: acme\nrecipes:\n  - base--acme # pinned by ops\n",
    });
    const out = await rewriteRecipes(forge, "rule/workflow", "rule/workflow--acme", "acme");
    expect(out.deleted).toEqual(["base--acme"]);
    expect(out.profileRepointed).toEqual(["base--acme -> base"]);

    const raw = await fs.readFile(path.join(forge.root, "profiles/acme/profile.yaml"), "utf8");
    expect(raw).toContain("# pinned by ops");
    expect(raw).toContain("- base");
    expect(raw).not.toContain("base--acme");
    expect(Object.keys(YAML.parse(raw) as object).sort()).toEqual(["name", "recipes"]);
  });

  it("repoints a profile whose directory name disagrees with its `name` field, before deleting the recipe (Ruling 12)", async () => {
    const forge = await bareForge({
      "recipes/base.yaml": "name: base\ningredients:\n  - rule/workflow\n",
      "recipes/base--acme.yaml": "name: base--acme\ningredients:\n  - rule/workflow--acme\n",
      // Directory is "acme-corp"; the profile's own `name` field is "acme" — the asymmetry
      // `loadForge` already has between profiles and their directories.
      "profiles/acme-corp/profile.yaml": "name: acme\nrecipes:\n  - base--acme\n",
    });
    const out = await rewriteRecipes(forge, "rule/workflow", "rule/workflow--acme", "acme");
    expect(out.deleted).toEqual(["base--acme"]);
    expect(out.profileRepointed).toEqual(["base--acme -> base"]);

    const reloaded = await loadForge(forge.root);
    expect(reloaded.recipes.has("base--acme")).toBe(false);
    expect(reloaded.profiles.get("acme")!.recipes).toEqual(["base"]);
    // The directory itself is never renamed — only its file's content changed.
    expect(await exists(path.join(forge.root, "profiles/acme-corp/profile.yaml"))).toBe(true);
  });

  it("keeps a CRLF, BOM-prefixed recipe file's EOL and BOM after the rewrite (Ruling 13)", async () => {
    const BOM = "﻿";
    const crlf = `${BOM}name: solo--acme\r\ningredients:\r\n  - rule/workflow--acme\r\n  - rule/other\r\n`;
    const root = await tmpDir();
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, "recipes"), { recursive: true });
    await fs.mkdir(path.join(root, "profiles/acme"), { recursive: true });
    await fs.writeFile(path.join(root, "craftar.forge.yaml"), "name: test-forge\nschema: 1\n");
    await fs.writeFile(path.join(root, "recipes/solo.yaml"), crlf);
    await fs.writeFile(path.join(root, "profiles/acme/profile.yaml"), "name: acme\nrecipes:\n  - solo--acme\n");
    const forge = await loadForge(root);

    const out = await rewriteRecipes(forge, "rule/workflow", "rule/workflow--acme", "acme");
    expect(out.rewritten).toEqual(["solo--acme"]);
    expect(out.deleted).toEqual([]); // no unsuffixed "solo" sibling — never renamed

    const text = await fs.readFile(path.join(root, "recipes/solo.yaml"), "utf8");
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain("rule/workflow\r\n");
    expect(text).not.toContain("rule/workflow--acme");
    expect(/(?<!\r)\n/.test(text.slice(1))).toBe(false); // every \n is still preceded by \r
  });

  it("throws rather than record a rewrite that never touched the file, when the reference sits behind a YAML alias (Ruling 14)", async () => {
    const aliased = "name: base--acme\nx: &shared\n  - rule/workflow--acme\n  - rule/other\ningredients: *shared\n";
    const forge = await bareForge({
      "recipes/base--acme.yaml": aliased,
      "profiles/acme/profile.yaml": "name: acme\nrecipes:\n  - base--acme\n",
    });
    await expect(rewriteRecipes(forge, "rule/workflow", "rule/workflow--acme", "acme")).rejects.toThrow(/base--acme/);

    const untouched = await fs.readFile(path.join(forge.root, "recipes/base--acme.yaml"), "utf8");
    expect(untouched).toBe(aliased);
  });
});

// Final review, C2 (Ruling 29 — spec §8 refusal 7 in both directions): a plan must cover every
// file the diff has — paired, base-only and variant-only — each exactly once. Before this, a plan
// stripped of its entries applied as "resolved" and the variant, with its only copy of a
// variant-only file, was deleted.
describe("applyPlan — the plan covers the diff exactly once (Ruling 29)", () => {
  function coverageScenario() {
    return scenario({ "rule.md": "a\nold\nc\n" }, { "rule.md": "a\nnew\nc\n", "extra.md": "only here\n" });
  }

  it("refuses a plan with no entries at all, naming a file the diff has", async () => {
    const { base, variant, diff } = await coverageScenario();
    const plan = await planFrom(base, variant, diff, "acme");
    plan.files = [];
    await expect(applyPlan(base, variant, diff, plan)).rejects.toThrow(/rule\.md|extra\.md/);
  });

  it("refuses a plan missing the entry for one file, and names it", async () => {
    const { base, variant, diff } = await coverageScenario();
    const plan = await planFrom(base, variant, diff, "acme");
    plan.files[0].hunks![0].take = "variant";
    plan.files = plan.files.filter((f) => f.file !== "extra.md");
    await expect(applyPlan(base, variant, diff, plan)).rejects.toThrow(/extra\.md/);
  });

  it("refuses a plan with two entries for the same file, instead of letting the last one win", async () => {
    const { base, variant, diff } = await coverageScenario();
    const plan = await planFrom(base, variant, diff, "acme");
    const extra = plan.files.find((f) => f.file === "extra.md")!;
    extra.take = "base";
    plan.files.push({ ...extra, take: "variant" });
    plan.files[0].hunks![0].take = "variant";
    await expect(applyPlan(base, variant, diff, plan)).rejects.toThrow(/extra\.md/);
  });

  it("refuses an entry carrying both hunk decisions and a side", async () => {
    const { base, variant, diff } = await coverageScenario();
    const plan = await planFrom(base, variant, diff, "acme");
    plan.files[0].hunks![0].take = "variant";
    plan.files[0].onlyIn = "base";
    plan.files.find((f) => f.file === "extra.md")!.take = "variant";
    await expect(applyPlan(base, variant, diff, plan)).rejects.toThrow(/rule\.md/);
  });
});
