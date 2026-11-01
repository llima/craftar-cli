import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { POLICY, nameShown, validateDocs, type DocsCheck, type DocsReport } from "../src/core/docs-validate.js";
import { profile, recipe, rule, scenario, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";
import { remoteForge } from "./helpers/remote.js";

// Spec 47 §4, §5.3, §7, §8 — the checks over a real directory, through validateDocs.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const M = ["ZZ", "MARKER", "ZZ"].join("");
const TOKEN = "ghp_" + "x".repeat(36);

const forgeWith = (docs?: unknown, extra: Record<string, unknown> = {}): ForgeSpec => ({
  ingredients: [rule("style", "# Style\n")],
  recipes: [recipe("base", ["rule/style"])],
  profiles: [profile("acme", ["base"], ["claude-code"], { ...(docs === undefined ? {} : { docs }), ...extra })],
});

function git(dir: string, ...args: string[]) {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(dir, ".no-global"), GIT_CONFIG_NOSYSTEM: "1" } });
}

/** A workspace with `files`, a Forge whose profile holds `docs` (no key when undefined), and a git repository unless `repo: false`. */
async function ws(files: Record<string, string | Buffer>, o: { docs?: unknown; repo?: boolean; extra?: Record<string, unknown>; config?: Record<string, unknown> } = {}) {
  const s = await scenario(forgeWith(o.docs, o.extra), { config: { profile: "acme", ...o.config }, files });
  cleanups.push(() => removeWithRetry(s.root));
  if (o.repo !== false) git(s.wsRoot, "init", "-q");
  return s;
}
const run = (root: string, o: Partial<Parameters<typeof validateDocs>[0]> = {}): Promise<DocsReport> =>
  validateDocs({ root, version: "test", fetch: false, strict: false, limit: null, configured: true, typedWorkspace: null, home: process.env.CRAFTAR_HOME, ...o });
const findings = (r: DocsReport, id?: string) => r.checks.filter((c) => c.level !== "ok" && (id === undefined || c.id === id));
const brief = (c: DocsCheck) => `${c.level} ${c.id} ${c.path}${c.line === null ? "" : `:${c.line}:${c.column}`} ${c.message}`;

describe("§4.3 links — each row", () => {
  it("a tree with nothing wrong: no warn, no error, one ok per always-on check and policy", async () => {
    const s = await ws({ "docs/a.md": "# A\n\n[b](b.md) [self](#a) [dir](../docs) [ext](https://h/x) [root](/docs/b.md#b)\n", "docs/b.md": "# B\n", "README.md": "[a](docs/a.md)\n" });
    const r = await run(s.wsRoot);
    expect(findings(r)).toEqual([]);
    expect(r.checks.map((c) => `${c.level} ${c.id}`)).toEqual(["ok links", "ok leaked-tags", "ok policy"]);
    expect(r.checks[0].message).toBe("5 links in 3 files");
    expect(r.scanned).toBe(3);
  });

  it.each([
    ["missing", "[x](nope.md)", "error links docs/a.md:1:5 target does not exist"],
    ["case", "[x](B.md)", "error links docs/a.md:1:5 target's case differs from the file on disk"],
    ["leaves", "[x](../../outside.md)", "error links docs/a.md:1:5 target leaves the workspace"],
    ["backslash", "[x](sub\\b.md)", "error links docs/a.md:1:5 target holds a backslash"],
    ["NUL", "[x](b%00.md)", "error links docs/a.md:1:5 target holds a NUL character"],
    ["Windows", "[x](C:/b.md)", "error links docs/a.md:1:5 target is an absolute Windows path"],
    ["bad percent", "[x](b%zz.md)", "error links docs/a.md:1:5 target's percent-encoding does not decode"],
    ["fragment", "[x](b.md#nope)", "warn links docs/a.md:1:5 fragment not found in the target"],
    ["bad fragment", "[x](b.md#%zz)", "warn links docs/a.md:1:5 fragment's percent-encoding does not decode"],
    ["climbing percent", "[x](%2e%2e%2f%2e%2e%2fx.md)", "error links docs/a.md:1:5 target leaves the workspace"],
    ["percent backslash", "[x](a%5cb.md)", "error links docs/a.md:1:5 target holds a backslash"],
    ["escaped in Markdown is fine", "[x](b\\.md)", null],
    ["escaped in href is a backslash", '<a href="b\\.md">x</a>', "error links docs/a.md:1:10 target holds a backslash"],
    ["query is cut", "[x](b.md?plain=1)", null],
    ["query then fragment", "[x](b.md?x#b)", null],
    ["{{key}} is not checked", "[x]({{key}}.md)", null],
    ["&amp; decoded", "[x](a&amp;b.md)", null],
    ["empty is the file itself", "[x]() [y](?x)", null],
    ["//host is external", "[x](//host/x)", null],
    ["a self fragment that decodes", "# Café\n\n[x](#caf%C3%A9)", null],
  ])("%s", async (_label, body, expected) => {
    const s = await ws({ "docs/a.md": body + "\n", "docs/b.md": "# B\n", "docs/a&b.md": "x\n" });
    const r = await run(s.wsRoot);
    expect(findings(r).map(brief)).toEqual(expected === null ? [] : [expected]);
  });

  it("a link through a symbolic link is a warn and is not followed", async () => {
    const s = await ws({ "docs/a.md": "[x](lnk/b.md) [y](lnk)\n", "real/b.md": "x\n" });
    await fs.symlink(path.join(s.wsRoot, "real"), path.join(s.wsRoot, "docs", "lnk"), "junction");
    const r = await run(s.wsRoot);
    expect(findings(r, "links").map(brief)).toEqual([
      "warn links docs/a.md:1:5 target is reached through a symbolic link, not followed",
      "warn links docs/a.md:1:19 target is reached through a symbolic link, not followed",
    ]);
  });

  it("a fragment into a file the walk did not read gets no finding, whether or not it decodes", async () => {
    const s = await ws({ "docs/a.md": "[x](../projects/x/README.md#nope) [y](../projects/x/README.md#%zz)\n", "projects/x/README.md": "# Other\n" });
    expect(findings(await run(s.wsRoot))).toEqual([]);
  });

  it("a fragment into an encoding-skipped file has only the encoding line", async () => {
    const s = await ws({ "docs/a.md": "[x](u.md#nope)\n", "docs/u.md": Buffer.from([0xff, 0xfe, 0x41, 0x00]) });
    expect(findings(await run(s.wsRoot)).map(brief)).toEqual(["warn encoding docs/u.md not valid UTF-8: not scanned"]);
  });

  it("two names differing only in case are each their own file (case-sensitive disk only)", async () => {
    const s = await ws({ "docs/a.md": "[x](b.md) [y](B.md)\n", "docs/b.md": "x\n" });
    const caseSensitive = await fs.writeFile(path.join(s.wsRoot, "docs", "B.md"), "y\n").then(async () => (await fs.readdir(path.join(s.wsRoot, "docs"))).length === 3);
    if (!caseSensitive) return; // a case-insensitive disk holds one file; the case row above covers it
    const r = await run(s.wsRoot);
    expect(findings(r)).toEqual([]);
    expect(r.scanned).toBe(3);
  });
});

describe("§4.3 leaked-tags, encoding, scope", () => {
  it("a tag outside code is an error naming its entry; in code it is nothing", async () => {
    const tag = "<" + ["in", "voke"].join("") + ">";
    const s = await ws({ ".claude/rules/x.md": `ok ${tag}\n\n\`${tag}\`\n`, "CLAUDE.md": "```\n" + tag + "\n```\n" });
    expect(findings(await run(s.wsRoot)).map(brief)).toEqual(["error leaked-tags .claude/rules/x.md:1:4 tool-call tag outside code (invoke)"]);
  });

  it("over 8 MiB is reported and not scanned", async () => {
    const s = await ws({ "docs/big.md": "[x](nope.md)\n" + "a".repeat(8 * 1024 * 1024) });
    const r = await run(s.wsRoot);
    expect(findings(r).map(brief)).toEqual(["warn encoding docs/big.md over 8 MiB: not scanned"]);
    expect(r.scanned).toBe(0);
  });

  it("a UTF-16 file with its BOM counts as not UTF-8", async () => {
    const s = await ws({ "docs/w.md": Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("\u0000[\u0000x", "latin1")]) });
    expect(findings(await run(s.wsRoot)).map(brief)).toEqual(["warn encoding docs/w.md not valid UTF-8: not scanned"]);
  });

  it("a symbolic link met in the walk is one scope warn, never entered — a directory link outside included", async () => {
    const outside = await tmpDir();
    cleanups.push(() => removeWithRetry(outside));
    await writeFiles(outside, { "secret.md": `[x](${M}.md)\n` });
    const s = await ws({ "docs/a.md": "x\n" });
    await fs.symlink(outside, path.join(s.wsRoot, "docs", "out"), "junction");
    const r = await run(s.wsRoot);
    expect(findings(r).map(brief)).toEqual(["warn scope docs/out symbolic link not followed: not scanned"]);
    expect(JSON.stringify(r)).not.toContain(M);
  });

  it("a workspace that is not a git repository scans everything and says so once", async () => {
    const s = await ws({ "docs/a.md": "x\n" }, { repo: false });
    const r = await run(s.wsRoot);
    expect(findings(r).map(brief)).toEqual(["warn scope null git could not say which files it ignores: every file was scanned"]);
  });

  it("a file git ignores is not scanned; a tree with nothing ignored has no finding", async () => {
    const s = await ws({ "docs/a.md": "x\n", "docs/private/notes.md": "[x](nope.md)\n", ".gitignore": "docs/private/\n" });
    const r = await run(s.wsRoot);
    expect(findings(r)).toEqual([]);
    expect(r.scanned).toBe(1);
    await fs.writeFile(path.join(s.wsRoot, ".gitignore"), "");
    expect(findings(await run(s.wsRoot)).map(brief)).toEqual(["error links docs/private/notes.md:1:5 target does not exist"]);
  });

  it("a file name with a space and a newline goes through -z to git", async () => {
    if (process.platform === "win32") return; // no newline in a Windows file name
    const s = await ws({ "docs/a b.md": "[x](nope.md)\n", "docs/c\nd.md": "[x](nope.md)\n", ".gitignore": "docs/a b.md\ndocs/c?d.md\n" });
    const r = await run(s.wsRoot);
    expect(findings(r)).toEqual([]);
    expect(r.scanned).toBe(0);
  });
});

describe("§7 — what a finding prints", () => {
  it("no target, value or frontmatter text reaches any leaf of the report", async () => {
    const files = {
      "docs/a.md": `---\ntitle: ${M}\nrelated: [${M}.md, "https://u:${TOKEN}@h"]\n---\n[a](https://user:${TOKEN}@host/x) [b](${M}/x.md) [c](x.md#${M}) <a href="${M}">x</a>\n`,
      "docs/b.md": `---\ntitle: [${M}\n---\n`,
    };
    const s = await ws(files, { docs: { categories: [{ path: "x", frontmatter: ["title"] }], uncovered: "error", related: "symmetric" } });
    const r = await run(s.wsRoot);
    expect(findings(r).length).toBeGreaterThan(3);
    const leaves: string[] = [];
    const walk = (v: unknown) => (typeof v === "string" ? leaves.push(v) : v && typeof v === "object" ? Object.values(v).forEach(walk) : undefined);
    walk(r);
    for (const leaf of leaves) {
      expect(leaf).not.toContain(M);
      expect(leaf).not.toContain(TOKEN);
    }
  });

  it("a file name with a control character, ##vso[ (any case), ##[ or :: is replaced whole by its numbered label", async () => {
    if (process.platform === "win32") return; // these names are not valid on Windows
    const s = await ws({ "docs/a\u001b[31m.md": "[x](nope.md)\n", "docs/##VSO[task].md": "[x](nope.md)\n", "docs/b.md": "[x](nope.md)\n", "docs/z::y.md": "[x](nope.md)\n" });
    const r = await run(s.wsRoot);
    expect(findings(r).map((c) => c.path)).toEqual(["(a file name — not shown) #1", "(a file name — not shown) #2", "docs/b.md", "(a file name — not shown) #4"]);
  });

  it("nameShown uses TERMINAL_UNSAFE's class and the CI commands", () => {
    expect(nameShown("docs/a.md")).toBe(true);
    for (const bad of ["a\u202eb", "a\u0085b", "x##[y", "a::b", "##Vso[x"]) expect(nameShown(bad)).toBe(false);
  });
});

describe("§8 — a generated file's fix", () => {
  it("a path craftar.lock records reads: edit the Forge and run craftar sync; an unreadable lock is no entry", async () => {
    const s = await ws({ "CLAUDE.md": "[x](nope.md)\n", "AGENTS.md": "[x](nope.md)\n" });
    await fs.writeFile(path.join(s.wsRoot, "craftar.lock"), JSON.stringify({ schema: 2, generatedAt: "2026-01-01T00:00:00Z", forge: { source: "../forge", ref: null, commit: null }, profile: "acme", recipes: [], targets: [], files: [{ path: "AGENTS.md", target: "agents-md", ingredient: "rule/x", hash: "0" }] }));
    let r = await run(s.wsRoot);
    expect(findings(r, "links").map((c) => `${c.path} ${c.fix}`)).toEqual(["AGENTS.md edit the Forge and run craftar sync", "CLAUDE.md correct the link or restore the file"]);
    await fs.writeFile(path.join(s.wsRoot, "craftar.lock"), "{");
    r = await run(s.wsRoot);
    expect(findings(r, "links").map((c) => c.fix)).toEqual(["correct the link or restore the file", "correct the link or restore the file"]);
  });
});

describe("§5.3 — the declared checks", () => {
  const BLOCK = {
    categories: [{ path: "architecture", frontmatter: ["title", "status"] }, { path: "tech-debt", name: "dated" }, { path: "specs" }, { path: "missing" }],
    uncovered: "error",
  };

  it("each row, with READMEs exempt and a category that has no directory named by position", async () => {
    const s = await ws(
      {
        "docs/loose.md": "x\n",
        "docs/architecture/README.md": "x\n",
        "docs/architecture/ok.md": "---\ntitle: T\nstatus: s\n---\n",
        "docs/architecture/nofm.md": "x\n",
        "docs/architecture/empty.md": "---\ntitle: ''\n---\n",
        "docs/architecture/bad.md": "---\ntitle: [unclosed\n---\n",
        "docs/architecture/list.md": "---\n- a\n---\n",
        "docs/tech-debt/2026-02-30-impossible.md": "x\n",
        "docs/tech-debt/2026-10-09-fine-name.md": "x\n",
        "docs/tech-debt/Notes.md": "x\n",
        "docs/tech-debt/README.md": "x\n",
        "docs/specs/deep/any.md": "x\n",
      },
      { docs: BLOCK },
    );
    const r = await run(s.wsRoot);
    const lines = findings(r).map(brief);
    expect(lines[0]).toMatch(/^error frontmatter docs\/architecture\/bad\.md:2:\d+ frontmatter is not valid YAML \([A-Z_]+\)$/);
    expect(lines.slice(1)).toEqual([
      "error frontmatter docs/architecture/empty.md required frontmatter key title is missing or empty",
      "error frontmatter docs/architecture/empty.md required frontmatter key status is missing or empty",
      "error frontmatter docs/architecture/list.md required frontmatter key title is missing or empty",
      "error frontmatter docs/architecture/list.md required frontmatter key status is missing or empty",
      "error frontmatter docs/architecture/nofm.md no frontmatter block",
      "error categories docs/loose.md file is in no declared category",
      "error names docs/tech-debt/2026-02-30-impossible.md file name does not fit dated (YYYY-MM-DD-<kebab-case>.md, a real date)",
      "error names docs/tech-debt/Notes.md file name does not fit dated (YYYY-MM-DD-<kebab-case>.md, a real date)",
      "error categories null categories[3]: no such directory under docs/",
    ]);
    expect(r.checks.filter((c) => c.level === "ok").map((c) => c.id)).toEqual(["links", "leaked-tags", "policy"]);
  });

  it("with nothing to report each declared check that is on prints one ok", async () => {
    const s = await ws({ "docs/architecture/a.md": "---\ntitle: T\nstatus: s\n---\n", "docs/tech-debt/README.md": "x\n", "docs/specs/x.md": "x\n" }, { docs: { categories: BLOCK.categories.slice(0, 3), related: "resolve" } });
    const r = await run(s.wsRoot);
    expect(r.checks.map((c) => `${c.level} ${c.id}`)).toEqual(["ok links", "ok leaked-tags", "ok policy", "ok categories", "ok frontmatter", "ok names", "ok related"]);
    expect(r.checks.find((c) => c.id === "policy")!.message).toBe(POLICY.categories(3));
  });

  it("docs/ absent: every declared path is a categories error", async () => {
    const s = await ws({ "README.md": "x\n" }, { docs: { categories: [{ path: "a" }, { path: "b/c" }] } });
    expect(findings(await run(s.wsRoot)).map(brief)).toEqual(["error categories null categories[0]: no such directory under docs/", "error categories null categories[1]: no such directory under docs/"]);
  });

  it("related: resolve — every entry fault, relative to its file, and a symbolic link a warn", async () => {
    const s = await ws(
      {
        "docs/a/x.md": `---\nrelated:\n  - ../b/y.md\n  - nope.md\n  - ../../../out.md\n  - "https://h/x"\n  - ""\n  - "a\\\\b.md"\n  - C:/x.md\n  - y.md\n  - ../lnk/z.md\n  - /docs/b/y.md\n  - ../../projects\n---\n`,
        "docs/a/Y.md": "x\n",
        "docs/b/y.md": "x\n",
        "docs/c/nolist.md": "---\nrelated: x\n---\n",
        "docs/c/README.md": "---\nrelated: [unclosed\n---\n",
        "projects/.keep": "",
        "real/z.md": "x\n",
      },
      { docs: { categories: [{ path: "a" }, { path: "b" }, { path: "c" }], related: "resolve" } },
    );
    await fs.symlink(path.join(s.wsRoot, "real"), path.join(s.wsRoot, "docs", "lnk"), "junction");
    const lines = findings(await run(s.wsRoot)).map(brief);
    expect(lines).toContain("error related docs/a/x.md related[1]: the entry does not exist");
    expect(lines).toContain("error related docs/a/x.md related[2]: the entry leaves the workspace");
    expect(lines).toContain("error related docs/a/x.md related[3]: has a scheme: related: names files of the workspace");
    expect(lines).toContain("error related docs/a/x.md related[4]: empty, or holds a NUL character");
    expect(lines).toContain("error related docs/a/x.md related[5]: holds a backslash");
    expect(lines).toContain("error related docs/a/x.md related[6]: an absolute Windows path");
    expect(lines).toContain("error related docs/a/x.md related[7]: the entry's case differs from the file on disk");
    expect(lines).toContain("warn related docs/a/x.md related[8]: the entry is reached through a symbolic link, not followed");
    expect(lines.filter((l) => l.includes("related[0]") || l.includes("related[9]") || l.includes("related[10]"))).toEqual([]);
    expect(lines).toContain("error related docs/c/nolist.md related: is not a list of strings");
    // A README is exempt from frontmatter, so only related reads it.
    expect(lines.filter((l) => l.includes("docs/c/README.md"))).toHaveLength(1);
    expect(lines.find((l) => l.includes("docs/c/README.md"))).toMatch(/^error related docs\/c\/README\.md:2:\d+ frontmatter is not valid YAML/);
  });

  it("a NUL in a related: entry is a finding", async () => {
    const s = await ws({ "docs/a/x.md": '---\nrelated: ["b\\0.md"]\n---\n' }, { docs: { categories: [{ path: "a" }], related: "resolve" } });
    expect(findings(await run(s.wsRoot)).map(brief)).toEqual(["error related docs/a/x.md related[0]: empty, or holds a NUL character"]);
  });

  it("related: symmetric — a target that does not list the file back; outside docs/, a directory and an unscanned file are exempt", async () => {
    const s = await ws(
      {
        "docs/a/x.md": "---\nrelated: [../b/y.md, ../b/z.md, ../../README.md, ../b, ../b/w.txt]\n---\n",
        "docs/b/y.md": "---\nrelated: [../a/x.md]\n---\n",
        "docs/b/z.md": "---\ntitle: z\n---\n",
        "docs/b/w.txt": "x\n",
        "README.md": "x\n",
      },
      { docs: { categories: [{ path: "a" }, { path: "b" }], related: "symmetric" } },
    );
    expect(findings(await run(s.wsRoot)).map(brief)).toEqual(["error related docs/a/x.md related[1]: the target does not list this file back"]);
  });

  it("a refused block with frontmatter and related both on is one finding", async () => {
    const s = await ws({ "docs/a/x.md": "---\ntitle: [x\n---\n" }, { docs: { categories: [{ path: "a", frontmatter: ["title"] }], related: "symmetric" } });
    const r = await run(s.wsRoot);
    expect(findings(r).map((c) => c.id)).toEqual(["frontmatter"]);
  });

  it("a block YAML refuses is nothing where no check reads it", async () => {
    const s = await ws({ "docs/a/x.md": "---\ntitle: [x\n---\n", ".claude/agents/y.md": "---\nrelated: [x\n---\n" }, { docs: { categories: [{ path: "a" }] } });
    expect(findings(await run(s.wsRoot))).toEqual([]);
  });
});

describe("§4.4 — policy, and the always-on checks in every case", () => {
  const BROKEN = { "docs/a.md": "[x](nope.md)\n" };

  it("no block", async () => {
    const s = await ws(BROKEN);
    const r = await run(s.wsRoot);
    expect(r.checks.find((c) => c.id === "policy")).toMatchObject({ level: "ok", message: POLICY.noBlock });
    expect(findings(r, "links")).toHaveLength(1);
  });

  it("docs: null is no block", async () => {
    const s = await ws(BROKEN, { docs: null });
    expect((await run(s.wsRoot)).checks.find((c) => c.id === "policy")!.message).toBe(POLICY.noBlock);
  });

  it("a block that does not read is one policy error, its declared checks not run", async () => {
    const s = await ws(BROKEN, { docs: { categories: "x", [TOKEN]: 1 } });
    const r = await run(s.wsRoot);
    const p = r.checks.find((c) => c.id === "policy")!;
    expect(p.level).toBe("error");
    expect(p.message).toBe("docs block: categories — categories is a list of entries, each with a path (and 1 more)");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(findings(r, "links")).toHaveLength(1);
  });

  it("an unreachable path Forge: error naming the Forge, fix with the typed --workspace as typed", async () => {
    const s = await ws(BROKEN, { config: { forge: "../nowhere" } });
    const r = await run(s.wsRoot, { typedWorkspace: "my ws" });
    expect(r.checks.find((c) => c.id === "policy")).toMatchObject({ level: "error", message: POLICY.notRead("Forge"), fix: 'run craftar doctor --workspace "my ws"' });
    expect(findings(r, "links")).toHaveLength(1);
    const f = await run(s.wsRoot, { typedWorkspace: "w", fetch: true });
    expect(f.checks.find((c) => c.id === "policy")!.fix).toBe("run craftar doctor --workspace w --fetch");
    const marked = await run(s.wsRoot, { typedWorkspace: "w::x" });
    expect(marked.checks.find((c) => c.id === "policy")!.fix).toBe("run craftar doctor --workspace <dir>");
  });

  it("a remote Forge with no cached copy and no --fetch", async () => {
    const s = await ws(BROKEN, { config: { forge: "https://example.invalid/acme/forge.git" } });
    const r = await run(s.wsRoot);
    expect(r.checks.find((c) => c.id === "policy")).toMatchObject({ level: "error", message: POLICY.notRead("Forge"), fix: "run craftar doctor; with no cached copy, run again with --fetch" });
    expect(findings(r, "links")).toHaveLength(1);
  });

  it("a remote Forge: --fetch reads the block; a failed fetch over a cached copy is a policy warn whose fix says --fetch", async () => {
    const remote = await remoteForge(forgeWith({ categories: [{ path: "missing" }] }));
    cleanups.push(() => remote.cleanup());
    const s = await ws(BROKEN, { config: { forge: remote.url } });
    const fetched = await run(s.wsRoot, { fetch: true });
    expect(fetched.checks.filter((c) => c.id === "policy").map((c) => `${c.level} ${c.message}`)).toEqual([`ok ${POLICY.categories(1)}`]);
    expect(findings(fetched, "categories")).toHaveLength(1);
    // The cached copy, read with no --fetch: no warning.
    expect((await run(s.wsRoot)).checks.filter((c) => c.id === "policy").map((c) => c.level)).toEqual(["ok"]);
    await fs.rename(remote.bare, `${remote.bare}.gone`);
    const failed = await run(s.wsRoot, { fetch: true, typedWorkspace: "w" });
    expect(failed.checks.filter((c) => c.id === "policy").map((c) => `${c.level} ${c.message} ${c.fix}`)).toEqual([
      `warn ${POLICY.warned} run craftar doctor --workspace w --fetch`,
      `ok ${POLICY.categories(1)} null`,
    ]);
    expect(JSON.stringify(failed)).not.toContain(remote.url);
    expect(findings(failed, "links")).toHaveLength(1);
  });

  it("a configuration that does not read", async () => {
    const s = await ws(BROKEN);
    await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), `forge: [${M}\n`);
    const r = await run(s.wsRoot);
    expect(r.checks.find((c) => c.id === "policy")).toMatchObject({ level: "error", message: POLICY.notRead("configuration") });
    expect(JSON.stringify(r)).not.toContain(M);
  });

  it("an unknown profile, and profile names holding a marker, ##vso[ or a line feed, are absent from the output", async () => {
    const s = await scenario(
      { ...forgeWith(), profiles: [profile("acme", ["base"]), profile(`${M}`, ["base"]), profile("##vso[task.x]", ["base"]), profile("a\nb", ["base"])] },
      { config: { profile: `nope${M}` }, files: BROKEN },
    );
    cleanups.push(() => removeWithRetry(s.root));
    const r = await run(s.wsRoot);
    expect(r.checks.find((c) => c.id === "policy")).toMatchObject({ level: "error", message: POLICY.notRead("profile") });
    const out = JSON.stringify(r);
    for (const x of [M, "##vso[", "a\\nb", "nope"]) expect(out).not.toContain(x);
  });

  it("a load that warned is a policy warn, the block still read", async () => {
    const s = await ws(BROKEN, { config: { ref: "main" }, docs: { categories: [] } });
    const r = await run(s.wsRoot);
    expect(r.checks.filter((c) => c.id === "policy").map((c) => `${c.level} ${c.message} ${c.fix}`)).toEqual([
      `warn ${POLICY.warned} run craftar doctor`,
      `ok ${POLICY.categories(0)} null`,
    ]);
  });

  it("not configured: no policy line and no declared check", async () => {
    const s = await ws(BROKEN, { docs: { categories: [{ path: "missing" }] } });
    const r = await run(s.wsRoot, { configured: false });
    expect(r.checks.map((c) => `${c.level} ${c.id}`)).toEqual(["error links", "ok leaked-tags"]);
  });

  it("a repos destination is skipped when the Forge loads, and scanned when it does not", async () => {
    const extra = { repos: [{ name: "app", url: "https://example.com/acme/app.git", path: "docs/app" }] };
    const s = await ws({ "docs/app/x.md": "[x](nope.md)\n" }, { extra });
    expect(findings(await run(s.wsRoot))).toEqual([]);
    await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), "forge: ../nowhere\nprofile: acme\n");
    expect(findings(await run(s.wsRoot), "links")).toHaveLength(1);
  });
});

describe("§4.1 — [path]", () => {
  it("limits the findings about a file; every file is still read; a path: null finding still counts", async () => {
    const s = await ws({ "docs/a.md": "[x](other/b.md#b) [y](nope.md)\n", "docs/z.md": "[x](nope.md)\n" }, { repo: false });
    await fs.mkdir(path.join(s.wsRoot, "docs", "other"), { recursive: true });
    await fs.writeFile(path.join(s.wsRoot, "docs", "other", "b.md"), "# B\n");
    const r = await run(s.wsRoot, { limit: "docs/a.md" });
    expect(findings(r).map(brief)).toEqual(["error links docs/a.md:1:23 target does not exist", "warn scope null git could not say which files it ignores: every file was scanned"]);
    expect(r.scanned).toBe(3);
  });

  it("a path naming a file that exists and is not scanned reports no finding about a file", async () => {
    const s = await ws({ "docs/a.md": "[x](nope.md)\n", "src/x.ts": "" });
    expect(findings(await run(s.wsRoot, { limit: "src/x.ts" }))).toEqual([]);
  });

  it("a path outside the workspace, or naming nothing, is refused", async () => {
    const s = await ws({ "docs/a.md": "x\n" });
    await expect(run(s.wsRoot, { limit: "../x" })).rejects.toThrow("../x is outside the workspace");
    await expect(run(s.wsRoot, { limit: "docs/none.md" })).rejects.toThrow("docs/none.md names nothing in the workspace");
  });
});

describe("§11 item 6 — containment", () => {
  it("a ../../x that exists outside the workspace reads the same as one that does not", async () => {
    const s = await ws({ "docs/a.md": "[x](../../exists.md) [y](../../absent.md)\n" });
    await fs.writeFile(path.join(s.root, "exists.md"), "x\n");
    expect(findings(await run(s.wsRoot)).map((c) => c.message)).toEqual(["target leaves the workspace", "target leaves the workspace"]);
  });
});

describe("§11 item 7 — Windows shapes", () => {
  it("CRLF and BOM files keep their line numbers", async () => {
    const s = await ws({ "docs/a.md": "\uFEFF# A\r\n\r\n[x](nope.md)\r\n" });
    expect(findings(await run(s.wsRoot)).map(brief)).toEqual(["error links docs/a.md:3:5 target does not exist"]);
  });
});

describe("§11 item 13 — writes nothing", () => {
  it("the workspace and the Forge are byte-identical after a run", async () => {
    const s = await ws({ "docs/a.md": "[x](nope.md)\n" }, { docs: { categories: [{ path: "a" }], related: "symmetric" } });
    const snapshot = async (d: string) => {
      const out: Record<string, string> = {};
      const walk = async (rel: string) => {
        for (const e of await fs.readdir(path.join(d, rel), { withFileTypes: true })) {
          const r = path.join(rel, e.name);
          if (e.isDirectory()) await walk(r);
          else out[r] = (await fs.readFile(path.join(d, r))).toString("base64");
        }
      };
      await walk("");
      return out;
    };
    const before = await snapshot(s.root);
    await run(s.wsRoot);
    expect(await snapshot(s.root)).toEqual(before);
  });
});
