import path from "node:path";
import { z } from "zod";
import { climbsOut } from "../core/text.js";
import { findSecrets } from "../core/secrets.js";

/* ------------------------------------------------------------------ */
/* __proto__ key refusal helper (tech-debt 2026-09-25-zod)              */
/* ------------------------------------------------------------------ */

/** The message noProtoKey and parseFragment use for a __proto__ key — one spelling. */
export const NO_PROTO_KEY = "a __proto__ key is not allowed";

/**
 * Refuse `__proto__` as a key in the raw input: zod's `z.record()` silently strips it,
 * turning a write into a silent drop — the key appears in the source file yet vanishes
 * from the parsed object. Wrap any `z.record()` that users can write (profile params,
 * recipe params, workspace overrides.params, ingredient params, etc.).
 *
 * MCP `server` and `env` keep `__proto__` by design (spec 07): they are tool configs
 * passed through, not user-facing Craftar records.
 */
function noProtoKey<T extends z.ZodTypeAny>(schema: T): z.ZodType<z.infer<T>> {
  return z.custom<unknown>().superRefine((v, ctx) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.hasOwn(v, "__proto__")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["__proto__"], message: NO_PROTO_KEY });
    }
  }).pipe(schema);
}

/* ------------------------------------------------------------------ */
/* Targets                                                              */
/* ------------------------------------------------------------------ */

export const TARGETS = ["claude-code", "kiro", "agents-md"] as const;
export type Target = (typeof TARGETS)[number];
export const TargetSchema = z.enum(TARGETS);

/** Owners of lock entries: AI-coder targets (`claude-code`, `kiro`, `agents-md`) plus `services`. */
export const OWNERS = [...TARGETS, "services"] as const;
export type Owner = (typeof OWNERS)[number];
export const OwnerSchema = z.enum(OWNERS);

/* ------------------------------------------------------------------ */
/* Ingredients                                                          */
/* ------------------------------------------------------------------ */

export const INGREDIENT_TYPES = ["rule", "agent", "command", "skill", "mcp", "script", "steering", "hook", "service"] as const;
export type IngredientType = (typeof INGREDIENT_TYPES)[number];

/** The environment variable name pattern (spec 27 §5.1). Exported so doctor's NAME_REF can be built from it. */
export const ENV_NAME = "[A-Za-z_][A-Za-z0-9_]*";

/** Keys that exist in the Forge only and are stripped by import comparisons (spec 27 §5.2, spec 43 §7.2). */
export const FORGE_ONLY_KEYS = ["params", "authEnv", "registration"] as const;

/** Return a shallow copy of `meta` with FORGE_ONLY_KEYS removed (spec 27 §5.3). */
export function stripForgeOnlyKeys(meta: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...meta };
  for (const key of FORGE_ONLY_KEYS) delete copy[key];
  return copy;
}

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

/** Slug-like pattern: starts with alphanumeric, then alphanumeric, dots, underscores or hyphens. Used by ingredient names and service `as`. */
const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

/* ------------------------------------------------------------------ */
/* Compose fragment shape (spec 31)                                     */
/* ------------------------------------------------------------------ */

/** The five top-level maps a Compose fragment declares (spec 31 §4.1). */
export const COMPOSE_MAPS = ["services", "volumes", "networks", "configs", "secrets"] as const;

/**
 * Compose fragment shape: must be a mapping; each of the five top-level maps, when present,
 * must be a mapping and must not have a __proto__ key. `.passthrough()` keeps unknown keys
 * (version, x-*, etc.). A map that is present and not a mapping fails zod's record parse
 * with a message like "Expected object, received array".
 */
export const ComposeFragmentShape = z
  .object({
    services: noProtoKey(z.record(z.unknown())).optional(),
    volumes: noProtoKey(z.record(z.unknown())).optional(),
    networks: noProtoKey(z.record(z.unknown())).optional(),
    configs: noProtoKey(z.record(z.unknown())).optional(),
    secrets: noProtoKey(z.record(z.unknown())).optional(),
  })
  .passthrough();
export type ComposeFragment = z.infer<typeof ComposeFragmentShape>;

/**
 * The stack file shape: the `include` array is REQUIRED and contains objects with a `path` key.
 * Used by `recordedServices` to parse the stack without casts.
 */
export const ComposeStackShape = z.object({
  include: z.array(z.object({ path: z.string() }).passthrough()),
}).passthrough();
export type ComposeStack = z.infer<typeof ComposeStackShape>;

/**
 * A row from `docker compose ps --format json` (spec 31 §4.4).
 * The schema validates the shape; `readPs` transforms it to `PsContainer`.
 * Unknown keys are ignored (no `.strict()`).
 */
export const ComposePsRow = z.object({
  Service: z.string(),
  State: z.string(),
  Health: z.string().optional().nullable(),
  Publishers: z
    .array(
      z.object({
        TargetPort: z.number(),
        PublishedPort: z.number(),
        Protocol: z.string(),
      }).passthrough(),
    )
    .optional()
    .nullable(),
}).passthrough();
export type ComposePsRowData = z.infer<typeof ComposePsRow>;

const IngredientBase = z.object({
  name: z.string().regex(SLUG, "ingredient names are slug-like"),
  description: z.string().optional(),
  /** Which targets receive this ingredient. Default: all. */
  targets: z.array(TargetSchema).or(z.literal("*")).default("*"),
  /** Output basename when it differs from `name` (variants: `workflow--acme` emits as `workflow`). */
  as: z
    .string()
    // Every emitter joins it into an output path (`outName`): `..` there wrote outside the workspace (0.17.3).
    .refine((v) => !climbsOut(v), "as must not climb out of its folder with a .. segment")
    .optional(),
  /** Free-form tags used by recipes and `craftar explain`. */
  tags: z.array(z.string()).default([]),
  /** Where this ingredient came from (set by `craftar import`). */
  origin: z.object({ workspace: z.string(), path: z.string() }).strict().optional(),
  /** Declared parameters (spec 09). Optional without a default, so fingerprints of existing ingredients do not move. */
  params: noProtoKey(z.record(IngredientParam)).optional(),
  // Strict: an unknown key is a typo or a field no command reads. Stripping it hid it from `forge unify`,
  // which could then resolve and delete a variant that differed only there (spec 07, Ruling 1).
}).strict();

export const RuleIngredient = IngredientBase.extend({
  type: z.literal("rule"),
  inclusion: Inclusion.default("always"),
  fileMatchPattern: z.string().or(z.array(z.string())).optional(),
  /** Main file, relative to the ingredient dir. */
  file: z.string().default("rule.md"),
  /** Frontmatter as found in the source (kept verbatim for byte-exact claude-code round trips). */
  frontmatterRaw: z.string().optional(),
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
  /** Environment variable names this MCP server needs (spec 27 §4.1). Optional with no default, so fingerprints of existing ingredients do not move. */
  authEnv: z
    .array(
      z.string().regex(new RegExp(`^${ENV_NAME}$`), "an authEnv item is a variable name")
    )
    .superRefine((items, ctx) => {
      for (let i = 0; i < items.length; i++) {
        const finding = findSecrets(items[i])[0];
        if (finding) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i],
            message: `looks like a token (${finding.kind}) — an authEnv item is a variable NAME`,
          });
        }
      }
    })
    .optional(),
});

/**
 * A script or hook file: read from the ingredient directory and written under the same spelling (0.17.3).
 * Only a spelling that climbs out is refused; `./x`, `/x` and `a/../x` keep the output path they always had.
 */
const EmittedFile = z.string().refine((v) => !climbsOut(v), 'a files entry must not climb out of the ingredient directory with a .. segment');

export const ScriptIngredient = IngredientBase.extend({
  type: z.literal("script"),
  files: z.array(EmittedFile).min(1),
});

/** Kiro-only steering that has no Claude counterpart (product.md, tech.md, structure.md…). */
export const SteeringIngredient = IngredientBase.extend({
  type: z.literal("steering"),
  file: z.string().default("steering.md"),
  targets: z.array(TargetSchema).or(z.literal("*")).default(["kiro"]),
});

/**
 * A hook registration entry: when Claude Code runs the hook (spec 43 §4.2).
 * The schema is strict: unknown keys fail the Forge load.
 */
const HookRegistration = z
  .object({
    /** Event name: starts with uppercase, then letters only, max 64 chars. */
    event: z.string().regex(/^[A-Z][A-Za-z]*$/, "event is a name starting with uppercase").max(64),
    /** Matcher pattern (optional). Non-empty, max 512 chars. */
    matcher: z.string().min(1).max(512).optional(),
    /** Command to run. Non-empty, max 1024 chars. */
    command: z.string().min(1).max(1024),
    /** Arguments for exec form (optional). Max 64 items, each max 1024 chars. */
    args: z.array(z.string().max(1024)).max(64).optional(),
    /** Timeout in seconds (optional). Integer 1-3600. */
    timeout: z.number().int().min(1).max(3600).optional(),
    /** Shell form (optional): bash or powershell. Refused with args. */
    shell: z.enum(["bash", "powershell"]).optional(),
  })
  .strict()
  .refine((r) => !(r.args && r.shell), "shell applies to the shell form only; drop it or drop args")
  .superRefine((r, ctx) => {
    // Scan matcher, command and each args[i] for literal secrets
    const scan = (value: string | undefined, path: (string | number)[]) => {
      if (!value) return;
      const finding = findSecrets(value)[0];
      if (finding) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `looks like a token (${finding.kind}) — a registration holds no secret; have the hook read it from the environment`,
        });
      }
    };
    scan(r.matcher, ["matcher"]);
    scan(r.command, ["command"]);
    if (r.args) {
      for (let i = 0; i < r.args.length; i++) {
        scan(r.args[i], ["args", i]);
      }
    }
  });

export const HookIngredient = IngredientBase.extend({
  type: z.literal("hook"),
  files: z.array(EmittedFile).min(1),
  /** Registration entries (optional, spec 43 §4.2). At least one when present. */
  registration: z.array(HookRegistration).min(1).optional(),
});

/**
 * A service path: `compose`, and every entry of `files`, `executable` and `binary`.
 *
 * Every `/`-separated segment must match `/^[A-Za-z0-9._@+-]+$/` (letters, digits, . _ @ + -)
 * after an optional leading `./`. Refused when:
 * - climbsOut (the path escapes the directory)
 * - Any segment is `..` (even `a/../b` that stays inside is refused)
 * - Absolute (starts with `/` or a Windows drive letter)
 * - Contains a backslash
 * - Any segment does not match the allowed chars (including empty string, trailing `/`, `a//b`, spaces, `#`, newlines, `:`)
 * - Equals `ingredient.yaml` after normalization
 */
const SEGMENT_OK = /^[A-Za-z0-9._@+-]+$/;

const ServicePath = z
  .string()
  .superRefine((v, ctx) => {
    // First: check if it actually climbs out (escapes the directory)
    if (climbsOut(v)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a service path must not climb out with a .. segment" });
      return; // short-circuit
    }
    const stripped = v.startsWith("./") ? v.slice(2) : v;
    // Second: check for .. segment even in paths that don't climb out (a/../b)
    if (stripped.split("/").includes("..")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a service path must not hold a .. segment" });
      return; // short-circuit
    }
    // Third: absolute path (before segment check, so /abs fails as absolute, not as bad segment)
    if (/^\/|^[A-Za-z]:/.test(v)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a service path must not be absolute" });
      return;
    }
    // Fourth: backslash (before segment check, so a\b fails as backslash, not as bad segment)
    if (v.includes("\\")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a service path must not contain a backslash" });
      return;
    }
    // Fifth: check segment characters — SEGMENT_OK matches "." but "." alone is not a valid segment
    if (stripped === "" || !stripped.split("/").every((seg) => SEGMENT_OK.test(seg) && seg !== ".")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a service path holds only letters, digits and . _ @ + - in each segment" });
      return;
    }
    // Sixth: ingredient.yaml (case-insensitive: on case-insensitive disks INGREDIENT.YAML aliases ingredient.yaml)
    if (normalizeDeclared(v).toLowerCase() === "ingredient.yaml") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a service path must not be ingredient.yaml" });
    }
  });

/**
 * Service ingredient: a Compose fragment plus the files it mounts or builds from.
 * NOTE: This is the base shape for parsing; the subset validations (executable ⊆ files, binary ⊆ files)
 * are done in the IngredientSchema wrapper below.
 */
export const ServiceIngredient = IngredientBase
  .omit({ as: true }) // Remove the base `as` to add our own with slug validation
  .extend({
    type: z.literal("service"),
    /** The compose fragment, relative to the ingredient directory. */
    compose: ServicePath.default("compose.yaml"),
    /** Other files to write next to the fragment. */
    files: z.array(ServicePath).default([]),
    /** A subset of files written with mode 0755 on POSIX. */
    executable: z.array(ServicePath).default([]),
    /** A subset of files copied as bytes (no {{param}}, no sections, no secret scan). */
    binary: z.array(ServicePath).default([]),
    /** A service is aimed at no AI coder by default. */
    targets: z.array(TargetSchema).or(z.literal("*")).default([]),
    /** For a service, `as` must be slug-like (spec 31 §7). */
    as: z
      .string()
      .refine((v) => !climbsOut(v), "as must not climb out of its folder with a .. segment")
      .refine((v) => SLUG.test(v), "a service as must be slug-like (like name)")
      .optional(),
  })
  .strict();

// The base discriminated union of all ingredient types
const IngredientSchemaBase = z.discriminatedUnion("type", [
  RuleIngredient,
  AgentIngredient,
  CommandIngredient,
  SkillIngredient,
  McpIngredient,
  ScriptIngredient,
  SteeringIngredient,
  HookIngredient,
  ServiceIngredient,
]);

/**
 * Normalize a declared service path for subset checks: resolves `./foo` to `foo`.
 * Used by schema validation (executable ⊆ files, binary ⊆ files) and by extract.ts.
 */
export const normalizeDeclared = (p: string) => path.posix.normalize(p);

/**
 * The full ingredient schema: parses with the discriminated union, then validates
 * service-specific constraints (executable ⊆ files, binary ⊆ files, compose not in files,
 * no duplicate files entries).
 *
 * NOTE: We use superRefine on the union instead of on ServiceIngredient itself because
 * zod's discriminatedUnion does not propagate refinements from its members — a refine
 * on ServiceIngredient would never run when parsed through this union.
 */
export const IngredientSchema = IngredientSchemaBase.superRefine((data, ctx) => {
  if (data.type !== "service") return;
  // Case-insensitive: on case-insensitive disks Compose.yaml aliases compose.yaml
  const composeNorm = normalizeDeclared(data.compose).toLowerCase();
  const filesSet = new Set(data.files.map((f) => normalizeDeclared(f).toLowerCase()));

  // Check that compose is not in files (case-insensitive)
  for (let i = 0; i < data.files.length; i++) {
    if (normalizeDeclared(data.files[i]).toLowerCase() === composeNorm) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["files", i], message: "files must not list the compose file" });
    }
  }

  // Check for duplicate files entries (case-insensitive; message names the place, never the value)
  const seen = new Map<string, number>(); // normalized lower -> first index
  for (let i = 0; i < data.files.length; i++) {
    const norm = normalizeDeclared(data.files[i]).toLowerCase();
    const prev = seen.get(norm);
    if (prev !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["files", i], message: `files[${i}] repeats files[${prev}]` });
    } else {
      seen.set(norm, i);
    }
  }

  // executable ⊆ files stays exact (a subset names the entry as written)
  const filesSetExact = new Set(data.files.map(normalizeDeclared));
  for (let i = 0; i < data.executable.length; i++) {
    if (!filesSetExact.has(normalizeDeclared(data.executable[i]))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["executable", i], message: "executable must be a subset of files" });
    }
  }
  for (let i = 0; i < data.binary.length; i++) {
    if (!filesSetExact.has(normalizeDeclared(data.binary[i]))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["binary", i], message: "binary must be a subset of files" });
    }
  }
});
export type Ingredient = z.infer<typeof IngredientSchemaBase>;

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
/* Templates (spec 32)                                                  */
/* ------------------------------------------------------------------ */

/** Rule texts of spec 32 §5.2 — each refusal names its position and one of these, never a value from the block. */
export const TEMPLATE_RULES = {
  list: "must be a list of entries, each with a kind",
  entry: "an entry is a mapping with a kind",
  kind: 'a kind is a lowercase name: a-z, 0-9 and "-", starting with a letter',
  packages: "a dotnet-new entry lists at least one package",
  package: 'a package is a NuGet ID, optionally <id>::<version>: no path, no space, no leading "-" or "."',
  source: "a source is an https:// URL",
  unknownKey: "a dotnet-new entry has no such key (it has kind, packages and source)",
} as const;

export const TEMPLATE_KIND = /^[a-z][a-z0-9-]*$/;
/** `<id>` or `<id>::<version>` (spec 32 §5.2): no separator, no space, no leading `-` or `.`. */
export const TEMPLATE_PACKAGE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(::[0-9A-Za-z][0-9A-Za-z.+-]*)?$/;
/**
 * A source is an `https://` URL with a non-empty host of printable ASCII without `/`,
 * then an optional path of printable ASCII. An empty authority spelled with slashes is refused here
 * as well as by `credentialFault`, which reads past it; spelled with a backslash (a character of the
 * host class) it is `credentialFault`'s alone. No control character reaches a terminal.
 */
export const TEMPLATE_SOURCE = /^https:\/\/[\x21-\x2e\x30-\x7e]+(\/[\x21-\x7e]*)?$/;
/** A key we can echo: an identifier-like name, nothing else (URLs, newlines) reaches an output. */
export const TEMPLATE_KEY_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export const DotnetNewTemplateSchema = z
  .object({
    kind: z.literal("dotnet-new"),
    packages: z
      .array(
        z.string({ invalid_type_error: TEMPLATE_RULES.package, required_error: TEMPLATE_RULES.package }).regex(TEMPLATE_PACKAGE, TEMPLATE_RULES.package),
        { invalid_type_error: TEMPLATE_RULES.packages, required_error: TEMPLATE_RULES.packages }
      )
      .min(1, TEMPLATE_RULES.packages),
    source: z.string({ invalid_type_error: TEMPLATE_RULES.source }).regex(TEMPLATE_SOURCE, TEMPLATE_RULES.source).optional(),
  })
  .strict();
export type DotnetNewTemplate = z.infer<typeof DotnetNewTemplateSchema>;

/** An entry with any kind: validated as a record with a kind, then `dotnet-new` is re-checked with DotnetNewTemplateSchema. */
export const TemplatesSchema = z.array(
  noProtoKey(z.record(z.unknown(), { invalid_type_error: TEMPLATE_RULES.entry })).superRefine((entry, ctx) => {
    const kind = (entry as Record<string, unknown>).kind;
    if (typeof kind !== "string" || !TEMPLATE_KIND.test(kind)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["kind"], message: TEMPLATE_RULES.kind });
      return;
    }
    if (kind === "dotnet-new") {
      const r = DotnetNewTemplateSchema.safeParse(entry);
      if (!r.success) {
        for (const issue of r.error.issues) {
          if (issue.code === "unrecognized_keys") {
            // An unknown key is named only when it is a name; otherwise the entry itself is the position.
            for (const key of issue.keys) {
              if (TEMPLATE_KEY_NAME.test(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: TEMPLATE_RULES.unknownKey });
              else ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: TEMPLATE_RULES.unknownKey });
            }
          } else {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
          }
        }
      }
    }
  }),
  { invalid_type_error: TEMPLATE_RULES.list, required_error: TEMPLATE_RULES.list }
);

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
  params: noProtoKey(z.record(z.object({ default: z.unknown().optional(), description: z.string().optional() }))).default({}),
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
  integrations: noProtoKey(z.record(z.unknown())).default({}),
  /** Values substituted into `{{param}}` placeholders inside ingredient bodies. */
  params: noProtoKey(z.record(z.unknown())).default({}),
  repos: z.array(noProtoKey(z.record(z.unknown()))).default([]),
  /** Section values for this profile, keyed `<type>/<outName>` then section name (spec 11 §5.1). */
  sections: SectionsSchema,
  /** Project templates (spec 32 §5.1): kept as written, NOT validated at load — `declaredTemplates` is its one reader. */
  templates: z.unknown().optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

/* ------------------------------------------------------------------ */
/* Forge                                                                */
/* ------------------------------------------------------------------ */

/** The manifest schema a Forge must declare once a body holds a section marker (spec 11 §6.14, Ruling 7): craftar ≤ 0.6.2 refuses it at load. */
export const FORGE_SCHEMA_SECTIONS = 2;
/** The manifest schema a Forge must declare for its profiles' integrations blocks to be read (spec 33 §4.2): a craftar that does not know schema 3 refuses the Forge at load. */
export const FORGE_SCHEMA_INTEGRATIONS = 3;
/** The manifest schema a Forge must declare for an MCP server to take the params its ingredient declares (spec 34 §4.1): every craftar that does not substitute refuses it at load. */
export const FORGE_SCHEMA_SERVER_PARAMS = 4;
/** Forge schema that reads the param agents-md.primary (spec 41 §4.1). */
export const FORGE_SCHEMA_AGENTS_MD_PRIMARY = 5;
/** Forge schema that reads targets= on a section marker (spec 41 Part B). */
export const FORGE_SCHEMA_TARGET_SECTIONS = 6;
/** Forge schema that reads the rules index (spec 44 §4.1). */
export const FORGE_SCHEMA_RULES_INDEX = 7;
/** Forge schema that reads a profile's own ingredients and recipes under `profiles/<p>/` (spec 51 §4.1). */
export const FORGE_SCHEMA_PROFILE_LOCAL = 8;

export const ForgeManifestSchema = z.object({
  name: z.string(),
  schema: z
    .union([
      z.literal(1),
      z.literal(FORGE_SCHEMA_SECTIONS),
      z.literal(FORGE_SCHEMA_INTEGRATIONS),
      z.literal(FORGE_SCHEMA_SERVER_PARAMS),
      z.literal(FORGE_SCHEMA_AGENTS_MD_PRIMARY),
      z.literal(FORGE_SCHEMA_TARGET_SECTIONS),
      z.literal(FORGE_SCHEMA_RULES_INDEX),
      z.literal(FORGE_SCHEMA_PROFILE_LOCAL),
    ])
    .default(1),
  description: z.string().optional(),
});
export type ForgeManifest = z.infer<typeof ForgeManifestSchema>;

/** The valid schema values a Forge manifest can declare. */
export type ForgeSchema = ForgeManifest["schema"];

/* ------------------------------------------------------------------ */
/* Workspace (craftar.yaml)                                             */
/* ------------------------------------------------------------------ */

/** The overrides.params record, wrapped to refuse __proto__. Used in WorkspaceConfigSchema and in import's workspaceParams. */
export const OverridesParamsSchema = noProtoKey(z.record(z.unknown()));

export const WorkspaceConfigSchema = z.object({
  /** Path or git URL of the Forge. Relative paths resolve from the workspace root. */
  forge: z.string(),
  ref: z.string().optional(),
  profile: z.string(),
  recipes: z.object({ add: z.array(z.string()).default([]), remove: z.array(z.string()).default([]) }).default({}),
  targets: z.array(TargetSchema).optional(),
  /** Exact generated paths this workspace keeps out of git on purpose (spec 49 §4.5); an older craftar strips the key. */
  mayBeIgnored: z.array(z.string()).optional(),
  overrides: z
    .object({
      params: OverridesParamsSchema.default({}),
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

/** Lock entry for schema 1 and 2: target is an AI-coder target. */
export const LockEntrySchema = z.object({
  path: z.string(),
  hash: z.string(),
  target: TargetSchema,
  ingredient: z.string(),
});
/** Lock entry for schema 3: target is any owner (AI-coder targets plus `services`). Derived from LockEntrySchema. */
export const LockEntrySchemaV3 = LockEntrySchema.extend({ target: OwnerSchema });
/** Lock schema 1 (craftar ≤ 0.10.x): read, never written since 0.11.0. */
export const LockSchemaV1 = z.object({
  schema: z.literal(1),
  forge: z.object({ source: z.string(), commit: z.string().nullable() }),
  profile: z.string(),
  generatedAt: z.string(),
  files: z.array(LockEntrySchema),
});
/** Lock schema 2 (spec 13 §5.2): also what the sync used — the requested ref, the resolved recipes and targets. */
export const LockSchemaV2 = z.object({
  schema: z.literal(2),
  forge: z.object({
    /** craftar.yaml › forge as written (after the local merge); never holds credentials (spec 13 §4.3). */
    source: z.string(),
    /** The requested ref; null when none was given or the Forge is a path. */
    ref: z.string().nullable(),
    /** The resolved commit; null for a path Forge without git. */
    commit: z.string().nullable(),
  }),
  profile: z.string(),
  /** Resolution.recipes: resolved, in application order (extends parents included). */
  recipes: z.array(z.string()),
  targets: z.array(TargetSchema),
  /** When the lock's content last changed (Ruling 10). */
  generatedAt: z.string(),
  files: z.array(LockEntrySchema),
});
/** Lock schema 3 (spec 31 §5.2): entry targets include internal owners like `services`. Derived from LockSchemaV2. */
export const LockSchemaV3 = LockSchemaV2.extend({
  schema: z.literal(3),
  files: z.array(LockEntrySchemaV3),
});
/** Supported lock schemas; anything else is refused by name in `readLock`. */
export const LOCK_SCHEMAS: readonly unknown[] = [1, 2, 3];
// A lock with no `schema` key is version 1, as `.default(1)` read it before. A discriminated union
// rejects a missing discriminator, so the key is supplied before the union sees it.
export const LockSchema = z.preprocess(
  (v) => (v !== null && typeof v === "object" && !Array.isArray(v) && !Object.hasOwn(v, "schema") ? { ...v, schema: 1 } : v),
  z.discriminatedUnion("schema", [LockSchemaV1, LockSchemaV2, LockSchemaV3]),
);
export type Lock = z.infer<typeof LockSchema>;
export type LockV2 = z.infer<typeof LockSchemaV2>;
export type LockV3 = z.infer<typeof LockSchemaV3>;
export type LockEntry = z.infer<typeof LockEntrySchema>;
export type LockEntryV3 = z.infer<typeof LockEntrySchemaV3>;

/* ------------------------------------------------------------------ */
/* Workspace registry — $CRAFTAR_HOME/registry.json (spec 21 §5.2)      */
/* ------------------------------------------------------------------ */

// Every level keeps keys it does not declare (`.passthrough()`) and `targets` are plain strings, so
// an older craftar neither refuses nor strips what a newer one wrote; a later release only appends
// keys, and a change an older craftar would misread moves `schema` to 2.
export const RegistryEntrySchema = z
  .object({
    /** The workspace's real path; native and absolute — the registry is per machine. */
    path: z.string(),
    profile: z.string(),
    forge: z
      .object({
        kind: z.enum(["path", "remote"]),
        /** craftar.yaml › forge as written (after the local merge), as the lock records it. */
        source: z.string(),
        /** Where the Forge lives: a path Forge's real path, a remote one's cache key; null when unresolvable. */
        key: z.string().nullable(),
        /** ForgeOrigin.ref: null for a path Forge. */
        ref: z.string().nullable(),
        /** The commit this sync planned from. */
        commit: z.string().nullable(),
        fromLocalFile: z.boolean(),
      })
      .passthrough(),
    /** Resolution.recipes, in application order. */
    recipes: z.array(z.string()),
    /** slot → recipe, for the resolved recipes that declare one. */
    stack: z.record(z.string()),
    targets: z.array(z.string()),
    /** ISO time of the last writing sync here. */
    lastSync: z.string(),
  })
  .passthrough();

/** A person's consent, typed on this machine, for `craftar mcp --allow-writes` to write one workspace (spec 40 §3, §5.2). */
export const WriteConsentSchema = z
  .object({
    /** The workspace's native real path, compared with `samePath`. */
    path: z.string(),
    /** The Forge the consent was given for, as the configuration named it. */
    forge: z.object({ source: z.string(), ref: z.string().nullable() }),
    profile: z.string(),
    /** ISO time of the consent. */
    grantedAt: z.string(),
  })
  .passthrough();
export type WriteConsent = z.infer<typeof WriteConsentSchema>;

export const RegistrySchema = z
  .object({
    schema: z.literal(1),
    workspaces: z.array(RegistryEntrySchema),
    writeConsent: z.array(WriteConsentSchema).optional(),
  })
  .passthrough();
/** Registry schemas this craftar reads; anything else is refused by name. */
export const REGISTRY_SCHEMAS: readonly unknown[] = [1];
export type Registry = z.infer<typeof RegistrySchema>;
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

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

/** A hunk may also become a parameter (spec 09) or a section (spec 12); a one-sided file entry keeps TakeSchema. */
export const HunkTakeSchema = z.enum(["base", "variant", "param", "section", "keep"]);
export type HunkTake = z.infer<typeof HunkTakeSchema>;

export const PlanParamSchema = z
  .object({ token: z.string().min(1), key: z.string().regex(PARAM_KEY, "a param key is letters, digits, _ and .") })
  .strict();
export type PlanParam = z.infer<typeof PlanParamSchema>;

/** A section a hunk becomes (spec 12 §4.1). Read only when take is "section". */
export const PlanSectionSchema = z
  .object({
    name: z.string().regex(SECTION_NAME, "a section name is slug-like"),
    /** Base line numbers, 1-based and inclusive: widens the section over equal base lines (spec 12 §6.2). */
    lines: z.string().regex(/^[1-9][0-9]*-[1-9][0-9]*$/, 'lines is "<from>-<to>"').optional(),
  })
  .strict();
export type PlanSection = z.infer<typeof PlanSectionSchema>;

export const PlanHunkSchema = z.object({
  hunk: z.number().int().positive(),
  /** Human echo of what `forge diff` printed. Never read back. */
  at: z.string().default(""),
  take: HunkTakeSchema,
  /** Read only when take is "param" (spec 09 §4.1). */
  params: z.array(PlanParamSchema).optional(),
  /** Read only when take is "section" (spec 12 §4.1). */
  section: PlanSectionSchema.optional(),
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
