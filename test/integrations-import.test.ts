import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { exists } from "../src/core/forge.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, writeFiles, type ForgeSpec, type WorkspaceSpec } from "./helpers/forge.js";
import { ado, ADO_MCP_JSON, forgeAt, mcp, PM, snapshot, states, STORIES, STORIES_ACME, sync } from "./helpers/integrations.js";

// Spec 33 §9.6 — importing a workspace synced through an integration leaves the Forge byte for byte.

const TOKEN = "ghp_" + "x".repeat(36); // assembled at runtime on purpose
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
/** A Forge at `schema` and a workspace synced from it. */
async function synced(schema: number, spec: ForgeSpec, ws: WorkspaceSpec = { config: { profile: "acme" } }) {
  const s = await forgeAt(schema, spec, ws);
  cleanups.push(s.cleanup);
  await sync(s.wsRoot);
  return s;
}
const importBack = (s: { wsRoot: string; forgeRoot: string }, profileName = "acme") => importClaudeCode({ workspaceRoot: s.wsRoot, forgeRoot: s.forgeRoot, profileName });
/** Import, and the Forge files whose bytes moved (added, removed or changed), sorted. */
async function moved(s: { wsRoot: string; forgeRoot: string }, profileName = "acme") {
  const before = await snapshot(s.forgeRoot);
  const r = await importBack(s, profileName);
  const after = await snapshot(s.forgeRoot);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).sort();
  return { r, changed };
}
const refusal = async (s: { wsRoot: string; forgeRoot: string }) => {
  const before = await snapshot(s.forgeRoot);
  const message = await importBack(s).then(() => "no error", (e: Error) => e.message);
  return { message, untouched: JSON.stringify(await snapshot(s.forgeRoot)) === JSON.stringify(before) };
};
const LEFT = [{ recipe: "pm-azure-devops", slot: "pm", refs: ["rule/stories-azure-devops", "mcp/azure-devops"] }];
const paramsOnly = (block: Record<string, unknown>, profileExtra: Record<string, unknown> = {}): ForgeSpec => ({
  ingredients: [rule("workflow", "# Workflow\n"), rule("where", "Org {{integrations.pm.org}}\n")],
  recipes: [recipe("base", ["rule/workflow", "rule/where"])],
  profiles: [profile("acme", ["base"], ["claude-code", "kiro"], { integrations: block, ...profileExtra })],
});

describe("import — the effective params", () => {
  it("1. a body citing an integration param is reused as rendered", async () => {
    const s = await synced(3, paramsOnly({ pm: { org: "acme" } }));
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(r.variants).toEqual([]);
    expect(r.reused).toEqual(["rule/where", "rule/workflow"]);
    expect(r.rendered).toEqual([{ name: "rule/where", keys: ["integrations.pm.org"] }]);
    expect(r.params).toEqual([]);
    expect(r.profileWrite.action).toBe("unchanged");
  });

  it("2. (control) the same at schema 2 with the value in params", async () => {
    const s = await synced(2, paramsOnly({ pm: { org: "acme" } }, { params: { "integrations.pm.org": "acme" } }));
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(r.variants).toEqual([]);
    expect(r.reused).toEqual(["rule/where", "rule/workflow"]);
    expect(r.rendered).toEqual([{ name: "rule/where", keys: ["integrations.pm.org"] }]);
    expect(r.params).toEqual([]);
    expect(r.profileWrite.action).toBe("unchanged");
  });

  it("3. I3 names the block", async () => {
    const s = await synced(3, paramsOnly({ pm: { org: "acme" } }));
    await writeFiles(s.wsRoot, { ".claude/rules/new.md": "Literal {{integrations.pm.org}}\n" });
    expect(await refusal(s)).toEqual({
      message: "import: .claude/rules/new.md holds {{integrations.pm.org}} literally, but profile acme's integrations set integrations.pm.org — sync would render it\nThe Forge was left untouched.",
      untouched: true,
    });
  });

  it("4. I3 keeps today's wording when params set the key", async () => {
    const s = await synced(3, paramsOnly({ pm: { org: "x" } }, { params: { "integrations.pm.org": "acme" } }));
    await writeFiles(s.wsRoot, { ".claude/rules/new.md": "Literal {{integrations.pm.org}}\n" });
    expect((await refusal(s)).message).toBe(
      "import: .claude/rules/new.md holds {{integrations.pm.org}} literally, but profile acme sets integrations.pm.org — sync would render it\nThe Forge was left untouched.",
    );
  });

  it("5. a malformed block fails the import, the Forge untouched", async () => {
    const s = await synced(3, paramsOnly({ pm: { org: "acme" } }));
    // Overwrite the profile in the Forge with a malformed block
    const profileYaml = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
    const profileData = YAML.parse(await fs.readFile(profileYaml, "utf8"));
    profileData.integrations = { pm: "x" };
    await fs.writeFile(profileYaml, YAML.stringify(profileData));
    expect(await refusal(s)).toEqual({
      message: "import: profile acme does not resolve (profile acme: integrations.pm is not a mapping) — fix the Forge and re-run\nThe Forge was left untouched.",
      untouched: true,
    });
  });

  it("6. (control) the same malformed block at schema 2 imports", async () => {
    const s = await synced(2, paramsOnly({ pm: { org: "acme" } }));
    // Overwrite the profile in the Forge with a malformed block
    const profileYaml = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
    const profileData = YAML.parse(await fs.readFile(profileYaml, "utf8"));
    profileData.integrations = { pm: "x" };
    await fs.writeFile(profileYaml, YAML.stringify(profileData));
    expect((await refusal(s)).message).toBe("no error");
  });

  it("7. a new profile gets no integrations.* param and integrations: {}", async () => {
    const s = await synced(3, paramsOnly({ pm: { org: "acme" } }));
    const r = await importBack(s, "globex");
    const profileYaml = path.join(s.forgeRoot, "profiles/globex/profile.yaml");
    const profileData = YAML.parse(await fs.readFile(profileYaml, "utf8"));
    expect(profileData.integrations).toEqual({});
    expect(Object.keys(profileData.params ?? {}).filter((k: string) => k.startsWith("integrations."))).toEqual([]);
    // The rule has "Org acme\n" from the workspace, but "globex" has no value for integrations.pm.org
    // so it becomes a variant, and no integrations.* param is inferred.
    expect(r.variants).toEqual([{ name: "rule/where--globex", reason: "differs from rule/where already in the Forge" }]);
    expect(r.params).toEqual([]);
  });
});
