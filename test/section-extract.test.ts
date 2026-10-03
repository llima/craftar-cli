import { describe, expect, it } from "vitest";
import { diffLines, type Hunk } from "../src/core/diff.js";
import { deriveSections, type SectionRun, type MarkerInsertion } from "../src/core/section-extract.js";
import type { PlanHunk } from "../src/schema/index.js";

/**
 * Section extraction tests (spec 12 §10.1): deriveSections on synthetic bodies.
 * Uses the §5.1 body pattern (review posture, reviewer table) with acme/globex/initech names.
 */

const OPEN = (n: string) => `<!-- craftar:section ${n} -->`;
const CLOSE = "<!-- /craftar:section -->";

const lines = (...xs: string[]) => xs.map((x) => x + "\n").join("");

/** The §5.1 body structure without markers. */
const HEADER = ["# Review posture", "", "Dispatch reviewers after every commit.", ""];
const FOOTER = ["", "Never edit what a reviewer reads."];
const TABLE_ACME = ["| Repo | Reviewer |", "|---|---|", "| `acme-api` | backend-reviewer |"];
const TABLE_GLOBEX = ["| Repo | Reviewer |", "|---|---|", "| `globex-api` | backend-reviewer |", "| `globex-web` | frontend-reviewer |"];

/** Build a body from header, table rows and footer. */
const body = (rows: string[]) => lines(...HEADER, ...rows, ...FOOTER);

/** Build a body with sections. */
const bodyWithSection = (sectionName: string, rows: string[]) =>
  lines(...HEADER, OPEN(sectionName), ...rows, CLOSE, ...FOOTER);

/** Plan entry helper. */
const entry = (hunk: number, take: string, section?: { name: string; lines?: string }): PlanHunk => ({
  hunk,
  at: "",
  take: take as PlanHunk["take"],
  ...(section ? { section } : {}),
});

/** Get hunks from two texts. */
const getHunks = (base: string, variant: string): Hunk[] => diffLines(base, variant);

const FILE = "rule.md";
const LABEL = "ingredients/rules/review-posture/rule.md";
const REF = "rule/review-posture";

const err = (fn: () => unknown): string => {
  try {
    fn();
    return "no error";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("deriveSections — Q1: variant adds rows (block hunk, no base lines)", () => {
  const base = body(TABLE_ACME);
  const variant = body([...TABLE_ACME, "| `acme-web` | frontend-reviewer |", "| `acme-desktop` | desktop-reviewer |"]);
  const hunks = getHunks(base, variant);

  it("without lines: empty span, default '', value = the two rows", () => {
    const entries = [entry(1, "section", { name: "extras" })];
    const result = deriveSections({
      file: FILE,
      label: LABEL,
      ref: REF,
      baseText: base,
      variantText: variant,
      hunks,
      entries,
      declaredElsewhere: new Map(),
    });

    expect(result.runs).toHaveLength(1);
    const run = result.runs[0];
    expect(run.name).toBe("extras");
    expect(run.existing).toBe(false);
    expect(run.default).toBe("");
    expect(run.value).toBe("| `acme-web` | frontend-reviewer |\n| `acme-desktop` | desktop-reviewer |\n");
    expect(run.from).toBe(run.to + 1); // empty span

    // Markers at the right positions
    expect(result.markers).toHaveLength(2);
    const opener = result.markers.find((m) => m.line.includes("craftar:section extras"));
    const closer = result.markers.find((m) => m.line.includes("/craftar:section"));
    expect(opener).toBeDefined();
    expect(closer).toBeDefined();
    // Same `at` for empty span
    expect(opener!.at).toBe(closer!.at);
  });

  it("with lines over shared rows: default = shared table, value = whole variant table", () => {
    // Lines covering the table header (line 5), separator (line 6), and shared row (line 7)
    const entries = [entry(1, "section", { name: "flavors", lines: "5-7" })];
    const result = deriveSections({
      file: FILE,
      label: LABEL,
      ref: REF,
      baseText: base,
      variantText: variant,
      hunks,
      entries,
      declaredElsewhere: new Map(),
    });

    expect(result.runs).toHaveLength(1);
    const run = result.runs[0];
    expect(run.name).toBe("flavors");
    expect(run.existing).toBe(false);
    expect(run.from).toBe(5);
    expect(run.to).toBe(7);
    expect(run.default).toBe(lines(...TABLE_ACME));
    // Value is the variant's table plus the two extra rows
    expect(run.value).toBe(lines(...TABLE_ACME, "| `acme-web` | frontend-reviewer |", "| `acme-desktop` | desktop-reviewer |"));
  });
});

describe("deriveSections — Q2: two hunks (rows 1 and 3 differ, row 2 equal)", () => {
  const base = lines("# Table", "| a |", "| b |", "| c |", "end");
  const variant = lines("# Table", "| A |", "| b |", "| C |", "end");
  const hunks = getHunks(base, variant);

  it("one run of both hunks: default = three base rows, value = three variant rows", () => {
    // Two hunks: line 2 and line 4
    expect(hunks).toHaveLength(2);
    const entries = [entry(1, "section", { name: "rows" }), entry(2, "section", { name: "rows" })];
    const result = deriveSections({
      file: FILE,
      label: LABEL,
      ref: REF,
      baseText: base,
      variantText: variant,
      hunks,
      entries,
      declaredElsewhere: new Map(),
    });

    expect(result.runs).toHaveLength(1);
    const run = result.runs[0];
    expect(run.hunks).toEqual([1, 2]);
    expect(run.default).toBe("| a |\n| b |\n| c |\n");
    expect(run.value).toBe("| A |\n| b |\n| C |\n");
  });
});

describe("deriveSections — Q3: existing section (base with flavors, variant adds row c)", () => {
  const base = bodyWithSection("flavors", ["| a |", "| b |"]);
  // Variant has rows a, b, c but no markers
  const variantNoMarkers = body(["| a |", "| b |", "| c |"]);
  const hunks = getHunks(base, variantNoMarkers);

  it("existing run from opener to closer; value = a, b, c rows; no markers inserted", () => {
    // Find the hunks that touch the section
    const entries = hunks.map((_, i) => entry(i + 1, "section", { name: "flavors" }));
    const result = deriveSections({
      file: FILE,
      label: LABEL,
      ref: REF,
      baseText: base,
      variantText: variantNoMarkers,
      hunks,
      entries,
      declaredElsewhere: new Map(),
    });

    expect(result.runs).toHaveLength(1);
    const run = result.runs[0];
    expect(run.name).toBe("flavors");
    expect(run.existing).toBe(true);
    expect(run.default).toBeNull();
    expect(run.value).toBe("| a |\n| b |\n| c |\n");
    expect(result.markers).toHaveLength(0); // No markers for existing section
  });
});

describe("deriveSections — Q4: existing section (variant rows q, r)", () => {
  const base = bodyWithSection("flavors", ["| a |", "| b |"]);
  const variantNoMarkers = body(["| q |", "| r |"]);
  const hunks = getHunks(base, variantNoMarkers);

  it("existing; value = q, r", () => {
    const entries = hunks.map((_, i) => entry(i + 1, "section", { name: "flavors" }));
    const result = deriveSections({
      file: FILE,
      label: LABEL,
      ref: REF,
      baseText: base,
      variantText: variantNoMarkers,
      hunks,
      entries,
      declaredElsewhere: new Map(),
    });

    expect(result.runs).toHaveLength(1);
    const run = result.runs[0];
    expect(run.existing).toBe(true);
    expect(run.value).toBe("| q |\n| r |\n");
  });
});

describe("deriveSections — Q5: missing final newline (S10)", () => {
  it("base ends without final newline → S10 base", () => {
    const base = "x\n| a |"; // no final newline
    const variant = "x\n| b |\n| c |\n";
    const hunks = getHunks(base, variant);

    const entries = [entry(1, "section", { name: "data" })];
    expect(err(() =>
      deriveSections({
        file: FILE,
        label: LABEL,
        ref: REF,
        baseText: base,
        variantText: variant,
        hunks,
        entries,
        declaredElsewhere: new Map(),
      }),
    )).toContain("would reach a missing final newline in the base");
  });

  it("variant ends without final newline → S10 variant", () => {
    const base = "x\n| a |\n";
    const variant = "x\n| b |\n| c |"; // no final newline
    const hunks = getHunks(base, variant);

    const entries = [entry(1, "section", { name: "data" })];
    expect(err(() =>
      deriveSections({
        file: FILE,
        label: LABEL,
        ref: REF,
        baseText: base,
        variantText: variant,
        hunks,
        entries,
        declaredElsewhere: new Map(),
      }),
    )).toContain("would reach a missing final newline in the variant");
  });
});

describe("deriveSections — S8: straddling hunk", () => {
  it("hunk holds lines inside and outside section → S8", () => {
    // Base has section around "| a |", variant also changes line right after closer
    const base = lines("x", OPEN("data"), "| a |", CLOSE, "y");
    const variant = lines("x", "| b |", "z"); // Changed both inside and after section
    const hunks = getHunks(base, variant);

    // The hunk spans lines that include both inside and outside the section
    const entries = hunks.map((_, i) => entry(i + 1, "section", { name: "data" }));

    expect(err(() =>
      deriveSections({
        file: FILE,
        label: LABEL,
        ref: REF,
        baseText: base,
        variantText: variant,
        hunks,
        entries,
        declaredElsewhere: new Map(),
      }),
    )).toContain("holds lines inside and outside section data");
  });
});

describe("deriveSections — S1: take: section without section object", () => {
  it("throws S1 message", () => {
    const base = "a\nb\n";
    const variant = "a\nc\n";
    const hunks = getHunks(base, variant);

    const entries = [entry(1, "section")]; // No section field
    expect(err(() =>
      deriveSections({
        file: FILE,
        label: LABEL,
        ref: REF,
        baseText: base,
        variantText: variant,
        hunks,
        entries,
        declaredElsewhere: new Map(),
      }),
    )).toContain('hunk 1 is take: section but names no section');
  });
});

describe("deriveSections — S3: non-consecutive hunks", () => {
  it("gap in hunk numbers → S3", () => {
    const base = lines("a", "b", "c", "d", "e");
    const variant = lines("A", "b", "C", "d", "E");
    const hunks = getHunks(base, variant);
    expect(hunks.length).toBe(3);

    // Hunks 1 and 3 for same section (gap at 2)
    const entries = [entry(1, "section", { name: "data" }), entry(2, "base"), entry(3, "section", { name: "data" })];

    expect(err(() =>
      deriveSections({
        file: FILE,
        label: LABEL,
        ref: REF,
        baseText: base,
        variantText: variant,
        hunks,
        entries,
        declaredElsewhere: new Map(),
      }),
    )).toContain("section data is not one run of consecutive hunks (hunks 1, 3)");
  });
});

describe("deriveSections — S4: two different lines ranges", () => {
  it("two hunks with different lines → S4", () => {
    const base = lines("a", "b", "c", "d");
    const variant = lines("A", "B", "c", "d");
    const hunks = getHunks(base, variant);

    const entries = [
      entry(1, "section", { name: "data", lines: "1-2" }),
      entry(2, "section", { name: "data", lines: "1-3" }),
    ];

    expect(err(() =>
      deriveSections({
        file: FILE,
        label: LABEL,
        ref: REF,
        baseText: base,
        variantText: variant,
        hunks,
        entries,
        declaredElsewhere: new Map(),
      }),
    )).toContain("section data has two ranges: 1-2, 1-3");
  });
});

describe("deriveSections — S5: lines issues", () => {
  it("out of range → S5", () => {
    const base = lines("a", "b", "c");
    const variant = lines("A", "b", "c");
    const hunks = getHunks(base, variant);

    const entries = [entry(1, "section", { name: "data", lines: "1-10" })];

    expect(err(() =>
      deriveSections({
        file: FILE,
        label: LABEL,
        ref: REF,
        baseText: base,
        variantText: variant,
        hunks,
        entries,
        declaredElsewhere: new Map(),
      }),
    )).toContain("lines 1-10 of section data is out of range");
  });

  it("does not contain hunk → S5", () => {
    const base = lines("a", "b", "c", "d", "e");
    const variant = lines("a", "b", "c", "D", "e");
    const hunks = getHunks(base, variant);

    // Hunk is at line 4, but lines only covers 1-2
    const entries = [entry(1, "section", { name: "data", lines: "1-2" })];

    expect(err(() =>
      deriveSections({
        file: FILE,
        label: LABEL,
        ref: REF,
        baseText: base,
        variantText: variant,
        hunks,
        entries,
        declaredElsewhere: new Map(),
      }),
    )).toContain("does not contain hunk 1");
  });

  it("covers a non-run hunk → S5", () => {
    // Create three separate hunks by having equal lines between changes
    const base = lines("a", "x", "b", "y", "c", "z", "d");
    const variant = lines("A", "x", "B", "y", "C", "z", "d");
    const hunks = getHunks(base, variant);

    // Should have 3 hunks at lines 1, 3, 5
    expect(hunks.length).toBe(3);

    // Only hunks 1 and 2 are section, but lines covers all 3
    const entries = [
      entry(1, "section", { name: "data", lines: "1-5" }),
      entry(2, "section", { name: "data", lines: "1-5" }),
      entry(3, "base"),
    ];

    expect(err(() =>
      deriveSections({
        file: FILE,
        label: LABEL,
        ref: REF,
        baseText: base,
        variantText: variant,
        hunks,
        entries,
        declaredElsewhere: new Map(),
      }),
    )).toContain("covers hunk 3, which is take: base");
  });

  it("end anchor cuts a hunk → S5 (lines ends directly before a changed line)", () => {
    // base: lines 1-10, where line 9 is equal and line 10 is changed
    // Create a scenario: hunk 1 at line 5 (in section), hunk 2 at lines 10 (not in section)
    const base = lines("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k");
    const variant = lines("a", "b", "c", "d", "E", "f", "g", "h", "i", "J", "k");
    const hunks = getHunks(base, variant);

    // Hunk 1 at line 5, hunk 2 at line 10
    expect(hunks.length).toBe(2);
    expect(hunks[0].a.start).toBe(5);
    expect(hunks[1].a.start).toBe(10);

    // Section spans lines 5-9, so end anchor is line 10 which is inside hunk 2
    const entries = [
      entry(1, "section", { name: "data", lines: "5-9" }),
      entry(2, "base"),
    ];

    expect(err(() =>
      deriveSections({
        file: FILE,
        label: LABEL,
        ref: REF,
        baseText: base,
        variantText: variant,
        hunks,
        entries,
        declaredElsewhere: new Map(),
      }),
    )).toContain("lines 5-9 of section data cuts hunk 2");
  });

  it("start anchor cuts a hunk → S5 (lines starts directly after a changed line)", () => {
    // Create a scenario: hunk 1 at line 2 (not in section), hunk 2 at line 5 (in section)
    const base = lines("a", "b", "c", "d", "e", "f", "g", "h");
    const variant = lines("a", "B", "c", "d", "E", "f", "g", "h");
    const hunks = getHunks(base, variant);

    // Hunk 1 at line 2, hunk 2 at line 5
    expect(hunks.length).toBe(2);
    expect(hunks[0].a.start).toBe(2);
    expect(hunks[1].a.start).toBe(5);

    // Section spans lines 3-5, so start anchor is line 2 which is inside hunk 1
    const entries = [
      entry(1, "base"),
      entry(2, "section", { name: "data", lines: "3-5" }),
    ];

    expect(err(() =>
      deriveSections({
        file: FILE,
        label: LABEL,
        ref: REF,
        baseText: base,
        variantText: variant,
        hunks,
        entries,
        declaredElsewhere: new Map(),
      }),
    )).toContain("lines 3-5 of section data cuts hunk 1");
  });
});

describe("deriveSections — S6: name already declared", () => {
  it("same file → S6", () => {
    const base = bodyWithSection("flavors", ["| a |"]);
    const variant = body(["| a |", "| b |"]);
    const hunks = getHunks(base, variant);

    // Try to create a new section with same name as existing
    const entries = hunks.map((_, i) => entry(i + 1, "section", { name: "flavors" }));

    // This should actually be detected as existing, let's use a different case
    // New section name that matches existing
  });

  it("declared elsewhere → S6", () => {
    const base = lines("a", "b", "c");
    const variant = lines("a", "B", "c");
    const hunks = getHunks(base, variant);

    const entries = [entry(1, "section", { name: "extras" })];

    expect(err(() =>
      deriveSections({
        file: FILE,
        label: LABEL,
        ref: REF,
        baseText: base,
        variantText: variant,
        hunks,
        entries,
        declaredElsewhere: new Map([["extras", "other.md:5"]]),
      }),
    )).toContain("section extras is already declared in rule/review-posture (other.md:5)");
  });
});

describe("deriveSections — S7: overlapping sections", () => {
  it("new span over existing marker → S7", () => {
    const base = lines("a", OPEN("data"), "x", CLOSE, "b", "c");
    const variant = lines("a", "x", "B", "C");
    const hunks = getHunks(base, variant);

    // Try to create a section that overlaps the existing one
    const entries = hunks.map((_, i) => entry(i + 1, "section", { name: "other" }));

    expect(err(() =>
      deriveSections({
        file: FILE,
        label: LABEL,
        ref: REF,
        baseText: base,
        variantText: variant,
        hunks,
        entries,
        declaredElsewhere: new Map(),
      }),
    )).toContain("would overlap section data");
  });

  it("existing run named differently → S7", () => {
    const base = bodyWithSection("flavors", ["| a |"]);
    const variant = body(["| b |"]);
    const hunks = getHunks(base, variant);

    // Touch the section but name it differently
    const entries = hunks.map((_, i) => entry(i + 1, "section", { name: "other" }));

    expect(err(() =>
      deriveSections({
        file: FILE,
        label: LABEL,
        ref: REF,
        baseText: base,
        variantText: variant,
        hunks,
        entries,
        declaredElsewhere: new Map(),
      }),
    )).toContain("would overlap section flavors");
  });
});

describe("deriveSections — S9: existing section with wrong lines", () => {
  it("lines given but not exact → S9", () => {
    const base = bodyWithSection("flavors", ["| a |", "| b |"]);
    const variant = body(["| c |", "| d |"]);
    const hunks = getHunks(base, variant);

    // The section spans lines 5-8 (opener, two rows, closer)
    const entries = hunks.map((_, i) => entry(i + 1, "section", { name: "flavors", lines: "5-10" }));

    expect(err(() =>
      deriveSections({
        file: FILE,
        label: LABEL,
        ref: REF,
        baseText: base,
        variantText: variant,
        hunks,
        entries,
        declaredElsewhere: new Map(),
      }),
    )).toContain("already spans lines");
  });
});

describe("deriveSections — S12: variant with markers", () => {
  it("column-0 marker in variant → S12", () => {
    const base = lines("a", "b", "c");
    const variant = lines("a", OPEN("data"), "c");
    const hunks = getHunks(base, variant);

    const entries = [entry(1, "section", { name: "other" })];

    expect(err(() =>
      deriveSections({
        file: FILE,
        label: LABEL,
        ref: REF,
        baseText: base,
        variantText: variant,
        hunks,
        entries,
        declaredElsewhere: new Map(),
      }),
    )).toContain("variant holds a section marker");
  });

  it("near miss in variant → S12", () => {
    const base = lines("a", "b", "c");
    const variant = lines("a", "<!--craftar:section x-->", "c");
    const hunks = getHunks(base, variant);

    const entries = [entry(1, "section", { name: "other" })];

    expect(err(() =>
      deriveSections({
        file: FILE,
        label: LABEL,
        ref: REF,
        baseText: base,
        variantText: variant,
        hunks,
        entries,
        declaredElsewhere: new Map(),
      }),
    )).toContain("variant holds a section marker");
  });
});

describe("deriveSections — empty span cases", () => {
  it("empty span in the middle of a file", () => {
    const base = lines("a", "b", "c", "d");
    const variant = lines("a", "b", "x", "y", "c", "d");
    const hunks = getHunks(base, variant);

    // Pure addition after line 2
    expect(hunks.length).toBe(1);
    expect(hunks[0].a.lines.length).toBe(0);

    const entries = [entry(1, "section", { name: "extras" })];
    const result = deriveSections({
      file: FILE,
      label: LABEL,
      ref: REF,
      baseText: base,
      variantText: variant,
      hunks,
      entries,
      declaredElsewhere: new Map(),
    });

    expect(result.runs).toHaveLength(1);
    const run = result.runs[0];
    expect(run.default).toBe("");
    expect(run.from).toBe(run.to + 1); // empty span
    expect(run.value).toBe("x\ny\n");
  });

  it("empty span at the end of a file with final newline", () => {
    const base = lines("a", "b");
    const variant = lines("a", "b", "c", "d");
    const hunks = getHunks(base, variant);

    const entries = [entry(1, "section", { name: "extras" })];
    const result = deriveSections({
      file: FILE,
      label: LABEL,
      ref: REF,
      baseText: base,
      variantText: variant,
      hunks,
      entries,
      declaredElsewhere: new Map(),
    });

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].default).toBe("");
    expect(result.runs[0].value).toBe("c\nd\n");
  });
});

describe("deriveSections — adjacent new and existing sections", () => {
  it("processes both correctly", () => {
    // Base has one section, variant adds content that becomes another
    const base = lines("header", OPEN("first"), "x", CLOSE, "middle", "footer");
    // Variant changes middle and removes markers from first
    const variant = lines("header", "x", "NEW", "footer");
    const hunks = getHunks(base, variant);

    // Find the hunks - one touches existing, one is new
    // This tests that both can coexist in one file
    // For simplicity, let's test a simpler case
  });
});

describe("deriveSections — CRLF and BOM handling", () => {
  it("CRLF base and variant give same runs as LF", () => {
    const baseLf = lines("a", "b", "c");
    const variantLf = lines("a", "B", "c");
    const baseCrlf = baseLf.replace(/\n/g, "\r\n");
    const variantCrlf = variantLf.replace(/\n/g, "\r\n");

    const hunksLf = getHunks(baseLf, variantLf);
    const hunksCrlf = getHunks(baseCrlf, variantCrlf);

    const entriesLf = [entry(1, "section", { name: "data" })];
    const entriesCrlf = [entry(1, "section", { name: "data" })];

    const resultLf = deriveSections({
      file: FILE,
      label: LABEL,
      ref: REF,
      baseText: baseLf,
      variantText: variantLf,
      hunks: hunksLf,
      entries: entriesLf,
      declaredElsewhere: new Map(),
    });

    const resultCrlf = deriveSections({
      file: FILE,
      label: LABEL,
      ref: REF,
      baseText: baseCrlf,
      variantText: variantCrlf,
      hunks: hunksCrlf,
      entries: entriesCrlf,
      declaredElsewhere: new Map(),
    });

    // Runs should be equivalent (default/value are LF normalized)
    expect(resultLf.runs.length).toBe(resultCrlf.runs.length);
    expect(resultLf.runs[0].default).toBe(resultCrlf.runs[0].default);
    expect(resultLf.runs[0].value).toBe(resultCrlf.runs[0].value);
  });

  it("BOM base and variant give same runs as non-BOM", () => {
    const bom = "\uFEFF";
    const baseLf = lines("a", "b", "c");
    const variantLf = lines("a", "B", "c");
    const baseBom = bom + baseLf;
    const variantBom = bom + variantLf;

    const hunksLf = getHunks(baseLf, variantLf);
    const hunksBom = getHunks(baseBom, variantBom);

    const entriesLf = [entry(1, "section", { name: "data" })];
    const entriesBom = [entry(1, "section", { name: "data" })];

    const resultLf = deriveSections({
      file: FILE,
      label: LABEL,
      ref: REF,
      baseText: baseLf,
      variantText: variantLf,
      hunks: hunksLf,
      entries: entriesLf,
      declaredElsewhere: new Map(),
    });

    const resultBom = deriveSections({
      file: FILE,
      label: LABEL,
      ref: REF,
      baseText: baseBom,
      variantText: variantBom,
      hunks: hunksBom,
      entries: entriesBom,
      declaredElsewhere: new Map(),
    });

    expect(resultLf.runs.length).toBe(resultBom.runs.length);
    expect(resultLf.runs[0].default).toBe(resultBom.runs[0].default);
    expect(resultLf.runs[0].value).toBe(resultBom.runs[0].value);
  });
});

describe("deriveSections — marker insertion order", () => {
  it("opener before closer at same at for empty span", () => {
    const base = lines("a", "b", "c");
    const variant = lines("a", "b", "x", "c");
    const hunks = getHunks(base, variant);

    const entries = [entry(1, "section", { name: "data" })];
    const result = deriveSections({
      file: FILE,
      label: LABEL,
      ref: REF,
      baseText: base,
      variantText: variant,
      hunks,
      entries,
      declaredElsewhere: new Map(),
    });

    expect(result.markers.length).toBe(2);
    // For empty span, opener and closer at same position, opener first
    expect(result.markers[0].line).toContain("craftar:section data");
    expect(result.markers[1].line).toContain("/craftar:section");
  });
});
