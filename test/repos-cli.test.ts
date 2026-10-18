import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";
import { fakeGit, readCloneLog } from "./helpers/fake-git.js";
import { makeForge, profile, recipe, rule, tmpDir } from "./helpers/forge.js";
import { remoteForge } from "./helpers/remote.js";

// Spec 37 §4.7 — `craftar repos` lists, `craftar repos clone [<name>…]` clones the missing entries of an existing
// workspace. git is the fake of test/helpers/fake-git.ts wherever a clone could run — no real clone, no network. The
// two remote-Forge cases run the real git against a file:// bare repository (the Forge, never a repository entry),
// and with every entry present, so a regression there could not start a clone either.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const REPOS = [
  { name: "portal-api", url: "https://git.example.com/acme/portal-api.git" },
  { name: "portal-web", url: "git@git.example.com:acme/portal-web.git", path: "apps/portal-web", ref: "release" },
  { name: "docs", url: "https://git.example.com/acme/docs.git", path: "notes/docs" },
];

async function setup(opts: { repos?: unknown[]; declared?: boolean } = {}) {
  const parent = await fs.realpath(await tmpDir("craftar-repos-cli-"));
  cleanups.push(() => fs.rm(parent, { recursive: true, force: true }));
  const forge = path.join(parent, "forge");
  const extra = opts.declared ? { params: { token: { description: "a value nobody set" } } } : {};
  await makeForge(forge, {
    ingredients: [rule("a", opts.declared ? "# A {{token}}\n" : "# A\n", extra)],
    recipes: [recipe("base", ["rule/a"])],
    profiles: [profile("acme", ["base"], ["claude-code"], { repos: opts.repos ?? REPOS })],
  });
  const home = path.join(parent, "home");
  const ws = path.join(parent, "ws");
  await fs.mkdir(ws);
  await fs.writeFile(path.join(ws, "craftar.yaml"), `forge: ${forge.replace(/\\/g, "/")}\nprofile: acme\n`);
  const fg = await fakeGit();
  cleanups.push(fg.cleanup);
  const env = (extra: NodeJS.ProcessEnv = {}) => fg.env({ CRAFTAR_HOME: home, ...extra });
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => runCli([...args, "--workspace", ws], { env: env(extra) });
  return { parent, forge, home, ws, fg, run };
}
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(d: string): Promise<void> {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        out[path.relative(dir, p) + "/"] = "";
        await walk(p);
      } else out[path.relative(dir, p)] = await fs.readFile(p, "utf8").catch(() => "?");
    }
  }
  await walk(dir);
  return out;
}

describe("craftar repos — the listing", () => {
  it("present, missing, blocked — with URLs and refs; nothing cloned, nothing written", async () => {
    const s = await setup();
    await fs.mkdir(path.join(s.ws, "portal-api"));
    await fs.writeFile(path.join(s.ws, "notes"), "a file where a directory should be\n");
    const before = await snapshot(s.ws);
    const r = s.run(["repos"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(
      [
        "repositories of acme — 3 in the profile, 1 missing",
        "  present  portal-api  → portal-api        https://git.example.com/acme/portal-api.git",
        "  missing  portal-web  → apps/portal-web   git@git.example.com:acme/portal-web.git  @ release",
        "  blocked  docs        → notes/docs        https://git.example.com/acme/docs.git  (notes is not a directory)",
        "",
      ].join("\n"),
    );
    expect(await snapshot(s.ws)).toEqual(before);
    expect(await readCloneLog(s.fg.log)).toEqual([]);
  });
  it("--json: keys in order, null ref and reason, the native real path, the plan's warnings", async () => {
    const s = await setup();
    await fs.mkdir(path.join(s.ws, "portal-api"));
    const r = s.run(["repos", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(Object.keys(j)).toEqual(["workspace", "profile", "repos", "warnings"]);
    expect(j.workspace).toBe(await fs.realpath(s.ws));
    expect(j.profile).toBe("acme");
    expect(j.repos).toEqual([
      { name: "portal-api", url: "https://git.example.com/acme/portal-api.git", path: "portal-api", ref: null, state: "present", reason: null },
      { name: "portal-web", url: "git@git.example.com:acme/portal-web.git", path: "apps/portal-web", ref: "release", state: "missing", reason: null },
      { name: "docs", url: "https://git.example.com/acme/docs.git", path: "notes/docs", ref: null, state: "missing", reason: null },
    ]);
    for (const row of j.repos) expect(Object.keys(row)).toEqual(["name", "url", "path", "ref", "state", "reason"]);
    expect(Array.isArray(j.warnings)).toBe(true);
  });
  it("a path only the lock records is blocked (a file sync writes)", async () => {
    const s = await setup({ repos: [{ name: "old", url: "https://git.example.com/acme/old.git" }] });
    expect(s.run(["sync"]).code).toBe(0);
    const lockFile = path.join(s.ws, "craftar.lock");
    const lock = JSON.parse(await fs.readFile(lockFile, "utf8"));
    lock.files.push({ path: "old/readme.md", hash: "sha256:" + "0".repeat(64), target: "claude-code", ingredient: "rule/a" });
    await fs.writeFile(lockFile, JSON.stringify(lock, null, 2) + "\n");
    const r = s.run(["repos", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).repos[0]).toMatchObject({ state: "blocked", reason: "old is a file sync writes" });
    const c = s.run(["repos", "clone"]);
    expect(c.code).toBe(1);
    expect(c.stderr).toBe("error: cannot clone old: old is a file sync writes\n");
    expect(await readCloneLog(s.fg.log)).toEqual([]);
  });
  it("a profile with no entry: one line, exit 0", async () => {
    const s = await setup({ repos: [] });
    const r = s.run(["repos"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("profile acme lists no repositories\n");
  });
  it("a profile with no entry whose plan warns: the warn line follows the one line (review round 3)", async () => {
    const s = await setup({ repos: [] });
    await fs.writeFile(path.join(s.forge, "ingredients", "rules", "a", "rule.md"), "# A {{nobody.sets.this}}\n");
    const r = s.run(["repos"]);
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe("profile acme lists no repositories");
    expect(lines[1]).toMatch(/^  warn .*nobody\.sets\.this/);
  });
  it("C4: the block does not read — exit 1", async () => {
    const s = await setup({ repos: [{ name: "a" }] });
    const r = s.run(["repos"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("error: profile acme: repos[0]: url is missing\n");
  });
  it("a directory without craftar.yaml, and a plan that throws: exit 1, as status says it", async () => {
    const s = await setup();
    const bare = path.join(s.parent, "nothing-here");
    await fs.mkdir(bare);
    const env = s.fg.env({ CRAFTAR_HOME: s.home });
    const st = runCli(["status", "--workspace", bare], { env });
    const rp = runCli(["repos", "--workspace", bare], { env });
    expect(rp.code).toBe(1);
    expect(rp.stderr).toBe(st.stderr);
    await fs.writeFile(path.join(s.ws, "craftar.yaml"), `forge: ${s.forge.replace(/\\/g, "/")}\nprofile: acme\nrecipes:\n  add: [nope]\n`);
    const st2 = s.run(["status"]);
    const rp2 = s.run(["repos"]);
    expect(st2.code).toBe(1);
    expect(rp2.code).toBe(1);
    expect(rp2.stderr).toBe(st2.stderr);
  });
});

describe("craftar repos clone", () => {
  it("no name: the missing entries, in order; a present one skipped with a line; exit 0", async () => {
    const s = await setup({ repos: REPOS.slice(0, 2).concat([{ name: "cli", url: "https://git.example.com/acme/cli.git" }]) });
    await fs.mkdir(path.join(s.ws, "portal-api"));
    const r = s.run(["repos", "clone"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(
      [
        "craftar repos clone — cloning 2 repositories of acme",
        "  present  portal-api  → portal-api  (not cloned)",
        "  cloned   portal-web  → apps/portal-web",
        "  cloned   cli         → cli",
        "",
      ].join("\n"),
    );
    const calls = await readCloneLog(s.fg.log);
    expect(calls.map((c) => c.args.at(-1))).toEqual(["apps/portal-web", "cli"]);
    for (const c of calls) {
      expect(await fs.realpath(c.cwd)).toBe(await fs.realpath(s.ws));
      expect(c.allow).toBe("https:ssh");
    }
  });
  it("names: only those, in the profile's order", async () => {
    const s = await setup({ repos: REPOS.slice(0, 2).concat([{ name: "cli", url: "https://git.example.com/acme/cli.git" }]) });
    const r = s.run(["repos", "clone", "cli", "portal-api"]);
    expect(r.code, r.stderr).toBe(0);
    expect((await readCloneLog(s.fg.log)).map((c) => c.args.at(-1))).toEqual(["portal-api", "cli"]);
  });
  it("a failed clone: exit 1, the others tried, the by-hand line", async () => {
    const s = await setup({ repos: REPOS.slice(0, 2) });
    const r = s.run(["repos", "clone"], { CRAFTAR_TEST_CLONE_FAIL: "apps/portal-web" });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("  failed  portal-web  → apps/portal-web  (git exited 128)\n");
    expect(r.stdout).toContain(`  1 of 2 cloned — clone the rest by hand, in ${s.ws}:\n`);
    expect(r.stdout).toContain('    git clone --no-recurse-submodules --branch=release -- "git@git.example.com:acme/portal-web.git" "apps/portal-web"\n');
    expect((await readCloneLog(s.fg.log)).length).toBe(2);
  });
  it("every entry present: nothing to clone, exit 0, no clone run", async () => {
    const s = await setup({ repos: REPOS.slice(0, 2) });
    await fs.mkdir(path.join(s.ws, "portal-api"));
    await fs.mkdir(path.join(s.ws, "apps", "portal-web"), { recursive: true });
    const r = s.run(["repos", "clone"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("all 2 repositories of acme are present — nothing to clone\n");
    expect(await readCloneLog(s.fg.log)).toEqual([]);
  });
  it("refusals before any clone: R1 (printed, and not printed), R2, R3, C3, C4, C5, C6", async () => {
    const MARK = "zq" + "mark";
    const cases: Array<[string, { repos?: unknown[]; pre?: (ws: string) => Promise<void>; args: string[]; env?: NodeJS.ProcessEnv }, string]> = [
      ["R1", { args: ["nope"] }, "error: profile acme has no repository nope\n"],
      ["R1 unprintable", { args: [`$(${MARK})`] }, "error: profile acme: a name given is not a repository name\n"],
      ["R3", { args: ["portal-api", "PORTAL-API"] }, "error: portal-api is given twice\n"],
      ["R2", { args: ["portal-api"], pre: (ws) => fs.mkdir(path.join(ws, "portal-api")) }, "error: portal-api is present at portal-api — nothing to clone\n"],
      ["C3", { repos: [], args: [] }, "error: profile acme lists no repositories — nothing to clone\n"],
      ["C4", { repos: [{ name: "a", url: "file:///srv/a.git" }], args: [] }, "error: profile acme: repos[0]: url is not an https or ssh git URL\n"],
      ["C5", { args: [], pre: (ws) => fs.writeFile(path.join(ws, "notes"), "x") }, "error: cannot clone docs: notes is not a directory\n"],
      ["C6", { args: [], env: { PATH: "", Path: "" } }, "error: cloning needs git — install it, or leave the clone out\n"],
    ];
    for (const [what, c, expected] of cases) {
      const s = await setup(c.repos === undefined ? {} : { repos: c.repos });
      if (c.pre) await c.pre(s.ws);
      const before = await snapshot(s.ws);
      const r = s.run(["repos", "clone", ...c.args], c.env);
      expect(r.code, what).toBe(1);
      expect(r.stderr, what).toBe(expected);
      expect(r.stdout + r.stderr, what).not.toContain(MARK);
      expect(await readCloneLog(s.fg.log), what).toEqual([]);
      expect(await snapshot(s.ws), what).toEqual(before);
    }
  });
  it("a workspace whose sync is refused still clones; no lock, registry or craftar.yaml byte changes", async () => {
    const s = await setup({ declared: true, repos: REPOS.slice(0, 1) });
    const yaml = await fs.readFile(path.join(s.ws, "craftar.yaml"), "utf8");
    const r = s.run(["repos", "clone"]);
    expect(r.code, r.stderr).toBe(0);
    expect((await readCloneLog(s.fg.log)).length).toBe(1);
    expect(await fs.readFile(path.join(s.ws, "craftar.yaml"), "utf8")).toBe(yaml);
    expect(await fs.lstat(path.join(s.ws, "craftar.lock")).then(() => true, () => false)).toBe(false);
    expect(await fs.lstat(path.join(s.home, "registry.json")).then(() => true, () => false)).toBe(false);
  });
});

describe("a remote Forge whose fetch fails (real git, a file:// bare Forge; every entry present)", () => {
  async function remoteSetup() {
    const r = await remoteForge({
      ingredients: [rule("a", "# A\n")],
      recipes: [recipe("base", ["rule/a"])],
      profiles: [profile("acme", ["base"], ["claude-code"], { repos: [{ name: "portal-api", url: "https://git.example.com/acme/portal-api.git" }] })],
    });
    cleanups.push(r.cleanup);
    const ws = await fs.realpath(await tmpDir("craftar-repos-remote-ws-"));
    const home = await fs.realpath(await tmpDir("craftar-repos-remote-home-"));
    cleanups.push(() => fs.rm(ws, { recursive: true, force: true }), () => fs.rm(home, { recursive: true, force: true }));
    await fs.writeFile(path.join(ws, "craftar.yaml"), `forge: ${r.url}\nprofile: acme\n`);
    await fs.mkdir(path.join(ws, "portal-api"));
    const run = (args: string[]) => runCli([...args, "--workspace", ws], { env: { CRAFTAR_HOME: home } });
    expect(run(["sync"]).code).toBe(0);
    await fs.rename(r.bare, r.bare + ".gone");
    return { r, run };
  }
  it("craftar repos lists from the cached copy, with the load's warning in the output and in --json", async () => {
    const { r, run } = await remoteSetup();
    const t = run(["repos"]);
    expect(t.code, t.stderr).toBe(0);
    expect(t.stdout).toContain("  present  portal-api");
    expect(t.stdout + t.stderr).toContain(`Forge ${r.url} not fetched (`);
    const j = JSON.parse(run(["repos", "--json"]).stdout);
    expect(j.warnings[0].startsWith(`Forge ${r.url} not fetched (`)).toBe(true);
  });
  it("R4: repos clone refuses, with no --offline advice; sync's message keeps its tail", async () => {
    const { r, run } = await remoteSetup();
    const c = run(["repos", "clone"]);
    expect(c.code).toBe(1);
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(c.stderr).toMatch(new RegExp(`^error: cannot fetch the Forge ${esc(r.url)}: [^\\n]+ — repos clone reads the profile's repositories only from a fresh copy\\n$`));
    expect(run(["sync"]).stderr).toContain("— run with --offline to use the cached copy (");
  });
});

