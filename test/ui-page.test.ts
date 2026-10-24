import { describe, expect, it } from "vitest";
import { FILE_STATE_ORDER_MAP } from "../src/core/impact.js";
import { PAGE_STATES } from "../src/ui/page.js";
import { PAGE_CSS, PAGE_HTML, PAGE_JS, pageCss, pageJs } from "../src/ui/page.js";

// Spec 36 §7.4, §10.3 — a source check of the page. The CSP is what stops inline script even if this is fooled;
// what the page DOES with an answer is the by-hand run of spec §10.5 (step 36f).

// Banned APIs for both pageJs(false) and pageJs(true) — spec 40 §6.5 rules: no confirm(, alert(, prompt(
const BANNED_APIS = ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "setAttribute(\"on", "srcdoc", "javascript:", "confirm(", "alert(", "prompt("];

describe("craftar ui — the page's source", () => {
  it("the script never builds markup from a string, and never evaluates one", () => {
    for (const banned of BANNED_APIS)
      expect(PAGE_JS, banned).not.toContain(banned);
    expect(PAGE_JS).toContain("textContent");
  });

  it("the document has no inline script, no inline style, no handler attribute and no URL of another host", () => {
    expect(PAGE_HTML).toMatch(/^<!doctype html>/i);
    expect(PAGE_HTML).toMatch(/<script src="\/app\.js"><\/script>/);
    expect(PAGE_HTML.match(/<script\b/g)).toHaveLength(1);
    expect(PAGE_HTML).not.toMatch(/<script\b[^>]*>[^<]/);
    expect(PAGE_HTML).not.toMatch(/<style\b/);
    expect(PAGE_HTML).not.toMatch(/\sstyle\s*=/);
    expect(PAGE_HTML).not.toMatch(/\son[a-z]+\s*=/i);
    for (const text of [PAGE_HTML, PAGE_JS, PAGE_CSS]) {
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toMatch(/(^|[^:])\/\/[a-z0-9.-]+\.[a-z]{2,}/i); // a protocol-relative URL
    }
    expect(PAGE_CSS).not.toMatch(/@import|url\(/);
  });

  it("the token: read from the fragment, kept in sessionStorage, stripped from the address bar, sent as a header only", () => {
    expect(PAGE_JS).toContain("location.hash");
    expect(PAGE_JS).toContain("sessionStorage");
    expect(PAGE_JS).toContain("history.replaceState");
    expect(PAGE_JS).toContain("Authorization");
    expect(PAGE_JS).toContain("Bearer ");
    for (const banned of ["localStorage", "document.cookie", "?token=", "&token="]) expect(PAGE_JS, banned).not.toContain(banned);
  });

  it("the only requests are the page's own /api/ routes; a file's path is encoded", () => {
    const fetched = [...PAGE_JS.matchAll(/fetch\(\s*([^,)]+)/g)].map((m) => m[1].trim());
    expect(fetched.length).toBeGreaterThan(0);
    // every fetch goes through the one helper, whose argument is a path the page built
    expect(fetched).toEqual(["path"]);
    expect(PAGE_JS).toContain('"/api/workspaces"');
    expect(PAGE_JS).toContain("encodeURIComponent(");
    for (const banned of ["XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "import("]) expect(PAGE_JS, banned).not.toContain(banned);
  });

  it("nothing polls", () => {
    for (const banned of ["setInterval", "setTimeout"]) expect(PAGE_JS, banned).not.toContain(banned);
  });

  it("the sentences the spec fixes are on the page", () => {
    for (const s of ["status read offline from the Forge cache", "read from the cached copy of the Forge — not fetched", "craftar sync --workspace "]) expect(PAGE_JS, s).toContain(s);
  });

  it("the path in the command to copy is one shell word: single-quoted when it starts with /, double-quoted otherwise", () => {
    const src = /function shellWord\(text\) \{[\s\S]*?\n  \}/.exec(PAGE_JS);
    expect(src, "shellWord not found in the script").not.toBeNull();
    // The test evaluates the page's own function; the page itself never evaluates a string (first test of this file).
    const shellWord = new Function(`${src![0]}; return shellWord;`)() as (t: string) => string;
    expect(shellWord("/home/me/ws")).toBe("/home/me/ws");
    expect(shellWord("/home/me/my ws")).toBe("'/home/me/my ws'");
    expect(shellWord("/home/me/a$b`c")).toBe("'/home/me/a$b`c'");
    expect(shellWord("/home/me/it's")).toBe("'/home/me/it'\\''s'");
    expect(shellWord("/home/me/a\\b")).toBe("'/home/me/a\\b'");
    expect(shellWord("C:\\Users\\me\\ws")).toBe("C:\\Users\\me\\ws");
    expect(shellWord("C:\\Users\\me\\my ws")).toBe('"C:\\Users\\me\\my ws"');
    expect(shellWord('C:\\a "b" c')).toBe('"C:\\a \\"b\\" c"');
  });

  it("the page places every FileState once, from one record: its order, whether sync acts on it, whether it has a diff", () => {
    expect(Object.keys(PAGE_STATES).sort()).toEqual(Object.keys(FILE_STATE_ORDER_MAP).sort());
    // diff follows the core's one test (diffReport): unchanged and adopt have none.
    expect(Object.entries(PAGE_STATES).filter(([, v]) => !v.diff).map(([k]) => k).sort()).toEqual(["adopt", "unchanged"]);
    expect(Object.entries(PAGE_STATES).filter(([, v]) => v.syncActs).map(([k]) => k).sort()).toEqual(["adopt", "new", "orphan", "update"]);
    // The script no longer spells the lists itself.
    expect(PAGE_JS).not.toMatch(/var STATES = \["/);
    expect(PAGE_JS).not.toContain('f.state !== "unchanged"');
  });

  it("the page prints the core's refusal line, not one of its own", () => {
    expect(PAGE_JS).not.toContain("sync is refused");
    expect(PAGE_JS).toContain("doc.refused");
  });
});

// Spec 40 §6.5 — pageJs(writes) and pageCss(writes) tests
describe("pageJs and pageCss (spec 40 §6.5)", () => {
  it("pageJs(false) === PAGE_JS and pageCss(false) === PAGE_CSS", () => {
    expect(pageJs(false)).toBe(PAGE_JS);
    expect(pageCss(false)).toBe(PAGE_CSS);
  });

  it("pageJs(true) has no banned APIs (including confirm(, alert(, prompt()", () => {
    const jsTrue = pageJs(true);
    for (const banned of BANNED_APIS) {
      expect(jsTrue, banned).not.toContain(banned);
    }
    expect(jsTrue).toContain("textContent");
  });

  it("pageJs(false) contains none of POST, /sync, /discard, Discard edit; pageJs(true) contains each", () => {
    const jsFalse = pageJs(false);
    const jsTrue = pageJs(true);
    for (const term of ['"POST"', '"/sync"', '"/discard"', '"Discard edit"']) {
      expect(jsFalse, `pageJs(false) should not contain ${term}`).not.toContain(term);
      expect(jsTrue, `pageJs(true) should contain ${term}`).toContain(term);
    }
  });

  it('"Discard edit" in pageJs(true) appears only inside showDiff, not in fileRow bar-building code', () => {
    const jsTrue = pageJs(true);

    // Find the showDiff function's body
    const showDiffMatch = jsTrue.match(/function showDiff\([^)]*\)\s*\{/);
    expect(showDiffMatch, "showDiff function not found").not.toBeNull();
    const showDiffStart = showDiffMatch!.index!;

    // Find the fileRow function's body
    const fileRowMatch = jsTrue.match(/function fileRow\([^)]*\)\s*\{/);
    expect(fileRowMatch, "fileRow function not found").not.toBeNull();
    const fileRowStart = fileRowMatch!.index!;

    // The showDiff function comes after fileRow
    expect(showDiffStart).toBeGreaterThan(fileRowStart);

    // Find where "Discard edit" appears
    const discardIndex = jsTrue.indexOf('"Discard edit"');
    expect(discardIndex, '"Discard edit" not found in pageJs(true)').toBeGreaterThan(-1);

    // "Discard edit" should be after showDiff starts
    expect(discardIndex, '"Discard edit" should be inside showDiff function').toBeGreaterThan(showDiffStart);

    // Verify it's not in the bar-building code of fileRow (which is before showDiff)
    const fileRowToShowDiff = jsTrue.slice(fileRowStart, showDiffStart);
    expect(fileRowToShowDiff, '"Discard edit" should not appear in fileRow bar-building code').not.toContain('"Discard edit"');
  });

  it("pageJs(true) mentions the example settings file exclusion", () => {
    const jsTrue = pageJs(true);
    expect(jsTrue).toContain(".claude/settings.craftar.example.json");
  });

  it("pageCss(true) includes confirmation box styles", () => {
    const cssTrue = pageCss(true);
    expect(cssTrue).toContain(".confirm-overlay");
    expect(cssTrue).toContain(".confirm-box");
  });
});
