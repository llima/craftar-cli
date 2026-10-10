import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, scenario } from "./helpers/forge.js";

// Spec 29 §4.1 — `explain` names, for each parameter a file cites, the layer that filled it.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const BODY = "{{own}} {{fromRecipe}} {{fromProfile}} {{fromWs}} {{fromLocal}} {{nobody}} {{own}} {{ 'X' | localize }}\n";

async function build() {
  const s = await scenario(
    {
      ingredients: [
        rule("a", BODY, { params: { own: { default: "d" }, fromProfile: { default: "shadowed" }, nobody: { description: "n" } } }),
        rule("plain", "# no parameters here\n"),
      ],
      recipes: [
        recipe("base", ["rule/a", "rule/plain"], { params: { fromRecipe: { default: "first" }, fromWs: { default: "shadowed" } } }),
        recipe("late", [], { params: { fromRecipe: { default: "last" } } }),
      ],
      profiles: [profile("acme", ["base", "late"], ["claude-code", "agents-md"], { params: { fromProfile: "p", fromLocal: "shadowed" } })],
    },
    { config: { profile: "acme", overrides: { params: { fromWs: "w" } } }, local: { overrides: { params: { fromLocal: "l" } } } },
  );
  cleanups.push(s.cleanup);
  return s;
}

describe("explain — params", () => {
  it("Plan.params lists each cited key once, sorted, with its layer; an ingredient citing nothing has no entry", async () => {
    const s = await build();
    const p = await plan(await loadWorkspace(s.wsRoot));
    expect(p.params.get("rule/a")).toEqual([
      { key: "fromLocal", layer: "workspace" },
      { key: "fromProfile", layer: { profile: "acme" } },
      { key: "fromRecipe", layer: { recipe: "late" } },
      { key: "fromWs", layer: "workspace" },
      { key: "nobody", layer: "unset" },
      { key: "own", layer: "default" },
    ]);
    expect(p.params.has("rule/plain")).toBe(false);
    expect(p.files.find((f) => f.path === ".claude/rules/a.md")!.content.toString("utf8")).toBe("d last p w l {{nobody}} d {{ 'X' | localize }}\n");
  });

  it("the line sits under the ingredient lines, in the sections line's shape", async () => {
    const s = await build();
    const r = runCli(["explain", ".claude/rules/a.md", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")).toContain("  params      fromLocal (workspace), fromProfile (profile acme), fromRecipe (recipe late), fromWs (workspace), nobody (unset), own (default)");
  });

  it("a file citing no parameter, and AGENTS.md, get no params line", async () => {
    const s = await build();
    expect(runCli(["explain", ".claude/rules/plain.md", "--workspace", s.wsRoot]).stdout).not.toContain("  params");
    const agents = runCli(["explain", "AGENTS.md", "--workspace", s.wsRoot]);
    expect(agents.code).toBe(0);
    expect(agents.stdout).not.toContain("  params");
  });
});
