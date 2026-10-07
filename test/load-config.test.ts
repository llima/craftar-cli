import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import YAML from "yaml";
import { loadWorkspace, loadWorkspaceConfig } from "../src/core/sync.js";
import { profile, recipe, rule, scenario, tmpDir } from "./helpers/forge.js";
import { remoteForge } from "./helpers/remote.js";
import { localKeys } from "../src/core/workspace-yaml.js";

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
