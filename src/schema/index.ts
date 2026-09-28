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

/** A parameter an ingredient declares (spec 09). `default` is the weakest layer, scoped to this ingredient. */
const IngredientParam = z
  .object({
    // A scalar: `substitute` renders values with String(), and an object would render "[object Object]".
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    description: z.string().optional(),
    example: z.unknown().optional(),
  })
  .strict();

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
  origin: z.object({ workspace: z.string(), path: z.string() }).strict().optional(),
  /** Declared parameters (spec 09). Optional without a default, so fingerprints of existing ingredients do not move. */
  params: z.record(IngredientParam).optional(),
  // Strict: an unknown key is a typo or a field no command reads. Stripping it hid it from `forge unify`,
  // which could then resolve and delete a variant that differed only there (spec 07, Ruling 1).
}).strict();

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

/** The MCP server keys Craftar reads. Anything else is the tool's own config and passes through. */
const McpServerShape = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string()).optional(),
    type: z.string().optional(),
  })
  .passthrough();
export type McpServer = z.infer<typeof McpServerShape>;

export const McpIngredient = IngredientBase.extend({
  type: z.literal("mcp"),
  // Checked against the declared shape, then returned as the very object the Forge holds: zod would
  // rebuild it in schema order and drop a `__proto__` key, and the emitters write it verbatim (spec 07 §5.3).
  server: z
    .unknown()
    .superRefine((v, ctx) => {
      const r = McpServerShape.safeParse(v);
      if (!r.success) for (const issue of r.error.issues) ctx.addIssue(issue);
    })
    .transform((v) => v as McpServer),
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
/** Loose on purpose: a later stage validates against the Forge's actual ingredients with a better message. */
export const IngredientRefSchema = z.custom<IngredientRef>((v) => typeof v === "string" && v.includes("/"));

/* ------------------------------------------------------------------ */
/* Sections (spec 11)                                                   */
/* ------------------------------------------------------------------ */

/** A section name: the ingredient-name grammar (spec 11 §6.1). */
export const SECTION_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
/** A section key: `<type>/<outName>` (spec 11 §3). A key of another shape fails the load; one that names nothing is warned by `plan()`. */
const SectionKey = z.string().regex(new RegExp(`^(${INGREDIENT_TYPES.join("|")})/[a-z0-9][a-z0-9._-]*$`, "i"), "a section key is <type>/<name>, e.g. rule/review-posture");
/** Section values by key, then by name. Strings only (spec 11 Ruling 20); `""` empties the section. */
export const SectionsSchema = z.record(SectionKey, z.record(z.string().regex(SECTION_NAME, "a section name is slug-like"), z.string())).default({});
export type Sections = z.infer<typeof SectionsSchema>;

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
  /** Section values for this profile, keyed `<type>/<outName>` then section name (spec 11 §5.1). */
  sections: SectionsSchema,
});
export type Profile = z.infer<typeof ProfileSchema>;

/* ------------------------------------------------------------------ */
/* Forge                                                                */
/* ------------------------------------------------------------------ */

/** The manifest schema a Forge must declare once a body holds a section marker (spec 11 §6.14, Ruling 7): craftar ≤ 0.6.2 refuses it at load. */
export const FORGE_SCHEMA_SECTIONS = 2;

export const ForgeManifestSchema = z.object({
  name: z.string(),
  schema: z.union([z.literal(1), z.literal(FORGE_SCHEMA_SECTIONS)]).default(1),
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
      /** Section values for this workspace, same shape as a profile's (spec 11 §5.1). */
      sections: SectionsSchema,
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

/* ------------------------------------------------------------------ */
/* Unify plan — external input, so it is parsed, never trusted         */
/* ------------------------------------------------------------------ */

export const TakeSchema = z.enum(["base", "variant", "keep"]);
export type Take = z.infer<typeof TakeSchema>;

/** The class `forge diff` suggests for a hunk (spec 08). A suggestion never decides anything. */
export const HUNK_CLASSES = ["evolution", "value", "block"] as const;
export const HunkClassSchema = z.enum(HUNK_CLASSES);
export type HunkClass = z.infer<typeof HunkClassSchema>;

export const SuggestedTokenSchema = z.object({
  a: z.string(), // the base side's text for this change
  b: z.string(), // the variant side's text
  param: z.string(), // "param.<slug>"
});

export const HunkSuggestionSchema = z.object({
  class: HunkClassSchema,
  reason: z.string(),
  tokens: z.array(SuggestedTokenSchema).optional(),
});
export type HunkSuggestion = z.infer<typeof HunkSuggestionSchema>;

/** `substitute`'s key syntax (src/core/resolve.ts). */
export const PARAM_KEY = /^[A-Za-z0-9_.]+$/;

/** A hunk may also become a parameter (spec 09); a one-sided file entry keeps TakeSchema. */
export const HunkTakeSchema = z.enum(["base", "variant", "param", "keep"]);
export type HunkTake = z.infer<typeof HunkTakeSchema>;

export const PlanParamSchema = z
  .object({ token: z.string().min(1), key: z.string().regex(PARAM_KEY, "a param key is letters, digits, _ and .") })
  .strict();
export type PlanParam = z.infer<typeof PlanParamSchema>;

export const PlanHunkSchema = z.object({
  hunk: z.number().int().positive(),
  /** Human echo of what `forge diff` printed. Never read back. */
  at: z.string().default(""),
  take: HunkTakeSchema,
  /** Read only when take is "param" (spec 09 §4.1). */
  params: z.array(PlanParamSchema).optional(),
  /** Echo of the suggested class when the plan was saved. Never read back; a malformed one is dropped. */
  suggestion: HunkSuggestionSchema.optional().catch(undefined),
});
export type PlanHunk = z.infer<typeof PlanHunkSchema>;

export const PlanFileSchema = z.object({
  file: z.string(),
  hunks: z.array(PlanHunkSchema).optional(),
  onlyIn: z.enum(["base", "variant"]).optional(),
  take: TakeSchema.optional(),
});
export type PlanFile = z.infer<typeof PlanFileSchema>;

export const UnifyPlanSchema = z.object({
  schema: z.literal(1),
  base: IngredientRefSchema,
  profile: z.string(),
  variant: IngredientRefSchema,
  baseFingerprint: z.string(),
  variantFingerprint: z.string(),
  files: z.array(PlanFileSchema).default([]),
});
export type UnifyPlan = z.infer<typeof UnifyPlanSchema>;
