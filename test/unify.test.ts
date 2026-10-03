import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { exists, gitDirty, loadForge, type Forge } from "../src/core/forge.js";
import { applyPlan, metaDifferences, planFrom, rewriteRecipes, writeUnified } from "../src/core/unify.js";
import { prove } from "../src/core/extract.js";
import { diffIngredients } from "../src/core/variants.js";
import { HunkSuggestionSchema, UnifyPlanSchema, type UnifyPlan } from "../src/schema/index.js";
import { makeForge, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec, type IngredientSpec } from "./helpers/forge.js";
import { runCli } from "./helpers/cli.js";

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
        { kind: "inline" as const, a: { start: 2, lines: ["old"] }, b: { start: 2, lines: ["new"] }, suggestion: { class: "evolution" as const, reason: "prose differs" } },
        { kind: "block" as const, a: { start: 5, lines: [] }, b: { start: 5, lines: ["added"] }, suggestion: { class: "block" as const, reason: "only in the variant" } },
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
    expect(paired.hunks!.map((h) => h.suggestion?.class)).toEqual(["evolution", "block"]);
    for (const f of plan.files.filter((f) => f.onlyIn)) expect(f).not.toHaveProperty("suggestion");
    expect(plan.files.find((f) => f.file === "gone.md")).toMatchObject({ onlyIn: "base", take: "keep" });
    expect(plan.files.find((f) => f.file === "extra.md")).toMatchObject({ onlyIn: "variant", take: "keep" });
  });

  it("pre-fills a section name from a heading for a block hunk (spec 12 §4.2)", async () => {
    // Base has a heading "## Reviewer Table" above the table rows
    // Variant adds extra rows (block hunk)
    const baseDir = await tmpDir();
    cleanups.push(() => fs.rm(baseDir, { recursive: true, force: true }));
    await writeFiles(baseDir, {
      "ingredient.yaml": "type: rule\nname: review-posture\n",
      "rule.md": "# Rules\n\n## Reviewer Table\n| a |\n",
    });

    const variantDir = await tmpDir();
    cleanups.push(() => fs.rm(variantDir, { recursive: true, force: true }));
    await writeFiles(variantDir, {
      "ingredient.yaml": "type: rule\nname: review-posture--acme\nas: review-posture\n",
      "rule.md": "# Rules\n\n## Reviewer Table\n| a |\n| b |\n",
    });

    const base = { ref: "rule/review-posture", dir: baseDir, meta: { type: "rule", name: "review-posture" } } as never;
    const variant = { ref: "rule/review-posture--acme", dir: variantDir, meta: { type: "rule", name: "review-posture--acme", as: "review-posture" } } as never;
    const diff = await diffIngredients(base, variant);

    const plan = await planFrom(base, variant, diff, "acme");
    const paired = plan.files.find((f) => f.file === "rule.md")!;

    // The hunk should be classified as "block" (only in variant)
    expect(paired.hunks![0].suggestion?.class).toBe("block");
    // The section name should be pre-filled from the heading "Reviewer Table" → "reviewer-table"
    expect(paired.hunks![0].section).toEqual({ name: "reviewer-table" });
    // take should still be "keep"
    expect(paired.hunks![0].take).toBe("keep");
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

describe("applyPlan ignores the suggestion (spec 08 §4.3)", () => {
  it("gives the same result with the suggestions, without them, and with a mangled one", async () => {
    const { base, variant, diff } = await scenario({ "rule.md": "a\nuse acme-api\nc\n" }, { "rule.md": "a\nuse globex-api\nc\n" });
    const plan = await planFrom(base, variant, diff, "acme");
    plan.files[0].hunks![0].take = "variant";
    expect(plan.files[0].hunks![0].suggestion?.class).toBe("value");
    const stripped = structuredClone(plan);
    delete stripped.files[0].hunks![0].suggestion;
    const mangled = UnifyPlanSchema.parse({ ...structuredClone(plan), files: [{ ...plan.files[0], hunks: [{ ...plan.files[0].hunks![0], suggestion: { class: "bogus" } }] }] });
    const r = await applyPlan(base, variant, diff, plan);
    expect(await applyPlan(base, variant, diff, stripped)).toEqual(r);
    expect(await applyPlan(base, variant, diff, mangled)).toEqual(r);
  });
});

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

  it("leaves a suffixed recipe alone when it has no unsuffixed sibling", async () => {
    const forge = await forgeWith({
      ingredients: [rule("workflow", "a\n"), rule("workflow--acme", "b\n", { as: "workflow" })],
      recipes: [recipe("solo--acme", ["rule/workflow--acme"])],
      profiles: [profile("acme", ["solo--acme"])],
    });
    const out = await rewriteRecipes(forge, "rule/workflow", "rule/workflow--acme", "acme");
    expect(out.identicalToSibling).toEqual([]); // Ruling 42: `deleted` is gone; nothing to report
    const reloaded = await loadForge(forge.root);
    expect(reloaded.recipes.get("solo--acme")!.ingredients).toEqual(["rule/workflow"]);
    expect(reloaded.profiles.get("acme")!.recipes).toEqual(["solo--acme"]);
  });

  it("does not report a sibling whose ingredients differ beyond the variant as identical", async () => {
    const forge = await forgeWith({
      ingredients: [rule("workflow", "a\n"), rule("workflow--acme", "b\n", { as: "workflow" })],
      recipes: [
        recipe("base", ["rule/workflow"]),
        recipe("base--acme", ["rule/workflow--acme", "rule/extra"]),
      ],
      profiles: [profile("acme", ["base--acme"])],
    });
    const out = await rewriteRecipes(forge, "rule/workflow", "rule/workflow--acme", "acme");
    expect(out.identicalToSibling).toEqual([]);
  });
});

/**
 * Loads a Forge from hand-written files rather than `makeForge`, so a test can put a recipe under
 * a filename that disagrees with its own `name` field, or control the raw bytes (comments, EOL,
 * BOM) of recipes and profiles precisely. `rewriteRecipes` never touches `ingredients/`, so these
 * scenarios skip writing ingredient directories entirely.
 */
async function bareForge(files: Record<string, string>): Promise<Forge> {
  const root = await tmpDir();
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  await writeFiles(root, { "craftar.forge.yaml": "name: test-forge\nschema: 1\n", ...files });
  return loadForge(root);
}

describe("rewriteRecipes — file identity, byte fidelity and safety (Rulings 9, 10, 13, 14)", () => {
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
    expect(out.identicalToSibling).toEqual([]); // Ruling 42: no unsuffixed "solo" sibling

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

// Final review, C4 (Ruling 31): the merge engine is text-only. A one-sided file is copied as the
// raw bytes on disk, and a file present on both sides whose bytes differ while either side is not
// valid UTF-8 is refused by name — decoding both as UTF-8 would fold every invalid byte to U+FFFD,
// so the diff could not even see that the two differ.
describe("unify — non-UTF-8 content (Ruling 31)", () => {
  /** Like `scenario`, but the files may be raw bytes. */
  async function rawScenario(baseFiles: Record<string, string | Buffer>, variantFiles: Record<string, string | Buffer>) {
    return scenario(baseFiles as Record<string, string>, variantFiles as Record<string, string>);
  }

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xff, 0xfe, 0x80]);

  it("copies a variant-only binary file into the base byte for byte", async () => {
    const { base, variant, diff } = await rawScenario({ "rule.md": "x\n" }, { "rule.md": "x\n", "logo.png": PNG });
    const plan = await planFrom(base, variant, diff, "acme");
    plan.files.find((f) => f.file === "logo.png")!.take = "variant";
    const r = await applyPlan(base, variant, diff, plan);
    await writeUnified(base, r);
    const written = await fs.readFile(path.join((base as { dir: string }).dir, "logo.png"));
    expect(written.equals(PNG)).toBe(true);
  });

  it("refuses, naming the file, a pair whose bytes differ while one side is not valid UTF-8 — even when both decode alike", async () => {
    const latinE = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n" in Latin-1
    const latinEGrave = Buffer.from([0x63, 0x61, 0x66, 0xe8, 0x0a]); // "cafè\n" in Latin-1
    const { base, variant, diff } = await rawScenario(
      { "rule.md": "x\n", "latin.txt": latinE },
      { "rule.md": "x\n", "latin.txt": latinEGrave },
    );
    // Both decode to "caf\uFFFD\n": the text diff alone cannot see the difference.
    expect(diff.files).toEqual([]);
    await expect(planFrom(base, variant, diff, "acme")).rejects.toThrow(/latin\.txt/);
    const plan = { schema: 1 as const, base: "rule/workflow", profile: "acme", variant: "rule/workflow--acme", baseFingerprint: "", variantFingerprint: "", files: [] };
    await expect(applyPlan(base, variant, diff, plan as never)).rejects.toThrow(/latin\.txt/);
  });

  it("accepts a pair that differs only in text when one side carries a UTF-8 BOM", async () => {
    const { base, variant, diff } = await rawScenario({ "rule.md": `${BOM}a\nold\n` }, { "rule.md": "a\nnew\n" });
    const plan = await planFrom(base, variant, diff, "acme");
    plan.files[0].hunks![0].take = "variant";
    const r = await applyPlan(base, variant, diff, plan);
    expect(r.write["rule.md"]).toBe(`${BOM}a\nnew\n`);
  });
});

describe("metaDifferences — MCP server key order (spec 07, AC 19)", () => {
  it("does not treat a reordered server as a metadata difference", async () => {
    const forge = await forgeWith({
      ingredients: [
        { meta: { type: "mcp", name: "p", server: { command: "npx", type: "stdio", env: { A: "1", B: "2" } } } },
        { meta: { type: "mcp", name: "p--acme", as: "p", server: { type: "stdio", env: { B: "2", A: "1" }, command: "npx" } } },
      ],
    });
    expect(metaDifferences(forge.ingredients.get("mcp/p")!, forge.ingredients.get("mcp/p--acme")!)).toEqual([]);
  });
});

describe("the hunk suggestion in a plan (spec 08 §5.1)", () => {
  const plan = (hunk: Record<string, unknown>) => ({
    schema: 1,
    base: "rule/w",
    profile: "acme",
    variant: "rule/w--acme",
    baseFingerprint: "sha256:a",
    variantFingerprint: "sha256:b",
    files: [{ file: "rule.md", hunks: [{ hunk: 1, at: "lines 1–1", take: "keep", ...hunk }] }],
  });
  const value = { class: "value", reason: "1 token differs", tokens: [{ a: "acme-api", b: "globex-api", param: "param.acme_api" }] };

  it("accepts the three classes and refuses any other", () => {
    expect(HunkSuggestionSchema.safeParse(value).success).toBe(true);
    expect(HunkSuggestionSchema.safeParse({ class: "evolution", reason: "prose differs" }).success).toBe(true);
    expect(HunkSuggestionSchema.safeParse({ class: "bogus", reason: "x" }).success).toBe(false);
  });

  it("keeps a valid suggestion, drops a malformed one without failing, and accepts a plan without one", () => {
    expect(UnifyPlanSchema.parse(plan({ suggestion: value })).files[0].hunks![0].suggestion).toEqual(value);
    const mangled = UnifyPlanSchema.parse(plan({ suggestion: { class: "bogus" } })).files[0].hunks![0];
    expect(mangled.suggestion).toBeUndefined();
    expect(UnifyPlanSchema.parse(plan({})).files[0].hunks![0]).toEqual({ hunk: 1, at: "lines 1–1", take: "keep" });
  });
});

describe("take: param — the engine (spec 09 §6.1, §6.2)", () => {
  async function paramPlan(baseRule: string, variantRule: string, edit: (hunks: NonNullable<UnifyPlan["files"][number]["hunks"]>) => void) {
    const { base, variant, diff } = await scenario({ "rule.md": baseRule }, { "rule.md": variantRule });
    const plan = await planFrom(base, variant, diff, "acme");
    edit(plan.files[0].hunks!);
    return { base, variant, diff, plan };
  }
  const run = async (b: string, v: string, edit: Parameters<typeof paramPlan>[2]) => {
    const { base, variant, diff, plan } = await paramPlan(b, v, edit);
    return applyPlan(base, variant, diff, plan);
  };
  const err = (p: Promise<unknown>) => p.then(() => "no error", (e: Error) => e.message);

  it("pre-fills params on a value hunk from its suggestion, and on no other hunk", async () => {
    const { plan } = await paramPlan("a\nuse globex-api\nb\nStep 6.\n", "a\nuse acme-api\nb\nStep 5.\n", () => {});
    const [value, evolution] = plan.files[0].hunks!;
    expect(value.take).toBe("keep");
    expect(value.params).toEqual([{ token: "globex-api", key: "param.globex_api" }]);
    expect(evolution).not.toHaveProperty("params");
  });

  it("templates the base, and carries the default and the value, one key over two hunks", async () => {
    const r = await run("use globex-api\nshared\nalso globex-api\n", "use acme-api\nshared\nalso acme-api\n", (hs) => {
      for (const h of hs) Object.assign(h, { take: "param", params: [{ token: "globex-api", key: "deploy.api" }] });
    });
    expect(r.write["rule.md"]).toBe("use {{deploy.api}}\nshared\nalso {{deploy.api}}\n");
    expect(r.params).toEqual([
      { key: "deploy.api", default: "globex-api", value: "acme-api", reused: false, sites: [{ file: "rule.md", hunk: 1 }, { file: "rule.md", hunk: 2 }] },
    ]);
    expect(r.resolved).toBe(true);
  });

  it("replaces only the changed occurrence, never the same text in unchanged context (edge case 3)", async () => {
    const r = await run("globex-api: see globex-api docs\n", "acme-api: see globex-api docs\n", (hs) => {
      Object.assign(hs[0], { take: "param", params: [{ token: "globex-api", key: "deploy.api" }] });
    });
    expect(r.write["rule.md"]).toBe("{{deploy.api}}: see globex-api docs\n");
  });

  it("keeps a CRLF + BOM base's line endings and BOM in the template", async () => {
    const r = await run("﻿port 8080\r\nend\r\n", "﻿port 9090\r\nend\r\n", (hs) => {
      Object.assign(hs[0], { take: "param", params: [{ token: "8080", key: "port" }] });
    });
    expect(r.write["rule.md"]).toBe("﻿port {{port}}\r\nend\r\n");
  });

  it("carries an adjacent space into the default when the variant removed a word (edge case 18)", async () => {
    const r = await run("use globex-api now\n", "use now\n", (hs) => {
      Object.assign(hs[0], { take: "param", params: [{ token: "globex-api", key: "k" }] });
    });
    expect(r.params[0]).toMatchObject({ default: "globex-api ", value: "" });
    expect(r.write["rule.md"]).toBe("use {{k}}now\n");
  });

  it("refuses P1, P2, P4, P5, P6, P7, P8, P9 and P10 with the Forge-independent messages", async () => {
    const one = (params: unknown) => (hs: any[]) => Object.assign(hs[0], { take: "param", params });
    expect(await err(run("a globex-api\n", "a acme-api\n", one([])))).toContain("names no params");
    expect(await err(run("a\n", "a\nb\n", one([{ token: "a", key: "k" }])))).toContain("its lines do not pair");
    expect(await err(run("x globex-api\n", "x acme-api\n", one([{ token: "globex-api", key: "k" }, { token: "globex-api", key: "j" }])))).toContain("names token \"globex-api\" twice");
    expect(await err(run("x globex-api\n", "x acme-api\n", one([{ token: "globex-api", key: "k" }, { token: "x", key: "j" }])))).toContain("is not a changed region");
    expect(await err(run("x globex-api y globex-web\n", "x acme-api y acme-web\n", one([{ token: "globex-api", key: "k" }])))).toContain("is not covered by params");
    expect(await err(run("| globex-api   |\n", "| acme-api |\n", one([{ token: "globex-api", key: "k" }])))).toContain("whitespace only");
    expect(await err(run("x {{globex}}\n", "x {{acme}}\n", one([{ token: "globex", key: "k" }])))).toContain("would change which {{…}} placeholders");
    expect(await err(run("x globex-api\nsame\ny globex-api\n", "x acme-api\nsame\ny initech-api\n", (hs: any[]) => {
      for (const h of hs) Object.assign(h, { take: "param", params: [{ token: "globex-api", key: "k" }] });
    }))).toContain("would need two values");
    expect(await err(run("x globex-api\n", "x acme-api\n", one([{ token: "globex-api", key: "constructor" }])))).toContain("is reserved");
    expect(await err(run("x globex-api\n", "x acme-api\n", one([{ token: "globex-api", key: "kiro.banner" }])))).toContain("is reserved");
    expect(await err(run("x globex-api\nsame\nStep 6\n", "x acme-api\nsame\nStep 5\n", one([{ token: "globex-api", key: "k" }])))).toContain("needs the variant resolved");
  });

  it("a mixed plan: a param hunk next to hunks taken from either side", async () => {
    const r = await run("x globex-api\nsame\nStep 6\n", "x acme-api\nsame\nStep 5\n", (hs: any[]) => {
      Object.assign(hs[0], { take: "param", params: [{ token: "globex-api", key: "k" }] });
      hs[1].take = "variant";
    });
    expect(r.write["rule.md"]).toBe("x {{k}}\nsame\nStep 5\n");
    expect(r.resolved).toBe(true);
  });

  it("ignores params in metaDifferences when the variant declares none (§6.6)", async () => {
    const { base, variant } = await scenario({ "rule.md": "a\n" }, { "rule.md": "a\n" });
    (base as any).meta = { ...(base as any).meta, params: { k: { default: "x" } } };
    expect(metaDifferences(base, variant)).toEqual([]);
    (variant as any).meta = { ...(variant as any).meta, params: { k: { default: "y" } } };
    expect(metaDifferences(base, variant)).toEqual(["params"]);
  });
});

describe("take: param — the remaining engine rows (spec 09 AC 9)", () => {
  const err = (p: Promise<unknown>) => p.then(() => "no error", (e: Error) => e.message);

  it("P3: a file a target copies as raw bytes cannot hold a parameter", async () => {
    const baseDir = await tmpDir();
    const variantDir = await tmpDir();
    cleanups.push(() => fs.rm(baseDir, { recursive: true, force: true }), () => fs.rm(variantDir, { recursive: true, force: true }));
    await writeFiles(baseDir, { "ingredient.yaml": "type: skill\nname: run\n", "run.sh": "echo globex-api\n" });
    await writeFiles(variantDir, { "ingredient.yaml": "type: skill\nname: run--acme\nas: run\n", "run.sh": "echo acme-api\n" });
    const base = { ref: "skill/run", dir: baseDir, meta: { type: "skill", name: "run", layout: "dir" } } as never;
    const variant = { ref: "skill/run--acme", dir: variantDir, meta: { type: "skill", name: "run--acme", as: "run", layout: "dir" } } as never;
    const diff = await diffIngredients(base, variant);
    const plan = await planFrom(base, variant, diff, "acme");
    Object.assign(plan.files[0].hunks![0], { take: "param", params: [{ token: "globex-api", key: "k" }] });
    expect(await err(applyPlan(base, variant, diff, plan))).toContain("is copied without substitution");
  });

  it("P10: a param plan refuses a variant held back by a metadata difference", async () => {
    const { base, variant, diff } = await scenario({ "rule.md": "x globex-api\n" }, { "rule.md": "x acme-api\n" });
    (variant as any).meta = { ...(variant as any).meta, targets: ["kiro"] };
    const plan = await planFrom(base, variant, diff, "acme");
    Object.assign(plan.files[0].hunks![0], { take: "param", params: [{ token: "globex-api", key: "k" }] });
    expect(await err(applyPlan(base, variant, diff, plan))).toContain("ingredient.yaml differs in targets");
  });

  it("P20: the proof refuses a template that does not render a side back", () => {
    const e = (f: () => void) => { try { f(); return "no error"; } catch (x) { return (x as Error).message; } };
    const ext = [{ key: "k", default: "globex-api", value: "acme-api", sites: [], reused: false }];
    expect(e(() => prove("rule.md", "x {{k}}\n", "x globex-web\n", "x acme-api\n", ext))).toContain("would not reproduce the base side of \"rule.md\"");
    expect(e(() => prove("rule.md", "x {{k}}\n", "x globex-api\n", "x acme-web\n", ext))).toContain("would not reproduce the variant side of \"rule.md\"");
  });
});

describe("U1 — a merge never changes section markers (spec 11 §6.12, Ruling 8)", () => {
  const TABLE_ACME = "| Repo | Reviewer |\n|---|---|\n| `acme-api` | backend-reviewer |\n| `acme-web` | frontend-reviewer |\n";
  const TABLE_GLOBEX = "| Repo | Reviewer |\n|---|---|\n| `globex-api` | backend-reviewer |\n| `globex-web` | frontend-reviewer |\n| `globex-desktop` | desktop-reviewer |\n";
  const HEAD = "# Review posture\n\nDispatch reviewers after every commit.\n\n";
  const TAIL = "\nNever edit what a reviewer reads.\n";
  const BASE = `${HEAD}<!-- craftar:section flavors -->\n${TABLE_ACME}<!-- /craftar:section -->\n${TAIL}`;
  const VARIANT = `${HEAD}${TABLE_GLOBEX}${TAIL}`;
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

  // P6's Forge: the base's table wrapped in markers, a globex variant without them; committed.
  async function p6Forge() {
    const root = await tmpDir("craftar-u1-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [rule("review-posture", BASE), rule("review-posture--globex", VARIANT, { as: "review-posture" })],
      recipes: [recipe("base", ["rule/review-posture"]), recipe("base--globex", ["rule/review-posture--globex"])],
      profiles: [profile("acme", ["base"]), profile("globex", ["base--globex"])],
    });
    await fs.writeFile(path.join(root, "craftar.forge.yaml"), "name: test-forge\nschema: 2\n");
    await execFileP("git", ["-C", root, "init", "-q"]);
    await execFileP("git", ["-C", root, "add", "-A"]);
    await execFileP("git", ["-C", root, "commit", "-qm", "init"], { env: gitEnv });
    return root;
  }
  const porcelain = async (root: string) => (await execFileP("git", ["-C", root, "status", "--porcelain"])).stdout;

  it("P6: the diff splits the markers across two hunks — the opener alone, then the rows with the closer", async () => {
    const forge = await loadForge(await p6Forge());
    const diff = await diffIngredients(forge.ingredients.get("rule/review-posture")!, forge.ingredients.get("rule/review-posture--globex")!);
    const hunks = diff.files[0].hunks;
    expect(hunks).toHaveLength(2);
    expect(hunks[0].a.lines).toEqual(["<!-- craftar:section flavors -->"]);
    expect(hunks[1].a.lines).toContain("<!-- /craftar:section -->");
  });

  it("refuses a plan taking the variant for the closing marker's hunk and the base for the opener's, the Forge untouched", async () => {
    const root = await p6Forge();
    const planDir = await tmpDir("craftar-u1-plan-");
    cleanups.push(() => fs.rm(planDir, { recursive: true, force: true }));
    const planPath = path.join(planDir, "plan.yaml");
    expect(runCli(["forge", "unify", "rule/review-posture", "--profile", "globex", "--save-plan", planPath, "--forge", root]).code).toBe(0);
    const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
    plan.files[0].hunks[0].take = "base";
    plan.files[0].hunks[1].take = "variant";
    await fs.writeFile(planPath, YAML.stringify(plan));

    const r = runCli(["forge", "unify", "rule/review-posture", "--profile", "globex", "--plan", planPath, "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      "unify: ingredients/rules/review-posture/rule.md would lose or change section markers (the result has malformed markers — line 5: section flavors is never closed) — take base for the marker lines, or take: section to fill the section",
    );
    expect(await porcelain(root)).toBe("");
  });

  it("refuses --take variant, which drops the section, the Forge untouched", async () => {
    const root = await p6Forge();
    const r = runCli(["forge", "unify", "rule/review-posture", "--profile", "globex", "--take", "variant", "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("would lose or change section markers (sections flavors would become none)");
    expect(await porcelain(root)).toBe("");
  });

  it("passes --take base: the markers stay and the variant goes", async () => {
    const root = await p6Forge();
    const r = runCli(["forge", "unify", "rule/review-posture", "--profile", "globex", "--take", "base", "--forge", root]);
    expect(r.code, r.stderr).toBe(0);
    expect(await fs.readFile(path.join(root, "ingredients/rules/review-posture/rule.md"), "utf8")).toBe(BASE);
    expect(await exists(path.join(root, "ingredients/rules/review-posture--globex"))).toBe(false);
  });

  it("refuses a variant-only file that would bring markers in, and a base-only file removed with its sections", async () => {
    const e = (p: Promise<unknown>) => p.then(() => "no error", (x: Error) => x.message);
    const add = await scenario({ "rule.md": "a\n" }, { "rule.md": "a\n", "notes.md": "<!-- craftar:section n -->\nx\n<!-- /craftar:section -->\n" });
    const addPlan = await planFrom(add.base, add.variant, add.diff, "acme");
    addPlan.files[0].take = "variant";
    expect(await e(applyPlan(add.base, add.variant, add.diff, addPlan))).toContain("sections none would become n");
    const rm = await scenario({ "rule.md": "a\n", "notes.md": "<!-- craftar:section n -->\nx\n<!-- /craftar:section -->\n" }, { "rule.md": "a\n" });
    const rmPlan = await planFrom(rm.base, rm.variant, rm.diff, "acme");
    rmPlan.files[0].take = "variant";
    expect(await e(applyPlan(rm.base, rm.variant, rm.diff, rmPlan))).toContain("the file would be removed with sections n");
  });
});

describe("take: section (spec 12)", () => {
  // Helper to create a basic Forge scenario for section tests
  const sectionScenario = async (baseBody: string, variantBody: string) => {
    const root = await tmpDir("craftar-section-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [
        rule("review-posture", baseBody),
        rule("review-posture--acme", variantBody, { as: "review-posture" }),
      ],
      recipes: [recipe("base", ["rule/review-posture"]), recipe("base--acme", ["rule/review-posture--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });
    const forge = await loadForge(root);
    const base = forge.ingredients.get("rule/review-posture")!;
    const variant = forge.ingredients.get("rule/review-posture--acme")!;
    const diffResult = await diffIngredients(base, variant);
    return { root, forge, base, variant, diff: diffResult };
  };

  it("a new section over a table whose variant has extra rows: template holds markers", async () => {
    const baseBody = "# Review\n\nDispatch reviewers.\n\n| Repo | Reviewer |\n|---|---|\n| `api` | bob |\n\nDone.\n";
    const variantBody = "# Review\n\nDispatch reviewers.\n\n| Repo | Reviewer |\n|---|---|\n| `api` | bob |\n| `web` | alice |\n\nDone.\n";
    const { base, variant, diff } = await sectionScenario(baseBody, variantBody);
    // variant has extra row; the hunk is a block hunk (lines only in variant)
    const planObj = await planFrom(base, variant, diff, "acme");
    // Set take: section with lines covering the whole table (lines 5-7)
    planObj.files[0].hunks![0].take = "section";
    (planObj.files[0].hunks![0] as Record<string, unknown>).section = { name: "flavors", lines: "5-7" };

    const result = await applyPlan(base, variant, diff, planObj);
    expect(result.resolved).toBe(true);

    const merged = result.write["rule.md"] as string;
    expect(merged).toContain("<!-- craftar:section flavors -->");
    expect(merged).toContain("<!-- /craftar:section -->");
    // The markers should wrap the table
    const expected = `# Review

Dispatch reviewers.

<!-- craftar:section flavors -->
| Repo | Reviewer |
|---|---|
| \`api\` | bob |
<!-- /craftar:section -->

Done.
`;
    expect(merged).toBe(expected);

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].key).toBe("rule/review-posture");
    expect(result.sections[0].name).toBe("flavors");
    expect(result.sections[0].existing).toBe(false);
    expect(result.sections[0].default).toBe("| Repo | Reviewer |\n|---|---|\n| `api` | bob |\n");
    expect(result.sections[0].value).toBe("| Repo | Reviewer |\n|---|---|\n| `api` | bob |\n| `web` | alice |\n");
  });

  it("CRLF + BOM base: markers written with CRLF, BOM kept", async () => {
    const BOM = String.fromCharCode(0xfeff);
    const baseBody = BOM + "# Review\r\n\r\nTable:\r\n\r\n| a |\r\n\r\nDone.\r\n";
    const variantBody = BOM + "# Review\r\n\r\nTable:\r\n\r\n| b |\r\n\r\nDone.\r\n";
    const { base, variant, diff } = await sectionScenario(baseBody, variantBody);
    const planObj = await planFrom(base, variant, diff, "acme");
    planObj.files[0].hunks![0].take = "section";
    (planObj.files[0].hunks![0] as Record<string, unknown>).section = { name: "t" };

    const result = await applyPlan(base, variant, diff, planObj);
    const merged = result.write["rule.md"] as string;

    // Check BOM is kept
    expect(merged.charCodeAt(0)).toBe(0xfeff);
    // Check CRLF is used for markers
    expect(merged).toContain("<!-- craftar:section t -->\r\n");
    expect(merged).toContain("<!-- /craftar:section -->\r\n");
  });

  it("reuse of an existing section (probe Q3 shape): result.write has no rule.md, existing=true", async () => {
    // Base already has the section markers
    const baseBody = "# Review\n\n<!-- craftar:section flavors -->\n| a |\n| b |\n<!-- /craftar:section -->\n\nDone.\n";
    // Variant has no markers, but content is a|b|c
    const variantBody = "# Review\n\n| a |\n| b |\n| c |\n\nDone.\n";
    const { root, base, variant, diff } = await sectionScenario(baseBody, variantBody);
    // The variant's text differs from the base in the rows, resulting in hunks touching the section
    const planObj = await planFrom(base, variant, diff, "acme");
    // Both hunks touch the existing section, set them to take: section
    for (const h of planObj.files[0].hunks!) {
      h.take = "section";
      (h as Record<string, unknown>).section = { name: "flavors" };
    }

    const result = await applyPlan(base, variant, diff, planObj);

    // Body unchanged (only value is written to profile, not the file)
    expect(result.write["rule.md"]).toBeUndefined();
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].existing).toBe(true);
    expect(result.sections[0].value).toBe("| a |\n| b |\n| c |\n");
  });

  // SF1: a reuse-only plan on a mixed-EOL base must not round-trip through mergeFile, which would
  // normalize the line endings even though the body does not change (spec 12 §6.7 step 3).
  it("leaves a mixed-EOL base untouched on a reuse-only section plan", async () => {
    // Base has mixed EOL (CRLF first line, then LF) with existing section markers
    const baseBody = "# T\r\n\n<!-- craftar:section flavors -->\n| a |\n<!-- /craftar:section -->\n\nEnd.\n";
    // Variant has no markers, different content
    const variantBody = "# T\r\n\n| b |\n\nEnd.\n";
    const { base, variant, diff } = await sectionScenario(baseBody, variantBody);
    const planObj = await planFrom(base, variant, diff, "acme");
    // Set take: section on all hunks (reuse, no new section)
    for (const h of planObj.files[0].hunks!) {
      h.take = "section";
      (h as Record<string, unknown>).section = { name: "flavors" };
    }

    const result = await applyPlan(base, variant, diff, planObj);

    // Body unchanged: write has no rule.md (spec 12 §6.7 step 3)
    expect(result.write["rule.md"]).toBeUndefined();
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].existing).toBe(true);
  });

  it("a plan mixing take: param and take: section in one file: both proved", async () => {
    const baseBody = "# Review\n\nDeploy to acme-api.\n\n| Repo |\n|---|\n| x |\n\nEnd.\n";
    const variantBody = "# Review\n\nDeploy to globex-api.\n\n| Repo |\n|---|\n| y |\n\nEnd.\n";
    const { base, variant, diff } = await sectionScenario(baseBody, variantBody);
    const planObj = await planFrom(base, variant, diff, "acme");

    // First hunk is "acme-api" -> "globex-api" (param)
    planObj.files[0].hunks![0].take = "param";
    (planObj.files[0].hunks![0] as Record<string, unknown>).params = [{ token: "acme-api", key: "deploy.api" }];

    // Second hunk is table row change (section)
    planObj.files[0].hunks![1].take = "section";
    (planObj.files[0].hunks![1] as Record<string, unknown>).section = { name: "repos" };

    const result = await applyPlan(base, variant, diff, planObj);
    expect(result.resolved).toBe(true);
    expect(result.params).toHaveLength(1);
    expect(result.params[0].key).toBe("deploy.api");
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].name).toBe("repos");

    const merged = result.write["rule.md"] as string;
    expect(merged).toContain("{{deploy.api}}");
    expect(merged).toContain("<!-- craftar:section repos -->");
  });

  it("S2: section hunk on file not expanded by emitter is refused", async () => {
    // Use a script with a non-TEXT_EXT file extension (.bin is not in the regex)
    const root = await tmpDir("craftar-s2-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));

    // Create script ingredients manually with proper structure
    // Scripts require `files` to list the file names
    // Using .bin which is NOT in TEXT_EXT (/\.(md|txt|json|ya?ml|ps1|py|sh|js|ts|cjs|mjs|toml|xml|csv)$/i)
    const script = (name: string, body: Record<string, string>, extra: Record<string, unknown> = {}): IngredientSpec => ({
      meta: { type: "script", name, files: Object.keys(body), ...extra },
      files: body,
    });

    await makeForge(root, {
      ingredients: [
        script("deploy", { "run.bin": "echo a\n" }),
        script("deploy--acme", { "run.bin": "echo b\n" }, { as: "deploy" }),
      ],
      recipes: [recipe("base", ["script/deploy"]), recipe("base--acme", ["script/deploy--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });
    const forge = await loadForge(root);
    const base = forge.ingredients.get("script/deploy")!;
    const variant = forge.ingredients.get("script/deploy--acme")!;
    const diffResult = await diffIngredients(base, variant);
    const planObj = await planFrom(base, variant, diffResult, "acme");
    planObj.files[0].hunks![0].take = "section";
    (planObj.files[0].hunks![0] as Record<string, unknown>).section = { name: "s" };

    await expect(applyPlan(base, variant, diffResult, planObj)).rejects.toThrow(
      'unify plan: "run.bin" is copied without expansion by a target that emits it — a section marker there would be emitted literally',
    );
  });

  it("S3 second form: one name in two files is refused", async () => {
    const root = await tmpDir("craftar-s3-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));

    // Create skill ingredients manually with proper structure
    const skill = (name: string, body: Record<string, string>, extra: Record<string, unknown> = {}): IngredientSpec => ({
      meta: { type: "skill", name, layout: "dir", ...extra },
      files: body,
    });

    await makeForge(root, {
      ingredients: [
        skill("analyze", { "SKILL.md": "a\n", "notes.md": "x\n" }),
        skill("analyze--acme", { "SKILL.md": "b\n", "notes.md": "y\n" }, { as: "analyze" }),
      ],
      recipes: [recipe("base", ["skill/analyze"]), recipe("base--acme", ["skill/analyze--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });
    const forge = await loadForge(root);
    const base = forge.ingredients.get("skill/analyze")!;
    const variant = forge.ingredients.get("skill/analyze--acme")!;
    const diffResult = await diffIngredients(base, variant);
    const planObj = await planFrom(base, variant, diffResult, "acme");

    // Set both files to use section with the same name
    for (const pf of planObj.files) {
      if (pf.hunks) {
        pf.hunks[0].take = "section";
        (pf.hunks[0] as Record<string, unknown>).section = { name: "same-name" };
      }
    }

    await expect(applyPlan(base, variant, diffResult, planObj)).rejects.toThrow(
      /section same-name is named in ".*" and ".*"/,
    );
  });

  it("S11: a keep left with section hunk is refused", async () => {
    // Need a base with two differences so we get two hunks
    const baseBody = "# Review\n\na\nb\nc\nd\n";
    const variantBody = "# Review\n\nx\nb\nc\ny\n";
    const { base, variant, diff } = await sectionScenario(baseBody, variantBody);
    const planObj = await planFrom(base, variant, diff, "acme");

    // Ensure we have at least 2 hunks
    expect(planObj.files[0].hunks!.length).toBeGreaterThanOrEqual(2);

    // First hunk is section, second is keep
    planObj.files[0].hunks![0].take = "section";
    (planObj.files[0].hunks![0] as Record<string, unknown>).section = { name: "s" };
    planObj.files[0].hunks![1].take = "keep";

    await expect(applyPlan(base, variant, diff, planObj)).rejects.toThrow(
      "unify plan: take: section needs the variant resolved in the same plan — 1 decision(s) still keep",
    );
  });

  it("S11: ingredient.yaml differs with section hunk is refused", async () => {
    const root = await tmpDir("craftar-s11-meta-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [
        rule("review-posture", "a\n", { tags: ["x"] }),
        rule("review-posture--acme", "b\n", { as: "review-posture", tags: ["y"] }),
      ],
      recipes: [recipe("base", ["rule/review-posture"]), recipe("base--acme", ["rule/review-posture--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });
    const forge = await loadForge(root);
    const base = forge.ingredients.get("rule/review-posture")!;
    const variant = forge.ingredients.get("rule/review-posture--acme")!;
    const diffResult = await diffIngredients(base, variant);
    const planObj = await planFrom(base, variant, diffResult, "acme");
    planObj.files[0].hunks![0].take = "section";
    (planObj.files[0].hunks![0] as Record<string, unknown>).section = { name: "s" };

    await expect(applyPlan(base, variant, diffResult, planObj)).rejects.toThrow(
      /unify plan: take: section needs the variant resolved in the same plan — ingredient.yaml differs in/,
    );
  });

  it("S12: variant with a marker in another admitted file is refused", async () => {
    const root = await tmpDir("craftar-s12-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));

    // Create skill ingredients manually with proper structure
    const skill = (name: string, body: Record<string, string>, extra: Record<string, unknown> = {}): IngredientSpec => ({
      meta: { type: "skill", name, layout: "dir", ...extra },
      files: body,
    });

    await makeForge(root, {
      ingredients: [
        skill("analyze", { "SKILL.md": "a\n", "notes.md": "x\n" }),
        skill("analyze--acme", {
          "SKILL.md": "b\n",
          "notes.md": "<!-- craftar:section n -->\ny\n<!-- /craftar:section -->\n",
        }, { as: "analyze" }),
      ],
      recipes: [recipe("base", ["skill/analyze"]), recipe("base--acme", ["skill/analyze--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });
    const forge = await loadForge(root);
    const base = forge.ingredients.get("skill/analyze")!;
    const variant = forge.ingredients.get("skill/analyze--acme")!;
    const diffResult = await diffIngredients(base, variant);
    const planObj = await planFrom(base, variant, diffResult, "acme");
    // Set section on SKILL.md only
    for (const pf of planObj.files) {
      if (pf.file === "SKILL.md" && pf.hunks) {
        pf.hunks[0].take = "section";
        (pf.hunks[0] as Record<string, unknown>).section = { name: "s" };
      } else if (pf.hunks) {
        pf.hunks[0].take = "base"; // resolve the other file
      }
    }

    await expect(applyPlan(base, variant, diffResult, planObj)).rejects.toThrow(
      /skill\/analyze--acme holds a section marker on notes.md:1/,
    );
  });

  it("U1: --take variant over a marked base is still refused", async () => {
    // This test ensures that taking variant on a file with markers is still refused
    const baseBody = "# Review\n\n<!-- craftar:section flavors -->\n| a |\n<!-- /craftar:section -->\n\nDone.\n";
    const variantBody = "# Review\n\n| b |\n\nDone.\n";
    const { base, variant, diff } = await sectionScenario(baseBody, variantBody);
    const planObj = await planFrom(base, variant, diff, "acme");
    // Take variant on all hunks (no section declaration)
    for (const h of planObj.files[0].hunks!) {
      h.take = "variant";
    }

    await expect(applyPlan(base, variant, diff, planObj)).rejects.toThrow(
      /would lose or change section markers.*take base for the marker lines, or take: section to fill the section/,
    );
  });

  it("U1: plan with section hunk that also takes variant on an existing marker hunk is refused", async () => {
    // Base has two sections
    const baseBody = "# Review\n\n<!-- craftar:section s1 -->\na\n<!-- /craftar:section -->\n\n<!-- craftar:section s2 -->\nb\n<!-- /craftar:section -->\n";
    // Variant has neither marker
    const variantBody = "# Review\n\nc\n\nd\n";
    const { base, variant, diff } = await sectionScenario(baseBody, variantBody);
    const planObj = await planFrom(base, variant, diff, "acme");
    // There should be hunks touching both sections
    // Take section on one, take variant on the other (dropping its markers)
    if (planObj.files[0].hunks!.length >= 2) {
      planObj.files[0].hunks![0].take = "section";
      (planObj.files[0].hunks![0] as Record<string, unknown>).section = { name: "s1" };
      planObj.files[0].hunks![1].take = "variant";
    }

    await expect(applyPlan(base, variant, diff, planObj)).rejects.toThrow(
      /would lose or change section markers/,
    );
  });

  it("a plan with no section hunk behaves exactly as before", async () => {
    // Simple base/variant diff with take: base
    const baseBody = "a\nb\nc\n";
    const variantBody = "a\nx\nc\n";
    const { base, variant, diff } = await sectionScenario(baseBody, variantBody);
    const planObj = await planFrom(base, variant, diff, "acme");
    planObj.files[0].hunks![0].take = "base";

    const result = await applyPlan(base, variant, diff, planObj);
    expect(result.resolved).toBe(true);
    expect(result.sections).toEqual([]);
    // No changes when taking base on a simple diff
    expect(result.write["rule.md"]).toBeUndefined();
  });

  it("D1: insertion-first run computes span correctly — markers wrap b..e", async () => {
    // D1 bug: insertion-first case where run starts with pure insertion and ends with a change
    // Base: a b c d e f (lines 1-6)
    // Variant: a [inserted] b c d E f — insertion after a, change at e
    // Span should be 2-5 (b..e), markers around b through e
    const baseBody = "a\nb\nc\nd\ne\nf\n";
    const variantBody = "a\ninserted\nb\nc\nd\nE\nf\n";
    const { base, variant, diff } = await sectionScenario(baseBody, variantBody);

    // Should have 2 hunks: hunk 1 = insertion after line 1, hunk 2 = line 5 changed
    expect(diff.files[0].hunks.length).toBe(2);

    const planObj = await planFrom(base, variant, diff, "acme");
    // Set both hunks to section with same name
    planObj.files[0].hunks![0].take = "section";
    (planObj.files[0].hunks![0] as Record<string, unknown>).section = { name: "t" };
    planObj.files[0].hunks![1].take = "section";
    (planObj.files[0].hunks![1] as Record<string, unknown>).section = { name: "t" };

    const result = await applyPlan(base, variant, diff, planObj);
    expect(result.resolved).toBe(true);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].name).toBe("t");

    const merged = result.write["rule.md"] as string;
    // Markers should wrap lines b, c, d, e (span 2-5)
    const expected = `a
<!-- craftar:section t -->
b
c
d
e
<!-- /craftar:section -->
f
`;
    expect(merged).toBe(expected);

    // Default is base lines 2-5 (b, c, d, e)
    expect(result.sections[0].default).toBe("b\nc\nd\ne\n");
    // Value is variant lines between anchors (inserted, b, c, d, E)
    expect(result.sections[0].value).toBe("inserted\nb\nc\nd\nE\n");
  });
});
