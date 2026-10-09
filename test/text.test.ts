import { describe, it, expect } from "vitest";
import { climbsOut, hashNormalized, legacyHash, toCrlf, toLf, stripBom, detectEol } from "../src/core/text.js";
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
  it("tells two Latin-1 buffers apart", () => {
    expect(hashNormalized(Buffer.from("caf\xe9\n", "latin1"))).not.toBe(hashNormalized(Buffer.from("caf\xe8\n", "latin1")));
  });
  it("hashes valid UTF-8 as before (guard)", () => {
    // A valid UTF-8 buffer with BOM and CRLF should hash identically to the normalized string.
    expect(hashNormalized(Buffer.from("﻿a\r\nb"))).toBe(hashNormalized("a\nb"));
  });
  it("legacyHash is the pre-0.17.4 hash: blind to the invalid byte", () => {
    expect(legacyHash(Buffer.from("caf\xe9\n", "latin1"))).toBe(legacyHash(Buffer.from("caf\xe8\n", "latin1")));
    expect(legacyHash(Buffer.from("caf\xe9\n", "latin1"))).toBe(hashNormalized("caf\ufffd\n"));
  });
  it("a non-UTF-8 buffer hashes the same in CRLF, CR and LF, and with a UTF-8 BOM", () => {
    const L = Buffer.from("a\xe9\nb\n", "latin1");
    expect(hashNormalized(Buffer.from("a\xe9\r\nb\r\n", "latin1"))).toBe(hashNormalized(L));
    expect(hashNormalized(Buffer.from("a\xe9\rb\r", "latin1"))).toBe(hashNormalized(L));
    expect(hashNormalized(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), L]))).toBe(hashNormalized(L));
    expect(hashNormalized(L)).not.toBe(hashNormalized(Buffer.from("a\xe8\nb\n", "latin1")));
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
    const known = new Set(["frontend-angular", "backend-api", "repo-discovery"]);
    expect(agentResources("frontend-reviewer", "uses .claude/rules/frontend-angular.md", known, ["frontend-angular", "backend-api"])).toEqual([
      "file://.kiro/steering/frontend-angular.md",
      "file://.kiro/steering/repo-discovery.md",
    ]);
    expect(agentResources("docs-author", "mentions .claude/rules/backend-api.md", known, ["frontend-angular", "backend-api"])).toEqual(["file://.kiro/steering/**/*.md"]);
  });
});

describe("climbsOut (0.17.3)", () => {
  it("is true only for a path that resolves above the folder it is joined under", () => {
    for (const p of ["..", "../x", "a/../../x", "./../x", "..\\x", "a\\..\\..\\x", "/../x", "//../x", "/..", "\\..\\x", "//srv/share/../../../x", "/a/../../x"]) expect(climbsOut(p), p).toBe(true);
    for (const p of ["x", "./x", "/x", "//x", "/a/../x", "a/../x", "a/b/../../x", "..x", "a/..x", "", "/"]) expect(climbsOut(p), p).toBe(false);
  });
});
