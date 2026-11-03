/**
 * Spec 54 Part B — a profile that extends a profile (§5). Every case here failed before the change (the build report says
 * how): the gate did not exist, so a schema 12 Forge did not load, and `extends` / `abstract` were dropped.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { runCli } from "./helpers/cli.js";
import { acmeCopies, acmeHoisted, type Family } from "./helpers/profile-extends.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { loadForge } from "../src/core/forge.js";
import { explainFile } from "../src/core/report.js";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { apply, readLock, status } from "../src/core/sync.js";

const GATE = 12;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = (f: Family): Family => (cleanups.push(f.cleanup), f);

async function bytes(wsRoot: string): Promise<Record<string, string>> {
  const p = await plan(await loadWorkspace(wsRoot, { home: process.env.CRAFTAR_HOME }));
  const out: Record<string, string> = {};
  for (const f of p.files) out[f.path] = f.content.toString("utf8");
  return out;
}
async function planOf(wsRoot: string) {
  const ws = await loadWorkspace(wsRoot, { home: process.env.CRAFTAR_HOME });
  return { ws, p: await plan(ws) };
}
async function sync(wsRoot: string): Promise<void> {
  const { ws, p } = await planOf(wsRoot);
  await apply(ws, p, await status(ws, p, await readLock(ws.root)), {});
}
const profileFile = (f: Family, p: string) => path.join(f.forgeRoot, "profiles", p, "profile.yaml");
async function editProfile(f: Family, p: string, edit: (doc: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const file = profileFile(f, p);
  await fs.writeFile(file, YAML.stringify(edit(YAML.parse(await fs.readFile(file, "utf8")))));
}

describe("spec 54 Part B — a profile that extends a profile", () => {
  it("the hoist: each child of an abstract acme plans the bytes the two copies planned (§10 item 8)", async () => {
    const copies = kept(await acmeCopies(GATE));
    const hoisted = kept(await acmeHoisted(GATE));
    for (const w of ["portal", "shop", "globex"] as const) expect(await bytes(hoisted.ws[w])).toEqual(await bytes(copies.ws[w]));
    for (const w of ["portal", "shop"] as const) {
      await sync(hoisted.ws[w]);
      expect(runCli(["sync", "--check", "--workspace", hoisted.ws[w]]).code).toBe(0);
    }
  });

  it("another client's catalogue lists no local of acme's family; a child's lists them under their owner (§5.8)", async () => {
    const f = kept(await acmeHoisted(GATE));
    const globex = JSON.parse(runCli(["ingredients", "--forge", f.forgeRoot, "--profile", "globex", "--json"]).stdout);
    expect(globex.ingredients.map((i: { ref: string }) => i.ref)).not.toContain("rule/house");
    const portal = JSON.parse(runCli(["ingredients", "--forge", f.forgeRoot, "--profile", "acme-portal", "--json"]).stdout);
    const house = portal.ingredients.find((i: { ref: string }) => i.ref === "rule/house");
    expect(house).toMatchObject({ scope: "profile", profile: "acme" });
  });

  it("explain names the parent for a value and a local only the parent gives", async () => {
    const f = kept(await acmeHoisted(GATE));
    const out = runCli(["explain", ".claude/rules/house.md", "--workspace", f.ws.portal]).stdout;
    expect(out).toContain("source      profile acme (profiles/acme/ingredients/rules/house)");
    expect(out).toContain("tone (profile acme)");
    expect(out).toContain("ticket.prefix (profile acme)");
    const { ws, p } = await planOf(f.ws.portal);
    expect(explainFile(ws, p, ".claude/rules/house.md")!.sections).toEqual([{ name: "tone", layer: { profile: "acme" } }]);
  });

  it("a child's value beats its parent's, and a workspace's beats both", async () => {
    const f = kept(await acmeHoisted(GATE));
    await editProfile(f, "acme-portal", (d) => ({ ...d, params: { "ticket.prefix": "PORTAL" }, sections: { "rule/house": { tone: "Bullets.\n" } } }));
    const t = (await bytes(f.ws.portal))[".claude/rules/house.md"];
    expect(t).toContain("Tickets start with PORTAL.");
    expect(t).toContain("Bullets.\n");
    expect((await bytes(f.ws.shop))[".claude/rules/house.md"]).toContain("Tickets start with ACME.");
  });

  it("within the layers, a child's integrations scalar beats a parent's explicit param of the same key (D4)", async () => {
    const f = kept(await acmeHoisted(GATE));
    await editProfile(f, "acme", (d) => ({ ...d, params: { ...(d.params as object), "integrations.executor.model": "parent" } }));
    await editProfile(f, "acme-portal", (d) => ({ ...d, integrations: { executor: { kind: "kiro", model: "child" } } }));
    expect((await planOf(f.ws.portal)).p.resolution.params["integrations.executor.model"]).toBe("child");
  });

  it("a child's integrations slot replaces the parent's whole: another kind selects another recipe (D6)", async () => {
    const f = kept(await acmeHoisted(GATE));
    await editProfile(f, "acme-shop", (d) => ({ ...d, integrations: { executor: { kind: "claude-subagent" } } }));
    const shop = (await planOf(f.ws.shop)).p.resolution.recipes;
    expect(shop).toContain("executor-claude-subagent");
    expect(shop).not.toContain("executor-kiro");
    expect((await planOf(f.ws.portal)).p.resolution.recipes).toContain("executor-kiro");
  });

  it("recipes: the parent's list first, then the child's, a duplicate kept at its first place (D6)", async () => {
    const f = kept(await acmeHoisted(GATE));
    await editProfile(f, "acme-portal", (d) => ({ ...d, recipes: ["base", "stack-angular"] }));
    expect((await planOf(f.ws.portal)).p.resolution.recipes).toEqual(["base", "acme-base", "stack-angular", "executor-kiro"]);
  });

  it("a child that writes no targets inherits its parent's; one that writes them keeps its own (§7 item 1)", async () => {
    const f = kept(await acmeHoisted(GATE));
    await editProfile(f, "acme", (d) => ({ ...d, targets: ["claude-code", "agents-md"] }));
    await editProfile(f, "acme-shop", (d) => {
      const { targets: _, ...rest } = d;
      return rest;
    });
    expect((await planOf(f.ws.shop)).p.resolution.targets).toEqual(["claude-code", "agents-md"]);
    expect((await planOf(f.ws.portal)).p.resolution.targets).toEqual(["claude-code", "kiro"]);
  });

  it("a chain of three: a grandparent's value under a parent's under the child's (§7 item 10)", async () => {
    const f = kept(await acmeHoisted(GATE));
    await fs.mkdir(path.join(f.forgeRoot, "profiles/acme-web"), { recursive: true });
    await fs.writeFile(profileFile(f, "acme-web"), YAML.stringify({ name: "acme-web", abstract: true, extends: "acme", params: { "ticket.prefix": "WEB" } }));
    await editProfile(f, "acme-portal", (d) => ({ ...d, extends: "acme-web" }));
    const t = (await bytes(f.ws.portal))[".claude/rules/house.md"];
    expect(t).toContain("Tickets start with WEB.");
    expect(t).toContain("Short paragraphs.\n");
  });

  it("below the gate a profile holding extends or abstract fails the load, naming the file and schema 12", async () => {
    const f = kept(await acmeHoisted(11));
    await expect(loadForge(f.forgeRoot)).rejects.toThrow(`profiles/acme/profile.yaml: abstract in a profile needs schema: ${GATE} in craftar.forge.yaml`);
  });

  it("E1, E2, E3: a missing parent, a parent that is not abstract and a cycle fail the load in one error", async () => {
    const f = kept(await acmeHoisted(GATE));
    await editProfile(f, "acme-portal", (d) => ({ ...d, extends: "nope" }));
    await editProfile(f, "acme-shop", (d) => ({ ...d, extends: "globex" }));
    await fs.mkdir(path.join(f.forgeRoot, "profiles/loop-a"), { recursive: true });
    await fs.mkdir(path.join(f.forgeRoot, "profiles/loop-b"), { recursive: true });
    await fs.writeFile(profileFile(f, "loop-a"), YAML.stringify({ name: "loop-a", abstract: true, extends: "loop-b" }));
    await fs.writeFile(profileFile(f, "loop-b"), YAML.stringify({ name: "loop-b", abstract: true, extends: "loop-a" }));
    const msg = await loadForge(f.forgeRoot).then(() => "loaded", (e: Error) => e.message);
    expect(msg).toContain("E1 profiles/acme-portal/profile.yaml: extends nope, which is not a profile of this Forge");
    expect(msg).toContain("E2 profiles/acme-shop/profile.yaml: extends globex, which is not abstract — mark it abstract: true, or extend an abstract profile");
    expect(msg).toContain("E3 extends cycle: loop-a → loop-b → loop-a");
  });

  it("L1′, L2′, L3′: a child's local shadowing its parent's, and a parent's recipe citing a child's local, fail the load", async () => {
    const f = kept(await acmeHoisted(GATE));
    await fs.mkdir(path.join(f.forgeRoot, "profiles/acme-portal/ingredients/rules/house"), { recursive: true });
    await fs.writeFile(path.join(f.forgeRoot, "profiles/acme-portal/ingredients/rules/house/ingredient.yaml"), YAML.stringify({ type: "rule", name: "house" }));
    await fs.writeFile(path.join(f.forgeRoot, "profiles/acme-portal/ingredients/rules/house/rule.md"), "Other.\n");
    await fs.mkdir(path.join(f.forgeRoot, "profiles/acme-portal/recipes"), { recursive: true });
    await fs.writeFile(path.join(f.forgeRoot, "profiles/acme-portal/recipes/acme-base.yaml"), YAML.stringify({ name: "acme-base", ingredients: [] }));
    await fs.mkdir(path.join(f.forgeRoot, "profiles/acme-shop/ingredients/rules/shop-only"), { recursive: true });
    await fs.writeFile(path.join(f.forgeRoot, "profiles/acme-shop/ingredients/rules/shop-only/ingredient.yaml"), YAML.stringify({ type: "rule", name: "shop-only" }));
    await fs.writeFile(path.join(f.forgeRoot, "profiles/acme-shop/ingredients/rules/shop-only/rule.md"), "Shop.\n");
    await fs.writeFile(path.join(f.forgeRoot, "profiles/acme/recipes/acme-extra.yaml"), YAML.stringify({ name: "acme-extra", ingredients: ["rule/shop-only"] }));
    const msg = await loadForge(f.forgeRoot).then(() => "loaded", (e: Error) => e.message);
    expect(msg).toContain("L1′ profiles/acme-portal/ingredients/rules/house and profiles/acme/ingredients/rules/house: a local of profile acme-portal and of acme, which it extends — rename the child's");
    expect(msg).toContain("L2′ profiles/acme-portal/recipes/acme-base.yaml and profiles/acme/recipes/acme-base.yaml: a local recipe of profile acme-portal and of acme, which it extends — rename the child's");
    expect(msg).toContain("L3′ profiles/acme/recipes/acme-extra.yaml: cites rule/shop-only, which is local to a profile that extends acme (profiles/acme-shop/ingredients/rules/shop-only) — a parent's recipe does not see a child's ingredients");
  });

  it("a child's local recipe may cite its parent's local (L4 reads the family)", async () => {
    const f = kept(await acmeHoisted(GATE));
    await fs.mkdir(path.join(f.forgeRoot, "profiles/acme-portal/recipes"), { recursive: true });
    await fs.writeFile(path.join(f.forgeRoot, "profiles/acme-portal/recipes/portal-extra.yaml"), YAML.stringify({ name: "portal-extra", ingredients: ["rule/house"], extends: ["acme-base"] }));
    await editProfile(f, "acme-portal", (d) => ({ ...d, recipes: [...(d.recipes as string[]), "portal-extra"] }));
    expect(Object.keys(await bytes(f.ws.portal))).toContain(".claude/rules/house.md");
  });

  it("an abstract profile is no workspace's: the workspace, init --profile and --like refuse it (D7)", async () => {
    const f = kept(await acmeHoisted(GATE));
    const cfg = path.join(f.ws.portal, "craftar.yaml");
    await fs.writeFile(cfg, YAML.stringify({ ...YAML.parse(await fs.readFile(cfg, "utf8")), profile: "acme" }));
    const r = runCli(["sync", "--check", "--workspace", f.ws.portal]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("profile acme is abstract — a workspace uses a profile that extends it: acme-portal, acme-shop");
    const init = runCli(["init", "--forge", f.forgeRoot, "--profile", "acme", "--workspace", path.join(f.root, "new-ws")]);
    expect(init.code).toBe(1);
    expect(init.stderr).toContain("profile acme is abstract");
  });

  it("import into a child refuses a source that differs from its parent's local, and reuses one that equals it (D11)", async () => {
    const f = kept(await acmeHoisted(GATE));
    await sync(f.ws.portal);
    const same = await importClaudeCode({ workspaceRoot: f.ws.portal, forgeRoot: f.forgeRoot, profileName: "acme-portal" });
    expect(same.variants).toEqual([]);
    expect(await fs.readdir(path.join(f.forgeRoot, "ingredients/rules"))).not.toContain("house");
    const file = path.join(f.ws.portal, ".claude/rules/house.md");
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("# House rules", "# House rules, portal"));
    await expect(importClaudeCode({ workspaceRoot: f.ws.portal, forgeRoot: f.forgeRoot, profileName: "acme-portal" })).rejects.toThrow(
      /rule\/house differs from the local of acme, which acme-portal extends \(profiles\/acme\/ingredients\/rules\/house\)/,
    );
  });

  it("recipes --json lists the concrete profiles that resolve a recipe, never the abstract parent", async () => {
    const f = kept(await acmeHoisted(GATE));
    const j = JSON.parse(runCli(["recipes", "--forge", f.forgeRoot, "--json"]).stdout);
    const base = j.recipes.find((r: { name: string }) => r.name === "base");
    expect(base.profiles).toEqual(["acme-portal", "acme-shop", "globex"]);
  });
});
