import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { FORGE_SCHEMA_LIST_PARAMS } from "../src/schema/index.js";
import { profile, recipe, scenario, type IngredientSpec } from "./helpers/forge.js";

/** Spec 55 Part A §4.6–§4.7, tests 1, 10 and 11: list params in metadata, and refused in a server or a registration. */

const GATE = FORGE_SCHEMA_LIST_PARAMS;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function forgeWith(ing: IngredientSpec, env: unknown = ["projects/a/**", "projects/b/**"]) {
  const s = await scenario(
    { ingredients: [ing], recipes: [recipe("core", [`${ing.meta.type}/${ing.meta.name}`])], profiles: [profile("acme", ["core"], ["claude-code", "kiro"], { params: { env } })] },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: GATE }));
  return s;
}
const LIST = { env: { type: "list" } };
const planned = async (s: { wsRoot: string }) => plan(await loadWorkspace(s.wsRoot));
const planError = async (s: { wsRoot: string }) => planned(s).then(() => "no error", (e: Error) => e.message);
const fileOf = async (s: { wsRoot: string }, p: string) => (await planned(s)).files.find((f) => f.path === p)!.content.toString("utf8");

describe("list params in metadata (spec 55 §4.6)", () => {
  it("test 1: a rule's paths: from a list — one quoted item per line; [] under paths: is refused", async () => {
    const rule: IngredientSpec = { meta: { type: "rule", name: "scoped", inclusion: "fileMatch", fileMatchPattern: "x/**", params: LIST, frontmatterRaw: "paths:\n  - {{ env | yaml-items }}" }, files: { "rule.md": "# Scoped\n" } };
    const s = await forgeWith(rule);
    expect(await fileOf(s, ".claude/rules/scoped.md")).toMatch(/^---\npaths:\n {2}- "projects\/a\/\*\*"\n {2}- "projects\/b\/\*\*"\n---\n/);
    const one = await forgeWith(rule, ["projects/a/**"]);
    expect(await fileOf(one, ".claude/rules/scoped.md")).toMatch(/^---\npaths:\n {2}- "projects\/a\/\*\*"\n---\n/);
    const empty = await forgeWith(rule, []);
    expect(await planError(empty)).toContain("rule/scoped: list param env in frontmatterRaw is empty under paths:");
  });

  it("test 10: py in a description is refused; join in a command's description renders and passes metadataFault", async () => {
    const bad = await forgeWith({ meta: { type: "command", name: "go", description: "Runs {{env | py}}", params: LIST }, files: { "command.md": "Go.\n" } });
    expect(await planError(bad)).toContain("command/go: list param env in description takes py, which a metadata field cannot hold");
    const ok = await forgeWith({ meta: { type: "command", name: "go", description: "Runs on {{ env | join: \" and \" }}", params: LIST }, files: { "command.md": "Go.\n" } });
    expect(await fileOf(ok, ".claude/commands/go.md")).toContain("description: Runs on projects/a/** and projects/b/**");
  });

  it("test 10: a joined value that would break the file is refused by spec 50's test, naming the list key", async () => {
    const s = await forgeWith({ meta: { type: "command", name: "go", description: "Runs {{ env | join: \": \" }}", params: LIST }, files: { "command.md": "Go.\n" } });
    const m = await planError(s);
    expect(m).toContain("command/go: {{env}} in description would break the file");
    expect(m).not.toContain("__join");
  });

  it("test 10: a yaml-items line under allowed-tools is refused", async () => {
    const s = await forgeWith({ meta: { type: "command", name: "go", params: LIST, frontmatterRaw: "description: Go\nallowed-tools:\n  - {{ env | yaml-items }}" }, files: { "command.md": "Go.\n" } });
    expect(await planError(s)).toContain("command/go: list param env in frontmatterRaw stands under allowed-tools");
  });

  it("test 10: a list fileMatchPattern element {{x | yaml-items}} splices one element per item", async () => {
    const s = await forgeWith({ meta: { type: "rule", name: "scoped", inclusion: "fileMatch", fileMatchPattern: ["src/**", "{{ env | yaml-items }}"], params: LIST }, files: { "rule.md": "# Scoped\n" } });
    const kiro = await fileOf(s, ".kiro/steering/scoped.md");
    expect(kiro).toContain("src/**");
    expect(kiro).toContain("projects/a/**");
    expect(kiro).toContain("projects/b/**");
    expect(kiro).not.toContain("yaml-items");
  });

  it("a list key in metadata with no filter is refused", async () => {
    const s = await forgeWith({ meta: { type: "command", name: "go", description: "Runs {{env}}", params: LIST }, files: { "command.md": "Go.\n" } });
    expect(await planError(s)).toContain("command/go: list param env in description is cited with no filter");
  });
});

describe("a list key in a server or a registration (spec 55 §4.7)", () => {
  it("test 11: a server's args citing a list key, filtered or not, fail the plan with no value", async () => {
    for (const arg of ["{{env | json}}", "{{env}}"]) {
      const s = await forgeWith({ meta: { type: "mcp", name: "srv", params: LIST, server: { command: "npx", args: ["tool", arg] } } }, ["SECRET-A"]);
      const m = await planError(s);
      expect(m).toContain("mcp/srv: list param env in server.args[1] — an MCP server or a hook registration cannot take a list");
      expect(m).not.toContain("SECRET-A");
    }
  });

  it("test 11: a registration's command citing a list key fails the plan", async () => {
    const s = await forgeWith(
      {
        meta: { type: "hook", name: "h", files: ["h.sh"], params: LIST, registration: [{ event: "PreToolUse", command: "bash .claude/hooks/h.sh {{env | sh}}" }] },
        files: { "h.sh": "#!/bin/sh\n" },
      },
      ["SECRET-A"],
    );
    const m = await planError(s);
    expect(m).toContain("hook/h: list param env in registration[0].command");
    expect(m).not.toContain("SECRET-A");
  });
});
