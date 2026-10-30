import { describe, expect, it } from "vitest";
import { buildRuleLookup, ruleRefState, ruleReference, type RuleLookup } from "../src/emitters/shared.js";
import type { ResolvedIngredient } from "../src/core/resolve.js";
import type { Ingredient } from "../src/schema/index.js";

/**
 * Spec 44 §4.3, §15 item 11: ruleReference returns { state, text }.
 */

/** Helper to create a minimal ResolvedIngredient for a rule. */
function ruleIng(name: string, targets: "*" | string[] = "*"): ResolvedIngredient {
  return {
    ref: `rule/${name}`,
    meta: { type: "rule", name, targets, inclusion: "always" } as Ingredient,
    files: { "rule.md": Buffer.from("# " + name) },
    via: [],
  };
}

/** Helper to create a minimal ResolvedIngredient for a steering. */
function steeringIng(name: string, targets: "*" | string[] = ["kiro"]): ResolvedIngredient {
  return {
    ref: `steering/${name}`,
    meta: { type: "steering", name, targets } as Ingredient,
    files: { "steering.md": Buffer.from("# " + name) },
    via: [],
  };
}

describe("ruleReference (spec 44 §4.3)", () => {
  it("returns { state, text } for each state", () => {
    // Build ingredients for each state scenario:
    // State A: rule targets: claude-code, workspace: [claude-code], mode: agents-md
    // State B: rule targets: kiro, workspace: [kiro], mode: agents-md  OR steering
    // State C: rule targets: agents-md, workspace: [agents-md], mode: agents-md
    // State K1: rule targets: kiro, workspace: [kiro], mode: kiro
    // State K2: rule targets: claude-code, workspace: [claude-code, kiro], mode: kiro
    // State K3: rule targets: agents-md, workspace: [agents-md, kiro], mode: kiro
    // State D: rule targets: [], workspace: [claude-code], mode: agents-md

    const ruleA = ruleIng("a", ["claude-code"]);
    const ruleB = ruleIng("b", ["kiro"]);
    const ruleC = ruleIng("c", ["agents-md"]);
    const ruleK1 = ruleIng("k1", ["kiro"]);
    const ruleK2 = ruleIng("k2", ["claude-code"]);
    const ruleK3 = ruleIng("k3", ["agents-md"]);
    const ruleD = ruleIng("d", []);

    // Build lookup with all rules
    const lookup = buildRuleLookup([ruleA, ruleB, ruleC, ruleK1, ruleK2, ruleK3, ruleD]);

    // Test state A: agents-md mode, workspace has claude-code, rule targets: claude-code
    const refA = ruleReference("a", lookup, ["claude-code"], "agents-md");
    expect(refA.state).toBe("A");
    expect(refA.text).toBe(".claude/rules/a.md");

    // Test state B: agents-md mode, workspace has kiro, rule targets: kiro
    const refB = ruleReference("b", lookup, ["kiro"], "agents-md");
    expect(refB.state).toBe("B");
    expect(refB.text).toBe(".kiro/steering/b.md");

    // Test state C: agents-md mode, workspace has agents-md, rule targets: agents-md
    const refC = ruleReference("c", lookup, ["agents-md"], "agents-md");
    expect(refC.state).toBe("C");
    expect(refC.text).toBe("AGENTS.md (rule: c)");

    // Test state K1: kiro mode, workspace has kiro, rule targets: kiro
    const refK1 = ruleReference("k1", lookup, ["kiro"], "kiro");
    expect(refK1.state).toBe("K1");
    expect(refK1.text).toBe(".kiro/steering/k1.md");

    // Test state K2: kiro mode, workspace has claude-code and kiro, rule targets: claude-code
    const refK2 = ruleReference("k2", lookup, ["claude-code", "kiro"], "kiro");
    expect(refK2.state).toBe("K2");
    expect(refK2.text).toBe(".claude/rules/k2.md");

    // Test state K3: kiro mode, workspace has agents-md and kiro, rule targets: agents-md
    const refK3 = ruleReference("k3", lookup, ["agents-md", "kiro"], "kiro");
    expect(refK3.state).toBe("K3");
    expect(refK3.text).toBe("AGENTS.md (rule: k3)");

    // Test state D: agents-md mode, workspace has claude-code, rule targets: []
    const refD = ruleReference("d", lookup, ["claude-code"], "agents-md");
    expect(refD.state).toBe("D");
    expect(refD.text).toBe("d (rule not in this workspace)");
    expect(refD.reworded).toBeDefined();
    expect(refD.reworded!.ref).toBe(".claude/rules/d.md");
    expect(refD.reworded!.kind).toBe("rule/d reaches no target here");
  });
});

describe("C correction (spec 44 §4.3, §15 item 11)", () => {
  it("a rule targets: [agents-md] in workspace [claude-code, kiro] is D, not C", () => {
    // The C correction: the bug was that a rule aimed at agents-md would get state C
    // even when agents-md is NOT among the workspace targets.
    // After the fix: state is D because agents-md is not a workspace target.
    const ruleAgentsMdOnly = ruleIng("x", ["agents-md"]);
    const lookup = buildRuleLookup([ruleAgentsMdOnly]);

    // Workspace has [claude-code, kiro] — NOT agents-md
    const state = ruleRefState("x", lookup, ["claude-code", "kiro"], "agents-md");
    expect(state).toBe("D");
  });

  it("a rule targets: [agents-md] in workspace [agents-md] is C", () => {
    // Control: when agents-md IS a workspace target, state C is correct
    const ruleAgentsMdOnly = ruleIng("x", ["agents-md"]);
    const lookup = buildRuleLookup([ruleAgentsMdOnly]);

    // Workspace has [agents-md]
    const state = ruleRefState("x", lookup, ["agents-md"], "agents-md");
    expect(state).toBe("C");
  });

  it("ruleReference returns D for agents-md-only rule in workspace without agents-md", () => {
    const ruleAgentsMdOnly = ruleIng("x", ["agents-md"]);
    const lookup = buildRuleLookup([ruleAgentsMdOnly]);

    const ref = ruleReference("x", lookup, ["claude-code", "kiro"], "agents-md");
    expect(ref.state).toBe("D");
    expect(ref.text).toBe("x (rule not in this workspace)");
    expect(ref.reworded).toBeDefined();
    expect(ref.reworded!.kind).toBe("rule/x reaches no target here");
  });
});
