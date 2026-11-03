import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { profile, recipe, rule, type ForgeSpec } from "./helpers/forge.js";
import { build, fileOf, localRule, planFor } from "./helpers/local-override.js";

/**
 * Spec 56 and spec 54 Part A, ruled by the user on 2026-11-03: a section key is `<type>/<output name>`, so a value a root
 * recipe gives to `rule/y` reaches a profile's override `rule/y` too — exactly as it reaches the variant `y--acme` the
 * override replaces. The profile keeps control through its own `sections`. Both behaviours are pinned here.
 */

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true });
});

const OPEN = (n: string) => `<!-- craftar:section ${n} -->`;
const CLOSE = "<!-- /craftar:section -->";
const ROOT_Y = `# Y\n${OPEN("s")}\nroot default\n${CLOSE}\n`;
const SHARED = "SHARED VALUE\n";
const spec = (acmeSections: Record<string, unknown> = {}): ForgeSpec => ({
  ingredients: [rule("style", "# Style\n"), rule("y", ROOT_Y)],
  recipes: [recipe("base", ["rule/style", "rule/y"], { sections: { "rule/y": { s: SHARED } } })],
  profiles: [profile("acme", ["base"], ["claude-code"], { sections: acmeSections }), profile("globex", ["base"])],
});

describe("a root recipe's sections and an override (spec 56, spec 54 Part A)", () => {
  it("an override that declares the section gets the recipe's value, as the variant it replaces did; globex too", async () => {
    const s = await build(cleanups, spec(), { extra: localRule("acme", "y", `# Y for acme\n${OPEN("s")}\nacme default\n${CLOSE}\n`), git: false });
    expect(fileOf(await planFor(s.root, s.forge, "acme"), ".claude/rules/y.md")).toBe(`# Y for acme\n${SHARED}`);
    expect(fileOf(await planFor(s.root, s.forge, "globex"), ".claude/rules/y.md")).toBe(`# Y\n${SHARED}`);
  });

  it("the profile's own sections win over the recipe's on its override", async () => {
    const s = await build(cleanups, spec({ "rule/y": { s: "ACME VALUE\n" } }), { extra: localRule("acme", "y", `# Y for acme\n${OPEN("s")}\nacme default\n${CLOSE}\n`), git: false });
    expect(fileOf(await planFor(s.root, s.forge, "acme"), ".claude/rules/y.md")).toBe("# Y for acme\nACME VALUE\n");
  });

  it("an override with no such marker keeps its text, and the plan warns that the recipe sets a section it lacks", async () => {
    const s = await build(cleanups, spec(), { extra: localRule("acme", "y", "# Y for acme\n"), git: false });
    const p = await planFor(s.root, s.forge, "acme");
    expect(fileOf(p, ".claude/rules/y.md")).toBe("# Y for acme\n");
    expect(p.warnings).toContain("recipe base sets section s of rule/y, which has no such marker");
  });
});
