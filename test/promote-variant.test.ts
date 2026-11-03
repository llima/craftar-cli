import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadForge } from "../src/core/forge.js";
import { forgeWorkspaces } from "../src/core/impact.js";
import { applyMove, planLocalize, proveMove } from "../src/core/localize.js";
import { applyBasePromotion, planBasePromotion, proveBasePromotion } from "../src/core/promote.js";
import type { IngredientRef } from "../src/schema/index.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe } from "./helpers/forge.js";
import { git } from "./helpers/remote.js";
import { build, bytesOf, CASE1, CASE2, planFor } from "./helpers/local-override.js";

/** Spec 56 §5.2: `forge promote <base> --variant <ref>` — a variant shared by several profiles becomes the base. */

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true });
});

const home = () => process.env.CRAFTAR_HOME!;
const all = ["acme", "globex", "initech"];
const workspaces = all.map((name) => ({ name, config: { profile: name } }));

describe("forge promote --variant (spec 56 §5.2)", () => {
  it("case 1 end to end: promote --variant rule/x-shared, then localize rule/x--acme — every profile plans the same bytes", async () => {
    const s = await build(cleanups, CASE1, { workspaces });
    const before = Object.fromEntries(await Promise.all(all.map(async (p) => [p, bytesOf(await planFor(s.root, s.forge, p))])));

    let f = await loadForge(s.forge);
    const promo = await planBasePromotion(f, "rule/x", { variant: "rule/x-shared" });
    expect(promo.profile).toBeNull();
    expect(promo.removed).toBe("rule/x-shared");
    expect(promo.created).toEqual(["rule/x--acme"]);
    await proveBasePromotion(f, promo);
    await applyBasePromotion(promo, []);
    git(s.forge, "add", "-A");
    git(s.forge, "commit", "-q", "-m", "promote");

    f = await loadForge(s.forge);
    const move = await planLocalize(f, "rule/x--acme", "acme");
    await proveMove(f, move, (await forgeWorkspaces(home(), s.forge)).workspaces);
    await applyMove(move, []);

    f = await loadForge(s.forge);
    expect(f.ingredients.get("rule/x" as IngredientRef)!.dir).toBe(path.join(s.forge, "ingredients/rules/x"));
    expect(f.ingredients.has("rule/x-shared" as IngredientRef)).toBe(false);
    expect(f.ingredients.has("rule/x--acme" as IngredientRef)).toBe(false);
    expect(await fs.readFile(path.join(s.forge, "ingredients/rules/x/rule.md"), "utf8")).toBe("# X shared\n");
    expect(await fs.readFile(path.join(s.forge, "profiles/acme/ingredients/rules/x/rule.md"), "utf8")).toBe("# X for acme\n");
    for (const p of all) expect(bytesOf(await planFor(s.root, s.forge, p)), p).toEqual(before[p]);
    for (const p of all) expect(runCli(["sync", "--check", "--workspace", s.ws[p]]).code, p).toBe(0);
  });

  it("--variant <name>--<p> is the same run as --profile <p>", async () => {
    const s = await build(cleanups, CASE2, { git: false });
    const f = await loadForge(s.forge);
    const a = await planBasePromotion(f, "rule/y", "acme");
    const b = await planBasePromotion(f, "rule/y", { variant: "rule/y--acme" });
    expect(b).toEqual(a);
  });

  it("refuses a ref that is not a variant of the base", async () => {
    const s = await build(cleanups, CASE1, { git: false });
    await expect(planBasePromotion(await loadForge(s.forge), "rule/x", { variant: "rule/style" })).rejects.toThrow("forge promote: rule/style is not a variant of rule/x");
    await expect(planBasePromotion(await loadForge(s.forge), "rule/x", { variant: "rule/nope" })).rejects.toThrow("forge promote: rule/nope is not a variant of rule/x");
  });

  it("refuses a profile that resolves both the base and the variant", async () => {
    const spec = { ...CASE1, recipes: [...CASE1.recipes!, recipe("both", ["rule/x"])], profiles: [profile("acme", ["base--acme"]), profile("globex", ["base", "both"]), profile("initech", ["base"])] };
    const s = await build(cleanups, spec, { git: false });
    await expect(planBasePromotion(await loadForge(s.forge), "rule/x", { variant: "rule/x-shared" })).rejects.toThrow(
      "forge promote: profile globex resolves rule/x itself — the Forge is inconsistent",
    );
  });

  it("CLI: --profile and --variant together, or neither, are refused; --json's profile is null under --variant", async () => {
    const s = await build(cleanups, CASE1, { workspaces });
    const both = runCli(["forge", "promote", "rule/x", "--profile", "globex", "--variant", "rule/x-shared", "--forge", s.forge]);
    expect(both.code).toBe(1);
    expect(both.stderr).toContain("forge promote: give --profile or --variant, not both");
    const neither = runCli(["forge", "promote", "rule/x", "--forge", s.forge]);
    expect(neither.code).toBe(1);
    expect(neither.stderr).toContain("forge promote: give --profile <p> or --variant <type/name>");
    const r = runCli(["forge", "promote", "rule/x", "--variant", "rule/x-shared", "--forge", s.forge, "--dry-run", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { profile: string | null; removed: string; created: string[] };
    expect(out).toMatchObject({ profile: null, removed: "rule/x-shared", created: ["rule/x--acme"] });
    const text = runCli(["forge", "promote", "rule/x", "--variant", "rule/x-shared", "--forge", s.forge, "--dry-run"]);
    expect(text.stdout).toContain("craftar forge promote rule/x ← rule/x-shared (dry run — nothing written)");
  });
});
