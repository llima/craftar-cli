import { isDeepStrictEqual } from "node:util";
import { FORGE_SCHEMA_SECTIONS, ForgeManifestSchema } from "../schema/index.js";
import { editYamlText } from "./yaml-edit.js";
import { parseYamlText, yamlFault } from "./yaml-read.js";

/**
 * `craftar.forge.yaml` with `schema: 2` (spec 11 §6.14; spec 12 §6.7), edited in place through the
 * round-trip gate, or null when it already declares 2. Throws `<command>: cannot edit craftar.forge.yaml
 * in place (<why>) — set schema: 2 by hand, commit, and re-run`.
 */
export function manifestWithSections(raw: string, command: "import" | "unify"): string | null {
  const refuse = (why: string) =>
    new Error(`${command}: cannot edit craftar.forge.yaml in place (${why}) — set schema: ${FORGE_SCHEMA_SECTIONS} by hand, commit, and re-run`);

  let before: unknown;
  try {
    before = parseYamlText("craftar.forge.yaml", raw);
  } catch (e) {
    throw refuse(`it does not parse: ${yamlFault(e)}`);
  }

  // Unreachable while forgeBefore/loadForge loads the manifest through its schema first; kept so the edit never assumes it.
  if (before === null || typeof before !== "object" || Array.isArray(before)) {
    throw refuse("it is not a YAML mapping");
  }

  if ((before as { schema?: unknown }).schema === FORGE_SCHEMA_SECTIONS) {
    return null;
  }

  let content: string;
  try {
    content = editYamlText(raw, { command, label: "craftar.forge.yaml", keys: ["schema"] }, (doc) => doc.set("schema", FORGE_SCHEMA_SECTIONS));
  } catch (e) {
    throw refuse((e as Error).message.replace(/^.*in place \((.*)\) — .*$/s, "$1"));
  }

  const after = parseYamlText("craftar.forge.yaml", content);
  if (!ForgeManifestSchema.safeParse(after).success || !isDeepStrictEqual(after, { ...before, schema: FORGE_SCHEMA_SECTIONS })) {
    throw refuse(`the edit does not read back as the original with exactly schema: ${FORGE_SCHEMA_SECTIONS}`);
  }

  return content;
}
