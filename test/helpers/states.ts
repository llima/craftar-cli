import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { apply, loadWorkspace, plan, readLock, status } from "../../src/core/sync.js";
import { profile, recipe, rule, scenario, writeFiles, type ForgeSpec, type WorkspaceSpec } from "./forge.js";

/**
 * One writing sync of a workspace, through the core (no CLI process, nothing registered). `home` is always the
 * test file's temporary CRAFTAR_HOME: a load without it reads and FILLS the developer's real ~/.craftar/forges.
 */
export async function syncOnce(wsRoot: string): Promise<void> {
  const ws = await loadWorkspace(wsRoot, { home: process.env.CRAFTAR_HOME });
  const p = await plan(ws);
  await apply(ws, p, await status(ws, p, await readLock(ws.root)), {});
}

export type Scenario = Awaited<ReturnType<typeof scenario>>;

/**
 * A workspace holding one file in each of the eight states, claude-code only:
 * adopted (adopt) · clash (collision) · edited (drift) · fresh (new) · gone (orphan) ·
 * gone-edited (orphan-drift) · keep (unchanged) · moved (update).
 */
export async function eightStates(): Promise<Scenario> {
  const s = await scenario(
    {
      ingredients: [
        rule("keep", "# Keep\n"),
        rule("moved", "# Moved\nold line\n"),
        rule("edited", "# Edited\nby the forge\n"),
        rule("gone", "# Gone\n"),
        rule("gone-edited", "# Gone edited\n"),
      ],
      recipes: [recipe("base", ["rule/keep", "rule/moved", "rule/edited", "rule/gone", "rule/gone-edited"])],
      profiles: [profile("acme", ["base"])],
    },
    { config: { profile: "acme" } },
  );
  await syncOnce(s.wsRoot);
  const ing = (name: string, body: string) => ({
    [`ingredients/rules/${name}/ingredient.yaml`]: YAML.stringify({ type: "rule", name }),
    [`ingredients/rules/${name}/rule.md`]: body,
  });
  await writeFiles(s.forgeRoot, {
    "ingredients/rules/moved/rule.md": "# Moved\nnew line\n",
    ...ing("fresh", "# Fresh\n"),
    ...ing("clash", "# Clash\nforge side\n"),
    ...ing("adopted", "# Adopted\n"),
    "recipes/base.yaml": YAML.stringify(recipe("base", ["rule/keep", "rule/moved", "rule/edited", "rule/fresh", "rule/clash", "rule/adopted"])),
  });
  await writeFiles(s.wsRoot, {
    ".claude/rules/edited.md": "# Edited\nby hand\n",
    ".claude/rules/gone-edited.md": "# Gone edited\nby hand\n",
    ".claude/rules/clash.md": "# Clash\ndisk side\n",
    ".claude/rules/adopted.md": "# Adopted\n",
  });
  return s;
}

export const TRACKER = {
  meta: { type: "mcp", name: "tracker", authEnv: ["ACME_TOKEN"], server: { command: "npx", args: ["-y", "acme-mcp"], env: { ACME_TOKEN: "${ACME_TOKEN}" } } },
};
export const MCP_FILES = [".mcp.json", ".kiro/settings/mcp.json", ".claude/settings.craftar.example.json"] as const;

/** claude-code + kiro, one MCP server and one rule: the three files tagged `mcp/*`. Not synced. */
export function mcpWorkspace(ws: Partial<WorkspaceSpec> = {}): Promise<Scenario> {
  return scenario(
    { ingredients: [rule("keep", "# Keep\n"), TRACKER], recipes: [recipe("base", ["rule/keep", "mcp/tracker"])], profiles: [profile("acme", ["base"], ["claude-code", "kiro"])] },
    { config: { profile: "acme" }, ...ws },
  );
}

/** Replace the tracker's args in the Forge, so the three MCP files become `update` after a sync. */
export async function moveTracker(forgeRoot: string): Promise<void> {
  await fs.writeFile(path.join(forgeRoot, "ingredients/mcp/tracker/ingredient.yaml"), YAML.stringify({ ...TRACKER.meta, server: { ...TRACKER.meta.server, args: ["-y", "acme-mcp@2"] } }));
}

const API =
  "# API\n<!-- craftar:section review -->\ndefault review\n<!-- /craftar:section -->\nTeam {{team}} on port {{api.port}}, region {{region}}.\n";

/**
 * claude-code + agents-md, Forge schema 2: `rule/api` (a section the profile fills; params from the profile, the
 * ingredient's default and the workspace), `rule/legacy` (imported: it has an origin), and AGENTS.md. Not synced.
 */
export async function explained(): Promise<Scenario> {
  const forge: ForgeSpec = {
    ingredients: [
      rule("api", API, { params: { "api.port": { default: 8080 } } }),
      rule("legacy", "# Legacy\n", { origin: { workspace: "acme-portal", path: ".claude/rules/legacy.md" } }),
    ],
    recipes: [recipe("base", ["rule/legacy"]), recipe("stack-node", ["rule/api"], { extends: ["base"] })],
    profiles: [profile("acme", ["stack-node"], ["claude-code", "agents-md"], { params: { team: "platform" }, sections: { "rule/api": { review: "acme review\n" } } })],
  };
  const s = await scenario(forge, { config: { profile: "acme", overrides: { params: { region: "eu" } } } });
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), "name: test-forge\nschema: 2\n");
  return s;
}
