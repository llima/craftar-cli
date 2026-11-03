/**
 * Spec 54 Part B — a profile that extends a profile (§5). Every case here failed before the change (the build report says
 * how): the gate did not exist, so a schema 13 Forge did not load, and `extends` / `abstract` were dropped.
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

const GATE = 13;
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

  it("below the gate a profile holding extends or abstract fails the load, naming the file and schema 13", async () => {
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
    const f = kept(await acmeHoisted(GATE, { importShaped: true }));
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

  it("a child that writes no repos or templates gets its parent's; craftar repos and templates list read them", async () => {
    const f = kept(await acmeHoisted(GATE));
    await editProfile(f, "acme", (d) => ({
      ...d,
      repos: [{ name: "portal-api", url: "https://git.example.com/acme/portal-api.git" }],
      templates: [{ kind: "dotnet-new", packages: ["Acme.Templates"] }],
    }));
    const repos = JSON.parse(runCli(["repos", "--json", "--workspace", f.ws.portal]).stdout);
    expect(repos.repos.map((r: { name: string }) => r.name)).toEqual(["portal-api"]);
    const t = JSON.parse(runCli(["templates", "list", "--json", "--workspace", f.ws.shop]).stdout);
    expect(t.templates.map((e: { package: string }) => e.package)).toEqual(["Acme.Templates"]);
  });
});


/* Spec 56 O6 (spec 54 §5.6): a parent's local that overrides a root base is the whole family's. */
describe("spec 54 O6 — a parent's override stands for its family", () => {
  async function withParentOverride(extra: Record<string, string> = {}): Promise<Family> {
    const f = kept(await acmeHoisted(GATE));
    await writeOver(f, {
      "profiles/acme/ingredients/rules/style/ingredient.yaml": YAML.stringify({ type: "rule", name: "style" }),
      "profiles/acme/ingredients/rules/style/rule.md": "# Style\nThe client's own style.\n",
      ...extra,
    });
    return f;
  }
  async function writeOver(f: Family, files: Record<string, string>) {
    for (const [rel, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(f.forgeRoot, rel)), { recursive: true });
      await fs.writeFile(path.join(f.forgeRoot, rel), text);
    }
  }

  it("every child writes the parent's override, and another client the root base", async () => {
    const f = await withParentOverride();
    for (const w of [f.ws.portal, f.ws.shop, f.ws.globex]) expect(runCli(["sync", "--workspace", w]).code).toBe(0);
    for (const w of [f.ws.portal, f.ws.shop]) expect(await fs.readFile(path.join(w, ".claude/rules/style.md"), "utf8")).toContain("The client's own style.");
    expect(await fs.readFile(path.join(f.ws.globex, ".claude/rules/style.md"), "utf8")).toContain("Keep it short.");
  });

  it("a child resolving the parent's override beside a root variant of its name refuses the sync", async () => {
    const f = await withParentOverride({
      "ingredients/rules/style--acme-portal/ingredient.yaml": YAML.stringify({ type: "rule", name: "style--acme-portal", as: "style" }),
      "ingredients/rules/style--acme-portal/rule.md": "# Style\nPortal.\n",
      "recipes/portal-extra.yaml": YAML.stringify({ name: "portal-extra", ingredients: ["rule/style--acme-portal"] }),
      "profiles/acme-portal/profile.yaml": YAML.stringify({ name: "acme-portal", extends: "acme", recipes: ["stack-angular", "portal-extra"], targets: ["claude-code", "kiro"] }),
    });
    const { p } = await planOf(f.ws.portal);
    expect(p.overrideConflicts).toEqual([{ profile: "acme-portal", override: "rule/style", variant: "rule/style--acme-portal" }]);
  });

  it("a Forge writer on the root base names the parent and the profiles that extend it", async () => {
    const f = await withParentOverride();
    const { overriddenWarnings } = await import("../src/core/profile-local.js");
    expect(overriddenWarnings(await loadForge(f.forgeRoot), "rule/style")).toEqual([
      "rule/style is overridden for profile acme and every profile that extends it (acme-portal, acme-shop) — this run does not change what they resolve",
    ]);
  });

  it("the catalogue in a child's context leaves out the root row the parent overrides", async () => {
    const f = await withParentOverride();
    const r = runCli(["ingredients", "--workspace", f.ws.portal, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const rows = JSON.parse(r.stdout).ingredients.filter((i: { ref: string }) => i.ref === "rule/style");
    expect(rows.map((i: { profile: string | null }) => i.profile)).toEqual(["acme"]);
  });
});

describe("spec 54 §5.2 — extends follows init --new-profile's name grammar (P3)", () => {
  it("a Windows device name is refused, by its rule and never its value", async () => {
    const { ProfileSchema } = await import("../src/schema/index.js");
    const { schemaFault } = await import("../src/core/schema-fault.js");
    const r = ProfileSchema.safeParse({ name: "acme-portal", extends: "con" });
    expect(r.success).toBe(false);
    expect(schemaFault(r.error!)).toBe("extends: a profile name that is not a Windows device name");
  });
});

describe("spec 54 §5.2 — the near miss comes before the schema", () => {
  it("below the gate a malformed extends value still reads as the near miss", async () => {
    const f = kept(await acmeCopies(12));
    await fs.writeFile(path.join(f.forgeRoot, "profiles/acme-portal/profile.yaml"), YAML.stringify({ name: "acme-portal", extends: 5, recipes: ["base"] }));
    await expect(loadForge(f.forgeRoot)).rejects.toThrow("profiles/acme-portal/profile.yaml: extends in a profile needs schema: 13 in craftar.forge.yaml");
  });
});

describe("spec 54 §5.8 — the catalogue with an abstract --profile", () => {
  it("lists the parent's view and says, in its own words, that nothing is in use", async () => {
    const f = kept(await acmeHoisted(GATE));
    const r = runCli(["ingredients", "--forge", f.forgeRoot, "--profile", "acme", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.warnings).toEqual(["profile acme is abstract — no workspace uses it, so nothing is marked as in use"]);
    expect(j.ingredients.some((i: { ref: string; profile: string | null }) => i.ref === "rule/house" && i.profile === "acme")).toBe(true);
  });
});

describe("spec 54 §5.3 — an inherited block's refusal names the file that holds it", () => {
  it("templates list refuses a parent's malformed templates naming the parent's profile.yaml", async () => {
    const f = kept(await acmeHoisted(GATE));
    const file = path.join(f.forgeRoot, "profiles/acme/profile.yaml");
    await fs.writeFile(file, YAML.stringify({ ...YAML.parse(await fs.readFile(file, "utf8")), templates: "not a list" }));
    const r = runCli(["templates", "list", "--workspace", f.ws.portal]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("profiles/acme/profile.yaml");
    expect(r.stderr).not.toContain("profiles/acme-portal/profile.yaml");
  });
});

describe("spec 54 §5.3 — what an integrations block alone provides, under a family", () => {
  it("a recipe the parent lists by hand is not the block's, as when the child lists it", async () => {
    const { providedByBlock } = await import("../src/importers/provided.js");
    for (const [mk, file] of [[acmeHoisted, "profiles/acme/profile.yaml"], [acmeCopies, "profiles/acme-portal/profile.yaml"]] as const) {
      const f = kept(await mk(GATE));
      await fs.writeFile(path.join(f.forgeRoot, "recipes/executor-kiro.yaml"), YAML.stringify({ name: "executor-kiro", ingredients: ["rule/dotnet"] }));
      const pf = path.join(f.forgeRoot, file);
      const doc = YAML.parse(await fs.readFile(pf, "utf8"));
      doc.recipes.push("executor-kiro");
      await fs.writeFile(pf, YAML.stringify(doc));
      expect([...providedByBlock(await loadForge(f.forgeRoot), "acme-portal").keys()]).toEqual([]);
    }
  });
});

describe("spec 54 §5.9 — a re-import of a child never copies what its parents' recipes bring", () => {
  it("no recipe the import writes lists an ingredient a parent's recipe gives, and the child still plans the same", async () => {
    const f = kept(await acmeHoisted(GATE, { importShaped: true }));
    expect(runCli(["sync", "--workspace", f.ws.portal]).code).toBe(0);
    await importClaudeCode({ workspaceRoot: f.ws.portal, forgeRoot: f.forgeRoot, profileName: "acme-portal" });
    const child = YAML.parse(await fs.readFile(path.join(f.forgeRoot, "profiles/acme-portal/profile.yaml"), "utf8"));
    const lists: string[][] = [];
    for (const r of child.recipes as string[]) {
      const file = path.join(f.forgeRoot, "recipes", `${r}.yaml`);
      lists.push(YAML.parse(await fs.readFile(file, "utf8")).ingredients);
    }
    for (const parentGives of ["rule/style", "command/open-pr", "rule/house"]) expect(lists.flat()).not.toContain(parentGives);
    expect(runCli(["sync", "--check", "--workspace", f.ws.portal]).code).toBe(0);
  });
});

describe("spec 54 §5.11 — a parent's sections/ file no value names is warned", () => {
  it("in its children's plans, since an abstract profile is never resolved itself", async () => {
    const f = kept(await acmeHoisted(GATE));
    await fs.mkdir(path.join(f.forgeRoot, "profiles/acme/sections"), { recursive: true });
    await fs.writeFile(path.join(f.forgeRoot, "profiles/acme/sections/stray.md"), "Nobody names this.\n");
    const { p } = await planOf(f.ws.portal);
    expect(p.warnings).toContain("profiles/acme/sections/stray.md: no section value names this file");
  });
});

describe("spec 41 §4.10 under a family — agents-md.primary a parent sets keeps import's fail-closed", () => {
  it("a child that does not resolve on its own refuses the import when its parent sets the mode", async () => {
    const f = kept(await acmeHoisted(GATE, { importShaped: true }));
    expect(runCli(["sync", "--workspace", f.ws.portal]).code).toBe(0);
    const parent = path.join(f.forgeRoot, "profiles/acme/profile.yaml");
    const doc = YAML.parse(await fs.readFile(parent, "utf8"));
    doc.params = { ...doc.params, "agents-md.primary": true };
    await fs.writeFile(parent, YAML.stringify(doc));
    await fs.writeFile(path.join(f.forgeRoot, "profiles/acme-portal/profile.yaml"), YAML.stringify({ name: "acme-portal", extends: "acme", recipes: ["stack-angular", "no-such-recipe"], targets: ["claude-code", "kiro"] }));
    await expect(importClaudeCode({ workspaceRoot: f.ws.portal, forgeRoot: f.forgeRoot, profileName: "acme-portal" })).rejects.toThrow(
      /^import: profile acme-portal does not resolve on its own \(.*\) — agents-md\.primary needs it to compare the bases; fix the Forge and re-run\n/,
    );
  });
});

describe("spec 54 §5.9 — a child's edit of a base its parent's recipe brings", () => {
  async function snapshot(root: string): Promise<string> {
    const { listFiles } = await import("../src/core/forge.js");
    const out: string[] = [];
    for (const rel of (await listFiles(root)).sort()) out.push(rel + "\0" + (await fs.readFile(path.join(root, rel), "utf8")));
    return out.join("\n");
  }
  it("import refuses it with the Forge untouched, where a variant would sit beside the base", async () => {
    const f = kept(await acmeHoisted(GATE, { importShaped: true }));
    expect(runCli(["sync", "--workspace", f.ws.portal]).code).toBe(0);
    await fs.writeFile(path.join(f.ws.portal, ".claude/rules/style.md"), "# Style\nKeep it very short.\n");
    const before = await snapshot(f.forgeRoot);
    await expect(importClaudeCode({ workspaceRoot: f.ws.portal, forgeRoot: f.forgeRoot, profileName: "acme-portal" })).rejects.toThrow(
      "import: rule/style--acme-portal would write the file of rule/style, which acme-portal's parent acme brings through its recipes — the two would sit side by side, and no command writes a parent",
    );
    expect(await snapshot(f.forgeRoot)).toBe(before);
  });
});

describe("spec 54 §5.9 — a parent's root variant is what the family writes for that file", () => {
  async function withParentVariant(): Promise<Family> {
    const f = kept(await acmeHoisted(GATE, { importShaped: true }));
    const w = (rel: string, text: string) => fs.mkdir(path.dirname(path.join(f.forgeRoot, rel)), { recursive: true }).then(() => fs.writeFile(path.join(f.forgeRoot, rel), text));
    await w("ingredients/rules/style--acme/ingredient.yaml", YAML.stringify({ type: "rule", name: "style--acme", as: "style" }));
    await w("ingredients/rules/style--acme/rule.md", "# Style\nAcme short.\n");
    await w("recipes/base-acme.yaml", YAML.stringify({ name: "base-acme", ingredients: ["rule/style--acme", "command/open-pr"] }));
    const pf = path.join(f.forgeRoot, "profiles/acme/profile.yaml");
    await fs.writeFile(pf, YAML.stringify({ ...YAML.parse(await fs.readFile(pf, "utf8")), recipes: ["base-acme", "acme-base"] }));
    expect(runCli(["sync", "--workspace", f.ws.portal]).code).toBe(0);
    return f;
  }
  for (const local of ["never", "always"] as const) {
    for (const edit of [true, false]) {
      it(`import --local=${local}${edit ? " after a hand edit" : ", unchanged,"} never writes the child's own style beside the parent's variant`, async () => {
        const f = await withParentVariant();
        if (edit) await fs.writeFile(path.join(f.ws.portal, ".claude/rules/style.md"), "# Style\nEdited by hand.\n");
        await expect(importClaudeCode({ workspaceRoot: f.ws.portal, forgeRoot: f.forgeRoot, profileName: "acme-portal", local })).rejects.toThrow(
          "which acme-portal's parent acme brings through its recipes — the two would sit side by side, and no command writes a parent",
        );
      });
    }
  }
  it("the load refuses a child's local of the name a parent's root variant writes (L1′)", async () => {
    const f = await withParentVariant();
    await fs.mkdir(path.join(f.forgeRoot, "profiles/acme-portal/ingredients/rules/style"), { recursive: true });
    await fs.writeFile(path.join(f.forgeRoot, "profiles/acme-portal/ingredients/rules/style/ingredient.yaml"), YAML.stringify({ type: "rule", name: "style" }));
    await fs.writeFile(path.join(f.forgeRoot, "profiles/acme-portal/ingredients/rules/style/rule.md"), "# Style\nPortal.\n");
    await expect(loadForge(f.forgeRoot)).rejects.toThrow("a local ingredient and the root variant of the same name for profile acme, which it extends");
  });
});

