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
