import { promises as fs } from "node:fs";
import path from "node:path";
import { parseYamlText } from "./yaml-read.js";

/**
 * A workspace file's YAML (`craftar.yaml`, `craftar.local.yaml`), for every reader of it. A syntax error
 * names the file, the code and the place only, and yaml's warnings are not emitted: both would quote the
 * line, and that line can be a `forge:` holding a credential not checked yet (spec 13 §4.3).
 */
export function parseWorkspaceYaml(name: string, text: string): unknown {
  return parseYamlText(name, text);
}

/** The keys a layered list or value can come from, in the order `localKeys` names them. */
const LOCAL_KEYS = ["forge", "ref", "profile", "recipes", "targets"] as const;
export type LocalKey = (typeof LOCAL_KEYS)[number];

/**
 * The workspace's `craftar.local.yaml`, read once: its document (null when there is no such file, `{}` when it
 * is empty, as `loadWorkspace` merges it) and which of `forge`, `ref`, `profile`, `recipes` and `targets` it
 * sets. One answer for every command that writes `craftar.yaml` and must not be overridden by the local layer
 * (spec 22's R1, spec 23's N10); `init` merges the same document it checked.
 */
export async function readLocalFile(root: string): Promise<{ doc: unknown | null; keys: LocalKey[] }> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, "craftar.local.yaml"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { doc: null, keys: [] };
    throw e;
  }
  const doc = parseWorkspaceYaml("craftar.local.yaml", text) ?? {};
  return { doc, keys: typeof doc === "object" ? LOCAL_KEYS.filter((k) => k in (doc as object)) : [] };
}

/** Which of the `LOCAL_KEYS` `craftar.local.yaml` sets — none when there is no such file. */
export async function localKeys(root: string): Promise<LocalKey[]> {
  return (await readLocalFile(root)).keys;
}
