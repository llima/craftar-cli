import { describe, expect, it } from "vitest";
import { LEAKED_TAGS, blankCode, codeSpanRanges, githubSlug, readTarget, scanMarkdown } from "../src/core/docs-validate.js";

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

describe("review round 2 — a fence inside a list item", () => {
  it("a fence indented to an ordered item's content is a fence, a blank line inside included", () => {
    expect(dests("1. x\n\n    ```\n    [x](missing.md)\n\n    ```\n\ntext [y](y.md)\n")).toEqual(["y.md"]);
  });
  it("a fence in a nested bullet is a fence", () => {
    expect(dests("- a\n  - b\n\n      ```\n      [x](m.md)\n\n      ```\n")).toEqual([]);
  });
  it("at the top level a closer indented four spaces still does not close", () => {
    expect(dests("```\n    ```\n[x](x.md)\n```\n[y](y.md)\n")).toEqual(["y.md"]);
  });
});

describe("review round 2 — scanner nits", () => {
  it("a one-line <pre> element inside a paragraph is blanked, as <code> is", () => {
    expect(dests("see <pre>[x](x.md)</pre> and [y](y.md)\n")).toEqual(["y.md"]);
  });
});

describe("review round 3", () => {
  it("a character whose lower case is longer (İ) before <code> does not shift what is blanked", () => {
    const tag = "<" + ["in", "voke"].join("") + ">";
    const s = scanMarkdown(`İ <code>[x](m.md) ${tag}</code> [y](y.md)\n`);
    expect(s.links.map((l) => l.dest)).toEqual(["y.md"]);
    expect(s.tags).toEqual([]);
  });
  it("a fence on the list item's own line is a fence", () => {
    expect(dests("- ```\n  [x](m.md)\n  ```\n[y](y.md)\n")).toEqual(["y.md"]);
  });
});

describe("review round 4 — a fence ends with its container", () => {
  it("an unclosed fence in a list item ends at a line indented less than the item", () => {
    expect(dests("- ```\n  code\n\nNext [z](z.md)\n")).toEqual(["z.md"]);
    expect(dests("1. x\n\n    ```\n    code\n\nNext [z](z.md)\n")).toEqual(["z.md"]);
  });
  it("an unclosed fence in a block quote ends at an unquoted line", () => {
    expect(dests("> ```\n> code\n\nplain [q](q.md)\n")).toEqual(["q.md"]);
  });
  it("a blank line inside an item's fence does not end it", () => {
    expect(dests("- ```\n  a\n\n  [x](m.md)\n  ```\n")).toEqual([]);
  });
});

describe("review round 5 — a top-level fence after a list", () => {
  it("a fence at column 0 after a list item, with a blank line, is a top-level fence", () => {
    expect(at("- item\n\n```js\ncode [a](a.md)\n```\n\n[b](b.md)\n")).toEqual(["7:5 b.md"]);
  });
  it("the same with no blank line", () => {
    expect(at("- item\n```js\ncode [a](a.md)\n```\n\n[b](b.md)\n")).toEqual(["6:5 b.md"]);
  });
  it("after an ordered item", () => {
    expect(dests("1. item\n\n```\n[a](a.md)\n```\n")).toEqual([]);
  });
  it("a tab inside an item's fence counts as the item's indent", () => {
    expect(at("- ```\n\t[a](a.md)\n  ```\n[b](b.md)\n")).toEqual(["4:5 b.md"]);
  });
});

describe("review round 6 — a tab-indented fence in a list item", () => {
  it("a fence indented by a tab opens inside the item", () => {
    expect(dests("1. item\n\n\t~~~\n\t[a](x.md)\n\t~~~\n")).toEqual([]);
  });
  it("a closer indented by a tab closes the item's fence", () => {
    expect(dests("1. item\n   ~~~\n   x\n\t~~~\n   [b](y.md)\n")).toEqual(["y.md"]);
    expect(dests("- item\n  ~~~\n  x\n\t~~~\n  [b](y.md)\n")).toEqual(["y.md"]);
  });
});

describe("review round 7 — tabs counted from their real column", () => {
  it("a tab after a block-quote marker makes the line a fence", () => {
    expect(dests("> \t~~~\n> [a](x.md)\n> ~~~\n")).toEqual([]);
    expect(dests(">\t~~~\n> [a](x.md)\n> ~~~\n")).toEqual([]);
  });
  it("a tab-indented closer in a quote closes the fence", () => {
    expect(dests("> ~~~\n> a\n> \t~~~\n> [b](y.md)\n\n[c](z.md)\n")).toEqual(["y.md", "z.md"]);
  });
  it("a list marker followed by a tab puts the content at column 4", () => {
    expect(dests("1.\titem\n\n   ```\n[a](x.md)\n   ```\n")).toEqual([]);
  });
  it("earlier cases hold: a quoted item, round 5's tab case", () => {
    expect(dests("> - item\n>   ~~~\n>   x\n> \t~~~\n>   [b](y.md)\n")).toEqual(["y.md"]);
    expect(at("- ```\n\t[a](a.md)\n  ```\n[b](b.md)\n")).toEqual(["4:5 b.md"]);
  });
});

describe("review round 8 — indented code read in columns after a quote marker", () => {
  it("a tab after > is two or three columns: a paragraph, not indented code", () => {
    expect(dests(">\t[a](x.md)\n")).toEqual(["x.md"]);
    expect(dests("> \t[a](x.md)\n")).toEqual(["x.md"]);
    expect(dests(">\t- [a](x.md)\n")).toEqual(["x.md"]);
  });
  it("a heading after > and a tab gives its anchor", () => {
    expect([...scanMarkdown("> \t# Head\n").anchors]).toEqual(["head"]);
  });
  it("a quoted list item after a tab keeps its content column", () => {
    expect(at(">\t- see [a](x.md)\n")).toEqual(["1:13 x.md"]);
  });
  it("four columns after > is still indented code", () => {
    expect(dests(">     [a](x.md)\n")).toEqual([]);
    expect(dests("\t[a](x.md)\n")).toEqual([]);
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
  it("300 000 lone closing tags in one paragraph", () => {
    const N = 300_000;
    const lines: string[] = [];
    for (let i = 0; i < N; i++) lines.push(i % 2 === 0 ? T("</", T("in", "voke") + ">") : T("</", "content>"));
    const text = lines.join("\n");
    const t0 = Date.now();
    const s = scanMarkdown(text);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(s.tags.length).toBe(N);
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

describe("spec 47 §6.3 — a code span's text enters the slug", () => {
  it("a heading with a `Result<T>` code span gives returns-resultt", () => {
    expect(githubSlug("2026-01-02 — Acme API returns `Result<T>` (PR #7)")).toBe("2026-01-02--acme-api-returns-resultt-pr-7");
  });
  it("a code span holding `Acme.<Module>.Tools` enters the slug literally", () => {
    expect(githubSlug("Optional layer — `Acme.<Module>.Tools`")).toBe("optional-layer--acmemoduletools");
  });
  it("Foo <b>bar</b> gives foo-bar — HTML outside code still dropped (guard, passes on HEAD)", () => {
    expect(githubSlug("Foo <b>bar</b>")).toBe("foo-bar");
  });
  it("Use `[a](b)` here gives use-ab-here — link syntax in code span is literal", () => {
    expect(githubSlug("Use `[a](b)` here")).toBe("use-ab-here");
  });
  it("Odd `Result<T> here gives odd-result-here — unclosed backtick is no span (guard, passes on HEAD)", () => {
    expect(githubSlug("Odd `Result<T> here")).toBe("odd-result-here");
  });
  it("Escaped \\<T\\> type gives escaped-t-type — backslash-escaped brackets outside code drop", () => {
    expect(githubSlug("Escaped \\<T\\> type")).toBe("escaped-t-type");
  });
  it("Pad `` `x` `` end gives pad-x-end — double-backtick span with padding spaces", () => {
    expect(githubSlug("Pad `` `x` `` end")).toBe("pad-x-end");
  });
  it("scanMarkdown returns-resultt anchors for duplicate headings", () => {
    const s = scanMarkdown("## Returns `Result<T>`\n\n## Returns `Result<T>`\n");
    expect([...s.anchors]).toContain("returns-resultt");
    expect([...s.anchors]).toContain("returns-resultt-1");
    expect([...s.anchors]).not.toContain("returns-result");
  });
  it("codeSpanRanges extracts ranges correctly", () => {
    expect(codeSpanRanges("a `b` c ``d`` e")).toEqual([
      { start: 2, end: 5, contentStart: 3, contentEnd: 4 },
      { start: 8, end: 13, contentStart: 10, contentEnd: 11 },
    ]);
  });
  it("an escaped _ is kept (GitHub keeps it)", () => {
    expect(githubSlug("Use \\_private here")).toBe("use-_private-here");
  });
  it("an escaped - is kept (GitHub keeps it)", () => {
    expect(githubSlug("A \\- B")).toBe("a---b");
  });
  it("two backslashes then a real <b> tag: the < is not escaped, the tag is HTML", () => {
    expect(githubSlug("Path \\\\<b>x</b>")).toBe("path-x");
  });
  it("a link whose text is a code span: the strip does not match across the span", () => {
    expect(githubSlug("[`a`](b)")).toBe("a");
  });
  it("a link with a code span inside running text", () => {
    expect(githubSlug("Use [`craftar sync`](https://x.y/z) now")).toBe("use-craftar-sync-now");
  });
  it("an HTML tag whose attribute holds a code span", () => {
    expect(githubSlug('<a id="`x`">t</a>')).toBe("t");
  });
  it("plain words with no code span", () => {
    expect(githubSlug("A x b")).toBe("a-x-b");
  });
});

describe("spec 47 §4.5 — a line that is only a closing tag", () => {
  const closeOf = (x: string) => T("</", x + ">");

  it("content alone gives one hit", () => {
    expect(scanMarkdown("text\n\n" + closeOf("content") + "\n").tags).toEqual([{ name: "content", line: 3, column: 1 }]);
  });
  it("thinking alone gives one hit", () => {
    expect(scanMarkdown("text\n\n" + closeOf("thinking") + "\n").tags).toEqual([{ name: "thinking", line: 3, column: 1 }]);
  });
  it(["ant", "ml"].join("") + ":foo alone gives one hit, name " + ["ant", "ml"].join(""), () => {
    expect(scanMarkdown("  " + T("</", T("ant", "ml") + ":foo>") + "\t").tags).toEqual([{ name: ["ant", "ml"].join(""), line: 1, column: 3 }]);
  });
  it(["ant", "ml"].join("") + ":invoke alone gives exactly one hit, name invoke (no double)", () => {
    const s = scanMarkdown(T("</", T("ant", "ml") + ":" + T("in", "voke") + ">"));
    expect(s.tags).toHaveLength(1);
    expect(s.tags[0].name).toBe(T("in", "voke"));
  });
  it("the pair: invoke line 2, content line 3", () => {
    const s = scanMarkdown("x\n" + T("</", T("in", "voke") + ">") + "\n" + closeOf("content") + "\n");
    expect(s.tags).toEqual([
      { name: T("in", "voke"), line: 2, column: 1 },
      { name: "content", line: 3, column: 1 },
    ]);
  });
  it("CRLF: content on line 3", () => {
    expect(scanMarkdown("x\r\n\r\n" + closeOf("content") + "\r\n").tags).toEqual([{ name: "content", line: 3, column: 1 }]);
  });
  it("file ends with the tag and no newline", () => {
    expect(scanMarkdown("x\n\n" + closeOf("content")).tags).toEqual([{ name: "content", line: 3, column: 1 }]);
  });
  it("not flagged: text before and after", () => {
    expect(scanMarkdown("text " + closeOf("content") + " more").tags).toEqual([]);
  });
  it("not flagged: opening content alone", () => {
    expect(scanMarkdown(T("<", "content>")).tags).toEqual([]);
  });
  it("not flagged: contents (wrong name)", () => {
    expect(scanMarkdown(closeOf("contents")).tags).toEqual([]);
  });
  it("not flagged: Content (case)", () => {
    expect(scanMarkdown(closeOf("Content")).tags).toEqual([]);
  });
  it("not flagged: content inside a fence", () => {
    expect(scanMarkdown("```\n" + closeOf("content") + "\n```\n").tags).toEqual([]);
  });
  it("not flagged: content inside a code span", () => {
    expect(scanMarkdown("`" + closeOf("content") + "`").tags).toEqual([]);
  });
  it("not flagged: content inside an HTML comment", () => {
    expect(scanMarkdown("<!-- " + closeOf("content") + " -->").tags).toEqual([]);
  });
  it("not flagged: content as indented code (4 spaces after blank)", () => {
    expect(scanMarkdown("text\n\n    " + closeOf("content") + "\n").tags).toEqual([]);
  });
  it("not flagged: alone decided on the line as written — a code span then the tag", () => {
    expect(scanMarkdown("`x` " + closeOf("content")).tags).toEqual([]);
  });
  it("not flagged: an HTML comment then the tag on one line", () => {
    expect(scanMarkdown("<!-- c --> " + closeOf("thinking")).tags).toEqual([]);
  });
  it("not flagged: a <code> element then the tag on one line (no content hit)", () => {
    const s = scanMarkdown(T("<", "code>y") + T("</", "code>") + " " + closeOf("content"));
    expect(s.tags.filter((t) => t.name === "content")).toEqual([]);
  });
  it("not flagged: a list item whose content is the tag", () => {
    expect(scanMarkdown("- " + closeOf("content")).tags).toEqual([]);
  });
  it("not flagged: a quote whose content is the tag", () => {
    expect(scanMarkdown("> " + closeOf("thinking")).tags).toEqual([]);
  });
  it("not flagged: a heading whose text is the tag", () => {
    expect(scanMarkdown("# " + closeOf("content")).tags).toEqual([]);
  });
  it("guard: a lazy line in a paragraph (col0 0) still gives one hit", () => {
    expect(scanMarkdown("x\n" + closeOf("content")).tags).toEqual([{ name: "content", line: 2, column: 1 }]);
  });
  it("guard: two leading spaces (not indented code) still gives one hit", () => {
    expect(scanMarkdown("text\n\n  " + closeOf("content")).tags).toEqual([{ name: "content", line: 3, column: 3 }]);
  });
  it("guard: the text line of a setext heading, written alone, mirrors the grep and gives one hit", () => {
    expect(scanMarkdown(closeOf("content") + "\n---\n").tags).toEqual([{ name: "content", line: 1, column: 1 }]);
  });
  it.each([
    [T("in", "voke"), T("in", "voke"), "already caught"],
    [T("para", "meter"), T("para", "meter"), "already caught"],
    [T("function", "_calls"), "function-calls", "already caught"],
    ["content", "content", "new"],
    ["thinking", "thinking", "new"],
    [T("ant", "ml") + ":x", T("ant", "ml"), "new"],
  ])("table: %s closing tag alone → name %s (%s)", (element, expectedName, _status) => {
    const s = scanMarkdown(closeOf(element));
    expect(s.tags).toHaveLength(1);
    expect(s.tags[0].name).toBe(expectedName);
  });
});

describe("R2-B3 — blankCode matches origin/main exactly", () => {
  // Expected values computed from origin/main's blankCode (commit before f9d5ecf).
  // The sequential pass order matters: <!-- then <code then <pre, each over the prior's output.
  it.each([
    ["a <!-- <code>x</code> --> b [l](y.md)", "a                         b [l](y.md)"],
    ["<code> <pre> </code> [q](w.md)", "                     [q](w.md)"],
    ["a <code><!-- x</code> --> [l](z.md)", "a                                  "],
    ["<!-- --> <code>y</code>", "                       "],
    ["<pre> <!-- </pre> --> x", "                       "],
    ["<code>a<!-- b</code>-->c", "                        "],
    ["<!-- <pre>x</pre> --> [l](a.md)", "                      [l](a.md)"],
    ["<pre><code></pre></code>", "                        "],
    ["a<CODE>X</CODE>b", "a              b"],
    ["<!-- unclosed", "             "],
    ["<code> unclosed", "               "],
    ["<pre> <!-- <code>x</code> --> </pre>", "                                    "],
    ["<code><pre></code></pre>", "                  </pre>"],
  ])("blankCode(%j) === %j", (input, expected) => {
    const result = blankCode(input);
    expect(result).toBe(expected);
    expect(result.length).toBe(input.length);
  });
});

describe("R2-B1 — shortcut link branch stays linear", () => {
  it("handles 200K nested brackets in linear time", () => {
    // 200K opening brackets followed by 200K closing brackets - should not be O(n²)
    const input = "[".repeat(200_000) + "]".repeat(200_000);
    const start = performance.now();
    // scanMarkdown calls scanParagraph which has the bracket loop
    const result = scanMarkdown(input);
    const elapsed = performance.now() - start;
    // Should complete in under 500ms even for 400K chars; quadratic would take many seconds
    expect(elapsed).toBeLessThan(500);
    // No links found (no valid markdown links in this input)
    expect(result.links).toEqual([]);
  });
});
