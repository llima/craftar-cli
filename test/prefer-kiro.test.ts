import { describe, expect, it } from "vitest";
import { parsePreferKiro, preferKiro, ruleTextOf, steeringBody, uncertainForm } from "../src/importers/prefer-kiro.js";

// Spec 29 §4.3 — a rule read back from its Kiro steering mirror: the source text and its proof.

const DEFAULT_BANNER = "<!-- GENERATED from .claude/rules/workflow.md by craftar -- do not edit. -->";
const FM = "---\ninclusion: always\n---\n\n";
const BODY =
  "# Workflow\n\nSee .kiro/steering/style.md, [s](.kiro/steering/style.md), .kiro/steering/team.md,\n" +
  ".kiro/steering/commands/open-pr.md, .kiro/steering/zzz.md, the dir .kiro/steering/ and .kiro/steering/*.md.\n" +
  "A line kept by hand.\n";
const RULE_TEXT =
  "# Workflow\n\nSee .claude/rules/style.md, [s](.claude/rules/style.md), .kiro/steering/team.md,\n" +
  ".kiro/steering/commands/open-pr.md, .claude/rules/zzz.md, the dir .claude/rules/ and .claude/rules/*.md.\n" +
  "A line kept by hand.\n";
const rules = new Set(["workflow", "style"]);
const handSteering = new Set(["team"]);
const input = (steering: string, banner: string | null = null) => ({ name: "workflow", steering, rules, handSteering, banner });

describe("parsePreferKiro", () => {
  it("splits on commas and trims, keeping the order", () => {
    expect(parsePreferKiro("workflow, branch-and-pr")).toEqual(["workflow", "branch-and-pr"]);
  });
  it.each(["", "workflow,", ",workflow", "a,,b", " "])("PK5: an empty name in %j", (v) => {
    expect(() => parsePreferKiro(v)).toThrow("--prefer-kiro: an empty rule name");
  });
  it("PK5: the same name twice", () => {
    expect(() => parsePreferKiro("workflow,style,workflow")).toThrow("--prefer-kiro: workflow is named twice");
  });
});

describe("steeringBody", () => {
  it("drops the frontmatter, the default banner and the one blank line after it", () => {
    expect(steeringBody(FM + DEFAULT_BANNER + "\n\n" + BODY, "workflow", null)).toBe(BODY);
  });
  it("drops the line an existing profile's kiro.banner renders for this rule", () => {
    const banner = "<!-- acme: built from {{source}} -->";
    expect(steeringBody(FM + "<!-- acme: built from .claude/rules/workflow.md -->\n\n" + BODY, "workflow", banner)).toBe(BODY);
    // Another rule's rendering of it is not this rule's banner: the line stays.
    expect(steeringBody(FM + "<!-- acme: built from .claude/rules/style.md -->\n\n" + BODY, "workflow", banner)).toBe("<!-- acme: built from .claude/rules/style.md -->\n\n" + BODY);
  });
  it("leaves a body with no banner, and a file with no frontmatter, as they are", () => {
    expect(steeringBody(FM + BODY, "workflow", null)).toBe(BODY);
    expect(steeringBody(BODY, "workflow", null)).toBe(BODY);
  });
  it("drops only an opening banner, and only one blank line after it", () => {
    const lower = "Intro\n\n" + DEFAULT_BANNER + "\n";
    expect(steeringBody(FM + lower, "workflow", null)).toBe(lower);
    expect(steeringBody(FM + DEFAULT_BANNER + "\n\n\nTwo blank lines above\n", "workflow", null)).toBe("\nTwo blank lines above\n");
  });
});

describe("ruleTextOf", () => {
  it("turns .kiro/steering/ back into .claude/rules/, a hand-written steering reference and commands/ aside", () => {
    expect(ruleTextOf(BODY, rules, handSteering)).toBe(RULE_TEXT);
  });
  it("a steering name that is also a rule is a rule; a longer name is not the hand-written one", () => {
    expect(ruleTextOf(".kiro/steering/team.md", new Set(["team"]), new Set(["team"]))).toBe(".claude/rules/team.md");
    expect(ruleTextOf(".kiro/steering/team.md.bak and .kiro/steering/team-notes.md", rules, handSteering)).toBe(".claude/rules/team.md.bak and .claude/rules/team-notes.md");
  });
});

describe("uncertainForm (PK3)", () => {
  it.each([
    ["AGENTS.md (rule: style)", "AGENTS.md (rule: style)"],
    ["see [the style](AGENTS.md) too", "](AGENTS.md)"],
    ["style (rule not in this workspace)", "rule not in this workspace)"],
    ["the style (style, rule not in this workspace)", "rule not in this workspace)"],
  ])("finds %j", (line, form) => {
    expect(uncertainForm("first\n" + line + "\n")).toEqual({ line: 2, form });
  });
  it("a plain mention of AGENTS.md is not one", () => {
    expect(uncertainForm("Read AGENTS.md first.\n")).toBeNull();
  });
});

describe("preferKiro", () => {
  it("returns the rule text, proved to render back to the steering body", () => {
    expect(preferKiro(input(FM + DEFAULT_BANNER + "\n\n" + BODY))).toEqual({ text: RULE_TEXT, body: BODY });
  });
  it("a mirror the emitter generated gives the rule's own text back", () => {
    const generated = "# Workflow\n\nSee .kiro/steering/style.md.\n";
    expect(preferKiro(input(FM + DEFAULT_BANNER + "\n\n" + generated)).text).toBe("# Workflow\n\nSee .claude/rules/style.md.\n");
  });
  it("PK3 names the line of the steering file and the form", () => {
    const steering = FM + DEFAULT_BANNER + "\n\n# Workflow\n\nSee AGENTS.md (rule: style).\n";
    expect(() => preferKiro(input(steering))).toThrow(
      'import: --prefer-kiro workflow: .kiro/steering/workflow.md line 9 holds "AGENTS.md (rule: style)", which Kiro writes for a rule it does not have — that form has no certain source; edit the steering file or drop workflow from --prefer-kiro',
    );
  });
  it("PK4: a body that names .claude/rules/ does not come back, and the first such line is named", () => {
    const steering = FM + DEFAULT_BANNER + "\n\n# Workflow\n\nfine: .kiro/steering/style.md\nnot fine: .claude/rules/style.md\n";
    expect(() => preferKiro(input(steering))).toThrow(
      "import: --prefer-kiro workflow: .kiro/steering/workflow.md line 10 would not come back from the rule built from it — it names .claude/rules/ where sync writes .kiro/steering/; edit the steering file or drop workflow from --prefer-kiro",
    );
  });
});
