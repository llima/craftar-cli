import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listFiles } from "../../src/core/forge.js";
import { apply, loadWorkspace, plan, readLock, status } from "../../src/core/sync.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, type ForgeSpec, type IngredientSpec, type WorkspaceSpec } from "./forge.js";

/** A temp dir holding `forge/` (its manifest at `schema`) and `ws/`. `makeForge` alone always writes schema 1. */
export async function forgeAt(schema: number, spec: ForgeSpec, ws: WorkspaceSpec = { config: { profile: "acme" } }) {
  const root = await tmpDir("craftar-integrations-");
  const forgeRoot = path.join(root, "forge");
  const wsRoot = path.join(root, "ws");
  await makeForge(forgeRoot, spec);
  await fs.writeFile(path.join(forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
  await makeWorkspace(wsRoot, forgeRoot, ws);
  return { root, forgeRoot, wsRoot, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

/** plan → status → apply, as `craftar sync` does; returns the plan. */
export async function sync(wsRoot: string) {
  const w = await loadWorkspace(wsRoot);
  const p = await plan(w);
  await apply(w, p, await status(w, p, await readLock(wsRoot)), {});
  return p;
}

/** Every file under `dir`, POSIX-relative → its bytes in base64: two snapshots are `toEqual` exactly when no byte moved. */
export async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of await listFiles(dir)) out[rel] = (await fs.readFile(path.join(dir, rel))).toString("base64");
  return out;
}

/** `craftar status`, as a path → state record. */
export async function states(wsRoot: string): Promise<Record<string, string>> {
  const w = await loadWorkspace(wsRoot);
  const p = await plan(w);
  return Object.fromEntries((await status(w, p, await readLock(wsRoot))).map((s) => [s.path, s.state]));
}

export const mcp = (name: string, server: Record<string, unknown>, extra: Record<string, unknown> = {}): IngredientSpec => ({ meta: { type: "mcp", name, server, ...extra } });

export const STORIES = "Stories live in Azure DevOps, organisation {{integrations.pm.org}}, project {{integrations.pm.project}}.\n";
export const STORIES_ACME = "Stories live in Azure DevOps, organisation acme, project Platform.\n";
export const PM = { pm: { kind: "azure-devops", org: "acme", project: "Platform" } };
export const ADO_MCP_JSON = '{\n  "mcpServers": {\n    "azure-devops": {\n      "command": "npx",\n      "args": [\n        "-y",\n        "ado-mcp"\n      ]\n    }\n  }\n}\n';

/** Spec 33 §4.1's example: `base` listed by the profile, `pm-azure-devops` selected by its block. */
export const ado = (extra: Partial<ForgeSpec> = {}, block: Record<string, unknown> = PM, profileExtra: Record<string, unknown> = {}): ForgeSpec => ({
  ingredients: [
    rule("workflow", "# Workflow\n"),
    rule("where", "Org {{integrations.pm.org}}\n"),
    rule("stories-azure-devops", STORIES),
    mcp("azure-devops", { command: "npx", args: ["-y", "ado-mcp"] }),
    ...(extra.ingredients ?? []),
  ],
  recipes: [
    recipe("base", ["rule/workflow", "rule/where"]),
    recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops"], { slot: "pm" }),
    ...(extra.recipes ?? []),
  ],
  profiles: [profile("acme", ["base"], ["claude-code", "kiro"], { integrations: block, ...profileExtra }), ...(extra.profiles ?? [])],
});
