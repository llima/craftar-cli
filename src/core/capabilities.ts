import { INGREDIENT_TYPES, TARGETS, type IngredientType, type Target } from "../schema/index.js";

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
 * A Record over both unions makes a missing cell a type error.
 *
 * - **native** — body reaches the tool's own place unchanged.
 * - **converted** — written, but the body is changed or re-housed.
 * - **unsupported** — nothing written; sync warns when the ingredient is aimed at the target.
 */
export const CAPABILITIES: Record<Target, Record<IngredientType, Capability>> = {
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
      output: [".mcp.json"],
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
      output: [".claude/hooks/<file>"],
      note: null,
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
      note: "written as JSON; tools mapped to Kiro names, one with no equivalent dropped with a warning; .claude/rules/ references resolved as for a rule; resources taken from the ingredient, else derived from the steering files",
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
  },
};

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
