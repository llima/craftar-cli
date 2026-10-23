import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, plan, unsetDeclared } from "../src/core/sync.js";
import { profile, recipe, rule, scenario, type ForgeSpec } from "./helpers/forge.js";
import { forgeAt } from "./helpers/integrations.js";
import { runCli } from "./helpers/cli.js";

// Spec: warn about an unresolved {{key}} only when it is declared
// (or, at Forge schema 3+, under the reserved prefix `integrations.`).

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("param warning — declared vs undeclared", () => {
  it("1. an undeclared {{key}} is left verbatim with no warning", async () => {
    // rule r with body "Use {{record.foo}}.\n", nothing declares record.foo
    const spec: ForgeSpec = {
      ingredients: [rule("r", "Use {{record.foo}}.\n")],
      recipes: [recipe("base", ["rule/r"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const s = await scenario(spec, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    // No param warning at all
    expect(p.warnings.filter((w) => w.startsWith("param "))).toEqual([]);

    // missingParams still records the key
    expect(p.missingParams).toEqual([
      {
        key: "record.foo",
        refs: ["rule/r"],
        warning: 'param "record.foo" has no value in any layer — left verbatim (rule/r)',
        declaredBy: [],
      },
    ]);

    // The planned file content still has the placeholder verbatim
    const content = p.files.find((f) => f.path === ".claude/rules/r.md")!.content.toString("utf8");
    expect(content).toBe("Use {{record.foo}}.\n");
  });

  it("2. a declared key with no value still warns and refuses", async () => {
    // rule r declares `params: { org: {} }` (no default) and its body cites {{org}}
    const spec: ForgeSpec = {
      ingredients: [rule("r", "Org: {{org}}\n", { params: { org: { description: "the organisation" } } })],
      recipes: [recipe("base", ["rule/r"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const s = await scenario(spec, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    // The warning IS present for a declared key
    expect(p.warnings).toContain('param "org" has no value in any layer — left verbatim (rule/r)');

    // unsetDeclared returns the declared-but-unset key
    expect(unsetDeclared(p)).toEqual([
      { key: "org", declaredBy: ["rule/r"], citedBy: ["rule/r"] },
    ]);
  });

  it("3. at schema 3 an unset integrations key still warns", async () => {
    // Forge schema: 3, rule `where` body "Org {{integrations.pm.org}}\n",
    // profile with integrations: { pm: { kind: <a kind whose recipe exists> } } and no org
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\n"),
      ],
      recipes: [
        recipe("base", ["rule/workflow", "rule/where"]),
        recipe("pm-azure-devops", [], { slot: "pm" }),
      ],
      profiles: [
        profile("acme", ["base"], ["claude-code"], {
          integrations: { pm: { kind: "azure-devops" } }, // no org key
        }),
      ],
    };
    const s = await forgeAt(3, spec);
    cleanups.push(s.cleanup);

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    // The warning IS present for an integrations.* key at schema 3
    expect(p.warnings).toContain('param "integrations.pm.org" has no value in any layer — left verbatim (rule/where)');
  });

  it("4. at schema 1 an integrations-looking key is undeclared, so no warning", async () => {
    // Same body at schema 1, no integrations block
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\n"),
      ],
      recipes: [recipe("base", ["rule/workflow", "rule/where"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const s = await forgeAt(1, spec);
    cleanups.push(s.cleanup);

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    // No param warning — it's undeclared and not under schema 3
    expect(p.warnings.filter((w) => w.startsWith("param "))).toEqual([]);

    // But missingParams still records it
    expect(p.missingParams.some((m) => m.key === "integrations.pm.org")).toBe(true);
  });

  it("5. CLI: doctor --strict passes on a workspace whose only unresolved {{…}} is undeclared", async () => {
    // Sync the workspace of case 1, then doctor --strict → exit 0
    const spec: ForgeSpec = {
      ingredients: [rule("r", "Use {{record.foo}}.\n")],
      recipes: [recipe("base", ["rule/r"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const s = await scenario(spec, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);

    // Sync first using runCli (so workspace is registered)
    const syncR = runCli(["sync", "--workspace", s.wsRoot]);
    expect(syncR.code).toBe(0);

    // Run doctor --strict
    const r = runCli(["doctor", "--strict", "--workspace", s.wsRoot]);

    // Should exit 0 (no warn or error for undeclared params)
    expect(r.code).toBe(0);

    // stdout should not contain record.foo — it's undeclared, no warning
    expect(r.stdout).not.toContain("record.foo");
  });

  it("6. a key another ingredient declares with a default still warns where it stays literal", async () => {
    // Rule `a` declares `deploy.api` with default "x" and cites it
    // Rule `b` cites `{{deploy.api}}` and declares nothing
    // The warning should fire for b because the key is declared (by a, with a default)
    const spec: ForgeSpec = {
      ingredients: [
        rule("a", "api: {{deploy.api}}\n", { params: { "deploy.api": { default: "x" } } }),
        rule("b", "api: {{deploy.api}}\n"),
      ],
      recipes: [recipe("base", ["rule/a", "rule/b"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const s = await scenario(spec, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);

    // The warning IS present because deploy.api is declared by rule/a
    expect(p.warnings).toContain('param "deploy.api" has no value in any layer — left verbatim (rule/b)');

    // unsetDeclared does NOT include this key, because the declaring ingredient has a default
    expect(unsetDeclared(p)).toEqual([]);

    // Rule b's content still has the literal placeholder
    const content = p.files.find((f) => f.path === ".claude/rules/b.md")!.content.toString("utf8");
    expect(content).toBe("api: {{deploy.api}}\n");
  });
});
