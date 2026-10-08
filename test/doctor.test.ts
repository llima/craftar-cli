import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor, type Check, type DoctorOptions } from "../src/core/doctor.js";
import { register } from "../src/core/registry.js";
import { cacheKey, ensureTree } from "../src/core/remote.js";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";
import { git, remoteForge } from "./helpers/remote.js";

// Spec 24 §9.1 — the checks of `craftar doctor`, run on synthetic homes, Forges and workspaces.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const mcp = (name: string, env: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  meta: { type: "mcp", name, server: { command: "x", env }, ...extra },
});

const FORGE: ForgeSpec = {
  ingredients: [rule("style", "# Style\n")],
  recipes: [recipe("base", ["rule/style"])],
  profiles: [profile("acme", ["base"])],
};

async function fixture(spec: ForgeSpec = FORGE) {
  const root = await tmpDir("craftar-doctor-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const forgeRoot = path.join(root, "forge");
  await makeForge(forgeRoot, spec);
  const ws = async (name: string, config: Record<string, unknown> = { profile: "acme" }) => {
    const dir = path.join(root, name);
    await makeWorkspace(dir, forgeRoot, { config });
    return dir;
  };
  return { root, home, forgeRoot, ws };
}

async function syncAndRegister(home: string, dir: string) {
  const ws = await loadWorkspace(dir, { home });
  const p = await plan(ws);
  await apply(ws, p, await status(ws, p, await readLock(ws.root)));
  await register(home, ws, p);
}

const run = (o: Partial<DoctorOptions> & { home: string }) =>
  runDoctor({ version: "0.0.0", workspace: null, fetch: false, strict: false, registryOff: false, env: {}, nodeVersion: "22.11.0", gitVersion: async () => "2.53.0", ...o });

const of = (checks: Check[], id: string) => checks.filter((c) => c.id === id);
const one = (checks: Check[], id: string) => {
  const found = of(checks, id);
  expect(found, id).toHaveLength(1);
  return found[0];
};

describe("machine checks", () => {
  it("an empty home: node, git, home, registry, cache all ok, nothing else", async () => {
    const f = await fixture();
    const r = await run({ home: f.home });
    expect(r.checks.map((c) => [c.id, c.level])).toEqual([
      ["node", "ok"],
      ["git", "ok"],
      ["home", "ok"],
      ["registry", "ok"],
      ["cache", "ok"],
    ]);
    expect(r.workspace).toBeNull();
    expect(r.summary).toEqual({ ok: 5, warn: 0, error: 0 });
  });

  it("node < 22 is an error; git missing is a warn with a path Forge", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a");
    const r = await run({ home: f.home, workspace: a, nodeVersion: "20.1.0", gitVersion: async () => null });
    expect(one(r.checks, "node").level).toBe("error");
    expect(one(r.checks, "git")).toMatchObject({ level: "warn", fix: "install git" });
    expect(one(r.checks, "config").level).toBe("ok");
  });

  it("git missing with a remote Forge is an error, and config and the load-dependent checks do not run", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a", { profile: "acme", forge: "https://example.com/acme/forge.git" });
    const r = await run({ home: f.home, workspace: a, gitVersion: async () => null });
    expect(one(r.checks, "git").level).toBe("error");
    for (const id of ["config", "forge", "forge-inside", "plan", "params", "mcp-env", "status", "registered"]) expect(of(r.checks, id), id).toHaveLength(0);
    expect(one(r.checks, "lock").level).toBe("warn");
  });

  it("home: a file at $CRAFTAR_HOME is an error, reported once — the cache is not checked", async () => {
    const f = await fixture();
    await fs.writeFile(f.home, "x");
    const r = await run({ home: f.home });
    expect(one(r.checks, "home").level).toBe("error");
    expect(one(r.checks, "cache")).toMatchObject({ level: "ok", message: "not checked ($CRAFTAR_HOME is not a directory)" });
    expect(r.summary.error + r.summary.warn).toBe(1);
  });

  it("registry: a missing entry warns with prune; schema 2 is an error; a non-empty CRAFTAR_NO_REGISTRY is off", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a");
    await syncAndRegister(f.home, a);
    await fs.rm(a, { recursive: true });
    expect(one((await run({ home: f.home })).checks, "registry")).toMatchObject({ level: "warn", fix: "craftar workspaces prune" });
    expect(one((await run({ home: f.home, registryOff: true })).checks, "registry")).toMatchObject({ level: "ok", message: "off (CRAFTAR_NO_REGISTRY)" });
    await writeFiles(f.home, { "registry.json": JSON.stringify({ schema: 2, workspaces: [] }) });
    expect(one((await run({ home: f.home })).checks, "registry")).toMatchObject({ level: "error", fix: "upgrade craftar" });
    await writeFiles(f.home, { "registry.json": JSON.stringify({ schema: 1, workspaces: "x" }) });
    const shape = one((await run({ home: f.home })).checks, "registry");
    expect(shape).toMatchObject({ level: "error", fix: `repair or remove ${path.join(f.home, "registry.json")}` });
    expect(shape.message).toMatch(/^invalid .*registry\.json \(workspaces: .+\)$/);
  });

  it("a craftar.yaml its schema refuses: config error in one line, naming the field", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a", { profile: 3 });
    const cfg = one((await run({ home: f.home, workspace: a })).checks, "config");
    expect(cfg.level).toBe("error");
    expect(cfg.message).toMatch(/^invalid craftar\.yaml \(profile: .+\)$/);
  });
});

describe("the cache check (§4.3)", () => {
  async function cacheFixture() {
    const f = await fixture();
    const r = await remoteForge(FORGE);
    cleanups.push(r.cleanup);
    await ensureTree(r.url, null, { home: f.home });
    return { ...f, r, key: cacheKey(r.url) };
  }

  it("an entry nothing names warns with its directory; an entry without fetched warns", async () => {
    const c = await cacheFixture();
    await fs.mkdir(path.join(c.home, "forges", "example.com-half-000000000000"), { recursive: true });
    const r = await run({ home: c.home });
    const found = of(r.checks, "cache");
    expect(found.map((x) => x.message).sort()).toEqual([`${c.key} — nothing names it`, "example.com-half-000000000000 — a fetch never completed"].sort());
    expect(found.every((x) => x.level === "warn" && x.fix === "craftar cache prune")).toBe(true);
  });

  it("named by a registry entry — missing ones too — or by the checked, unregistered workspace: not reported", async () => {
    const c = await cacheFixture();
    const a = await c.ws("acme-remote", { profile: "acme", forge: c.r.url });
    const checked = await run({ home: c.home, workspace: a });
    expect(one(checked.checks, "cache").level).toBe("ok");
    await syncAndRegister(c.home, a);
    await fs.rm(a, { recursive: true });
    expect(one((await run({ home: c.home })).checks, "cache").level).toBe("ok");
  });

  it("the orphan part is skipped, and says why, without a registry or when the checked craftar.yaml does not read", async () => {
    const c = await cacheFixture();
    expect(one((await run({ home: c.home, registryOff: true })).checks, "cache").message).toMatch(/\(orphans not checked: CRAFTAR_NO_REGISTRY is set\)$/);
    await fs.mkdir(path.join(c.home, "forges", "example.com-half-000000000000"), { recursive: true });
    expect(one((await run({ home: c.home, registryOff: true })).checks, "cache")).toMatchObject({
      level: "warn",
      message: "example.com-half-000000000000 — a fetch never completed (orphans not checked: CRAFTAR_NO_REGISTRY is set)",
    });
    await fs.rm(path.join(c.home, "forges", "example.com-half-000000000000"), { recursive: true });
    const bad = path.join(c.root, "bad");
    await writeFiles(bad, { "craftar.yaml": "forge: [\n" });
    expect(one((await run({ home: c.home, workspace: bad })).checks, "cache").message).toMatch(/orphans not checked: the checked craftar.yaml does not read/);
  });

  it("the orphan part runs when only the Forge load fails", async () => {
    const c = await cacheFixture();
    const a = await c.ws("acme-a", { profile: "acme", forge: "../nowhere" });
    const r = await run({ home: c.home, workspace: a });
    expect(one(r.checks, "config").level).toBe("error");
    expect(one(r.checks, "cache")).toMatchObject({ level: "warn", message: `${c.key} — nothing names it` });
  });

  it("the size is summed", async () => {
    const c = await cacheFixture();
    await syncAndRegister(c.home, await c.ws("acme-remote", { profile: "acme", forge: c.r.url }));
    expect(one((await run({ home: c.home })).checks, "cache").message).toMatch(/^1 entry, \d+\.\d MB$/);
  });
});

describe("workspace checks", () => {
  it("a workspace in sync: every check ok, forge-inside and params included", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a");
    await syncAndRegister(f.home, a);
    const r = await run({ home: f.home, workspace: a });
    expect(r.checks.filter((c) => c.scope === "workspace").map((c) => [c.id, c.level])).toEqual([
      ["config", "ok"],
      ["forge", "ok"],
      ["forge-inside", "ok"],
      ["plan", "ok"],
      ["params", "ok"],
      ["mcp-env", "ok"],
      ["lock", "ok"],
      ["status", "ok"],
      ["registered", "ok"],
    ]);
    expect(r.workspace).toBe(await fs.realpath(a));
  });

  it("drift and outdated warn under status; no lock warns under lock and runs no status; invalid lock JSON is an error", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a");
    await syncAndRegister(f.home, a);
    await writeFiles(a, { ".claude/rules/style.md": "# Edited\n" });
    expect(one((await run({ home: f.home, workspace: a })).checks, "status")).toMatchObject({ level: "warn", message: "drift — 1 drift" });
    const b = await f.ws("acme-b");
    await syncAndRegister(f.home, b);
    await writeFiles(b, { "craftar.yaml": "forge: ../forge\nprofile: acme\ntargets: [claude-code, kiro]\n" });
    expect(one((await run({ home: f.home, workspace: b })).checks, "status").message).toMatch(/^outdated — /);
    const c = await f.ws("acme-c");
    const nolock = await run({ home: f.home, workspace: c });
    expect(one(nolock.checks, "lock")).toMatchObject({ level: "warn", fix: "craftar sync" });
    expect(of(nolock.checks, "status")).toHaveLength(0);
    expect(one(nolock.checks, "registered").message).toBe("never synced, nothing to register yet");
    await writeFiles(c, { "craftar.lock": "{ not json" });
    const bad = await run({ home: f.home, workspace: c });
    expect(one(bad.checks, "lock")).toMatchObject({ level: "error", fix: "repair or remove craftar.lock" });
    expect(of(bad.checks, "status")).toHaveLength(0);
    await writeFiles(c, { "craftar.lock": JSON.stringify({ schema: 2, generatedAt: 5, files: "x" }) });
    const refused = one((await run({ home: f.home, workspace: c })).checks, "lock");
    expect(refused).toMatchObject({ level: "error", fix: "repair or remove craftar.lock" });
    expect(refused.message).toMatch(/^craftar\.lock is not a valid lock \(.+\)$/);
    expect(refused.message).not.toContain("\n");
    expect(one(bad.checks, "lock").message).toMatch(/^craftar\.lock is not valid JSON \(/);
    await writeFiles(c, { "craftar.lock": JSON.stringify({ schema: 9 }) });
    expect(one((await run({ home: f.home, workspace: c })).checks, "lock")).toMatchObject({ level: "error", fix: "upgrade craftar", message: expect.stringMatching(/declares schema 9/) });
  });

  it("params: a declared key with no value warns once, naming its citers, and plan does not repeat it", async () => {
    const f = await fixture({
      ingredients: [rule("a", "# {{who}}\n", { params: { who: { description: "w" } } }), rule("b", "# {{who}} too\n"), rule("c", "# {{other}}\n")],
      recipes: [recipe("base", ["rule/a", "rule/b", "rule/c"])],
      profiles: [profile("acme", ["base"])],
    });
    const a = await f.ws("acme-a");
    const r = await run({ home: f.home, workspace: a });
    expect(one(r.checks, "params")).toMatchObject({ level: "warn", message: '"who" declared by rule/a has no value — cited by rule/a, rule/b', fix: "set who in the profile's params or overrides.params" });
    const planLines = of(r.checks, "plan").map((c) => c.message);
    expect(planLines.some((x) => x.includes('param "who"'))).toBe(false);
    expect(planLines.some((x) => x.includes('param "other"'))).toBe(true);
    expect(of(r.checks, "plan").map((c) => c.level)).toEqual(["warn"]);
  });

  it("params: a default or a profile value is ok", async () => {
    const f = await fixture({
      ingredients: [rule("a", "# {{who}}\n", { params: { who: { default: "x" } } }), rule("b", "# {{where}}\n", { params: { where: { description: "w" } } })],
      recipes: [recipe("base", ["rule/a", "rule/b"])],
      profiles: [profile("acme", ["base"], ["claude-code"], { params: { where: "here" } })],
    });
    expect(one((await run({ home: f.home, workspace: await f.ws("acme-a") })).checks, "params").level).toBe("ok");
  });

  it("mcp-env: one line per (server, NAME) across claude-code and kiro; set names, ${X:-d} and agents-md-only servers not reported; no value printed", async () => {
    const secret = "sk-" + "z".repeat(24);
    const f = await fixture({
      ingredients: [
        mcp("acme-api", { TOKEN: "${ACME_TOKEN}", AGAIN: "Bearer ${ACME_TOKEN}", HOST: "${ACME_HOST}", D: "${WITH_DEFAULT:-d}", K: secret }),
        mcp("acme-docs", { TOKEN: "${DOCS_TOKEN}" }, { targets: ["agents-md"] }),
      ],
      recipes: [recipe("base", ["mcp/acme-api", "mcp/acme-docs"])],
      profiles: [profile("acme", ["base"], ["claude-code", "kiro", "agents-md"])],
    });
    const r = await run({ home: f.home, workspace: await f.ws("acme-a"), env: { ACME_HOST: "h" } });
    expect(of(r.checks, "mcp-env")).toEqual([
      { id: "mcp-env", scope: "workspace", level: "warn", message: 'server "acme-api" expects ACME_TOKEN, not set', fix: "export ACME_TOKEN" },
    ]);
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  it("mcp-env: the same server name written by two targets from different ingredients — both are checked", async () => {
    const f = await fixture({
      ingredients: [mcp("api", { T: "${ACME_A}" }, { targets: ["claude-code"] }), mcp("api--x", { T: "${ACME_B}" }, { as: "api", targets: ["kiro"] })],
      recipes: [recipe("base", ["mcp/api", "mcp/api--x"])],
      profiles: [profile("acme", ["base"], ["claude-code", "kiro"])],
    });
    const r = await run({ home: f.home, workspace: await f.ws("acme-a") });
    expect(of(r.checks, "mcp-env").map((c) => c.message)).toEqual(['server "api" expects ACME_A, not set', 'server "api" expects ACME_B, not set']);
  });

  it("forge-inside: a workspace inside its path Forge warns; a directory named ..x inside it too", async () => {
    const f = await fixture();
    const inner = path.join(f.forgeRoot, "ws");
    await makeWorkspace(inner, f.forgeRoot, { config: { profile: "acme" } });
    expect(one((await run({ home: f.home, workspace: inner })).checks, "forge-inside").level).toBe("warn");
    const dotted = path.join(f.forgeRoot, "..x");
    await makeWorkspace(dotted, f.forgeRoot, { config: { profile: "acme" } });
    expect(one((await run({ home: f.home, workspace: dotted })).checks, "forge-inside").level).toBe("warn");
  });

  it("config: a ref beside a path Forge is a config warn, not repeated under plan", async () => {
    const f = await fixture();
    const r = await run({ home: f.home, workspace: await f.ws("acme-a", { profile: "acme", ref: "v1" }) });
    const cfg = of(r.checks, "config");
    expect(cfg.map((c) => c.level)).toEqual(["warn"]);
    expect(cfg[0].message).toMatch(/^ref "v1" is ignored/);
    expect(r.summary.ok).toBe(r.checks.filter((c) => c.level === "ok").length);
    expect(of(r.checks, "plan").map((c) => c.level)).toEqual(["ok"]);
  });

  it("registered: through a symlink is ok (real paths); synced but not registered warns", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a");
    await syncAndRegister(f.home, a);
    const link = path.join(f.root, "link-a");
    await fs.symlink(a, link, process.platform === "win32" ? "junction" : "dir");
    expect(one((await run({ home: f.home, workspace: link })).checks, "registered").message).toBe("in the registry");
    await fs.rm(path.join(f.home, "registry.json"));
    expect(one((await run({ home: f.home, workspace: a })).checks, "registered")).toMatchObject({ level: "warn", fix: "craftar sync" });
    const off = await run({ home: f.home, workspace: a, registryOff: true });
    expect(one(off.checks, "registered")).toMatchObject({ level: "ok", message: "registry off" });
  });

  it("a symlinked workspace loads its Forge through the path as given, like every other command", async () => {
    const f = await fixture();
    const real = path.join(f.root, "real", "ws");
    await writeFiles(real, { "craftar.yaml": "forge: ../forge\nprofile: acme\n" });
    const links = path.join(f.root, "links");
    await fs.mkdir(links);
    const kind = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(f.forgeRoot, path.join(links, "forge"), kind);
    await fs.symlink(real, path.join(links, "ws"), kind);
    const r = await run({ home: f.home, workspace: path.join(links, "ws") });
    expect(one(r.checks, "config").level).toBe("ok");
    expect(r.workspace).toBe(await fs.realpath(real));
  });

  it("a workspace that does not load: config error, dependent checks absent, lock still runs", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a", { profile: "acme", forge: "../nowhere" });
    const r = await run({ home: f.home, workspace: a });
    expect(one(r.checks, "config")).toMatchObject({ level: "error", fix: null });
    for (const id of ["forge", "forge-inside", "plan", "params", "mcp-env", "status", "registered"]) expect(of(r.checks, id), id).toHaveLength(0);
    expect(one(r.checks, "lock").level).toBe("warn");
  });
});

describe("a remote Forge (§4.2 forge row, §6 cases 2–4)", () => {
  it("a ref the cache cannot resolve, offline: config error with the --fetch fix", async () => {
    const f = await fixture();
    const r = await remoteForge(FORGE);
    cleanups.push(r.cleanup);
    await ensureTree(r.url, null, { home: f.home });
    const a = await f.ws("acme-remote", { profile: "acme", forge: r.url, ref: "nope" });
    expect(one((await run({ home: f.home, workspace: a })).checks, "config")).toMatchObject({ level: "error", fix: "craftar doctor --fetch" });
  });

  it("never fetched: config error with the --fetch fix; --fetch fetches it", async () => {
    const f = await fixture();
    const r = await remoteForge(FORGE);
    cleanups.push(r.cleanup);
    const a = await f.ws("acme-remote", { profile: "acme", forge: r.url });
    expect(one((await run({ home: f.home, workspace: a })).checks, "config")).toMatchObject({ level: "error", fix: "craftar doctor --fetch" });
    const fetched = await run({ home: f.home, workspace: a, fetch: true });
    expect(one(fetched.checks, "forge").message).toMatch(/fetched now$/);
  });

  it("offline reads the cache without the network; --fetch with the remote unreachable warns under forge only", async () => {
    const f = await fixture();
    const r = await remoteForge(FORGE);
    cleanups.push(r.cleanup);
    const a = await f.ws("acme-remote", { profile: "acme", forge: r.url });
    await ensureTree(r.url, null, { home: f.home });
    const entry = path.join(f.home, "forges", cacheKey(r.url));
    const refs = () => git(path.join(entry, "repo.git"), "for-each-ref");
    const stamp = () => fs.readFile(path.join(entry, "fetched"), "utf8");
    const [refs0, stamp0] = [refs(), await stamp()];
    await r.commit({ "README.md": "moved\n" });
    await fs.rename(r.bare, `${r.bare}.away`);
    cleanups.push(() => fs.rename(`${r.bare}.away`, r.bare).catch(() => {}));
    const off = await run({ home: f.home, workspace: a });
    expect(one(off.checks, "forge").message).toMatch(/, cached /);
    expect(refs()).toBe(refs0);
    expect(await stamp()).toBe(stamp0);
    const down = await run({ home: f.home, workspace: a, fetch: true });
    expect(one(down.checks, "forge").level).toBe("warn");
    expect(of(down.checks, "plan").map((c) => c.level)).toEqual(["ok"]);
    expect(of(down.checks, "config").map((c) => c.level)).toEqual(["ok"]);
  });

  it("a full-SHA ref already cached: forge ok, pinned, offline and under --fetch", async () => {
    const f = await fixture();
    const r = await remoteForge(FORGE);
    cleanups.push(r.cleanup);
    const sha = git(r.src, "rev-parse", "HEAD");
    const a = await f.ws("acme-pinned", { profile: "acme", forge: r.url, ref: sha });
    await ensureTree(r.url, sha, { home: f.home });
    for (const fetch of [false, true])
      expect(one((await run({ home: f.home, workspace: a, fetch })).checks, "forge"), String(fetch)).toMatchObject({ level: "ok", message: `${r.url} @ pinned ${sha.slice(0, 8)}, cached` });
  });
});


describe("the cache check and removal directories (spec 26 §5.1, §6 case 13)", () => {
  it("a ~removing- directory is not an entry: no 'fetch never completed', not counted", async () => {
    const f = await fixture();
    await writeFiles(path.join(f.home, "forges"), { "~removing-example.com-old-0a1b2c3d4e5f-4242/fetched": "x" });
    const r = await run({ home: f.home });
    expect(one(r.checks, "cache")).toEqual({ id: "cache", scope: "machine", level: "ok", message: "0 entries, 0.0 MB", fix: null });
  });

  it("an entry whose fetch never completed: the fix is craftar cache prune", async () => {
    const f = await fixture();
    await writeFiles(path.join(f.home, "forges"), { "example.com-half-000000000000/repo.git/HEAD": "x" });
    const r = await run({ home: f.home });
    expect(one(r.checks, "cache")).toEqual({ id: "cache", scope: "machine", level: "warn", message: "example.com-half-000000000000 — a fetch never completed", fix: "craftar cache prune" });
  });
});
