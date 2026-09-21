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
 * fingerprints — and the unify plans that record them — do not move.
 */
function sortedDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortedDeep);
  if (v !== null && typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v; // Date and friends keep their toJSON
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortedDeep((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

export async function fingerprintDir(dir: string): Promise<string> {
  const meta = YAML.parse(await fs.readFile(path.join(dir, "ingredient.yaml"), "utf8"));
  const files: Record<string, Buffer> = {};
  for (const rel of await listFiles(dir)) if (rel !== "ingredient.yaml") files[rel] = await fs.readFile(path.join(dir, rel));
  return fingerprintOf(meta, files);
}
