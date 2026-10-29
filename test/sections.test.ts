import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { canonicalValue, checkDeclaredOnce, expandSections, firstMarkerLine, inferSections, markerLine, parseSections, readsTargetSections, SectionMarkerError } from "../src/core/sections.js";
import { readsPrimary } from "../src/core/resolve.js";
import { rendersServers } from "../src/core/mcp-server.js";
import { readsIntegrations } from "../src/core/integrations.js";

const F = "ingredients/rules/review-posture/rule.md";
const OPEN = (n: string) => `<!-- craftar:section ${n} -->`;
const CLOSE = "<!-- /craftar:section -->";

/** Spec 11 §5.1's body. */
const TABLE = ["| Repo | Reviewer |", "|---|---|", "| `acme-api` | backend-reviewer |", "| `acme-web` | frontend-reviewer |"];
const BODY = ["# Review posture", "", "Dispatch reviewers after every commit.", "", OPEN("flavors"), ...TABLE, CLOSE, "", "Never edit what a reviewer reads.", ""].join("\n");
const HEAD = "# Review posture\n\nDispatch reviewers after every commit.\n";
const TAIL = "Never edit what a reviewer reads.\n";
const GLOBEX = ["| Repo | Reviewer |", "|---|---|", "| `globex-api` | backend-reviewer |", "| `globex-web` | frontend-reviewer |", "| `globex-desktop` | desktop-reviewer |"];

const lines = (...xs: string[]) => xs.map((x) => x + "\n").join("");

function parseError(text: string): SectionMarkerError {
  try {
    parseSections(text, F, "rule/review-posture");
  } catch (e) {
    if (e instanceof SectionMarkerError) return e;
    throw e;
  }
  throw new Error("expected a parse error");
}

describe("grammar (spec 11 §6.1)", () => {
  it("a file with no marker is one outside segment", () => {
    const p = parseSections("# x\n\nbody\n", F);
    expect(p.segments).toEqual([{ text: "# x\n\nbody\n" }]);
    expect(p.sections).toEqual([]);
  });

  it("parses the §5.1 body: default verbatim, opener line recorded", () => {
    const p = parseSections(BODY, F);
    expect(p.sections).toEqual([{ name: "flavors", default: TABLE.map((l) => l + "\n").join(""), line: 5 }]);
    expect(p.segments).toHaveLength(3);
  });

  it.each([
    ["an open marker never closed", lines("# x", OPEN("a"), "x"), 2, "section a is never closed"],
    ["a close with no open section", lines("# x", CLOSE), 2, "a closing marker with no open section"],
    ["an open inside an open section", lines(OPEN("a"), OPEN("b"), "x", CLOSE), 2, "section b opens inside section a (line 1)"],
    ["a name declared twice in one file", lines(OPEN("a"), CLOSE, OPEN("a"), CLOSE), 3, `section a is declared twice in rule/review-posture (also ${F}:1)`],
    ["a near miss without a name", lines("x", "<!-- craftar:section -->"), 2, "malformed section marker"],
    ["a near miss without spaces", lines("<!--craftar:section a-->"), 1, "malformed section marker"],
    ["a near miss with a two-word name", lines("<!-- craftar:section Flavors Table -->"), 1, "malformed section marker"],
    ["a near miss closer with two spaces", lines(OPEN("a"), "<!--  /craftar:section -->"), 2, "malformed section marker"],
  ])("refuses %s, naming file and line", (_what, text, line, problem) => {
    const e = parseError(text);
    expect(e.file).toBe(F);
    expect(e.line).toBe(line);
    expect(e.problem).toContain(problem);
    expect(e.message).toBe(`section markers in ${F}:${line}: ${e.problem}`);
  });

  it("the malformed message states both expected forms", () => {
    expect(parseError("<!-- craftar:section -->\n").problem).toBe('malformed section marker — expected "<!-- craftar:section <name> -->" or "<!-- /craftar:section -->"');
  });

  it("an indented marker and one inside a line of prose are literal", () => {
    for (const text of [lines("  " + OPEN("a"), "x"), lines("\t" + CLOSE), lines(`see ${OPEN("a")} here`)]) {
      const p = parseSections(text, F);
      expect(p.sections).toEqual([]);
      expect(expandSections(p, {})).toBe(text);
    }
  });

  it("tolerates trailing spaces and tabs after a marker", () => {
    const p = parseSections(lines(OPEN("a") + "  \t", "x", CLOSE + " "), F);
    expect(p.sections).toEqual([{ name: "a", default: "x\n", line: 1 }]);
  });

  it("refuses a name declared in two files of one ingredient (Ruling 11)", () => {
    const a = parseSections(lines(OPEN("notes"), CLOSE), "ingredients/skills/pdf/SKILL.md");
    const b = parseSections(lines("x", OPEN("notes"), CLOSE), "ingredients/skills/pdf/reference.md");
    expect(() => checkDeclaredOnce("skill/pdf", [a, b])).toThrow(
      "section markers in ingredients/skills/pdf/reference.md:2: section notes is declared twice in skill/pdf (also ingredients/skills/pdf/SKILL.md:1)",
    );
    expect(() => checkDeclaredOnce("skill/pdf", [a])).not.toThrow();
  });

  it("parses a CRLF file and a BOM file exactly like the LF one", () => {
    const lf = parseSections(BODY, F);
    expect(parseSections(BODY.replace(/\n/g, "\r\n"), F)).toEqual(lf);
    expect(parseSections("﻿" + BODY, F)).toEqual(lf);
    expect(parseError(lines("x", OPEN("a")).replace(/\n/g, "\r\n")).line).toBe(2);
  });

  it("markerLine tells an opener, a closer, a near miss and text apart", () => {
    expect(markerLine(OPEN("flavors"))).toEqual({ kind: "open", name: "flavors" });
    expect(markerLine(CLOSE + "\n")).toEqual({ kind: "close" });
    expect(markerLine("<!-- / craftar:section -->")).toEqual({ kind: "near" });
    expect(markerLine("<!-- craftar:section -bad -->")).toEqual({ kind: "near" });
    expect(markerLine("<!-- other comment -->")).toBeNull();
    expect(markerLine(" " + OPEN("a"))).toBeNull();
  });
});

describe("expansion and byte semantics (spec 11 §6.2)", () => {
  const p = parseSections(BODY, F);
  const between = (out: string) => {
    expect(out.startsWith(HEAD)).toBe(true);
    expect(out.endsWith(TAIL)).toBe(true);
    return out.slice(HEAD.length, out.length - TAIL.length);
  };

  it("X1: no values — the file as it was before the markers", () => {
    expect(between(expandSections(p, {}))).toBe("\n" + TABLE.map((l) => l + "\n").join("") + "\n");
    expect(expandSections(p, undefined)).toBe(BODY.replace(OPEN("flavors") + "\n", "").replace(CLOSE + "\n", ""));
  });

  it("X2: a value with its newline", () => {
    expect(between(expandSections(p, { flavors: "| g |\n" }))).toBe("\n| g |\n\n");
  });

  it("X3: a value without its final newline gives X2's bytes", () => {
    expect(expandSections(p, { flavors: "| g |" })).toBe(expandSections(p, { flavors: "| g |\n" }));
  });

  it("X4: an emptied section leaves the blank lines around it", () => {
    expect(between(expandSections(p, { flavors: "" }))).toBe("\n\n");
  });

  it.each([
    ["|", "flavors: |\n  a\n  b\n", "a\nb\n"],
    ["|-", "flavors: |-\n  a\n  b\n", "a\nb\n"],
    ["plain", "flavors: one line\n", "one line\n"],
    ["|+", "flavors: |+\n  a\n\n", "a\n\n"],
    ['""', 'flavors: ""\n', ""],
    ["\\r\\n", 'flavors: "a\\r\\nb"\n', "a\nb\n"],
  ])("the YAML table: %s inserts the canonical value", (_form, yaml, inserted) => {
    const v = (YAML.parse(yaml) as { flavors: string }).flavors;
    expect(canonicalValue(v)).toBe(inserted);
    const out = expandSections(parseSections(lines("A", OPEN("flavors"), "x", CLOSE, "B"), F), { flavors: v });
    expect(out).toBe("A\n" + inserted + "B\n");
  });

  it("keeps leading spaces, tabs and trailing spaces of a value", () => {
    expect(canonicalValue("  a \t\n\tb")).toBe("  a \t\n\tb\n");
  });

  it("a closer on the last line without a newline produces nothing", () => {
    const q = parseSections("A\n" + OPEN("a") + "\nx\n" + CLOSE, F);
    expect(expandSections(q, {})).toBe("A\nx\n");
    expect(expandSections(q, { a: "z" })).toBe("A\nz\n");
  });

  it("adjacent markers declare an empty default", () => {
    const q = parseSections(lines("A", OPEN("a"), CLOSE, "B"), F);
    expect(q.sections[0].default).toBe("");
    expect(expandSections(q, {})).toBe("A\nB\n");
    expect(expandSections(q, { a: "q" })).toBe("A\nq\nB\n");
  });

  it("a value named for a section the file does not declare is ignored by expansion", () => {
    expect(expandSections(p, { other: "x" })).toBe(expandSections(p, {}));
  });

  it("firstMarkerLine finds a marker or a near miss at column 0, and nothing else", () => {
    expect(firstMarkerLine("a\nb\n" + CLOSE + "\n")).toBe(3);
    expect(firstMarkerLine("a\n<!--craftar:section x-->\n")).toBe(2);
    expect(firstMarkerLine("a\n  " + CLOSE + "\n")).toBeNull();
  });
});

describe("the section matcher (spec 11 §6.8)", () => {
  const p = parseSections(BODY, F);
  const src = (between: string) => HEAD + between + TAIL;
  const T = (xs: string[]) => xs.map((l) => l + "\n").join("");

  it("E1: a different table is the section's value", () => {
    expect(inferSections(p, src("\n" + T(GLOBEX) + "\n"), {}, {})).toEqual({ values: { flavors: T(GLOBEX) } });
  });

  it("E2: an emptied table infers the empty string", () => {
    expect(inferSections(p, src("\n\n"), {}, {})).toEqual({ values: { flavors: "" } });
  });

  it("E3: outside text changed is F11, naming the line", () => {
    const r = inferSections(p, src("\n" + T(GLOBEX) + "\n").replace("Dispatch", "Send"), {}, {});
    expect(r).toEqual({ fallback: "F11", reason: `the text outside the sections of ${F} differs (line 3)` });
  });

  const AB = parseSections(lines("A", OPEN("a"), "x", CLOSE, OPEN("b"), "y", CLOSE, "B"), F);
  it("E4: two adjacent open sections are ambiguous (F12)", () => {
    expect(inferSections(AB, lines("A", "q", "B"), {}, {})).toEqual({ fallback: "F12", reason: `section inference ambiguous in ${F}: a, b` });
  });

  it("E5: with b fixed by the workspace, a is inferred", () => {
    expect(inferSections(AB, lines("A", "q", "y", "B"), { b: "y" }, {})).toEqual({ values: { a: "q\n" } });
  });

  it("a workspace-fixed section that differs is F11, naming it", () => {
    expect(inferSections(AB, lines("A", "q", "z", "B"), { b: "y" }, {})).toEqual({
      fallback: "F11",
      reason: `section b of ${F} is set by the workspace and the source differs there`,
    });
  });

  const SEP = parseSections(lines("A", OPEN("a"), "x", CLOSE, "sep", OPEN("b"), "y", CLOSE, "B"), F);
  it("E6: a separator line occurring twice is ambiguous (F12)", () => {
    expect(inferSections(SEP, lines("A", "sep", "sep", "B"), {}, {})).toEqual({ fallback: "F12", reason: `section inference ambiguous in ${F}: a, b` });
  });

  it("E7: two sections separated by a fixed line", () => {
    expect(inferSections(SEP, lines("A", "q", "sep", "r", "B"), {}, {})).toEqual({ values: { a: "q\n", b: "r\n" } });
  });

  const LAST = parseSections("A\n" + OPEN("a") + "\nx\n" + CLOSE, F);
  it("E8: a closer on the last line without a newline", () => {
    expect(inferSections(LAST, "A\nz\n", {}, {})).toEqual({ values: { a: "z\n" } });
  });

  it("E9: the same, with a source that has no final newline, is F11", () => {
    const r = inferSections(LAST, "A\nz", {}, {});
    expect(r).toMatchObject({ fallback: "F11" });
    expect("reason" in r && r.reason).toMatch(/^the text outside the sections of .* differs \(line \d+\)$/);
  });

  it("E10: a value citing {{k}} the render map sets is F13", () => {
    const rows = [...GLOBEX.slice(0, 2), "| `{{deploy.api}}` | backend-reviewer |"];
    expect(inferSections(p, src("\n" + T(rows) + "\n"), {}, { "deploy.api": "globex-api" })).toEqual({
      fallback: "F13",
      reason: "section flavors would cite {{deploy.api}}, which this profile renders",
    });
    // Unset, the same citation is a value like any other (edge case 7).
    expect(inferSections(p, src("\n" + T(rows) + "\n"), {}, {})).toEqual({ values: { flavors: T(rows) } });
  });

  it("E11: an Angular pipe in a value is literal", () => {
    const rows = [...GLOBEX.slice(0, 2), "| {{ 'Save' | localize }} | x |"];
    expect(inferSections(p, src("\n" + T(rows) + "\n"), {}, { Save: "no" })).toEqual({ values: { flavors: T(rows) } });
  });

  it("a value holding a marker line is F13", () => {
    const r = inferSections(p, src("\n" + T(["| a |", "<!-- craftar:section x -->"]) + "\n"), {}, {});
    expect(r).toEqual({ fallback: "F13", reason: "section flavors would hold a section marker" });
  });

  it("outside text is rendered with the map before matching", () => {
    const q = parseSections(lines("Org {{scm.org}}", OPEN("a"), "x", CLOSE), F);
    expect(inferSections(q, lines("Org globex", "q"), {}, { "scm.org": "globex" })).toEqual({ values: { a: "q\n" } });
  });

  it("a CRLF or BOM source matches like the LF one", () => {
    const s = src("\n" + T(GLOBEX) + "\n");
    expect(inferSections(p, s.replace(/\n/g, "\r\n"), {}, {})).toEqual({ values: { flavors: T(GLOBEX) } });
    expect(inferSections(p, "﻿" + s, {}, {})).toEqual({ values: { flavors: T(GLOBEX) } });
  });
});

describe("schema gates (spec 41 Part B)", () => {
  it("readsTargetSections: false at schema 5, true at schema 6", () => {
    expect(readsTargetSections({ schema: 5 })).toBe(false);
    expect(readsTargetSections({ schema: 6 })).toBe(true);
  });

  it("readsPrimary, rendersServers, readsIntegrations are all true at schema 6 (they use >=)", () => {
    const m = { schema: 6 };
    expect(readsPrimary(m)).toBe(true);
    expect(rendersServers(m)).toBe(true);
    expect(readsIntegrations(m)).toBe(true);
  });
});

describe("targeted sections (spec 41 Part B §11.3)", () => {
  const O = (n: string, t: string) => `<!-- craftar:section ${n} targets=${t} -->`;
  const C = CLOSE;

  it("Case 1: targets=false and a targeted marker is near with the schema-6 problem", () => {
    const m = markerLine(O("x", "kiro"), { targets: false });
    expect(m).toEqual({ kind: "near", problem: "section x names targets, which a Forge reads only at schema: 6 — set schema: 6 in craftar.forge.yaml" });
  });

  it("Case 1: parseSections with targets=false throws the schema-6 problem", () => {
    const e = parseError(O("x", "kiro") + "\nY\n" + C + "\n");
    expect(e.line).toBe(1);
    expect(e.problem).toBe("section x names targets, which a Forge reads only at schema: 6 — set schema: 6 in craftar.forge.yaml");
  });

  it("Case 2: targets=true parses valid targets", () => {
    const m1 = markerLine(O("x", "kiro"), { targets: true });
    expect(m1).toEqual({ kind: "open", name: "x", targets: ["kiro"] });

    const m2 = markerLine(O("x", "claude-code,agents-md"), { targets: true });
    expect(m2).toEqual({ kind: "open", name: "x", targets: ["claude-code", "agents-md"] });
  });

  it("Case 3: targets=true refuses invalid targets, value never in message", () => {
    const problem = "section x: targets= takes one or more of claude-code, kiro, agents-md, comma-separated, each once";

    // Empty value
    expect(markerLine(O("x", ""), { targets: true })).toEqual({ kind: "near", problem });

    // Unknown target
    expect(markerLine(O("x", "cursor"), { targets: true })).toEqual({ kind: "near", problem });

    // Duplicate target
    expect(markerLine(O("x", "kiro,kiro"), { targets: true })).toEqual({ kind: "near", problem });

    // Trailing comma
    expect(markerLine(O("x", "kiro,"), { targets: true })).toEqual({ kind: "near", problem });

    // Wrong case
    expect(markerLine(O("x", "Kiro"), { targets: true })).toEqual({ kind: "near", problem });

    // Fake secret token - must not appear in message
    const fakeToken = "zz-secret-zz";
    const result = markerLine(O("x", fakeToken), { targets: true });
    expect(result?.kind).toBe("near");
    expect((result as { problem?: string }).problem).toBe(problem);
    expect((result as { problem?: string }).problem).not.toContain(fakeToken);
  });

  it("Case 4: plain opener with targets=true has no targets key", () => {
    const m = markerLine(OPEN("x"), { targets: true });
    expect(m).toEqual({ kind: "open", name: "x" });
    expect(m).not.toHaveProperty("targets");
  });

  it("Case 5: projectSections removes sections not for the owner (blank-line rule)", () => {
    // O(n,t) = targeted opener, C = closer
    const Ot = (n: string, t: string) => `<!-- craftar:section ${n} targets=${t} -->`;

    // first: "O\nX\nC\n\nbody\n" → "\nbody\n"
    const first = parseSections(Ot("x", "claude-code") + "\nX\n" + C + "\n\nbody\n", F, F, { targets: true });
    expect(expandSections(first, {}, "kiro")).toBe("\nbody\n");

    // last: "body\n\nO\nX\nC\n" → "body\n\n"
    const last = parseSections("body\n\n" + Ot("x", "claude-code") + "\nX\n" + C + "\n", F, F, { targets: true });
    expect(expandSections(last, {}, "kiro")).toBe("body\n\n");

    // alone: "O\nX\nC\n" → ""
    const alone = parseSections(Ot("x", "claude-code") + "\nX\n" + C + "\n", F, F, { targets: true });
    expect(expandSections(alone, {}, "kiro")).toBe("");

    // between blank lines: "a\n\nO\nX\nC\n\nb\n" → "a\n\nb\n"
    const betweenBlanks = parseSections("a\n\n" + Ot("x", "claude-code") + "\nX\n" + C + "\n\nb\n", F, F, { targets: true });
    expect(expandSections(betweenBlanks, {}, "kiro")).toBe("a\n\nb\n");

    // not between blanks: "a\nO\nX\nC\nb\n" → "a\nb\n"
    const notBetweenBlanks = parseSections("a\n" + Ot("x", "claude-code") + "\nX\n" + C + "\nb\n", F, F, { targets: true });
    expect(expandSections(notBetweenBlanks, {}, "kiro")).toBe("a\nb\n");

    // blank before only: "a\n\nO\nX\nC\nb\n" → "a\n\nb\n"
    const blankBeforeOnly = parseSections("a\n\n" + Ot("x", "claude-code") + "\nX\n" + C + "\nb\n", F, F, { targets: true });
    expect(expandSections(blankBeforeOnly, {}, "kiro")).toBe("a\n\nb\n");

    // two removed in a row between blanks: "a\n\nO1\nX\nC\nO2\nY\nC\n\nb\n" → "a\n\nb\n"
    const twoRemoved = parseSections("a\n\n" + Ot("x1", "claude-code") + "\nX\n" + C + "\n" + Ot("x2", "claude-code") + "\nY\n" + C + "\n\nb\n", F, F, { targets: true });
    expect(expandSections(twoRemoved, {}, "kiro")).toBe("a\n\nb\n");

    // removed then received: "a\n\nO1\nX\nC\nO2\nY\nC\n\nb\n" with O2 targets=kiro → "a\n\nY\n\nb\n"
    const removedThenReceived = parseSections("a\n\n" + Ot("x1", "claude-code") + "\nX\n" + C + "\n" + Ot("x2", "kiro") + "\nY\n" + C + "\n\nb\n", F, F, { targets: true });
    expect(expandSections(removedThenReceived, {}, "kiro")).toBe("a\n\nY\n\nb\n");

    // for owner claude-code the same inputs give the section's default (today's expansion)
    expect(expandSections(first, {}, "claude-code")).toBe("X\n\nbody\n");
    expect(expandSections(alone, {}, "claude-code")).toBe("X\n");
    expect(expandSections(betweenBlanks, {}, "claude-code")).toBe("a\n\nX\n\nb\n");

    // a CRLF input gives the same as its LF form (parseSections normalizes)
    const crlfInput = ("a\n\n" + Ot("x", "claude-code") + "\nX\n" + C + "\n\nb\n").replace(/\n/g, "\r\n");
    const crlfParsed = parseSections(crlfInput, F, F, { targets: true });
    expect(expandSections(crlfParsed, {}, "kiro")).toBe("a\n\nb\n");

    // owner services removes every targeted section
    expect(expandSections(first, {}, "services")).toBe("\nbody\n");
    expect(expandSections(removedThenReceived, {}, "services")).toBe("a\n\nb\n");
  });

  it("Case 6: profile value for removed section is not inserted", () => {
    // A profile provides a value for a section that the owner will never see.
    // That value must not appear in the expanded result.
    const Ot = (n: string, t: string) => `<!-- craftar:section ${n} targets=${t} -->`;
    const parsed = parseSections("a\n\n" + Ot("x", "claude-code") + "\ndefault\n" + C + "\n\nb\n", F, F, { targets: true });

    // Profile provides a value for section x
    const values = { x: "profile value\n" };

    // For kiro (not in targets), the section is removed entirely — the profile value is ignored
    expect(expandSections(parsed, values, "kiro")).toBe("a\n\nb\n");

    // For claude-code (in targets), the section is kept and the profile value is used
    expect(expandSections(parsed, values, "claude-code")).toBe("a\n\nprofile value\n\nb\n");
  });

  it("Case 7: file with no targeted section behaves same with/without owner", () => {
    // A file with only untargeted sections (no targets= attribute) expands the same
    // whether an owner is given or not.
    const parsed = parseSections("a\n" + OPEN("x") + "\ndefault\n" + C + "\nb\n", F, F, { targets: true });

    // Without owner
    expect(expandSections(parsed, {})).toBe("a\ndefault\nb\n");
    expect(expandSections(parsed, { x: "custom\n" })).toBe("a\ncustom\nb\n");

    // With owner — same result since section has no targets attribute
    expect(expandSections(parsed, {}, "kiro")).toBe("a\ndefault\nb\n");
    expect(expandSections(parsed, { x: "custom\n" }, "kiro")).toBe("a\ncustom\nb\n");
    expect(expandSections(parsed, {}, "claude-code")).toBe("a\ndefault\nb\n");
    expect(expandSections(parsed, { x: "custom\n" }, "claude-code")).toBe("a\ncustom\nb\n");
  });

  it("firstMarkerLine: targeted line is non-null at every schema", () => {
    // A targeted marker line should be detected by firstMarkerLine at every schema
    // (it's a near miss at schema <6, but still caught)
    const targetedOpener = "<!-- craftar:section x targets=claude-code -->";
    const targetedCloser = "<!-- /craftar:section -->";

    // firstMarkerLine uses markerLine with no options (default: targets=false)
    // At targets=false, a targeted opener is a "near" result (schema-6 problem)
    // This should still return a line number (it's not null, which is "plain text")
    expect(firstMarkerLine(targetedOpener + "\n")).toBe(1);
    expect(firstMarkerLine("body\n" + targetedOpener + "\n")).toBe(2);
    expect(firstMarkerLine("body\n" + targetedCloser + "\n")).toBe(2); // closer is always same
  });
});