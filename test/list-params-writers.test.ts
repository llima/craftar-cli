import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { loadForge } from "../src/core/forge.js";
import { checkParamWrites } from "../src/core/param-writes.js";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { planPromote } from "../src/importers/drift-promote.js";
import { FORGE_SCHEMA_LIST_PARAMS } from "../src/schema/index.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, profile, recipe, rule, tmpDir, writeFiles } from "./helpers/forge.js";
import { acmeLists, type Scenario } from "./helpers/list-params.js";
import { git } from "./helpers/remote.js";

/** Spec 55 Part A §4.8, tests 12–13: import, forge unify and drift promote with a list param. */

const GATE = FORGE_SCHEMA_LIST_PARAMS;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = (s: Scenario) => (cleanups.push(s.cleanup), s);
const BODY = "# Allow\n\nALLOW = {{env | py}}\n";

async function synced(s: Scenario) {
  git(s.forgeRoot, "init", "-q", "-b", "main");
  git(s.forgeRoot, "add", "-A");
  git(s.forgeRoot, "commit", "-q", "-m", "forge");
  const ws = await loadWorkspace(s.wsRoot);
  const p = await plan(ws);
  await apply(ws, p, await status(ws, p, await readLock(ws.root)), {});
}

describe("list params and the writers (spec 55 §4.8)", () => {
  it("test 12: an unchanged re-import reuses the base; a different list makes a variant, no profile value written", async () => {
    const s = kept(await acmeLists({ schema: GATE, declare: true, body: BODY }));
    await synced(s);
    const paramsOf = async () => YAML.parse(await fs.readFile(path.join(s.forgeRoot, "profiles/acme/profile.yaml"), "utf8")).params;
    const paramsBefore = await paramsOf();
    const same = await importClaudeCode({ workspaceRoot: s.wsRoot, forgeRoot: s.forgeRoot, profileName: "acme" });
    expect(same.variants).toEqual([]);
    const file = path.join(s.wsRoot, ".claude/rules/allow.md");
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace('["A", "B"]', '["A", "B", "C"]'));
    const changed = await importClaudeCode({ workspaceRoot: s.wsRoot, forgeRoot: s.forgeRoot, profileName: "acme" });
    expect(changed.variants.map((v) => v.name)).toEqual(["rule/allow--acme"]);
    expect(changed.params).toEqual([]);
    expect(await paramsOf()).toEqual(paramsBefore);
  });

  it("test 12: an unchanged re-import reuses a base whose metadata holds yaml-items in paths: and join in a description", async () => {
    const root = await tmpDir("craftar-list-meta-import-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const ws = path.join(root, "ws");
    // The Forge as import writes it, then edited by hand to cite the list (the shape of test/metadata-params-import.test.ts).
    await writeFiles(ws, {
      // Quoted as yaml-items writes them: the workspace has no lock yet, so sync would leave a differing file as a collision.
      ".claude/rules/scoped.md": '---\npaths:\n  - "src/**"\n  - "lib/**"\n---\n# Scoped\n',
      ".claude/agents/helper.md": "---\nname: helper\ndescription: Helps on src/** and lib/**\n---\nHelp.\n",
    });
    await importClaudeCode({ workspaceRoot: ws, forgeRoot: forge, profileName: "acme" });
    const edit = async (rel: string, f: (doc: Record<string, unknown>) => void) => {
      const abs = path.join(forge, rel);
      const doc = YAML.parse(await fs.readFile(abs, "utf8"));
      f(doc);
      await fs.writeFile(abs, YAML.stringify(doc));
    };
    await edit("ingredients/rules/scoped/ingredient.yaml", (d) => {
      d.frontmatterRaw = String(d.frontmatterRaw).replace('  - "src/**"\n  - "lib/**"', "  - {{ env | yaml-items }}");
      d.params = { env: { type: "list" } };
    });
    await edit("ingredients/agents/helper/ingredient.yaml", (d) => {
      d.description = 'Helps on {{ env | join: " and " }}';
      if (typeof d.frontmatterRaw === "string") d.frontmatterRaw = d.frontmatterRaw.replace("src/** and lib/**", '{{ env | join: " and " }}');
      d.params = { env: { type: "list" } };
    });
    await edit("profiles/acme/profile.yaml", (d) => {
      d.params = { env: ["src/**", "lib/**"] };
    });
    await edit("craftar.forge.yaml", (d) => {
      d.schema = GATE;
    });
    await writeFiles(ws, { "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }) });
    const w = await loadWorkspace(ws);
    const p = await plan(w);
    expect(p.files.find((f) => f.path === ".claude/rules/scoped.md")!.content.toString("utf8")).toBe('---\npaths:\n  - "src/**"\n  - "lib/**"\n---\n# Scoped\n');
    await apply(w, p, await status(w, p, await readLock(w.root)), {});
    const r = await importClaudeCode({ workspaceRoot: ws, forgeRoot: forge, profileName: "acme" });
    expect(r.variants.map((v) => v.name)).toEqual([]);
  });

  it("test 13: forge unify sees a citation that is only filtered (P14)", async () => {
    const root = await tmpDir("craftar-list-unify-cites-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [rule("deploy", "base\nX = {{k | py}}\n"), rule("deploy--acme", "acme\nX = {{k | py}}\n", { as: "deploy" })],
      recipes: [recipe("base", ["rule/deploy"]), recipe("base--acme", ["rule/deploy--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });
    await writeFiles(root, { "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: GATE }) });
    const forge = await loadForge(root);
    const ext = { key: "k", default: "base", value: "acme", reused: false } as never;
    const m = await checkParamWrites(forge, forge.ingredients.get("rule/deploy")!, forge.ingredients.get("rule/deploy--acme")!, "acme", [ext]).then(() => "ok", (e: Error) => e.message);
    expect(m).toContain("unify: rule/deploy already uses {{k}}");
  });

  it("test 13: drift show gives a file citing a list key the reason, and drift promote refuses it (D25)", async () => {
    const s = kept(await acmeLists({ schema: GATE, declare: true, body: BODY }));
    await synced(s);
    const file = path.join(s.wsRoot, ".claude/rules/allow.md");
    await fs.writeFile(file, (await fs.readFile(file, "utf8")) + "hand edit\n");
    const show = JSON.parse(runCli(["drift", "show", "--json", "--workspace", s.wsRoot]).stdout);
    const row = show.files.find((f: { path: string }) => f.path === ".claude/rules/allow.md");
    expect(row).toMatchObject({ promotable: false, reason: "cites a list param" });
    const kiro = path.join(s.wsRoot, ".kiro/steering/allow.md");
    await fs.writeFile(kiro, (await fs.readFile(kiro, "utf8")) + "hand edit\r\n");
    const both = JSON.parse(runCli(["drift", "show", "--json", "--workspace", s.wsRoot]).stdout);
    expect(both.files.find((f: { path: string }) => f.path === ".kiro/steering/allow.md")).toMatchObject({ reason: "cites a list param" });
    await expect(
      planPromote({ workspaceRoot: s.wsRoot, forgeDir: null, path: ".claude/rules/allow.md", home: path.join(s.root, ".craftar"), env: { ...process.env, CRAFTAR_NO_REGISTRY: "1" } }),
    ).rejects.toThrow("its ingredient cites a list param, so the file holds a rendered list — promoting it would freeze the list in the Forge; edit the list in the profile's params, or the Forge by hand (D25)");
  });

  it("test 13: forge unify take: param onto a list key is refused (P21)", async () => {
    const root = await tmpDir("craftar-list-unify-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [rule("deploy", "base\n"), rule("deploy--acme", "acme\n", { as: "deploy" }), rule("other", "X = {{env | py}}\n", { params: { env: { type: "list" } } })],
      recipes: [recipe("base", ["rule/deploy", "rule/other"]), recipe("base--acme", ["rule/deploy--acme", "rule/other"])],
      profiles: [profile("acme", ["base--acme"], ["claude-code"], { params: { env: ["A"] } })],
    });
    await writeFiles(root, { "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: GATE }) });
    const forge = await loadForge(root);
    const ext = (key: string) => ({ key, default: "base", value: "acme", reused: false }) as never;
    const w = (key: string) => checkParamWrites(forge, forge.ingredients.get("rule/deploy")!, forge.ingredients.get("rule/deploy--acme")!, "acme", [ext(key)]).then(() => "ok", (e: Error) => e.message);
    expect(await w("env")).toContain("unify: env is a list param — take: param writes a scalar; take this hunk from a side, or name another key (P21)");
  });
});
