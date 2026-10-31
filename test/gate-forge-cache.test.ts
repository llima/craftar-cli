import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";
import { makeForge, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";

// gateOutsideForge refuses a target under the Forge cache ($CRAFTAR_HOME/forges/…)

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const FORGE_SPEC: ForgeSpec = {
  ingredients: [rule("hello", "hello world\n")],
  recipes: [recipe("base", ["rule/hello"])],
  profiles: [profile("acme", ["base"])],
};

async function setup() {
  const parent = await fs.realpath(await tmpDir("craftar-gatecache-"));
  cleanups.push(() => removeWithRetry(parent));
  const home = path.join(parent, "home");
  const forgeDir = path.join(parent, "forge");
  const wsDir = path.join(parent, "ws");
  
  // Create a Forge
  await makeForge(forgeDir, FORGE_SPEC);
  
  // Create a workspace and sync to populate the cache structure
  await fs.mkdir(wsDir, { recursive: true });
  await fs.writeFile(path.join(wsDir, "craftar.yaml"), `forge: ${forgeDir.replace(/\\/g, "/")}\nprofile: acme\n`);
  
  // Create the forges directory with an entry
  const entrySecret = "entry-secret";
  const forgesDir = path.join(home, "forges", entrySecret, "trees", "abc");
  await fs.mkdir(forgesDir, { recursive: true });
  
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    runCli(args, { env: { CRAFTAR_HOME: home, ...env } });
  
  return { parent, home, forgeDir, wsDir, forgesDir, entrySecret, run };
}

describe("gateOutsideForge refuses targets under the Forge cache", () => {
  it("import --report to a path under forges/ exits 1, no file created, stderr lacks entry name", async () => {
    const ctx = await setup();
    const reportPath = path.join(ctx.home, "forges", ctx.entrySecret, "trees", "abc", "report.md");
    
    // Create a source workspace with something to import
    const srcWs = path.join(ctx.parent, "src-ws");
    await fs.mkdir(path.join(srcWs, ".claude/rules"), { recursive: true });
    await fs.writeFile(path.join(srcWs, ".claude/rules/test.md"), "# Test\n");
    
    const r = ctx.run([
      "import", "--from", "claude-code",
      "--forge", ctx.forgeDir,
      "--profile", "globex",
      "--workspace", srcWs,
      "--report", reportPath,
    ]);
    
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("refusing to write the report");
    expect(r.stderr).toContain("inside craftar's Forge cache");
    expect(r.stderr).not.toContain(ctx.entrySecret);
    expect(r.stderr).toContain("(a cache entry name — not shown)");
    await expect(fs.lstat(reportPath)).rejects.toThrow();
  });

  it("forge unify --save-plan to a path under forges/ exits 1, no file created, stderr lacks entry name", async () => {
    const ctx = await setup();
    
    // Create a variant so unify has something to work with
    await writeFiles(ctx.forgeDir, {
      "ingredients/rules/hello--acme/ingredient.yaml": "type: rule\nname: hello--acme\nas: hello\n",
      "ingredients/rules/hello--acme/rule.md": "variant text\n",
      "recipes/base--acme.yaml": "name: base--acme\ningredients:\n  - rule/hello--acme\n",
      "profiles/acme/profile.yaml": "name: acme\nrecipes:\n  - base--acme\ntargets:\n  - claude-code\n",
    });
    
    const planPath = path.join(ctx.home, "forges", ctx.entrySecret, "trees", "abc", "plan.yaml");
    const r = ctx.run([
      "forge", "unify", "rule/hello",
      "--profile", "acme",
      "--forge", ctx.forgeDir,
      "--save-plan", planPath,
    ]);
    
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("refusing to write the plan");
    expect(r.stderr).toContain("inside craftar's Forge cache");
    expect(r.stderr).not.toContain(ctx.entrySecret);
    expect(r.stderr).toContain("(a cache entry name — not shown)");
    await expect(fs.lstat(planPath)).rejects.toThrow();
  });

  it("target in a not-yet-existing directory under the cache is refused, directory not created", async () => {
    const ctx = await setup();
    const nestedPath = path.join(ctx.home, "forges", ctx.entrySecret, "trees", "abc", "nested", "deep", "report.md");
    const nestedParent = path.dirname(nestedPath);
    
    const srcWs = path.join(ctx.parent, "src-ws2");
    await fs.mkdir(path.join(srcWs, ".claude/rules"), { recursive: true });
    await fs.writeFile(path.join(srcWs, ".claude/rules/test.md"), "# Test\n");
    
    const r = ctx.run([
      "import", "--from", "claude-code",
      "--forge", ctx.forgeDir,
      "--profile", "globex",
      "--workspace", srcWs,
      "--report", nestedPath,
    ]);
    
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("refusing to write the report");
    expect(r.stderr).toContain("inside craftar's Forge cache");
    await expect(fs.lstat(nestedParent)).rejects.toThrow(); // Directory not created
  });

  it("through a symlink (junction on win32) to the cache tree", async () => {
    const ctx = await setup();
    const linkPath = path.join(ctx.parent, "link-to-forges");
    await fs.symlink(path.join(ctx.home, "forges"), linkPath, "junction");
    
    const reportPath = path.join(linkPath, ctx.entrySecret, "trees", "abc", "report.md");
    
    const srcWs = path.join(ctx.parent, "src-ws3");
    await fs.mkdir(path.join(srcWs, ".claude/rules"), { recursive: true });
    await fs.writeFile(path.join(srcWs, ".claude/rules/test.md"), "# Test\n");
    
    const r = ctx.run([
      "import", "--from", "claude-code",
      "--forge", ctx.forgeDir,
      "--profile", "globex",
      "--workspace", srcWs,
      "--report", reportPath,
    ]);
    
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("inside craftar's Forge cache");
    expect(r.stderr).not.toContain(ctx.entrySecret);
  });

  it("control: a target outside the cache still writes", async () => {
    const ctx = await setup();
    const reportPath = path.join(ctx.parent, "report.md");
    
    const srcWs = path.join(ctx.parent, "src-ws4");
    await fs.mkdir(path.join(srcWs, ".claude/rules"), { recursive: true });
    await fs.writeFile(path.join(srcWs, ".claude/rules/test.md"), "# Test\n");
    
    const r = ctx.run([
      "import", "--from", "claude-code",
      "--forge", ctx.forgeDir,
      "--profile", "globex",
      "--workspace", srcWs,
      "--report", reportPath,
    ]);
    
    expect(r.code, r.stderr).toBe(0);
    await expect(fs.lstat(reportPath)).resolves.toBeTruthy();
  });
});

describe("a cache entry's name in a refusal that cannot resolve the path", () => {
  async function loop(home: string) {
    const entry = path.join(home, "forges", "entry-secret");
    await fs.mkdir(entry, { recursive: true });
    await fs.symlink(path.join(entry, "loop"), path.join(entry, "loop"));
    return entry;
  }

  it.skipIf(process.platform === "win32")("import --forge through a link loop, with a home itself named forges: no entry name", async () => {
    const parent = await fs.realpath(await tmpDir("craftar-gatecache-loop-"));
    cleanups.push(() => removeWithRetry(parent));
    const home = path.join(parent, "forges");
    const entry = await loop(home);
    const ws = path.join(parent, "ws");
    await fs.mkdir(path.join(ws, ".claude/rules"), { recursive: true });
    const r = runCli(["import", "--from", "claude-code", "--forge", path.join(entry, "loop", "q"), "--profile", "acme", "--workspace", ws], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain("entry-secret");
    expect(r.stderr).toContain("(a cache entry name — not shown)");
  });

  it.skipIf(process.platform === "win32")("import --report through a link loop: no entry name", async () => {
    const parent = await fs.realpath(await tmpDir("craftar-gatecache-loop-"));
    cleanups.push(() => removeWithRetry(parent));
    const home = path.join(parent, "home");
    const entry = await loop(home);
    const forge = path.join(parent, "forge");
    await makeForge(forge, FORGE_SPEC);
    const ws = path.join(parent, "ws");
    await fs.mkdir(path.join(ws, ".claude/rules"), { recursive: true });
    const r = runCli(["import", "--from", "claude-code", "--forge", forge, "--profile", "acme", "--workspace", ws, "--report", path.join(entry, "loop", "r.md")], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("refusing to write the report");
    expect(r.stderr).not.toContain("entry-secret");
  });

  it("--save-plan inside a Forge that is a tree of the cache: no entry name", async () => {
    const parent = await fs.realpath(await tmpDir("craftar-gatecache-tree-"));
    cleanups.push(() => removeWithRetry(parent));
    const home = path.join(parent, "home");
    const tree = path.join(home, "forges", "entry-secret", "trees", "abc");
    await makeForge(tree, FORGE_SPEC);
    await writeFiles(tree, {
      "ingredients/rules/hello--acme/ingredient.yaml": "type: rule\nname: hello--acme\nas: hello\n",
      "ingredients/rules/hello--acme/rule.md": "variant text\n",
      "recipes/base--acme.yaml": "name: base--acme\ningredients:\n  - rule/hello--acme\n",
      "profiles/acme/profile.yaml": "name: acme\nrecipes:\n  - base--acme\ntargets:\n  - claude-code\n",
    });
    const r = runCli(["forge", "unify", "rule/hello", "--profile", "acme", "--forge", tree, "--save-plan", path.join(tree, "plan.yaml")], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("refusing to write the plan");
    expect(r.stderr).not.toContain("entry-secret");
  });
});

describe("the path a gate refusal prints", () => {
  const LABEL = "(a cache entry name — not shown)";

  async function fixture() {
    const parent = await fs.realpath(await tmpDir("craftar-gatecache-shown-"));
    cleanups.push(() => removeWithRetry(parent));
    const home = path.join(parent, "home");
    const entry = path.join(home, "forges", "entry-secret");
    await fs.mkdir(entry, { recursive: true });
    const forge = path.join(parent, "forge");
    await makeForge(forge, FORGE_SPEC);
    const ws = path.join(parent, "ws");
    await fs.mkdir(path.join(ws, ".claude/rules"), { recursive: true });
    const report = (target: string, env: NodeJS.ProcessEnv, cwd?: string, f = forge) =>
      runCli(["import", "--from", "claude-code", "--forge", f, "--profile", "acme", "--workspace", ws, "--report", target], { env, cwd });
    return { parent, home, entry, report };
  }

  it.skipIf(process.platform === "win32")("a home reached through a link and itself named forges: no entry name", async () => {
    const { parent, report } = await fixture();
    const real = path.join(parent, "real", "forges");
    const entry = path.join(real, "forges", "entry-secret");
    await fs.mkdir(entry, { recursive: true });
    await fs.symlink(path.join(entry, "loop"), path.join(entry, "loop"));
    const link = path.join(parent, "linkhome");
    await fs.symlink(real, link);
    const r = report(path.join(entry, "loop", "r.md"), { CRAFTAR_HOME: link });
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain("entry-secret");
  });

  it.skipIf(process.platform === "win32")("a relative target under the cache: no entry name, from the home and from forges/", async () => {
    const { home, entry, report } = await fixture();
    await fs.symlink(path.join(entry, "loop"), path.join(entry, "loop"));
    for (const [cwd, target] of [[home, path.join("forges", "entry-secret", "loop", "r.md")], [path.join(home, "forges"), path.join("entry-secret", "loop", "r.md")]]) {
      const r = report(target, { CRAFTAR_HOME: home }, cwd);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(LABEL);
      expect(r.stderr).not.toContain("entry-secret");
    }
  });

  it("an existing file in a folder named forges outside the cache keeps its path", async () => {
    const { parent, home, report } = await fixture();
    const target = path.join(parent, "work", "forges", "acme", "r.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "x\n");
    const r = report(target, { CRAFTAR_HOME: home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`refusing to write the report to ${target}: the file already exists`);
  });

  it("a Forge in a folder named forges outside the cache keeps its path", async () => {
    const { parent, home, report } = await fixture();
    const forge = path.join(parent, "work", "forges", "acme");
    await makeForge(forge, FORGE_SPEC);
    const target = path.join(forge, "r.md");
    const r = report(target, { CRAFTAR_HOME: home }, undefined, forge);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`refusing to write the report to ${target}: it resolves inside the Forge (${forge})`);
  });
});

describe("the cause a gate refusal relays", () => {
  async function fixture() {
    const parent = await fs.realpath(await tmpDir("craftar-gatecache-cause-"));
    cleanups.push(() => removeWithRetry(parent));
    const forge = path.join(parent, "forge");
    await makeForge(forge, FORGE_SPEC);
    const ws = path.join(parent, "ws");
    await fs.mkdir(path.join(ws, ".claude/rules"), { recursive: true });
    const looped = async (dir: string) => {
      await fs.mkdir(dir, { recursive: true });
      await fs.symlink(path.join(dir, "loop"), path.join(dir, "loop"));
      return path.join(dir, "loop");
    };
    return { parent, forge, ws, looped };
  }

  it.skipIf(process.platform === "win32")("a folder named forges outside the cache keeps its name", async () => {
    const { parent, forge, ws, looped } = await fixture();
    const loop = await looped(path.join(parent, "ord", "forges", "kept"));
    const env = { CRAFTAR_HOME: path.join(parent, "home") };
    const report = runCli(["import", "--from", "claude-code", "--forge", forge, "--profile", "acme", "--workspace", ws, "--report", path.join(loop, "r.md")], { env });
    expect(report.code).toBe(1);
    expect(report.stderr).not.toContain("(a cache entry name — not shown)");
    const asForge = runCli(["import", "--from", "claude-code", "--forge", path.join(loop, "f"), "--profile", "acme", "--workspace", ws], { env });
    expect(asForge.code).toBe(1);
    expect(asForge.stderr).not.toContain("(a cache entry name — not shown)");
  });

  it.skipIf(process.platform === "win32")("a cache linked to a directory of another name: no entry name", async () => {
    const { parent, forge, ws, looped } = await fixture();
    const store = path.join(parent, "store");
    const loop = await looped(path.join(store, "entry-secret"));
    const home = path.join(parent, "home");
    await fs.mkdir(home);
    await fs.symlink(store, path.join(home, "forges"));
    const env = { CRAFTAR_HOME: home };
    const report = runCli(["import", "--from", "claude-code", "--forge", forge, "--profile", "acme", "--workspace", ws, "--report", path.join(loop, "r.md")], { env });
    expect(report.code).toBe(1);
    expect(report.stderr).not.toContain("entry-secret");
    const asForge = runCli(["import", "--from", "claude-code", "--forge", path.join(loop, "f"), "--profile", "acme", "--workspace", ws], { env });
    expect(asForge.code).toBe(1);
    expect(asForge.stderr).not.toContain("entry-secret");
  });
});
