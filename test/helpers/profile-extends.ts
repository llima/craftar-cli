import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { makeForge, makeWorkspace, recipe, rule, tmpDir, writeFiles, type IngredientSpec } from "./forge.js";

/**
 * Spec 54 Part B fixtures (synthetic): a client `acme` with two workspaces' profiles, `acme-portal` (Angular, Claude Code
 * and Kiro) and `acme-shop` (.NET, Claude Code), and another client `globex`. The same client is written two ways:
 *
 * - **copies** — what a Forge holds today: both acme profiles repeat their params, sections and integrations, and the
 *   client's own rule sits at the root (recipe `acme-base`), where every catalogue lists it;
 * - **hoisted** — spec 54 §5.1: an abstract `acme` holds the shared values, the client's rule and its recipe as locals,
 *   and each child writes only `extends`, its stack recipe and its targets.
 *
 * Both must plan the same bytes for every child (spec 54 §10 item 8).
 */

const OPEN = (n: string) => `<!-- craftar:section ${n} -->`;
const CLOSE = "<!-- /craftar:section -->";

export const ingredients: IngredientSpec[] = [
  rule("style", "# Style\nKeep it short.\n"),
  rule("angular", "# Angular\nUse signals.\n"),
  rule("dotnet", "# .NET\nUse records.\n"),
  {
    meta: { type: "command", name: "open-pr", description: "Open a pull request" },
    files: { "command.md": ["# Open a PR", OPEN("execution"), "Run the checks by hand.", CLOSE, ""].join("\n") },
  },
];

/** The client's own rule: cites a param and holds a section. */
export const house: IngredientSpec = rule("house", ["# House rules", "Tickets start with {{ticket.prefix}}.", OPEN("tone"), "Neutral.", CLOSE, ""].join("\n"));

const shared = {
  params: { "ticket.prefix": "ACME" },
  integrations: { executor: { kind: "kiro" } },
  sections: { "rule/house": { tone: "Short paragraphs.\n" } },
};

export const rootRecipes = [
  recipe("base", ["rule/style", "command/open-pr"]),
  recipe("stack-angular", ["rule/angular"]),
  recipe("stack-dotnet", ["rule/dotnet"]),
  recipe("executor-kiro", []),
  recipe("executor-claude-subagent", []),
];

export interface Family {
  root: string;
  forgeRoot: string;
  ws: { portal: string; shop: string; globex: string };
  cleanup: () => Promise<void>;
}

async function workspaces(root: string, forgeRoot: string): Promise<Family["ws"]> {
  const ws = { portal: path.join(root, "ws-portal"), shop: path.join(root, "ws-shop"), globex: path.join(root, "ws-globex") };
  await makeWorkspace(ws.portal, forgeRoot, { config: { profile: "acme-portal" } });
  await makeWorkspace(ws.shop, forgeRoot, { config: { profile: "acme-shop" } });
  await makeWorkspace(ws.globex, forgeRoot, { config: { profile: "globex" } });
  return ws;
}

const globex = { name: "globex", recipes: ["base"], targets: ["claude-code"], integrations: { executor: { kind: "claude-subagent" } }, params: { "ticket.prefix": "GLX" } };

/** Today's shape: two copies of the client, its rule at the root. */
export async function acmeCopies(schema: number): Promise<Family> {
  const root = await tmpDir("craftar-extends-");
  const forgeRoot = path.join(root, "forge");
  await makeForge(forgeRoot, {
    ingredients: [...ingredients, house],
    recipes: [...rootRecipes, recipe("acme-base", ["rule/house"])],
    profiles: [
      { name: "acme-portal", recipes: ["base", "acme-base", "stack-angular"], targets: ["claude-code", "kiro"], ...shared },
      { name: "acme-shop", recipes: ["base", "acme-base", "stack-dotnet"], targets: ["claude-code"], ...shared },
      globex,
    ],
  });
  await writeFiles(forgeRoot, { "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema }) });
  return { root, forgeRoot, ws: await workspaces(root, forgeRoot), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

/** Spec 54 §5.1: the abstract parent `acme` holds what both children shared, its rule and recipe as locals. */
/** `command/open-pr` as import writes one (its frontmatter kept raw beside `description`), so a re-import compares it as the same. */
const importShaped = (xs: IngredientSpec[]): IngredientSpec[] =>
  xs.map((x) => (x.meta.name === "open-pr" ? { ...x, meta: { ...x.meta, frontmatterRaw: "description: Open a pull request" } } : x));

export async function acmeHoisted(schema: number, opts: { importShaped?: boolean } = {}): Promise<Family> {
  const root = await tmpDir("craftar-extends-");
  const forgeRoot = path.join(root, "forge");
  await makeForge(forgeRoot, {
    ingredients: opts.importShaped ? importShaped(ingredients) : ingredients,
    recipes: rootRecipes,
    profiles: [
      { name: "acme", abstract: true, recipes: ["base", "acme-base"], ...shared },
      { name: "acme-portal", extends: "acme", recipes: ["stack-angular"], targets: ["claude-code", "kiro"] },
      { name: "acme-shop", extends: "acme", recipes: ["stack-dotnet"], targets: ["claude-code"] },
      globex,
    ],
  });
  await writeFiles(forgeRoot, {
    "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema }),
    "profiles/acme/ingredients/rules/house/ingredient.yaml": YAML.stringify(house.meta),
    "profiles/acme/ingredients/rules/house/rule.md": house.files!["rule.md"] as string,
    "profiles/acme/recipes/acme-base.yaml": YAML.stringify(recipe("acme-base", ["rule/house"])),
  });
  return { root, forgeRoot, ws: await workspaces(root, forgeRoot), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
