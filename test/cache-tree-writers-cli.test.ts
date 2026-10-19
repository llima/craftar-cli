import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listFiles } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, tmpDir, type ForgeSpec } from "./helpers/forge.js";
import { remoteForge } from "./helpers/remote.js";

// A tree of the Forge cache passed as a Forge to the gated writers (forge unify, forge promote, drift promote).
// The tree is a clean, tracked git repository with a commit, so the git gates pass; these tests fail until the writers share P5's check.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const THREE: ForgeSpec = {
  ingredients: [rule("workflow", "base text\n"), rule("workflow--acme", "acme text\n", { as: "workflow" }), rule("style", "style\n")],
  recipes: [recipe("base", ["rule/workflow", "rule/style"]), recipe("base--acme", ["rule/workflow--acme", "rule/style"])],
  profiles: [profile("acme", ["base--acme"], ["claude-code", "kiro"]), profile("globex", ["base"]), profile("initech", ["base"], ["claude-code", "kiro"])],
};

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await listFiles(dir)) if (!f.startsWith(".git/")) out[f] = (await fs.readFile(path.join(dir, f))).toString("hex");
  return out;
}

interface CacheTreeContext {
  parent: string;
  home: string;
  tree: string;
  entry: string;
  t: string;
  w0: string;
  rf: Awaited<ReturnType<typeof remoteForge>>;
  run: (args: string[], env?: NodeJS.ProcessEnv) => { code: number | null; stdout: string; stderr: string };
}

async function cacheTree(): Promise<CacheTreeContext> {
  const rf = await remoteForge(THREE);
  cleanups.push(rf.cleanup);
  const parent = await fs.realpath(await tmpDir("craftar-cachetree-"));
  cleanups.push(() => fs.rm(parent, { recursive: true, force: true }));
  const home = path.join(parent, "home");
  const w0 = path.join(parent, "w0");
  await fs.mkdir(w0, { recursive: true });
  await fs.writeFile(path.join(w0, "craftar.yaml"), `forge: ${rf.url}\nprofile: acme\n`);
  const syncR = runCli(["sync", "--workspace", w0], { env: { CRAFTAR_HOME: home } });
  expect(syncR.code, syncR.stderr).toBe(0);
  const forges = path.join(home, "forges");
  const [entry] = await fs.readdir(forges);
  const trees = path.join(forges, entry, "trees");
  const [t] = (await fs.readdir(trees)).filter((n) => !n.endsWith(".ok") && !n.endsWith(".used"));
  const tree = path.join(trees, t);
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => runCli(args, { env: { CRAFTAR_HOME: home, ...env } });
  return { parent, home, tree, entry, t, w0, rf, run };
}

const TAIL = /is a tree of craftar's Forge cache — nothing is written there; clone the Forge and pass that directory\n$/;

describe("cache tree as Forge — gated writers", () => {
  it("forge unify --forge <cache tree> is refused, the tree untouched", async () => {
    const ctx = await cacheTree();
    const before = await snapshot(ctx.tree);
    const r = ctx.run(["forge", "unify", "rule/workflow", "--profile", "acme", "--take", "base", "--forge", ctx.tree, "--no-impact"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(TAIL);
    expect(r.stderr).not.toContain(ctx.entry);
    expect(r.stderr).toContain("(a cache entry name — not shown)");
    expect(r.stdout).toBe("");
    expect(await snapshot(ctx.tree)).toEqual(before);
  });

  it("forge promote --forge <cache tree> is refused, the tree untouched", async () => {
    const ctx = await cacheTree();
    const before = await snapshot(ctx.tree);
    const r = ctx.run(["forge", "promote", "rule/workflow", "--profile", "acme", "--forge", ctx.tree, "--no-impact"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(TAIL);
    expect(r.stderr).not.toContain(ctx.entry);
    expect(r.stderr).toContain("(a cache entry name — not shown)");
    expect(r.stdout).toBe("");
    expect(await snapshot(ctx.tree)).toEqual(before);
  });

  it("drift promote in a workspace whose forge: is a cache tree is refused, the tree untouched", async () => {
    const ctx = await cacheTree();
    const ws = path.join(ctx.parent, "ws-initech");
    const relForge = path.relative(ws, ctx.tree).replace(/\\/g, "/");
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(path.join(ws, "craftar.yaml"), `forge: ${relForge}\nprofile: initech\n`);
    const syncR = ctx.run(["sync", "--workspace", ws]);
    expect(syncR.code, syncR.stderr).toBe(0);
    await fs.writeFile(path.join(ws, ".claude/rules/workflow.md"), "hand edit\n");
    const before = await snapshot(ctx.tree);
    const r = ctx.run(["drift", "promote", ".claude/rules/workflow.md", "--workspace", ws]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(TAIL);
    expect(r.stderr).not.toContain(ctx.entry);
    expect(r.stderr).toContain("(a cache entry name — not shown)");
    expect(await snapshot(ctx.tree)).toEqual(before);
  });

  it("drift promote --forge <cache tree> in a URL workspace is refused as a cache tree, before D2", async () => {
    const ctx = await cacheTree();
    await fs.writeFile(path.join(ctx.w0, ".claude/rules/workflow.md"), "hand edit\n");
    const before = await snapshot(ctx.tree);
    const r = ctx.run(["drift", "promote", ".claude/rules/workflow.md", "--workspace", ctx.w0, "--forge", ctx.tree]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(TAIL);
    expect(r.stderr).not.toContain(ctx.entry);
    expect(r.stderr).toContain("(a cache entry name — not shown)");
    expect(await snapshot(ctx.tree)).toEqual(before);
  });

  it("drift promote in a workspace whose forge: is a cache tree, with --forge an ordinary directory, is refused as a cache tree, not D2", async () => {
    const ctx = await cacheTree();
    const ws = path.join(ctx.parent, "ws-initech-forge");
    const relForge = path.relative(ws, ctx.tree).replace(/\\/g, "/");
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(path.join(ws, "craftar.yaml"), `forge: ${relForge}\nprofile: initech\n`);
    const syncR = ctx.run(["sync", "--workspace", ws]);
    expect(syncR.code, syncR.stderr).toBe(0);
    await fs.writeFile(path.join(ws, ".claude/rules/workflow.md"), "hand edit\n");
    const before = await snapshot(ctx.tree);
    const r = ctx.run(["drift", "promote", ".claude/rules/workflow.md", "--workspace", ws, "--forge", ctx.rf.src]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(TAIL);
    expect(r.stderr).not.toContain(ctx.entry);
    expect(await snapshot(ctx.tree)).toEqual(before);
  });

  it("craftar import --forge <cache tree> is refused, the tree untouched", async () => {
    const ctx = await cacheTree();
    const src = path.join(ctx.parent, "src-ws");
    await fs.mkdir(path.join(src, ".claude/rules"), { recursive: true });
    await fs.writeFile(path.join(src, ".claude/rules/hello.md"), "# Hello\n");
    const before = await snapshot(ctx.tree);
    const r = ctx.run(["import", "--from", "claude-code", "--forge", ctx.tree, "--profile", "globex", "--workspace", src]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(TAIL);
    expect(r.stderr).not.toContain(ctx.entry);
    expect(await snapshot(ctx.tree)).toEqual(before);
  });

  it("craftar import --forge <a new directory under the cache> is refused, nothing created", async () => {
    const ctx = await cacheTree();
    const src = path.join(ctx.parent, "src-ws2");
    await fs.mkdir(path.join(src, ".claude/rules"), { recursive: true });
    await fs.writeFile(path.join(src, ".claude/rules/hello.md"), "# Hello\n");
    const target = path.join(ctx.home, "forges", "new-forge");
    const r = ctx.run(["import", "--from", "claude-code", "--forge", target, "--profile", "globex", "--workspace", src]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(TAIL);
    await expect(fs.lstat(target)).rejects.toThrow();
    expect(r.stderr).toContain(path.join(ctx.home, "forges", "(a cache entry name — not shown)"));
  });

  it("craftar import --forge <an ordinary new directory> still imports (pin)", async () => {
    const ctx = await cacheTree();
    const src = path.join(ctx.parent, "src-ws3");
    await fs.mkdir(path.join(src, ".claude/rules"), { recursive: true });
    await fs.writeFile(path.join(src, ".claude/rules/hello.md"), "# Hello\n");
    const target = path.join(ctx.parent, "fresh-forge");
    const r = ctx.run(["import", "--from", "claude-code", "--forge", target, "--profile", "globex", "--workspace", src]);
    expect(r.code, r.stderr).toBe(0);
    await expect(fs.lstat(path.join(target, "ingredients/rules/hello"))).resolves.toBeTruthy();
  });

  it("forge unify --save-plan with a cache tree still writes the plan and nothing in the tree (pin)", async () => {
    const ctx = await cacheTree();
    const planFile = path.join(ctx.parent, "plan.yaml");
    const before = await snapshot(ctx.tree);
    const r = ctx.run(["forge", "unify", "rule/workflow", "--profile", "acme", "--save-plan", planFile, "--forge", ctx.tree, "--no-impact"]);
    expect(r.code, r.stderr).toBe(0);
    expect(await fs.lstat(planFile).then(() => true, () => false)).toBe(true);
    expect(await snapshot(ctx.tree)).toEqual(before);
  });

  it("a cache tree reached through a junction is refused", async () => {
    const ctx = await cacheTree();
    const link = path.join(ctx.parent, "via-link");
    await fs.symlink(ctx.tree, link, "junction");
    const before = await snapshot(ctx.tree);
    const r = ctx.run(["forge", "unify", "rule/workflow", "--profile", "acme", "--take", "base", "--forge", link, "--no-impact"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(TAIL);
    expect(r.stderr).not.toContain(ctx.entry);
    expect(r.stderr).toContain("(a cache entry name — not shown)");
    expect(await snapshot(ctx.tree)).toEqual(before);
  });

  it("a cache tree under a CRAFTAR_HOME given through a junction is refused", async () => {
    const ctx = await cacheTree();
    const homeLink = path.join(ctx.parent, "home-link");
    await fs.symlink(ctx.home, homeLink, "junction");
    const linkedTree = path.join(homeLink, "forges", ctx.entry, "trees", ctx.t);
    const before = await snapshot(ctx.tree);
    const r = ctx.run(["forge", "promote", "rule/workflow", "--profile", "acme", "--forge", linkedTree, "--no-impact"], { CRAFTAR_HOME: homeLink });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(TAIL);
    expect(r.stderr).not.toContain(ctx.entry);
    expect(r.stderr).toContain("(a cache entry name — not shown)");
    expect(await snapshot(ctx.tree)).toEqual(before);
  });

  it.skipIf(process.platform !== "win32")("on Windows a cache tree spelled in another case is refused", async () => {
    const ctx = await cacheTree();
    const r = ctx.run(["forge", "unify", "rule/workflow", "--profile", "acme", "--take", "base", "--forge", ctx.tree.toUpperCase(), "--no-impact"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(TAIL);
    expect(r.stderr).not.toContain(ctx.entry);
    expect(r.stderr).toContain("(a cache entry name — not shown)");
  });
});
