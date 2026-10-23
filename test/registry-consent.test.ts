import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allowWrites, consentFor, forget, prune, readRegistry, registryFile, revokeWrites } from "../src/core/registry.js";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { register } from "../src/core/registry.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";

// Spec 40 §5.2, §7.1, §7.2 — write consent in the registry for `craftar mcp --allow-writes`.

const FORGE: ForgeSpec = {
  ingredients: [rule("style", "# Style\n")],
  recipes: [recipe("base", ["rule/style"])],
  profiles: [profile("acme", ["base"]), profile("other", ["base"])],
};

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fixture(spec: ForgeSpec = FORGE) {
  const root = await tmpDir("craftar-consent-");
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

/** A writing sync, then registration — what `craftar sync` does. */
async function syncAndRegister(home: string, wsRoot: string, now?: Date) {
  const ws = await loadWorkspace(wsRoot, { home });
  const p = await plan(ws);
  const st = await status(ws, p, await readLock(ws.root));
  await apply(ws, p, st);
  return register(home, ws, p, { now });
}

describe("allowWrites (spec 40 §5.2)", () => {
  it("writes writeConsent: [{ path, forge: { source, ref }, profile, grantedAt }]; a second call for the same workspace replaces", async () => {
    const f = await fixture();
    const ws = await f.ws("acme-portal");
    await syncAndRegister(f.home, ws);
    const grant = { forge: { source: "../forge", ref: null }, profile: "acme" };
    const entry = await allowWrites(f.home, ws, grant, { now: new Date("2026-10-23T12:00:00.000Z") });
    const raw = JSON.parse(await fs.readFile(registryFile(f.home), "utf8"));
    expect(raw.writeConsent).toEqual([
      { path: await fs.realpath(ws), forge: { source: "../forge", ref: null }, profile: "acme", grantedAt: "2026-10-23T12:00:00.000Z" },
    ]);
    expect(Object.keys(raw.writeConsent[0])).toEqual(["path", "forge", "profile", "grantedAt"]);
    expect(entry).toEqual(raw.writeConsent[0]);

    // A second allowWrites for the same workspace with profile "other" leaves ONE entry
    const grant2 = { forge: { source: "../forge", ref: null }, profile: "other" };
    await allowWrites(f.home, ws, grant2, { now: new Date("2026-10-23T13:00:00.000Z") });
    const raw2 = JSON.parse(await fs.readFile(registryFile(f.home), "utf8"));
    expect(raw2.writeConsent).toHaveLength(1);
    expect(raw2.writeConsent[0].profile).toBe("other");
  });
});

describe("register keeps the consent (spec 40 §7.2)", () => {
  it("allowWrites, then syncAndRegister twice; readRegistry(home).writeConsent equals what allowWrites returned", async () => {
    const f = await fixture();
    const ws = await f.ws("acme-portal");
    await syncAndRegister(f.home, ws);
    const grant = { forge: { source: "../forge", ref: null }, profile: "acme" };
    const entry = await allowWrites(f.home, ws, grant, { now: new Date("2026-10-23T12:00:00.000Z") });

    await syncAndRegister(f.home, ws, new Date("2026-10-23T13:00:00.000Z"));
    await syncAndRegister(f.home, ws, new Date("2026-10-23T14:00:00.000Z"));

    const reg = await readRegistry(f.home);
    expect(reg.writeConsent).toEqual([entry]);
    // The workspace entry has no key writeConsent and no key consent
    expect(Object.hasOwn(reg.workspaces[0], "writeConsent")).toBe(false);
    expect(Object.hasOwn(reg.workspaces[0], "consent")).toBe(false);
  });
});

describe("consentFor through a symlink (spec 40 §5.2)", () => {
  it("allowWrites(home, link, …) records fs.realpath(target); consentFor(reg, target) and consentFor(reg, link) both find it", async () => {
    const f = await fixture();
    const ws = await f.ws("acme-portal");
    await syncAndRegister(f.home, ws);
    const link = path.join(f.root, "link");
    await fs.symlink(ws, link, process.platform === "win32" ? "junction" : "dir");

    const grant = { forge: { source: "../forge", ref: null }, profile: "acme" };
    // First call through the real path
    await allowWrites(f.home, ws, grant, { now: new Date("2026-10-23T12:00:00.000Z") });
    // Second call through the link — should replace, not add
    await allowWrites(f.home, link, grant, { now: new Date("2026-10-23T13:00:00.000Z") });

    const raw = JSON.parse(await fs.readFile(registryFile(f.home), "utf8"));
    expect(raw.writeConsent).toHaveLength(1);
    expect(raw.writeConsent[0].path).toBe(await fs.realpath(ws));
    expect(raw.writeConsent[0].grantedAt).toBe("2026-10-23T13:00:00.000Z");

    const reg = await readRegistry(f.home);
    expect(await consentFor(reg, ws)).toEqual(raw.writeConsent[0]);
    expect(await consentFor(reg, link)).toEqual(raw.writeConsent[0]);
    // consentFor for another directory is null
    expect(await consentFor(reg, f.root)).toBeNull();
  });
});

describe("revokeWrites (spec 40 §5.2)", () => {
  it("removes the consent and returns { removed: true }; raw text then does not contain 'writeConsent' and equals byte for byte before allowWrites", async () => {
    const f = await fixture();
    const ws = await f.ws("acme-portal");
    await syncAndRegister(f.home, ws);
    const before = await fs.readFile(registryFile(f.home), "utf8");

    const grant = { forge: { source: "../forge", ref: null }, profile: "acme" };
    await allowWrites(f.home, ws, grant, { now: new Date("2026-10-23T12:00:00.000Z") });

    const result = await revokeWrites(f.home, ws);
    expect(result).toEqual({ path: await fs.realpath(ws), removed: true });

    const after = await fs.readFile(registryFile(f.home), "utf8");
    expect(after.includes("writeConsent")).toBe(false);
    expect(after).toBe(before);
  });
});

describe("revokeWrites with no consent (spec 40 §5.2)", () => {
  it("returns { removed: false } and file bytes/mtime unchanged; with no registry.json at all, returns { removed: false } and file still does not exist", async () => {
    const f = await fixture();
    const ws = await f.ws("acme-portal");
    await syncAndRegister(f.home, ws);
    const before = await fs.readFile(registryFile(f.home), "utf8");
    const stat1 = await fs.stat(registryFile(f.home));

    const result = await revokeWrites(f.home, ws);
    expect(result).toEqual({ path: await fs.realpath(ws), removed: false });

    const after = await fs.readFile(registryFile(f.home), "utf8");
    const stat2 = await fs.stat(registryFile(f.home));
    expect(after).toBe(before);
    expect(stat2.mtimeMs).toBe(stat1.mtimeMs);

    // With no registry.json at all
    const home2 = path.join(f.root, "home2");
    const result2 = await revokeWrites(home2, ws);
    expect(result2).toEqual({ path: await fs.realpath(ws), removed: false });
    const file2Exists = await fs.access(registryFile(home2)).then(() => true, () => false);
    expect(file2Exists).toBe(false);
  });
});

describe("forget removes consent (spec 40 §5.2)", () => {
  it("forget(home, a) with consents for a and b (two registered workspaces) leaves only b's consent", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a");
    const b = await f.ws("acme-b");
    await syncAndRegister(f.home, a);
    await syncAndRegister(f.home, b);
    await allowWrites(f.home, a, { forge: { source: "../forge", ref: null }, profile: "acme" }, { now: new Date("2026-10-23T12:00:00.000Z") });
    await allowWrites(f.home, b, { forge: { source: "../forge", ref: null }, profile: "acme" }, { now: new Date("2026-10-23T12:00:00.000Z") });

    await forget(f.home, a);

    const reg = await readRegistry(f.home);
    expect(reg.writeConsent).toHaveLength(1);
    expect(reg.writeConsent![0].path).toBe(await fs.realpath(b));
  });
});

describe("prune removes consent of pruned paths (spec 40 §5.2)", () => {
  it("prune(home) after deleting workspace a's directory removes a's entry AND its consent, keeps b's", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a");
    const b = await f.ws("acme-b");
    await syncAndRegister(f.home, a);
    await syncAndRegister(f.home, b);
    await allowWrites(f.home, a, { forge: { source: "../forge", ref: null }, profile: "acme" }, { now: new Date("2026-10-23T12:00:00.000Z") });
    await allowWrites(f.home, b, { forge: { source: "../forge", ref: null }, profile: "acme" }, { now: new Date("2026-10-23T12:00:00.000Z") });

    await fs.rm(a, { recursive: true });
    await prune(f.home);

    const reg = await readRegistry(f.home);
    expect(reg.workspaces).toHaveLength(1);
    expect(reg.workspaces[0].path).toBe(await fs.realpath(b));
    expect(reg.writeConsent).toHaveLength(1);
    expect(reg.writeConsent![0].path).toBe(await fs.realpath(b));
  });
});

describe("schema strictness (spec 40 §7.1)", () => {
  it("a registry whose writeConsent is [{ path: 1 }] makes readRegistry throw", async () => {
    const f = await fixture();
    await fs.mkdir(f.home, { recursive: true });
    const bad = { schema: 1, workspaces: [], writeConsent: [{ path: 1 }] };
    await fs.writeFile(registryFile(f.home), JSON.stringify(bad, null, 2) + "\n");
    await expect(readRegistry(f.home)).rejects.toThrow();
  });
});
