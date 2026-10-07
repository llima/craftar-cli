import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { stripBom } from "./text.js";

/**
 * A workspace file's YAML (`craftar.yaml`, `craftar.local.yaml`), for every reader of it. A syntax error
 * names the file, the code and the place only, and yaml's warnings are not emitted: both would quote the
 * line, and that line can be a `forge:` holding a credential not checked yet (spec 13 §4.3).
 */
export function parseWorkspaceYaml(name: string, text: string): unknown {
  try {
    return YAML.parse(stripBom(text), { logLevel: "error" });
  } catch (e) {
    const pos = (e as { linePos?: Array<{ line: number; col: number }> }).linePos?.[0];
    const code = (e as { code?: string }).code ?? "YAML syntax error";
    throw new Error(`invalid ${name}: ${code}${pos ? ` at line ${pos.line}, column ${pos.col}` : ""}`);
  }
}

/** The keys a layered list or value can come from, in the order `localKeys` names them. */
const LOCAL_KEYS = ["forge", "ref", "profile", "recipes", "targets"] as const;
export type LocalKey = (typeof LOCAL_KEYS)[number];

/**
 * Which of `forge`, `ref`, `profile`, `recipes` and `targets` the workspace's `craftar.local.yaml` sets — none
 * when there is no such file. One answer for every command that writes `craftar.yaml` and must not be
 * overridden by the local layer (spec 22's R1, spec 23's N10).
 */
export async function localKeys(root: string): Promise<LocalKey[]> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, "craftar.local.yaml"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const doc = parseWorkspaceYaml("craftar.local.yaml", text);
  if (doc === null || typeof doc !== "object") return [];
  return LOCAL_KEYS.filter((k) => k in doc);
}
