import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { resolve } from "../src/core/resolve.js";
import { workspaceParams } from "../src/importers/decide.js";
import { profile, recipe, scenario, tmpDir, type WorkspaceSpec } from "./helpers/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function ws(spec: WorkspaceSpec) {
  const s = await scenario({ recipes: [recipe("base", []), recipe("extra", []), recipe("other", [])], profiles: [profile("acme", ["base"])] }, spec);
  cleanups.push(s.cleanup);
  return loadWorkspace(s.wsRoot);
}

describe("workspace layers", () => {
  it("an array in craftar.local.yaml replaces the workspace array", async () => {
    const w = await ws({ config: { profile: "acme", targets: ["claude-code", "kiro"] }, local: { targets: ["kiro"] } });
    expect(w.config.targets).toEqual(["kiro"]);
    expect(resolve(w.forge, w.config).targets).toEqual(["kiro"]);
  });

  it("recipes.add from the local layer replaces, not appends", async () => {
    const w = await ws({ config: { profile: "acme", recipes: { add: ["other"] } }, local: { recipes: { add: ["extra"] } } });
    expect(w.config.recipes.add).toEqual(["extra"]);
  });

  it("objects still merge key by key", async () => {
    const w = await ws({ config: { profile: "acme", overrides: { params: { a: "1" } } }, local: { overrides: { params: { b: "2" } } } });
    expect(w.config.overrides.params).toEqual({ a: "1", b: "2" });
  });

  it("import's workspace layer merges overrides.params exactly as loadWorkspace does, nested values included", async () => {
    const spec = { config: { profile: "acme", overrides: { params: { a: "1", db: { host: "h", port: 1 } } } }, local: { overrides: { params: { db: { port: 2 } } } } };
    const s = await scenario({ recipes: [recipe("base", [])], profiles: [profile("acme", ["base"])] }, spec);
    cleanups.push(s.cleanup);
    const w = await loadWorkspace(s.wsRoot);
    const read = (abs: string) => fs.readFile(abs, "utf8");
    expect(w.config.overrides.params).toEqual({ a: "1", db: { host: "h", port: 2 } });
    expect({ ...(await workspaceParams(s.wsRoot, read)) }).toEqual(w.config.overrides.params);
  });

  it("deduplicates resolved targets", async () => {
    const w = await ws({ config: { profile: "acme", targets: ["kiro", "kiro"] } });
    expect(resolve(w.forge, w.config).targets).toEqual(["kiro"]);
  });

  it("an empty targets array in craftar.local.yaml resolves to none, and plan() warns about the orphan risk", async () => {
    const w = await ws({ config: { profile: "acme" }, local: { targets: [] } });
    expect(resolve(w.forge, w.config).targets).toEqual([]);
    const p = await plan(w);
    expect(p.warnings).toContain(
      "no targets resolved — nothing will be emitted and every file in craftar.lock becomes an orphan (an empty list in craftar.local.yaml replaces the workspace's)",
    );
    expect(p.files).toEqual([]);
  });

  it("without craftar.yaml, points at craftar init first (built in 0.14.0, spec 23), then at import", async () => {
    const dir = await tmpDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const error = await loadWorkspace(dir).then(
      () => null,
      (e: Error) => e,
    );
    expect(error?.message).toMatch(/craftar\.yaml not found/);
    expect(error?.message).toContain(
      `craftar import --workspace "${dir}" --from claude-code --forge <dir> --profile <name> --write-config`,
    );
    expect(error?.message).toContain(`craftar init --workspace "${dir}" --forge <dir> --profile <name>`);
    expect(error!.message.indexOf("craftar init")).toBeLessThan(error!.message.indexOf("craftar import"));
  });

  it("fails clearly when the Forge path does not exist", async () => {
    const dir = await tmpDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, "craftar.yaml"), "forge: ./nowhere\nprofile: acme\n");
    await expect(loadWorkspace(dir)).rejects.toThrow(/Forge not found/);
  });

  it("workspaceParams refuses a __proto__ key in overrides.params like the loader", async () => {
    const dir = await tmpDir();
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(dir + "/craftar.yaml", "forge: ../f\nprofile: x\noverrides:\n  params:\n    __proto__: x\n    k: v\n");
    const read = (abs: string) => fs.readFile(abs, "utf8");
    await expect(workspaceParams(dir, read)).rejects.toThrow(/craftar\.yaml does not load.*__proto__/s);
  });
});
