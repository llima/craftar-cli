/**
 * Project templates declared in a profile (spec 32 §5).
 * `declaredTemplates` is the one reader of `profile.templates`.
 * This module returns data and throws; it never prints.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DotnetNewTemplateSchema, TEMPLATE_RULES, TemplatesSchema } from "../schema/index.js";
import { credentialFault } from "./remote.js";
import { exists } from "./forge.js";
import { schemaIssues } from "./schema-fault.js";
import { capture as defaultCapture, type Probe, type Runner } from "./proc.js";

const CREDENTIAL = "a source must not carry a user or a password: NuGet's own configuration holds credentials";

/** The missing-SDK finding and its fix: one spelling for `templates install` and doctor's `dotnet` check. */
export const DOTNET_MISSING = "the .NET SDK is not available: dotnet --version gave no version";
export const DOTNET_MISSING_FIX = "install the .NET SDK (the version a global.json at the workspace root pins, if there is one) and check PATH";

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

/** The phrase for an entry this craftar cannot install (one spelling for the warning and doctor). */
export const notInstalled = (kind: string) => `kind "${kind}" is not installed by this craftar`;

const unknownKind = (kind: string) => `templates: ${notInstalled(kind)} — skipped`;

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

/** Build the argv for `dotnet new install`. */
export function installArgv(e: DotnetNewEntry, opts?: { force?: boolean; interactive?: boolean }): string[] {
  const argv = ["new", "install"];
  for (const pkg of e.packages) {
    argv.push(pkg.version !== null ? `${pkg.id}::${pkg.version}` : pkg.id);
  }
  if (e.source !== null) {
    argv.push("--add-source", e.source);
  }
  if (opts?.force) argv.push("--force");
  if (opts?.interactive) argv.push("--interactive");
  return argv;
}

/** "dotnet " + argv.join(" ") */
export function installLine(argv: string[]): string {
  return `dotnet ${argv.join(" ")}`;
}

/** Declared package IDs that exist at `root` as anything (lstat), in declaration order, once each. */
export async function rootCollisions(entries: DeclaredEntry[], root: string): Promise<string[]> {
  const seen = new Set<string>();
  const collisions: string[] = [];
  for (const e of entries) {
    if (!e.installable) continue;
    for (const pkg of e.packages) {
      if (seen.has(pkg.id)) continue;
      seen.add(pkg.id);
      try {
        await fs.lstat(path.join(root, pkg.id));
        collisions.push(pkg.id);
      } catch {
        // does not exist, no collision
      }
    }
  }
  return collisions;
}

/** Positions of the entries that declare a `source`, when `root` holds no file named NuGet.Config (any case); else []. */
export async function unpinnedSources(entries: DeclaredEntry[], root: string): Promise<number[]> {
  const withSource = entries.filter((e): e is DotnetNewEntry => e.installable && e.source !== null);
  if (withSource.length === 0) return [];

  let files: string[];
  try {
    files = await fs.readdir(root);
  } catch {
    files = [];
  }
  const hasNugetConfig = files.some((f) => f.toLowerCase() === "nuget.config");
  if (hasNugetConfig) return [];

  return withSource.map((e) => e.entry);
}

/** messages.md §5, without a prefix: the CLI's line and doctor's message are this text. */
export function feedMessage(positions: number[]): string {
  const pos = positions.map((p) => `templates[${p}]`).join(", ");
  return `a source is declared (${pos}) and the workspace root has no NuGet.Config — dotnet adds a declared source to the feeds it already uses, it does not replace them (craftar looks at the workspace root only; NuGet also reads parent directories and the user's configuration)`;
}

export interface InstallOptions {
  dryRun?: boolean;
  force?: boolean;
  interactive?: boolean;
  env: NodeJS.ProcessEnv;
  announce?: (entry: number, line: string) => void;
}

export interface InstallResult {
  lines: Array<{ entry: number; line: string }>;
  installed: number[];
  failed: Array<{ entry: number; code: number | null }>;
  skipped: number[];
}

export interface InstallReport {
  out: string[];
  err: string[];
  exitCode: 0 | 1;
}

/** What `install` prints after its runs, and its exit code (spec 32 §4.2 step 5). */
export function installReport(result: InstallResult, dryRun: boolean): InstallReport {
  const store = "into the dotnet template store of this user (remove a package with: dotnet new uninstall <package>)";
  if (dryRun) {
    return {
      err: [],
      out: [...result.lines.map((l) => l.line), `dry run: ${result.lines.length} would run, ${result.skipped.length} skipped — nothing installed`],
      exitCode: 0,
    };
  }
  const err: string[] = [];
  for (const f of result.failed) {
    const msg = f.code === null ? "dotnet did not exit" : `dotnet exited ${f.code}`;
    err.push(`templates[${f.entry}] failed — ${msg}`);
  }
  const out = [`templates: ${result.installed.length} installed, ${result.failed.length} failed, ${result.skipped.length} skipped — ${store}`];
  const exitCode: 0 | 1 = result.failed.length > 0 || result.skipped.length > 0 ? 1 : 0;
  return { err, out, exitCode };
}

/** Throws messages.md §4 before any run when an ID collides — `dryRun` included. */
export async function installTemplates(entries: DeclaredEntry[], root: string, opts: InstallOptions, run: Runner): Promise<InstallResult> {
  const collisions = await rootCollisions(entries, root);
  if (collisions.length > 0) {
    throw new Error(`a file or folder named like a declared package exists at the workspace root (${collisions.join(", ")}) — dotnet would install it instead of the feed's package; nothing installed`);
  }

  const lines: Array<{ entry: number; line: string }> = [];
  const installed: number[] = [];
  const failed: Array<{ entry: number; code: number | null }> = [];
  const skipped: number[] = [];

  for (const e of entries) {
    if (!e.installable) {
      skipped.push(e.entry);
      continue;
    }

    const argv = installArgv(e, { force: opts.force, interactive: opts.interactive });
    const line = installLine(argv);
    lines.push({ entry: e.entry, line });

    if (opts.dryRun) continue;

    opts.announce?.(e.entry, line);
    try {
      const result = await run({
        file: "dotnet",
        args: argv,
        cwd: root,
        env: { ...opts.env, DOTNET_NOLOGO: "1" },
        stdin: opts.interactive ? "inherit" : "ignore",
      });

      if (result.code === 0) {
        installed.push(e.entry);
      } else {
        failed.push({ entry: e.entry, code: result.code });
      }
    } catch {
      // The program could not start — the next entry still runs.
      failed.push({ entry: e.entry, code: null });
    }
  }

  return { lines, installed, failed, skipped };
}

/** The `dotnet` check of the `doctor` tool of `craftar mcp` when the probe's directory cannot be prepared: the SDK was not looked at. */
export const DOTNET_PROBE_DIR_FAILED = "dotnet was not checked: no directory could be prepared to run it in";
export const DOTNET_PROBE_DIR_FIX = "check that the temporary directory can be written";

/**
 * `dotnetVersion` in a new directory of its own under the temporary directory, removed afterwards. The host
 * reads the first `global.json` going up from its working directory and loads what its `sdk.paths` names; the
 * `{}` here stops the walk and pins no version. `ran: false` means no probe ran: never a run elsewhere.
 */
export async function dotnetVersionInOwnDir(probe: Probe = defaultCapture, env: NodeJS.ProcessEnv = process.env): Promise<{ ran: false } | { ran: true; version: string | null }> {
  let dir: string | null = null;
  try {
    try {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-dotnet-"));
      await fs.writeFile(path.join(dir, "global.json"), "{}", { flag: "wx" });
    } catch {
      return { ran: false };
    }
    return { ran: true, version: await dotnetVersion(probe, env, dir) };
  } finally {
    if (dir !== null) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}

/**
 * The SDK's version, or null (D5). Probed in `cwd` (the workspace root) because `dotnet` reads
 * `global.json` from its working directory — the install runs there.
 */
export async function dotnetVersion(probe: Probe = defaultCapture, env: NodeJS.ProcessEnv = process.env, cwd?: string): Promise<string | null> {
  try {
    const stdout = await probe("dotnet", ["--version"], { ...env, DOTNET_NOLOGO: "1" }, cwd);
    for (const raw of stdout.split("\n")) {
      const line = raw.trim();
      if (/^\d+\.\d+\.\d+/.test(line)) return line;
    }
    return null;
  } catch {
    return null;
  }
}
