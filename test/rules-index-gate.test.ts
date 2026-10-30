import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { acmeIndex } from "./helpers/rules-index.js";
import { loadForge } from "../src/core/forge.js";
import { readsRulesIndex, RULES_INDEX_KEY } from "../src/core/rules-index.js";

type Scenario = Awaited<ReturnType<typeof acmeIndex>>;

/**
 * Spec 44 §4.1 first two bullets, §4.2 first bullet: the gate and the reserved prefix.
 */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

describe("rules-index gate (spec 44 §4.1)", () => {
  it("1a. a Forge whose manifest says schema: 7 loads", async () => {
    const s = kept(await acmeIndex({ schema: 7 }));
    // This should not throw — today it refuses with "declares schema 7"
    const forge = await loadForge(s.forgeRoot);
    expect(forge.manifest.schema).toBe(7);
  });

  it("1b. readsRulesIndex: false at schema 6, true at schema 7", () => {
    expect(readsRulesIndex({ schema: 6 })).toBe(false);
    expect(readsRulesIndex({ schema: 7 })).toBe(true);
  });

  it("1c. RULES_INDEX_KEY equals \"craftar.rules.index\"", () => {
    expect(RULES_INDEX_KEY).toBe("craftar.rules.index");
  });

  it("FORGE_SCHEMA_RULES_INDEX appears only in schema/index.ts and rules-index.ts", () => {
    const srcDir = path.resolve(__dirname, "../src");
    // Use grep to find files referencing FORGE_SCHEMA_RULES_INDEX
    const result = execFileSync(
      "grep",
      ["-rl", "FORGE_SCHEMA_RULES_INDEX", srcDir],
      { encoding: "utf8" }
    );
    const files = result.trim().split("\n").map((f) => path.relative(srcDir, f)).sort();
    expect(files).toEqual(["core/rules-index.ts", "schema/index.ts"]);
  });
});
