import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Spec 50 §5.3: `ctx.meta(ing)` (and `metaFor` in the rules index's builder, which has no ctx) is the one reader of the
 * metadata fields of §5.2 in the emitters. A second reader would write a field as the Forge holds it at the gate.
 */

const DIR = path.join(import.meta.dirname, "..", "src", "emitters");
const FIELD =
  /\.meta\.(frontmatterRaw|fileMatchPattern|description|argumentHint)\b|\.meta\[\s*["'`](frontmatterRaw|fileMatchPattern|description|argumentHint)|\{[^}]*\b(frontmatterRaw|fileMatchPattern|description|argumentHint)\b[^}]*\}\s*=\s*[\w$.]+\.meta\b/;
const ALIAS = /=\s*([A-Za-z_$][\w$]*)\.meta\s*;/;

/**
 * The aliases of an ingredient's raw metadata the emitters keep, each read for something other than a field of §5.2:
 * agents-md's type switch, a hook's registration, a skill's layout.
 */
const KNOWN_ALIASES = ["agents-md.ts: const m = ing.meta;", "shared.ts: const meta = ing.meta;", "shared.ts: const meta = ing.meta;"];

async function scan() {
  const fields: string[] = [];
  const aliases: string[] = [];
  for (const name of (await fs.readdir(DIR)).filter((n) => n.endsWith(".ts")).sort()) {
    const lines = (await fs.readFile(path.join(DIR, name), "utf8")).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (FIELD.test(line)) fields.push(`${name}:${i + 1}: ${line.trim()}`);
      if (ALIAS.test(line)) aliases.push(`${name}: ${line.trim()}`);
    });
  }
  return { fields, aliases };
}

describe("spec 50 §5.3: one reader of the metadata fields in src/emitters/", () => {
  it("no emitter reads a field of §5.2 off an ingredient's raw metadata", async () => {
    expect((await scan()).fields).toEqual([]);
  });

  it("no new alias of an ingredient's raw metadata appears", async () => {
    expect((await scan()).aliases).toEqual(KNOWN_ALIASES);
  });
});
