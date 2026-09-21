import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { gitDirty } from "../src/core/forge.js";
import { UnifyPlanSchema } from "../src/schema/index.js";
import { tmpDir } from "./helpers/forge.js";

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
