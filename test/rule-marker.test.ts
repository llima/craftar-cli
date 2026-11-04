import { describe, expect, it } from "vitest";
import { RULE_MARKER_LINE, ruleMarker } from "../src/emitters/agents-md.js";
import { agentsBound } from "../src/importers/drift-promote.js";

// E9.10: the AGENTS.md rule marker has one spelling, written by the emitter and read back by drift promote.

describe("the AGENTS.md rule marker", () => {
  it("is written in one form, which the one pattern reads back with the rule's name", () => {
    expect(ruleMarker("workflow")).toBe("<!-- rule: workflow -->");
    expect(RULE_MARKER_LINE.exec(ruleMarker("a-b.c"))?.[1]).toBe("a-b.c");
    expect(RULE_MARKER_LINE.test(`  ${ruleMarker("x")}`)).toBe(false);
  });
  it("is what agentsBound finds a rule's span by", () => {
    const p0 = ["# AGENTS.md", "", ruleMarker("a"), "old a", "", ruleMarker("b"), "b", ""].join("\n");
    const p1 = ["# AGENTS.md", "", ruleMarker("a"), "new a", "", ruleMarker("b"), "b", ""].join("\n");
    expect(agentsBound(p0, p1, "a")).toBe(true);
    expect(agentsBound(p0, p1.replace("\nb\n", "\nB\n"), "a")).toBe(false);
  });
});
