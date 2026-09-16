import { describe, expect, it } from "vitest";
import { diffLines, diffOps, renderDiff } from "../src/core/diff.js";

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
});

describe("diffOps", () => {
  it("keeps every line, tagged, in order", () => {
    expect(diffOps("a\nold\n", "a\nnew\n")).toEqual([
      { kind: "same", line: "a" },
      { kind: "del", line: "old" },
      { kind: "add", line: "new" },
      { kind: "same", line: "" },
    ]);
  });
});

describe("renderDiff", () => {
  it("marks each side and keeps unchanged lines as context", () => {
    const out = renderDiff("a\nold\nc\n", "a\nnew\nc\n");
    expect(out.split("\n")).toEqual(["  a", "- old", "+ new", "  c", "  "]);
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
    const paint = { same: (s: string) => "[s]" + s, del: (s: string) => "[d]" + s, add: (s: string) => "[a]" + s };
    const out = renderDiff(`x\n${same}`, `y\n${same}`, { paint });
    expect(out.split("\n")).toEqual([
      "[d]- x",
      "[a]+ y",
      "[s]  line 0",
      "[s]  line 1",
      "[s]  line 2",
      "[s]  … 4 unchanged lines …",
      "[s]  line 7",
      "[s]  line 8",
      "[s]  line 9",
    ]);
  });
});
