import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FILE_STATE_ORDER_MAP } from "../src/core/impact.js";
import { PAGE_STATES } from "../src/ui/page.js";
import { PAGE_CSS, PAGE_HTML, PAGE_JS, pageCss, pageJs } from "../src/ui/page.js";
import { EXAMPLE_SETTINGS } from "../src/emitters/shared.js";

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

  it("the source of page.ts uses EXAMPLE_SETTINGS from shared.ts, not a second spelling of the path", async () => {
    // Read the source file to ensure there is no literal spelling of the example path
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const source = await fs.readFile(path.join(__dirname, "..", "src", "ui", "page.ts"), "utf8");
    // The literal path should not appear in the source
    expect(source).not.toContain("settings.craftar.example.json");
    // And pageJs(true) should contain the path (interpolated from EXAMPLE_SETTINGS)
    expect(pageJs(true)).toContain(EXAMPLE_SETTINGS);
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

// A fake DOM environment for running pageJs in a test.
interface FakeNode {
  nodeType: 1;
  tagName: string;
  className: string;
  textContent: string;
  hidden: boolean;
  type?: string;
  parentNode: FakeNode | null;
  children: FakeNode[];
  listeners: Map<string, Array<() => void>>;
  appendChild(child: FakeNode): void;
  removeChild(child: FakeNode): void;
  addEventListener(event: string, handler: () => void): void;
  setAttribute(name: string, value: string): void;
  firstChild: FakeNode | null;
}

function fakeDom() {
  function createNode(tagName: string): FakeNode {
    const node: FakeNode = {
      nodeType: 1,
      tagName: tagName.toUpperCase(),
      className: "",
      textContent: "",
      hidden: false,
      parentNode: null,
      children: [],
      listeners: new Map(),
      appendChild(child: FakeNode) {
        child.parentNode = this;
        this.children.push(child);
      },
      removeChild(child: FakeNode) {
        const idx = this.children.indexOf(child);
        if (idx !== -1) this.children.splice(idx, 1);
        child.parentNode = null;
      },
      addEventListener(event: string, handler: () => void) {
        if (!this.listeners.has(event)) this.listeners.set(event, []);
        this.listeners.get(event)!.push(handler);
      },
      setAttribute(name: string, value: string) {
        if (name === "type") (this as any).type = value;
      },
      get firstChild(): FakeNode | null {
        return this.children[0] ?? null;
      },
    };
    return node;
  }

  const app = createNode("main");
  const body = createNode("body");

  const doc = {
    createElement: (tag: string) => createNode(tag),
    createTextNode: (text: string) => {
      const n = createNode("#text");
      n.textContent = text;
      return n;
    },
    getElementById: (id: string) => (id === "app" ? app : null),
    body,
  };

  const storage: Record<string, string> = {};
  const sessionStorage = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => { storage[key] = value; },
  };

  const location = { hash: "#tok", pathname: "/" };
  const history = { replaceState: () => {} };

  const posts: Array<{ url: string; body: unknown }> = [];
  type FetchRoutes = Record<string, unknown>;

  function makeFetch(routes: FetchRoutes, debug = false) {
    return (url: string, opts?: RequestInit) => {
      if (debug) console.log("FETCH:", url, opts?.method || "GET");
      if (opts?.method === "POST") {
        posts.push({ url, body: JSON.parse(opts.body as string) });
        const postRoutes = routes as Record<string, unknown>;
        // Find POST route (store URLs ending with /sync or /discard)
        for (const [pattern, response] of Object.entries(postRoutes)) {
          if (url.endsWith(pattern.split("*").pop()!)) {
            if (debug) console.log("  -> matched POST", pattern);
            return Promise.resolve({
              status: 200,
              json: () => Promise.resolve(response),
            });
          }
        }
      }
      // GET request
      for (const [pattern, response] of Object.entries(routes)) {
        if (url === pattern || url.startsWith(pattern + "?")) {
          if (debug) console.log("  -> matched GET", pattern);
          return Promise.resolve({
            status: 200,
            json: () => Promise.resolve(response),
          });
        }
      }
      if (debug) console.log("  -> 404");
      return Promise.resolve({ status: 404, json: () => Promise.resolve({ error: "not found" }) });
    };
  }

  // Find button by text content in a node tree
  function findButton(root: FakeNode, text: string): FakeNode | null {
    if (root.tagName === "BUTTON" && root.textContent === text) return root;
    for (const child of root.children) {
      const found = findButton(child, text);
      if (found) return found;
    }
    return null;
  }

  // Find a diff button that's in a bar containing a specific path
  function findDiffButtonForPath(root: FakeNode, path: string): FakeNode | null {
    // Find nodes containing the path
    function findRowWithPath(node: FakeNode): FakeNode | null {
      // A row has className "bar" or contains the path as text in a span
      for (const child of node.children) {
        if (child.textContent === path) {
          // Found the path span, return parent's parent (the box)
          return node;
        }
        const found = findRowWithPath(child);
        if (found) return found;
      }
      return null;
    }
    const row = findRowWithPath(root);
    if (!row) return null;
    return findButton(row, "diff");
  }

  // Find any node containing specific text
  function findNodeWithText(root: FakeNode, text: string): FakeNode | null {
    if (root.textContent.includes(text)) return root;
    for (const child of root.children) {
      const found = findNodeWithText(child, text);
      if (found) return found;
    }
    return null;
  }

  function click(node: FakeNode) {
    const handlers = node.listeners.get("click") ?? [];
    for (const h of handlers) h();
  }

  return { doc, body, app, location, history, sessionStorage, posts, makeFetch, findButton, findDiffButtonForPath, findNodeWithText, click };
}

// Let pending promises run
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("pageJs(true) driven in a stubbed DOM (spec 40 §6.5)", () => {
  const WS_ID = "0123456789abcdef";
  const DIGEST = "a".repeat(64);
  const DRIFT_PATH = ".claude/rules/edited.md";

  function makeRoutes(writes: boolean) {
    return {
      "/api/workspaces": {
        version: "0.0.0-test",
        registry: "/test/registry.json",
        fetch: false,
        writes,
        workspaces: [{
          id: WS_ID,
          name: "ws",
          path: "/test/ws",
          profile: "acme",
          recipes: ["base"],
          stack: {},
          targets: ["claude-code"],
          forge: { kind: "path", source: "../forge", ref: null, commit: null, key: "/test/forge" },
          lastSync: "2025-01-01T00:00:00Z",
          forgeMoved: null,
          status: "drift",
        }],
        warnings: [],
      },
      [`/api/workspaces/${WS_ID}`]: {
        id: WS_ID,
        path: "/test/ws",
        profile: "acme",
        recipes: ["base"],
        targets: ["claude-code"],
        forge: { kind: "path", source: "../forge", ref: null, commit: null },
        statuses: [
          { path: DRIFT_PATH, state: "drift", target: "claude-code", ingredient: "rule/edited" },
          { path: ".claude/rules/fresh.md", state: "new", target: "claude-code", ingredient: "rule/fresh" },
        ],
        warnings: [],
        unsetParams: [],
        refused: null,
        ...(writes ? { digest: DIGEST } : {}),
      },
      [`/api/workspaces/${WS_ID}/diff`]: {
        path: DRIFT_PATH,
        state: "drift",
        from: `${DRIFT_PATH} (disk, drift)`,
        to: `${DRIFT_PATH} (forge)`,
        hidden: false,
        note: null,
        diff: "- a\n+ b",
      },
      // POST routes
      [`/api/workspaces/${WS_ID}/discard`]: {
        written: [DRIFT_PATH],
        removed: [],
        skipped: [],
        registry: "updated",
      },
      [`/api/workspaces/${WS_ID}/sync`]: {
        profile: "acme",
        recipes: ["base"],
        targets: ["claude-code"],
        written: [".claude/rules/fresh.md"],
        removed: [],
        skipped: [{ path: DRIFT_PATH, reason: "drift" }],
        registry: "updated",
      },
    };
  }

  it("Discard edit: clicking Discard edit then Confirm posts to /discard with correct body", async () => {
    const { doc, body, app, location, history, sessionStorage, posts, makeFetch, findButton, findDiffButtonForPath, click } = fakeDom();
    const routes = makeRoutes(true);
    const fetch = makeFetch(routes);

    // Run the script
    const src = pageJs(true);
    new Function("document", "location", "history", "sessionStorage", "fetch", src)(doc, location, history, sessionStorage, fetch);

    // Wait for initial load
    await tick(); await tick(); await tick();

    // Click the workspace link (button with text "ws")
    const wsLink = findButton(app, "ws");
    expect(wsLink, "workspace link should exist").not.toBeNull();
    click(wsLink!);

    await tick(); await tick(); await tick();

    // Click the diff button for the DRIFT file (not just any diff button)
    const diffBtn = findDiffButtonForPath(app, DRIFT_PATH);
    expect(diffBtn, "diff button for drift file should exist").not.toBeNull();
    click(diffBtn!);

    await tick(); await tick(); await tick();

    // Click Discard edit (it's added to the detail area inside app)
    const discardBtn = findButton(app, "Discard edit");
    expect(discardBtn, "Discard edit button should exist").not.toBeNull();
    click(discardBtn!);

    // Click Confirm in the overlay (added to document.body)
    const confirmBtn = findButton(body, "Confirm");
    expect(confirmBtn, "Confirm button should exist").not.toBeNull();
    click(confirmBtn!);

    await tick(); await tick(); await tick();

    // Check POST was made
    const discardPost = posts.find((p) => p.url.includes("/discard"));
    expect(discardPost, "should POST to /discard").not.toBeUndefined();
    expect(discardPost!.url).toBe(`/api/workspaces/${WS_ID}/discard`);
    expect(discardPost!.body).toEqual({ digest: DIGEST, path: DRIFT_PATH });
  });

  it("Sync: clicking Sync then Confirm posts to /sync with correct body", async () => {
    const { doc, body, app, location, history, sessionStorage, posts, makeFetch, findButton, click } = fakeDom();
    const routes = makeRoutes(true);
    const fetch = makeFetch(routes);

    const src = pageJs(true);
    new Function("document", "location", "history", "sessionStorage", "fetch", src)(doc, location, history, sessionStorage, fetch);

    await tick(); await tick(); await tick();

    // Click workspace link
    const wsLink = findButton(app, "ws");
    click(wsLink!);

    await tick(); await tick(); await tick();

    // Click Sync (it's added inside the workspace view inside app)
    const syncBtn = findButton(app, "Sync");
    expect(syncBtn, "Sync button should exist").not.toBeNull();
    click(syncBtn!);

    // Click Confirm (in the overlay on document.body)
    const confirmBtn = findButton(body, "Confirm");
    click(confirmBtn!);

    await tick(); await tick(); await tick();

    // Check POST was made
    const syncPost = posts.find((p) => p.url.includes("/sync"));
    expect(syncPost, "should POST to /sync").not.toBeUndefined();
    expect(syncPost!.url).toBe(`/api/workspaces/${WS_ID}/sync`);
    expect(syncPost!.body).toEqual({ digest: DIGEST });
  });

  it("writes:false — no Sync or Discard edit buttons", async () => {
    const { doc, body, app, location, history, sessionStorage, makeFetch, findButton, click } = fakeDom();
    const routes = makeRoutes(false); // writes: false
    const fetch = makeFetch(routes);

    // Use pageJs(true) but with writes:false from the API
    const src = pageJs(true);
    new Function("document", "location", "history", "sessionStorage", "fetch", src)(doc, location, history, sessionStorage, fetch);

    await tick(); await tick(); await tick();

    // Click workspace link
    const wsLink = findButton(app, "ws");
    click(wsLink!);

    await tick(); await tick(); await tick();

    // Sync button should not exist (no digest in the response)
    const syncBtn = findButton(app, "Sync");
    expect(syncBtn, "Sync button should not exist without digest").toBeNull();

    // Click diff to open detail
    const diffBtn = findButton(app, "diff");
    click(diffBtn!);

    await tick(); await tick(); await tick();

    // Discard edit should not exist (no digest)
    const discardBtn = findButton(app, "Discard edit");
    expect(discardBtn, "Discard edit button should not exist without digest").toBeNull();
  });

  it("result message survives reload after discard", async () => {
    const { doc, body, app, location, history, sessionStorage, makeFetch, findButton, findDiffButtonForPath, findNodeWithText, click } = fakeDom();
    const routes = makeRoutes(true);
    const fetch = makeFetch(routes);

    const src = pageJs(true);
    new Function("document", "location", "history", "sessionStorage", "fetch", src)(doc, location, history, sessionStorage, fetch);

    await tick(); await tick(); await tick();

    // Click workspace link
    const wsLink = findButton(app, "ws");
    click(wsLink!);

    await tick(); await tick(); await tick();

    // Click diff for the drift file
    const diffBtn = findDiffButtonForPath(app, DRIFT_PATH);
    expect(diffBtn, "diff button for drift file should exist").not.toBeNull();
    click(diffBtn!);

    await tick(); await tick(); await tick();

    // Click Discard edit
    const discardBtn = findButton(app, "Discard edit");
    expect(discardBtn, "Discard edit button should exist").not.toBeNull();
    click(discardBtn!);

    // Click Confirm
    const confirmBtn = findButton(body, "Confirm");
    expect(confirmBtn, "Confirm button should exist").not.toBeNull();
    click(confirmBtn!);

    await tick(); await tick(); await tick(); await tick();

    // After the reload, the result message should be visible
    const resultNode = findNodeWithText(app, "wrote 1, removed 0, skipped 0");
    expect(resultNode, "result message should survive the reload").not.toBeNull();
  });
});
