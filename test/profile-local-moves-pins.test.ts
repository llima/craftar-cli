import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listFiles } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";
import { git } from "./helpers/remote.js";

/**
 * Spec 51 Part B §10: pin, BEFORE any source change of Part B, what the commands Part B touches answer today on a
 * Forge whose profile holds locals — `import` with no `--local`, at schema 8 and at schema 7, `drift show --json`,
 * `drift promote` on a root file, and `forge promote --json`. Part B may change only what it says it changes: the two
 * import refusals that gain a hint, and `drift show`'s row for a local's file. Every other value stays as pinned here.
 */

const PIN_FILE = path.resolve(__dirname, "pins/profile-local-moves-off.json");
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
  ingredients: [rule("style", "# Style\n"), rule("workflow", "base text\n"), rule("workflow--acme", "acme text\n", { as: "workflow" })],
  recipes: [recipe("base", ["rule/style", "rule/workflow"]), recipe("base--acme", ["rule/style", "rule/workflow--acme"])],
  profiles: [profile("acme", ["base--acme", "acme-extra"]), profile("globex", ["base", "globex-extra"])],
};
const files = {
  ...localRule("acme", "x", "# X\n"),
  ...localRecipe("acme", "acme-extra", ["rule/x"]),
  ...localRule("globex", "secret", "# S\n"),
  ...localRecipe("globex", "globex-extra", ["rule/secret"]),
};

/** A Forge in git at `schema`, and a workspace of acme synced from it. */
async function setup(schema: number) {
  const root = await tmpDir("craftar-local-moves-pin-");
  cleanups.push(root);
  const forge = path.join(root, "forge");
  // Below the gate the local recipes are not read, so the profiles name the root recipes only.
  await makeForge(forge, schema >= 8 ? spec : { ...spec, profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"])] });
  await fs.writeFile(path.join(forge, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
  await writeFiles(forge, files);
  git(forge, "init", "-q", "-b", "main");
  git(forge, "add", "-A");
  git(forge, "commit", "-q", "-m", "forge");
  const ws = path.join(root, "ws");
  await makeWorkspace(ws, forge, { config: { profile: "acme" } });
  const sync = runCli(["sync", "--workspace", ws]);
  expect(sync.code, sync.stderr).toBe(0);
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
    if (f.startsWith(".git/") || !(await fs.lstat(path.join(dir, f))).isFile()) continue;
    out[f] = await fs.readFile(path.join(dir, f), "utf8");
  }
  return out;
}

const importInto = (s: { ws: string; forge: string }) => runCli(["import", "--from", "claude-code", "--workspace", s.ws, "--forge", s.forge, "--profile", "acme"]);
const run = (r: { code: number | null; stdout: string; stderr: string }) => ({ code: r.code, stdout: r.stdout, stderr: r.stderr });

async function observe() {
  const out: Record<string, unknown> = {};

  // A source equal to the profile's local: reused there, the Forge's tree after.
  {
    const s = await setup(8);
    out.importReuse = normalize({ ...run(importInto(s)), forge: await tree(s.forge) }, s.roots);
  }
  // A source that differs from the profile's local: refused (Part B adds a hint to this message).
  {
    const s = await setup(8);
    await fs.writeFile(path.join(s.ws, ".claude/rules/x.md"), "# X, edited\n");
    out.importDiffers = normalize(run(importInto(s)), s.roots);
  }
  // I14: a new root ingredient named after another profile's local (Part B adds a hint to this message).
  {
    const s = await setup(8);
    await writeFiles(s.ws, { ".claude/rules/secret.md": "# mine\n" });
    out.importI14 = normalize(run(importInto(s)), s.roots);
  }
  // Below the gate: the folder is not read, and import is what it was.
  {
    const s = await setup(7);
    out.importSchema7 = normalize({ ...run(importInto(s)), forge: await tree(s.forge) }, s.roots);
  }
  // drift show over a hand-edited local file and a hand-edited root file (Part B changes the local's row only).
  {
    const s = await setup(8);
    await fs.writeFile(path.join(s.ws, ".claude/rules/x.md"), "# X, edited by hand\n");
    await fs.writeFile(path.join(s.ws, ".claude/rules/style.md"), "# Style, edited by hand\n");
    const r = runCli(["drift", "show", "--json", "--workspace", s.ws]);
    out.driftShow = normalize({ code: r.code, json: JSON.parse(r.stdout), stderr: r.stderr }, s.roots);
  }
  // drift promote of a root file in a workspace whose profile holds locals: unchanged by Part B.
  {
    const s = await setup(8);
    await fs.writeFile(path.join(s.ws, ".claude/rules/style.md"), "# Style, edited by hand\n");
    const r = runCli(["drift", "promote", ".claude/rules/style.md", "--json", "--workspace", s.ws]);
    out.driftPromoteRoot = normalize({ code: r.code, json: r.code === 0 ? JSON.parse(r.stdout) : r.stdout, stderr: r.stderr, forge: await tree(s.forge) }, s.roots);
  }
  // forge promote of a root variant in a Forge holding locals: unchanged by Part B.
  {
    const s = await setup(8);
    const r = runCli(["forge", "promote", "rule/workflow", "--profile", "acme", "--forge", s.forge, "--no-impact", "--json"]);
    out.forgePromote = normalize({ code: r.code, json: r.code === 0 ? JSON.parse(r.stdout) : r.stdout, stderr: r.stderr, forge: await tree(s.forge) }, s.roots);
  }
  return out;
}

/**
 * What Part B changes on purpose, taken out before the comparison and asserted present: the hint the two import
 * refusals gain (spec 51 §4.2, §5.3) and drift show's row for a local's file (§5.4). Nothing else of the pin may move.
 */
const HINTS: Array<[string, string]> = [
  ["importDiffers", " — edit the local in the Forge and re-run, or re-run with --local=auto to rewrite it"],
  ["importI14", ", or re-run with --local=auto to keep it local to this profile"],
];
const WAS: Record<string, string> = { importDiffers: " — edit the local in the Forge, then re-run", importI14: "" };
function deliberate(observed: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(observed);
  // Spec 51 §5.4: a local's file is promotable — drift show's row for it was `promotable: false`, `profile-local`.
  const row = (out.driftShow as { json: { files: Array<{ path: string; promotable: boolean; reason: string | null }> } }).json.files.find((f) => f.path === ".claude/rules/x.md")!;
  expect(row).toMatchObject({ promotable: true, reason: null });
  Object.assign(row, { promotable: false, reason: "profile-local" });
  for (const [key, hint] of HINTS) {
    const o = out[key] as { stderr: string };
    expect(o.stderr, key).toContain(hint);
    o.stderr = o.stderr.replace(hint, WAS[key]);
  }
  return out;
}

describe("profile-local moves=off baseline pin (spec 51 Part B §10)", () => {
  it("import without --local, drift show, drift promote and forge promote on a Forge whose profiles hold locals", { timeout: 180_000 }, async () => {
    const observed = await observe();
    if (regen) {
      await fs.writeFile(PIN_FILE, JSON.stringify(observed, null, 2) + "\n");
      return;
    }
    expect(deliberate(observed)).toEqual(JSON.parse(await fs.readFile(PIN_FILE, "utf8")));
  });
});
