/**
 * Spec 54 Part B — the writers and an abstract profile (§5.7, §5.9, §5.10). Every case here failed before the change.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { execFileSync } from "node:child_process";
import { loadForge } from "../src/core/forge.js";
import { forgeWorkspaces } from "../src/core/impact.js";
import { applyMove, planLocalize, planShare, proveMove } from "../src/core/localize.js";
import { newProfile } from "../src/core/new-profile.js";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { planPromote } from "../src/importers/drift-promote.js";
import { runCli } from "./helpers/cli.js";
import { acmeHoisted, house, ingredients, rootRecipes } from "./helpers/profile-extends.js";
import { makeForge, makeWorkspace, recipe, tmpDir, writeFiles } from "./helpers/forge.js";

const GATE = 12;
const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
});
const home = () => process.env.CRAFTAR_HOME!;

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "craftar-test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "craftar-test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
});
function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "maintenance.auto", "false"]);
  execFileSync("git", ["-C", dir, "config", "gc.auto", "0"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"], { env: gitEnv() });
}

/** A family whose client rule is still at the root (recipe acme-base), resolved only by acme's children; each synced and registered. */
async function familyAtRoot(opts: { globexToo?: boolean } = {}) {
  const root = await tmpDir("craftar-extends-writers-");
  roots.push(root);
  const forge = path.join(root, "forge");
  await makeForge(forge, {
    ingredients: [...ingredients, house],
    recipes: [...rootRecipes, recipe("acme-base", ["rule/house"])],
    profiles: [
      { name: "acme", abstract: true, recipes: ["base", "acme-base"], params: { "ticket.prefix": "ACME" }, integrations: { executor: { kind: "kiro" } } },
      { name: "acme-portal", extends: "acme", recipes: ["stack-angular"], targets: ["claude-code", "kiro"] },
      { name: "acme-shop", extends: "acme", recipes: ["stack-dotnet"], targets: ["claude-code"] },
      { name: "globex", recipes: opts.globexToo ? ["base", "acme-base"] : ["base"], targets: ["claude-code"], params: { "ticket.prefix": "GLX" } },
    ],
  });
  await writeFiles(forge, { "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: GATE }) });
  const ws: Record<string, string> = {};
  for (const p of ["acme-portal", "acme-shop", "globex"]) {
    const dir = path.join(root, `ws-${p}`);
    await makeWorkspace(dir, forge, { config: { profile: p } });
    const r = runCli(["sync", "--workspace", dir]);
    expect(r.code, r.stderr).toBe(0);
    ws[p] = dir;
  }
  return { root, forge, ws };
}

describe("spec 54 Part B — the writers", () => {
  it("forge localize takes an abstract parent: the rule and its recipe move to profiles/acme, every child plans the same (D9)", async () => {
    const s = await familyAtRoot();
    const f = await loadForge(s.forge);
    const move = await planLocalize(f, "rule/house", "acme");
    await proveMove(f, move, (await forgeWorkspaces(home(), s.forge)).workspaces);
    await applyMove(move, []);
    expect(await fs.readdir(path.join(s.forge, "profiles/acme/ingredients/rules"))).toEqual(["house"]);
    expect(await fs.readdir(path.join(s.forge, "profiles/acme/recipes"))).toEqual(["acme-base.yaml"]);
    for (const p of ["acme-portal", "acme-shop", "globex"]) expect(runCli(["sync", "--check", "--workspace", s.ws[p]]).code).toBe(0);
  });

  it("forge localize to a parent refuses when a profile outside the family resolves the rule", async () => {
    const s = await familyAtRoot({ globexToo: true });
    await expect(loadForge(s.forge).then((f) => planLocalize(f, "rule/house", "acme"))).rejects.toThrow("forge localize: profile globex also resolves rule/house");
  });

  it("forge share moves a parent's local back to the root", async () => {
    const f0 = await acmeHoisted(GATE);
    roots.push(f0.root);
    for (const w of [f0.ws.portal, f0.ws.shop, f0.ws.globex]) expect(runCli(["sync", "--workspace", w]).code).toBe(0);
    const f = await loadForge(f0.forgeRoot);
    const move = await planShare(f, "rule/house", "acme");
    await proveMove(f, move, (await forgeWorkspaces(home(), f0.forgeRoot)).workspaces);
    await applyMove(move, []);
    expect(await fs.readdir(path.join(f0.forgeRoot, "ingredients/rules"))).toContain("house");
    expect(runCli(["sync", "--check", "--workspace", f0.ws.portal]).code).toBe(0);
  });

  it("import --profile and init --new-profile --like refuse an abstract profile (D7)", async () => {
    const f0 = await acmeHoisted(GATE);
    roots.push(f0.root);
    expect(runCli(["sync", "--workspace", f0.ws.portal]).code).toBe(0);
    await expect(importClaudeCode({ workspaceRoot: f0.ws.portal, forgeRoot: f0.forgeRoot, profileName: "acme" })).rejects.toThrow(
      "import: profile acme is abstract — a workspace uses a profile that extends it: acme-portal, acme-shop",
    );
    const f = await loadForge(f0.forgeRoot);
    expect(() => newProfile(f, { name: "acme-api", like: "acme" })).toThrow("--like: profile acme is abstract — start from a profile that extends it, or write extends: acme in the new profile by hand");
  });

  it("drift promote refuses a hand edit of a file from a parent's local that only a variant could hold (D24)", async () => {
    const f0 = await acmeHoisted(GATE);
    roots.push(f0.root);
    gitInit(f0.forgeRoot);
    expect(runCli(["sync", "--workspace", f0.ws.portal]).code).toBe(0);
    const file = path.join(f0.ws.portal, ".claude/rules/house.md");
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("# House rules", "# House rules for the portal"));
    await expect(
      planPromote({ workspaceRoot: f0.ws.portal, forgeDir: null, path: ".claude/rules/house.md", home: home(), env: { ...process.env, CRAFTAR_NO_REGISTRY: "1" } }),
    ).rejects.toThrow(
      "D24 .claude/rules/house.md comes from rule/house, local to acme, which acme-portal extends (profiles/acme/ingredients/rules/house) — no command writes a parent: edit it there by hand, then sync every workspace of the family",
    );
  });
});
