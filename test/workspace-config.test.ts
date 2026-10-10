import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadForgeFor, loadWorkspace, mergeWorkspaceConfig, plan, readWorkspaceConfig } from "../src/core/sync.js";
import { profile, recipe, rule, scenario, writeFiles } from "./helpers/forge.js";

// Spec 24 §5.1: loadWorkspace in three pieces, with no behaviour change.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const FORGE = {
  ingredients: [rule("a", "# A {{who}}\n", { params: { who: { description: "who" } } })],
  recipes: [recipe("base", ["rule/a"])],
  profiles: [profile("acme", ["base"])],
};

describe("readWorkspaceConfig / mergeWorkspaceConfig / loadForgeFor", () => {
  it("loadWorkspace equals readWorkspaceConfig then loadForgeFor", async () => {
    const s = await scenario(FORGE, { config: { profile: "acme" }, local: { targets: ["kiro"] } });
    cleanups.push(s.cleanup);
    const merged = await readWorkspaceConfig(s.wsRoot);
    expect(merged.config.targets).toEqual(["kiro"]);
    const a = await loadWorkspace(s.wsRoot);
    const b = await loadForgeFor(s.wsRoot, merged);
    expect(b.config).toEqual(a.config);
    expect(b.origin).toEqual(a.origin);
    expect(b.warnings).toEqual(a.warnings);
    expect(b.forge.root).toBe(a.forge.root);
  });

  it("a configuration reads even when its Forge does not load", async () => {
    const s = await scenario(FORGE, { config: { profile: "acme", forge: "../nowhere" } });
    cleanups.push(s.cleanup);
    expect((await readWorkspaceConfig(s.wsRoot)).config.forge).toBe("../nowhere");
    await expect(loadWorkspace(s.wsRoot)).rejects.toThrow("Forge not found at");
  });

  it("a null local means no file: the schema error names craftar.local.yaml only when it exists", () => {
    expect(() => mergeWorkspaceConfig({ forge: "x" }, null)).toThrow(/^invalid craftar\.yaml: /);
    expect(() => mergeWorkspaceConfig({ forge: "x" }, {})).toThrow(/^invalid craftar\.yaml \(merged with craftar\.local\.yaml\): /);
    expect(mergeWorkspaceConfig({ forge: "../f", profile: "acme" }, null).config.profile).toBe("acme");
  });

  it("a local forge: override warns from the merge; a ref beside a path Forge warns from the load, first", async () => {
    const s = await scenario(FORGE, { config: { profile: "acme", ref: "v1" } });
    cleanups.push(s.cleanup);
    await writeFiles(s.wsRoot, { "craftar.local.yaml": `forge: ${path.relative(s.wsRoot, s.forgeRoot).replace(/\\/g, "/")}\n` });
    const merged = await readWorkspaceConfig(s.wsRoot);
    expect(merged.fromLocalFile).toBe(true);
    expect(merged.warnings).toHaveLength(1);
    const ws = await loadForgeFor(s.wsRoot, merged);
    expect(ws.warnings[0]).toMatch(/^ref "v1" is ignored/);
    expect(ws.warnings[1]).toMatch(/^Forge overridden by craftar\.local\.yaml/);
  });

  it("plan() lists each unresolved cited param with its refs and the exact warning", async () => {
    const s = await scenario(FORGE, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    const p = await plan(await loadWorkspace(s.wsRoot));
    expect(p.missingParams).toEqual([{ key: "who", refs: ["rule/a"], warning: 'param "who" has no value in any layer — left verbatim (rule/a)', declaredBy: ["rule/a"] }]);
    expect(p.warnings).toContain(p.missingParams[0].warning);
    await fs.rm(s.root, { recursive: true, force: true });
  });
});
