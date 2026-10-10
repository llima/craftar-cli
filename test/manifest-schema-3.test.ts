import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadForge } from "../src/core/forge.js";
import { manifestWithSections } from "../src/core/manifest-edit.js";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { profile, recipe, rule, scenario } from "./helpers/forge.js";

// Spec 33 §4.2, §9.3 — schema 3 loads, includes schema 2 (section markers), and is never lowered.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const MARKED = "# Flow\n<!-- craftar:section steps -->\ndefault steps\n<!-- /craftar:section -->\n";
const HAND = "name: test-forge # by hand\nschema: 3\n";

async function marked(manifest: string) {
  const s = await scenario(
    { ingredients: [rule("flow", MARKED)], recipes: [recipe("base", ["rule/flow"])], profiles: [profile("acme", ["base"])] },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), manifest);
  return s;
}

describe("the Forge manifest at schema 3", () => {
  it("loads, and reads back as 3", async () => {
    const s = await marked(HAND);
    expect((await loadForge(s.forgeRoot)).manifest.schema).toBe(3);
  });

  it("includes schema 2: a body holding a section marker plans, and renders the default", async () => {
    const s = await marked(HAND);
    const p = await plan(await loadWorkspace(s.wsRoot));
    expect(p.files.map((f) => [f.path, f.content.toString("utf8")])).toEqual([[".claude/rules/flow.md", "# Flow\ndefault steps\n"]]);
  });

  it("(control) the same Forge at schema 1 refuses the marker", async () => {
    const s = await marked("name: test-forge\nschema: 1\n");
    await expect(plan(await loadWorkspace(s.wsRoot))).rejects.toThrow(/declares schema: 1, but .* holds a section marker/);
  });

  it("manifestWithSections leaves a 3 alone, as it leaves a 2", () => {
    expect(manifestWithSections(HAND, "import")).toBeNull();
    expect(manifestWithSections(HAND, "unify")).toBeNull();
    expect(manifestWithSections("name: f\nschema: 2\n", "import")).toBeNull();
  });

  it("(control) manifestWithSections still bumps a 1, and a manifest with no schema, to 2", () => {
    expect(manifestWithSections("name: f\nschema: 1\n", "import")).toBe("name: f\nschema: 2\n");
    expect(manifestWithSections("name: f\n", "unify")).toBe("name: f\nschema: 2\n");
  });

  it("an import that decides a source against a marked base leaves the manifest's bytes — never rewritten to 2", async () => {
    const s = await marked(HAND);
    const w = await loadWorkspace(s.wsRoot);
    const p = await plan(w);
    await apply(w, p, await status(w, p, await readLock(s.wsRoot)), {});
    const r = await importClaudeCode({ workspaceRoot: s.wsRoot, forgeRoot: s.forgeRoot, profileName: "acme" });
    expect(r.manifestWrite).toBe("unchanged");
    expect(await fs.readFile(path.join(s.forgeRoot, "craftar.forge.yaml"), "utf8")).toBe(HAND);
    expect(r.reused).toEqual(["rule/flow"]);
  });
});
