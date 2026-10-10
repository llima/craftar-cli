import path from "node:path";
import {
  DotnetNewTemplateSchema,
  ENTRY,
  LIST,
  TemplatesSchema,
  type DotnetNewTemplate,
} from "../schema/index.js";
import { credentialFault } from "./remote.js";
import { exists } from "./forge.js";
import { schemaIssues } from "./schema-fault.js";

/* ------------------------------------------------------------------ */
/* Rule message for credentials (messages.md §1)                       */
/* ------------------------------------------------------------------ */

const CREDENTIAL = "a source must not carry a user or a password: NuGet's own configuration holds credentials";

/* ------------------------------------------------------------------ */
/* Types (design.md)                                                    */
/* ------------------------------------------------------------------ */

export interface DotnetNewEntry {
  entry: number;
  kind: "dotnet-new";
  installable: true;
  packages: Array<{ id: string; version: string | null }>;
  source: string | null;
}
export interface OtherEntry {
  entry: number;
  kind: string;
  installable: false;
}
export type DeclaredEntry = DotnetNewEntry | OtherEntry;
export interface Declared {
  declared: boolean;
  entries: DeclaredEntry[];
  warnings: string[];
}

/** One row per package, one per entry this craftar cannot install — `templates list --json` (spec 32 §4.1), keys in this order. */
export interface TemplateRow {
  entry: number;
  kind: string;
  package: string | null;
  version: string | null;
  source: string | null;
  installable: boolean;
}

/* ------------------------------------------------------------------ */
/* declaredTemplates                                                    */
/* ------------------------------------------------------------------ */

const UNKNOWN_KIND = (kind: string) => `templates: kind "${kind}" is not installed by this craftar — skipped`;

/** The one reader of `profile.templates` (spec 32 §8). Throws the refusal of messages.md §2. */
export function declaredTemplates(profile: { name: string; templates?: unknown }, label: string): Declared {
  // 1. Not declared
  if (profile.templates === undefined || profile.templates === null) {
    return { declared: false, entries: [], warnings: [] };
  }

  // 2. Parse through TemplatesSchema
  const parsed = TemplatesSchema.safeParse(profile.templates);
  if (!parsed.success) {
    const rawIssues = parsed.error.issues;
    const rawFirst = rawIssues[0];
    const issues = schemaIssues(parsed.error);
    const first = issues[0];

    // Format the position: numeric path segments become [N], others become .key
    // schemaIssues returns path as "0" or "0.kind" or "0.packages.1" — we need templates[0] or templates[0].kind or templates[0].packages[1]
    // For unrecognized_keys, the path is just the entry index and we need to append the unknown key name
    const formatPosition = (rawPath: string, rawIssue: typeof rawFirst): string => {
      let result = "templates";
      if (rawPath !== "top level") {
        const parts = rawPath.split(".");
        for (const part of parts) {
          if (/^\d+$/.test(part)) {
            result += `[${part}]`;
          } else {
            result += `.${part}`;
          }
        }
      }
      // For unrecognized_keys, append the first unknown key to the path
      if (rawIssue.code === "unrecognized_keys" && Array.isArray(rawIssue.keys) && rawIssue.keys.length > 0) {
        result += `.${rawIssue.keys[0]}`;
      }
      return result;
    };
    const position = formatPosition(first.path, rawFirst);
    const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : "";

    // Check if it's the list-level refusal (the block is not a list)
    if (first.text === LIST) {
      const hint = `  templates:\n    - kind: dotnet-new\n      packages: [Example.Templates.Api]`;
      throw new Error(`${label}: ${position} — ${first.text}\n${hint}`);
    }
    throw new Error(`${label}: ${position} — ${first.text}${more}`);
  }

  // 3. For each dotnet-new entry with a source: credentialFault
  const rawEntries = parsed.data;
  for (let i = 0; i < rawEntries.length; i++) {
    const entry = rawEntries[i] as Record<string, unknown>;
    if (entry.kind === "dotnet-new") {
      // Re-parse with DotnetNewTemplateSchema to get the typed entry
      // (the schema already validated; this cannot fail)
      const r = DotnetNewTemplateSchema.safeParse(entry);
      if (!r.success) {
        throw new Error(`${label}: templates[${i}] — ${ENTRY}`);
      }
      const typed = r.data;
      if (typed.source && credentialFault(typed.source)) {
        throw new Error(`${label}: templates[${i}].source — ${CREDENTIAL}`);
      }
    }
  }

  // 4. Build entries and warnings
  const entries: DeclaredEntry[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < rawEntries.length; i++) {
    const entry = rawEntries[i] as Record<string, unknown>;
    const kind = entry.kind as string;

    if (kind === "dotnet-new") {
      const typed = entry as DotnetNewTemplate;
      const packages = typed.packages.map((pkg) => {
        const idx = pkg.indexOf("::");
        if (idx === -1) return { id: pkg, version: null };
        return { id: pkg.slice(0, idx), version: pkg.slice(idx + 2) };
      });
      entries.push({
        entry: i,
        kind: "dotnet-new",
        installable: true,
        packages,
        source: typed.source ?? null,
      });
    } else {
      // Unknown kind
      entries.push({ entry: i, kind, installable: false });
      warnings.push(UNKNOWN_KIND(kind));
    }
  }

  return { declared: true, entries, warnings };
}

/* ------------------------------------------------------------------ */
/* templateRows                                                         */
/* ------------------------------------------------------------------ */

export function templateRows(entries: DeclaredEntry[]): TemplateRow[] {
  const rows: TemplateRow[] = [];
  for (const e of entries) {
    if (e.installable) {
      for (const pkg of e.packages) {
        rows.push({
          entry: e.entry,
          kind: e.kind,
          package: pkg.id,
          version: pkg.version,
          source: e.source,
          installable: true,
        });
      }
    } else {
      rows.push({
        entry: e.entry,
        kind: e.kind,
        package: null,
        version: null,
        source: null,
        installable: false,
      });
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* profileLabel (D9)                                                    */
/* ------------------------------------------------------------------ */

/** D9: the Forge-relative file when the directory carries the profile's name, else a description. */
export async function profileLabel(forgeRoot: string, name: string): Promise<string> {
  const expected = path.join(forgeRoot, "profiles", name, "profile.yaml");
  if (await exists(expected)) {
    return `profiles/${name}/profile.yaml`;
  }
  return `the profile.yaml of profile ${name}`;
}
