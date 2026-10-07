import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheKey } from "../src/core/remote.js";
import { forget, listWorkspaces, prune, readRegistry, register, registryFile, rowStatus } from "../src/core/registry.js";
import { apply, loadWorkspace, plan, readLock, status, type FileStatus } from "../src/core/sync.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";
import { git, remoteForge } from "./helpers/remote.js";

// Spec 21 §10.2 — the registry's core: register, read, forget, prune, and the row status.

const FORGE: ForgeSpec = {
  ingredients: [rule("style", "# Style\n")],
  recipes: [recipe("base", ["rule/style"]), recipe("frontend-angular", [], { slot: "frontend" })],
  profiles: [profile("acme", ["base", "frontend-angular"])],
};

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fixture(spec: ForgeSpec = FORGE) {
  const root = await tmpDir("craftar-registry-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const forgeRoot = path.join(root, "forge");
  await makeForge(forgeRoot, spec);
  const ws = async (name: string, config: Record<string, unknown> = { profile: "acme" }) => {
    const wsRoot = path.join(root, name);
    await makeWorkspace(wsRoot, forgeRoot, { config });
    return wsRoot;
  };
  return { root, home, forgeRoot, ws };
}

/** A writing sync, then registration — what `craftar sync` does (§4.1). */
async function syncAndRegister(home: string, wsRoot: string, now?: Date) {
  const ws = await loadWorkspace(wsRoot, { home });
  const p = await plan(ws);
  const st = await status(ws, p, await readLock(ws.root));
  await apply(ws, p, st);
  return register(home, ws, p, { now });
}

const fakeStatus = (...states: FileStatus["state"][]): FileStatus[] => states.map((state, i) => ({ path: `f${i}`, state }) as FileStatus);

describe("register (§4.1, §5.2, §6.1)", () => {
  it("creates registry.json with one entry, every key in order; a second register replaces it", async () => {
    const f = await fixture();
    const a = await f.ws("acme-portal");
    await syncAndRegister(f.home, a, new Date("2026-10-07T10:00:00.000Z"));
    const raw = JSON.parse(await fs.readFile(registryFile(f.home), "utf8"));
    expect(raw.schema).toBe(1);
    expect(raw.workspaces).toHaveLength(1);
    const e = raw.workspaces[0];
    expect(Object.keys(e)).toEqual(["path", "profile", "forge", "recipes", "stack", "targets", "lastSync"]);
    expect(Object.keys(e.forge)).toEqual(["kind", "source", "key", "ref", "commit", "fromLocalFile"]);
    expect(e).toMatchObject({
      path: await fs.realpath(a),
      profile: "acme",
      forge: { kind: "path", source: "../forge", key: await fs.realpath(f.forgeRoot), ref: null, commit: null, fromLocalFile: false },
      recipes: ["base", "frontend-angular"],
      stack: { frontend: "frontend-angular" },
      targets: ["claude-code"],
      lastSync: "2026-10-07T10:00:00.000Z",
    });
    await syncAndRegister(f.home, a, new Date("2026-10-07T11:00:00.000Z"));
    const again = await readRegistry(f.home);
    expect(again.workspaces).toHaveLength(1);
    expect(again.workspaces[0].lastSync).toBe("2026-10-07T11:00:00.000Z");
    expect((await fs.readFile(registryFile(f.home), "utf8")).endsWith("}\n")).toBe(true);
  });

  it("a workspace reached through a symlink (a junction on Windows) and through its target is one entry", async () => {
    const f = await fixture();
    const a = await f.ws("acme-portal");
    const link = path.join(f.root, "link");
    await fs.symlink(a, link, process.platform === "win32" ? "junction" : "dir");
    await syncAndRegister(f.home, a);
    await syncAndRegister(f.home, link);
    const reg = await readRegistry(f.home);
    expect(reg.workspaces.map((e) => e.path)).toEqual([await fs.realpath(a)]);
  });

  it.skipIf(process.platform !== "win32")("on Windows, the same path in another letter case is one entry", async () => {
    const f = await fixture();
    const a = await f.ws("acme-portal");
    await syncAndRegister(f.home, a);
    await syncAndRegister(f.home, a.toUpperCase());
    expect((await readRegistry(f.home)).workspaces).toHaveLength(1);
  });

  it("forge.key: ../forge and the absolute path of the same Forge share one key; a file:// remote keys by cacheKey", async () => {
    const f = await fixture();
    const rel = await f.ws("acme-rel");
    const abs = await f.ws("acme-abs", { profile: "acme", forge: f.forgeRoot });
    const r = await remoteForge(FORGE);
    cleanups.push(r.cleanup);
    const rem = await f.ws("acme-remote", { profile: "acme", forge: ` ${r.url}` });
    await syncAndRegister(f.home, rel);
    await syncAndRegister(f.home, abs);
    await syncAndRegister(f.home, rem);
    const byName = Object.fromEntries((await readRegistry(f.home)).workspaces.map((e) => [path.basename(e.path), e.forge]));
    expect(byName["acme-rel"].key).toBe(byName["acme-abs"].key);
    expect(byName["acme-rel"].key).toBe(await fs.realpath(f.forgeRoot));
    expect(byName["acme-remote"]).toMatchObject({ kind: "remote", key: cacheKey(r.url), ref: null });
  });

  it("two registers in parallel both land", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a");
    const b = await f.ws("acme-b");
    await Promise.all([syncAndRegister(f.home, a), syncAndRegister(f.home, b)]);
    expect((await readRegistry(f.home)).workspaces.map((e) => path.basename(e.path))).toEqual(["acme-a", "acme-b"]);
  });

  it("a live registry.lock makes register wait, then refuse; a stale one is taken over", async () => {
    const f = await fixture();
    const a = await f.ws("acme-portal");
    const ws = await loadWorkspace(a, { home: f.home });
    const p = await plan(ws);
    await fs.mkdir(f.home, { recursive: true });
    const lock = path.join(f.home, "registry.lock");
    await fs.writeFile(lock, "4242 2026-10-07T00:00:00.000Z\n");
    await expect(register(f.home, ws, p, { lock: { waitMs: 300, pollMs: 50 } })).rejects.toThrow(
      `the workspace registry ${lock} is busy (held by PID 4242)`,
    );
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);
    await register(f.home, ws, p, { lock: { waitMs: 300, pollMs: 50, staleMs: 1_000 } });
    expect((await readRegistry(f.home)).workspaces).toHaveLength(1);
  });

  it("keeps an entry's undeclared keys and unknown targets through another workspace's register", async () => {
    const f = await fixture();
    const b = await f.ws("acme-b");
    await fs.mkdir(f.home, { recursive: true });
    const foreign = {
      path: path.join(f.root, "acme-a"),
      profile: "acme",
      forge: { kind: "path", source: "../forge", key: null, ref: null, commit: null, fromLocalFile: false, later: 1 },
      recipes: [],
      stack: {},
      targets: ["cursor"],
      lastSync: "2026-01-01T00:00:00.000Z",
      extra: "kept",
    };
    await fs.writeFile(registryFile(f.home), JSON.stringify({ schema: 1, workspaces: [foreign], top: true }, null, 2) + "\n");
    await syncAndRegister(f.home, b);
    const raw = JSON.parse(await fs.readFile(registryFile(f.home), "utf8"));
    expect(raw.top).toBe(true);
    const kept = raw.workspaces.find((e: { path: string }) => e.path === foreign.path);
    expect(kept).toEqual(foreign);
    expect(Object.keys(kept).at(-1)).toBe("extra");
    expect(Object.keys(kept.forge).at(-1)).toBe("later");
    expect(Object.keys(raw).at(-1)).toBe("top");
  });
});

describe("readRegistry (§4.6, §7)", () => {
  it("none is an empty registry; schema 2 is refused by name; invalid JSON names the file", async () => {
    const home = await tmpDir();
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    expect(await readRegistry(home)).toEqual({ schema: 1, workspaces: [] });
    await writeFiles(home, { "registry.json": JSON.stringify({ schema: 2, workspaces: [] }) });
    await expect(readRegistry(home)).rejects.toThrow("registry.json declares schema 2, which this craftar does not read — upgrade craftar");
    await writeFiles(home, { "registry.json": "{ not json" });
    await expect(readRegistry(home)).rejects.toThrow(`cannot read ${registryFile(home)}:`);
  });
});

describe("forget and prune (§4.3, §4.4)", () => {
  it("forget removes a registered path and refuses an unregistered one", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a");
    const b = await f.ws("acme-b");
    await syncAndRegister(f.home, a);
    await syncAndRegister(f.home, b);
    expect(await forget(f.home, a)).toBe(await fs.realpath(a));
    expect((await readRegistry(f.home)).workspaces.map((e) => path.basename(e.path))).toEqual(["acme-b"]);
    // An existing directory is matched, and named, by its real path (on Windows, the long form of an 8.3 temp path).
    await expect(forget(f.home, a)).rejects.toThrow(`${await fs.realpath(a)} is not registered`);
  });

  it("forget matches a directory that no longer exists by its resolved path", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a");
    await syncAndRegister(f.home, a);
    const real = await fs.realpath(a);
    await fs.rm(a, { recursive: true });
    expect(await forget(f.home, real)).toBe(real);
  });

  it("prune removes missing entries (directory or craftar.yaml gone) and keeps an error row", async () => {
    const f = await fixture();
    const gone = await f.ws("acme-gone");
    const noYaml = await f.ws("acme-noyaml");
    const broken = await f.ws("acme-broken");
    const ok = await f.ws("acme-ok");
    for (const w of [gone, noYaml, broken, ok]) await syncAndRegister(f.home, w);
    await fs.rm(gone, { recursive: true });
    await fs.rm(path.join(noYaml, "craftar.yaml"));
    await writeFiles(broken, { "craftar.yaml": "forge: ../nowhere\nprofile: acme\n" });
    const pruned = await prune(f.home);
    expect(pruned.map((p) => path.basename(p))).toEqual(["acme-gone", "acme-noyaml"]);
    expect((await readRegistry(f.home)).workspaces.map((e) => path.basename(e.path))).toEqual(["acme-broken", "acme-ok"]);
    expect(await prune(f.home)).toEqual([]);
  });
});

describe("row status (§4.2)", () => {
  it("each line of the table, first match wins", () => {
    expect(rowStatus(fakeStatus("unchanged"), null)).toBe("no-lock");
    expect(rowStatus(fakeStatus("unchanged", "adopt"), {} as never)).toBe("up-to-date");
    for (const s of ["new", "update", "orphan"] as const) expect(rowStatus(fakeStatus("unchanged", s), {} as never)).toBe("outdated");
    for (const s of ["drift", "orphan-drift", "collision"] as const) expect(rowStatus(fakeStatus("update", s), {} as never)).toBe("drift");
  });

  it("listWorkspaces: up to date, drift, outdated, no lock, missing, error, and forge moved on a path Forge", async () => {
    const f = await fixture();
    git(f.root, "init", "-q", "-b", "main", f.forgeRoot);
    git(f.forgeRoot, "add", "-A");
    git(f.forgeRoot, "commit", "-q", "-m", "init");
    const names = ["acme-1-ok", "acme-2-drift", "acme-3-outdated", "acme-4-nolock", "acme-5-missing", "acme-6-error", "acme-7-moved"];
    const dirs: Record<string, string> = {};
    for (const n of names) {
      dirs[n] = await f.ws(n);
      await syncAndRegister(f.home, dirs[n]);
    }
    await writeFiles(dirs["acme-2-drift"], { ".claude/rules/style.md": "# Edited by hand\n" });
    await writeFiles(dirs["acme-3-outdated"], { "craftar.yaml": "forge: ../forge\nprofile: acme\ntargets: [claude-code, kiro]\n" });
    await fs.rm(path.join(dirs["acme-4-nolock"], "craftar.lock"));
    await fs.rm(dirs["acme-5-missing"], { recursive: true });
    await writeFiles(dirs["acme-6-error"], { "craftar.lock": "{ not json" });
    // The Forge's HEAD moves without changing what it renders: only the moved mark changes.
    await writeFiles(f.forgeRoot, { "README.md": "notes\n" });
    git(f.forgeRoot, "add", "-A");
    git(f.forgeRoot, "commit", "-q", "-m", "notes");

    const { rows, warnings } = await listWorkspaces(f.home, { fetch: false });
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(rows.map((r) => r.name)).toEqual(names);
    expect(by["acme-1-ok"]).toMatchObject({ status: "up-to-date", forgeMoved: true });
    expect(by["acme-2-drift"].status).toBe("drift");
    expect(by["acme-3-outdated"].status).toBe("outdated");
    expect(by["acme-4-nolock"]).toMatchObject({ status: "no-lock", forgeMoved: null, forge: { lockCommit: null } });
    expect(by["acme-5-missing"]).toMatchObject({ status: "missing", forgeMoved: null, files: null, forge: { defaultBranch: null, lockCommit: null, fetched: false } });
    expect(by["acme-6-error"]).toMatchObject({ status: "error", forgeMoved: null, files: null });
    expect(warnings.some((w) => w.startsWith(`${by["acme-6-error"].path}: `))).toBe(true);
    expect(by["acme-7-moved"].forgeMoved).toBe(true);
    expect(by["acme-1-ok"].files).toEqual({ unchanged: 1 });
    expect(Object.keys(by["acme-1-ok"])).toEqual(["name", "path", "profile", "recipes", "stack", "targets", "forge", "lastSync", "status", "forgeMoved", "files"]);
    expect(Object.keys(by["acme-1-ok"].forge)).toEqual(["kind", "source", "key", "ref", "defaultBranch", "commit", "lockCommit", "fromLocalFile", "fetched"]);
  });

  it("a row that loads forwards its plan's warnings; an error row its load warnings, then the error — each prefixed with its path", async () => {
    const f = await fixture();
    const ok = await f.ws("acme-ok", { profile: "acme", ref: "v1" });
    const bad = await f.ws("acme-bad", { profile: "acme", ref: "v2" });
    await syncAndRegister(f.home, ok);
    await syncAndRegister(f.home, bad);
    await writeFiles(bad, { "craftar.lock": "{ not json" });
    const { rows, warnings } = await listWorkspaces(f.home, { fetch: false });
    expect(rows.map((r) => r.status)).toEqual(["error", "up-to-date"]);
    const [realBad, realOk] = [await fs.realpath(bad), await fs.realpath(ok)];
    expect(warnings[0]).toBe(`${realBad}: ref "v2" is ignored: the Forge is a path (../forge), read as its working tree`);
    expect(warnings[1].startsWith(`${realBad}: `)).toBe(true);
    expect(warnings[2]).toBe(`${realOk}: ref "v1" is ignored: the Forge is a path (../forge), read as its working tree`);
    expect(warnings).toHaveLength(3);
  });

  it("rows print in path order even when the file is not sorted", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a");
    const b = await f.ws("acme-b");
    await syncAndRegister(f.home, a);
    await syncAndRegister(f.home, b);
    const raw = JSON.parse(await fs.readFile(registryFile(f.home), "utf8"));
    raw.workspaces.reverse();
    await fs.writeFile(registryFile(f.home), JSON.stringify(raw, null, 2) + "\n");
    expect((await listWorkspaces(f.home, { fetch: false })).rows.map((r) => r.name)).toEqual(["acme-a", "acme-b"]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a workspace that exists but cannot be inspected is an error row, and prune keeps it", async () => {
    const f = await fixture();
    const parent = path.join(f.root, "fence");
    const inner = path.join(parent, "acme-locked");
    await writeFiles(inner, { "craftar.yaml": "forge: ../../forge\nprofile: acme\n" });
    await syncAndRegister(f.home, inner);
    await fs.chmod(parent, 0o000);
    cleanups.push(() => fs.chmod(parent, 0o755));
    expect((await listWorkspaces(f.home, { fetch: false })).rows[0].status).toBe("error");
    expect(await prune(f.home)).toEqual([]);
  });

  it("forge moved is false when the Forge did not move, and null for a Forge without git", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a");
    await syncAndRegister(f.home, a);
    expect((await listWorkspaces(f.home, { fetch: false })).rows[0]).toMatchObject({ status: "up-to-date", forgeMoved: null });
    git(f.root, "init", "-q", "-b", "main", f.forgeRoot);
    git(f.forgeRoot, "add", "-A");
    git(f.forgeRoot, "commit", "-q", "-m", "init");
    await syncAndRegister(f.home, a);
    expect((await listWorkspaces(f.home, { fetch: false })).rows[0]).toMatchObject({ status: "up-to-date", forgeMoved: false });
  });
});
