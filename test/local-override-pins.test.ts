import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listFiles } from "../src/core/forge.js";
import { FORGE_SCHEMA_LOCAL_OVERRIDE } from "../src/schema/index.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";
import { git } from "./helpers/remote.js";
import { withoutNewerTag } from "./helpers/newer-tag-delta.js";

/**
 * Spec 56 §9: pin, BEFORE any source change of spec 56, what a Forge below the override gate answers — a Forge at
 * schema 9 whose profile acme holds a local and a local recipe, and whose root holds acme's variant `rule/y--acme` of a
 * shared base `rule/y` (the shape `forge localize` refuses today). Spec 56 may change none of it: its keys, lines and
 * refusals appear only at the new schema.
 */

const PIN_FILE = path.resolve(__dirname, "pins/local-override-off.json");
const regen = process.env.REGEN_PINS === "1";

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true });
});

const localRule = (p: string, name: string, body: string) => ({
  [`profiles/${p}/ingredients/rules/${name}/ingredient.yaml`]: YAML.stringify({ type: "rule", name }),
  [`profiles/${p}/ingredients/rules/${name}/rule.md`]: body,
});
const localRecipe = (p: string, name: string, ingredients: string[]) => ({
  [`profiles/${p}/recipes/${name}.yaml`]: YAML.stringify({ name, ingredients }),
});

const spec: ForgeSpec = {
  ingredients: [rule("style", "# Style\n"), rule("y", "# Y shared\n"), rule("y--acme", "# Y for acme\n", { as: "y" })],
  recipes: [recipe("base", ["rule/style", "rule/y"]), recipe("base--acme", ["rule/style", "rule/y--acme"])],
  profiles: [profile("acme", ["base--acme", "acme-extra"]), profile("globex", ["base"])],
};
const files = { ...localRule("acme", "x", "# X\n"), ...localRecipe("acme", "acme-extra", ["rule/x"]) };

async function setup() {
  const root = await tmpDir("craftar-local-override-pin-");
  cleanups.push(root);
  const forge = path.join(root, "forge");
  await makeForge(forge, spec);
  await fs.writeFile(path.join(forge, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 9 }));
  await writeFiles(forge, files);
  git(forge, "init", "-q", "-b", "main");
  git(forge, "add", "-A");
  git(forge, "commit", "-q", "-m", "forge");
  const ws: Record<string, string> = {};
  for (const p of ["acme", "globex"]) {
    ws[p] = path.join(root, p);
    await makeWorkspace(ws[p], forge, { config: { profile: p } });
    const sync = runCli(["sync", "--workspace", ws[p]]);
    expect(sync.code, sync.stderr).toBe(0);
  }
  return { root, forge, ws, roots: [root, await fs.realpath(root)] };
}

function normalize(value: unknown, roots: string[]): unknown {
  if (typeof value === "string") {
    let s = value;
    for (const r of roots) {
      s = s.split(r).join("<root>");
      s = s.split(r.replace(/\\/g, "/")).join("<root>");
      s = s.split(r.replace(/\//g, "\\")).join("<root>");
    }
    return s.replace(/<root>[/\\]/g, "<root>/");
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, roots));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, roots)]));
  return value;
}

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of (await listFiles(dir)).sort()) {
    if (f.startsWith(".git/") || f === "craftar.lock" || !(await fs.lstat(path.join(dir, f))).isFile()) continue;
    out[f] = await fs.readFile(path.join(dir, f), "utf8");
  }
  return out;
}

const run = (r: { code: number | null; stdout: string; stderr: string }) => ({ code: r.code, stdout: r.stdout, stderr: r.stderr });
const json = (r: { code: number | null; stdout: string; stderr: string }) => ({ code: r.code, json: r.code === 0 ? JSON.parse(r.stdout) : r.stdout, stderr: r.stderr });

async function observe() {
  const s = await setup();
  const out: Record<string, unknown> = {};
  for (const p of ["acme", "globex"]) {
    out[`${p}.files`] = await tree(s.ws[p]);
    out[`${p}.check`] = run(runCli(["sync", "--check", "--workspace", s.ws[p]]));
    out[`${p}.status`] = json(runCli(["status", "--json", "--workspace", s.ws[p]]));
    out[`${p}.ingredients`] = json(runCli(["ingredients", "--json", "--workspace", s.ws[p]]));
  }
  out.explainLocal = run(runCli(["explain", ".claude/rules/x.md", "--workspace", s.ws.acme]));
  out.explainRoot = run(runCli(["explain", ".claude/rules/y.md", "--workspace", s.ws.acme]));
  out.forgeIngredients = json(runCli(["ingredients", "--forge", s.forge, "--json"]));
  out.forgeIngredientsText = run(runCli(["ingredients", "--forge", s.forge]));
  out.localize = run(runCli(["forge", "localize", "rule/y--acme", "--profile", "acme", "--forge", s.forge, "--dry-run", "--json"]));
  out.share = json(runCli(["forge", "share", "rule/x", "--profile", "acme", "--forge", s.forge, "--dry-run", "--json"]));
  out.promote = json(runCli(["forge", "promote", "rule/y", "--profile", "acme", "--forge", s.forge, "--dry-run", "--json"]));
  out.promoteShared = run(runCli(["forge", "promote", "rule/y", "--profile", "globex", "--forge", s.forge, "--dry-run", "--json"]));
  out.importAcme = run(runCli(["import", "--from", "claude-code", "--workspace", s.ws.acme, "--forge", s.forge, "--profile", "acme"]));
  out.forgeAfterImport = await tree(s.forge);
  const commit = git(s.forge, "rev-parse", "HEAD").trim();
  return JSON.parse(JSON.stringify(normalize(out, s.roots)).split(commit).join("<commit>").split(commit.slice(0, 8)).join("<commit>")) as Record<string, unknown>;
}

/**
 * What spec 56 changes below its gate on purpose (§5.1), taken out before the comparison and asserted present: the
 * localize refusal of a profile's own variant whose base is at the root names the schema at which it becomes an
 * override. Nothing else of the pin may move.
 */
const LOCALIZE_HINT = `; at schema ${FORGE_SCHEMA_LOCAL_OVERRIDE} in craftar.forge.yaml it becomes profile acme's override of rule/y`;
function deliberate(observed: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(observed);
  const o = out.localize as { stderr: string };
  expect(o.stderr).toContain(LOCALIZE_HINT);
  o.stderr = o.stderr.replace(LOCALIZE_HINT, "");
  return out;
}

describe("local override off baseline pin (spec 56 §9)", () => {
  it("a schema 9 Forge with a profile's locals and a root variant of its own answers as before spec 56", { timeout: 180_000 }, async () => {
    const observed = await observe();
    if (regen) {
      await fs.writeFile(PIN_FILE, JSON.stringify(observed, null, 2) + "\n");
      return;
    }
    expect(withoutNewerTag(deliberate(observed))).toEqual(withoutNewerTag(JSON.parse(await fs.readFile(PIN_FILE, "utf8"))));
  });
});
