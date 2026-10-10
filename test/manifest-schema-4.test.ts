import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadForge } from "../src/core/forge.js";
import { manifestWithSections } from "../src/core/manifest-edit.js";
import { reservedKey } from "../src/core/extract.js";
import { resolve } from "../src/core/resolve.js";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { profile, recipe, rule } from "./helpers/forge.js";
import { ado, forgeAt, snapshot, sync } from "./helpers/integrations.js";

// Spec 34 §4.1, §5.1, §9 — schema 4 loads, includes schema 3 and schema 2, and is never lowered.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const MARKED = "# Flow\n<!-- craftar:section steps -->\ndefault steps\n<!-- /craftar:section -->\n";
const HAND4 = "name: test-forge # by hand\nschema: 4\n";

async function marked(manifest: string) {
  const s = await forgeAt(
    4, // schema from forgeAt is overwritten by the manifest string anyway
    { ingredients: [rule("flow", MARKED)], recipes: [recipe("base", ["rule/flow"])], profiles: [profile("acme", ["base"])] },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), manifest);
  return s;
}

describe("the Forge manifest at schema 4", () => {
  it("loads, and reads back as 4", async () => {
    const s = await marked(HAND4);
    expect((await loadForge(s.forgeRoot)).manifest.schema).toBe(4);
  });

  it("includes 2: a marked body plans and renders its default", async () => {
    const s = await marked(HAND4);
    const p = await plan(await loadWorkspace(s.wsRoot));
    expect(p.files.map((f) => [f.path, f.content.toString("utf8")])).toEqual([[".claude/rules/flow.md", "# Flow\ndefault steps\n"]]);
  });

  it("includes 3: the integrations block is read", async () => {
    const s = await forgeAt(4, ado());
    cleanups.push(s.cleanup);
    const w = await loadWorkspace(s.wsRoot);
    const r = resolve(w.forge, w.config);
    expect(r.recipes).toEqual(["base", "pm-azure-devops"]);
    expect(r.params["integrations.pm.org"]).toBe("acme");
  });

  it("includes 3: the reserved prefix", () => {
    expect(reservedKey("integrations.pm.org", 4)).toBe(true);
  });

  it("includes 3: import leaves what the block provides to its recipe", async () => {
    const s = await forgeAt(4, ado());
    cleanups.push(s.cleanup);
    await sync(s.wsRoot);
    const snapBefore = await snapshot(s.forgeRoot);
    const r = await importClaudeCode({ workspaceRoot: s.wsRoot, forgeRoot: s.forgeRoot, profileName: "acme" });
    const snapAfter = await snapshot(s.forgeRoot);
    expect(snapAfter).toEqual(snapBefore);
    expect(r.leftToRecipes).toEqual([{ recipe: "pm-azure-devops", slot: "pm", refs: ["rule/stories-azure-devops", "mcp/azure-devops"] }]);
  });

  it("a 4 is never lowered", async () => {
    // manifestWithSections returns null for a manifest at 4
    expect(manifestWithSections(HAND4, "import")).toBe(null);
    expect(manifestWithSections(HAND4, "unify")).toBe(null);

    // import-after-sync leaves a 4 alone
    const s = await marked(HAND4);
    const w = await loadWorkspace(s.wsRoot);
    const p = await plan(w);
    await apply(w, p, await status(w, p, await readLock(s.wsRoot)), {});
    const r = await importClaudeCode({ workspaceRoot: s.wsRoot, forgeRoot: s.forgeRoot, profileName: "acme" });
    expect(r.manifestWrite).toBe("unchanged");
    expect(await fs.readFile(path.join(s.forgeRoot, "craftar.forge.yaml"), "utf8")).toBe(HAND4);
  });
});
