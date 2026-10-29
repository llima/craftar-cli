/**
 * MCP server rendering and credential checking (spec 34).
 * The one place a server is rendered or scanned for placeholders.
 */

import type { Ingredient, McpServer } from "../schema/index.js";
import { FORGE_SCHEMA_SERVER_PARAMS } from "../schema/index.js";
import { findSecrets, looksLikeSecretValue, secretValueKind } from "./secrets.js";
import { urlCredentialIn } from "./remote.js";

type McpMeta = Extract<Ingredient, { type: "mcp" }>;

/** The placeholder pattern, same as `substitute`'s in resolve.ts. */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/**
 * A YAML alias can make an object refer back to itself, and a walk would not end. Worded as `fingerprintOf` words it, behind
 * the ingredient's ref — as every message about a server or a registration starts.
 */
const cyclic = (ref: string) => new Error(`${ref}: ingredient metadata is cyclic (a YAML alias refers back to itself)`);

/** Whether this Forge's servers are rendered (spec 34 §4.1: schema 4 or above). */
export function rendersServers(manifest: { schema: number }): boolean {
  return manifest.schema >= FORGE_SCHEMA_SERVER_PARAMS;
}

/** A leaf that was substituted: its path, its top-level key, and its rendered value. */
export interface SubstitutedLeaf {
  path: string;
  under: string;
  value: string;
}

/** The result of renderLeaves: the rendered value and the four cases (spec 43 §7.2). */
export interface RenderedLeaves {
  value: unknown;
  missing: string[];
  undeclared: string[];
  substituted: SubstitutedLeaf[];
}

export interface RenderedServer {
  server: McpServer;
  missing: string[];
  undeclared: string[];
  substituted: SubstitutedLeaf[];
}

/**
 * Walk an object, substituting string leaves. Returns the same object when nothing changed,
 * a new object (on null prototype) when something did. The one walk for servers and registrations.
 *
 * The four cases (spec 34 §6, spec 43 §4.3):
 * - declared and valued → substituted
 * - declared, no value → left, added to missing
 * - undeclared, valued → left, added to undeclared
 * - undeclared, no value → left, silent
 */
export function renderLeaves(
  value: unknown,
  declared: Record<string, unknown>,
  params: Record<string, unknown>,
  ref: string,
): RenderedLeaves {
  const missing: string[] = [];
  const undeclared: string[] = [];
  const substituted: SubstitutedLeaf[] = [];
  const missingSeen = new Set<string>();
  const undeclaredSeen = new Set<string>();

  const ancestors = new Set<object>();
  function walk(v: unknown, path: string, under: string): unknown {
    if (typeof v === "string") {
      let changed = false;
      // One replace per leaf, no second pass on substituted text.
      const result = v.replace(PLACEHOLDER, (match, key: string) => {
        // Own properties only — never follow a prototype.
        const isDeclared = Object.hasOwn(declared, key);
        const isValued = Object.hasOwn(params, key);

        if (isDeclared && isValued) {
          // Declared and valued → substitute
          changed = true;
          return String(params[key]);
        }
        if (isDeclared && !isValued) {
          // Declared, no value → left, added to missing
          if (!missingSeen.has(key)) {
            missingSeen.add(key);
            missing.push(key);
          }
          return match;
        }
        if (!isDeclared && isValued) {
          // Undeclared, valued → left, added to undeclared
          if (!undeclaredSeen.has(key)) {
            undeclaredSeen.add(key);
            undeclared.push(key);
          }
          return match;
        }
        // Undeclared, no value → left, said nowhere
        return match;
      });

      if (changed) {
        substituted.push({ path, under, value: result });
        return result;
      }
      return v;
    }

    if (v === null || typeof v !== "object") return v; // numbers, booleans, null — as they are
    if (ancestors.has(v)) throw cyclic(ref);
    ancestors.add(v);
    try {
      return Array.isArray(v) ? walkArray(v, path, under) : walkObject(v as Record<string, unknown>, path, under);
    } finally {
      ancestors.delete(v);
    }
  }

  function walkArray(arr: unknown[], path: string, under: string): unknown {
    let changed = false;
    const items: unknown[] = [];
    for (let i = 0; i < arr.length; i++) {
      const item = walk(arr[i], `${path}[${i}]`, under);
      items.push(item);
      if (item !== arr[i]) changed = true;
    }
    return changed ? items : arr;
  }

  function walkObject(obj: Record<string, unknown>, path: string, under: string): unknown {
    let changed = false;
    // A null prototype, so a `__proto__` key stays an entry; own enumerable keys only, in the source's order.
    const result: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(obj)) {
      const v = walk(obj[k], path ? `${path}.${k}` : k, path ? under : k);
      result[k] = v;
      if (v !== obj[k]) changed = true;
    }
    return changed ? result : obj;
  }

  const rendered = walk(value, "", "");

  return {
    value: rendered,
    missing,
    undeclared,
    substituted,
  };
}

/**
 * Render an MCP server by substituting its declared params.
 * Returns the same object when nothing is substituted.
 */
export function renderServer(meta: McpMeta, params: Record<string, unknown>): RenderedServer {
  const declared: Record<string, unknown> = meta.params ?? {};
  const ref = `${meta.type}/${meta.name}`;
  const result = renderLeaves(meta.server, declared, params, ref);

  return {
    server: result.value as McpServer,
    missing: result.missing,
    undeclared: result.undeclared,
    substituted: result.substituted,
  };
}

/** The keys an object's string values cite, once each, in the object's own order, depth first. */
export function citationsIn(
  value: unknown,
  declared: Record<string, unknown>,
  ref: string,
): Array<{ key: string; declared: boolean }> {
  const result: Array<{ key: string; declared: boolean }> = [];
  const seen = new Set<string>();
  const ancestors = new Set<object>();

  function walk(v: unknown): void {
    if (typeof v === "string") {
      // Find all placeholders in this string
      let match: RegExpExecArray | null;
      const re = new RegExp(PLACEHOLDER.source, "g");
      while ((match = re.exec(v)) !== null) {
        const key = match[1];
        if (!seen.has(key)) {
          seen.add(key);
          result.push({ key, declared: Object.hasOwn(declared, key) });
        }
      }
      return;
    }

    if (v === null || typeof v !== "object") return;
    if (ancestors.has(v)) throw cyclic(ref);
    ancestors.add(v);
    // Walk values only, not keys (keys are never scanned for placeholders)
    for (const val of Array.isArray(v) ? v : Object.keys(v).map((k) => (v as Record<string, unknown>)[k])) walk(val);
    ancestors.delete(v);
  }

  walk(value);
  return result;
}

/** The keys a server's string values cite, once each, in the server's own order, depth first. [] for a non-mcp ingredient. */
export function serverCitations(meta: Ingredient): Array<{ key: string; declared: boolean }> {
  if (meta.type !== "mcp") return [];

  const declared: Record<string, unknown> = meta.params ?? {};
  const ref = `${meta.type}/${meta.name}`;
  return citationsIn(meta.server, declared, ref);
}

export interface ServerFinding {
  path: string;
  kind: string;
}

/**
 * Check the substituted leaves of a rendered server for credentials.
 * Row U (URL credentials) is tried before row T (token patterns).
 * Row E (entropy) applies only to leaves under `env` or `args`.
 */
export function credentialIn(substituted: SubstitutedLeaf[]): { error: ServerFinding | null; warnings: ServerFinding[] } {
  const warnings: ServerFinding[] = [];

  for (const leaf of substituted) {
    // Row U: URL with credentials (tried before row T)
    if (urlCredentialIn(leaf.value)) {
      return { error: { path: leaf.path, kind: "url-credentials" }, warnings: [] };
    }

    // Row T: Token of a known format
    const tokenHit = findSecrets(leaf.value)[0];
    if (tokenHit) {
      return { error: { path: leaf.path, kind: tokenHit.kind }, warnings: [] };
    }

    // Row E: High-entropy value, only under env or args
    if ((leaf.under === "env" || leaf.under === "args") && looksLikeSecretValue(leaf.value)) {
      warnings.push({ path: leaf.path, kind: "high-entropy-value" });
    }
  }

  return { error: null, warnings };
}

/** Options for credential and entropy messages. */
export interface MessageOptions {
  prefix?: string;
  remedy?: string;
}

const DEFAULT_PREFIX = "server.";
const DEFAULT_REMEDY = "have the server read it from the environment";

/** Build the error message for a credential found in a rendered value. */
export function credentialMessage(ref: string, f: ServerFinding, options?: MessageOptions): string {
  const prefix = options?.prefix ?? DEFAULT_PREFIX;
  const remedy = options?.remedy ?? DEFAULT_REMEDY;
  // Row U gets a different verb ("holds a URL with credentials") than row T ("looks like a credential")
  if (f.kind === "url-credentials") {
    return `${ref}: the value rendered into ${prefix}${f.path} holds a URL with credentials (${f.kind}) — a generated file is committed, so a secret cannot come from a param; ${remedy}`;
  }
  return `${ref}: the value rendered into ${prefix}${f.path} looks like a credential (${f.kind}) — a generated file is committed, so a secret cannot come from a param; ${remedy}`;
}

/** Build the warning message for a high-entropy value (row E). */
export function entropyMessage(ref: string, f: ServerFinding, options?: MessageOptions): string {
  const prefix = options?.prefix ?? DEFAULT_PREFIX;
  const remedy = options?.remedy ?? DEFAULT_REMEDY;
  return `${ref}: the value rendered into ${prefix}${f.path} may be a secret (${f.kind}) — a generated file is committed; if it is one, ${remedy}`;
}

/** Build the warning message for an undeclared key with a value. */
export function undeclaredMessage(ref: string, key: string, subject = "server"): string {
  return `${ref}: ${subject} cites {{${key}}}, which has a value but is not declared in the ingredient's params — left verbatim`;
}

/** Import's scan of a server it read (moved from the importer, messages unchanged). */
export function serverSecret(serverName: string, server: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(server)) {
    const hit = secretInServerField(serverName, key, value, key === "env" || key === "args");
    if (hit) return hit;
  }
  return null;
}

/** Recursively scan one MCP server field for a secret-like value, building a dotted/bracketed field path. */
function secretInServerField(server: string, field: string, value: unknown, useEntropy: boolean): string | null {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const hit = secretInServerField(server, `${field}[${i}]`, v, useEntropy);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const hit = secretInServerField(server, `${field}.${k}`, v, useEntropy);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value !== "string" && typeof value !== "number") return null;
  const kind = useEntropy ? secretValueKind(String(value)) : (findSecrets(String(value))[0]?.kind ?? null);
  return kind ? `secret-like value (${kind}) in .mcp.json → mcpServers.${server}.${field}` : null;
}

/** Whether `unify`'s kept-variant warning gets its second line (spec 34 §5.2). */
export function holdsBaseCitations(base: Ingredient, variant: Ingredient): boolean {
  // Both must be mcp
  if (base.type !== "mcp" || variant.type !== "mcp") return false;

  // The base must declare at least one key
  const baseParams = base.params;
  if (!baseParams || Object.keys(baseParams).length === 0) return false;

  // The variant must have no params key (undefined, not empty {})
  if (variant.params !== undefined) return false;

  // A key the variant's server cites must be one of the base's declared keys
  const variantCitations = serverCitations(variant);
  const baseDeclared = new Set(Object.keys(baseParams));

  for (const cite of variantCitations) {
    if (baseDeclared.has(cite.key)) return true;
  }

  return false;
}

/**
 * A written MCP server that starts through `cmd /c` or `cmd /k` (spec 42 §3): `command`, read as a file name (after the
 * last `/` or `\`, without case, a trailing `.exe` dropped), is `cmd`, and the first `args` item, without case, is `/c`
 * or `/k`. The one test of that shape. Pure; a plain object only.
 */
export function windowsOnlyLauncher(server: unknown): "c" | "k" | null {
  if (server === null || typeof server !== "object" || Array.isArray(server)) return null;
  const s = server as Record<string, unknown>;
  if (typeof s.command !== "string") return null;
  if (!Array.isArray(s.args) || s.args.length === 0 || typeof s.args[0] !== "string") return null;

  // Extract file name: after the last `/` or `\`
  const command = s.command;
  const lastSep = Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\"));
  let fileName = lastSep >= 0 ? command.slice(lastSep + 1) : command;

  // Strip trailing `.exe` (case insensitive)
  if (fileName.toLowerCase().endsWith(".exe")) {
    fileName = fileName.slice(0, -4);
  }

  // Check that the file name is exactly `cmd` (case insensitive)
  if (fileName.toLowerCase() !== "cmd") return null;

  // Check the first arg is `/c` or `/k` (case insensitive)
  const firstArg = (s.args[0] as string).toLowerCase();
  if (firstArg === "/c") return "c";
  if (firstArg === "/k") return "k";
  return null;
}

export const LAUNCHER_OK = "no written MCP server is Windows-only";

export function launcherWarning(server: string, letter: "c" | "k", files: readonly string[]): string {
  return `server "${server}" starts through cmd /${letter} \u2014 Windows only; it does not start on Linux or macOS (${files.join(", ")})`;
}

export function launcherFix(letter: "c" | "k"): string {
  return `in the Forge, write the program cmd runs as the server's command and drop "cmd" and "/${letter}" (spec 42)`;
}

export function launcherImportWarning(server: string, letter: "c" | "k"): string {
  return `.mcp.json server "${server}" starts through cmd /${letter} \u2014 Windows only; the ingredient keeps it as written (spec 42)`;
}
