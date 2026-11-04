import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { listFiles, loadForge } from "../src/core/forge.js";
import { proveUnifyLoads } from "../src/core/unify.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";
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
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const forge = path.join(root, "forge");
  const tmp = path.join(root, "tmp");
  await fs.mkdir(tmp);
  await makeForge(forge, THREE);
  await writeFiles(forge, extra);
  git(forge, "init", "-q", "-b", "main");
  git(forge, "add", "-A");
  git(forge, "commit", "-q", "-m", "forge");
  const unify = () =>
    runCli(["forge", "unify", "rule/workflow", "--profile", "acme", "--take", "variant", "--forge", forge, "--no-impact"], { env: { CRAFTAR_HOME: path.join(root, "home"), TMPDIR: tmp } });
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
    const prevTmp = process.env.TMPDIR;
    process.env.TMPDIR = s.tmp;
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
      if (prevTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmp;
    }
    expect(await snapshot(s.forge)).toEqual(before);
    expect((await fs.readdir(s.tmp)).filter((n) => n.startsWith("craftar-"))).toEqual([]);
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
