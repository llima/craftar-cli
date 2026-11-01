import { describe, expect, it } from "vitest";
import { LEAKED_TAGS, blankCode, githubSlug, readTarget, scanMarkdown } from "../src/core/docs-validate.js";

// Spec 47 §6 — the scanner: what it reads as a link, what it leaves as code, and in what time.

const dests = (text: string) => scanMarkdown(text).links.map((l) => l.dest);
const at = (text: string) => scanMarkdown(text).links.map((l) => `${l.line}:${l.column} ${l.dest}`);
const T = (a: string, b: string) => a + b; // tags assembled at runtime (§4.5)

describe("§11 item 1 — the 790 case and its traps", () => {
  it("a link in a double-backtick span is code", () => {
    expect(dests("See `` [a](x.md) `` and [b](y.md).\n")).toEqual(["y.md"]);
  });
  it("a single backtick run does not close a double one", () => {
    expect(dests("`` a ` [c](z.md) ``\n")).toEqual([]);
  });
  it("a fence closed by a longer run hides its link", () => {
    expect(dests("```\n[a](x.md)\n`````\n[b](y.md)\n")).toEqual(["y.md"]);
  });
  it("a shorter run does not close a fence", () => {
    expect(dests("````\n```\n[a](x.md)\n````\n")).toEqual([]);
  });
  it("an unclosed fence hides everything after it", () => {
    expect(dests("[a](x.md)\n~~~\n[b](y.md)\n\n[c](z.md)\n")).toEqual(["x.md"]);
  });
  it("a link wrapped across two lines is read, at its own line", () => {
    expect(at("intro text with a [long\nlink text](docs/a.md) here\n")).toEqual(["2:12 docs/a.md"]);
  });
  it("a table row is its own paragraph", () => {
    expect(at("| a | b |\n|---|---|\n| [x](x.md) | `[y](y.md)` |\n")).toEqual(["3:7 x.md"]);
  });
  it("a nested list item's link is read, and indented text in a list is text", () => {
    expect(dests("- one [a](a.md)\n  - two [b](b.md)\n\n        [c](c.md)\n")).toEqual(["a.md", "b.md", "c.md"]);
  });
});

describe("§11 item 2 — forms the measured tree did not hold", () => {
  it("a reference definition, with and without a title", () => {
    expect(at('[ref]: docs/a.md\n\n[two]: <b c.md> "t"\n')).toEqual(["1:8 docs/a.md", "3:9 b c.md"]);
  });
  it("<a href> and <img src> with quoted values; an unquoted one is unseen", () => {
    expect(dests('<a href="a.md">a</a> <img alt="x" src=\'i.png\'> <a href=b.md>b</a>\n')).toEqual(["a.md", "i.png"]);
  });
  it("an angle destination with a space", () => {
    expect(dests("[a](<a b.md>)\n")).toEqual(["a b.md"]);
  });
  it("a percent-encoded target is kept for readTarget", () => {
    expect(dests("[a](a%20b.md) [b](c%zz.md)\n")).toEqual(["a%20b.md", "c%zz.md"]);
  });
  it("an image, a title and balanced parentheses", () => {
    expect(dests('![alt](img/x.png) [t](a.md "Title") [p](a(b).md)\n')).toEqual(["img/x.png", "a.md", "a(b).md"]);
  });
  it("an image inside a link gives both", () => {
    expect(dests("[![b](badge.svg)](docs/a.md)\n")).toEqual(["badge.svg", "docs/a.md"]);
  });
  it("text after the destination that is no title makes no link", () => {
    expect(dests("[a](b.md junk)\n")).toEqual([]);
  });
  it("an escaped bracket opens nothing", () => {
    expect(dests("\\[a](b.md)\n")).toEqual([]);
  });
});

describe("§6.1 — blocks", () => {
  it("frontmatter is skipped with its lines counted, CRLF and BOM keep line numbers", () => {
    const text = "\uFEFF---\r\ntitle: [x](no.md)\r\n---\r\n\r\n[a](a.md)\r\n";
    expect(at(text)).toEqual(["5:5 a.md"]);
    expect(scanMarkdown(text).frontmatter).toEqual({ raw: "title: [x](no.md)", firstLine: 2 });
  });
  it("the frontmatter block is parseFrontmatter's: a closing fence of four dashes still closes it", () => {
    const s = scanMarkdown("---\ntitle: x\n----\n[a](a.md)\n");
    expect(s.frontmatter).toEqual({ raw: "title: x", firstLine: 2 });
    expect(at("---\ntitle: x\n----\n[a](a.md)\n")).toEqual(["4:5 a.md"]);
  });
  it("a fence in a block quote is a fence", () => {
    expect(dests("> ```\n> [a](a.md)\n> ```\n> [b](b.md)\n")).toEqual(["b.md"]);
  });
  it("a link in a block quote keeps its column", () => {
    expect(at("> see [b](b.md)\n")).toEqual(["1:11 b.md"]);
  });
  it("an HTML comment, one-line or spanning lines, is skipped", () => {
    expect(dests("a <!-- [x](x.md) --> [y](y.md)\n\n<!--\n[z](z.md)\n\n-->\n[w](w.md)\n")).toEqual(["y.md", "w.md"]);
  });
  it("a <pre> and a <code> block are skipped", () => {
    expect(dests("<pre>\n[x](x.md)\n</pre>\n<code>\n[y](y.md)\n</code>\n[z](z.md)\n")).toEqual(["z.md"]);
  });
  it("indented code outside a list is skipped", () => {
    expect(dests("text\n\n    [x](x.md)\n\n[y](y.md)\n")).toEqual(["y.md"]);
  });
  it("[^1]: and a task box are not definitions", () => {
    expect(dests("[^1]: word.md\n\n- [x]: done.md\n")).toEqual([]);
  });
});

describe("review round 1 — scanner nits", () => {
  it("a reference definition cannot interrupt a paragraph; consecutive definitions at its start all count", () => {
    expect(dests("intro text\n[ref]: nope.md\n")).toEqual([]);
    expect(dests("[a]: x.md\n[b]: y.md\n")).toEqual(["x.md", "y.md"]);
  });
  it("<codex> is not a <code> element", () => {
    expect(dests("<codex>[x](x.md)</codex>\n")).toEqual(["x.md"]);
  });
  it("a backslash before a closing backtick is literal inside the span", () => {
    expect(dests("`a\\` [x](x.md) `\n")).toEqual(["x.md"]);
  });
});

describe("§6.2 — anchors", () => {
  it("GitHub slugs, with -1 for a repeat, and <a id> / <a name>", () => {
    const s = scanMarkdown("# Hello World!\n\n## Hello World\n\nSetext Title\n---\n\n## `code` and [link](x.md)\n\n<a id=\"custom\"></a> <a name='other'>\n");
    expect([...s.anchors].sort()).toEqual(["code-and-link", "custom", "hello-world", "hello-world-1", "other", "setext-title"]);
  });
  it("a slug keeps letters of any script and drops punctuation", () => {
    expect(githubSlug("Café — 2. Über_x")).toBe("café--2-über_x");
  });
});

describe("§4.5 — leaked tags, outside code only", () => {
  const open = T("<", T("in", "voke") + ' name="x">');
  const close = T("</", T("function", "_calls") + ">");
  it("an opening and a closing tag are found by entry name, at their position", () => {
    const s = scanMarkdown(`ok\n\ntext ${open}\n${close}\n`);
    expect(s.tags).toEqual([
      { name: "invoke", line: 3, column: 6 },
      { name: "function-calls", line: 4, column: 1 },
    ]);
  });
  it("a prefixed form is found", () => {
    expect(scanMarkdown(T("<ab:", T("para", "meter") + ">")).tags.map((t) => t.name)).toEqual(["parameter"]);
  });
  it("in a code span, a fence or a comment it is documentation", () => {
    expect(scanMarkdown("`" + open + "`\n\n```\n" + close + "\n```\n<!-- " + open + " -->\n").tags).toEqual([]);
  });
  it("a longer element name is not the tag", () => {
    expect(scanMarkdown(T("<", T("in", "voker") + ">")).tags).toEqual([]);
  });
  it("each entry has a name and at least one element", () => {
    for (const t of LEAKED_TAGS) expect(t.name.length * t.elements.length).toBeGreaterThan(0);
  });
});

describe("§6.4 — readTarget", () => {
  it.each([
    ["https://h/x", true, { kind: "external" }],
    ["mailto:a@b", true, { kind: "external" }],
    ["//host/x", true, { kind: "external" }],
    ["{{key}}.md", true, { kind: "unchecked" }],
    ["C:\\x", true, { kind: "fault", fault: "windows-path" }],
    ["C:/x", true, { kind: "fault", fault: "windows-path" }],
    ["a\\b.md", true, { kind: "fault", fault: "backslash" }],
    ["x\\.md", true, { kind: "path", path: "x.md", fragment: null, badFragment: false }],
    ["x\\.md", false, { kind: "fault", fault: "backslash" }],
    ["%5c", true, { kind: "fault", fault: "backslash" }],
    ["%00", true, { kind: "fault", fault: "nul" }],
    ["a%zz.md", true, { kind: "fault", fault: "bad-percent" }],
    ["%2e%2e%2fx", true, { kind: "path", path: "../x", fragment: null, badFragment: false }],
    ["a&amp;b.md", true, { kind: "path", path: "a&b.md", fragment: null, badFragment: false }],
    ["a.md?plain=1", true, { kind: "path", path: "a.md", fragment: null, badFragment: false }],
    ["a.md?x#y", true, { kind: "path", path: "a.md", fragment: "y", badFragment: false }],
    ["#caf%C3%A9", true, { kind: "path", path: "", fragment: "café", badFragment: false }],
    ["a.md#%zz", true, { kind: "path", path: "a.md", fragment: null, badFragment: true }],
    ["", true, { kind: "path", path: "", fragment: null, badFragment: false }],
    ["?x", true, { kind: "path", path: "", fragment: null, badFragment: false }],
    ["/x", true, { kind: "path", path: "/x", fragment: null, badFragment: false }],
  ])("%s (markdown %s)", (dest, markdown, expected) => {
    expect(readTarget(dest, markdown)).toEqual(expected);
  });
});

describe("§11 item 4 — a pathological file finishes in linear time", () => {
  it("1 MiB of unmatched backtick runs", () => {
    const text = "`a``b```c".repeat(Math.ceil((1 << 20) / 9));
    const t0 = Date.now();
    blankCode(text);
    scanMarkdown(text);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
  it("1 MiB of [", () => {
    const t0 = Date.now();
    scanMarkdown("[".repeat(1 << 20));
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
  it("1 MiB of [](", () => {
    const t0 = Date.now();
    scanMarkdown("[](".repeat((1 << 20) / 3));
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});

describe("§6.2 — a pathological heading finishes in linear time (review round 1)", () => {
  const MiB = 1 << 20;
  it.each([
    ["# then [", "# " + "[".repeat(MiB)],
    ["# a, spaces, b", "# a" + " ".repeat(MiB) + "b"],
    ["# then <", "# " + "<".repeat(MiB)],
    ["a setext paragraph of [", "[".repeat(MiB) + "\n===\n"],
    ["nested destinations with no title", "[](x ".repeat(MiB / 5) + ")".repeat(MiB / 5)],
  ])("%s", (_label, text) => {
    const t0 = Date.now();
    scanMarkdown(text);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});
