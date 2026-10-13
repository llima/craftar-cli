import { describe, expect, it } from "vitest";
import { PAGE_CSS, PAGE_HTML, PAGE_JS } from "../src/ui/page.js";

// Spec 36 §7.4, §10.3 — a source check of the page. The CSP is what stops inline script even if this is fooled;
// what the page DOES with an answer is the by-hand run of spec §10.5 (step 36f).

describe("craftar ui — the page's source", () => {
  it("the script never builds markup from a string, and never evaluates one", () => {
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "setAttribute(\"on", "srcdoc", "javascript:"])
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
});
