import { describe, it, expect } from "vitest";
import { hashNormalized, toCrlf, toLf, stripBom, detectEol } from "../src/core/text.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { referencedRules, rewrite, agentResources } from "../src/emitters/kiro.js";

describe("normalized hashing (the CRLF lesson)", () => {
  it("is identical for LF, CRLF and BOM variants of the same text", () => {
    const lf = "# a\n\nb\n";
    expect(hashNormalized(lf)).toBe(hashNormalized(toCrlf(lf)));
    expect(hashNormalized(lf)).toBe(hashNormalized("﻿" + toCrlf(lf)));
    expect(hashNormalized(lf)).not.toBe(hashNormalized(lf + "x"));
  });
  it("toCrlf never doubles CR", () => {
    expect(toCrlf("a\r\nb\nc")).toBe("a\r\nb\r\nc");
    expect(toLf("a\r\nb\rc")).toBe("a\nb\nc");
    expect(stripBom("﻿x")).toBe("x");
    expect(detectEol("a\r\nb\r\n")).toBe("crlf");
  });
});

describe("frontmatter", () => {
  it("round-trips Claude Code loose frontmatter byte-for-byte", () => {
    const doc = "---\nname: x\ndescription: Reviews a, b — c\ntools: Read, Grep, Glob, Bash\n---\n\n# Body\n";
    const { data, body, raw } = parseFrontmatter<Record<string, string>>(doc, { loose: true });
    expect(data.tools).toBe("Read, Grep, Glob, Bash");
    expect(serializeFrontmatter({}, body, { raw })).toBe(doc);
  });
  it("keeps [project-name] literal instead of parsing it as YAML", () => {
    const { data } = parseFrontmatter<Record<string, string>>("---\nargument-hint: [project-name]\n---\nx", { loose: true });
    expect(data["argument-hint"]).toBe("[project-name]");
  });
});

describe("kiro emitter helpers", () => {
  it("rewrites rule paths and extracts references in order", () => {
    const t = "see .claude/rules/frontend-angular.md and .claude/rules/repo-discovery.md and .claude/rules/nope.md";
    expect(rewrite(t)).toContain(".kiro/steering/frontend-angular.md");
    expect(referencedRules(t, new Set(["frontend-angular", "repo-discovery"]))).toEqual(["frontend-angular", "repo-discovery"]);
  });
  it("binds stack reviewers to their rule and gives generic agents the whole tree", () => {
    const known = new Set(["frontend-angular", "backend-oaf", "repo-discovery"]);
    expect(agentResources("frontend-reviewer", "uses .claude/rules/frontend-angular.md", known, ["frontend-angular", "backend-oaf"])).toEqual([
      "file://.kiro/steering/frontend-angular.md",
      "file://.kiro/steering/repo-discovery.md",
    ]);
    expect(agentResources("docs-author", "mentions .claude/rules/backend-oaf.md", known, ["frontend-angular", "backend-oaf"])).toEqual(["file://.kiro/steering/**/*.md"]);
  });
});
