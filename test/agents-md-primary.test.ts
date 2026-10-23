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
