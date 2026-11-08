/**
 * `craftar setup` (spec 62), the pure part: the files of a new Forge, the schema it declares, the labels of the targets it
 * offers, the hint `craftar` prints with no arguments. No `fs`, no `process`.
 */
import path from "node:path";
import { TARGETS, type Target } from "../schema/index.js";
import { TARGET_SINCE } from "./native-targets.js";
import { profileYamlText, yamlSafe } from "./new-profile.js";

/** One file of the new Forge, Forge-relative with `/`, written LF without a BOM. */
export interface SetupFile {
  path: string;
  text: string;
}

export interface SetupForgeAnswers {
  /** The Forge's `name:` (the profile-name grammar). */
  name: string;
  /** The first profile's name. */
  profile: string;
  targets: readonly Target[];
  /** Write the starter rule and the `base` recipe (§5.2, R4). */
  starter: boolean;
}

/** The starter rule's ref and its recipe (§5.2). */
export const STARTER_RULE = "project-conventions";
export const STARTER_RECIPE = "base";

/**
 * §3, R5: the lowest Forge schema the targets need — the highest `TARGET_SINCE` among them, 1 for none. `gemini` is no target
 * since 1.4.0, so no answer reaches 17.
 */
export function setupSchema(targets: readonly Target[]): number {
  return targets.reduce((max, t) => Math.max(max, TARGET_SINCE[t]), 1);
}

/**
 * The state label each target is offered with (§4.5): from the user's ruling of 2026-11-07 (spec 61 §21, working vs mvp) and
 * the README's tags — `opencode` is tagged `mvp` (1.6.0); the five targets of 1.5.0 are validated in each tool. A `Record` over
 * every target, so a new one does not compile until it is placed here.
 */
export const TARGET_STATES: Record<Target, "working" | "mvp"> = {
  "claude-code": "working",
  kiro: "working",
  "agents-md": "working",
  cursor: "working",
  copilot: "working",
  "agent-skills": "working",
  codex: "working",
  antigravity: "working",
  opencode: "mvp",
};

/** Targets that write no rule file of their own: `codex` and `opencode` read rules through `agents-md`, `agent-skills` writes none. */
const NO_RULE_FILE: readonly Target[] = ["codex", "agent-skills", "opencode"];

/** S12: true when every chosen target writes no rule file, so the starter rule would reach no file on the first sync. */
export function rulesReachNoFile(targets: readonly Target[]): boolean {
  return targets.length > 0 && targets.every((t) => NO_RULE_FILE.includes(t));
}

/** S12's note, said in the confirmation and the output. */
export const STARTER_REACHES_NO_FILE =
  "the starter rule reaches no file for these targets; add a target that writes rules (claude-code, kiro, agents-md, cursor, copilot, antigravity) to see it";

/**
 * §4.5 Q3: a directory's base name reduced to the profile-name grammar — lower-cased, every run of other characters one `-`,
 * no `-` at either end; `forge` when nothing is left. Both separators are read, so a win32 path reduces the same everywhere.
 */
export function derivedName(dir: string): string {
  const base = dir.split(/[\\/]/).filter((s) => s !== "").pop() ?? "";
  const reduced = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return reduced === "" ? "forge" : reduced;
}

/** The default location of the new Forge (§4.5 Q2): a sibling of the current directory, `../<base>-forge`. */
export function defaultForgeDir(cwd: string): string {
  return path.join(path.dirname(cwd), `${derivedName(cwd)}-forge`);
}

/** One row of the schema table the Forge README holds, mirroring the CLI README's *Compatibility* table (levels 2 and up). */
export interface SchemaLevel {
  level: number;
  adds: string;
  since: string;
}

export const SCHEMA_LEVELS: readonly SchemaLevel[] = [
  { level: 2, adds: "sections in ingredient bodies", since: "0.7.0" },
  { level: 3, adds: "a profile's `integrations` block", since: "0.27.0" },
  { level: 4, adds: "params inside an MCP `server`", since: "0.28.0" },
  { level: 5, adds: "`agents-md.primary`", since: "0.36.0" },
  { level: 6, adds: "sections that name their targets", since: "0.39.0" },
  { level: 7, adds: "the rules index, `{{craftar.rules.index}}`", since: "0.40.0" },
  { level: 8, adds: "profile-local ingredients and recipes", since: "0.45.0" },
  { level: 9, adds: "params in ingredient metadata", since: "0.47.0" },
  { level: 10, adds: "`sections` in a recipe", since: "0.51.0" },
  { level: 11, adds: "section values held in files", since: "0.53.0" },
  { level: 12, adds: "a profile local overriding a root base", since: "0.55.0" },
  { level: 13, adds: "profiles that extend an abstract profile", since: "0.57.0" },
  { level: 14, adds: "list params", since: "0.59.0" },
  { level: 15, adds: "the `cursor`, `copilot` and `agent-skills` targets", since: "1.1.0" },
  { level: 16, adds: "the `codex` and `antigravity` targets", since: "1.2.0" },
  { level: 17, adds: "the `gemini` target — removed in 1.4.0; the level still loads and allows no target", since: "1.3.0" },
  { level: 18, adds: "the `opencode` target", since: "1.6.0" },
];

const MANIFEST_DESCRIPTION = "Craftar Forge — shared harness ingredients, recipes and client profiles.";

function readmeText(name: string, profile: string): string {
  const rows = SCHEMA_LEVELS.map((l) => `| ${l.level} | ${l.adds} | ${l.since} |`).join("\n");
  return `# ${name}

A Craftar **Forge**: the AI-coding harness of your projects — rules, agents, commands, skills, MCP servers — written once
and generated into each workspace by \`craftar sync\`.

## Layout

- \`craftar.forge.yaml\` — the Forge's name and the \`schema:\` it declares.
- \`ingredients/<type>/<name>/\` — one ingredient per folder: an \`ingredient.yaml\` and its files (\`rules/\`, \`agents/\`,
  \`commands/\`, \`skills/\`, \`mcp/\`, …).
- \`recipes/<name>.yaml\` — a recipe lists ingredients (\`ingredients: [rule/<name>, …]\`).
- \`profiles/<name>/profile.yaml\` — a profile picks recipes and targets for a client or a team; \`${profile}\` is the first.

## Where this Forge lives

Keep this Forge out of a workspace's git repository. craftar allows a Forge in a directory inside another repository (a nested
repository), but there it is easy to commit the Forge by mistake as part of the workspace: put it beside your workspaces, in a
repository of its own, and point each workspace's \`craftar.yaml\` at it.

## Adding a rule

1. Create \`ingredients/rules/<name>/ingredient.yaml\` (\`type: rule\`, \`name: <name>\`) and \`rule.md\` beside it.
2. List \`rule/<name>\` in a recipe the profile uses.
3. Commit, then run \`craftar sync\` in each workspace. Never edit a generated file: edit the Forge and sync.

## Schema levels

This Forge declares the lowest \`schema:\` its targets need. Each level below is opt-in: raise \`schema:\` in
\`craftar.forge.yaml\` by hand when you need one — every craftar older than the version that reads it then refuses the Forge.

| Level | What it adds | Read since |
|---|---|---|
${rows}

## Next commands

- \`craftar init --forge <this directory> --profile ${profile}\` — start another workspace on this Forge.
- \`craftar init --forge <this directory> --new-profile <name>\` — add a profile.
- \`craftar import --from claude-code --forge <this directory> --profile <name>\` — bring an existing \`.claude/\` in.
- \`craftar doctor\` — check a workspace and this machine.
`;
}

const STARTER_RULE_BODY = `# Project conventions

This rule lives in the Forge at \`ingredients/rules/${STARTER_RULE}/rule.md\`. Edit it there, commit, and run
\`craftar sync\` in each workspace — never edit the generated copy.

- Replace this line with a convention your team follows.
- Replace this line with another one, or delete it.
`;

/**
 * The one builder of the new Forge's bytes (§5.1, §5.2): sorted by path the way a listing would, every text LF with a final
 * newline and no BOM; `.gitkeep` files are empty.
 */
export function setupForgeFiles(a: SetupForgeAnswers): SetupFile[] {
  const files: SetupFile[] = [
    { path: "craftar.forge.yaml", text: `name: ${yamlSafe(a.name)}\nschema: ${setupSchema(a.targets)}\ndescription: ${MANIFEST_DESCRIPTION}\n` },
    { path: "README.md", text: readmeText(a.name, a.profile) },
    { path: `profiles/${a.profile}/profile.yaml`, text: profileYamlText(a.profile, a.starter ? [STARTER_RECIPE] : [], [...a.targets]) },
  ];
  if (a.starter) {
    files.push(
      {
        path: `ingredients/rules/${STARTER_RULE}/ingredient.yaml`,
        text: `type: rule\nname: ${STARTER_RULE}\ndescription: Project conventions — the first rule of this Forge; edit or replace it.\n`,
      },
      { path: `ingredients/rules/${STARTER_RULE}/rule.md`, text: STARTER_RULE_BODY },
      { path: `recipes/${STARTER_RECIPE}.yaml`, text: `name: ${STARTER_RECIPE}\ningredients: [rule/${STARTER_RULE}]\n` },
    );
  } else {
    files.push({ path: "ingredients/.gitkeep", text: "" }, { path: "recipes/.gitkeep", text: "" });
  }
  const order = (p: string) => (p === "craftar.forge.yaml" ? "0" : p === "README.md" ? "1" : `2${p}`);
  return files.sort((x, y) => (order(x.path) < order(y.path) ? -1 : order(x.path) > order(y.path) ? 1 : 0));
}

/** The registry as §4.6 reads it: no file, no workspace entry, at least one entry, or a file that does not read. */
export type RegistryView = "absent" | "empty" | "registered" | "unreadable";

/** §4.6: the `new here? run craftar setup` line — only in a terminal, with no registered workspace and a registry that reads. */
export function showsSetupHint(isTty: boolean, registry: RegistryView): boolean {
  return isTty && (registry === "absent" || registry === "empty");
}

export const SETUP_HINT = "new here? run craftar setup";

/**
 * A path quoted for the shell a printed command is pasted into (§4.8, the `again` line): POSIX single quotes, a `'` written
 * `'\\''`, so `$`, a backtick, `\\` and `"` stay literal; win32 double quotes for `cmd` (S1 refuses `"` and `%` there). A plain
 * path (letters, digits, `_`, `.`, `/`, `-`, `:`, `\\` on win32) is printed bare.
 */
export function shellQuote(p: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return /^[\w.\\/:-]+$/.test(p) ? p : `"${p}"`;
  return /^[\w./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Every target name setup can offer, in `TARGETS` order. */
export const SETUP_TARGETS: readonly Target[] = TARGETS;
