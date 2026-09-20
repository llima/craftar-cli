import { describe, expect, it } from "vitest";
import { diffLines, diffOps, renderDiff, splitLines } from "../src/core/diff.js";

describe("diffLines", () => {
  it("reports nothing for identical text", () => {
    expect(diffLines("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("reports nothing when only the line endings or a BOM differ", () => {
    expect(diffLines("a\nb\n", "a\r\nb\r\n")).toEqual([]);
    expect(diffLines("﻿a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("calls a replaced line inline and carries both sides", () => {
    const h = diffLines("a\nold\nc\n", "a\nnew\nc\n");
    expect(h).toHaveLength(1);
    expect(h[0].kind).toBe("inline");
    expect(h[0].a).toEqual({ start: 2, lines: ["old"] });
    expect(h[0].b).toEqual({ start: 2, lines: ["new"] });
  });

  it("calls a pure addition a block, inserted after the previous line", () => {
    const h = diffLines("a\nb\n", "a\nb\nc\n");
    expect(h).toHaveLength(1);
    expect(h[0].kind).toBe("block");
    expect(h[0].a).toEqual({ start: 3, lines: [] });
    expect(h[0].b.lines).toEqual(["c"]);
  });

  it("calls a pure removal a block", () => {
    const h = diffLines("a\nb\nc\n", "a\nc\n");
    expect(h).toHaveLength(1);
    expect(h[0].kind).toBe("block");
    expect(h[0].a.lines).toEqual(["b"]);
    expect(h[0].b.lines).toEqual([]);
  });

  it("separates two changes into two hunks with their own line numbers", () => {
    const h = diffLines("1\nx\n3\n4\ny\n6\n", "1\nX\n3\n4\nY\n6\n");
    expect(h.map((x) => [x.kind, x.a.start])).toEqual([
      ["inline", 2],
      ["inline", 5],
    ]);
  });

  it("diffs an empty file against content", () => {
    const h = diffLines("", "a\n");
    expect(h).toHaveLength(1);
    expect(h[0].b.lines).toContain("a");
  });

  it("splits without the phantom element the trailing newline used to leave", () => {
    expect(splitLines("")).toEqual({ lines: [], eofNewline: false });
    expect(splitLines("\n")).toEqual({ lines: [""], eofNewline: true });
    expect(splitLines("a")).toEqual({ lines: ["a"], eofNewline: false });
    expect(splitLines("a\n")).toEqual({ lines: ["a"], eofNewline: true });
    expect(splitLines("a\n\nb")).toEqual({ lines: ["a", "", "b"], eofNewline: false });
  });

  it("shows a final-newline-only difference as the last line, not as an empty line", () => {
    const h = diffLines("a", "a\n");
    expect(h).toHaveLength(1);
    expect(h[0].a).toEqual({ start: 1, lines: ["a"], noEofNewline: true });
    expect(h[0].b).toEqual({ start: 1, lines: ["a"] });
  });

  it("marks the unterminated side on the hunk that already shows its last line", () => {
    const h = diffLines("a\nb", "a\nc\n");
    expect(h).toHaveLength(1);
    expect(h[0].a).toEqual({ start: 2, lines: ["b"], noEofNewline: true });
    expect(h[0].b).toEqual({ start: 2, lines: ["c"] });
  });

  it("extends the trailing hunk back to the unterminated last line", () => {
    const h = diffLines("a\nb", "a\nb\nc\n");
    expect(h).toHaveLength(1);
    expect(h[0].a).toEqual({ start: 2, lines: ["b"], noEofNewline: true });
    expect(h[0].b).toEqual({ start: 2, lines: ["b", "c"] });
  });

  it("extends the trailing hunk when the terminated side is the one with the extra line", () => {
    const h = diffLines("a\nb\nc\n", "a\nb");
    expect(h).toHaveLength(1);
    expect(h[0].a).toEqual({ start: 2, lines: ["b", "c"] });
    expect(h[0].b).toEqual({ start: 2, lines: ["b"], noEofNewline: true });
  });

  it("marks a removed unterminated file even though the other side has no lines", () => {
    const h = diffLines("a", "");
    expect(h).toHaveLength(1);
    expect(h[0].a).toEqual({ start: 1, lines: ["a"], noEofNewline: true });
    expect(h[0].b.lines).toEqual([]);
  });

  it("marks both sides when neither ends in a newline", () => {
    const h = diffLines("a", "b");
    expect(h).toHaveLength(1);
    expect(h[0].a).toEqual({ start: 1, lines: ["a"], noEofNewline: true });
    expect(h[0].b).toEqual({ start: 1, lines: ["b"], noEofNewline: true });
  });

  it("does not mark an empty file, which has no last line", () => {
    const h = diffLines("", "\n");
    expect(h).toHaveLength(1);
    expect(h[0].a.noEofNewline).toBeUndefined();
    expect(h[0].b.noEofNewline).toBeUndefined();
  });
});

describe("diffOps", () => {
  it("keeps every line, tagged, in order", () => {
    expect(diffOps("a\nold\n", "a\nnew\n")).toEqual([
      { kind: "same", line: "a" },
      { kind: "del", line: "old" },
      { kind: "add", line: "new" },
    ]);
  });
});

describe("renderDiff", () => {
  it("marks each side and keeps unchanged lines as context", () => {
    const out = renderDiff("a\nold\nc\n", "a\nnew\nc\n");
    expect(out.split("\n")).toEqual(["  a", "- old", "+ new", "  c"]);
  });

  it("collapses a long unchanged run to three lines, a summary and three lines", () => {
    const same = Array.from({ length: 10 }, (_, k) => `line ${k}`).join("\n");
    const out = renderDiff(`x\n${same}`, `y\n${same}`);
    expect(out.split("\n")).toEqual([
      "- x",
      "+ y",
      "  line 0",
      "  line 1",
      "  line 2",
      "  … 4 unchanged lines …",
      "  line 7",
      "  line 8",
      "  line 9",
    ]);
  });

  it("paints each kind of line, and still collapses when lines are painted", () => {
    const same = Array.from({ length: 10 }, (_, k) => `line ${k}`).join("\n");
    const paint = { same: (s: string) => `[s]${s}[/s]`, del: (s: string) => `[d]${s}[/d]`, add: (s: string) => `[a]${s}[/a]` };
    const out = renderDiff(`x\n${same}`, `y\n${same}`, { paint });
    expect(out.split("\n")).toEqual([
      "[d]- x[/d]",
      "[a]+ y[/a]",
      "[s]  line 0[/s]",
      "[s]  line 1[/s]",
      "[s]  line 2[/s]",
      "[s]  … 4 unchanged lines …[/s]",
      "[s]  line 7[/s]",
      "[s]  line 8[/s]",
      "[s]  line 9[/s]",
    ]);
  });

  it("prints the git marker under the side that has no final newline", () => {
    const out = renderDiff("a\nb", "a\nb\n");
    expect(out.split("\n")).toEqual(["  a", "- b", "\\ No newline at end of file", "+ b"]);
  });

  it("attaches the marker to a changed line when the ops continue past it", () => {
    const out = renderDiff("a\nb", "a\nb\nc\n");
    expect(out.split("\n")).toEqual(["  a", "- b", "\\ No newline at end of file", "+ b", "+ c"]);
  });

  it("attaches the marker to a changed line when the removal is the trailing one", () => {
    const out = renderDiff("a\nb\nc\n", "a\nb");
    expect(out.split("\n")).toEqual(["  a", "- b", "+ b", "\\ No newline at end of file", "- c"]);
  });

  it("prints no marker when both sides are unterminated on the same last line", () => {
    const out = renderDiff("x\nb", "y\nb");
    expect(out.split("\n")).toEqual(["- x", "+ y", "  b"]);
    expect(out).not.toContain("No newline");
  });

  it("keeps the marker off the context line when both sides end on different last lines", () => {
    const out = renderDiff("a\nb", "a");
    expect(out.split("\n")).toEqual(["  a", "- b", "\\ No newline at end of file"]);
    // The other engine flags side a only — the two must agree about the same input.
    expect(diffLines("a\nb", "a")[0].b.noEofNewline).toBeUndefined();
  });

  it("keeps the marker off the context line in the mirror case too", () => {
    const out = renderDiff("a", "a\nb");
    expect(out.split("\n")).toEqual(["  a", "+ b", "\\ No newline at end of file"]);
    expect(diffLines("a", "a\nb")[0].a.noEofNewline).toBeUndefined();
  });

  it("still prints both markers when each side's last line changed", () => {
    const out = renderDiff("a", "b");
    expect(out.split("\n")).toEqual([
      "- a",
      "\\ No newline at end of file",
      "+ b",
      "\\ No newline at end of file",
    ]);
  });

  it("paints each marker with the painter of the side it follows", () => {
    const paint = {
      same: (s: string) => `[s]${s}[/s]`,
      del: (s: string) => `[d]${s}[/d]`,
      add: (s: string) => `[a]${s}[/a]`,
    };
    expect(renderDiff("a", "b", { paint }).split("\n")).toEqual([
      "[d]- a[/d]",
      "[d]\\ No newline at end of file[/d]",
      "[a]+ b[/a]",
      "[a]\\ No newline at end of file[/a]",
    ]);
    expect(renderDiff("a", "a\nb", { paint }).split("\n")).toEqual([
      "[s]  a[/s]",
      "[a]+ b[/a]",
      "[a]\\ No newline at end of file[/a]",
    ]);
  });

  it("does not transform the ops when the last op is not same", () => {
    const out = renderDiff("a\nb", "a\n");
    expect(out.split("\n")).toEqual(["  a", "- b", "\\ No newline at end of file"]);
  });

  it("prints exactly as many markers as diffLines flags, on the same sides", () => {
    const cases: Array<[string, string]> = [
      ["a\nb", "a"],
      ["a", "a\nb"],
      ["x\nb", "y\nb"],
      ["a", "b"],
      ["a\nb", "a\nb\nc\n"],
      ["a\nb\nc\n", "a\nb"],
    ];
    for (const [a, b] of cases) {
      const markers = renderDiff(a, b).split("\n").filter((l) => l.includes("No newline")).length;
      const flags = diffLines(a, b).reduce(
        (n, h) => n + (h.a.noEofNewline ? 1 : 0) + (h.b.noEofNewline ? 1 : 0),
        0,
      );
      expect({ a, b, markers }).toEqual({ a, b, markers: flags });
    }
  });
});
