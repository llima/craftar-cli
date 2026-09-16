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
  const parts = [JSON.stringify(m, Object.keys(m).sort())];
  for (const k of Object.keys(files).sort()) parts.push(k, hashNormalized(files[k]));
  return hashNormalized(parts.join("\0"));
}

export async function fingerprintDir(dir: string): Promise<string> {
  const meta = YAML.parse(await fs.readFile(path.join(dir, "ingredient.yaml"), "utf8"));
  const files: Record<string, Buffer> = {};
  for (const rel of await listFiles(dir)) if (rel !== "ingredient.yaml") files[rel] = await fs.readFile(path.join(dir, rel));
  return fingerprintOf(meta, files);
}
