import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { exists, listFiles, loadForge } from "../src/core/forge.js";
import { applyBasePromotion, planBasePromotion, proveBasePromotion, type BasePromotion } from "../src/core/promote.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import type { WriteJournal } from "../src/core/unify.js";
import { listVariants } from "../src/core/variants.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";
import { git } from "./helpers/remote.js";

// Spec 29 §4.4 — forge promote: the edit set (P1, P3–P6), the slot proof (P7) and the writes.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// A temp root of this file's own: the proof's scratch directories are counted, and another test file may be proving
// a promotion at the same moment.
const TEMP_VARS = ["TMPDIR", "TEMP", "TMP"] as const;
const ambient = Object.fromEntries(TEMP_VARS.map((k) => [k, process.env[k]]));
let ownTemp = "";
beforeAll(async () => {
  ownTemp = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-basepromo-tmp-"));
  for (const k of TEMP_VARS) process.env[k] = ownTemp;
});
afterAll(async () => {
  for (const k of TEMP_VARS) {
    if (ambient[k] === undefined) delete process.env[k];
    else process.env[k] = ambient[k];
  }
  await fs.rm(ownTemp, { recursive: true, force: true });
});

const variant = (name: string, of: string, body: string, extra: Record<string, unknown> = {}) => rule(name, body, { as: of, ...extra });
const THREE: ForgeSpec = {
  ingredients: [rule("workflow", "base text\n"), variant("workflow--acme", "workflow", "acme text\n"), rule("style", "style\n")],
  recipes: [recipe("base", ["rule/workflow", "rule/style"]), recipe("base--acme", ["rule/workflow--acme", "rule/style"])],
  profiles: [profile("acme", ["base--acme"], ["claude-code", "kiro"]), profile("globex", ["base"]), profile("initech", ["base"], ["claude-code", "kiro"])],
};

async function forgeOf(spec: ForgeSpec, extra: Record<string, string | Buffer> = {}) {
  const root = await tmpDir("craftar-basepromo-test-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "forge");
  await makeForge(dir, spec);
  await writeFiles(dir, extra);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "forge");
  return { root, dir };
}
/** Every file of the Forge, `.git` aside, as bytes in hex — two snapshots compare with `toEqual`. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await listFiles(dir)) if (!f.startsWith(".git/")) out[f] = (await fs.readFile(path.join(dir, f))).toString("hex");
  return out;
}
const rel = (dir: string, abs: string) => path.relative(dir, abs).split(path.sep).join("/");
const written = (dir: string, p: BasePromotion) => Object.fromEntries(p.writes.map((w) => [rel(dir, w.abs), w.content]));
const text = (v: string | Buffer) => (typeof v === "string" ? v : v.toString("utf8"));
const scratchDirs = async () => (await fs.readdir(os.tmpdir())).filter((d) => d.startsWith("craftar-forge-promote-"));
/** Plan a promotion and assert the Forge was only read. */
async function planned(f: { dir: string }, ref = "rule/workflow", p = "acme") {
  const before = await snapshot(f.dir);
  const promotion = await planBasePromotion(await loadForge(f.dir), ref, p);
  expect(await snapshot(f.dir)).toEqual(before);
  expect(git(f.dir, "status", "--porcelain")).toBe("");
  return promotion;
}
async function refusal(f: { dir: string }, ref: string, p: string): Promise<string> {
  const before = await snapshot(f.dir);
  const message = await planBasePromotion(await loadForge(f.dir), ref, p).then(
    () => "no refusal",
    (e: Error) => e.message,
  );
  expect(await snapshot(f.dir)).toEqual(before);
  return message;
}

describe("planBasePromotion — the edit set", () => {
  it("1. three profiles: the base takes the variant, each other profile gets the old base and an owned recipe", async () => {
    const f = await forgeOf(THREE);
    const p = await planned(f);
    expect({ base: p.base, profile: p.profile, removed: p.removed, created: p.created, recipes: p.recipes, profiles: p.profiles, discarded: p.discarded, warnings: p.warnings }).toEqual({
      base: "rule/workflow",
      profile: "acme",
      removed: "rule/workflow--acme",
      created: ["rule/workflow--globex", "rule/workflow--initech"],
      recipes: { edited: ["base--acme"], created: [{ name: "base--globex", from: "base" }, { name: "base--initech", from: "base" }] },
      profiles: ["globex", "initech"],
      discarded: false,
      warnings: [],
    });
    const w = written(f.dir, p);
    expect(Object.keys(w)).toEqual([
      "ingredients/rules/workflow--globex/rule.md",
      "ingredients/rules/workflow--globex/ingredient.yaml",
      "ingredients/rules/workflow--initech/rule.md",
      "ingredients/rules/workflow--initech/ingredient.yaml",
      "ingredients/rules/workflow/rule.md",
      "ingredients/rules/workflow/ingredient.yaml",
      "recipes/base--globex.yaml",
      "recipes/base--initech.yaml",
      "recipes/base--acme.yaml",
      "profiles/globex/profile.yaml",
      "profiles/initech/profile.yaml",
    ]);
    for (const q of ["globex", "initech"]) {
      expect(text(w[`ingredients/rules/workflow--${q}/rule.md`])).toBe("base text\n");
      expect(YAML.parse(text(w[`ingredients/rules/workflow--${q}/ingredient.yaml`]))).toEqual({ type: "rule", name: `workflow--${q}`, as: "workflow" });
      expect(YAML.parse(text(w[`recipes/base--${q}.yaml`]))).toEqual({ name: `base--${q}`, ingredients: [`rule/workflow--${q}`, "rule/style"] });
      expect(YAML.parse(text(w[`profiles/${q}/profile.yaml`])).recipes).toEqual([`base--${q}`]);
    }
    expect(text(w["ingredients/rules/workflow/rule.md"])).toBe("acme text\n");
    const baseMeta = YAML.parse(text(w["ingredients/rules/workflow/ingredient.yaml"]));
    expect(baseMeta).toEqual({ type: "rule", name: "workflow" });
    expect(Object.hasOwn(baseMeta, "as")).toBe(false);
    expect(YAML.parse(text(w["recipes/base--acme.yaml"])).ingredients).toEqual(["rule/workflow", "rule/style"]);
    expect(p.removes.map((a) => rel(f.dir, a))).toEqual(["ingredients/rules/workflow--acme/ingredient.yaml", "ingredients/rules/workflow--acme/rule.md"]);
    expect(Object.fromEntries(p.writes.map((x) => [rel(f.dir, x.abs), x.created]))).toMatchObject({
      "ingredients/rules/workflow--globex/rule.md": true,
      "ingredients/rules/workflow/rule.md": false,
      "recipes/base--globex.yaml": true,
      "recipes/base--acme.yaml": false,
      "profiles/globex/profile.yaml": false,
    });
    expect(p.mustHold.map((a) => rel(f.dir, a)).sort()).toEqual([
      "ingredients/rules/workflow--acme/ingredient.yaml",
      "ingredients/rules/workflow--acme/rule.md",
      "ingredients/rules/workflow/ingredient.yaml",
      "ingredients/rules/workflow/rule.md",
      "profiles/globex/profile.yaml",
      "profiles/initech/profile.yaml",
      "recipes/base--acme.yaml",
    ]);
    // The shared recipe is never edited.
    expect([...Object.keys(w), ...p.removes.map((a) => rel(f.dir, a))]).not.toContain("recipes/base.yaml");
  });

  it("2. a lone profile on the shared recipe still gets its own copy", async () => {
    const f = await forgeOf({ ...THREE, profiles: THREE.profiles!.filter((x) => x.name !== "initech") });
    const p = await planned(f);
    expect(p.created).toEqual(["rule/workflow--globex"]);
    expect(p.recipes.created).toEqual([{ name: "base--globex", from: "base" }]);
    expect(p.profiles).toEqual(["globex"]);
  });

  it("3. a recipe the other profile owns by name is edited in place — <recipe>--<q> and <q>-steering", async () => {
    const owned = await forgeOf({
      ...THREE,
      recipes: [...THREE.recipes!.filter((r) => r.name !== "base"), recipe("base--globex", ["rule/workflow", "rule/style"])],
      profiles: [profile("acme", ["base--acme"]), profile("globex", ["base--globex"])],
    });
    const p = await planned(owned);
    expect(p.recipes).toEqual({ edited: ["base--acme", "base--globex"], created: [] });
    expect(p.profiles).toEqual([]);
    expect(YAML.parse(text(written(owned.dir, p)["recipes/base--globex.yaml"])).ingredients).toEqual(["rule/workflow--globex", "rule/style"]);

    const steering = await forgeOf({
      ingredients: [
        { meta: { type: "steering", name: "team", file: "steering.md" }, files: { "steering.md": "team\n" } },
        { meta: { type: "steering", name: "team--acme", as: "team", file: "steering.md" }, files: { "steering.md": "acme team\n" } },
      ],
      recipes: [recipe("acme-steering", ["steering/team--acme"]), recipe("globex-steering", ["steering/team"])],
      profiles: [profile("acme", ["acme-steering"], ["kiro"]), profile("globex", ["globex-steering"], ["kiro"])],
    });
    const s = await planned(steering, "steering/team", "acme");
    expect(s.recipes).toEqual({ edited: ["acme-steering", "globex-steering"], created: [] });
    expect(s.created).toEqual(["steering/team--globex"]);
    expect(Object.keys(written(steering.dir, s))).toContain("ingredients/steerings/team--globex/steering.md");
  });

  it("4. no other profile resolves the base: nothing is created and the old base is discarded", async () => {
    const f = await forgeOf({ ...THREE, profiles: [profile("acme", ["base--acme"])] });
    const p = await planned(f);
    expect(p.created).toEqual([]);
    expect(p.discarded).toBe(true);
    expect(p.recipes).toEqual({ edited: ["base--acme"], created: [] });
    expect(Object.keys(written(f.dir, p))).toEqual(["ingredients/rules/workflow/rule.md", "ingredients/rules/workflow/ingredient.yaml", "recipes/base--acme.yaml"]);
  });

  it("5. files travel as raw bytes: not valid UTF-8, CRLF, and a file only one side has", async () => {
    const binary = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0d, 0x0a]);
    const other = Buffer.from([0x00, 0xff, 0x0a]);
    const f = await forgeOf(THREE, {
      "ingredients/rules/workflow/rule.md": binary,
      "ingredients/rules/workflow/only-base.txt": "left behind\r\n",
      "ingredients/rules/workflow--acme/rule.md": other,
      "ingredients/rules/workflow--acme/notes/only-variant.txt": "comes along\r\n",
    });
    const p = await planned(f);
    const w = written(f.dir, p);
    expect((w["ingredients/rules/workflow--globex/rule.md"] as Buffer).equals(binary)).toBe(true);
    expect(text(w["ingredients/rules/workflow--globex/only-base.txt"])).toBe("left behind\r\n");
    expect((w["ingredients/rules/workflow/rule.md"] as Buffer).equals(other)).toBe(true);
    expect(text(w["ingredients/rules/workflow/notes/only-variant.txt"])).toBe("comes along\r\n");
    expect(p.writes.find((x) => x.abs.endsWith(path.join("workflow", "notes", "only-variant.txt")))!.created).toBe(true);
    // The base's file the variant does not have is removed, and git must hold it.
    expect(p.removes.map((a) => rel(f.dir, a))).toContain("ingredients/rules/workflow/only-base.txt");
    expect(p.mustHold.map((a) => rel(f.dir, a))).toContain("ingredients/rules/workflow/only-base.txt");
  });

  it("6. a copied recipe keeps its slot, params, extends and comments: only the name and the one entry change", async () => {
    const source = "# the shared base\nname: base\nslot: core\nextends: []\nparams:\n  org:\n    default: acme-org # kept\ningredients:\n  - rule/workflow # the rule\n  - rule/style\n";
    const f = await forgeOf(THREE, { "recipes/base.yaml": source });
    const p = await planned(f);
    expect(text(written(f.dir, p)["recipes/base--globex.yaml"])).toBe(source.replace("name: base\n", "name: base--globex\n").replace("- rule/workflow #", "- rule/workflow--globex #"));
  });

  it("7. a profile on two shared recipes naming the base gets one profile edit holding both", async () => {
    const f = await forgeOf({
      ...THREE,
      recipes: [...THREE.recipes!, recipe("extra", ["rule/workflow"])],
      profiles: [profile("acme", ["base--acme"]), profile("globex", ["base", "extra"])],
    });
    const p = await planned(f);
    expect(p.recipes.created).toEqual([{ name: "base--globex", from: "base" }, { name: "extra--globex", from: "extra" }]);
    const profileWrites = p.writes.filter((x) => x.abs.endsWith("profile.yaml"));
    expect(profileWrites).toHaveLength(1);
    expect(YAML.parse(text(profileWrites[0].content)).recipes).toEqual(["base--globex", "extra--globex"]);
    expect(p.detail.profiles).toEqual([{ profile: "globex", file: "profiles/globex/profile.yaml", swaps: [{ old: "base", new: "base--globex" }, { old: "extra", new: "extra--globex" }] }]);
  });

  it("8. P1, P3, P4, P5 and P6 — each by its whole message, the Forge untouched", async () => {
    const f = await forgeOf(THREE);
    expect(await refusal(f, "rule/nowhere", "acme")).toBe("forge promote: rule/nowhere is not an ingredient of this Forge");
    expect(await refusal(f, "rule/workflow", "globex")).toBe("forge promote: rule/workflow has no variant for profile globex");
    expect(await refusal(f, "rule/workflow--acme", "acme")).toBe("forge promote: rule/workflow--acme is a variant — name its base, rule/workflow, with --profile");

    const p3 = "forge promote: rule/workflow--globex already exists, and profile globex also resolves rule/workflow — the Forge is inconsistent (both would write one file); remove one by hand, commit, and re-run";
    expect(await refusal(await forgeOf({ ...THREE, ingredients: [...THREE.ingredients!, variant("workflow--globex", "workflow", "stale\n")] }), "rule/workflow", "acme")).toBe(p3);
    expect(await refusal(await forgeOf(THREE, { "ingredients/rules/workflow--globex/rule.md": "no ingredient.yaml here\n" }), "rule/workflow", "acme")).toBe(p3);

    expect(await refusal(await forgeOf({ ...THREE, recipes: [...THREE.recipes!, recipe("base--globex", ["rule/style"])] }), "rule/workflow", "acme")).toBe(
      "forge promote: recipe base--globex already exists — promote would create it for profile globex from base; remove or rename it by hand, commit, and re-run",
    );

    const chained = await forgeOf({ ...THREE, recipes: [...THREE.recipes!, recipe("wide", [], { extends: ["base"] })], profiles: [profile("acme", ["base--acme"]), profile("globex", ["wide"])] });
    expect(await refusal(chained, "rule/workflow", "acme")).toBe(
      "forge promote: profile globex reaches recipe base (which names rule/workflow) through wide → base — promote would have to copy that chain; edit the Forge by hand",
    );

    const misnamed = await forgeOf({ ...THREE, recipes: THREE.recipes!.filter((r) => r.name !== "base") }, { "recipes/core.yaml": YAML.stringify(recipe("base", ["rule/workflow", "rule/style"])) });
    expect(await refusal(misnamed, "rule/workflow", "acme")).toBe("forge promote: recipe base is recipes/core.yaml — forge promote writes recipes/base.yaml");
  });

  it("8b. a profile that resolves the base and its own variant, and a recipe naming both, are refused as inconsistent", async () => {
    const both = await forgeOf({ ...THREE, profiles: [profile("acme", ["base--acme", "base"]), profile("globex", ["base"])] });
    expect(await refusal(both, "rule/workflow", "acme")).toBe(
      "forge promote: profile acme resolves rule/workflow itself — the Forge is inconsistent (it would write one file from two ingredients); remove one from its recipes by hand, commit, and re-run",
    );
    const one = await forgeOf({ ...THREE, recipes: [...THREE.recipes!, recipe("mixed", ["rule/workflow", "rule/workflow--acme"])] });
    expect(await refusal(one, "rule/workflow", "acme")).toBe(
      "forge promote: recipe mixed names both rule/workflow and rule/workflow--acme — the Forge is inconsistent (both would write one file); remove one by hand, commit, and re-run",
    );
  });

  it("9. a profile that does not resolve today is warned about, neither given a variant nor refused", async () => {
    const f = await forgeOf({ ...THREE, profiles: [...THREE.profiles!, profile("umbrella", ["base", "missing"])] });
    const p = await planned(f);
    expect(p.created).toEqual(["rule/workflow--globex", "rule/workflow--initech"]);
    expect(p.warnings).toEqual(['profile umbrella does not resolve today (recipe "missing" not found (referenced by profile umbrella)) — promote could not check it']);
  });

  it("10. a recipe whose entry the edit cannot land in is refused by name, never reported as edited", async () => {
    const aliased = "name: base--acme\nshared: &list\n  - rule/workflow--acme\n  - rule/style\ningredients: *list\n";
    expect(await refusal(await forgeOf(THREE, { "recipes/base--acme.yaml": aliased }), "rule/workflow", "acme")).toBe(
      "forge promote: cannot edit recipes/base--acme.yaml in place (ingredients is an alias) — expand it by hand, commit, and re-run",
    );
    // An entry that is itself an alias: the edit finds no scalar to replace, and the read-back says so.
    const entryAlias = "name: base--acme\ndescription: &ref rule/workflow--acme\ningredients:\n  - *ref\n  - rule/style\n";
    expect(await refusal(await forgeOf(THREE, { "recipes/base--acme.yaml": entryAlias }), "rule/workflow", "acme")).toBe(
      "forge promote: cannot edit recipes/base--acme.yaml in place (the edit does not read back as exactly rule/workflow--acme replaced by rule/workflow) — reformat it by hand, commit, and re-run",
    );
  });
});

/** One workspace per profile beside the Forge; returns each one's planned files as path → bytes. */
async function plansOf(f: { root: string; dir: string }, profiles: string[]) {
  const out: Record<string, Record<string, Buffer>> = {};
  for (const q of profiles) {
    const ws = path.join(f.root, `${q}-portal`);
    if (!(await exists(ws))) await makeWorkspace(ws, f.dir, { config: { profile: q } });
    const p = await plan(await loadWorkspace(ws));
    out[q] = Object.fromEntries(p.files.map((x) => [x.path, x.content]));
  }
  return out;
}
function sameBytes(a: Record<string, Buffer>, b: Record<string, Buffer>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => b[k] !== undefined && a[k].equals(b[k]));
}

describe("proveBasePromotion and applyBasePromotion", () => {
  it("11. the proof passes for a sound edit set, leaves no scratch directory and reads the Forge only", async () => {
    for (const spec of [THREE, { ...THREE, profiles: [profile("acme", ["base--acme"])] }]) {
      const f = await forgeOf(spec);
      const p = await planned(f);
      const before = await snapshot(f.dir);
      const scratch = await scratchDirs();
      await expect(proveBasePromotion(await loadForge(f.dir), p)).resolves.toBeUndefined();
      expect(await snapshot(f.dir)).toEqual(before);
      expect(await scratchDirs()).toEqual(scratch);
    }
  });

  it("12. every workspace plans the same paths and the same bytes before and after — and a recipe put back by hand does not", async () => {
    const f = await forgeOf(THREE);
    const profiles = ["acme", "globex", "initech"];
    const before = await plansOf(f, profiles);
    expect(Object.keys(before.acme).length).toBeGreaterThan(2);
    // The three do not all plan the same text: the promotion has something to preserve.
    expect(sameBytes(before.acme, before.initech)).toBe(false);
    const p = await planned(f);
    await proveBasePromotion(await loadForge(f.dir), p);
    await applyBasePromotion(p, []);
    const after = await plansOf(f, profiles);
    for (const q of profiles) expect(sameBytes(before[q], after[q]), q).toBe(true);
    // Negative control: globex's owned recipe pointed back at the base — which now holds acme's text.
    const file = path.join(f.dir, "recipes/base--globex.yaml");
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("rule/workflow--globex", "rule/workflow"));
    expect(sameBytes(before.globex, (await plansOf(f, ["globex"])).globex)).toBe(false);
  });

  it("13. P7 names the profile and what would differ — an owned recipe another profile resolves, and three tampered edit sets", async () => {
    // (a) base--globex is globex's by name, and initech resolves it too.
    const shared = await forgeOf({
      ...THREE,
      recipes: [...THREE.recipes!.filter((r) => r.name !== "base"), recipe("base--globex", ["rule/workflow", "rule/style"])],
      profiles: [profile("acme", ["base--acme"]), profile("globex", ["base--globex"]), profile("initech", ["base--globex"])],
    });
    const a = await planned(shared);
    await expect(proveBasePromotion(await loadForge(shared.dir), a)).rejects.toThrow(
      "forge promote: profile initech would not resolve the same after the promotion — its ingredients differ at position 1 (rule/workflow--globex ≠ rule/workflow--initech); nothing written",
    );

    const f = await forgeOf(THREE);
    const forge = await loadForge(f.dir);
    const sound = await planned(f);
    const tamper = (change: (w: BasePromotion["writes"][number]) => BasePromotion["writes"][number] | null): BasePromotion => ({
      ...sound,
      writes: sound.writes.map(change).filter((w): w is BasePromotion["writes"][number] => w !== null),
    });
    // (b) globex's profile edit dropped: it still resolves the shared recipe, so the base's new text.
    await expect(proveBasePromotion(forge, tamper((w) => (rel(f.dir, w.abs) === "profiles/globex/profile.yaml" ? null : w)))).rejects.toThrow(
      "forge promote: profile globex would not resolve the same after the promotion — its ingredients differ at position 1 (rule/workflow ≠ rule/workflow--globex); nothing written",
    );
    // (c) a created recipe that gains a slot the one it replaces does not have.
    await expect(
      proveBasePromotion(forge, tamper((w) => (rel(f.dir, w.abs) === "recipes/base--initech.yaml" ? { ...w, content: text(w.content) + "slot: core\n" } : w))),
    ).rejects.toThrow("forge promote: profile initech would not resolve the same after the promotion — recipe base--initech changes slot; nothing written");
    // (d) the old base's copy holding another byte.
    await expect(
      proveBasePromotion(forge, tamper((w) => (rel(f.dir, w.abs) === "ingredients/rules/workflow--globex/rule.md" ? { ...w, content: Buffer.from("base text!\n") } : w))),
    ).rejects.toThrow("forge promote: profile globex would not resolve the same after the promotion — rule/workflow--globex would not hold the same files; nothing written");
    // (e) the order of a copied recipe's entries.
    await expect(
      proveBasePromotion(forge, tamper((w) => (rel(f.dir, w.abs) === "recipes/base--globex.yaml" ? { ...w, content: "name: base--globex\ningredients:\n  - rule/style\n  - rule/workflow--globex\n" } : w))),
    ).rejects.toThrow("forge promote: profile globex would not resolve the same after the promotion — its ingredients differ at position 1 (rule/style ≠ rule/workflow--globex); nothing written");
    expect(git(f.dir, "status", "--porcelain")).toBe("");
    expect(await scratchDirs()).toEqual([]);
  });

  it("14. the writes: exactly the expected paths change, the variant's directory is gone, and the old base shows as two variants", async () => {
    const f = await forgeOf(THREE, { "ingredients/rules/workflow/nested/only-base.txt": "left\n" });
    const p = await planned(f);
    const journal: WriteJournal = [];
    await applyBasePromotion(p, journal);
    expect(git(f.dir, "status", "--porcelain", "--untracked-files=all").split("\n").map((l) => l.trim()).sort()).toEqual([
      "?? ingredients/rules/workflow--globex/ingredient.yaml",
      "?? ingredients/rules/workflow--globex/nested/only-base.txt",
      "?? ingredients/rules/workflow--globex/rule.md",
      "?? ingredients/rules/workflow--initech/ingredient.yaml",
      "?? ingredients/rules/workflow--initech/nested/only-base.txt",
      "?? ingredients/rules/workflow--initech/rule.md",
      "?? recipes/base--globex.yaml",
      "?? recipes/base--initech.yaml",
      "D ingredients/rules/workflow--acme/ingredient.yaml",
      "D ingredients/rules/workflow--acme/rule.md",
      "D ingredients/rules/workflow/nested/only-base.txt",
      "M ingredients/rules/workflow/rule.md",
      "M profiles/globex/profile.yaml",
      "M profiles/initech/profile.yaml",
      "M recipes/base--acme.yaml",
    ]);
    // The base's ingredient.yaml is written too, with the bytes it already had: the variant's, `name` set and `as` removed.
    expect(await exists(path.join(f.dir, "ingredients/rules/workflow--acme"))).toBe(false);
    expect(await exists(path.join(f.dir, "ingredients/rules/workflow/nested"))).toBe(false);
    expect(await exists(path.join(f.dir, "ingredients/rules/workflow"))).toBe(true);
    expect(journal.map((j) => rel(f.dir, j.abs)).sort()).toEqual([...p.writes.map((w) => rel(f.dir, w.abs)), ...p.removes.map((a) => rel(f.dir, a))].sort());
    const after = await loadForge(f.dir);
    const report = await listVariants(after);
    expect(report.groups.map((g) => [g.base, g.variants.map((v) => v.profile).sort()])).toEqual([["rule/workflow", ["globex", "initech"]]]);
    expect(report.orphans).toEqual([]);
    await expect(planBasePromotion(after, "rule/workflow", "acme")).rejects.toThrow("forge promote: rule/workflow has no variant for profile acme");
  });

  it("15. a write that fails midway leaves a journal naming what was already written", async () => {
    const f = await forgeOf(THREE);
    const p = await planned(f);
    // A directory where the first new recipe must be written: that write fails, after every ingredient file landed.
    await fs.mkdir(path.join(f.dir, "recipes/base--globex.yaml"));
    const journal: WriteJournal = [];
    await expect(applyBasePromotion(p, journal)).rejects.toThrow();
    expect(journal.map((j) => [rel(f.dir, j.abs), j.created])).toEqual([
      ["ingredients/rules/workflow--globex/rule.md", true],
      ["ingredients/rules/workflow--globex/ingredient.yaml", true],
      ["ingredients/rules/workflow--initech/rule.md", true],
      ["ingredients/rules/workflow--initech/ingredient.yaml", true],
      ["ingredients/rules/workflow/rule.md", false],
      ["ingredients/rules/workflow/ingredient.yaml", false],
      ["recipes/base--globex.yaml", false],
    ]);
    // Nothing after the failed write was touched: no profile, no edited recipe, and the variant is still there.
    expect(git(f.dir, "status", "--porcelain", "profiles", "recipes/base--acme.yaml", "ingredients/rules/workflow--acme")).toBe("");
  });

  it("16. nothing is written through a link: a linked ingredient directory refuses the plan", async () => {
    const f = await forgeOf(THREE);
    const elsewhere = path.join(f.root, "elsewhere");
    await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, path.join(f.dir, "ingredients/rules/workflow--globex"), "junction");
    const message = await planBasePromotion(await loadForge(f.dir), "rule/workflow", "acme").then(() => "no refusal", (e: Error) => e.message);
    expect(message).toContain("is a symbolic link to a directory");
    expect(message).toContain("workflow--globex");
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });

  // Root ignores the read-only bit, so the scenario cannot fail there.
  it.skipIf(process.getuid?.() === 0)("17. a file the promotion must overwrite and cannot is refused by the proof, by its Forge path, with nothing written", async () => {
    const f = await forgeOf(THREE);
    const locked = path.join(f.dir, "profiles/initech/profile.yaml");
    cleanups.push(() => fs.chmod(locked, 0o644).catch(() => undefined));
    await fs.chmod(locked, 0o444);
    const p = await planned(f);
    await expect(proveBasePromotion(await loadForge(f.dir), p)).rejects.toThrow(
      /^forge promote: profiles\/initech\/profile\.yaml could not be written on the scratch copy the edit is proved on \((EACCES|EPERM)\) — it cannot be written in the Forge either; nothing written$/,
    );
    expect(git(f.dir, "status", "--porcelain")).toBe("");
    expect(await scratchDirs()).toEqual([]);
  });

  it("18. a linked root directory is refused by the plan, and again by the writes — the link being the only thing wrong", async () => {
    const swap = async (f: { root: string; dir: string }) => {
      // The recipes directory moved out and linked back: every file still reads, and a write would land outside the Forge.
      const outside = path.join(f.root, "recipes-elsewhere");
      await fs.rename(path.join(f.dir, "recipes"), outside);
      await fs.symlink(outside, path.join(f.dir, "recipes"), "junction");
      return outside;
    };
    const message = "recipes is a symbolic link in the Forge — promote does not read a linked recipes, ingredients or profiles directory; replace it with the directory and commit";
    const atPlan = await forgeOf(THREE);
    const outside = await swap(atPlan);
    const before = await fs.readFile(path.join(outside, "base--acme.yaml"), "utf8");
    await expect(planBasePromotion(await loadForge(atPlan.dir), "rule/workflow", "acme")).rejects.toThrow(message);

    const atApply = await forgeOf(THREE);
    const p = await planned(atApply);
    const elsewhere = await swap(atApply);
    const journal: WriteJournal = [];
    await expect(applyBasePromotion(p, journal)).rejects.toThrow(message);
    expect(journal).toEqual([]);
    expect(await fs.readFile(path.join(elsewhere, "base--acme.yaml"), "utf8")).toBe(before);
    expect(await exists(path.join(atApply.dir, "ingredients/rules/workflow--globex"))).toBe(false);
  });

  it("19. an empty directory where a variant would go is no ingredient: the plan passes and the writes land", async () => {
    const f = await forgeOf(THREE);
    await fs.mkdir(path.join(f.dir, "ingredients/rules/workflow--globex/notes"), { recursive: true });
    const p = await planBasePromotion(await loadForge(f.dir), "rule/workflow", "acme");
    await applyBasePromotion(p, []);
    expect(await fs.readFile(path.join(f.dir, "ingredients/rules/workflow--globex/rule.md"), "utf8")).toBe("base text\n");
  });
});
