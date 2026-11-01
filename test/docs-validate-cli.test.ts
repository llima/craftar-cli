import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, scenario, tmpDir, writeFiles } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";
import { hermeticGit } from "./helpers/hermetic-git.js";

// Spec 47 §4.1, §4.6 — `craftar docs validate` as a real process: exit codes, refusals, --json, streams.

// Every git this file starts, in process and in a CLI child, reads none of the developer's configuration.
hermeticGit();

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const M = ["ZZ", "MARKER", "ZZ"].join("");
const TOKEN = "ghp_" + "x".repeat(36);

async function ws(files: Record<string, string>, docs?: unknown) {
  const s = await scenario(
    { ingredients: [rule("style", "# Style\n")], recipes: [recipe("base", ["rule/style"])], profiles: [profile("acme", ["base"], ["claude-code"], docs === undefined ? {} : { docs })] },
    { config: { profile: "acme" }, files },
  );
  cleanups.push(() => removeWithRetry(s.root));
  execFileSync("git", ["-C", s.wsRoot, "init", "-q"], { stdio: "ignore" });
  return s;
}

describe("exit codes and streams (§4.6)", () => {
  it("clean: exit 0, the report on stdout, nothing on stderr", async () => {
    const s = await ws({ "docs/a.md": "# A\n" });
    const r = runCli(["docs", "validate", "--workspace", s.wsRoot]);
    expect(r).toMatchObject({ code: 0, stderr: "" });
    expect(r.stdout).toBe("  ok     links       0 links in 1 file\n  ok     leaked-tags 1 file\n  ok     policy      no docs block in this profile\n\n0 errors, 0 warn in 1 file\n");
  });

  it("an error: exit 1, its line and fix in the text", async () => {
    const s = await ws({ "docs/a.md": "[x](nope.md)\n" });
    const r = runCli(["docs", "validate", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stdout.split("\n").slice(0, 2)).toEqual(["  error  links       docs/a.md:1:5 — target does not exist", "           fix: correct the link or restore the file"]);
    expect(r.stdout).toMatch(/\n1 error, 0 warn in 1 file\n$/);
  });

  it("a warn: exit 0, and 1 under --strict", async () => {
    const s = await ws({ "docs/a.md": "[x](#nope)\n" });
    expect(runCli(["docs", "validate", "--workspace", s.wsRoot]).code).toBe(0);
    expect(runCli(["docs", "validate", "--strict", "--workspace", s.wsRoot]).code).toBe(1);
  });

  it("a tree with nothing ignored (git exits 1) is no finding, --strict exits 0", async () => {
    const s = await ws({ "docs/a.md": "x\n" });
    const r = runCli(["docs", "validate", "--strict", "--json", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).summary).toEqual({ ok: 3, warn: 0, error: 0 });
  });

  it("--json: the keys in the contract's order", async () => {
    const s = await ws({ "docs/a.md": "[x](nope.md)\n" });
    const r = runCli(["docs", "validate", "--json", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(Object.keys(j)).toEqual(["version", "workspace", "fetch", "strict", "scanned", "checks", "summary"]);
    expect(Object.keys(j.checks[0])).toEqual(["id", "level", "path", "line", "column", "message", "fix"]);
    expect(Object.keys(j.summary)).toEqual(["ok", "warn", "error"]);
    expect(j.workspace).toBe(await fs.realpath(s.wsRoot));
    expect(j.checks[0]).toEqual({ id: "links", level: "error", path: "docs/a.md", line: 1, column: 5, message: "target does not exist", fix: "correct the link or restore the file" });
    expect(j.checks.at(-1)).toEqual({ id: "policy", level: "ok", path: null, line: null, column: null, message: "no docs block in this profile", fix: null });
  });

  it("[path] with a path: null finding still sets the exit", async () => {
    const s = await ws({ "docs/a.md": "x\n", "docs/b.md": "[x](nope.md)\n" }, { categories: [{ path: "missing" }] });
    const r = runCli(["docs", "validate", "docs/a.md", "--json", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).checks.filter((c: { level: string }) => c.level === "error").map((c: { id: string; path: string | null }) => `${c.id} ${c.path}`)).toEqual(["categories null"]);
  });
});

describe("refusals (§4.1)", () => {
  it("an explicit --workspace without craftar.yaml exits 1 on stderr", async () => {
    const dir = await tmpDir();
    cleanups.push(() => removeWithRetry(dir));
    const r = runCli(["docs", "validate", "--workspace", dir]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("no craftar.yaml in");
  });

  it("the current directory without craftar.yaml runs the always-on checks only", async () => {
    const dir = await tmpDir();
    cleanups.push(() => removeWithRetry(dir));
    await writeFiles(dir, { "docs/a.md": "[x](nope.md)\n" });
    execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
    const r = runCli(["docs", "validate", "--json"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).checks.map((c: { id: string }) => c.id)).toEqual(["links", "leaked-tags"]);
  });

  it("[path] outside the workspace or naming nothing exits 1, quoting only what was typed", async () => {
    const s = await ws({ "docs/a.md": "x\n" });
    const out = runCli(["docs", "validate", "../elsewhere", "--workspace", s.wsRoot]);
    expect(out).toMatchObject({ code: 1, stdout: "" });
    expect(out.stderr).toContain("../elsewhere is outside the workspace");
    const none = runCli(["docs", "validate", "docs/none.md", "--workspace", s.wsRoot]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("docs/none.md names nothing in the workspace");
  });

  it("a quoted [path] with spaces", async () => {
    const s = await ws({ "docs/my notes/a.md": "[x](nope.md)\n", "docs/b.md": "[x](nope.md)\n" });
    const r = runCli(["docs", "validate", "docs/my notes", "--json", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).checks.filter((c: { level: string }) => c.level !== "ok").map((c: { path: string }) => c.path)).toEqual(["docs/my notes/a.md"]);
  });
});

describe("git (§4.2, §11 item 11)", () => {
  it("a child PATH with no git scans everything and says so", async () => {
    const s = await ws({ "docs/a.md": "x\n", "docs/private.md": "x\n", ".gitignore": "docs/private.md\n" });
    const r = runCli(["docs", "validate", "--json", "--workspace", s.wsRoot], { env: { PATH: "", Path: "" } });
    const j = JSON.parse(r.stdout);
    expect(j.scanned).toBe(2);
    expect(j.checks.filter((c: { id: string }) => c.id === "scope").map((c: { message: string }) => c.message)).toEqual(["git could not say which files it ignores: every file was scanned"]);
  });
});

describe("printing (§11 item 5)", () => {
  it("no marker or token on stdout or stderr, text or --json, a malformed block included", async () => {
    const s = await ws(
      { "docs/a.md": `---\ntitle: ${M}\n---\n[a](https://user:${TOKEN}@h/x) [b](${M}.md) [c](${M}/x.md#${M})\n` },
      { categories: [{ path: `${M}` }], [M]: 1, related: M },
    );
    for (const extra of [[], ["--json"]]) {
      const r = runCli(["docs", "validate", ...extra, "--workspace", s.wsRoot]);
      // Not vacuous: the run printed its findings — the links error and the block's policy error.
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/links/);
      expect(r.stdout).toMatch(/docs block: /);
      expect(r.stdout + r.stderr).not.toContain(M);
      expect(r.stdout + r.stderr).not.toContain(TOKEN);
    }
  });
});

describe("writes nothing (§11 item 13)", () => {
  it("the registry is not created or touched", async () => {
    const s = await ws({ "docs/a.md": "x\n" });
    const reg = path.join(process.env.CRAFTAR_HOME!, "registry.json");
    const before = await fs.readFile(reg, "utf8").catch(() => null);
    runCli(["docs", "validate", "--workspace", s.wsRoot]);
    expect(await fs.readFile(reg, "utf8").catch(() => null)).toBe(before);
  });
});

describe("the README (spec 47 §10)", () => {
  it("Phase 2's shipped list ends with docs validate, Later no longer lists it, the status line and the Commands row say it", async () => {
    const readme = await fs.readFile(path.join(__dirname, "..", "README.md"), "utf8");
    const lines = readme.split("\n");
    expect(lines.find((l) => l.startsWith("Phase 2"))!).toMatch(/`craftar docs validate` \([^)]*\)\.$/);
    expect(lines.find((l) => l.startsWith("Later:"))!).not.toContain("docs validate");
    expect(lines.slice(0, 6).join("\n")).toContain("`craftar docs validate` checks a workspace's Markdown");
    expect(lines.some((l) => l.startsWith("| `craftar docs validate [path] [--workspace <dir>] [--fetch] [--strict] [--json]` |"))).toBe(true);
    expect(readme).toContain("### to 0.46.0");
    expect(readme).toContain("`[path]`, relative to the workspace (not the current directory)");
    expect(runCli(["docs", "validate", "--help"]).stdout.replace(/\s+/g, " ")).toContain("[path], relative to the workspace (not the current directory)");
  });
});
