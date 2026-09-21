import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { gitDirty } from "../src/core/forge.js";
import { planFrom } from "../src/core/unify.js";
import { UnifyPlanSchema } from "../src/schema/index.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";

const execFileP = promisify(execFile);

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
