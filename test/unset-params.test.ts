import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { exists } from "../src/core/forge.js";
import { apply, declaredWithoutValue, loadWorkspace, plan, readLock, status, unsetDeclared, unsetRefusal, unsetSummary } from "../src/core/sync.js";
import { profile, recipe, rule, scenario, writeFiles, type ForgeSpec, type WorkspaceSpec } from "./helpers/forge.js";

// Spec 29 §4.1 / §9 slice A — the core of the refusal: what counts as unset, and the gate in apply().

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const DECLARED = { org: { description: "the organisation" } };
/** rule/a declares `org` with no default and cites it; rule/b cites it too, plus an undeclared key and an Angular pipe. */
const forge = (o: { aParams?: Record<string, unknown>; recipeExtra?: Record<string, unknown>; profileExtra?: Record<string, unknown>; aBody?: string } = {}): ForgeSpec => ({
  ingredients: [rule("a", o.aBody ?? "Org: {{org}}\n", { params: o.aParams ?? DECLARED }), rule("b", "Also {{org}}, {{free}} and {{ 'X' | localize }}\n")],
  recipes: [recipe("base", ["rule/a", "rule/b"], o.recipeExtra)],
  profiles: [profile("acme", ["base"], ["claude-code"], o.profileExtra)],
});

async function planned(f: ForgeSpec, w: WorkspaceSpec = { config: { profile: "acme" } }) {
  const s = await scenario(f, w);
  cleanups.push(s.cleanup);
  const ws = await loadWorkspace(s.wsRoot);
  const p = await plan(ws);
  const st = await status(ws, p, await readLock(ws.root));
  return { s, ws, p, st };
}

const ORG_WARNING = 'param "org" has no value in any layer — left verbatim (rule/a, rule/b)';

describe("unset declared parameters — plan", () => {
  it("missingParams names who declares each key: the declaring ingredient, or nobody", async () => {
    const { p } = await planned(forge());
    expect(p.missingParams).toEqual([
      { key: "free", refs: ["rule/b"], warning: 'param "free" has no value in any layer — left verbatim (rule/b)', declaredBy: [] },
      { key: "org", refs: ["rule/a", "rule/b"], warning: ORG_WARNING, declaredBy: ["rule/a"] },
    ]);
    expect(p.warnings).toContain(ORG_WARNING);
  });

  it("unsetDeclared keeps only the declared ones, and the plan still holds the files with {{org}} verbatim", async () => {
    const { p } = await planned(forge());
    expect(unsetDeclared(p)).toEqual([{ key: "org", declaredBy: ["rule/a"], citedBy: ["rule/a", "rule/b"] }]);
    const a = p.files.find((f) => f.path === ".claude/rules/a.md")!;
    expect(a.content.toString("utf8")).toBe("Org: {{org}}\n");
    const b = p.files.find((f) => f.path === ".claude/rules/b.md")!;
    expect(b.content.toString("utf8")).toBe("Also {{org}}, {{free}} and {{ 'X' | localize }}\n");
  });

  it("an undeclared key and an Angular pipe alone refuse nothing", async () => {
    const { p } = await planned(forge({ aParams: {}, aBody: "No cite\n" }));
    expect(unsetDeclared(p)).toEqual([]);
    expect(p.missingParams.map((m) => [m.key, m.declaredBy])).toEqual([["free", []], ["org", []]]);
  });

  it("declared with no value but cited by no planned file: not unset for sync, still listed by declaredWithoutValue", async () => {
    const { p } = await planned({
      ingredients: [rule("a", "No cite\n", { params: DECLARED })],
      recipes: [recipe("base", ["rule/a"])],
      profiles: [profile("acme", ["base"])],
    });
    expect(unsetDeclared(p)).toEqual([]);
    expect([...declaredWithoutValue(p)]).toEqual([["org", ["rule/a"]]]);
  });

  it("a default scoped to another ingredient does not make an undeclared citation an unset declared one (§6 case 1)", async () => {
    const { p } = await planned(forge({ aParams: { org: { default: "acme-inc" } } }));
    expect(unsetDeclared(p)).toEqual([]);
    expect(p.missingParams.find((m) => m.key === "org")).toEqual({ key: "org", refs: ["rule/b"], warning: 'param "org" has no value in any layer — left verbatim (rule/b)', declaredBy: [] });
  });

  it("an empty string is a value (§6 case 4)", async () => {
    const { p } = await planned(forge({ profileExtra: { params: { org: "" } } }));
    expect(unsetDeclared(p)).toEqual([]);
    expect(p.files.find((f) => f.path === ".claude/rules/a.md")!.content.toString("utf8")).toBe("Org: \n");
  });

  it("a citation inside a section the profile empties is not a citation (§6 case 3)", async () => {
    const body = "# A\n<!-- craftar:section who -->\nOrg: {{org}}\n<!-- /craftar:section -->\n";
    const s = await scenario(
      { ingredients: [rule("a", body, { params: DECLARED })], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"], ["claude-code"], { sections: { "rule/a": { who: "" } } })] },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    await writeFiles(s.forgeRoot, { "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 2 }) });
    const p = await plan(await loadWorkspace(s.wsRoot));
    expect(p.missingParams).toEqual([]);
    expect(unsetDeclared(p)).toEqual([]);
    expect([...declaredWithoutValue(p).keys()]).toEqual(["org"]);
  });
});

describe("unset declared parameters — every layer supplies the value", () => {
  const cases: Array<[string, ForgeSpec, WorkspaceSpec]> = [
    ["a recipe default", forge({ recipeExtra: { params: { org: { default: "from-recipe" } } } }), { config: { profile: "acme" } }],
    ["the profile", forge({ profileExtra: { params: { org: "from-profile" } } }), { config: { profile: "acme" } }],
    ["craftar.yaml", forge(), { config: { profile: "acme", overrides: { params: { org: "from-workspace" } } } }],
    ["craftar.local.yaml", forge(), { config: { profile: "acme" }, local: { overrides: { params: { org: "from-local" } } } }],
  ];
  for (const [name, f, w] of cases) {
    it(`${name}: nothing unset, apply writes, the value is in the file`, async () => {
      const { s, ws, p, st } = await planned(f, w);
      expect(unsetDeclared(p)).toEqual([]);
      await apply(ws, p, st);
      expect(await fs.readFile(path.join(s.wsRoot, ".claude/rules/a.md"), "utf8")).toBe(`Org: from-${name === "a recipe default" ? "recipe" : name === "the profile" ? "profile" : name === "craftar.yaml" ? "workspace" : "local"}\n`);
      expect(await exists(path.join(s.wsRoot, "craftar.lock"))).toBe(true);
    });
  }
});

describe("unset declared parameters — the block and the gate", () => {
  it("unsetRefusal: the count, one aligned line per key, the fix; thenSync extends the fix", () => {
    const unset = [
      { key: "apiPort", declaredBy: ["rule/stack"], citedBy: ["rule/stack"] },
      { key: "org", declaredBy: ["rule/a"], citedBy: ["agent/reviewer", "rule/a"] },
    ];
    expect(unsetRefusal(unset)).toBe(
      [
        "2 declared parameter(s) have no value — nothing written",
        "  apiPort  declared by rule/stack · cited by rule/stack",
        "  org      declared by rule/a · cited by agent/reviewer, rule/a",
        "  fix: set each under params in the profile, or under overrides.params in craftar.yaml",
      ].join("\n"),
    );
    // init's form: it has just written craftar.yaml, so its first line does not say "nothing written"
    expect(unsetRefusal(unset, { thenSync: true }).split("\n")[0]).toBe("2 declared parameter(s) have no value — craftar.yaml written, sync not run");
    expect(unsetRefusal(unset, { thenSync: true }).split("\n").at(-1)).toBe("  fix: set each under params in the profile, or under overrides.params in craftar.yaml, then run craftar sync");
    expect(unsetSummary(unset)).toBe("declared parameter(s) with no value: apiPort, org");
  });

  it("apply() throws the block before any write: no file, no lock", async () => {
    const { s, ws, p, st } = await planned(forge());
    await expect(apply(ws, p, st)).rejects.toThrow(unsetRefusal(unsetDeclared(p)));
    expect(await exists(path.join(s.wsRoot, ".claude"))).toBe(false);
    expect(await exists(path.join(s.wsRoot, "craftar.lock"))).toBe(false);
  });

  it("apply() with dryRun throws too", async () => {
    const { ws, p, st } = await planned(forge());
    await expect(apply(ws, p, st, { dryRun: true })).rejects.toThrow("1 declared parameter(s) have no value — nothing written");
  });

  it("a workspace synced before the declaration existed is refused after it, with every file still unchanged", async () => {
    const { s, ws, p, st } = await planned(forge({ aParams: {} }));
    await apply(ws, p, st);
    const meta = path.join(s.forgeRoot, "ingredients/rules/a/ingredient.yaml");
    await fs.writeFile(meta, YAML.stringify({ ...YAML.parse(await fs.readFile(meta, "utf8")), params: DECLARED }));
    const ws2 = await loadWorkspace(s.wsRoot);
    const p2 = await plan(ws2);
    const st2 = await status(ws2, p2, await readLock(ws2.root));
    expect(st2.map((x) => x.state)).toEqual(["unchanged", "unchanged"]);
    const lockBefore = await fs.readFile(path.join(s.wsRoot, "craftar.lock"), "utf8");
    await expect(apply(ws2, p2, st2)).rejects.toThrow("nothing written");
    expect(await fs.readFile(path.join(s.wsRoot, "craftar.lock"), "utf8")).toBe(lockBefore);
  });
});
