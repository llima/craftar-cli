import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listFiles } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";
import { git } from "./helpers/remote.js";

/** Spec 51 §5 and acceptance 6–7: `craftar forge localize` and `craftar forge share` end to end. */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

const spec: ForgeSpec = {
  ingredients: [rule("style", "# Style\n"), rule("x", "# X\n"), rule("v--acme", "# V for acme\n", { as: "v" })],
  recipes: [recipe("base", ["rule/style"]), recipe("stack-x", ["rule/x", "rule/v--acme"])],
  profiles: [profile("acme", ["base", "stack-x"], ["claude-code", "kiro", "agents-md"]), profile("globex", ["base"])],
};

async function setup(opts: { schema?: number; extra?: Record<string, string>; register?: boolean } = {}) {
  const root = await tmpDir("craftar-localize-cli-");
  roots.push(root);
  const forge = path.join(root, "forge");
  await makeForge(forge, spec);
  await fs.writeFile(path.join(forge, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: opts.schema ?? 8 }));
  if (opts.extra) await writeFiles(forge, opts.extra);
  git(forge, "init", "-q", "-b", "main");
  git(forge, "add", "-A");
  git(forge, "commit", "-q", "-m", "forge");
  const ws = path.join(root, "ws");
  await makeWorkspace(ws, forge, { config: { profile: "acme" } });
  if (opts.register !== false) {
    const r = runCli(["sync", "--workspace", ws]);
    expect(r.code, r.stderr).toBe(0);
  }
  return { root, forge, ws };
}

async function snapshot(dir: string, skip: (rel: string) => boolean = () => false): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await listFiles(dir)) {
    if (f.startsWith(".git/") || skip(f) || !(await fs.lstat(path.join(dir, f))).isFile()) continue;
    out[f] = await fs.readFile(path.join(dir, f), "utf8");
  }
  return out;
}

const lockOf = async (ws: string) => JSON.parse(await fs.readFile(path.join(ws, "craftar.lock"), "utf8"));

/** Acceptance 6 and 7: after the move and a commit, `sync` leaves every file unchanged; the lock moves only where it must. */
async function syncAfterMove(s: { forge: string; ws: string }) {
  git(s.forge, "add", "-A");
  git(s.forge, "commit", "-q", "-m", "move");
  const filesBefore = await snapshot(s.ws, (f) => f === "craftar.lock");
  const lockBefore = await lockOf(s.ws);
  expect(runCli(["sync", "--check", "--workspace", s.ws]).code).toBe(0);
  const st = JSON.parse(runCli(["status", "--json", "--workspace", s.ws]).stdout);
  expect(st.statuses.length).toBeGreaterThan(0);
  expect(st.statuses.filter((f: { state: string }) => f.state !== "unchanged")).toEqual([]);
  const r = runCli(["sync", "--workspace", s.ws]);
  expect(r.code, r.stderr).toBe(0);
  expect(await snapshot(s.ws, (f) => f === "craftar.lock")).toEqual(filesBefore);
  return { lockBefore, lockAfter: await lockOf(s.ws) };
}

describe("craftar forge localize (spec 51 §5.1)", () => {
  it("acceptance 6: localize then sync — every file unchanged, the lock changed only in forge.commit and a renamed variant's ingredient", async () => {
    const s = await setup();
    const r = runCli(["forge", "localize", "rule/x", "--profile", "acme", "--forge", s.forge, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(Object.keys(out)).toEqual(["ref", "profile", "dryRun", "moved", "recipes", "impact", "warnings"]);
    expect(out).toMatchObject({ ref: "rule/x", profile: "acme", dryRun: false, moved: { from: "ingredients/rules/x", to: "profiles/acme/ingredients/rules/x" } });
    expect(out.recipes).toEqual([{ name: "stack-x", from: "recipes/stack-x.yaml", to: "profiles/acme/recipes/stack-x.yaml" }]);
    expect(out.impact).toHaveLength(1);
    expect(out.impact[0].state).toBe("no-effect");

    // Then the base-less variant, which is renamed: its lock entries follow the new ref.
    git(s.forge, "add", "-A");
    git(s.forge, "commit", "-q", "-m", "localize rule/x");
    const v = runCli(["forge", "localize", "rule/v--acme", "--profile", "acme", "--forge", s.forge, "--json"]);
    expect(v.code, v.stderr).toBe(0);
    expect(JSON.parse(v.stdout).moved).toEqual({ from: "ingredients/rules/v--acme", to: "profiles/acme/ingredients/rules/v" });

    const { lockBefore, lockAfter } = await syncAfterMove(s);
    expect(lockAfter.forge.commit).not.toBe(lockBefore.forge.commit);
    const strip = (l: { files: Array<{ path: string; ingredient: string }> }) => l.files.map((f) => ({ ...f, ingredient: f.ingredient === "rule/v--acme" ? "rule/v" : f.ingredient }));
    expect(strip(lockAfter)).toEqual(strip(lockBefore));
    expect(lockAfter.files.filter((f: { ingredient: string }) => f.ingredient === "rule/v").length).toBeGreaterThan(0);
    expect({ ...lockAfter, files: null, forge: { ...lockAfter.forge, commit: null }, generatedAt: null }).toEqual({ ...lockBefore, files: null, forge: { ...lockBefore.forge, commit: null }, generatedAt: null });
  });

  it("the text form names what moved", async () => {
    const s = await setup();
    const r = runCli(["forge", "localize", "rule/x", "--profile", "acme", "--forge", s.forge]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("craftar forge localize rule/x → profile acme");
    expect(r.stdout).toContain("moved    ingredients/rules/x → profiles/acme/ingredients/rules/x");
    expect(r.stdout).toContain("recipe   stack-x: recipes/stack-x.yaml → profiles/acme/recipes/stack-x.yaml");
  });

  it("--dry-run proves and writes nothing, exit 0, impact []", async () => {
    const s = await setup();
    const before = await snapshot(s.forge);
    const r = runCli(["forge", "localize", "rule/x", "--profile", "acme", "--forge", s.forge, "--dry-run", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ dryRun: true, impact: [] });
    expect(await snapshot(s.forge)).toEqual(before);
  });

  it("refuses a dirty Forge, a Forge below schema 8 and a Forge no workspace is registered for, exit 1 and nothing written", async () => {
    const dirty = await setup();
    await fs.writeFile(path.join(dirty.forge, "ingredients/rules/x/rule.md"), "# X, edited\n");
    const d = runCli(["forge", "localize", "rule/x", "--profile", "acme", "--forge", dirty.forge]);
    expect(d.code).toBe(1);
    expect(d.stderr).toContain("is not a clean git checkout");

    const old = await setup({ schema: 7 });
    const o = runCli(["forge", "localize", "rule/x", "--profile", "acme", "--forge", old.forge]);
    expect(o.code).toBe(1);
    expect(o.stderr).toContain("forge localize: the Forge is at schema 7 — profile-local ingredients need schema 8");

    const lone = await setup({ register: false });
    const before = await snapshot(lone.forge);
    const n = runCli(["forge", "localize", "rule/x", "--profile", "acme", "--forge", lone.forge]);
    expect(n.code).toBe(1);
    expect(n.stderr).toContain("forge localize: no workspace of this Forge is registered on this machine — the move is proved against every registered workspace");
    expect(await snapshot(lone.forge)).toEqual(before);
  });

  it("a refusal of the proof exits 1 with the Forge untouched", async () => {
    const s = await setup();
    await fs.writeFile(path.join(s.ws, "craftar.yaml"), YAML.stringify({ forge: path.relative(s.ws, s.forge), profile: "acme", overrides: { ingredients: { disable: ["rule/v--acme"] } } }));
    expect(runCli(["sync", "--workspace", s.ws]).code).toBe(0);
    const before = await snapshot(s.forge);
    const r = runCli(["forge", "localize", "rule/v--acme", "--profile", "acme", "--forge", s.forge]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("would not plan the same after the move");
    expect(await snapshot(s.forge)).toEqual(before);
  });
});

describe("craftar forge share (spec 51 §5.2)", () => {
  it("acceptance 7: share then sync — every file unchanged, the lock changed only in forge.commit", async () => {
    const s = await setup({
      extra: {
        "profiles/acme/ingredients/rules/y/ingredient.yaml": YAML.stringify({ type: "rule", name: "y" }),
        "profiles/acme/ingredients/rules/y/rule.md": "# Y\n",
        "profiles/acme/recipes/acme-extra.yaml": YAML.stringify({ name: "acme-extra", ingredients: ["rule/y"] }),
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base", "stack-x", "acme-extra"], targets: ["claude-code", "kiro", "agents-md"] }),
      },
    });
    const r = runCli(["forge", "share", "rule/y", "--profile", "acme", "--forge", s.forge, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(Object.keys(out)).toEqual(["ref", "profile", "dryRun", "moved", "recipes", "impact", "warnings"]);
    expect(out).toMatchObject({ moved: { from: "profiles/acme/ingredients/rules/y", to: "ingredients/rules/y" }, recipes: [] });
    const { lockBefore, lockAfter } = await syncAfterMove(s);
    expect(lockAfter.files).toEqual(lockBefore.files);
    expect(lockAfter.forge.commit).not.toBe(lockBefore.forge.commit);
  });
});
