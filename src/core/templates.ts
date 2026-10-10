/**
 * Project templates declared in a profile (spec 32 §5).
 * `declaredTemplates` is the one reader of `profile.templates`.
 * This module returns data and throws; it never prints.
 */
import path from "node:path";
import { DotnetNewTemplateSchema, TEMPLATE_RULES, TemplatesSchema } from "../schema/index.js";
import { credentialFault } from "./remote.js";
import { exists } from "./forge.js";
import { schemaIssues } from "./schema-fault.js";

const CREDENTIAL = "a source must not carry a user or a password: NuGet's own configuration holds credentials";

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

const position = (p: Array<string | number>) => "templates" + p.map((x) => (typeof x === "number" ? `[${x}]` : `.${x}`)).join("");

const unknownKind = (kind: string) => `templates: kind "${kind}" is not installed by this craftar — skipped`;

/** The one reader of `profile.templates` (spec 32 §8). Throws the refusal of messages.md §2. */
export function declaredTemplates(profile: { name: string; templates?: unknown }, label: string): Declared {
  if (profile.templates === undefined || profile.templates === null) {
    return { declared: false, entries: [], warnings: [] };
  }

  const parsed = TemplatesSchema.safeParse(profile.templates);
  if (!parsed.success) {
    const issues = schemaIssues(parsed.error);
    const pos = position(parsed.error.issues[0].path);
    const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : "";
    if (parsed.error.issues[0].path.length === 0) {
      const hint = `  templates:\n    - kind: dotnet-new\n      packages: [Example.Templates.Api]`;
      throw new Error(`${label}: ${pos} — ${issues[0].text}\n${hint}`);
    }
    throw new Error(`${label}: ${pos} — ${issues[0].text}${more}`);
  }

  const entries: DeclaredEntry[] = [];
  const warnings: string[] = [];

  for (let entry = 0; entry < parsed.data.length; entry++) {
    const raw = parsed.data[entry];
    const kind = String((raw as Record<string, unknown>).kind);

    if (kind !== "dotnet-new") {
      entries.push({ entry, kind, installable: false });
      warnings.push(unknownKind(kind));
      continue;
    }

    // The list schema already accepted this entry; this cannot fail
    const r = DotnetNewTemplateSchema.safeParse(raw);
    if (!r.success) throw new Error(`${label}: templates[${entry}] — ${TEMPLATE_RULES.entry}`);

    if (r.data.source !== undefined && credentialFault(r.data.source)) {
      throw new Error(`${label}: templates[${entry}].source — ${CREDENTIAL}`);
    }

    const packages = r.data.packages.map((pkg) => {
      const idx = pkg.indexOf("::");
      return idx === -1 ? { id: pkg, version: null } : { id: pkg.slice(0, idx), version: pkg.slice(idx + 2) };
    });
    entries.push({ entry, kind: "dotnet-new", installable: true, packages, source: r.data.source ?? null });
  }

  return { declared: true, entries, warnings };
}

/** Flatten entries to rows for `templates list --json`. */
export function templateRows(entries: DeclaredEntry[]): TemplateRow[] {
  return entries.flatMap((e): TemplateRow[] =>
    e.installable
      ? e.packages.map((pkg) => ({ entry: e.entry, kind: e.kind, package: pkg.id, version: pkg.version, source: e.source, installable: true as const }))
      : [{ entry: e.entry, kind: e.kind, package: null, version: null, source: null, installable: false as const }]
  );
}

/** D9: the Forge-relative file when the directory carries the profile's name, else a description. */
export async function profileLabel(forgeRoot: string, name: string): Promise<string> {
  return (await exists(path.join(forgeRoot, "profiles", name, "profile.yaml")))
    ? `profiles/${name}/profile.yaml`
    : `the profile.yaml of profile ${name}`;
}
