import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneCache } from "../src/core/cache.js";
import { runDoctor, type DoctorOptions } from "../src/core/doctor.js";
import { listWorkspaces, register, registryFile } from "../src/core/registry.js";
import { cacheKey, credentialFault, ensureTree, parseLsRemote, resolveRef, type GitRunner } from "../src/core/remote.js";
import { apply, loadForgeSource, loadWorkspace, loadWorkspaceConfig, plan, readLock, status } from "../src/core/sync.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles } from "./helpers/forge.js";
import { remoteForge } from "./helpers/remote.js";

// 0.28.1 — three values that reached an output: a Forge URL with credentials that an earlier
// release recorded in the registry, a `forge:` spelled with backslashes after the scheme, and a
// `ref:` that holds a URL with credentials. Every credential here is assembled at runtime.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const USER = "user" + "q".repeat(5);
const PW = "pw" + "x".repeat(8);
const CRED = `${USER}:${PW}@`;
const LABEL = "(a URL with credentials — not shown)";
const SPEC = { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] };

/** Nothing of the credential is in `value`, however it is serialized. */
function expectClean(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  expect(text.includes(PW), "the password is printed").toBe(false);
  expect(text.includes(USER), "the user is printed").toBe(false);
}

/**
 * A home as a release before 0.27.1 left it: two workspaces synced from a remote Forge named with
 * an empty authority and credentials — the registry records that URL and the key built from it,
 * and the cache entry carries the key as its name. The first workspace still names the URL in
 * `craftar.yaml` (an `error` row today); the second is gone from disk (a `missing` row).
 */
async function recordedHome() {
  const root = await tmpDir("craftar-recorded-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  await fs.mkdir(home);
  const r = await remoteForge(SPEC);
  cleanups.push(r.cleanup);
  const dirs: string[] = [];
  for (const name of ["acme-api", "acme-web"]) {
    const dir = path.join(root, name);
    await makeWorkspace(dir, root, { config: { profile: "acme", forge: r.url } });
    const w = await loadWorkspace(dir, { home });
    const p = await plan(w);
    await apply(w, p, await status(w, p, await readLock(w.root)));
    await register(home, w, p);
    dirs.push(await fs.realpath(dir));
  }
  const recorded = `https:///${CRED}example.invalid/acme/forge.git`;
  expect(credentialFault(recorded)).toBe(true);
  const oldKey = cacheKey(recorded);
  expect(oldKey).toContain(PW); // the premise: the entry's name holds the password
  const file = registryFile(home);
  const reg = JSON.parse(await fs.readFile(file, "utf8"));
  expect(reg.workspaces).toHaveLength(2);
  for (const e of reg.workspaces) {
    e.forge.source = recorded;
    e.forge.key = oldKey;
  }
  await fs.writeFile(file, JSON.stringify(reg, null, 2) + "\n");
  await fs.rename(path.join(home, "forges", cacheKey(r.url)), path.join(home, "forges", oldKey));
  await writeFiles(dirs[0], { "craftar.yaml": `profile: acme\nforge: "${recorded}"\n` });
  await fs.rm(dirs[1], { recursive: true, force: true });
  return { root, home, dirs, recorded, oldKey };
}

describe("a Forge URL with credentials recorded by an earlier release", () => {
  it("workspaces: an error row and a missing row give the label for the source and no key", async () => {
    const h = await recordedHome();
    const table = await listWorkspaces(h.home, { fetch: false });
    expect(table.rows.map((r) => [r.name, r.status])).toEqual([["acme-api", "error"], ["acme-web", "missing"]]);
    for (const row of table.rows) {
      expect(row.forge.kind).toBe("remote");
      expect(row.forge.source).toBe(LABEL);
      expect(row.forge.key).toBeNull();
    }
    expectClean(table);
  });

  it("workspaces: a recorded URL without credentials is still given as recorded, with its key", async () => {
    const h = await recordedHome();
    const file = registryFile(h.home);
    const reg = JSON.parse(await fs.readFile(file, "utf8"));
    const plain = "https://example.invalid/acme/forge.git";
    for (const e of reg.workspaces) {
      e.forge.source = plain;
      e.forge.key = cacheKey(plain);
    }
    await fs.writeFile(file, JSON.stringify(reg, null, 2) + "\n");
    const missing = (await listWorkspaces(h.home, { fetch: false })).rows.find((r) => r.status === "missing")!;
    expect([missing.forge.source, missing.forge.key]).toEqual([plain, cacheKey(plain)]);
  });

  it("cache prune: the entry such a row names is kept under the label, in a dry run and in a run", async () => {
    const h = await recordedHome();
    for (const dryRun of [true, false]) {
      const { report } = await pruneCache(h.home, { dryRun, workspace: null, registryOff: false });
      expect(report.kept).toEqual([{ path: `forges/${LABEL}`, reason: "named", namedBy: h.dirs }]);
      expect(report.removed).toEqual([]);
      expectClean(report);
    }
    // The entry itself is untouched: the label is what is printed, not a rename.
    expect(await fs.readdir(path.join(h.home, "forges"))).toContain(h.oldKey);
  });

  it("cache prune: an entry it would remove, and a removal directory left behind, are named by the label", async () => {
    const h = await recordedHome();
    // No completed fetch: the entry is removed although a row names it. A leftover of an interrupted prune carries the key too.
    await fs.rm(path.join(h.home, "forges", h.oldKey, "fetched"));
    await fs.mkdir(path.join(h.home, "forges", `~removing-${h.oldKey}-4242`));
    const { report } = await pruneCache(h.home, { dryRun: true, workspace: null, registryOff: false });
    expect(report.removed.map((r) => [r.path, r.kind, r.reason])).toEqual([
      [`forges/${LABEL}`, "entry", "incomplete"],
      [`forges/~removing-${LABEL}-4242`, "leftover", "interrupted"],
    ]);
    expectClean(report);
  });

  it("cache prune: a warning about such an entry names it by the label", async () => {
    const h = await recordedHome();
    await fs.rm(path.join(h.home, "forges", h.oldKey, "fetched"));
    const rename = async () => {
      throw Object.assign(new Error("held"), { code: "EPERM" });
    };
    const { report } = await pruneCache(h.home, { dryRun: false, workspace: null, registryOff: false, rename });
    expect(report.warnings).toEqual([`${LABEL} is held open (EPERM) — kept`]);
    expect(report.kept.map((k) => [k.path, k.reason])).toEqual([[`forges/${LABEL}`, "held-open"]]);
    expectClean(report);
  });

  it("cache prune: an entry nothing with credentials names keeps its name", async () => {
    const root = await tmpDir("craftar-recorded-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    await fs.mkdir(home);
    const r = await remoteForge(SPEC);
    cleanups.push(r.cleanup);
    await ensureTree(r.url, null, { home });
    const { report } = await pruneCache(home, { dryRun: true, workspace: null, registryOff: false });
    expect(report.removed.map((x) => x.path)).toEqual([`forges/${cacheKey(r.url)}`]);
  });

  it("doctor: the cache check names such an entry by the label", async () => {
    const h = await recordedHome();
    // The fetch of that entry never completed: the one cache finding that names an entry a row names.
    await fs.rm(path.join(h.home, "forges", h.oldKey, "fetched"));
    const o: DoctorOptions = { version: "0.0.0", workspace: null, fetch: false, strict: false, registryOff: false, env: {}, nodeVersion: "22.11.0", gitVersion: async () => "2.53.0", home: h.home };
    const report = await runDoctor(o);
    const cache = report.checks.filter((c) => c.id === "cache");
    expect(cache.map((c) => [c.level, c.message])).toEqual([["warn", `${LABEL} — a fetch never completed`]]);
    expectClean(report);
  });
});

describe("a forge: spelled with backslashes after the scheme", () => {
  const BACK = "\\";
  const spellings = [
    `https:${BACK}${BACK}${CRED}example.invalid${BACK}acme${BACK}forge.git`,
    `https:${BACK}${BACK}${CRED}example.invalid/acme/forge.git`,
    `https:/${BACK}${CRED}example.invalid/acme/forge.git`,
    `https:${BACK}/${CRED}example.invalid/acme/forge.git`,
    `HTTPS:${BACK}${BACK}${USER}@example.invalid/acme/forge.git`,
    `ssh:${BACK}${BACK}${CRED}example.invalid/acme/forge.git`,
    ` https:${BACK}${BACK}${CRED}example.invalid/acme/forge.git`,
  ];

  it("credentialFault flags it", () => {
    for (const v of spellings) expect(credentialFault(v), v.replace(CRED, "<cred>").replace(USER, "<user>")).toBe(true);
  });

  it("a drive path, a backslash URL with no userinfo, an ssh user alone and a file URL are not flagged", () => {
    for (const v of [
      `C:${BACK}Users${BACK}acme${BACK}forge`,
      `C:${BACK}forges${BACK}acme@work`,
      `D:/forges/acme`,
      `https:${BACK}${BACK}example.invalid${BACK}acme${BACK}forge.git`,
      `https:${BACK}${BACK}example.invalid/p@x`,
      `ssh:${BACK}${BACK}git@example.invalid/acme/forge.git`,
      `file:${BACK}${BACK}${CRED}dir/forge.git`,
    ])
      expect(credentialFault(v), v.replace(CRED, "<cred>")).toBe(false);
  });

  it("the load refuses it by file and field, and prints nothing of it — not `Forge not found at …`", async () => {
    const root = await tmpDir("craftar-backslash-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    for (const forge of spellings) {
      const err: unknown = await loadWorkspaceConfig(root, { profile: "acme", forge }, null).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expectClean(message);
      expect(message).toMatch(/^craftar\.yaml › forge holds credentials in the URL/);
    }
  });
});

describe("a ref: that holds a URL with credentials", () => {
  const REF = `https://${CRED}example.invalid/acme/forge.git`;

  it("a path Forge: the warning that the ref is ignored gives the label, not the value", async () => {
    const root = await tmpDir("craftar-ref-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(path.join(root, "forge"), SPEC);
    const loaded = await loadForgeSource(root, "forge", REF);
    expect(loaded.warnings).toEqual([`ref ${LABEL} is ignored: the Forge is a path (forge), read as its working tree`]);
    expectClean(loaded.warnings);
    // A plain ref is quoted as before.
    expect((await loadForgeSource(root, "forge", "v1")).warnings).toEqual([`ref "v1" is ignored: the Forge is a path (forge), read as its working tree`]);
  });

  it("a remote Forge: a ref that is not found is named by the label", () => {
    const refs = parseLsRemote(`ref: refs/heads/main\tHEAD\n${"a".repeat(40)}\tHEAD\n${"a".repeat(40)}\trefs/heads/main\n`);
    const url = "https://example.invalid/acme/forge.git";
    for (const ref of [REF, `refs/heads/${REF}`]) {
      let message = "";
      try {
        resolveRef(refs, ref, url);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe("");
      expectClean(message);
    }
    expect(() => resolveRef(refs, REF, url)).toThrow(`ref ${LABEL} not found in ${url}`);
    expect(() => resolveRef(refs, "v9", url)).toThrow(`ref "v9" not found in ${url}`);
  });

  it("a remote Forge: a ref that is both a branch and a tag is named by the label, with no hint that spells it", () => {
    const sha = "a".repeat(40);
    const url = "https://example.invalid/acme/forge.git";
    const both = (ref: string) => parseLsRemote(`${sha}\trefs/heads/${ref}\n${sha}\trefs/tags/${ref}\n`);
    expect(() => resolveRef(both(REF), REF, url)).toThrow(new Error(`ref ${LABEL} is both a branch and a tag in ${url}`));
    expect(() => resolveRef(both("v1"), "v1", url)).toThrow(new Error(`ref "v1" is both a branch and a tag in ${url} — write refs/heads/v1 or refs/tags/v1`));
  });

  /** A home holding a cached copy of a remote Forge, and the message a failing load gives. */
  async function cachedRemote() {
    const root = await tmpDir("craftar-ref-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    await fs.mkdir(home);
    const r = await remoteForge(SPEC);
    cleanups.push(r.cleanup);
    await ensureTree(r.url, null, { home });
    const messageOf = (p: Promise<unknown>) => p.then(() => "", (e: unknown) => (e as Error).message);
    return { root, home, url: r.url, messageOf };
  }

  it("a remote Forge that cannot be fetched: the cached copy that cannot resolve the ref names it by the label", async () => {
    const c = await cachedRemote();
    // The remote does not answer, and the cached copy lists no ref.
    const git: GitRunner = async (args) => {
      if (args.includes("ls-remote")) throw new Error("the remote does not answer");
      return "";
    };
    for (const mode of ["read", "sync"] as const) {
      const message = await c.messageOf(loadForgeSource(c.root, c.url, REF, { home: c.home, git, mode }));
      expect(message).toBe(`cannot fetch the Forge ${c.url}: the remote does not answer — and the cached copy cannot resolve ref ${LABEL}`);
      expectClean(message);
    }
    // A plain ref is named bare, as before.
    const plain = await c.messageOf(loadForgeSource(c.root, c.url, "v9", { home: c.home, git, mode: "read" }));
    expect(plain).toBe(`cannot fetch the Forge ${c.url}: the remote does not answer — and the cached copy cannot resolve v9`);
  });

  it("a remote Forge whose ref resolves to a commit the copy does not hold: named by the label, fetching and offline", async () => {
    const c = await cachedRemote();
    const sha = "b".repeat(40);
    // The remote and the cached copy both list the ref; no commit is ever found.
    const git: GitRunner = async (args) => {
      if (args.includes("cat-file")) throw new Error("no such commit");
      if (args.includes("ls-remote") || args.includes("for-each-ref")) return args.includes("ls-remote") ? `${sha}\trefs/heads/${REF}\n` : `${sha}\trefs/heads/${REF}\t\n`;
      return "";
    };
    for (const offline of [false, true]) {
      const message = await c.messageOf(ensureTree(c.url, REF, { home: c.home, git, offline }));
      expect(message).toBe(`ref ${LABEL} not found in ${c.url}`);
      expectClean(message);
    }
  });
});
