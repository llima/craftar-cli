import { afterEach, describe, expect, it } from "vitest";
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