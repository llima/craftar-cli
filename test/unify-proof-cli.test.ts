import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { listFiles, loadForge } from "../src/core/forge.js";
import { proveUnifyLoads } from "../src/core/unify.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";
import { git } from "./helpers/remote.js";

// E38.1: `forge unify` proves, on a scratch copy, that the Forge its edits leave still loads — before the first write.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const THREE: ForgeSpec = {
  ingredients: [rule("workflow", "base text\n"), rule("workflow--acme", "acme text\n", { as: "workflow" }), rule("style", "style\n")],
  recipes: [recipe("base", ["rule/workflow", "rule/style"]), recipe("base--acme", ["rule/workflow--acme", "rule/style"])],
  profiles: [profile("acme", ["base--acme"], ["claude-code"]), profile("globex", ["base"])],
};

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await listFiles(dir)) if (!f.startsWith(".git/")) out[f] = (await fs.readFile(path.join(dir, f))).toString("hex");
  return out;
}

async function scenario(extra: Record<string, string>) {
  const root = await fs.realpath(await tmpDir("craftar-unify-proof-"));
  cleanups.push(() => removeWithRetry(root));
  const forge = path.join(root, "forge");
  const tmp = path.join(root, "tmp");
  await fs.mkdir(tmp);
  await makeForge(forge, THREE);
  await writeFiles(forge, extra);
  git(forge, "init", "-q", "-b", "main");
  git(forge, "add", "-A");
  git(forge, "commit", "-q", "-m", "forge");
  const unify = () =>
    runCli(["forge", "unify", "rule/workflow", "--profile", "acme", "--take", "variant", "--forge", forge, "--no-impact"], { env: { CRAFTAR_HOME: path.join(root, "home"), TMPDIR: tmp, TEMP: tmp, TMP: tmp } });
  return { root, forge, tmp, unify };
}

describe("forge unify proves the Forge still loads before it writes (E38.1)", () => {
  it("refuses, with the Forge untouched and no copy left, an edit set whose removed variant a recipe still names", async () => {
    // No merge the CLI can reach on 0.60.0 builds such a set (the cascade, localCiters and the schema read-backs refuse
    // first); the proof is the gate behind them, so it is handed one directly: the variant removed, the cascade empty.
    // At schema 8 a root recipe naming an ingredient that does not exist fails the load (L4).
    const s = await scenario({ "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 8 }) });
    const f = await loadForge(s.forge);
    const before = await snapshot(s.forge);
    const prevTmp = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    for (const k of Object.keys(prevTmp)) process.env[k] = s.tmp;
    try {
      const run = proveUnifyLoads(f, {
        files: [],
        base: f.ingredients.get("rule/workflow")!,
        result: { write: {}, remove: [] } as never,
        cascade: [],
        removeDir: f.ingredients.get("rule/workflow--acme")!.dir,
      });
      const err = await run.then(() => null, (e: Error) => e.message);
      expect(err).toMatch(/^unify: the Forge would not load after this merge:\n/);
      expect(err).toContain("rule/workflow--acme");
      expect(err).toMatch(/\nnothing written$/);
      expect(err).not.toContain(s.tmp);
    } finally {
      for (const [k, v] of Object.entries(prevTmp)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(await snapshot(s.forge)).toEqual(before);
    expect((await fs.readdir(s.tmp)).filter((n) => n.startsWith("craftar-"))).toEqual([]);
  });

  it("refuses, with the Forge untouched, a Forge whose recipes folder is a directory link (through the proof copy)", async () => {
    // Until E38.1 unify did not copy the Forge, followed the link and wrote; the copy refuses a linked root tree.
    const s = await scenario({});
    // Inside the Forge, so the load reads through it (a link out of the Forge is refused at load, spec 48).
    const moved = path.join(s.forge, "store", "recipes");
    await fs.mkdir(path.dirname(moved));
    await fs.rename(path.join(s.forge, "recipes"), moved);
    // A junction on Windows needs no privilege; elsewhere the type is ignored.
    await fs.symlink(moved, path.join(s.forge, "recipes"), "junction");
    git(s.forge, "add", "-A");
    git(s.forge, "commit", "-q", "-m", "link");
    const ingredients = path.join(s.forge, "ingredients");
    const before = await snapshot(ingredients);
    const beforeLinked = await snapshot(moved);
    const r = s.unify();
    expect(r.code, r.stdout).toBe(1);
    expect(r.stderr).toBe("error: recipes is a symbolic link in the Forge — unify does not read a linked recipes, ingredients or profiles directory; replace it with the directory and commit\n");
    expect(await snapshot(ingredients)).toEqual(before);
    expect(await snapshot(moved)).toEqual(beforeLinked);
    expect(git(s.forge, "status", "--porcelain")).toBe("");
    expect((await fs.readdir(s.tmp)).filter((n) => n.startsWith("craftar-"))).toEqual([]);
  });

  // A file link inside the Forge is copied as a file and written through for real (spec 48): its target's folder can
  // refuse a write the proof never met. Off win32 (file link, chmod) and as non-root (root ignores the mode).
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a write that fails after the proof names what was written and the git recovery (lateFailure)", async () => {
    const s = await scenario({});
    const store = path.join(s.forge, "store");
    await fs.mkdir(store);
    await fs.rename(path.join(s.forge, "recipes/base--acme.yaml"), path.join(store, "base--acme.yaml"));
    await fs.symlink(path.join("..", "store", "base--acme.yaml"), path.join(s.forge, "recipes/base--acme.yaml"));
    git(s.forge, "add", "-A");
    git(s.forge, "commit", "-q", "-m", "link");
    await fs.chmod(store, 0o555);
    cleanups.push(() => fs.chmod(store, 0o755).catch(() => undefined));
    const r = s.unify();
    expect(r.code, r.stdout).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("unify had already started changing the Forge");
    expect(r.stderr).toContain("ingredients/rules/workflow/rule.md");
    expect(r.stderr).toContain("recover with:");
    expect(r.stderr).toMatch(/git -C \S+ checkout -- /);
    // The removal comes last: the variant is still there.
    expect(await fs.lstat(path.join(s.forge, "ingredients/rules/workflow--acme")).then(() => true, () => false)).toBe(true);
    // The recovery, run as printed, gives the Forge back.
    await fs.chmod(store, 0o755);
    for (const line of r.stderr.split("\n").filter((l) => l.startsWith("  git -C "))) execSync(line.trim());
    expect(git(s.forge, "status", "--porcelain")).toBe("");
  });

  it("(control) a profile's local recipe naming the variant is still refused by its own check, in its own words", async () => {
    const s = await scenario({
      "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 8 }),
      "profiles/globex/recipes/globex-extra.yaml": YAML.stringify({ name: "globex-extra", ingredients: ["rule/workflow--acme"] }),
    });
    const before = await snapshot(s.forge);
    const r = s.unify();
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("error: unify: profiles/globex/recipes/globex-extra.yaml cites rule/workflow--acme — unify does not edit a profile's local recipe; edit it by hand, commit, and re-run\n");
    expect(await snapshot(s.forge)).toEqual(before);
  });

  it("(control) a merge that loads is written, and leaves no scratch copy", async () => {
    const s = await scenario({});
    const r = s.unify();
    expect(r.code, r.stderr).toBe(0);
    expect(await fs.readFile(path.join(s.forge, "ingredients/rules/workflow/rule.md"), "utf8")).toBe("acme text\n");
    expect((await fs.readdir(s.tmp)).filter((n) => n.startsWith("craftar-"))).toEqual([]);
  });
});
