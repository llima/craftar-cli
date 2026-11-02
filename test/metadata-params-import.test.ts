import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { FORGE_SCHEMA_METADATA_PARAMS } from "../src/schema/index.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";

/** Spec 50 §5.6: import compares a base's metadata as sync renders it, and infers no value from metadata (§11 items 18, 22). */

const GATE = FORGE_SCHEMA_METADATA_PARAMS;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/**
 * A Forge made by importing a hand-written workspace (a rule with `paths: src/**`, an agent for acme), then templated by
 * hand at `schema`: the rule's `paths:` and pattern cite {{glob}}, the agent's description {{org}}; `params` set on acme.
 */
async function setup(schema: number, params: Record<string, string>) {
  const root = await tmpDir("craftar-meta-import-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const forge = path.join(root, "forge");
  const ws = path.join(root, "ws");
  await writeFiles(ws, {
    ".claude/rules/paths.md": "---\npaths: src/**\n---\n# Paths\n",
    ".claude/agents/helper.md": "---\nname: helper\ndescription: Helps acme engineers\n---\nHelp.\n",
  });
  await importClaudeCode({ workspaceRoot: ws, forgeRoot: forge, profileName: "acme" });
  const edit = async (rel: string, f: (doc: Record<string, unknown>) => void) => {
    const abs = path.join(forge, rel);
    const doc = YAML.parse(await fs.readFile(abs, "utf8"));
    f(doc);
    await fs.writeFile(abs, YAML.stringify(doc));
  };
  await edit("ingredients/rules/paths/ingredient.yaml", (d) => {
    d.frontmatterRaw = String(d.frontmatterRaw).replace("src/**", "{{glob}}");
    d.fileMatchPattern = "{{glob}}";
  });
  await edit("ingredients/agents/helper/ingredient.yaml", (d) => {
    d.description = "Helps {{org}} engineers";
    if (typeof d.frontmatterRaw === "string") d.frontmatterRaw = d.frontmatterRaw.replace("Helps acme", "Helps {{org}}");
  });
  await edit("profiles/acme/profile.yaml", (d) => {
    d.params = params;
  });
  await edit("craftar.forge.yaml", (d) => {
    d.schema = schema;
  });
  await writeFiles(ws, { "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }) });
  return { root, forge, ws };
}

/** Writes into the workspace what sync would write, so the workspace holds the rendered metadata. */
async function synced(ws: string) {
  const p = await plan(await loadWorkspace(ws, { home: process.env.CRAFTAR_HOME }));
  for (const f of p.files) {
    await fs.mkdir(path.dirname(path.join(ws, f.path)), { recursive: true });
    await fs.writeFile(path.join(ws, f.path), f.content);
  }
}

const importInto = (forge: string, ws: string) => importClaudeCode({ workspaceRoot: ws, forgeRoot: forge, profileName: "acme" });

describe("spec 50 §5.6: import at the metadata gate", () => {
  it("reuses every base of a workspace sync rendered, with no inference written (item 18)", async () => {
    const { forge, ws } = await setup(GATE, { glob: "src/**", org: "acme" });
    await synced(ws);
    const before = await fs.readFile(path.join(forge, "profiles/acme/profile.yaml"), "utf8");
    const r = await importInto(forge, ws);
    expect(r.variants.map((v) => [v.name, (v as { reason?: string }).reason])).toEqual([]);
    expect(r.reused).toEqual(expect.arrayContaining(["rule/paths", "agent/helper"]));
    expect(await fs.readFile(path.join(forge, "profiles/acme/profile.yaml"), "utf8")).toBe(before);
  });

  it("makes a variant of a rule whose paths: differs (item 18)", async () => {
    const { forge, ws } = await setup(GATE, { glob: "src/**", org: "acme" });
    await synced(ws);
    const file = path.join(ws, ".claude/rules/paths.md");
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("paths: src/**", "paths: lib/**"));
    const r = await importInto(forge, ws);
    expect(r.variants.map((v) => v.name)).toEqual(["rule/paths--acme"]);
  });

  it("makes a variant, never an inference, of a base whose description cites a key no layer sets (item 22)", async () => {
    const { forge, ws } = await setup(GATE, { glob: "src/**" });
    await synced(ws);
    const file = path.join(ws, ".claude/agents/helper.md");
    const text = await fs.readFile(file, "utf8");
    expect(text).toContain("description: Helps {{org}} engineers");
    await fs.writeFile(file, text.replace("Helps {{org}} engineers", "Helps acme engineers"));
    const r = await importInto(forge, ws);
    expect(r.variants.map((v) => v.name)).toEqual(["agent/helper--acme"]);
    const prof = YAML.parse(await fs.readFile(path.join(forge, "profiles/acme/profile.yaml"), "utf8"));
    expect(prof.params).toEqual({ glob: "src/**" });
  });
});
