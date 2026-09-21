import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { gitDirty } from "../src/core/forge.js";
import { applyPlan, planFrom } from "../src/core/unify.js";
import { diffIngredients } from "../src/core/variants.js";
import { UnifyPlanSchema } from "../src/schema/index.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";

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
});
