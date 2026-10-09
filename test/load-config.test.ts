import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import YAML from "yaml";
import { loadWorkspace, loadWorkspaceConfig } from "../src/core/sync.js";
import { profile, recipe, rule, scenario, tmpDir } from "./helpers/forge.js";
import { remoteForge } from "./helpers/remote.js";
import { localKeys, readLocalFile } from "../src/core/workspace-yaml.js";
import { defaultGit, type GitRunner } from "../src/core/remote.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const SPEC = { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] };

describe("loadWorkspaceConfig — the in-memory half of loadWorkspace (spec 23 §5.2)", () => {
  it("a path Forge, with a craftar.local.yaml: the same Workspace either way", async () => {
    const s = await scenario(SPEC, { config: { profile: "acme", ref: "v1" }, local: { targets: ["kiro"] } });
    cleanups.push(s.cleanup);
    const fromDisk = await loadWorkspace(s.wsRoot);
    const base = YAML.parse(await fs.readFile(path.join(s.wsRoot, "craftar.yaml"), "utf8"));
    const local = YAML.parse(await fs.readFile(path.join(s.wsRoot, "craftar.local.yaml"), "utf8"));
    const inMemory = await loadWorkspaceConfig(s.wsRoot, base, local);
    expect(inMemory).toEqual(fromDisk);
    expect(inMemory.config.targets).toEqual(["kiro"]);
    expect(inMemory.warnings).toEqual(['ref "v1" is ignored: the Forge is a path (../forge), read as its working tree']);
  });

  it("no local file is passed as null, and the schema error names only craftar.yaml", async () => {
    const s = await scenario(SPEC, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    expect(await loadWorkspaceConfig(s.wsRoot, { forge: "../forge", profile: "acme" }, null)).toEqual(await loadWorkspace(s.wsRoot));
    await expect(loadWorkspaceConfig(s.wsRoot, { forge: 42, profile: "acme" }, null)).rejects.toThrow(/^invalid craftar\.yaml: /);
  });

  it("a file:// Forge: the same Workspace either way, the fetch flags aside", async () => {
    const r = await remoteForge(SPEC);
    const ws = await tmpDir("craftar-lc-ws-");
    const home = await tmpDir("craftar-lc-home-");
    cleanups.push(r.cleanup, () => fs.rm(ws, { recursive: true, force: true }), () => fs.rm(home, { recursive: true, force: true }));
    await fs.writeFile(path.join(ws, "craftar.yaml"), `forge: ${r.url}\nprofile: acme\n`);
    const strip = (w: Awaited<ReturnType<typeof loadWorkspace>>) => ({ ...w, origin: { ...w.origin, fetched: null, fetchedAt: null } });
    const fromDisk = await loadWorkspace(ws, { home, mode: "sync" });
    const inMemory = await loadWorkspaceConfig(ws, { forge: r.url, profile: "acme" }, null, { home, mode: "sync" });
    expect(strip(inMemory)).toEqual(strip(fromDisk));
  });

  it("a credential is refused naming the file, before the value can be printed", async () => {
    const s = await scenario(SPEC, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    await expect(loadWorkspaceConfig(s.wsRoot, { forge: "https://u:SECRET@h.invalid/r", profile: "acme" }, null)).rejects.toThrow(
      "craftar.yaml › forge holds credentials in the URL",
    );
    await expect(loadWorkspaceConfig(s.wsRoot, { forge: "../forge", profile: "acme" }, { forge: "https://u:SECRET@h.invalid/r" })).rejects.toThrow(
      "craftar.local.yaml › forge holds credentials in the URL",
    );
  });
});

describe("localKeys — which of forge, ref, profile, recipes, targets craftar.local.yaml sets (spec 23 §5.2)", () => {
  it("no file → none; each key present → named, in a fixed order; other keys ignored", async () => {
    const dir = await tmpDir("craftar-localkeys-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    expect(await localKeys(dir)).toEqual([]);
    await fs.writeFile(path.join(dir, "craftar.local.yaml"), "targets: [kiro]\noverrides: { params: {} }\nrecipes: { add: [x] }\nforge: ../f\n");
    expect(await localKeys(dir)).toEqual(["forge", "recipes", "targets"]);
    await fs.writeFile(path.join(dir, "craftar.local.yaml"), "ref: v1\nprofile: acme\n");
    expect(await localKeys(dir)).toEqual(["ref", "profile"]);
    await fs.writeFile(path.join(dir, "craftar.local.yaml"), "");
    expect(await localKeys(dir)).toEqual([]);
  });

  it("a YAML error names the file and place, not the line", async () => {
    const dir = await tmpDir("craftar-localkeys-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, "craftar.local.yaml"), "forge: https://u:SECRET@h.invalid/r: x\n");
    const e = await localKeys(dir).catch((x: Error) => x);
    expect((e as Error).message.startsWith("invalid craftar.local.yaml: ")).toBe(true);
    expect((e as Error).message).not.toContain("SECRET");
  });
});

describe("readLocalFile — one read gives the document init merges and the keys it checks (spec 23 N10)", () => {
  it("absent → null; empty → {}; otherwise the parsed document beside its keys", async () => {
    const dir = await tmpDir("craftar-localfile-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    expect(await readLocalFile(dir)).toEqual({ doc: null, keys: [] });
    await fs.writeFile(path.join(dir, "craftar.local.yaml"), "");
    expect(await readLocalFile(dir)).toEqual({ doc: {}, keys: [] });
    await fs.writeFile(path.join(dir, "craftar.local.yaml"), "targets: [kiro]\noverrides: { params: { a: 1 } }\n");
    expect(await readLocalFile(dir)).toEqual({ doc: { targets: ["kiro"], overrides: { params: { a: 1 } } }, keys: ["targets"] });
  });
});

describe("loadForgeSource (spec 28 §5.2)", () => {
  it("a path Forge, no ref: warnings empty, origin as expected, the Forge loads", async () => {
    const s = await scenario(SPEC, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    const home = await tmpDir("craftar-lfs-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const { loadForgeSource } = await import("../src/core/sync.js");
    // Use a workspace directory that does not exist, to prove loadForgeSource doesn't require it
    const ws = path.join(s.root, "nonexistent-ws");
    const result = await loadForgeSource(ws, path.relative(ws, s.forgeRoot).replace(/\\/g, "/"), null, { home });
    expect(result.warnings).toEqual([]);
    expect(result.origin).toEqual({
      kind: "path",
      source: path.relative(ws, s.forgeRoot).replace(/\\/g, "/"),
      ref: null,
      defaultBranch: null,
      fetched: false,
      fromLocalFile: false,
    });
    expect([...result.forge.profiles.keys()]).toEqual(["acme"]);
    // The workspace directory ws does not exist and still does not afterwards
    expect(await fs.stat(ws).catch(() => "no")).toBe("no");
  });

  it("a path Forge with a ref: warns about ignored ref, origin.ref is null", async () => {
    const s = await scenario(SPEC, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    const home = await tmpDir("craftar-lfs-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const { loadForgeSource } = await import("../src/core/sync.js");
    const result = await loadForgeSource(s.wsRoot, "../forge", "v1", { home });
    expect(result.warnings).toEqual(['ref "v1" is ignored: the Forge is a path (../forge), read as its working tree']);
    expect(result.origin.ref).toBe(null);
  });

  it("a path that is not there: rejects with the resolved path", async () => {
    const ws = await tmpDir("craftar-lfs-ws-");
    cleanups.push(() => fs.rm(ws, { recursive: true, force: true }));
    const home = await tmpDir("craftar-lfs-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const { loadForgeSource } = await import("../src/core/sync.js");
    await expect(loadForgeSource(ws, "../nope", null, { home })).rejects.toThrow(`Forge not found at ${path.resolve(ws, "../nope")}`);
  });

  it("a file:// Forge, counted: one fetch, origin as expected", async () => {
    const r = await remoteForge(SPEC);
    const ws = await tmpDir("craftar-lfs-ws-");
    const home = await tmpDir("craftar-lfs-home-");
    cleanups.push(r.cleanup, () => fs.rm(ws, { recursive: true, force: true }), () => fs.rm(home, { recursive: true, force: true }));
    const { loadForgeSource } = await import("../src/core/sync.js");
    let fetchCount = 0;
    const counting: GitRunner = async (args, opts) => {
      if (args.includes("fetch")) fetchCount++;
      return defaultGit(args, opts);
    };
    const result = await loadForgeSource(ws, r.url, null, { home, mode: "sync", git: counting });
    expect(fetchCount).toBe(1);
    expect(result.origin.kind).toBe("remote");
    expect(result.origin.source).toBe(r.url);
    expect(result.origin.ref).toBe(null);
    expect(result.origin.fetched).toBe(true);
    expect(result.origin.defaultBranch).toBe("main");
    expect(result.origin.fromLocalFile).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("fromLocalFile travels: the same call with fromLocalFile: true sets origin.fromLocalFile", async () => {
    const r = await remoteForge(SPEC);
    const ws = await tmpDir("craftar-lfs-ws-");
    const home = await tmpDir("craftar-lfs-home-");
    cleanups.push(r.cleanup, () => fs.rm(ws, { recursive: true, force: true }), () => fs.rm(home, { recursive: true, force: true }));
    const { loadForgeSource } = await import("../src/core/sync.js");
    const result = await loadForgeSource(ws, r.url, null, { home, mode: "sync", fromLocalFile: true });
    expect(result.origin.fromLocalFile).toBe(true);
  });

  it("refuseRemote: with refuseRemote and a URL, rejects with the message, no fetch", async () => {
    const r = await remoteForge(SPEC);
    const ws = await tmpDir("craftar-lfs-ws-");
    const home = await tmpDir("craftar-lfs-home-");
    cleanups.push(r.cleanup, () => fs.rm(ws, { recursive: true, force: true }), () => fs.rm(home, { recursive: true, force: true }));
    const { loadForgeSource } = await import("../src/core/sync.js");
    let callCount = 0;
    const counting: GitRunner = async (args, opts) => {
      callCount++;
      return defaultGit(args, opts);
    };
    await expect(loadForgeSource(ws, r.url, null, { home, refuseRemote: () => "no remote here", git: counting })).rejects.toThrow("no remote here");
    expect(callCount).toBe(0);
  });

  it("loadWorkspaceConfig goes through the seam: the counting runner sees 1 fetch", async () => {
    const r = await remoteForge(SPEC);
    const ws = await tmpDir("craftar-lfs-ws-");
    const home = await tmpDir("craftar-lfs-home-");
    cleanups.push(r.cleanup, () => fs.rm(ws, { recursive: true, force: true }), () => fs.rm(home, { recursive: true, force: true }));
    let fetchCount = 0;
    const counting: GitRunner = async (args, opts) => {
      if (args.includes("fetch")) fetchCount++;
      return defaultGit(args, opts);
    };
    await loadWorkspaceConfig(ws, { forge: r.url, profile: "acme" }, null, { home, mode: "sync", git: counting });
    expect(fetchCount).toBe(1);
  });

  it("--offline threads git too: after a previous load, offline sees 0 fetches and warns", async () => {
    const r = await remoteForge(SPEC);
    const ws = await tmpDir("craftar-lfs-ws-");
    const home = await tmpDir("craftar-lfs-home-");
    cleanups.push(r.cleanup, () => fs.rm(ws, { recursive: true, force: true }), () => fs.rm(home, { recursive: true, force: true }));
    const { loadForgeSource } = await import("../src/core/sync.js");
    // First load to populate the cache
    await loadForgeSource(ws, r.url, null, { home, mode: "sync" });
    // Second load with offline and a counting runner
    let fetchCount = 0;
    const counting: GitRunner = async (args, opts) => {
      if (args.includes("fetch")) fetchCount++;
      return defaultGit(args, opts);
    };
    const result = await loadForgeSource(ws, r.url, null, { home, offline: true, git: counting });
    expect(fetchCount).toBe(0);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0].startsWith(`Forge ${r.url} not fetched (--offline) — using the cached copy at `)).toBe(true);
  });
});
