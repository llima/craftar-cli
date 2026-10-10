import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { renderImportReport } from "../src/core/import-report.js";
import type { ImportReport } from "../src/importers/claude-code.js";
import type { KiroReport } from "../src/importers/kiro-report.js";

// Spec 29 §4.2 — the report's text: import's own lists and the Kiro part, as paths and counts.

const base = (over: Partial<ImportReport> = {}): ImportReport => ({
  created: ["craftar.forge.yaml", "rule/workflow"],
  reused: ["rule/commit", "rule/plain", "rule/guess", "rule/parts"],
  variants: [{ name: "rule/review--acme", reason: "differs from rule/review already in the Forge" }],
  rejected: [],
  recipes: ["base"],
  profile: "acme",
  warnings: [],
  rendered: [{ name: "rule/commit", keys: ["scm.org"], sections: ["extra"] }],
  inferred: [{ name: "rule/guess", values: { org: "SECRET-LOOKING-VALUE" } }],
  params: [],
  sectioned: [{ name: "rule/parts", sections: ["who", "where"] }],
  sections: [],
  recipeSplits: [],
  profileWrite: { path: "profiles/acme/profile.yaml", action: "created", fields: [] },
  manifestWrite: "created",
  configWrite: null,
  configForgeKept: null,
  ...over,
});
const KIRO: KiroReport = {
  kind: "computed",
  collisions: [
    { path: ".kiro/steering/commands/open-pr.md", from: "command/open-pr", workspaceLines: 1, generatedLines: 9, note: "" },
    { path: ".kiro/steering/workflow.md", from: "rule/workflow", workspaceLines: 11, generatedLines: 9, note: "steering bigger than the rule" },
  ],
  unsourced: [".kiro/agents/ghost.json", ".kiro/steering/commands/legacy-deploy.md"],
};
const render = (report: ImportReport) =>
  renderImportReport({ workspace: "/work/acme-portal", forge: "/work/forge", report, now: new Date("2026-10-09T14:03:22.987Z"), version: "9.9.9" });
/** The text after the closing `---` of the frontmatter. */
const body = (text: string) => text.slice(text.indexOf("\n---\n", 4) + 5);

describe("renderImportReport", () => {
  it("the frontmatter parses back to the five keys, in order, the date without milliseconds", () => {
    const text = render(base({ kiro: KIRO }));
    expect(text.startsWith("---\n")).toBe(true);
    const fm = YAML.parse(text.slice(4, text.indexOf("\n---\n", 4)));
    expect(Object.keys(fm)).toEqual(["workspace", "forge", "profile", "date", "craftar"]);
    expect(fm).toEqual({ workspace: "/work/acme-portal", forge: "/work/forge", profile: "acme", date: "2026-10-09T14:03:22Z", craftar: "9.9.9" });
  });

  it("a path holding ': ' and '#' still parses back to itself", () => {
    const text = renderImportReport({ workspace: "C:\\work\\a: b #c", forge: "/f", report: base(), now: new Date("2026-10-09T14:03:22Z"), version: "9.9.9" });
    expect(YAML.parse(text.slice(4, text.indexOf("\n---\n", 4))).workspace).toBe("C:\\work\\a: b #c");
  });

  it("the body, byte for byte: every section with its count, the table sorted as given, a blank line before each heading", () => {
    expect(body(render(base({ kiro: KIRO, warnings: ["one warning"] })))).toBe(
      [
        "",
        "# Import report — acme",
        "",
        "## Created (2)",
        "- craftar.forge.yaml",
        "- rule/workflow",
        "",
        "## Reused (4)",
        "- rule/commit — rendered: scm.org; sections extra",
        "- rule/plain",
        "- rule/guess — inferred: org",
        "- rule/parts — sections: who, where",
        "",
        "## Variants (1)",
        "- rule/review--acme — differs from rule/review already in the Forge",
        "",
        "## Rejected (0)",
        "",
        "## Kiro collisions (2)",
        "",
        "| File | From | Workspace lines | Generated lines | Note |",
        "|---|---|---|---|---|",
        "| .kiro/steering/commands/open-pr.md | command/open-pr | 1 | 9 | |",
        "| .kiro/steering/workflow.md | rule/workflow | 11 | 9 | steering bigger than the rule |",
        "",
        "## Unsourced Kiro files (2)",
        "- .kiro/agents/ghost.json",
        "- .kiro/steering/commands/legacy-deploy.md",
        "",
        "## Warnings (1)",
        "- one warning",
        "",
      ].join("\n"),
    );
  });

  it("an inferred value never reaches the report — its key does", () => {
    const text = render(base({ kiro: KIRO }));
    expect(text).not.toContain("SECRET-LOOKING-VALUE");
    expect(text).toContain("- rule/guess — inferred: org");
  });

  it("no .kiro/ (and no kiro key at all): the single line, and no Unsourced section", () => {
    for (const report of [base({ kiro: { kind: "none" } }), base()]) {
      const text = body(render(report));
      expect(text).toContain("\n## Kiro collisions\nno .kiro/ in this workspace\n\n## Warnings (0)\n");
      expect(text).not.toContain("Unsourced");
    }
  });

  it("not computed: both Kiro sections say so, with the message", () => {
    const text = body(render(base({ kiro: { kind: "not-computed", message: "boom" } })));
    expect(text).toContain("\n## Kiro collisions\nnot computed: boom\n\n## Unsourced Kiro files\nnot computed: boom\n");
  });

  it("computed with nothing: the two counts are 0 and there is no table", () => {
    const text = body(render(base({ kiro: { kind: "computed", collisions: [], unsourced: [] } })));
    expect(text).toContain("\n## Kiro collisions (0)\n\n## Unsourced Kiro files (0)\n\n## Warnings (0)\n");
    expect(text).not.toContain("| File |");
  });

  it("a pipe in a cell is escaped and a newline in an entry becomes a space; LF only, one trailing newline, no BOM", () => {
    const text = render(
      base({
        kiro: { kind: "computed", collisions: [{ path: ".kiro/steering/a|b.md", from: "rule/a", workspaceLines: 1, generatedLines: 1, note: "" }], unsourced: [] },
        warnings: ["two\nlines"],
      }),
    );
    expect(text).toContain("| .kiro/steering/a\\|b.md | rule/a | 1 | 1 | |");
    expect(text).toContain("- two lines\n");
    expect(text.includes("\r")).toBe(false);
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text.endsWith("\n") && !text.endsWith("\n\n")).toBe(true);
  });
});
