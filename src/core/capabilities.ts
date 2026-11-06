import { INGREDIENT_TYPES, TARGETS, type IngredientType, type Target } from "../schema/index.js";
import type { Resolution, ResolvedIngredient } from "./resolve.js";
import { appliesTo, effectiveTargets, EXAMPLE_SETTINGS } from "../emitters/shared.js";

/* ------------------------------------------------------------------ */
/* Capability states and the matrix (spec 16 §5.3)                     */
/* ------------------------------------------------------------------ */

export type CapabilityState = "native" | "converted" | "unsupported";

export interface Capability {
  state: CapabilityState;
  /** Path patterns with `<name>` and `<file>`. Empty exactly when unsupported. */
  output: string[];
  /** Null for native cells; non-null for converted and unsupported. */
  note: string | null;
}

/**
 * The capability matrix: what each target does with each ingredient type.
 * A Record over both unions makes a missing cell a type error; `as const satisfies` keeps each
 * cell's `state` as a literal type, which `Written<T>` reads (spec 18 §3.1).
 *
 * - **native** — body reaches the tool's own place unchanged.
 * - **converted** — written, but the body is changed or re-housed.
 * - **unsupported** — nothing written; sync warns when the ingredient is aimed at the target.
 */
export const CAPABILITIES = {
  "claude-code": {
    rule: {
      state: "native",
      output: [".claude/rules/<name>.md"],
      note: null,
    },
    agent: {
      state: "native",
      output: [".claude/agents/<name>.md"],
      note: null,
    },
    command: {
      state: "native",
      output: [".claude/commands/<name>.md"],
      note: null,
    },
    skill: {
      state: "native",
      output: [".claude/skills/<name>/<file>", ".claude/skills/<name>.md"],
      note: null,
    },
    mcp: {
      state: "native",
      output: [".mcp.json", EXAMPLE_SETTINGS],
      note: null,
    },
    script: {
      state: "native",
      output: [".claude/scripts/<file>"],
      note: null,
    },
    steering: {
      state: "unsupported",
      output: [],
      note: "skipped with a warning when aimed at this target",
    },
    hook: {
      state: "native",
      output: [".claude/hooks/<file>", EXAMPLE_SETTINGS],
      note: `the registration is written to ${EXAMPLE_SETTINGS}, to copy`,
    },
    service: {
      state: "unsupported",
      output: [],
      note: "skipped with a warning when aimed at this target",
    },
  },
  kiro: {
    rule: {
      state: "converted",
      output: [".kiro/steering/<name>.md"],
      note: "inclusion frontmatter and a banner are added; a .claude/rules/ reference becomes .kiro/steering/ when kiro writes that file, and otherwise follows the rule it names (kept for claude-code, AGENTS.md (rule: <x>), or <x> (rule not in this workspace) with a warning)",
    },
    agent: {
      state: "converted",
      output: [".kiro/agents/<name>.json"],
      note: "written as JSON; tools mapped to Kiro names, one with no equivalent dropped with a warning; permissions.rules derived from the mapped tools; .claude/rules/ references resolved as for a rule; resources taken from the ingredient, else derived from the steering files",
    },
    command: {
      state: "converted",
      output: [".kiro/steering/commands/<name>.md"],
      note: "written as manual steering; .claude/rules/ references resolved as for a rule, in the body and the description",
    },
    skill: {
      state: "converted",
      output: [".kiro/skills/<name>/<file>"],
      note: "in its text files (.md, .txt, .json, .yaml, .yml), .claude/rules/ references resolved as for a rule; other files are copied as they are; a single-file skill becomes <name>/SKILL.md",
    },
    mcp: {
      state: "native",
      output: [".kiro/settings/mcp.json"],
      note: null,
    },
    script: {
      state: "unsupported",
      output: [],
      note: "skipped with a warning when aimed at this target",
    },
    steering: {
      state: "native",
      output: [".kiro/steering/<name>.md"],
      note: null,
    },
    hook: {
      state: "unsupported",
      output: [],
      note: "skipped with a warning when aimed at this target",
    },
    service: {
      state: "unsupported",
      output: [],
      note: "skipped with a warning when aimed at this target",
    },
  },
  "agents-md": {
    rule: {
      state: "converted",
      output: ["AGENTS.md"],
      note: "always-on rules are embedded in AGENTS.md; a scoped rule is listed at the file another target writes, or embedded when none does; .claude/rules/ references in the bodies, link text included, point at the file a target writes or the rule's place in AGENTS.md, or read <x> (rule not in this workspace) with a warning",
    },
    agent: {
      state: "unsupported",
      output: [],
      note: "skipped with a warning when aimed at this target",
    },
    command: {
      state: "unsupported",
      output: [],
      note: "skipped with a warning when aimed at this target",
    },
    skill: {
      state: "unsupported",
      output: [],
      note: "skipped with a warning when aimed at this target",
    },
    mcp: {
      state: "unsupported",
      output: [],
      note: "skipped with a warning when aimed at this target",
    },
    script: {
      state: "unsupported",
      output: [],
      note: "skipped with a warning when aimed at this target",
    },
    steering: {
      state: "unsupported",
      output: [],
      note: "skipped with a warning when aimed at this target",
    },
    hook: {
      state: "unsupported",
      output: [],
      note: "skipped with a warning when aimed at this target",
    },
    service: {
      state: "unsupported",
      output: [],
      note: "skipped with a warning when aimed at this target",
    },
  },
  cursor: {
    rule: {
      state: "converted",
      output: [".cursor/rules/<name>.mdc"],
      note: "written as .mdc: alwaysApply: true for an always-on rule, globs from fileMatchPattern for a scoped one, a description alone for an auto or a manual one; the body unchanged; with agents-md among the targets, an always-on rule with the default targets is left to AGENTS.md",
    },
    agent: {
      state: "converted",
      output: [".cursor/agents/<name>.md"],
      note: "name, description and model kept; tools have no Cursor field and are dropped with a warning",
    },
    command: {
      state: "unsupported",
      output: [],
      note: "through agent-skills: Cursor moved commands to skills, written to .agents/skills/ by the agent-skills target",
    },
    skill: {
      state: "unsupported",
      output: [],
      note: "through agent-skills: Cursor reads .agents/skills/, written by the agent-skills target",
    },
    mcp: {
      state: "converted",
      output: [".cursor/mcp.json"],
      note: "the servers under mcpServers; a ${NAME} reference becomes ${env:NAME}",
    },
    script: { state: "unsupported", output: [], note: "skipped with a warning when aimed at this target" },
    steering: { state: "unsupported", output: [], note: "skipped with a warning when aimed at this target" },
    hook: { state: "unsupported", output: [], note: "not written yet: Cursor's hook events differ — planned for a later release" },
    service: { state: "unsupported", output: [], note: "skipped with a warning when aimed at this target" },
  },
  copilot: {
    rule: {
      state: "converted",
      output: [".github/instructions/<name>.instructions.md", ".github/copilot-instructions.md"],
      note: "a scoped rule to .github/instructions/ with applyTo from fileMatchPattern; every always-on rule joined into .github/copilot-instructions.md, but with agents-md among the targets an always-on rule with the default targets is left to AGENTS.md; a manual or an auto rule has no Copilot equivalent and is skipped with a warning; VS Code also reads .claude/rules/, so with claude-code on it loads a scoped rule twice",
    },
    agent: {
      state: "converted",
      output: [".github/agents/<name>.agent.md"],
      note: "name, description and model kept; tools mapped to Copilot's aliases (read, edit, search, execute, web, agent, todo), a tool with no alias dropped with a warning",
    },
    command: {
      state: "converted",
      output: [".github/prompts/<name>.prompt.md"],
      note: "written as a VS Code prompt file with description, argument-hint and agent: agent; with agent-skills among the targets, a command with the default targets is left to .agents/skills/",
    },
    skill: { state: "unsupported", output: [], note: "through agent-skills: Copilot reads .agents/skills/, written by the agent-skills target" },
    mcp: {
      state: "converted",
      output: [".vscode/mcp.json"],
      note: "the servers under servers (VS Code's key), each kept whole; a ${NAME} reference becomes ${env:NAME}; the Copilot CLI reads the .mcp.json claude-code writes",
    },
    script: { state: "unsupported", output: [], note: "skipped with a warning when aimed at this target" },
    steering: { state: "unsupported", output: [], note: "skipped with a warning when aimed at this target" },
    hook: { state: "unsupported", output: [], note: "not written yet: Copilot's hook events differ — planned for a later release" },
    service: { state: "unsupported", output: [], note: "skipped with a warning when aimed at this target" },
  },
  "agent-skills": {
    rule: { state: "unsupported", output: [], note: "skipped with a warning when aimed at this target" },
    agent: { state: "unsupported", output: [], note: "skipped with a warning when aimed at this target" },
    command: {
      state: "converted",
      output: [".agents/skills/<name>/SKILL.md"],
      note: "written as a skill only a person invokes (disable-model-invocation: true), read by every tool that reads .agents/skills/; a command and a skill with one name fail the plan",
    },
    skill: {
      state: "converted",
      output: [".agents/skills/<name>/<file>"],
      note: "copied into .agents/skills/<name>/; a single-file skill becomes <name>/SKILL.md",
    },
    mcp: { state: "unsupported", output: [], note: "skipped with a warning when aimed at this target" },
    script: { state: "unsupported", output: [], note: "skipped with a warning when aimed at this target" },
    steering: { state: "unsupported", output: [], note: "skipped with a warning when aimed at this target" },
    hook: { state: "unsupported", output: [], note: "skipped with a warning when aimed at this target" },
    service: { state: "unsupported", output: [], note: "skipped with a warning when aimed at this target" },
  },
} as const satisfies Record<Target, Record<IngredientType, Capability>>;

/* ------------------------------------------------------------------ */
/* listTargets (spec 16 §4.4)                                          */
/* ------------------------------------------------------------------ */

export interface TargetInfo {
  name: Target;
  inUse: boolean | null;
  capabilities: Record<IngredientType, Capability>;
}

export interface ListTargetsResult {
  ingredientTypes: IngredientType[];
  targets: TargetInfo[];
}

/**
 * Returns the `--json` shape of `craftar targets`, minus `warnings` (cli.ts adds that).
 * @param inUse List of target names in use, or null when there is no workspace context.
 */
export function listTargets(inUse: Target[] | null): ListTargetsResult {
  return {
    ingredientTypes: [...INGREDIENT_TYPES],
    targets: TARGETS.map((name) => ({
      name,
      inUse: inUse === null ? null : inUse.includes(name),
      capabilities: CAPABILITIES[name],
    })),
  };
}

/* ------------------------------------------------------------------ */
/* The walk: the matrix decides what a target writes (spec 18 §3)       */
/* ------------------------------------------------------------------ */

/** The ingredient types target T writes: every type whose cell is not `unsupported`. */
export type Written<T extends Target> = {
  [K in IngredientType]: (typeof CAPABILITIES)[T][K]["state"] extends "unsupported" ? never : K;
}[IngredientType];

/** A resolved ingredient of a type target T writes. */
export type WrittenIngredient<T extends Target> = ResolvedIngredient & { meta: { type: Written<T> } };

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends (<X>() => X extends B ? 1 : 2) ? true : false;
/** What each target writes, pinned where `typecheck` looks: a cell flipped without its emitter fails here too. */
const writtenIs: [
  Equal<Written<"claude-code">, "rule" | "agent" | "command" | "skill" | "mcp" | "script" | "hook">,
  Equal<Written<"kiro">, "rule" | "agent" | "command" | "skill" | "mcp" | "steering">,
  Equal<Written<"agents-md">, "rule">,
  Equal<Written<"cursor">, "rule" | "agent" | "mcp">,
  Equal<Written<"copilot">, "rule" | "agent" | "command" | "mcp">,
  Equal<Written<"agent-skills">, "command" | "skill">,
] = [true, true, true, true, true, true];
void writtenIs;

/**
 * How a target words the warning for a type it does not write, and the "through X" cells (spec 61 §6.1): a type another
 * target writes into a file this tool reads is warned only when that carrier is not among the workspace's targets. Not part of
 * `targets --json`.
 */
const SKIP_WARNING: Record<Target, { label: string; per: "ingredient" | "type"; carriers?: Partial<Record<IngredientType, Target>> }> = {
  "claude-code": { label: "Claude Code", per: "ingredient" },
  kiro: { label: "Kiro", per: "ingredient" },
  "agents-md": { label: "AGENTS.md", per: "type" },
  cursor: { label: "Cursor", per: "type", carriers: { command: "agent-skills", skill: "agent-skills" } },
  copilot: { label: "Copilot", per: "type", carriers: { skill: "agent-skills" } },
  "agent-skills": { label: "Agent Skills", per: "type" },
};

export interface Walk<T extends Target> extends Iterable<WrittenIngredient<T>> {
  /** True once the one iteration ran to its end. */
  readonly finished: boolean;
}

/**
 * The ingredients of `resolution` aimed at `target` that the matrix says it writes, in resolution
 * order. Every other aimed ingredient is warned about here — per ingredient as the walk reaches it,
 * or per type on the first pull — so no emitter decides or words a skip. Lazy and walked once: the
 * warnings land where they did when each emitter skipped on its own (spec 18 §3.2, Ruling 2).
 * `matrix` is a parameter for one test only; production code never passes it.
 */
export function written<T extends Target>(
  resolution: Resolution,
  target: T,
  warn: (msg: string) => void,
  matrix: Record<Target, Record<IngredientType, Capability>> = CAPABILITIES,
): Walk<T> {
  const { label, per, carriers } = SKIP_WARNING[target];
  // A "through X" cell with its carrier among the targets: the content reaches the tool in X's file — nothing to say.
  const carried = (type: IngredientType) => {
    const c = carriers?.[type];
    return c !== undefined && resolution.targets.includes(c);
  };
  let started = false;
  let finished = false;
  function* walk(): Generator<WrittenIngredient<T>> {
    const aimed = resolution.ingredients.filter((ing) => appliesTo(effectiveTargets(ing.meta, resolution), target));
    const skips = (ing: ResolvedIngredient) => matrix[target][ing.meta.type].state === "unsupported";
    if (per === "type") {
      const byType = new Map<string, string[]>();
      for (const ing of aimed) if (skips(ing) && !carried(ing.meta.type)) byType.set(ing.meta.type, [...(byType.get(ing.meta.type) ?? []), ing.ref]);
      for (const [type, refs] of byType)
        warn(`${target}: ${refs.length} ${type} ingredient(s) have no ${label} equivalent — skipped: ${refs.join(", ")}`);
    }
    for (const ing of aimed) {
      if (!skips(ing)) {
        // The one narrowing cast: the matrix said this target writes the type (with a test table the
        // static type and what is yielded can disagree — in that test only).
        yield ing as WrittenIngredient<T>;
      } else if (per === "ingredient" && !carried(ing.meta.type)) {
        warn(`${target}: ${ing.meta.type} ${ing.ref} has no ${label} equivalent — skipped`);
      }
    }
    finished = true;
  }
  return {
    get finished() {
      return finished;
    },
    [Symbol.iterator]() {
      if (started) throw new Error(`internal: the ${target} walk was started twice`);
      started = true;
      return walk();
    },
  };
}
