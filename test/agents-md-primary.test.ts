import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acmePrimary } from "./helpers/agents-md-primary.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { reservedKey } from "../src/core/extract.js";
import { effectiveTargets, buildRuleLookup } from "../src/emitters/shared.js";
import { written } from "../src/core/capabilities.js";
import { RuleIngredient, AgentIngredient, SteeringIngredient } from "../src/schema/index.js";
import type { Scenario } from "./helpers/forge.js";
import type { Ingredient } from "../src/schema/index.js";

/**
 * Spec 41 §11.2: Unit tests for agents-md.primary resolution logic.
 */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

describe("Resolution.primary (spec 41 §4.1)", () => {
  it("schema 5, no key → primary false, no agents-md.primary warning", async () => {
    const s = kept(await acmePrimary({ schema: 5 }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    expect(p.resolution.primary).toBe(false);
    const primaryWarnings = p.warnings.filter((w) => w.includes("agents-md.primary"));
    expect(primaryWarnings).toEqual([]);
  });

  it("schema 5, agents-md.primary: true → primary true, no warning", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    expect(p.resolution.primary).toBe(true);
    const primaryWarnings = p.warnings.filter((w) => w.includes("agents-md.primary"));
    expect(primaryWarnings).toEqual([]);
  });

  it("schema 4, agents-md.primary: true → primary false, warning about schema", async () => {
    const s = kept(await acmePrimary({ schema: 4, params: { "agents-md.primary": true } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    expect(p.resolution.primary).toBe(false);
    const primaryWarnings = p.warnings.filter((w) => w.includes("agents-md.primary"));
    expect(primaryWarnings).toHaveLength(1);
    expect(primaryWarnings[0]).toContain("needs a Forge at schema: 5 — the mode is off");
  });

  it("schema 4, agents-md.primary: 'yes' → primary false, no warning", async () => {
    // Any non-true value below the gate produces no warning
    const s = kept(await acmePrimary({ schema: 4, params: { "agents-md.primary": "yes" } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    expect(p.resolution.primary).toBe(false);
    const primaryWarnings = p.warnings.filter((w) => w.includes("agents-md.primary"));
    expect(primaryWarnings).toEqual([]);
  });

  it("schema 5, agents-md.primary: 'true' (string) → primary false, type warning", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": "true" } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    expect(p.resolution.primary).toBe(false);
    const primaryWarnings = p.warnings.filter((w) => w.includes("agents-md.primary"));
    expect(primaryWarnings).toHaveLength(1);
    expect(primaryWarnings[0]).toContain("must be true or false — the mode is off");
  });

  it("schema 5, agents-md.primary: true, targets without agents-md → primary false, no-effect warning", async () => {
    const s = kept(
      await acmePrimary({
        schema: 5,
        params: { "agents-md.primary": true },
        wsConfig: { targets: ["claude-code", "kiro"] },
      }),
    );
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    expect(p.resolution.primary).toBe(false);
    const primaryWarnings = p.warnings.filter((w) => w.includes("agents-md.primary"));
    expect(primaryWarnings).toHaveLength(1);
    expect(primaryWarnings[0]).toContain("has no effect without the agents-md target");
  });

  it("schema 5, agents-md.primary: false → primary false, no warning", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": false } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    expect(p.resolution.primary).toBe(false);
    const primaryWarnings = p.warnings.filter((w) => w.includes("agents-md.primary"));
    expect(primaryWarnings).toEqual([]);
  });
});

describe("reservedKey with agents-md.primary (spec 41 §4.1)", () => {
  it("agents-md.primary is reserved at schema 1", () => {
    expect(reservedKey("agents-md.primary", 1)).toBe(true);
  });

  it("agents-md.primary is reserved at schema 5", () => {
    expect(reservedKey("agents-md.primary", 5)).toBe(true);
  });
});

describe("effectiveTargets (spec 41 §4.2–§4.3)", () => {
  const ruleAlways = (targets?: "*" | string[]): Ingredient =>
    RuleIngredient.parse({ type: "rule", name: "test", inclusion: "always", ...(targets !== undefined ? { targets } : {}) });
  const ruleFileMatch = (): Ingredient =>
    RuleIngredient.parse({ type: "rule", name: "test", inclusion: "fileMatch", fileMatchPattern: "src/**" });
  const agent = (): Ingredient => AgentIngredient.parse({ type: "agent", name: "test" });
  const steering = (): Ingredient => SteeringIngredient.parse({ type: "steering", name: "test" });

  it("a. primary true, rule always, targets omitted → ['agents-md']", () => {
    const meta = ruleAlways();
    expect(effectiveTargets(meta, { primary: true })).toEqual(["agents-md"]);
  });

  it("b. primary true, rule always, targets: '*' written → ['agents-md']", () => {
    const meta = ruleAlways("*");
    expect(effectiveTargets(meta, { primary: true })).toEqual(["agents-md"]);
  });

  it("c. primary false, rule always → returns the very same reference as meta.targets", () => {
    const meta = ruleAlways();
    expect(effectiveTargets(meta, { primary: false })).toBe(meta.targets);
  });

  it("d. primary true, rule inclusion: fileMatch → '*'", () => {
    const meta = ruleFileMatch();
    expect(effectiveTargets(meta, { primary: true })).toBe("*");
  });

  it("e. primary true, rule always, targets: ['claude-code', 'agents-md'] → that array (toBe)", () => {
    const meta = ruleAlways(["claude-code", "agents-md"]);
    expect(effectiveTargets(meta, { primary: true })).toBe(meta.targets);
  });

  it("f. primary true, agent → '*'", () => {
    const meta = agent();
    expect(effectiveTargets(meta, { primary: true })).toBe("*");
  });

  it("g. primary true, steering → its targets (['kiro'])", () => {
    const meta = steering();
    expect(effectiveTargets(meta, { primary: true })).toEqual(["kiro"]);
    expect(effectiveTargets(meta, { primary: true })).toBe(meta.targets);
  });
});

describe("written() under the mode (spec 41 §4.3)", () => {
  it("rule/style reaches only agents-md; rule/api reaches all three; rule/release unchanged", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const collectRefs = (target: "claude-code" | "kiro" | "agents-md"): string[] => {
      const refs: string[] = [];
      for (const ing of written(p.resolution, target, () => {})) {
        refs.push(ing.ref);
      }
      return refs;
    };

    const claudeCode = collectRefs("claude-code");
    const kiro = collectRefs("kiro");
    const agentsMd = collectRefs("agents-md");

    // rule/style (always, default targets) reaches agents-md only
    expect(claudeCode).toContain("rule/api");
    expect(claudeCode).not.toContain("rule/style");

    expect(kiro).toContain("rule/api");
    expect(kiro).toContain("rule/kiro-notes");
    expect(kiro).not.toContain("rule/style");

    // rule/style should be in agents-md
    expect(agentsMd).toContain("rule/style");
    expect(agentsMd).toContain("rule/api");
    expect(agentsMd).toContain("rule/release");
  });
});

describe("plan() under the mode (spec 41)", () => {
  it("no .claude/rules/style.md nor .kiro/steering/style.md; AGENTS.md contains '# Style'", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const paths = p.files.map((f) => f.path);
    expect(paths).not.toContain(".claude/rules/style.md");
    expect(paths).not.toContain(".kiro/steering/style.md");

    const agentsMd = p.files.find((f) => f.path === "AGENTS.md");
    expect(agentsMd).toBeDefined();
    expect(agentsMd!.content.toString("utf8")).toContain("# Style");
  });

  it("agent JSON prompt contains 'AGENTS.md (rule: style)' and not '.kiro/steering/style.md'", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const agentJson = p.files.find((f) => f.path === ".kiro/agents/api-reviewer.json");
    expect(agentJson).toBeDefined();
    const parsed = JSON.parse(agentJson!.content.toString("utf8"));
    expect(parsed.prompt).toContain("AGENTS.md (rule: style)");
    expect(parsed.prompt).not.toContain(".kiro/steering/style.md");
  });

  it("mode off: agent JSON prompt contains '.kiro/steering/style.md' (control)", async () => {
    const s = kept(await acmePrimary({ schema: 5 }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const agentJson = p.files.find((f) => f.path === ".kiro/agents/api-reviewer.json");
    expect(agentJson).toBeDefined();
    const parsed = JSON.parse(agentJson!.content.toString("utf8"));
    expect(parsed.prompt).toContain(".kiro/steering/style.md");
  });
});


describe("claude-code emitter under agents-md.primary (spec 41 §4.4)", () => {
  it("test 1: agent body resolves references — style→AGENTS.md, release→AGENTS.md, kiro-notes→.kiro/steering", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const agentMd = p.files.find((f) => f.path === ".claude/agents/api-reviewer.md");
    expect(agentMd).toBeDefined();
    const body = agentMd!.content.toString("utf8");

    // style and release → AGENTS.md
    expect(body).toContain("Follow AGENTS.md (rule: style) and AGENTS.md (rule: release).");
    // Link with fragment → fragment dropped
    expect(body).toContain("See [the style](AGENTS.md).");
    // kiro-notes (state B: kiro writes it) → .kiro/steering/
    expect(body).toContain("Notes: .kiro/steering/kiro-notes.md");
    // No .claude/rules/style.md remains
    expect(body).not.toContain(".claude/rules/style.md");
  });

  it("test 1b: agent frontmatter description is resolved", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const agentMd = p.files.find((f) => f.path === ".claude/agents/api-reviewer.md");
    expect(agentMd).toBeDefined();
    const body = agentMd!.content.toString("utf8");
    // Check the frontmatter description contains the resolved reference
    expect(body).toMatch(/description: Reviews API changes against AGENTS\.md \(rule: style\)/);
  });

  it("test 2: command and skill resolved", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const commandMd = p.files.find((f) => f.path === ".claude/commands/review.md");
    expect(commandMd).toBeDefined();
    expect(commandMd!.content.toString("utf8")).toContain("AGENTS.md (rule: style)");

    const skillMd = p.files.find((f) => f.path === ".claude/skills/checks/SKILL.md");
    expect(skillMd).toBeDefined();
    expect(skillMd!.content.toString("utf8")).toContain("Use AGENTS.md (rule: style).");
  });

  it("test 3: copied files unchanged and warned", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const pModeOn = await plan(ws);

    // Mode off for comparison
    const sOff = kept(await acmePrimary({ schema: 5 }));
    const wsOff = await loadWorkspace(sOff.wsRoot, { home: process.env.CRAFTAR_HOME });
    const pModeOff = await plan(wsOff);

    // run.sh and lint.sh should be byte-identical to mode-off
    const runShOn = pModeOn.files.find((f) => f.path === ".claude/skills/checks/run.sh");
    const runShOff = pModeOff.files.find((f) => f.path === ".claude/skills/checks/run.sh");
    expect(runShOn).toBeDefined();
    expect(runShOff).toBeDefined();
    expect(runShOn!.content).toEqual(runShOff!.content);

    const lintShOn = pModeOn.files.find((f) => f.path === ".claude/scripts/lint.sh");
    const lintShOff = pModeOff.files.find((f) => f.path === ".claude/scripts/lint.sh");
    expect(lintShOn).toBeDefined();
    expect(lintShOff).toBeDefined();
    expect(lintShOn!.content).toEqual(lintShOff!.content);

    // Check warnings: exactly one claude-code: warning
    const ccWarnings = pModeOn.warnings.filter((w) => w.startsWith("claude-code: "));
    expect(ccWarnings).toHaveLength(1);
    const ccWarning = ccWarnings[0];

    // Contains file:line for style reference in scripts
    expect(ccWarning).toContain(".claude/scripts/lint.sh:2 (style)");
    expect(ccWarning).toContain(".claude/skills/checks/run.sh:2 (style)");

    // Does NOT contain #!/bin/sh or echo ok (body lines)
    expect(ccWarning).not.toContain("#!/bin/sh");
    expect(ccWarning).not.toContain("echo ok");
  });

  it("test 4: scoped rule body resolved", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const apiMd = p.files.find((f) => f.path === ".claude/rules/api.md");
    expect(apiMd).toBeDefined();
    expect(apiMd!.content.toString("utf8")).toContain("Every endpoint follows AGENTS.md (rule: style).");
  });

  it("test 5b: an agent's and a command's frontmatterRaw is resolved under the mode, and kept as written with it off", async () => {
    const fm = "name: fm-ref\ndescription: Checks against .claude/rules/style.md\n";
    const extraIngredients = [
      { meta: { type: "agent", name: "fm-ref", frontmatterRaw: fm }, files: { "agent.md": "Plain.\n" } },
      { meta: { type: "command", name: "fm-cmd", frontmatterRaw: "description: see .claude/rules/style.md\n" }, files: { "command.md": "Run.\n" } },
    ];
    const on = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true }, extraIngredients }));
    const pOn = await plan(await loadWorkspace(on.wsRoot, { home: process.env.CRAFTAR_HOME }));
    const agentOn = pOn.files.find((f) => f.path === ".claude/agents/fm-ref.md")!.content.toString("utf8");
    const cmdOn = pOn.files.find((f) => f.path === ".claude/commands/fm-cmd.md")!.content.toString("utf8");
    expect(agentOn).toContain("description: Checks against AGENTS.md (rule: style)\n");
    expect(cmdOn).toContain("description: see AGENTS.md (rule: style)\n");
    expect(pOn.reworded).toEqual(expect.arrayContaining([".claude/agents/fm-ref.md", ".claude/commands/fm-cmd.md"]));

    const off = kept(await acmePrimary({ schema: 5, extraIngredients }));
    const pOff = await plan(await loadWorkspace(off.wsRoot, { home: process.env.CRAFTAR_HOME }));
    expect(pOff.files.find((f) => f.path === ".claude/agents/fm-ref.md")!.content.toString("utf8")).toContain(fm);
  });

  it("test 5: frontmatterRaw vs description — only one is resolved", async () => {
    // Add fm-agent (with frontmatterRaw) and plain-agent (without), both citing a ghost rule
    const extraIngredients = [
      {
        meta: { type: "rule", name: "ghost", targets: [] },
        files: { "rule.md": "# Ghost\nNever written.\n" },
      },
      {
        meta: {
          type: "agent",
          name: "fm-agent",
          frontmatterRaw: "name: fm-agent\ndescription: x\n",
          description: "see .claude/rules/ghost.md",
        },
        files: { "agent.md": "Plain.\n" },
      },
      {
        meta: {
          type: "agent",
          name: "plain-agent",
          description: "see .claude/rules/ghost.md",
        },
        files: { "agent.md": "Body text.\n" },
      },
    ];
    const s = kept(
      await acmePrimary({ schema: 5, params: { "agents-md.primary": true }, extraIngredients }),
    );
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    // Find the claude-code: warning
    const ccWarnings = p.warnings.filter((w) => w.startsWith("claude-code: "));
    expect(ccWarnings.length).toBeGreaterThan(0);
    const ccWarning = ccWarnings.join("; ");

    // fm-agent uses frontmatterRaw, so its description is NOT resolved → not in warning
    expect(ccWarning).not.toContain("fm-agent");
    // plain-agent uses description, so it IS resolved → in warning
    expect(ccWarning).toContain(".claude/rules/ghost.md (in agent/plain-agent; rule/ghost reaches no target here)");
  });
});

describe("kiro emitter under agents-md.primary (spec 41 §4.4–§4.5)", () => {
  it("test 6: copied skill files unchanged and warned", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const pModeOn = await plan(ws);

    const sOff = kept(await acmePrimary({ schema: 5 }));
    const wsOff = await loadWorkspace(sOff.wsRoot, { home: process.env.CRAFTAR_HOME });
    const pModeOff = await plan(wsOff);

    // .kiro/skills/checks/run.sh unchanged bytes
    const runShOn = pModeOn.files.find((f) => f.path === ".kiro/skills/checks/run.sh");
    const runShOff = pModeOff.files.find((f) => f.path === ".kiro/skills/checks/run.sh");
    expect(runShOn).toBeDefined();
    expect(runShOff).toBeDefined();
    expect(runShOn!.content).toEqual(runShOff!.content);

    // kiro: warning contains the scan hit
    const kiroWarnings = pModeOn.warnings.filter((w) => w.startsWith("kiro: "));
    expect(kiroWarnings.length).toBeGreaterThan(0);
    const kiroWarning = kiroWarnings.join("; ");
    expect(kiroWarning).toContain(".kiro/skills/checks/run.sh:2 (style)");
  });

  it("test 7a: generated resources name only planned paths, no file://AGENTS.md", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const plannedPaths = new Set(p.files.map((f) => f.path));

    // Find which agents have explicit resources in the Forge (should be skipped)
    // In our test setup, only 'planner' has explicit resources
    const agentsWithExplicitResources = new Set(["planner"]);

    // Check every agent's generated resources (skip agents with explicit m.resources)
    for (const f of p.files) {
      if (!f.path.startsWith(".kiro/agents/") || !f.path.endsWith(".json")) continue;
      const json = JSON.parse(f.content.toString("utf8"));
      const agentName = json.name as string;

      // Skip agents with hand-written resources; §4.6 handles them (not this task)
      if (agentsWithExplicitResources.has(agentName)) continue;

      const resources: string[] = json.resources ?? [];
      for (const r of resources) {
        // Skip non-file:// and globs
        if (!r.startsWith("file://")) continue;
        if (r.includes("*")) continue;
        const resPath = r.slice("file://".length);
        expect(plannedPaths).toContain(resPath);
        expect(r).not.toBe("file://AGENTS.md");
      }
    }
  });

  it("test 7b: api-reviewer resources with repo-discovery — mode on vs off", async () => {
    const extraIngredients = [
      {
        meta: { type: "rule", name: "repo-discovery" },
        files: { "rule.md": "# Repo Discovery\nFind the repo.\n" },
      },
    ];
    const sOn = kept(
      await acmePrimary({ schema: 5, params: { "agents-md.primary": true }, extraIngredients }),
    );
    const wsOn = await loadWorkspace(sOn.wsRoot, { home: process.env.CRAFTAR_HOME });
    const pOn = await plan(wsOn);

    const sOff = kept(await acmePrimary({ schema: 5, extraIngredients }));
    const wsOff = await loadWorkspace(sOff.wsRoot, { home: process.env.CRAFTAR_HOME });
    const pOff = await plan(wsOff);

    const agentJsonOn = pOn.files.find((f) => f.path === ".kiro/agents/api-reviewer.json");
    const agentJsonOff = pOff.files.find((f) => f.path === ".kiro/agents/api-reviewer.json");

    expect(agentJsonOn).toBeDefined();
    expect(agentJsonOff).toBeDefined();

    const resourcesOn: string[] = JSON.parse(agentJsonOn!.content.toString("utf8")).resources;
    const resourcesOff: string[] = JSON.parse(agentJsonOff!.content.toString("utf8")).resources;

    // Mode on: repo-discovery is AGENTS.md-only now, so not in resources
    expect(resourcesOn).toEqual(["file://.kiro/steering/api.md"]);
    // Mode off: both api and repo-discovery
    expect(resourcesOff).toEqual(["file://.kiro/steering/api.md", "file://.kiro/steering/repo-discovery.md"]);
  });
});

describe("plan().reworded (spec 41 §4.4)", () => {
  it("test 8: reworded paths", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    // Should contain reworded .claude/ and .kiro/ text files
    expect(p.reworded).toContain(".claude/agents/api-reviewer.md");
    expect(p.reworded).toContain(".claude/commands/review.md");
    expect(p.reworded).toContain(".claude/skills/checks/SKILL.md");
    expect(p.reworded).toContain(".claude/rules/api.md");
    expect(p.reworded).toContain(".kiro/agents/api-reviewer.json");

    // Should NOT contain copied files
    expect(p.reworded).not.toContain(".claude/scripts/lint.sh");
  });

  it("test 8b: mode off → reworded is empty", async () => {
    const s = kept(await acmePrimary({ schema: 5 }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    expect(p.reworded).toEqual([]);
  });
});

describe("unresolvedRuleRefs unit (spec 41 §4.4)", () => {
  it("test 10: agents-md mode with left boundary check", async () => {
    // Build a minimal lookup where style is AGENTS.md-only and api is written by claude-code
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const { unresolvedRuleRefs, buildRuleLookup } = await import("../src/emitters/shared.js");
    const lookup = buildRuleLookup(p.resolution.ingredients, p.resolution);

    const text = "a\n.claude/rules/style.md and .claude/rules/api.md\nx.claude/rules/style.md\n";
    const refs = unresolvedRuleRefs(text, lookup, p.resolution.targets, "agents-md");

    // style is AGENTS.md-only (state C) → listed
    // api is written by claude-code (state A) → NOT listed
    // third line: x.claude/... has no left boundary → NOT listed
    expect(refs).toEqual([{ line: 2, name: "style" }]);
  });
});


describe("Kiro resources check (spec 41 §4.5–§4.6)", () => {
  it("test k1: fresh workspace, mode on — unplanned entry for style, not present", async () => {
    // planner has hand-written resources: file://.kiro/steering/style.md (style is AGENTS.md-only), a glob, file://docs/plan.md
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    expect(p.kiroResources).not.toBeNull();
    expect(p.kiroResources!.unplanned).toEqual([{ agent: "planner", path: ".kiro/steering/style.md" }]);
    expect(p.kiroResources!.present).toEqual([]);
    // The glob and docs/plan.md should NOT be listed
  });

  it("test k4: mode off — kiroResources is null, no warning", async () => {
    const s = kept(await acmePrimary({ schema: 5 }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    expect(p.kiroResources).toBeNull();
    const kiroResourcesWarnings = p.warnings.filter((w) => w.startsWith("kiro: agent resources"));
    expect(kiroResourcesWarnings).toEqual([]);
  });
});


describe("claudeMdBlocks unit (spec 41 §4.7)", () => {
  const makeReadExisting = (files: Record<string, string>) => async (rel: string): Promise<Buffer | null> => {
    if (Object.hasOwn(files, rel)) return Buffer.from(files[rel], "utf8");
    return null;
  };

  it("absent → {imports: false, blocking: []}", async () => {
    const { claudeMdBlocks } = await import("../src/core/sync.js");
    const result = await claudeMdBlocks(makeReadExisting({}));
    expect(result).toEqual({ imports: false, importedBy: null, blocking: [] });
  });

  it("CLAUDE.md with '# x\\n@AGENTS.md  \\n' → imports", async () => {
    const { claudeMdBlocks } = await import("../src/core/sync.js");
    const result = await claudeMdBlocks(makeReadExisting({ "CLAUDE.md": "# x\n@AGENTS.md  \n" }));
    expect(result.imports).toBe(true);
    expect(result.blocking).toEqual([]);
  });

  it("CLAUDE.md starting with a UTF-8 BOM before @AGENTS.md → imports (measured: Claude Code 2.1.310 reads it)", async () => {
    const { claudeMdBlocks } = await import("../src/core/sync.js");
    const result = await claudeMdBlocks(makeReadExisting({ "CLAUDE.md": "\uFEFF@AGENTS.md\n" }));
    expect(result).toEqual({ imports: true, importedBy: "CLAUDE.md", blocking: [] });
  });

  it(".claude/CLAUDE.md starting with a UTF-8 BOM before @../AGENTS.md → imports", async () => {
    const { claudeMdBlocks } = await import("../src/core/sync.js");
    const result = await claudeMdBlocks(makeReadExisting({ ".claude/CLAUDE.md": "\uFEFF@../AGENTS.md\r\n" }));
    expect(result).toEqual({ imports: true, importedBy: ".claude/CLAUDE.md", blocking: [] });
  });

  it("CLAUDE.md with '@AGENTS.md \\r\\n' (space before CRLF) → imports", async () => {
    const { claudeMdBlocks } = await import("../src/core/sync.js");
    const result = await claudeMdBlocks(makeReadExisting({ "CLAUDE.md": "@AGENTS.md \r\n" }));
    expect(result.imports).toBe(true);
    expect(result.blocking).toEqual([]);
  });

  // An import is relative to the file that holds it (measured with Claude Code 2.1.310): from .claude/CLAUDE.md only
  // `@../AGENTS.md` reaches the root's AGENTS.md.
  it(".claude/CLAUDE.md with '@../AGENTS.md\\r\\n' → imports", async () => {
    const { claudeMdBlocks } = await import("../src/core/sync.js");
    const result = await claudeMdBlocks(makeReadExisting({ ".claude/CLAUDE.md": "@../AGENTS.md\r\n" }));
    expect(result.imports).toBe(true);
    expect(result.blocking).toEqual([]);
  });

  it(".claude/CLAUDE.md with '@AGENTS.md' or '@./AGENTS.md' → blocking, not importing", async () => {
    const { claudeMdBlocks } = await import("../src/core/sync.js");
    for (const line of ["@AGENTS.md\n", "@./AGENTS.md\n"]) {
      const result = await claudeMdBlocks(makeReadExisting({ ".claude/CLAUDE.md": line }));
      expect(result).toEqual({ imports: false, importedBy: null, blocking: [".claude/CLAUDE.md"] });
    }
  });

  it("CLAUDE.md with '@./AGENTS.md' → imports; CLAUDE.md with '@../AGENTS.md' → blocking", async () => {
    const { claudeMdBlocks } = await import("../src/core/sync.js");
    expect((await claudeMdBlocks(makeReadExisting({ "CLAUDE.md": "@./AGENTS.md\n" }))).imports).toBe(true);
    expect(await claudeMdBlocks(makeReadExisting({ "CLAUDE.md": "@../AGENTS.md\n" }))).toEqual({ imports: false, importedBy: null, blocking: ["CLAUDE.md"] });
  });

  it("CLAUDE.md '# notes\\n' → blocking ['CLAUDE.md']", async () => {
    const { claudeMdBlocks } = await import("../src/core/sync.js");
    const result = await claudeMdBlocks(makeReadExisting({ "CLAUDE.md": "# notes\n" }));
    expect(result.imports).toBe(false);
    expect(result.blocking).toEqual(["CLAUDE.md"]);
  });

  it("CLAUDE.local.md alone → blocking ['CLAUDE.local.md']", async () => {
    const { claudeMdBlocks } = await import("../src/core/sync.js");
    const result = await claudeMdBlocks(makeReadExisting({ "CLAUDE.local.md": "# local\n" }));
    expect(result.imports).toBe(false);
    expect(result.blocking).toEqual(["CLAUDE.local.md"]);
  });

  it("CLAUDE.local.md beside an importing CLAUDE.md → imports, blocking []", async () => {
    const { claudeMdBlocks } = await import("../src/core/sync.js");
    const result = await claudeMdBlocks(makeReadExisting({
      "CLAUDE.md": "@AGENTS.md\n",
      "CLAUDE.local.md": "# local\n",
    }));
    expect(result.imports).toBe(true);
    expect(result.blocking).toEqual([]);
  });
});

describe("CLAUDE.md blocking warning (spec 41 §4.7)", () => {
  it("plan, mode on, CLAUDE.md with token — warning, token not in warnings", async () => {
    const TOKEN = "TOKEN-" + "x".repeat(8);
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true }, wsFiles: { "CLAUDE.md": `# notes\n${TOKEN}\n` } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    // Exactly one warning starting with the blocked message
    const blockedWarnings = p.warnings.filter((w) => w.startsWith("agents-md.primary: CLAUDE.md keeps Claude Code"));
    expect(blockedWarnings).toHaveLength(1);

    // The token string should NOT appear in any warning
    for (const w of p.warnings) {
      expect(w).not.toContain(TOKEN);
    }
  });

  it("mode on, targets [kiro, agents-md] → no blocked warning", async () => {
    const s = kept(await acmePrimary({
      schema: 5,
      params: { "agents-md.primary": true },
      wsFiles: { "CLAUDE.md": "# notes\n" },
      wsConfig: { targets: ["kiro", "agents-md"] },
    }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const blockedWarnings = p.warnings.filter((w) => w.startsWith("agents-md.primary:"));
    expect(blockedWarnings).toEqual([]);
  });

  it("mode off, CLAUDE.md exists → no blocked warning", async () => {
    const s = kept(await acmePrimary({ schema: 5, wsFiles: { "CLAUDE.md": "# notes\n" } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const blockedWarnings = p.warnings.filter((w) => w.startsWith("agents-md.primary:"));
    expect(blockedWarnings).toEqual([]);
  });
});

describe("Budget clause under the mode (spec 41 §4.9)", () => {
  it("mode on, over budget — warning contains 'these rules are in no other file'", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true, "agents-md.maxBytes": 10 } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const budgetWarnings = p.warnings.filter((w) => w.includes("AGENTS.md is") && w.includes("bytes"));
    expect(budgetWarnings).toHaveLength(1);
    expect(budgetWarnings[0]).toContain("these rules are in no other file");
  });

  it("mode off, over budget — warning does NOT contain 'these rules are in no other file'", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.maxBytes": 10 } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);

    const budgetWarnings = p.warnings.filter((w) => w.includes("AGENTS.md is") && w.includes("bytes"));
    expect(budgetWarnings).toHaveLength(1);
    expect(budgetWarnings[0]).not.toContain("these rules are in no other file");
  });
});


describe("agents-md-primary and kiro-resources doctor checks (spec 41 §4.6–§4.7)", () => {
  // Helper to run doctor
  async function runDoc(wsRoot: string, wsFiles: Record<string, string> = {}) {
    const { runDoctor } = await import("../src/core/doctor.js");
    const { tmpDir } = await import("./helpers/forge.js");
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");

    // Write wsFiles to workspace
    for (const [rel, content] of Object.entries(wsFiles)) {
      await fs.writeFile(path.join(wsRoot, rel), content);
    }

    const home = await tmpDir("craftar-doctor-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));

    return runDoctor({
      version: "0.0.0",
      home,
      workspace: wsRoot,
      fetch: false,
      strict: false,
      registryOff: false,
      env: {},
      nodeVersion: "22.11.0",
      gitVersion: async () => "2.53.0",
    });
  }

  it("1. mode off (schema 5, no key) → no check with id agents-md-primary or kiro-resources", async () => {
    const s = kept(await acmePrimary({ schema: 5 })); // mode off
    const report = await runDoc(s.wsRoot);

    const primaryCheck = report.checks.find((c) => c.id === "agents-md-primary");
    const kiroCheck = report.checks.find((c) => c.id === "kiro-resources");
    expect(primaryCheck).toBeUndefined();
    expect(kiroCheck).toBeUndefined();
  });

  it("2. mode on, fresh workspace → kiro-resources has exactly one error naming planner and .kiro/steering/style.md", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));
    const report = await runDoc(s.wsRoot);

    const kiroChecks = report.checks.filter((c) => c.id === "kiro-resources");
    expect(kiroChecks).toHaveLength(1);
    expect(kiroChecks[0].level).toBe("error");
    expect(kiroChecks[0].message).toContain("planner");
    expect(kiroChecks[0].message).toContain(".kiro/steering/style.md");

    // No plan finding should repeat this
    const planFindings = report.checks.filter((c) => c.id === "plan" && c.message.includes("agent resources"));
    expect(planFindings).toHaveLength(0);
  });

  it("3. mode on, wsFiles CLAUDE.md with # notes → agents-md-primary warn with claudeMdBlockedMessage(CLAUDE.md)", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));
    const { claudeMdBlockedMessage } = await import("../src/core/sync.js");
    const report = await runDoc(s.wsRoot, { "CLAUDE.md": "# notes\n" });

    const primaryChecks = report.checks.filter((c) => c.id === "agents-md-primary");
    const warnChecks = primaryChecks.filter((c) => c.level === "warn");
    expect(warnChecks.length).toBeGreaterThanOrEqual(1);
    expect(warnChecks[0].message).toBe(claudeMdBlockedMessage("CLAUDE.md"));

    // No plan finding should repeat this
    const planFindings = report.checks.filter((c) => c.id === "plan" && c.message.includes("keeps Claude Code"));
    expect(planFindings).toHaveLength(0);
  });

  it("4. mode on, CLAUDE.md with @AGENTS.md → exactly one agents-md-primary line, level ok, naming CLAUDE.md (spec 50 §4.1)", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));
    const report = await runDoc(s.wsRoot, { "CLAUDE.md": "@AGENTS.md\n" });

    const primaryChecks = report.checks.filter((c) => c.id === "agents-md-primary");
    expect(primaryChecks).toHaveLength(1);
    expect(primaryChecks[0].level).toBe("ok");
    expect(primaryChecks[0].message).toBe("AGENTS.md arrives through the import in CLAUDE.md");
  });

  it("5. ancestor: CLAUDE.md in parent directory → agents-md-primary warn naming the absolute path", async () => {
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");

    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));

    // Write CLAUDE.md to the root (parent of wsRoot) to simulate an ancestor
    await fs.writeFile(path.join(s.root, "CLAUDE.md"), "# parent\n");

    const report = await runDoc(s.wsRoot);

    const primaryChecks = report.checks.filter((c) => c.id === "agents-md-primary" && c.level === "warn");
    // The ancestor path is s.root/CLAUDE.md — check both raw and realpath
    const ancestorPath = path.join(s.root, "CLAUDE.md");
    const ancestorRealpath = await fs.realpath(ancestorPath);
    const ancestorCheck = primaryChecks.find((c) => c.message.includes(ancestorPath) || c.message.includes(ancestorRealpath));
    expect(ancestorCheck).toBeDefined();
  });

  // The scenario lives under os.tmpdir(): a CLAUDE.md in one of its real ancestors would make this case a warn, not an ok.
  const realAncestorClaude = (() => {
    for (let d = os.tmpdir(); ; d = path.dirname(d)) {
      // Since spec 50 §4.2 any of the three files there is a warn.
      if (["CLAUDE.md", "CLAUDE.local.md", path.join(".claude", "CLAUDE.md")].some((f) => existsSync(path.join(d, f)))) return true;
      if (d === path.dirname(d)) return false;
    }
  })();
  it.skipIf(realAncestorClaude)("6. mode on, nothing at root and no ancestor CLAUDE.md → one ok: nothing keeps Claude Code from reading AGENTS.md", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));
    const report = await runDoc(s.wsRoot);
    const primaryChecks = report.checks.filter((c) => c.id === "agents-md-primary");
    expect(primaryChecks).toEqual([expect.objectContaining({ level: "ok", message: "nothing keeps Claude Code from reading AGENTS.md" })]);
  });

  it("7. the ancestor walk reaches the file-system root", async () => {
    const { claudeMdAncestors } = await import("../src/core/doctor.js");
    const root = path.parse(process.cwd()).root;
    const ws = path.join(root, "a", "b", "ws");
    const seen: string[] = [];
    const found = await claudeMdAncestors(ws, async (f) => (seen.push(f), f === path.join(root, "CLAUDE.md")));
    expect(found).toEqual([path.join(root, "CLAUDE.md")]);
    // Since spec 50 §4.2 each directory is asked for three files; the last directory asked is the file-system root.
    expect(seen.filter((f) => path.basename(f) === "CLAUDE.md" && path.basename(path.dirname(f)) !== ".claude")).toEqual([
      path.join(root, "a", "b", "CLAUDE.md"),
      path.join(root, "a", "CLAUDE.md"),
      path.join(root, "CLAUDE.md"),
    ]);
    expect(seen.at(-1)).toBe(path.join(root, ".claude", "CLAUDE.md"));
  });
});

describe("claudeResolves (spec 41 §4.4, §4.10)", () => {
  it("a body file declared ./rule.md or /agent.md names the file listed as rule.md / agent.md", async () => {
    const { claudeResolves } = await import("../src/emitters/claude-code.js");
    expect(claudeResolves(RuleIngredient.parse({ type: "rule", name: "api", file: "./rule.md" }), "rule.md")).toBe(true);
    expect(claudeResolves(AgentIngredient.parse({ type: "agent", name: "a", file: "/agent.md" }), "agent.md")).toBe(true);
    expect(claudeResolves(RuleIngredient.parse({ type: "rule", name: "api" }), "rule.md")).toBe(true);
    expect(claudeResolves(RuleIngredient.parse({ type: "rule", name: "api" }), "notes.md")).toBe(false);
  });
});

describe("Kiro resources check — spellings (spec 41 §4.5)", () => {
  it("`.kiro/steering/./api.md` is the planned api.md; an entry that climbs out of the workspace is not checked", async () => {
    const extraIngredients = [
      {
        meta: { type: "agent", name: "spelled", resources: ["file://.kiro/steering/./api.md", "file://.kiro/steering/../../../outside.md"] },
        files: { "agent.md": "Plain.\n" },
      },
    ];
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true }, extraIngredients }));
    // A file where the climbing entry points (outside the workspace): it must not be reported as present.
    const { promises: fsp } = await import("node:fs");
    const pathMod = await import("node:path");
    await fsp.writeFile(pathMod.join(s.root, "outside.md"), "x\n");
    const p = await plan(await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME }));
    const named = [...p.kiroResources!.unplanned, ...p.kiroResources!.present].filter((e) => e.agent === "spelled");
    expect(named).toEqual([]);
  });
});
