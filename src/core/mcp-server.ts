/**
 * MCP server rendering and credential checking (spec 34).
 * The one place a server is rendered or scanned for placeholders.
 */

import type { ForgeManifest, Ingredient, McpServer } from "../schema/index.js";
import { FORGE_SCHEMA_SERVER_PARAMS } from "../schema/index.js";
import { findSecrets, looksLikeSecretValue, secretValueKind } from "./secrets.js";
import { urlCredentialIn } from "./remote.js";

type McpMeta = Extract<Ingredient, { type: "mcp" }>;

/** The placeholder pattern, same as `substitute`'s in resolve.ts. */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/** Whether this Forge's servers are rendered (spec 34 §4.1: schema 4 or above). */
export function rendersServers(manifest: Pick<ForgeManifest, "schema">): boolean {
  return manifest.schema >= FORGE_SCHEMA_SERVER_PARAMS;
}

/** A leaf that was substituted: its path, its top-level key, and its rendered value. */
export interface SubstitutedLeaf {
  path: string;
  under: string;
  value: string;
}

export interface RenderedServer {
  server: McpServer;
  missing: string[];
  undeclared: string[];
  substituted: SubstitutedLeaf[];
}

/**
 * Render an MCP server by substituting its declared params.
 * Returns the same object when nothing is substituted.
 */
export function renderServer(meta: McpMeta, params: Record<string, unknown>): RenderedServer {
  const declared: Record<string, unknown> = meta.params ?? {};
  const missing: string[] = [];
  const undeclared: string[] = [];
  const substituted: SubstitutedLeaf[] = [];
  const missingSeen = new Set<string>();
  const undeclaredSeen = new Set<string>();

  /**
   * Walk a value, substituting string leaves. Returns the same object when nothing changed,
   * a new object (on null prototype) when something did.
   */
  function walk(value: unknown, path: string, under: string): unknown {
    if (typeof value === "string") {
      let changed = false;
      // One replace per leaf, no second pass on substituted text.
      const result = value.replace(PLACEHOLDER, (match, key: string) => {
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
      return value;
    }

    if (Array.isArray(value)) {
      let changed = false;
      const items: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        const newItem = walk(item, `${path}[${i}]`, under);
        items.push(newItem);
        if (newItem !== item) changed = true;
      }
      return changed ? items : value;
    }

    if (value !== null && typeof value === "object") {
      let changed = false;
      // Create with null prototype so __proto__ stays an entry
      const result: Record<string, unknown> = Object.create(null);
      // Enumerate with Object.keys (own enumerable keys) — never follows prototype
      for (const k of Object.keys(value)) {
        const v = (value as Record<string, unknown>)[k];
        const newPath = path ? `${path}.${k}` : k;
        const newV = walk(v, newPath, path ? under : k);
        result[k] = newV;
        if (newV !== v) changed = true;
      }
      return changed ? result : value;
    }

    // Numbers, booleans, null — returned as they are
    return value;
  }

  const server = walk(meta.server, "", "") as McpServer;

  return {
    server,
    missing,
    undeclared,
    substituted,
  };
}

/** The keys a server's string values cite, once each, in the server's own order, depth first. [] for a non-mcp ingredient. */
export function serverCitations(meta: Ingredient): Array<{ key: string; declared: boolean }> {
  if (meta.type !== "mcp") return [];

  const declared: Record<string, unknown> = meta.params ?? {};
  const result: Array<{ key: string; declared: boolean }> = [];
  const seen = new Set<string>();

  function walk(value: unknown): void {
    if (typeof value === "string") {
      // Find all placeholders in this string
      let match: RegExpExecArray | null;
      const re = new RegExp(PLACEHOLDER.source, "g");
      while ((match = re.exec(value)) !== null) {
        const key = match[1];
        if (!seen.has(key)) {
          seen.add(key);
          result.push({ key, declared: Object.hasOwn(declared, key) });
        }
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }

    if (value !== null && typeof value === "object") {
      // Walk values only, not keys (keys are never scanned for placeholders)
      for (const k of Object.keys(value)) {
        walk((value as Record<string, unknown>)[k]);
      }
    }
  }

  walk(meta.server);
  return result;
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

/** Build the error message for a credential found in a rendered server. */
export function credentialMessage(ref: string, f: ServerFinding): string {
  // Row U gets a different verb ("holds a URL with credentials") than row T ("looks like a credential")
  if (f.kind === "url-credentials") {
    return `${ref}: the value rendered into server.${f.path} holds a URL with credentials (${f.kind}) — a generated file is committed, so a secret cannot come from a param; have the server read it from the environment`;
  }
  return `${ref}: the value rendered into server.${f.path} looks like a credential (${f.kind}) — a generated file is committed, so a secret cannot come from a param; have the server read it from the environment`;
}

/** Build the warning message for a high-entropy value (row E). */
export function entropyMessage(ref: string, f: ServerFinding): string {
  return `${ref}: the value rendered into server.${f.path} may be a secret (${f.kind}) — a generated file is committed; if it is one, have the server read it from the environment`;
}

/** Build the warning message for an undeclared key with a value. */
export function undeclaredMessage(ref: string, key: string): string {
  return `${ref}: server cites {{${key}}}, which has a value but is not declared in the ingredient's params — left verbatim`;
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
