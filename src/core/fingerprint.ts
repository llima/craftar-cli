import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { hashNormalized } from "./text.js";
import { listFiles } from "./forge.js";

/**
 * Identity of an ingredient's content: metadata minus the fields a variant
 * necessarily changes, plus every file hashed through `hashNormalized`.
 * Shared by `craftar import` (reuse or variant) and `forge variants` (distance).
 */
export function fingerprintOf(meta: unknown, files: Record<string, string | Buffer>): string {
  const m: Record<string, unknown> = { ...(meta as Record<string, unknown>) };
  delete m.origin;
  delete m.name;
  delete m.as;
  const parts = [JSON.stringify(sortedDeep(m))];
  for (const k of Object.keys(files).sort()) parts.push(k, hashNormalized(files[k]));
  return hashNormalized(parts.join("\0"));
}

/**
 * A copy of `v` with object keys sorted at every depth, so `JSON.stringify` of it is canonical.
 * Not `JSON.stringify(v, sortedKeys)`: a replacer array filters keys at every depth, which hashed
 * an MCP `server: { command, args, env }` as `{}` and made two different servers look identical.
 * For metadata with no nested object the output is byte-identical to that form, so those
 * fingerprints — and the unify plans that record them — do not move. (One exception: integer-like
 * keys, which only a hand-added unknown field can introduce, now follow the engine's numeric-first
 * key order instead of the replacer's lexicographic one. The result is still canonical.)
 * A YAML alias can make the parsed metadata cyclic; that is refused rather than overflowing.
 */
function sortedDeep(v: unknown, ancestors: Set<object> = new Set()): unknown {
  if (v === null || typeof v !== "object") return v;
  if (ancestors.has(v)) throw new Error("ingredient metadata is cyclic (a YAML alias refers back to itself)");
  if (Array.isArray(v)) {
    ancestors.add(v);
    const out = v.map((x) => sortedDeep(x, ancestors));
    ancestors.delete(v);
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v; // Date and friends keep their toJSON
  ancestors.add(v);
  // A null prototype, so a `__proto__` key is an ordinary key instead of setting the prototype.
  const out: Record<string, unknown> = Object.create(null);
  for (const k of Object.keys(v).sort()) out[k] = sortedDeep((v as Record<string, unknown>)[k], ancestors);
  ancestors.delete(v);
  return out;
}

export async function fingerprintDir(dir: string): Promise<string> {
  const metaFile = path.join(dir, "ingredient.yaml");
  const meta = YAML.parse(await fs.readFile(metaFile, "utf8"));
  const files: Record<string, Buffer> = {};
  for (const rel of await listFiles(dir)) if (rel !== "ingredient.yaml") files[rel] = await fs.readFile(path.join(dir, rel));
  try {
    return fingerprintOf(meta, files);
  } catch (e) {
    throw new Error(`${metaFile}: ${(e as Error).message}`);
  }
}
