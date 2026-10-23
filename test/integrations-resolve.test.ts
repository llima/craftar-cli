import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolve } from "../src/core/resolve.js";
import { loadWorkspace, plan, readLock, unsetDeclared } from "../src/core/sync.js";
import { ado, ADO_MCP_JSON, forgeAt, mcp, PM, STORIES_ACME, sync } from "./helpers/integrations.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, type ForgeSpec, type WorkspaceSpec } from "./helpers/forge.js";

// Spec 33 §9.2 — selection and params through resolve(), plan() and the lock.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function at(schema: number, spec: ForgeSpec, ws: WorkspaceSpec = { config: { profile: "acme" } }) {
  const s = await forgeAt(schema, spec, ws);
  cleanups.push(s.cleanup);
  return s;
}
const resolved = async (wsRoot: string) => {
  const w = await loadWorkspace(wsRoot);
  return resolve(w.forge, w.config);
};
const text = (p: Awaited<ReturnType<typeof plan>>, file: string) => p.files.find((f) => f.path === file)?.content.toString("utf8");
const fail = async (wsRoot: string) => {
  try {
    await resolved(wsRoot);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

describe("spec 33 §9.2 — resolve() reads the effective profile", () => {
  it("1. schema 3 selects and renders", async () => {
    const { wsRoot } = await at(3, ado());
    const p = await sync(wsRoot);
    expect(p.resolution.recipes).toEqual(["base", "pm-azure-devops"]);
    expect(p.warnings).toEqual([]);
    expect(p.files.map((f) => f.path)).toEqual([".claude/rules/stories-azure-devops.md", ".claude/rules/where.md", ".claude/rules/workflow.md", ".kiro/settings/mcp.json", ".kiro/steering/stories-azure-devops.md", ".kiro/steering/where.md", ".kiro/steering/workflow.md", ".mcp.json"]);
    expect(text(p, ".claude/rules/stories-azure-devops.md")).toBe(STORIES_ACME);
    expect(text(p, ".claude/rules/where.md")).toBe("Org acme\n");
    expect(text(p, ".mcp.json")).toBe(ADO_MCP_JSON);
    expect((await readLock(wsRoot))!.recipes).toEqual(["base", "pm-azure-devops"]);
  });

  it("2. schema 2 is today, byte for byte (control)", async () => {
    // Two scenarios at schema 2: ado() and ado({}, {}) (the same Forge, integrations: {})
    const { wsRoot: wsRoot1 } = await at(2, ado());
    const { wsRoot: wsRoot2 } = await at(2, ado({}, {}));

    const w1 = await loadWorkspace(wsRoot1);
    const w2 = await loadWorkspace(wsRoot2);
    const p1 = await plan(w1);
    const p2 = await plan(w2);

    // resolution.recipes of the first toEqual(["base"])
    expect(p1.resolution.recipes).toEqual(["base"]);

    // the two plans' files.map(...) are toEqual
    expect(p1.files.map((f) => [f.path, f.content.toString("base64")])).toEqual(
      p2.files.map((f) => [f.path, f.content.toString("base64")])
    );

    // the two warnings arrays are toEqual, and each is empty (at schema 2, integrations.* keys are undeclared)
    expect(p1.warnings).toEqual([]);
    expect(p2.warnings).toEqual(p1.warnings);

    // text check
    expect(text(p1, ".claude/rules/where.md")).toBe("Org {{integrations.pm.org}}\n");

    // Repeat the first scenario at schema 1 with the same four expectations
    const { wsRoot: wsRoot1s1 } = await at(1, ado());
    const w1s1 = await loadWorkspace(wsRoot1s1);
    const p1s1 = await plan(w1s1);
    expect(p1s1.resolution.recipes).toEqual(["base"]);
    expect(p1s1.files.map((f) => [f.path, f.content.toString("base64")])).toEqual(
      p1.files.map((f) => [f.path, f.content.toString("base64")])
    );
    // At schema 1, integrations.* keys are also undeclared — no warning
    expect(p1s1.warnings).toEqual([]);
    expect(text(p1s1, ".claude/rules/where.md")).toBe("Org {{integrations.pm.org}}\n");
  });

  it("3. schema 2 with a malformed block and a kind with no recipe (control)", async () => {
    const { wsRoot } = await at(2, ado({}, { "my-slot": 1, pm: { kind: "jira" } }));
    expect(await fail(wsRoot)).toBeNull();
    expect((await resolved(wsRoot)).recipes).toEqual(["base"]);
  });

  it("4. recipes.remove takes the recipe out and leaves the params", async () => {
    const { wsRoot } = await at(3, ado(), { config: { profile: "acme", recipes: { remove: ["pm-azure-devops"] } } });
    const r = await resolved(wsRoot);
    expect(r.recipes).toEqual(["base"]);
    expect(r.params["integrations.pm.org"]).toBe("acme");
    const w = await loadWorkspace(wsRoot);
    const p = await plan(w);
    expect(text(p, ".claude/rules/where.md")).toBe("Org acme\n");
    // no planned path contains stories-azure-devops or mcp.json
    expect(p.files.some((f) => f.path.includes("stories-azure-devops"))).toBe(false);
    expect(p.files.some((f) => f.path.includes("mcp.json"))).toBe(false);
  });

  it("5. overrides.params beats the block", async () => {
    const { wsRoot } = await at(3, ado(), { config: { profile: "acme", overrides: { params: { "integrations.pm.project": "Billing" } } } });
    const w = await loadWorkspace(wsRoot);
    const p = await plan(w);
    expect(text(p, ".claude/rules/stories-azure-devops.md")).toBe("Stories live in Azure DevOps, organisation acme, project Billing.\n");
  });

  it("6. the profile's own params beat the block", async () => {
    const { wsRoot } = await at(3, ado({}, PM, { params: { "integrations.pm.org": "other" } }));
    const w = await loadWorkspace(wsRoot);
    const p = await plan(w);
    expect(text(p, ".claude/rules/where.md")).toBe("Org other\n");
    expect(p.resolution.paramLayers.profile).toEqual({
      "integrations.pm.kind": "azure-devops",
      "integrations.pm.org": "other",
      "integrations.pm.project": "Platform",
    });
  });

  it("7. order: after the profile's recipes, before recipes.add; a later default still wins", async () => {
    // Build the spec by hand for this case
    const spec: ForgeSpec = {
      ingredients: [rule("workflow", "# Workflow\n")],
      recipes: [
        recipe("base", ["rule/workflow"]),
        recipe("pm-azure-devops", [], { slot: "pm", params: { team: { default: "A" } } }),
        recipe("extra", [], { params: { team: { default: "B" } } }),
      ],
      profiles: [profile("acme", ["base"], ["claude-code"], { integrations: PM })],
    };
    const { wsRoot } = await at(3, spec, { config: { profile: "acme", recipes: { add: ["extra"] } } });
    const r = await resolved(wsRoot);
    expect(r.recipes).toEqual(["base", "pm-azure-devops", "extra"]);
    expect(r.params.team).toBe("B");
  });

  it("8. an integration recipe that extends another is walked", async () => {
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\n"),
        rule("stories-azure-devops", STORIES_ACME),
      ],
      recipes: [
        recipe("base", ["rule/workflow"]),
        recipe("pm-common", ["rule/where"]),
        recipe("pm-azure-devops", ["rule/stories-azure-devops"], { slot: "pm", extends: ["pm-common"] }),
      ],
      profiles: [profile("acme", ["base"], ["claude-code"], { integrations: PM })],
    };
    const { wsRoot } = await at(3, spec);
    const r = await resolved(wsRoot);
    expect(r.recipes).toEqual(["base", "pm-common", "pm-azure-devops"]);
    expect(r.ingredients.find((i) => i.ref === "rule/where")!.via).toEqual(["pm-common"]);
  });

  it("9. two slots, block order", async () => {
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\n"),
        rule("stories-azure-devops", STORIES_ACME),
        mcp("azure-devops", { command: "npx", args: ["-y", "ado-mcp"] }),
        rule("idp", "IDP docs: {{integrations.idp.url}}\n"),
      ],
      recipes: [
        recipe("base", ["rule/workflow", "rule/where"]),
        recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops"], { slot: "pm" }),
        recipe("idp-docs", ["rule/idp"]),
      ],
      profiles: [
        profile("acme", ["base"], ["claude-code", "kiro"], {
          integrations: { idp: { kind: "docs", url: "https://idp.example.com/docs" }, pm: PM.pm },
        }),
      ],
    };
    const { wsRoot } = await at(3, spec);
    const r = await resolved(wsRoot);
    expect(r.recipes).toEqual(["base", "idp-docs", "pm-azure-devops"]);
    const w = await loadWorkspace(wsRoot);
    const p = await plan(w);
    expect(text(p, ".claude/rules/idp.md")).toBe("IDP docs: https://idp.example.com/docs\n");
  });

  it("10. listed and selected: resolved once, where recipes put it", async () => {
    // Profile ["pm-azure-devops", "base"] + PM
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\n"),
        rule("stories-azure-devops", STORIES_ACME),
        mcp("azure-devops", { command: "npx", args: ["-y", "ado-mcp"] }),
      ],
      recipes: [
        recipe("base", ["rule/workflow", "rule/where"]),
        recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops"], { slot: "pm" }),
      ],
      profiles: [profile("acme", ["pm-azure-devops", "base"], ["claude-code"], { integrations: PM })],
    };
    const { wsRoot } = await at(3, spec);
    const r = await resolved(wsRoot);
    expect(r.recipes).toEqual(["pm-azure-devops", "base"]);
  });

  it("11. slot collision is the existing error", async () => {
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\n"),
        rule("stories-azure-devops", STORIES_ACME),
        mcp("azure-devops", { command: "npx", args: ["-y", "ado-mcp"] }),
      ],
      recipes: [
        recipe("base", ["rule/workflow", "rule/where"]),
        recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops"], { slot: "pm" }),
        recipe("pm-github", [], { slot: "pm" }),
      ],
      profiles: [profile("acme", ["base", "pm-github"], ["claude-code"], { integrations: PM })],
    };
    const { wsRoot } = await at(3, spec);
    expect(await fail(wsRoot)).toBe('recipes "pm-github" and "pm-azure-devops" both occupy slot "pm"');
  });

  it("12. a kind with no recipe", async () => {
    // Block { pm: { kind: "jira", org: "acme" } }
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\n"),
      ],
      recipes: [recipe("base", ["rule/workflow", "rule/where"])],
      profiles: [profile("acme", ["base"], ["claude-code"], { integrations: { pm: { kind: "jira", org: "acme" } } })],
    };
    const { wsRoot } = await at(3, spec);
    expect(await fail(wsRoot)).toBe('recipe "pm-jira" not found (referenced by integrations.pm of profile acme)');

    // With recipes.remove: ["pm-jira"], the workspace resolves
    const { wsRoot: wsRoot2 } = await at(3, spec, { config: { profile: "acme", recipes: { remove: ["pm-jira"] } } });
    expect(await fail(wsRoot2)).toBeNull();
    const r = await resolved(wsRoot2);
    expect(r.recipes).toEqual(["base"]);
    expect(r.params["integrations.pm.kind"]).toBe("jira");
  });

  it("13. an unknown name in recipes.add keeps its own message (control)", async () => {
    const { wsRoot } = await at(3, ado(), { config: { profile: "acme", recipes: { add: ["nope"] } } });
    expect(await fail(wsRoot)).toBe('recipe "nope" not found (referenced by craftar.yaml recipes.add)');
  });

  it("14. a malformed block fails the resolution", async () => {
    // Block { pm: "azure-devops" } at schema 3
    const spec: ForgeSpec = {
      ingredients: [rule("workflow", "# Workflow\n")],
      recipes: [recipe("base", ["rule/workflow"])],
      profiles: [profile("acme", ["base"], ["claude-code"], { integrations: { pm: "azure-devops" } })],
    };
    const { wsRoot } = await at(3, spec);
    expect(await fail(wsRoot)).toBe("profile acme: integrations.pm is not a mapping");
  });

  it("15. a non-scalar value is a plan warning, first in the list", async () => {
    const { wsRoot } = await at(3, ado({}, { pm: { ...PM.pm, labels: ["a"] } }));
    const w = await loadWorkspace(wsRoot);
    const p = await plan(w);
    expect(p.warnings).toEqual(["profile acme: integrations.pm.labels is not a scalar — not available as a param"]);
  });

  it("16. numbers, booleans and braces", async () => {
    // Block { pm: { port: 8080, on: true, tpl: "{{integrations.pm.port}}" } }, a rule in base
    const spec: ForgeSpec = {
      ingredients: [rule("v", "{{integrations.pm.port}} {{integrations.pm.on}} {{integrations.pm.tpl}}\n")],
      recipes: [recipe("base", ["rule/v"])],
      profiles: [
        profile("acme", ["base"], ["claude-code"], {
          integrations: { pm: { port: 8080, on: true, tpl: "{{integrations.pm.port}}" } },
        }),
      ],
    };
    const { wsRoot } = await at(3, spec);
    const w = await loadWorkspace(wsRoot);
    const p = await plan(w);
    // substituted text is not substituted again
    expect(text(p, ".claude/rules/v.md")).toBe("8080 true {{integrations.pm.port}}\n");
  });

  it("17. a declared integration key with no value refuses the sync, as any declared key does (control + new)", async () => {
    // First half: control — sync is refused
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\n"),
        rule("stories-azure-devops", STORIES_ACME),
        mcp("azure-devops", { command: "npx", args: ["-y", "ado-mcp"] }),
        rule("team", "Team {{integrations.pm.team}}\n", { params: { "integrations.pm.team": { description: "the team" } } }),
      ],
      recipes: [
        recipe("base", ["rule/workflow", "rule/where", "rule/team"]),
        recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops"], { slot: "pm" }),
      ],
      profiles: [profile("acme", ["base"], ["claude-code"], { integrations: PM })],
    };
    const { wsRoot } = await at(3, spec);
    const w = await loadWorkspace(wsRoot);
    const p = await plan(w);
    expect(unsetDeclared(p)).toEqual([
      { key: "integrations.pm.team", declaredBy: ["rule/team"], citedBy: ["rule/team"] },
    ]);

    // Second half: with the block { pm: { ...PM.pm, team: "core" } }
    const spec2: ForgeSpec = {
      ...spec,
      profiles: [profile("acme", ["base"], ["claude-code"], { integrations: { pm: { ...PM.pm, team: "core" } } })],
    };
    const { wsRoot: wsRoot2 } = await at(3, spec2);
    const w2 = await loadWorkspace(wsRoot2);
    const p2 = await plan(w2);
    expect(unsetDeclared(p2)).toEqual([]);
    expect(text(p2, ".claude/rules/team.md")).toBe("Team core\n");
  });

  it("18. explain names the layer: the profile", async () => {
    const { wsRoot } = await at(3, ado());
    await sync(wsRoot);
    const r = runCli(["explain", ".claude/rules/stories-azure-devops.md", "--workspace", wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")).toContain("  params      integrations.pm.org (profile acme), integrations.pm.project (profile acme)");
  });

  // §6.28 — a padded flow mapping resolves at schema 3
  it("§6.28. a profile file with a padded flow mapping resolves", async () => {
    // Write the profile file with a padded flow mapping (inner spaces around braces)
    const spec: ForgeSpec = {
      ingredients: [rule("workflow", "# Workflow\n"), rule("where", "Org {{integrations.pm.org}}\n")],
      recipes: [recipe("base", ["rule/workflow", "rule/where"]), recipe("pm-azure-devops", [], { slot: "pm" })],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const s = await forgeAt(3, spec);
    cleanups.push(s.cleanup);

    // Overwrite the profile with a padded flow mapping
    const profilePath = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
    await fs.writeFile(profilePath, `name: acme
recipes: [base]
targets: [claude-code]
integrations:
  pm:  { kind: azure-devops, org: acme, project: Platform }
`);

    const r = await resolved(s.wsRoot);
    expect(r.recipes).toEqual(["base", "pm-azure-devops"]);
    const w = await loadWorkspace(s.wsRoot);
    const p = await plan(w);
    expect(text(p, ".claude/rules/where.md")).toBe("Org acme\n");
  });

  // §6.31 — a slot named like a recipe prefix
  it("§6.31. a slot named like a recipe prefix selects that recipe", async () => {
    const spec: ForgeSpec = {
      ingredients: [rule("workflow", "# Workflow\n")],
      recipes: [recipe("stack-dotnet", ["rule/workflow"])],
      profiles: [profile("acme", [], ["claude-code"], { integrations: { stack: { kind: "dotnet" } } })],
    };
    const { wsRoot } = await at(3, spec);
    const r = await resolved(wsRoot);
    expect(r.recipes).toEqual(["stack-dotnet"]);
    expect(r.params["integrations.stack.kind"]).toBe("dotnet");
  });
});
