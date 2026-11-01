import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, scenario, writeFiles, type IngredientSpec } from "./helpers/forge.js";

/**
 * Spec 51 §10: pin what a Forge below `schema: 8` gets today, BEFORE any source change, so the local layer can
 * prove it changes nothing there but the one warning §4.1 adds. The Forge already holds a `profiles/acme/ingredients`
 * and `profiles/acme/recipes` folder (ignored today), an unused recipe with broken references (loads today), a skill
 * shell file with a section and a param, and an Angular line. A second Forge pins the refusal of a declared key with
 * no value cited only in a skill's shell file, and an import whose computed `base` is empty pins import's summary.
 */

const PIN_FILE = path.resolve(__dirname, "pins/profile-local-off.json");
const regen = process.env.REGEN_PINS === "1";

type Scenario = Awaited<ReturnType<typeof scenario>>;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

function normalize(value: unknown, roots: string[]): unknown {
  if (typeof value === "string") {
    let s = value;
    for (const r of roots) {
      s = s.split(r).join("<root>");
      s = s.split(r.replace(/\\/g, "/")).join("<root>");
      s = s.split(r.replace(/\//g, "\\")).join("<root>");
    }
    s = s.replace(/<root>[/\\]/g, "<root>/");
    s = s.replace(/(schema \d+, generated )\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/g, "$1<timestamp>");
    s = s.replace(/on \d{4}-\d{2}-\d{2}\./g, "on <date>.");
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, roots));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v, roots);
    return out;
  }
  return value;
}

async function setSchema(forgeRoot: string, schema: number): Promise<void> {
  await fs.writeFile(path.join(forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
}

const skill = (runSh: string, params?: Record<string, unknown>): IngredientSpec => ({
  meta: { type: "skill", name: "sk", layout: "dir", ...(params ? { params } : {}) },
  files: { "SKILL.md": "---\nname: sk\ndescription: A skill\n---\nRun it.\n", "run.sh": runSh },
});

/** The main Forge: what a workspace in sync gets today. */
async function acmeLocal(schema: number): Promise<Scenario> {
  const s = await scenario(
    {
      ingredients: [
        { meta: { type: "rule", name: "style" }, files: { "rule.md": "# Style\nWrite {{ 'X' | localize }} in templates.\n" } },
        skill("#!/bin/sh\n<!-- craftar:section greeting -->\necho hello\n<!-- /craftar:section -->\nV={{tags}}\n"),
      ],
      recipes: [recipe("core", ["rule/style", "skill/sk"]), { name: "unused", extends: ["nope"], ingredients: ["rule/ghost"] }],
      profiles: [profile("acme", ["core"], ["claude-code", "kiro", "agents-md"], { params: { tags: ["a", "b"] } })],
    },
    { config: { profile: "acme" } },
  );
  await setSchema(s.forgeRoot, schema);
  await writeFiles(s.forgeRoot, {
    "profiles/acme/ingredients/rules/x/ingredient.yaml": YAML.stringify({ type: "rule", name: "x" }),
    "profiles/acme/ingredients/rules/x/rule.md": "# X\n",
    "profiles/acme/recipes/acme-extra.yaml": YAML.stringify({ name: "acme-extra", ingredients: ["rule/x"] }),
  });
  return s;
}

/** A Forge whose skill's shell file alone cites a declared key with no value: the sync is refused today. */
async function acmeRefused(schema: number): Promise<Scenario> {
  const s = await scenario(
    {
      ingredients: [skill("#!/bin/sh\nT={{token}}\n", { token: { description: "a token" } })],
      recipes: [recipe("core", ["skill/sk"])],
      profiles: [profile("acme", ["core"], ["claude-code", "kiro"])],
    },
    { config: { profile: "acme" } },
  );
  await setSchema(s.forgeRoot, schema);
  return s;
}

async function roots(s: Scenario): Promise<string[]> {
  return [s.root, await fs.realpath(s.root)];
}

const emptyPath = async (s: Scenario) => {
  const dir = path.join(s.root, "no-docker");
  await fs.mkdir(dir, { recursive: true });
  return { PATH: dir, Path: dir };
};

const workspaceChecks = (stdout: string) =>
  (JSON.parse(stdout).checks as Array<{ id: string; scope: string; level: string; message: string; fix: string | null }>)
    .filter((c) => c.scope === "workspace")
    .map((c) => ({ id: c.id, level: c.level, message: c.message, fix: c.fix }));

async function observeInSync(s: Scenario) {
  const W = ["--workspace", s.wsRoot];
  const F = ["--forge", s.forgeRoot];
  const fresh = runCli(["status", "--json", ...W]);
  const sync = runCli(["sync", ...W]);
  const lock = JSON.parse(await fs.readFile(path.join(s.wsRoot, "craftar.lock"), "utf8"));
  delete lock.generatedAt;
  const files: Record<string, string> = {};
  for (const rel of [".claude/rules/style.md", ".claude/skills/sk/run.sh", ".kiro/skills/sk/run.sh", ".kiro/steering/style.md", "AGENTS.md"]) {
    files[rel] = await fs.readFile(path.join(s.wsRoot, rel), "utf8");
  }
  const doctor = runCli(["doctor", "--strict", "--json", ...W], { env: await emptyPath(s) });
  const out = {
    freshStatus: { code: fresh.code, json: JSON.parse(fresh.stdout) },
    sync: { code: sync.code, stdout: sync.stdout, stderr: sync.stderr },
    files,
    lock,
    syncCheck: runCli(["sync", "--check", ...W]).code,
    recipesForge: JSON.parse(runCli(["recipes", "--json", ...F]).stdout),
    recipesWorkspace: JSON.parse(runCli(["recipes", "--json", ...W]).stdout),
    ingredientsForge: JSON.parse(runCli(["ingredients", "--json", ...F]).stdout),
    ingredientsWorkspace: JSON.parse(runCli(["ingredients", "--json", ...W]).stdout),
    explainRule: runCli(["explain", ".claude/rules/style.md", ...W]).stdout,
    explainShell: runCli(["explain", ".claude/skills/sk/run.sh", ...W]).stdout,
    explainKiroShell: runCli(["explain", ".kiro/skills/sk/run.sh", ...W]).stdout,
    ls: runCli(["ls", ...W]).stdout,
    doctor: { code: doctor.code, checks: workspaceChecks(doctor.stdout) },
  };
  return normalize(out, await roots(s));
}

async function observeRefused(s: Scenario) {
  const W = ["--workspace", s.wsRoot];
  const sync = runCli(["sync", ...W]);
  const doctor = runCli(["doctor", "--json", ...W], { env: await emptyPath(s) });
  const out = {
    sync: { code: sync.code, stdout: sync.stdout, stderr: sync.stderr },
    syncCheck: runCli(["sync", "--check", ...W]).code,
    doctor: { code: doctor.code, checks: workspaceChecks(doctor.stdout) },
  };
  return normalize(out, await roots(s));
}

/** An import whose computed `base` is empty: the workspace holds one hand-written Kiro steering file only. */
async function observeImport(schema: number) {
  const s = await scenario({ profiles: [] }, { config: { profile: "acme" }, files: { ".claude/.keep": "", ".kiro/steering/notes.md": "# Notes\nKeep it short.\n" } });
  cleanups.push(s.cleanup);
  await setSchema(s.forgeRoot, schema);
  const r = runCli(["import", "--from", "claude-code", "--workspace", s.wsRoot, "--forge", s.forgeRoot, "--profile", "acme"]);
  const tree: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else tree[path.relative(s.forgeRoot, abs).replace(/\\/g, "/")] = await fs.readFile(abs, "utf8");
    }
  };
  await walk(s.forgeRoot);
  return normalize({ code: r.code, stdout: r.stdout, stderr: r.stderr, forge: Object.fromEntries(Object.entries(tree).sort()) }, await roots(s));
}

async function observeAll(schema: number) {
  return {
    inSync: await observeInSync(kept(await acmeLocal(schema))),
    refused: await observeRefused(kept(await acmeRefused(schema))),
    import: await observeImport(schema),
  };
}

/** §4.1's warning, the one change below the gate: taken out before the comparison, and asserted present. */
const IGNORED = /^ *(warn )?profiles\/acme\/(ingredients|recipes): ignored below schema 8$/;
let ignoredSeen = 0;
function withoutIgnored(value: unknown): unknown {
  if (typeof value === "string") {
    const lines = value.split("\n");
    const kept = lines.filter((l) => !IGNORED.test(l));
    ignoredSeen += lines.length - kept.length;
    return kept.join("\n");
  }
  if (Array.isArray(value)) {
    return value
      .filter((v) => {
        const hit = (typeof v === "string" && IGNORED.test(v)) || (v !== null && typeof v === "object" && typeof (v as { message?: unknown }).message === "string" && IGNORED.test((v as { message: string }).message));
        if (hit) ignoredSeen++;
        return !hit;
      })
      .map(withoutIgnored);
  }
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutIgnored(v)]));
  return value;
}

describe("profile-local=off baseline pin (spec 51 §10)", () => {
  it("a Forge at schema 7 with a profiles/<p>/ingredients folder, a broken unused recipe and a skill shell file", { timeout: 120_000 }, async () => {
    const observed = await observeAll(7);
    if (regen) {
      await fs.writeFile(PIN_FILE, JSON.stringify(observed, null, 2) + "\n");
      return;
    }
    ignoredSeen = 0;
    expect(withoutIgnored(observed)).toEqual(JSON.parse(await fs.readFile(PIN_FILE, "utf8")));
    // Since spec 51: the folder this Forge does not read is said, on every surface that warns.
    expect(ignoredSeen).toBeGreaterThan(0);
  });
});
