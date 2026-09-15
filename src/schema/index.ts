import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Targets                                                              */
/* ------------------------------------------------------------------ */

export const TARGETS = ["claude-code", "kiro", "agents-md"] as const;
export type Target = (typeof TARGETS)[number];
export const TargetSchema = z.enum(TARGETS);

/* ------------------------------------------------------------------ */
/* Ingredients                                                          */
/* ------------------------------------------------------------------ */

export const INGREDIENT_TYPES = ["rule", "agent", "command", "skill", "mcp", "script", "steering", "hook"] as const;
export type IngredientType = (typeof INGREDIENT_TYPES)[number];

const Inclusion = z.enum(["always", "fileMatch", "manual", "auto"]);

const IngredientBase = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, "ingredient names are slug-like"),
  description: z.string().optional(),
  /** Which targets receive this ingredient. Default: all. */
  targets: z.array(TargetSchema).or(z.literal("*")).default("*"),
  /** Output basename when it differs from `name` (variants: `workflow--acme` emits as `workflow`). */
  as: z.string().optional(),
  /** Free-form tags used by recipes and `craftar explain`. */
  tags: z.array(z.string()).default([]),
  /** Where this ingredient came from (set by `craftar import`). */
  origin: z.object({ workspace: z.string(), path: z.string() }).optional(),
});

export const RuleIngredient = IngredientBase.extend({
  type: z.literal("rule"),
  inclusion: Inclusion.default("always"),
  fileMatchPattern: z.string().or(z.array(z.string())).optional(),
  /** Main file, relative to the ingredient dir. */
  file: z.string().default("rule.md"),
});

export const AgentIngredient = IngredientBase.extend({
  type: z.literal("agent"),
  tools: z.array(z.string()).default([]),
  model: z.string().optional(),
  /** Kiro `resources` override (steering files the agent loads). Default: heuristic, see emitters/kiro.ts. */
  resources: z.array(z.string()).optional(),
  file: z.string().default("agent.md"),
  /** Frontmatter as found in the source (kept verbatim for byte-exact claude-code round trips). */
  frontmatterRaw: z.string().optional(),
});

export const CommandIngredient = IngredientBase.extend({
  type: z.literal("command"),
  argumentHint: z.string().optional(),
  allowedTools: z.string().optional(),
  file: z.string().default("command.md"),
  frontmatterRaw: z.string().optional(),
});

export const SkillIngredient = IngredientBase.extend({
  type: z.literal("skill"),
  /** `dir` = folder with SKILL.md (+ assets); `file` = single markdown skill (legacy Claude layout). */
  layout: z.enum(["dir", "file"]).default("dir"),
});

export const McpIngredient = IngredientBase.extend({
  type: z.literal("mcp"),
  server: z.object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string()).optional(),
    type: z.string().optional(),
  }),
});

export const ScriptIngredient = IngredientBase.extend({
  type: z.literal("script"),
  files: z.array(z.string()).min(1),
});

/** Kiro-only steering that has no Claude counterpart (product.md, tech.md, structure.md…). */
export const SteeringIngredient = IngredientBase.extend({
  type: z.literal("steering"),
  file: z.string().default("steering.md"),
  targets: z.array(TargetSchema).or(z.literal("*")).default(["kiro"]),
});

export const HookIngredient = IngredientBase.extend({
  type: z.literal("hook"),
  files: z.array(z.string()).min(1),
});

export const IngredientSchema = z.discriminatedUnion("type", [
  RuleIngredient,
  AgentIngredient,
  CommandIngredient,
  SkillIngredient,
  McpIngredient,
  ScriptIngredient,
  SteeringIngredient,
  HookIngredient,
]);
export type Ingredient = z.infer<typeof IngredientSchema>;

/** `type/name`, the way recipes refer to ingredients. */
export type IngredientRef = `${IngredientType}/${string}`;

/* ------------------------------------------------------------------ */
/* Recipes                                                              */
/* ------------------------------------------------------------------ */

export const RecipeSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  extends: z.array(z.string()).default([]),
  /** Mutually exclusive slot (e.g. `frontend`): two recipes on the same slot cannot coexist. */
  slot: z.string().optional(),
  ingredients: z.array(z.string()).default([]),
  params: z.record(z.object({ default: z.unknown().optional(), description: z.string().optional() })).default({}),
});
export type Recipe = z.infer<typeof RecipeSchema>;

/* ------------------------------------------------------------------ */
/* Profiles                                                             */
/* ------------------------------------------------------------------ */

export const ProfileSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  recipes: z.array(z.string()).default([]),
  targets: z.array(TargetSchema).default(["claude-code"]),
  language: z.object({ rules: z.string().optional(), docs: z.string().optional(), commits: z.string().optional() }).partial().default({}),
  identity: z.object({ emailDomain: z.string().optional() }).partial().default({}),
  scm: z
    .object({
      kind: z.enum(["azure-devops", "github", "gitlab", "other"]).optional(),
      org: z.string().optional(),
      project: z.string().optional(),
      prTool: z.enum(["az", "rest", "gh", "glab"]).optional(),
      workspaceDefaultBranch: z.string().optional(),
      projectDefaultBranch: z.string().optional(),
    })
    .partial()
    .default({}),
  naming: z.object({ namespaceRoot: z.string().optional(), dotnetTemplates: z.array(z.string()).optional() }).partial().default({}),
  frontend: z.object({ packageManager: z.enum(["yarn", "npm", "pnpm"]).optional() }).partial().default({}),
  executor: z
    .object({ kind: z.enum(["kiro", "claude-subagent", "none"]).optional(), modelPin: z.string().optional(), terminal: z.string().optional() })
    .partial()
    .default({}),
  integrations: z.record(z.unknown()).default({}),
  /** Values substituted into `{{param}}` placeholders inside ingredient bodies. */
  params: z.record(z.unknown()).default({}),
  repos: z.array(z.record(z.unknown())).default([]),
});
export type Profile = z.infer<typeof ProfileSchema>;

/* ------------------------------------------------------------------ */
/* Forge                                                                */
/* ------------------------------------------------------------------ */

export const ForgeManifestSchema = z.object({
  name: z.string(),
  schema: z.literal(1).default(1),
  description: z.string().optional(),
});
export type ForgeManifest = z.infer<typeof ForgeManifestSchema>;

/* ------------------------------------------------------------------ */
/* Workspace (craftar.yaml)                                             */
/* ------------------------------------------------------------------ */

export const WorkspaceConfigSchema = z.object({
  /** Path or git URL of the Forge. Relative paths resolve from the workspace root. */
  forge: z.string(),
  ref: z.string().optional(),
  profile: z.string(),
  recipes: z.object({ add: z.array(z.string()).default([]), remove: z.array(z.string()).default([]) }).default({}),
  targets: z.array(TargetSchema).optional(),
  overrides: z
    .object({
      params: z.record(z.unknown()).default({}),
      ingredients: z.object({ disable: z.array(z.string()).default([]) }).default({}),
    })
    .default({}),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

/* ------------------------------------------------------------------ */
/* Lockfile (craftar.lock)                                              */
/* ------------------------------------------------------------------ */

export const LockEntrySchema = z.object({
  path: z.string(),
  hash: z.string(),
  target: TargetSchema,
  ingredient: z.string(),
});
export const LockSchema = z.object({
  schema: z.literal(1).default(1),
  forge: z.object({ source: z.string(), commit: z.string().nullable() }),
  profile: z.string(),
  generatedAt: z.string(),
  files: z.array(LockEntrySchema),
});
export type Lock = z.infer<typeof LockSchema>;
export type LockEntry = z.infer<typeof LockEntrySchema>;
