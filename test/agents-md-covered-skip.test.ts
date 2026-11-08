/**
 * The agents-md skip is silent for an ingredient another target of the workspace writes (decided by the walk from the matrix,
 * as SKIP_WARNING's carriers silence the "through X" cells); it is warned as before when no other target writes it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { profile, recipe, rule, scenario, type IngredientSpec } from "./helpers/forge.js";
import { skipResidue, withoutCoveredSkip } from "./helpers/covered-skip-delta.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const agent = (name: string, extra: Record<string, unknown> = {}): IngredientSpec => ({
  meta: { type: "agent", name, file: "agent.md", ...extra },
  files: { "agent.md": `# ${name}\n` },
});
const service = (name: string): IngredientSpec => ({
  meta: { type: "service", name, targets: "*" },
  files: { "compose.yaml": `services:\n  ${name}:\n    image: alpine\n` },
});

async function agentsMdWarnings(ingredients: IngredientSpec[], targets: string[], schema?: number): Promise<string[]> {
  const s = await scenario(
    { ingredients, recipes: [recipe("base", ingredients.map((i) => `${i.meta.type}/${i.meta.name}`))], profiles: [profile("acme", ["base"], targets)] },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  if (schema !== undefined) await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
  const p = await plan(await loadWorkspace(s.wsRoot));
  return p.warnings.filter((w) => w.startsWith("agents-md:"));
}

describe("agents-md: the skip of an ingredient another target writes is silent", () => {
  it("1. claude-code writes the agent and the MCP server: no agents-md line", async () => {
    const mcp: IngredientSpec = { meta: { type: "mcp", name: "pw", server: { command: "npx" } } };
    expect(await agentsMdWarnings([rule("a", "# A\n"), agent("x"), mcp], ["claude-code", "agents-md"])).toEqual([]);
  });

  it("2. agents-md alone: warned as before", async () => {
    expect(await agentsMdWarnings([rule("a", "# A\n"), agent("x")], ["agents-md"])).toEqual([
      "agents-md: 1 agent ingredient(s) have no AGENTS.md equivalent — skipped: agent/x",
    ]);
  });

  it("3. an agent whose targets leave claude-code out is warned: no other target writes it", async () => {
    expect(await agentsMdWarnings([agent("x", { targets: ["agents-md"] })], ["claude-code", "agents-md"])).toEqual([
      "agents-md: 1 agent ingredient(s) have no AGENTS.md equivalent — skipped: agent/x",
    ]);
  });

  it("4. two agents, one aimed at claude-code and one not: the line counts and names only the second", async () => {
    expect(await agentsMdWarnings([agent("x"), agent("y", { targets: ["agents-md"] })], ["claude-code", "agents-md"])).toEqual([
      "agents-md: 1 agent ingredient(s) have no AGENTS.md equivalent — skipped: agent/y",
    ]);
  });

  it("5. a type no other target writes (service) is still warned, with claude-code and kiro among the targets", async () => {
    expect(await agentsMdWarnings([service("echo")], ["claude-code", "kiro", "agents-md"])).toEqual([
      "agents-md: 1 service ingredient(s) have no AGENTS.md equivalent — skipped: service/echo",
    ]);
  });

  it("6. steering, which kiro writes and claude-code does not, is silent with kiro and warned without it", async () => {
    const st: IngredientSpec = { meta: { type: "steering", name: "st", targets: "*" }, files: { "steering.md": "# St\n" } };
    expect(await agentsMdWarnings([st], ["kiro", "agents-md"])).toEqual([]);
    expect(await agentsMdWarnings([st], ["claude-code", "agents-md"])).toEqual([
      "agents-md: 1 steering ingredient(s) have no AGENTS.md equivalent — skipped: steering/st",
    ]);
  });

  it("7. with cursor and agents-md alone, a hook (cursor runs claude-code's, absent here), a command and a skill (no agent-skills) stay warned", async () => {
    const hook: IngredientSpec = { meta: { type: "hook", name: "guard", targets: "*", files: ["guard.sh"] }, files: { "guard.sh": "echo\n" } };
    const command: IngredientSpec = { meta: { type: "command", name: "ship", targets: "*" }, files: { "command.md": "# ship\n" } };
    const skill: IngredientSpec = { meta: { type: "skill", name: "triage", targets: "*" }, files: { "SKILL.md": "# triage\n" } };
    expect(await agentsMdWarnings([agent("x"), hook, command, skill], ["cursor", "agents-md"], 15)).toEqual([
      "agents-md: 1 hook ingredient(s) have no AGENTS.md equivalent — skipped: hook/guard",
      "agents-md: 1 command ingredient(s) have no AGENTS.md equivalent — skipped: command/ship",
      "agents-md: 1 skill ingredient(s) have no AGENTS.md equivalent — skipped: skill/triage",
    ]);
  });
});

describe("the pin filter of the covered skip (test/helpers/covered-skip-delta.ts)", () => {
  const pinned = ["agents-md: 2 agent ingredient(s) have no AGENTS.md equivalent — skipped: agent/x, agent/y", "kiro: other"];
  it("a line the run no longer prints, or prints with fewer refs, is no residue", () => {
    expect(skipResidue(["kiro: other"], pinned)).toEqual([]);
    expect(skipResidue(["agents-md: 1 agent ingredient(s) have no AGENTS.md equivalent — skipped: agent/y"], pinned)).toEqual([]);
  });
  it("a line naming a ref or a type the pin never warned is a residue", () => {
    expect(skipResidue(["agents-md: 1 agent ingredient(s) have no AGENTS.md equivalent — skipped: agent/z"], pinned)).toHaveLength(1);
    expect(skipResidue(["agents-md: 1 mcp ingredient(s) have no AGENTS.md equivalent — skipped: agent/x"], pinned)).toHaveLength(1);
  });
  it("withoutCoveredSkip recounts a doctor summary instead of hiding it", () => {
    const report = { checks: [{ id: "plan", level: "warn", message: pinned[0] }, { id: "x", level: "error", message: "e" }], summary: { ok: 0, warn: 1, error: 1 } };
    expect(withoutCoveredSkip(report)).toEqual({ checks: [{ id: "x", level: "error", message: "e" }], summary: { ok: 0, warn: 0, error: 1 } });
  });
});
