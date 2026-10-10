import YAML from "yaml";
import { stripBom } from "./text.js";

/** A YAML syntax error with the code and the place only — never the message, which quotes the source line. */
export class YamlSyntaxError extends Error {
  readonly fault: string;
  constructor(name: string, fault: string) {
    super(`invalid ${name}: ${fault}`);
    this.fault = fault;
    this.name = "YamlSyntaxError";
  }
}

/** `MISSING_CHAR at line 3, column 1`, or `YAML syntax error` when the package gives no code; the position only when it gives one. */
export function yamlFault(e: unknown): string {
  if (e instanceof YamlSyntaxError) return e.fault;
  const pos = (e as { linePos?: Array<{ line: unknown; col: unknown }> }).linePos?.[0];
  const code = (e as { code?: unknown }).code;
  if (typeof code !== "string" || !/^[A-Z_]+$/.test(code)) return "YAML syntax error";
  const hasPos = pos && Number.isInteger(pos.line) && Number.isInteger(pos.col);
  return hasPos ? `${code} at line ${pos.line}, column ${pos.col}` : code;
}

/** Parse YAML text read from `name`: BOM stripped, no yaml warning emitted, and a syntax error is `invalid <name>: <fault>`. */
export function parseYamlText(name: string, text: string): unknown {
  try {
    return YAML.parse(stripBom(text), { logLevel: "error" });
  } catch (e) {
    throw new YamlSyntaxError(name, yamlFault(e));
  }
}
