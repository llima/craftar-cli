import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import YAML from "yaml";
import { makeForge, profile, recipe, rule, scenario, tmpDir, writeFiles, type IngredientSpec } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";
import { runCli } from "./helpers/cli.js";
import { git, remoteForge } from "./helpers/remote.js";
import { TSX_LOADER } from "./helpers/tsx-loader.js";
import { exists, listFiles } from "../src/core/forge.js";
import { UnifyPlanSchema } from "../src/schema/index.js";
import { cacheKey, ensureTree, UNVOUCHED_HIDDEN } from "../src/core/remote.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Every file under root with its content, so a before/after comparison catches an in-place edit. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files = (await listFiles(root)).filter((f) => f !== ".git" && !f.startsWith(".git/"));
  return Object.fromEntries(await Promise.all(files.map(async (f) => [f, await fs.readFile(path.join(root, f), "utf8")] as const)));
}

/** A fake but stable identity, so `git commit` never depends on the host's ambient config. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "craftar-test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "craftar-test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "maintenance.auto", "false"]);
  execFileSync("git", ["-C", dir, "config", "gc.auto", "0"]);
}

function gitCommitAll(dir: string, message: string): void {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", message], { env: gitEnv() });
}

/* ------------------------------------------------------------------ */
/* spec 13: a remote Forge through the cache (file:// remotes only)    */
/* ------------------------------------------------------------------ */
describe("cli — a remote Forge (spec 13 §4.1, §4.4, AC 1, 3, 4, 5)", () => {
  const SPEC = { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] };

  async function remoteWs(extra = "") {
    const r = await remoteForge(SPEC);
    const ws = await tmpDir("craftar-remote-ws-");
    const home = await tmpDir("craftar-home-");
    cleanups.push(r.cleanup, () => fs.rm(ws, { recursive: true, force: true }), () => removeWithRetry(home));
    await fs.writeFile(path.join(ws, "craftar.yaml"), `forge: ${r.url}\nprofile: acme\n${extra}`);
    const run = (args: string[], h = home) => runCli([...args, "--workspace", ws], { env: { CRAFTAR_HOME: h } });
    return { r, ws, home, run };
  }
  const short = (sha: string) => sha.slice(0, 8);

  it("AC 1: sync writes the files a path Forge at the same commit writes, byte for byte", async () => {
    const { r, ws, run } = await remoteWs();
    expect(run(["sync"]).code).toBe(0);
    const viaPath = await tmpDir("craftar-path-ws-");
    cleanups.push(() => fs.rm(viaPath, { recursive: true, force: true }));
    await fs.writeFile(path.join(viaPath, "craftar.yaml"), `forge: ${r.src.replace(/\\/g, "/")}\nprofile: acme\n`);
    expect(runCli(["sync", "--workspace", viaPath]).code).toBe(0);
    const strip = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== "craftar.yaml" && k !== "craftar.lock"));
    expect(strip(await snapshot(ws))).toEqual(strip(await snapshot(viaPath)));
  });

  it("AC 3: the header names the Forge, and shows the lock's commit once the Forge moved, until the next sync", async () => {
    const { r, run } = await remoteWs();
    const first = git(r.src, "rev-parse", "HEAD");
    expect(run(["sync"]).code).toBe(0);
    expect(run(["status"]).stdout.split("\n")[1]).toBe(`  forge ${r.url} @ main (default branch) ${short(first)}`);
    const next = await r.commit({ "README.md": "moved\n" });
    expect(run(["status"]).stdout.split("\n")[1]).toBe(`  forge ${r.url} @ main (default branch) ${short(next)} · lock ${short(first)}`);
    expect(run(["sync"]).code).toBe(0);
    expect(run(["status"]).stdout.split("\n")[1]).toBe(`  forge ${r.url} @ main (default branch) ${short(next)}`);
  });

  it("AC 4: a tag in ref does not move when the branch does", async () => {
    const r0 = await remoteWs("ref: v1\n");
    const tagged = git(r0.r.src, "rev-parse", "HEAD");
    git(r0.r.src, "tag", "v1");
    git(r0.r.src, "push", "-q", "origin", "v1");
    await r0.r.commit({ "README.md": "later\n" });
    const j = JSON.parse(r0.run(["status", "--json"]).stdout);
    expect(j.forge).toEqual({ kind: "remote", source: r0.r.url, ref: "v1", defaultBranch: null, commit: tagged, lockCommit: null, fetched: true });
  });

  it("AC 5: unreachable — sync fails naming --offline; readers warn and use the cache; --offline works; no cache fails everywhere", async () => {
    const { r, ws, home, run } = await remoteWs();
    expect(run(["sync"]).code).toBe(0);
    const sha = git(r.src, "rev-parse", "HEAD");
    await fs.rename(r.bare, r.bare + ".gone");
    for (const args of [["sync"], ["sync", "--dry-run"], ["sync", "--check"]]) {
      const x = run(args);
      expect(x.code, args.join(" ")).toBe(1);
      expect(x.stderr.startsWith(`error: cannot fetch the Forge ${r.url}: `), args.join(" ")).toBe(true);
      expect(x.stderr, args.join(" ")).toContain(`— run with --offline to use the cached copy (${short(sha)} fetched `);
    }
    const notFetched = `Forge ${r.url} not fetched (`;
    const st = run(["status", "--json"]);
    expect(st.code).toBe(0);
    expect(JSON.parse(st.stdout).warnings[0].startsWith(notFetched)).toBe(true);
    for (const args of [["diff"], ["explain", ".claude/rules/a.md"], ["ls"]]) {
      const x = run(args);
      expect(x.code, args.join(" ")).toBe(0);
      expect(x.stderr.startsWith(`warn ${notFetched}`), args.join(" ")).toBe(true);
    }
    for (const cmd of ["recipes", "ingredients"]) {
      const x = run([cmd, "--json"]);
      expect(x.code, cmd).toBe(0);
      expect(JSON.parse(x.stdout).warnings[0].startsWith(notFetched), cmd).toBe(true);
    }
    expect(run(["sync", "--offline"]).code).toBe(0);
    const empty = await tmpDir("craftar-home-");
    cleanups.push(() => removeWithRetry(empty));
    for (const args of [["sync"], ["status"], ["diff"], ["ls"], ["recipes"], ["sync", "--offline"]]) {
      const x = run(args, empty);
      expect(x.code, `${args.join(" ")} without a cache`).toBe(1);
    }
  });

  it("Q13-1 (answered: like sync --check): with the remote unreachable, diff --exit-code exits 1 naming --offline; plain diff reads the cache with a warning", async () => {
    const { r, run } = await remoteWs();
    expect(run(["sync"]).code).toBe(0);
    const sha = git(r.src, "rev-parse", "HEAD");
    await fs.rename(r.bare, r.bare + ".gone");
    const gate = run(["diff", "--exit-code"]);
    expect(gate.code).toBe(1);
    expect(gate.stdout).toBe("");
    expect(gate.stderr.startsWith(`error: cannot fetch the Forge ${r.url}: `)).toBe(true);
    expect(gate.stderr).toContain(`— run with --offline to use the cached copy (${short(sha)} fetched `);
    const check = run(["sync", "--check"]);
    expect([check.code, check.stderr.split(": ").slice(0, 2).join(": ")]).toEqual([1, gate.stderr.split(": ").slice(0, 2).join(": ")]);
    const plain = run(["diff"]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toBe("no differences\n");
    expect(plain.stderr.startsWith(`warn Forge ${r.url} not fetched (`)).toBe(true);
    const offline = run(["diff", "--exit-code", "--offline"]);
    expect([offline.code, offline.stdout]).toEqual([0, "no differences\n"]);
  });

  it("status --json carries forge for a path Forge too", async () => {
    const s = await scenario(SPEC, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    expect(JSON.parse(runCli(["status", "--json", "--workspace", s.wsRoot]).stdout).forge).toEqual({
      kind: "path",
      source: "../forge",
      ref: null,
      defaultBranch: null,
      commit: null,
      lockCommit: null,
      fetched: false,
    });
  });

  it("forge unify on a remote Forge is refused before anything is fetched", async () => {
    const { r, home, run } = await remoteWs();
    const x = run(["forge", "unify", "rule/a", "--profile", "acme", "--take", "base"]);
    expect([x.code, x.stderr]).toEqual([1, `error: the Forge of this workspace is remote (${r.url}) — clone it and pass --forge <dir>\n`]);
    expect(await fs.readdir(home)).toEqual([]);
  });

  it("--forge with a URL is refused, for the forge commands and the catalogue", async () => {
    const { r, home } = await remoteWs();
    for (const args of [["forge", "variants"], ["recipes"], ["ingredients"]]) {
      const x = runCli([...args, "--forge", r.url], { env: { CRAFTAR_HOME: home } });
      expect([x.code, x.stderr], args.join(" ")).toEqual([1, "error: --forge takes a directory; to read a remote Forge, run inside a workspace that names it\n"]);
    }
  });

  it("targets never fetches: no cache → unmarked with a warning; once cached → marked, and no new fetch", async () => {
    const { home, run } = await remoteWs();
    const before = JSON.parse(run(["targets", "--json"]).stdout);
    expect(before.targets.map((t: { inUse: unknown }) => t.inUse)).toEqual([null, null, null]);
    expect(before.warnings).toHaveLength(1);
    expect(before.warnings[0].startsWith("targets in use not shown: ")).toBe(true);
    expect(run(["status"]).code).toBe(0);
    const entry = path.join(home, "forges", (await fs.readdir(path.join(home, "forges")))[0]);
    const stamp = await fs.readFile(path.join(entry, "fetched"), "utf8");
    const after = JSON.parse(run(["targets", "--json"]).stdout);
    expect(after.targets.map((t: { inUse: unknown }) => t.inUse)).toEqual([true, false, false]);
    expect(after.warnings).toEqual([]);
    expect(await fs.readFile(path.join(entry, "fetched"), "utf8")).toBe(stamp);
  });
});

describe("cli — import --write-config keeps a remote forge (spec 13 §4.5, AC 8)", () => {
  async function wsWith(craftarYaml: string) {
    const root = await tmpDir("craftar-import-remote-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const ws = path.join(root, "ws");
    await writeFiles(ws, { ".claude/rules/a.md": "# A\n", "craftar.yaml": craftarYaml });
    return { ws, forge: path.join(root, "forge") };
  }

  it("forge kept byte for byte, profile and targets set, and the report says the Forge must be pushed", async () => {
    const { ws, forge } = await wsWith("forge: git@example.com:acme/forge.git\nprofile: old\n");
    const r = runCli(["import", "--from", "claude-code", "--workspace", ws, "--forge", forge, "--profile", "acme", "--write-config"]);
    expect(r.code).toBe(0);
    expect(await fs.readFile(path.join(ws, "craftar.yaml"), "utf8")).toBe("forge: git@example.com:acme/forge.git\nprofile: acme\ntargets:\n  - claude-code\n");
    expect(r.stdout.split("\n")).toContain(
      "  workspace craftar.yaml edited (profile, targets) — forge kept (remote git@example.com:acme/forge.git); push the Forge for sync to see this import",
    );
  });

  it("a credential in that forge is refused before anything prints it, and the Forge is not created", async () => {
    const { ws, forge } = await wsWith("forge: https://alice:s3cr3t@example.com/acme/forge.git\nprofile: old\n");
    const r = runCli(["import", "--from", "claude-code", "--workspace", ws, "--forge", forge, "--profile", "acme", "--write-config"]);
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).not.toContain("s3cr3t");
    expect(r.stderr).toContain("craftar.yaml › forge holds credentials in the URL — remove them and let git authenticate");
    expect(await exists(forge)).toBe(false);
  });

  it("--forge with a URL is refused for import too", async () => {
    const { ws } = await wsWith("forge: ../forge\nprofile: acme\n");
    const r = runCli(["import", "--from", "claude-code", "--workspace", ws, "--forge", "https://example.com/acme/forge.git", "--profile", "acme"]);
    expect([r.code, r.stderr]).toEqual([1, "error: --forge takes a directory; to read a remote Forge, run inside a workspace that names it\n"]);
  });
});

describe("cli — a credential in a URL no parser accepts is still refused (review of spec 13)", () => {
  it("https with a bad port and ssh with a bad port: refused at load, the secret never printed", async () => {
    for (const forgeValue of ["https://SECRETTOKEN@127.0.0.1:badport/acme/forge.git", "ssh://u:SECRETPW@127.0.0.1:99999999/x"]) {
      const s = await scenario({ recipes: [recipe("base", [])], profiles: [profile("acme", ["base"])] }, { config: { profile: "acme" } });
      cleanups.push(s.cleanup);
      const home = await tmpDir("craftar-home-");
      cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
      await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), `forge: ${forgeValue}\nprofile: acme\n`);
      const r = runCli(["status", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } });
      expect(r.code, forgeValue).toBe(1);
      expect(r.stderr, forgeValue).toBe(
        "error: craftar.yaml › forge holds credentials in the URL — remove them and let git authenticate (credential helper, SSH agent; see README › Remote Forge)\n",
      );
      expect(r.stdout + r.stderr, forgeValue).not.toMatch(/SECRETTOKEN|SECRETPW/);
      expect(await fs.readdir(home), forgeValue).toEqual([]);
    }
  });
});

describe("cli — a remote Forge, the cases the review asked for (spec 13 §10.2, §10.3, AC 2)", () => {
  const SPEC = {
    ingredients: [rule("a", "# A\n"), rule("b", "# B\n")],
    recipes: [recipe("base", ["rule/a"]), recipe("stack", ["rule/b"], { extends: ["base"] })],
    profiles: [profile("acme", ["stack"], ["claude-code", "kiro"])],
  };
  async function remoteWs(extra = "") {
    const r = await remoteForge(SPEC);
    const ws = await tmpDir("craftar-remote-ws-");
    const home = await tmpDir("craftar-home-");
    cleanups.push(r.cleanup, () => fs.rm(ws, { recursive: true, force: true }), () => removeWithRetry(home));
    await fs.writeFile(path.join(ws, "craftar.yaml"), `forge: ${r.url}\nprofile: acme\n${extra}`);
    const run = (args: string[]) => runCli([...args, "--workspace", ws], { env: { CRAFTAR_HOME: home } });
    return { r, ws, home, run };
  }

  it("AC 2: the lock after a remote sync is schema 2 with ref null, the commit, the resolved recipes (extends parent first) and targets", async () => {
    const { r, ws, run } = await remoteWs();
    expect(run(["sync"]).code).toBe(0);
    const l = JSON.parse(await fs.readFile(path.join(ws, "craftar.lock"), "utf8"));
    expect([l.schema, l.forge, l.recipes, l.targets]).toEqual([
      2,
      { source: r.url, ref: null, commit: git(r.src, "rev-parse", "HEAD") },
      ["base", "stack"],
      ["claude-code", "kiro"],
    ]);
  });

  it("a ref is recorded in the lock as requested", async () => {
    const r0 = await remoteWs("ref: main\n");
    expect(r0.run(["sync"]).code).toBe(0);
    expect(JSON.parse(await fs.readFile(path.join(r0.ws, "craftar.lock"), "utf8")).forge.ref).toBe("main");
  });

  it("forge variants and forge diff through a remote workspace print what --forge on a clone prints; --offline too; a failed fetch warns on stderr", async () => {
    const { r, run, home } = await remoteWs();
    for (const args of [["forge", "variants", "--json"], ["forge", "diff", "rule/a", "--json"]]) {
      const viaClone = runCli([...args, "--forge", r.src]);
      const viaRemote = run(args);
      expect([viaRemote.code, viaRemote.stdout, viaRemote.stderr], args.join(" ")).toEqual([viaClone.code, viaClone.stdout, viaClone.stderr]);
      expect(run([...args, "--offline"]).stdout, `${args.join(" ")} --offline`).toBe(viaClone.stdout);
    }
    await fs.rename(r.bare, r.bare + ".gone");
    const x = run(["forge", "variants", "--json"]);
    expect(x.code).toBe(0);
    expect(x.stderr.startsWith(`warn Forge ${r.url} not fetched (`)).toBe(true);
  });

  it("forge: from craftar.local.yaml warns not to commit, on status, sync, diff, explain and ls", async () => {
    const s = await scenario(SPEC, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    await fs.writeFile(path.join(s.wsRoot, "craftar.local.yaml"), "forge: ../forge\n");
    const w = "Forge overridden by craftar.local.yaml (../forge) — do not commit craftar.lock or the generated files";
    expect(JSON.parse(runCli(["status", "--json", "--workspace", s.wsRoot]).stdout).warnings[0]).toBe(w);
    expect(runCli(["sync", "--workspace", s.wsRoot]).stdout.split("\n")).toContain(`  warn ${w}`);
    for (const args of [["diff"], ["explain", ".claude/rules/a.md"], ["ls"]]) {
      const x = runCli([...args, "--workspace", s.wsRoot]);
      expect([x.code, x.stderr], args.join(" ")).toEqual([0, `warn ${w}\n`]);
    }
  });

  it("targets with no cached copy points at a command that fetches, not at --offline", async () => {
    const { r, run } = await remoteWs();
    expect(JSON.parse(run(["targets", "--json"]).stdout).warnings).toEqual([
      `targets in use not shown: the Forge ${r.url} has no cached copy yet — run craftar status once to fetch it`,
    ]);
  });

  it("a relative CRAFTAR_HOME resolves from the current directory", async () => {
    const { r, ws } = await remoteWs();
    const cwd = await tmpDir("craftar-cwd-");
    cleanups.push(() => removeWithRetry(cwd));
    const x = runCli(["status", "--workspace", ws], { cwd, env: { CRAFTAR_HOME: "relhome" } });
    expect(x.code).toBe(0);
    expect(await fs.readdir(path.join(cwd, "relhome", "forges"))).toHaveLength(1);
  });
});

describe("cli — no message prints a credential before it is checked (review of spec 13, round 2)", () => {
  it("a ? or # inside the password is refused at load; a YAML syntax error names the place, not the line", async () => {
    const s = await scenario({ recipes: [recipe("base", [])], profiles: [profile("acme", ["base"])] }, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const run = () => runCli(["status", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } });
    await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), "forge: ssh://u:SECRET?x@h.invalid/r\nprofile: acme\n");
    const a = run();
    expect([a.code, a.stderr]).toEqual([
      1,
      "error: craftar.yaml › forge holds credentials in the URL — remove them and let git authenticate (credential helper, SSH agent; see README › Remote Forge)\n",
    ]);
    await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), "forge: https://u:SECRET@h.invalid/r: x\nprofile: acme\n");
    const b = run();
    expect(b.code).toBe(1);
    expect(b.stderr.startsWith("error: invalid craftar.yaml: ")).toBe(true);
    expect(b.stderr).toMatch(/line 1, column \d+/);
    expect(a.stdout + a.stderr + b.stdout + b.stderr).not.toContain("SECRET");
    expect(await fs.readdir(home)).toEqual([]);
  });
});

describe("cli — a workspace file's YAML never echoes a credential, on any command (review of spec 13, round 3)", () => {
  it("import with a YAML error in craftar.yaml, with and without --write-config: the secret is never printed", async () => {
    for (const extra of [[], ["--write-config"]]) {
      const root = await tmpDir("craftar-import-yaml-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const ws = path.join(root, "ws");
      await writeFiles(ws, { ".claude/rules/a.md": "# A\n", "craftar.yaml": "forge: https://u:SECRET@h.invalid/r: x\nprofile: acme\n" });
      const r = runCli(["import", "--from", "claude-code", "--workspace", ws, "--forge", path.join(root, "forge"), "--profile", "acme", ...extra]);
      expect(r.code, extra.join(" ")).toBe(1);
      expect(r.stderr, extra.join(" ")).toContain("import: craftar.yaml does not load (invalid craftar.yaml: ");
      expect(r.stdout + r.stderr, extra.join(" ")).not.toContain("SECRET");
    }
  });

  it("a YAML warning (an unknown tag) is not printed before the credential refusal", async () => {
    const s = await scenario({ recipes: [recipe("base", [])], profiles: [profile("acme", ["base"])] }, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), "forge: !foo https://u:SECRET@h.invalid/r\nprofile: acme\n");
    const r = runCli(["status", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("craftar.yaml › forge holds credentials in the URL");
    expect(r.stdout + r.stderr).not.toContain("SECRET");
  });
});

describe("cli — the workspace registry (spec 21 §10.3)", () => {
  const SPEC = {
    ingredients: [rule("a", "# A\n")],
    recipes: [recipe("base", ["rule/a"]), recipe("frontend-angular", [], { slot: "frontend" })],
    profiles: [profile("acme", ["base", "frontend-angular"])],
  };

  /** A temporary root with its own CRAFTAR_HOME, a path Forge, and workspaces made on demand. */
  async function setup() {
    const root = await tmpDir("craftar-registry-cli-");
    cleanups.push(() => removeWithRetry(root));
    const home = path.join(root, "home");
    const forgeRoot = path.join(root, "forge");
    await makeForge(forgeRoot, SPEC);
    const ws = async (name: string) => {
      const dir = path.join(root, name);
      await writeFiles(dir, { "craftar.yaml": "forge: ../forge\nprofile: acme\n" });
      return dir;
    };
    const run = (args: string[], env: NodeJS.ProcessEnv = {}) => runCli(args, { env: { CRAFTAR_HOME: home, ...env } });
    const registry = path.join(home, "registry.json");
    const entries = async () => JSON.parse(await fs.readFile(registry, "utf8")).workspaces as Array<{ path: string; lastSync: string }>;
    return { root, home, forgeRoot, ws, run, registry, entries };
  }

  it("a writing sync registers; --dry-run and --check do not; a sync with nothing to write still updates lastSync", async () => {
    const s = await setup();
    const a = await s.ws("acme-a");
    expect(s.run(["sync", "--dry-run", "--workspace", a]).code).toBe(0);
    expect(await exists(s.registry)).toBe(false);
    expect(s.run(["sync", "--workspace", a]).code).toBe(0);
    const [first] = await s.entries();
    expect(first.path).toBe(await fs.realpath(a));
    const b = await s.ws("acme-b");
    expect(s.run(["sync", "--check", "--workspace", b]).code).toBe(1);
    expect((await s.entries()).map((e) => path.basename(e.path))).toEqual(["acme-a"]);
    await new Promise((r) => setTimeout(r, 20));
    const again = s.run(["sync", "--workspace", a]);
    expect(again.stdout).toContain("wrote 0,");
    expect(again.stdout).not.toContain("registry");
    const [second] = await s.entries();
    expect(second.lastSync > first.lastSync).toBe(true);
  });

  it("CRAFTAR_NO_REGISTRY: a non-empty value turns it off for sync and refuses every workspaces form; an empty one is unset", async () => {
    const s = await setup();
    const a = await s.ws("acme-a");
    const off = { CRAFTAR_NO_REGISTRY: "1" };
    const r = s.run(["sync", "--workspace", a], off);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("registry");
    expect(await exists(s.home)).toBe(false);
    for (const args of [["workspaces"], ["workspaces", "--json"], ["workspaces", "forget", a], ["workspaces", "prune"]]) {
      const x = s.run(args, off);
      expect(x.code, args.join(" ")).toBe(1);
      expect(x.stderr).toContain("the workspace registry is off (CRAFTAR_NO_REGISTRY is set)");
    }
    expect(await exists(s.home)).toBe(false);
    expect(s.run(["sync", "--workspace", a], { CRAFTAR_NO_REGISTRY: "" }).code).toBe(0);
    expect(await s.entries()).toHaveLength(1);
  });

  it("a CRAFTAR_HOME that cannot hold the registry: sync still writes its files and lock, exits 0, and warns", async () => {
    const s = await setup();
    const a = await s.ws("acme-a");
    await fs.writeFile(s.home, "not a directory\n");
    const r = s.run(["sync", "--workspace", a]);
    expect(r.code).toBe(0);
    expect(await exists(path.join(a, ".claude/rules/a.md"))).toBe(true);
    expect(await exists(path.join(a, "craftar.lock"))).toBe(true);
    expect(r.stdout).toContain(`warn registry not updated (${s.registry}): `);
  });

  it("a registry of schema 2, or of invalid JSON: sync warns and leaves its bytes; workspaces exits 1 naming it", async () => {
    const s = await setup();
    const a = await s.ws("acme-a");
    for (const body of [JSON.stringify({ schema: 2, workspaces: [] }) + "\n", "{ not json\n"]) {
      await writeFiles(s.home, { "registry.json": body });
      const r = s.run(["sync", "--workspace", a]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`warn registry not updated (${s.registry}): `);
      expect(await fs.readFile(s.registry, "utf8")).toBe(body);
      const w = s.run(["workspaces"]);
      expect(w.code).toBe(1);
      expect(w.stderr).toMatch(body.startsWith("{ not") ? `cannot read ${s.registry}` : "registry.json declares schema 2, which this craftar does not read — upgrade craftar");
    }
  });

  it("the table: up to date and drift, then missing; prune and forget; an error row is never pruned; nothing is written", async () => {
    const s = await setup();
    const ok = await s.ws("acme-ok");
    const drift = await s.ws("acme-drift");
    const gone = await s.ws("acme-gone");
    const broken = await s.ws("acme-broken");
    for (const w of [ok, drift, gone, broken]) expect(s.run(["sync", "--workspace", w]).code).toBe(0);
    await writeFiles(drift, { ".claude/rules/a.md": "# Edited\n" });
    await fs.rm(gone, { recursive: true });
    await writeFiles(broken, { "craftar.yaml": "forge: ../nowhere\nprofile: acme\n" });
    const before = await fs.stat(s.registry);
    const bytes = await fs.readFile(s.registry, "utf8");

    const t = s.run(["workspaces"]);
    expect(t.code).toBe(0);
    const out = t.stdout;
    expect(out).toContain("craftar workspaces — 4 registered\n");
    expect(out).not.toContain("(status read offline");
    expect(out).toMatch(/acme-ok\s+.*\n\s+profile acme · frontend=frontend-angular · claude-code\n\s+forge \.\.\/forge @ no git · synced \d{4}-\d\d-\d\d \d\d:\d\d UTC · up to date\n/);
    expect(out).toMatch(/forge \.\.\/forge @ no git · synced [^\n]* · drift\n/);
    expect(out).toMatch(/acme-gone[^\n]*\n\s+profile acme · frontend=frontend-angular · claude-code\n\s+synced [^\n]* · missing\n/);
    expect(out).toMatch(/synced [^\n]* · error\n/);
    expect(out).toContain(`warn ${await fs.realpath(broken)}: Forge not found at `);
    expect(await fs.readFile(s.registry, "utf8")).toBe(bytes);
    expect((await fs.stat(s.registry)).mtimeMs).toBe(before.mtimeMs);

    const p1 = s.run(["workspaces", "prune"]);
    expect(p1.code).toBe(0);
    expect(p1.stdout.trim()).toBe(`pruned ${path.join(await fs.realpath(s.root), "acme-gone")}`);
    expect(s.run(["workspaces", "prune"]).stdout.trim()).toBe("nothing to prune");
    const f = s.run(["workspaces", "forget", drift]);
    expect(f.code).toBe(0);
    expect(f.stdout.trim()).toBe(`forgot ${await fs.realpath(drift)}`);
    const again = s.run(["workspaces", "forget", drift]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain(`${await fs.realpath(drift)} is not registered`);
    expect((await s.entries()).map((e) => path.basename(e.path))).toEqual(["acme-broken", "acme-ok"]);
  });

  it("a Forge from craftar.local.yaml is recorded and marked (local override)", async () => {
    const s = await setup();
    const a = await s.ws("acme-a");
    await writeFiles(a, { "craftar.yaml": "forge: ../nowhere\nprofile: acme\n", "craftar.local.yaml": "forge: ../forge\n" });
    expect(s.run(["sync", "--workspace", a]).code).toBe(0);
    expect(JSON.parse(await fs.readFile(s.registry, "utf8")).workspaces[0].forge).toMatchObject({ source: "../forge", fromLocalFile: true });
    expect(s.run(["workspaces"]).stdout).toMatch(/forge \.\.\/forge \(local override\) @ no git · synced /);
  });

  it("an empty registry", async () => {
    const s = await setup();
    const r = s.run(["workspaces"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("craftar workspaces — no workspace registered (craftar sync registers one)");
  });

  it("--json: the full key set for a path Forge, a remote Forge and a missing row", async () => {
    const s = await setup();
    const a = await s.ws("acme-a");
    const r = await remoteForge(SPEC);
    cleanups.push(r.cleanup);
    const rem = path.join(s.root, "acme-remote");
    await writeFiles(rem, { "craftar.yaml": `forge: ${r.url}\nprofile: acme\n` });
    const gone = await s.ws("acme-gone");
    for (const w of [a, rem, gone]) expect(s.run(["sync", "--workspace", w]).code).toBe(0);
    await fs.rm(gone, { recursive: true });
    const j = JSON.parse(s.run(["workspaces", "--json"]).stdout);
    expect(Object.keys(j)).toEqual(["registry", "fetch", "workspaces", "warnings"]);
    expect(j.registry).toBe(s.registry);
    expect(j.fetch).toBe(false);
    const rowKeys = ["name", "path", "profile", "recipes", "stack", "targets", "forge", "lastSync", "status", "forgeMoved", "files"];
    const forgeKeys = ["kind", "source", "key", "ref", "defaultBranch", "commit", "lockCommit", "fromLocalFile", "fetched"];
    for (const row of j.workspaces) {
      expect(Object.keys(row)).toEqual(rowKeys);
      expect(Object.keys(row.forge)).toEqual(forgeKeys);
    }
    const by = Object.fromEntries(j.workspaces.map((w: { name: string }) => [w.name, w]));
    const sha = git(r.src, "rev-parse", "HEAD");
    expect(by["acme-a"]).toMatchObject({ status: "up-to-date", forgeMoved: null, files: { unchanged: 1 }, stack: { frontend: "frontend-angular" }, forge: { kind: "path", ref: null, commit: null, lockCommit: null, fetched: false } });
    expect(by["acme-remote"]).toMatchObject({ status: "up-to-date", forgeMoved: false, forge: { kind: "remote", source: r.url, ref: null, defaultBranch: "main", commit: sha, lockCommit: sha, fetched: false } });
    expect(by["acme-gone"]).toMatchObject({ status: "missing", forgeMoved: null, files: null, forge: { defaultBranch: null, lockCommit: null, fetched: false } });
    expect(j.warnings).toEqual([]);
  });

  it("a remote Forge: read offline from the cache without fetching; --fetch picks up a new commit", async () => {
    const s = await setup();
    const r = await remoteForge(SPEC);
    cleanups.push(r.cleanup);
    const rem = path.join(s.root, "acme-remote");
    await writeFiles(rem, { "craftar.yaml": `forge: ${r.url}\nprofile: acme\n` });
    expect(s.run(["sync", "--workspace", rem]).code).toBe(0);
    const entry = path.join(s.home, "forges", (await fs.readdir(path.join(s.home, "forges")))[0]);
    const refs = () => git(path.join(entry, "repo.git"), "for-each-ref");
    const stamp = () => fs.readFile(path.join(entry, "fetched"), "utf8");
    const [refs0, stamp0, reg0] = [refs(), await stamp(), await fs.readFile(s.registry, "utf8")];
    const next = await r.commit({ "README.md": "moved\n" });
    await fs.rename(r.bare, `${r.bare}.away`);
    const off = s.run(["workspaces"]);
    expect(off.code).toBe(0);
    expect(off.stdout).toContain("craftar workspaces — 1 registered (status read offline from the Forge cache)\n");
    expect(off.stdout).toContain(" · up to date\n");
    expect(refs()).toBe(refs0);
    expect(await stamp()).toBe(stamp0);
    expect(await fs.readFile(s.registry, "utf8")).toBe(reg0);
    await fs.rename(`${r.bare}.away`, r.bare);
    const on = JSON.parse(s.run(["workspaces", "--json", "--fetch"]).stdout);
    expect(on.fetch).toBe(true);
    expect(on.workspaces[0]).toMatchObject({ forgeMoved: true, forge: { commit: next, fetched: true } });
  });
});

describe("cli — add recipe / remove recipe (spec 22)", () => {
  const R2 = (x: string) => `error: recipe "${x}" not found in this Forge (base, front-a, front-b, front-c, stack-api)\n`;
  const R6 = (cmd: string) =>
    `error: ${cmd}: cannot edit craftar.yaml in place (it does not round-trip unchanged through the YAML writer: line 3, under recipes) — reformat it by hand and re-run\n`;
  const BASE_YAML = "forge: ../forge\nprofile: acme\n";

  /** Spec 22 §9's Forge, profile acme = [stack-api, front-a]; synced unless asked not to. */
  async function recipeScenario(opts: { sync?: boolean; local?: Record<string, unknown> } = {}) {
    const s = await scenario(
      {
        ingredients: [
          rule("base", "base\n"),
          rule("api", "api\n"),
          rule("front-a", "front a\n"),
          rule("front-b", "front b\n"),
          rule("front-c", "owner {{owner}}\n"),
        ],
        recipes: [
          recipe("base", ["rule/base"]),
          recipe("stack-api", ["rule/api"], { extends: ["base"] }),
          recipe("front-a", ["rule/front-a"], { slot: "front" }),
          recipe("front-b", ["rule/front-b"], { slot: "front" }),
          recipe("front-c", ["rule/front-c"], { slot: "front" }),
        ],
        profiles: [profile("acme", ["stack-api", "front-a"])],
      },
      { config: { profile: "acme" }, local: opts.local },
    );
    cleanups.push(s.cleanup);
    if (opts.sync !== false) expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    return s;
  }
  const yamlOf = (s: { wsRoot: string }) => fs.readFile(path.join(s.wsRoot, "craftar.yaml"), "utf8");
  const setYaml = (s: { wsRoot: string }, text: string) => fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), text);
  const recipeCli = (s: { wsRoot: string }, ...args: string[]) => runCli([...args, "--workspace", s.wsRoot]);
  /** Snapshots the workspace (but craftar.yaml) and the Forge; the returned check asserts nothing else moved. */
  async function guard(s: { wsRoot: string; forgeRoot: string }) {
    const strip = (snap: Record<string, string>) => {
      delete snap["craftar.yaml"];
      return snap;
    };
    const ws = strip(await snapshot(s.wsRoot));
    const forgeBefore = await snapshot(s.forgeRoot);
    return async () => {
      expect(strip(await snapshot(s.wsRoot))).toEqual(ws);
      expect(await snapshot(s.forgeRoot)).toEqual(forgeBefore);
    };
  }

  it("test 1: a slot held by another recipe is refused without --replace (R3)", async () => {
    const s = await recipeScenario();
    const r = recipeCli(s, "add", "recipe", "front-b");
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe('error: recipe "front-b" occupies slot "front", held by "front-a" — pass --replace to swap them\n');
    expect(await yamlOf(s)).toBe(BASE_YAML);
  });

  it("tests 2–3: --replace swaps, the output says what the next sync does, and swapping back cancels", async () => {
    const s = await recipeScenario();
    const r = recipeCli(s, "add", "recipe", "front-b", "--replace");
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "craftar.yaml: recipes.add + front-b; recipes.remove + front-a\n" +
        "recipes: base → stack-api → front-b\n" +
        "next sync: 1 new, 1 orphan — run `craftar sync`\n",
    );
    expect(await yamlOf(s)).toBe(BASE_YAML + "recipes:\n  add:\n    - front-b\n  remove:\n    - front-a\n");
    expect(recipeCli(s, "status").stdout.split("\n")[0]).toBe("craftar status — profile acme · recipes base → stack-api → front-b");

    const back = recipeCli(s, "add", "recipe", "front-a", "--replace");
    expect(back.code).toBe(0);
    expect(back.stderr).toBe("");
    expect(back.stdout).toBe(
      "craftar.yaml: recipes.add - front-b; recipes.remove - front-a\n" +
        "recipes: base → stack-api → front-a\n" +
        "next sync: nothing to sync\n",
    );
    expect(await yamlOf(s)).toBe(BASE_YAML + "recipes:\n  add: []\n  remove: []\n");
  });

  it("test 4: remove of a recipe extends brings in is refused, naming the top-level recipe (R4)", async () => {
    const s = await recipeScenario();
    const r = recipeCli(s, "remove", "recipe", "base");
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe('error: recipe "base" comes in through "stack-api" (extends) — remove "stack-api", or change the Forge\n');
    expect(await yamlOf(s)).toBe(BASE_YAML);
  });

  it("test 5: remove of a profile recipe takes what only it brought in", async () => {
    const s = await recipeScenario();
    const r = recipeCli(s, "remove", "recipe", "stack-api");
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("craftar.yaml: recipes.remove + stack-api\nrecipes: front-a\nnext sync: 2 orphan — run `craftar sync`\n");
    expect(await yamlOf(s)).toBe(BASE_YAML + "recipes:\n  remove:\n    - stack-api\n");
  });

  it("test 6: add of a recipe in use changes nothing and writes nothing", async () => {
    const s = await recipeScenario();
    const r = recipeCli(s, "add", "recipe", "stack-api");
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("nothing to change: stack-api is already in use\n");
    expect(await yamlOf(s)).toBe(BASE_YAML);
  });

  it("test 7: an unknown name is R2; one written by hand is R5 for other calls and cleaned up by remove", async () => {
    const s = await recipeScenario();
    const unmoved = await guard(s);
    const r = recipeCli(s, "add", "recipe", "nope");
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(R2("nope"));

    await setYaml(s, BASE_YAML + "recipes:\n  add: [nope]\n");
    const st = recipeCli(s, "status");
    expect(st.code).toBe(1);
    expect(st.stderr).toBe('error: recipe "nope" not found (referenced by craftar.yaml recipes.add)\n');
    const other = recipeCli(s, "add", "recipe", "front-b", "--replace");
    expect(other.code).toBe(1);
    expect(other.stdout).toBe("");
    expect(other.stderr).toBe('error: recipe "nope" not found (referenced by craftar.yaml recipes.add)\n');

    const clean = recipeCli(s, "remove", "recipe", "nope");
    expect(clean.code).toBe(0);
    expect(clean.stderr).toBe("");
    expect(clean.stdout).toBe("craftar.yaml: recipes.add - nope\nrecipes: base → stack-api → front-a\nnext sync: nothing to sync\n");
    expect(await yamlOf(s)).toBe(BASE_YAML + "recipes:\n  add: []\n");
    await unmoved();
  });

  it("tests 8–9: a name twice is R7; one bad name refuses the whole call", async () => {
    const s = await recipeScenario();
    const twice = recipeCli(s, "add", "recipe", "front-b", "front-b", "--replace");
    expect(twice.code).toBe(1);
    expect(twice.stdout).toBe("");
    expect(twice.stderr).toBe('error: recipe "front-b" is named twice\n');
    const bad = recipeCli(s, "add", "recipe", "front-b", "nope", "--replace");
    expect(bad.code).toBe(1);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toBe(R2("nope"));
    expect(await yamlOf(s)).toBe(BASE_YAML);
  });

  it("test 10: craftar.local.yaml with recipes is refused for both commands (R1); with only targets it is not", async () => {
    const R1 = "error: craftar.local.yaml sets recipes, which replaces craftar.yaml's lists — edit it by hand, or remove its recipes key and re-run\n";
    const s = await recipeScenario({ sync: false, local: { recipes: { add: [] } } });
    const unmovedS = await guard(s);
    for (const args of [["add", "recipe", "front-b", "--replace"], ["remove", "recipe", "stack-api"]]) {
      const r = recipeCli(s, ...args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stdout, args.join(" ")).toBe("");
      expect(r.stderr, args.join(" ")).toBe(R1);
    }
    expect(await yamlOf(s)).toBe(BASE_YAML);

    await unmovedS();

    const t = await recipeScenario({ local: { targets: ["claude-code"] } });
    const unmovedT = await guard(t);
    const ok = recipeCli(t, "add", "recipe", "front-b", "--replace");
    expect(ok.code).toBe(0);
    expect(ok.stderr).toBe("");
    expect(ok.stdout).toBe(
      "craftar.yaml: recipes.add + front-b; recipes.remove + front-a\n" +
        "recipes: base → stack-api → front-b\n" +
        "next sync: 1 new, 1 orphan — run `craftar sync`\n",
    );
    await unmovedT();
  });

  it("tests 11–12: the README's padded flow form is R6, file untouched; the unpadded one is edited in place", async () => {
    const s = await recipeScenario();
    const unmoved = await guard(s);
    const padded = BASE_YAML + "recipes: { add: [], remove: [] }\n";
    await setYaml(s, padded);
    const r = recipeCli(s, "add", "recipe", "front-b", "--replace");
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(R6("add recipe"));
    expect(await yamlOf(s)).toBe(padded);

    await setYaml(s, "\uFEFF" + BASE_YAML.replace(/\n/g, "\r\n") + "recipes: {add: [], remove: []}\r\n");
    const r2 = recipeCli(s, "remove", "recipe", "stack-api");
    expect(r2.code).toBe(0);
    expect(r2.stderr).toBe("");
    expect(r2.stdout).toBe("craftar.yaml: recipes.remove + stack-api\nrecipes: front-a\nnext sync: 2 orphan — run `craftar sync`\n");
    expect(await yamlOf(s)).toBe("\uFEFF" + BASE_YAML.replace(/\n/g, "\r\n") + "recipes: {add: [], remove: [stack-api]}\r\n");
    await unmoved();
  });

  it("test 13: nothing to sync when no file moves; an undeclared param is left silently", async () => {
    const s = await recipeScenario();
    const unmovedS = await guard(s);
    await setYaml(s, BASE_YAML + "recipes:\n  remove: [base]\n");
    const r = recipeCli(s, "add", "recipe", "base");
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("craftar.yaml: recipes.remove - base\nrecipes: base → stack-api → front-a\nnext sync: nothing to sync\n");

    await unmovedS();

    const t = await recipeScenario();
    const unmovedT = await guard(t);
    const w = recipeCli(t, "add", "recipe", "front-c", "--replace");
    expect(w.code).toBe(0);
    expect(w.stdout).toBe(
      "craftar.yaml: recipes.add + front-c; recipes.remove + front-a\n" +
        "recipes: base → stack-api → front-c\n" +
        "next sync: 1 new, 1 orphan — run `craftar sync`\n",
    );
    // An undeclared key is left verbatim silently — no warning
    expect(w.stderr).toBe("");
    await unmovedT();
  });

  it("test 14: nothing but craftar.yaml is written, by any call", async () => {
    const s = await recipeScenario();
    const ws = await snapshot(s.wsRoot);
    const forgeBefore = await snapshot(s.forgeRoot);
    for (const args of [
      ["add", "recipe", "front-b"],
      ["remove", "recipe", "base"],
      ["add", "recipe", "nope"],
      ["add", "recipe", "front-b", "--replace"],
      ["remove", "recipe", "stack-api"],
      ["add", "recipe", "stack-api"],
    ])
      recipeCli(s, ...args);
    const after = await snapshot(s.wsRoot);
    delete ws["craftar.yaml"];
    delete after["craftar.yaml"];
    expect(after).toEqual(ws);
    expect(await snapshot(s.forgeRoot)).toEqual(forgeBefore);
  });

  it("test 15: --replace with no slot conflict is the same as without it", async () => {
    const s = await recipeScenario();
    const t = await recipeScenario();
    for (const w of [s, t]) expect(recipeCli(w, "remove", "recipe", "stack-api").code).toBe(0);
    const a = recipeCli(s, "add", "recipe", "stack-api", "--replace");
    const b = recipeCli(t, "add", "recipe", "stack-api");
    expect(a.code).toBe(0);
    expect(a.stdout).toBe("craftar.yaml: recipes.remove - stack-api\nrecipes: base → stack-api → front-a\nnext sync: nothing to sync\n");
    expect(b.stdout).toBe(a.stdout);
    expect(await yamlOf(t)).toBe(await yamlOf(s));
  });

  it("test 16: --replace removes every other holder of the slot", async () => {
    const s = await recipeScenario();
    const unmoved = await guard(s);
    await setYaml(s, BASE_YAML + "recipes:\n  add: [front-c]\n");
    const r = recipeCli(s, "add", "recipe", "front-b", "--replace");
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "craftar.yaml: recipes.add + front-b, - front-c; recipes.remove + front-a\n" +
        "recipes: base → stack-api → front-b\n" +
        "next sync: 1 new, 1 orphan — run `craftar sync`\n",
    );
    expect(await yamlOf(s)).toBe(BASE_YAML + "recipes:\n  add: [front-b]\n  remove:\n    - front-a\n");
    await unmoved();
  });

  it("test 17: an edit that resolves but does not plan is refused, craftar.yaml untouched (R5, §5.2 step 4)", async () => {
    const s = await scenario(
      {
        ingredients: [rule("b", "b\n"), rule("m", "<!-- craftar:section s -->\nx\n<!-- /craftar:section -->\n")],
        recipes: [recipe("base", ["rule/b"]), recipe("marked", ["rule/m"])],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    const unmoved = await guard(s);
    const r = runCli(["add", "recipe", "marked", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "error: craftar.forge.yaml declares schema: 1, but ingredients/rules/m/rule.md:1 holds a section marker — set schema: 2 in craftar.forge.yaml, so that craftar 0.6.2 and older refuse this Forge instead of emitting the markers\n",
    );
    expect(await fs.readFile(path.join(s.wsRoot, "craftar.yaml"), "utf8")).toBe(BASE_YAML);
    await unmoved();
  });

  it("§14 item 7: recipes --json carries the craftar.yaml wording in its warning", async () => {
    const s = await recipeScenario();
    await setYaml(s, BASE_YAML + "recipes:\n  add: [nope]\n");
    const r = recipeCli(s, "recipes", "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).warnings).toEqual([
      'cannot resolve this workspace (profile acme): recipe "nope" not found (referenced by craftar.yaml recipes.add) — nothing is marked as in use',
    ]);
  });

  it("test 18: a workspace warning is printed once, on stderr", async () => {
    const s = await recipeScenario();
    await setYaml(s, "forge: ../forge\nref: v1\nprofile: acme\n");
    const r = recipeCli(s, "add", "recipe", "front-b", "--replace");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      "craftar.yaml: recipes.add + front-b; recipes.remove + front-a\n" +
        "recipes: base → stack-api → front-b\n" +
        "next sync: 1 new, 1 orphan — run `craftar sync`\n",
    );
    expect(r.stderr).toBe('warn ref "v1" is ignored: the Forge is a path (../forge), read as its working tree\n');
  });
});

describe("cli — a missing craftar.yaml points at craftar init first (spec 23 §13 item 6)", () => {
  it("every command that loads a workspace through loadWorkspace names craftar init, then import", async () => {
    const dir = await tmpDir("craftar-no-yaml-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const expected = `error: craftar.yaml not found in ${dir} — run \`craftar init --workspace "${dir}" --forge <dir> --profile <name>\` to start one, or \`craftar import --workspace "${dir}" --from claude-code --forge <dir> --profile <name> --write-config\` to bring in an existing harness\n`;
    for (const args of [["status"], ["sync"], ["diff"], ["explain", "x.md"], ["ls"], ["add", "recipe", "base"], ["remove", "recipe", "base"], ["targets"]]) {
      const r = runCli([...args, "--workspace", dir]);
      expect([r.code, r.stderr], args.join(" ")).toEqual([1, expected]);
    }
  });
});

describe("cli — craftar init (spec 23 §9.2)", () => {
  const SPEC = {
    ingredients: [rule("a", "# A\n"), rule("b", "# B\n"), rule("p", "# P {{nope}}\n")],
    recipes: [recipe("base", ["rule/a"]), recipe("extra", ["rule/b"]), recipe("ph", ["rule/p"])],
    profiles: [profile("acme", ["base"])],
  };
  const COLLISION = "  warn 1 file(s) already in the workspace differ from the Forge and were left as they are — to bring them into the Forge, run craftar import";

  /** A temporary root with its own CRAFTAR_HOME and a path Forge; workspaces are siblings of the Forge. */
  async function setup() {
    const root = await tmpDir("craftar-init-cli-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    const forge = path.join(root, "forge");
    await makeForge(forge, SPEC);
    const run = (args: string[], env: NodeJS.ProcessEnv = {}) => runCli(args, { env: { CRAFTAR_HOME: home, ...env } });
    const init = (ws: string, extra: string[] = [], env: NodeJS.ProcessEnv = {}) =>
      run(["init", "--workspace", ws, "--forge", forge, "--profile", "acme", ...extra], env);
    const registry = path.join(home, "registry.json");
    return { root, home, forge, run, init, registry };
  }
  const withoutLock = (snap: Record<string, string>) => Object.fromEntries(Object.entries(snap).filter(([k]) => k !== "craftar.lock"));
  const lockBody = async (ws: string) => {
    const { generatedAt, ...rest } = JSON.parse(await fs.readFile(path.join(ws, "craftar.lock"), "utf8"));
    void generatedAt;
    return rest;
  };

  it("an empty directory: craftar.yaml, then the same workspace and report a hand-written craftar.yaml plus sync give; registered", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    await fs.mkdir(ws);
    const r = s.init(ws);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    const lines = r.stdout.split("\n");
    expect(lines.slice(0, 2)).toEqual([
      `craftar init — wrote craftar.yaml in ${ws}`,
      "  forge ../forge · profile acme · recipes base · targets claude-code (from the profile)",
    ]);
    expect(await fs.readFile(path.join(ws, "craftar.yaml"), "utf8")).toBe("forge: ../forge\nprofile: acme\n");

    const hand = path.join(s.root, "hand");
    await writeFiles(hand, { "craftar.yaml": "forge: ../forge\nprofile: acme\n" });
    const h = s.run(["sync", "--workspace", hand]);
    expect(h.code).toBe(0);
    expect(lines.slice(2).join("\n")).toBe(h.stdout);
    expect(withoutLock(await snapshot(ws))).toEqual(withoutLock(await snapshot(hand)));
    expect(await lockBody(ws)).toEqual(await lockBody(hand));
    const reg = JSON.parse(await fs.readFile(s.registry, "utf8")).workspaces.map((w: { path: string }) => w.path);
    expect(reg).toContain(await fs.realpath(ws));
  });

  it("craftar.yaml already there: N1, the file unchanged", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    await writeFiles(ws, { "craftar.yaml": "forge: elsewhere\nprofile: other\n" });
    const r = s.init(ws);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`error: craftar.yaml already exists in ${ws} — change recipes with craftar add recipe / remove recipe, or edit it\n`);
    expect(await snapshot(ws)).toEqual({ "craftar.yaml": "forge: elsewhere\nprofile: other\n" });
  });

  it("--workspace: created when missing, not created on a refusal, refused when it is a file (N9)", async () => {
    const s = await setup();
    const ws = path.join(s.root, "new", "deep");
    const r = s.init(ws);
    expect(r.code, r.stderr).toBe(0);
    expect(await fs.readFile(path.join(ws, "craftar.yaml"), "utf8")).toBe("forge: ../../forge\nprofile: acme\n");

    const never = path.join(s.root, "never");
    const n5 = s.run(["init", "--workspace", never, "--forge", s.forge, "--profile", "nope"]);
    expect(n5.code).toBe(1);
    expect(n5.stderr).toBe('error: profile "nope" not found in Forge (acme)\n');
    expect(await exists(never)).toBe(false);

    const file = path.join(s.root, "a-file");
    await fs.writeFile(file, "x\n");
    const n9 = s.init(file);
    expect(n9.code).toBe(1);
    expect(n9.stderr).toBe(`error: cannot use ${file} as a workspace: it is not a directory\n`);
    expect(await fs.readFile(file, "utf8")).toBe("x\n");
  });

  it("a differing file already there: left as it is, a collision, the import warning, exit 0", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    await writeFiles(ws, { ".claude/rules/a.md": "# mine\n" });
    const r = s.init(ws);
    expect(r.code, r.stderr).toBe(0);
    expect(await fs.readFile(path.join(ws, ".claude/rules/a.md"), "utf8")).toBe("# mine\n");
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines).toContain("  wrote 0, removed 0 orphan(s), skipped 1");
    expect(lines.at(-1)).toBe(COLLISION);
    // Without a collision there is no such line.
    const clean = path.join(s.root, "clean");
    expect(s.init(clean).stdout).not.toContain("already in the workspace differ");
  });

  it("a craftar.lock from an earlier sync: --no-sync counts update and orphan; without it, sync's report", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    await writeFiles(ws, { "craftar.yaml": "forge: ../forge\nprofile: acme\nrecipes:\n  add: [extra]\n" });
    expect(s.run(["sync", "--workspace", ws]).code).toBe(0);
    await writeFiles(s.forge, { "ingredients/rules/a/rule.md": "# A changed\n" });
    await fs.rm(path.join(ws, "craftar.yaml"));
    const dry = s.init(ws, ["--no-sync"]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout.split("\n")[2]).toBe("next sync: 1 update, 1 orphan — run `craftar sync`");
    await fs.rm(path.join(ws, "craftar.yaml"));
    const r = s.init(ws);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.split("\n").slice(2, 6)).toEqual([
      "craftar sync — profile acme · recipes base · targets claude-code",
      "  wrote 1, removed 1 orphan(s), skipped 0",
      "  + .claude/rules/a.md",
      "  - .claude/rules/b.md  (orphan: no longer produced by the Forge)",
    ]);
  });

  it("--no-sync: craftar.yaml only, the next sync line, nothing registered; an undeclared param is left silently", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    const r = s.init(ws, ["--no-sync", "--add-recipe", "ph"]);
    expect(r.code, r.stderr).toBe(0);
    // An undeclared key is left verbatim silently — no warning
    expect(r.stdout).toBe(
      [
        `craftar init — wrote craftar.yaml in ${ws}`,
        "  forge ../forge · profile acme · recipes base → ph · targets claude-code (from the profile)",
        "next sync: 2 new — run `craftar sync`",
        "",
      ].join("\n"),
    );
    expect(await snapshot(ws)).toEqual({ "craftar.yaml": "forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - ph\n" });
    expect(await exists(s.registry)).toBe(false);
    // Then craftar sync gives the tree init without the flag gives (§6 case 7).
    expect(s.run(["sync", "--workspace", ws]).code).toBe(0);
    const other = path.join(s.root, "other");
    expect(s.init(other, ["--add-recipe", "ph"]).code).toBe(0);
    expect(withoutLock(await snapshot(ws))).toEqual(withoutLock(await snapshot(other)));
  });

  it("CRAFTAR_NO_REGISTRY=1: synced, not registered", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    const r = s.init(ws, [], { CRAFTAR_NO_REGISTRY: "1" });
    expect(r.code, r.stderr).toBe(0);
    expect(await fs.readFile(path.join(ws, ".claude/rules/a.md"), "utf8")).toBe("# A\n");
    expect(await exists(s.registry)).toBe(false);
  });

  it("the first block: targets labelled by where they come from; a recipe call that changes nothing is a note", async () => {
    const s = await setup();
    const a = path.join(s.root, "a");
    const r = s.init(a, ["--no-sync", "--targets", "claude-code,kiro", "--remove-recipe", "extra"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.split("\n").slice(1, 3)).toEqual(["  forge ../forge · profile acme · recipes base · targets claude-code, kiro", "  note extra is not in use"]);
    expect(await fs.readFile(path.join(a, "craftar.yaml"), "utf8")).toBe("forge: ../forge\nprofile: acme\ntargets:\n  - claude-code\n  - kiro\n");
    const b = path.join(s.root, "b");
    await writeFiles(b, { "craftar.local.yaml": "targets: [kiro]\n" });
    const l = s.init(b, ["--no-sync"]);
    expect(l.code, l.stderr).toBe(0);
    expect(l.stdout.split("\n")[1]).toBe("  forge ../forge · profile acme · recipes base · targets kiro (from craftar.local.yaml)");
    const n10 = s.init(b, ["--no-sync", "--targets", "kiro"]);
    expect(n10.code).toBe(1);
  });

  it("a credential in --forge is refused naming the flag, never the value; nothing written", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    const r = s.run(["init", "--workspace", ws, "--forge", "https://alice:s3cr3t@example.invalid/acme/forge.git", "--profile", "acme"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("error: --forge holds credentials in the URL — remove them and let git authenticate (credential helper, SSH agent; see README › Remote Forge)\n");
    expect(r.stdout + r.stderr).not.toContain("s3cr3t");
    expect(await exists(ws)).toBe(false);
  });

  it("--forge and --profile are required (N2)", async () => {
    // Test 1: --profile missing → N2 with our message (replaces pinned commander line)
    const s = await setup();
    const ws = path.join(s.root, "ws");
    const r = s.run(["init", "--workspace", ws, "--forge", s.forge]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: --profile is required when craftar init does not run in a terminal — pass it, or run craftar init in a terminal to be asked\n");
    expect(await exists(ws)).toBe(false);
  });
});

describe("cli — craftar doctor (spec 24 §9.2)", () => {
  const SPEC = { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] };

  async function setup() {
    const root = await tmpDir("craftar-doctor-cli-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    await makeForge(path.join(root, "forge"), SPEC);
    const ws = path.join(root, "acme-a");
    await writeFiles(ws, { "craftar.yaml": "forge: ../forge\nprofile: acme\n" });
    const run = (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
      runCli(["doctor", ...args], { cwd: opts.cwd, env: { CRAFTAR_HOME: home, ...opts.env } });
    return { root, home, ws, run };
  }

  it("exit 0 with warnings; 1 with an error; --strict turns a warning into exit 1", async () => {
    const s = await setup();
    const warn = s.run(["--workspace", s.ws]);
    expect(warn.code).toBe(0);
    expect(warn.stdout).toMatch(/\n {2}warn {3}lock {10}absent — never synced — craftar sync\n/);
    expect(warn.stdout).toMatch(/\nsummary: \d+ ok, 1 warn, 0 error\n$/);
    expect(s.run(["--workspace", s.ws, "--strict"]).code).toBe(1);
    await writeFiles(s.ws, { "craftar.yaml": "forge: ../nowhere\nprofile: acme\n" });
    const err = s.run(["--workspace", s.ws]);
    expect(err.code).toBe(1);
    expect(err.stdout).toMatch(/ error  config +Forge not found at /);
  });

  it("doctor exits 1 without --strict when a declared, cited parameter has no value (spec 29)", async () => {
    const s = await scenario(
      { ingredients: [rule("a", "Org: {{org}}\n", { params: { org: { description: "o" } } })], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    const r = runCli(["doctor", "--workspace", s.wsRoot, "--json"]);
    expect(r.code).toBe(1);
    const params = JSON.parse(r.stdout).checks.filter((c: { id: string }) => c.id === "params");
    expect(params.map((c: { level: string }) => c.level)).toEqual(["error"]);
  });

  it("outside a workspace: machine checks only, exit 0; an explicit --workspace without craftar.yaml exits 1 on stderr, --json too", async () => {
    const s = await setup();
    const out = s.run([], { cwd: s.root });
    expect(out.code).toBe(0);
    expect(out.stdout.split("\n")[0]).toMatch(/· no workspace \(machine checks only\)$/);
    expect(out.stdout).not.toMatch(/ config /);
    for (const extra of [[], ["--json"]]) {
      const bad = s.run(["--workspace", s.root, ...extra]);
      expect(bad.code).toBe(1);
      expect(bad.stdout).toBe("");
      expect(bad.stderr).toContain(`no craftar.yaml in ${s.root} — run doctor inside a workspace, or without --workspace for the machine checks`);
    }
  });

  it("the current directory with craftar.yaml is checked without --workspace", async () => {
    const s = await setup();
    const r = s.run([], { cwd: s.ws });
    expect(r.stdout.split("\n")[0]).toContain(await fs.realpath(s.ws));
    expect(r.stdout).toMatch(/ ok {5}config /);
  });

  it("--json: the top-level keys and each check's keys in order, one entry per finding", async () => {
    const s = await setup();
    const j = JSON.parse(s.run(["--workspace", s.ws, "--json"]).stdout);
    expect(Object.keys(j)).toEqual(["version", "workspace", "fetch", "strict", "checks", "summary"]);
    expect(j).toMatchObject({ workspace: await fs.realpath(s.ws), fetch: false, strict: false });
    for (const c of j.checks) expect(Object.keys(c)).toEqual(["id", "scope", "level", "message", "fix"]);
    expect(j.checks.map((c: { id: string }) => c.id)).toEqual(["node", "git", "home", "registry", "cache", "config", "forge", "forge-inside", "plan", "params", "mcp-env", "lock", "registered"]);
    expect(Object.keys(j.summary)).toEqual(["ok", "warn", "error"]);
  });

  it("writes nothing: the workspace tree and the registry are byte-identical before and after", async () => {
    const s = await setup();
    expect(runCli(["sync", "--workspace", s.ws], { env: { CRAFTAR_HOME: s.home } }).code).toBe(0);
    const before = await snapshot(s.ws);
    const reg = await fs.readFile(path.join(s.home, "registry.json"), "utf8");
    expect(s.run(["--workspace", s.ws]).code).toBe(0);
    expect(await snapshot(s.ws)).toEqual(before);
    expect(await fs.readFile(path.join(s.home, "registry.json"), "utf8")).toBe(reg);
  });

  it("text: a message that already ends in its fix is not suffixed twice", async () => {
    const s = await setup();
    await writeFiles(s.home, { "registry.json": JSON.stringify({ schema: 9, workspaces: [] }) });
    const out = s.run([], { cwd: s.root }).stdout;
    expect(out).toMatch(/registry\.json declares schema 9, which this craftar does not read — upgrade craftar\n/);
    expect(out).not.toContain("upgrade craftar — upgrade craftar");
  });

  it("CRAFTAR_NO_REGISTRY: non-empty turns the registry off; empty still reads it", async () => {
    const s = await setup();
    await writeFiles(s.home, { "registry.json": JSON.stringify({ schema: 2, workspaces: [] }) });
    const line = (env: NodeJS.ProcessEnv) => JSON.parse(s.run(["--json"], { cwd: s.root, env }).stdout).checks.find((c: { id: string }) => c.id === "registry");
    expect(line({ CRAFTAR_NO_REGISTRY: "1" })).toMatchObject({ level: "ok", message: "off (CRAFTAR_NO_REGISTRY)" });
    expect(line({ CRAFTAR_NO_REGISTRY: "" })).toMatchObject({ level: "error", fix: "upgrade craftar" });
  });

  it("8. mcp-env with a marker value: marker does not appear in text or --json output", async () => {
    const marker = "MARKER_SECRET_27";
    const root = await tmpDir("craftar-doctor-mcp-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    // Forge with an MCP ingredient declaring authEnv
    const mcp = { meta: { type: "mcp", name: "tracker", authEnv: ["ACME_TRACKER_TOKEN"], server: { command: "npx" } } };
    await makeForge(path.join(root, "forge"), {
      ingredients: [mcp],
      recipes: [recipe("base", ["mcp/tracker"])],
      profiles: [profile("acme", ["base"])],
    });
    const ws = path.join(root, "acme-a");
    await writeFiles(ws, { "craftar.yaml": "forge: ../forge\nprofile: acme\n" });
    // Set the env variable to the marker value
    const mcpEnv = (stdout: string) => (JSON.parse(stdout).checks as Array<{ id: string; level: string; message: string }>).filter((c) => c.id === "mcp-env");
    const text = runCli(["doctor", "--workspace", ws], { env: { CRAFTAR_HOME: home, ACME_TRACKER_TOKEN: marker } });
    expect(text.stdout).not.toContain(marker);
    expect(text.stderr).not.toContain(marker);
    expect(text.stdout).toContain("every variable a written MCP server expects is set");
    const json = runCli(["doctor", "--workspace", ws, "--json"], { env: { CRAFTAR_HOME: home, ACME_TRACKER_TOKEN: marker } });
    expect(json.stdout).not.toContain(marker);
    expect(json.stderr).not.toContain(marker);
    expect(mcpEnv(json.stdout).map((c) => [c.level, c.message])).toEqual([["ok", "every variable a written MCP server expects is set"]]);
    // Unset: the declared name is what doctor reports, so a doctor that ignores authEnv cannot pass.
    const unset = runCli(["doctor", "--workspace", ws, "--json"], { env: { CRAFTAR_HOME: home, ACME_TRACKER_TOKEN: undefined } });
    expect(mcpEnv(unset.stdout).map((c) => [c.level, c.message])).toEqual([["warn", 'server "tracker" expects ACME_TRACKER_TOKEN, not set']]);
  });

  it("9. mcp-launcher with a Windows-only server: --strict exits 1", async () => {
    const root = await tmpDir("craftar-doctor-launcher-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    const LEGACY = { meta: { type: "mcp", name: "legacy", server: { command: "cmd", args: ["/c", "npx", "-y", "@acme/example-mcp"] } } };
    await makeForge(path.join(root, "forge"), {
      ingredients: [LEGACY],
      recipes: [recipe("base", ["mcp/legacy"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    });
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": "forge: ../forge\nprofile: acme\n" });
    expect(runCli(["sync", "--workspace", ws], { env: { CRAFTAR_HOME: home } }).code).toBe(0);
    const strict = runCli(["doctor", "--strict", "--json", "--workspace", ws], { env: { CRAFTAR_HOME: home } });
    expect(strict.code).toBe(1);
    const checks = JSON.parse(strict.stdout).checks as Array<{ id: string; level: string }>;
    const mcpLauncher = checks.find((c) => c.id === "mcp-launcher");
    expect(mcpLauncher?.level).toBe("warn");
  });

  it("10. mcp-launcher with a portable server: --strict exits 0 when no other warnings", async () => {
    const root = await tmpDir("craftar-doctor-launcher-ok-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    const PORTABLE = { meta: { type: "mcp", name: "api", server: { command: "npx", args: ["-y", "@acme/example-mcp"] } } };
    await makeForge(path.join(root, "forge"), {
      ingredients: [PORTABLE],
      recipes: [recipe("base", ["mcp/api"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    });
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": "forge: ../forge\nprofile: acme\n" });
    expect(runCli(["sync", "--workspace", ws], { env: { CRAFTAR_HOME: home } }).code).toBe(0);
    const strict = runCli(["doctor", "--strict", "--json", "--workspace", ws], { env: { CRAFTAR_HOME: home } });
    const checks = JSON.parse(strict.stdout).checks as Array<{ id: string; level: string }>;
    const mcpLauncher = checks.find((c) => c.id === "mcp-launcher");
    expect(mcpLauncher?.level).toBe("ok");
    // exit code is 0 only if all other checks are ok/pass
    expect(strict.code).toBe(0);
  });
});
