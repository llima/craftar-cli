/**
 * `craftar docs validate` (spec 47): the one module of the command — the docs block's one reader, the scanner, the checks.
 * Returns data and throws; it never prints. No finding carries a line of a file, a link's target or a frontmatter value.
 */
import { DocsBlockSchema, type DocsBlock } from "../schema/index.js";

/** A docs block that does not read (spec 47 §5.4): one line, `docs block: <position> — <rule>`, never a value. */
export class DocsBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocsBlockError";
  }
}

const position = (p: Array<string | number>) =>
  p.length === 0 ? "docs" : p.map((x, i) => (typeof x === "number" ? `[${x}]` : i === 0 ? x : `.${x}`)).join("");

/** The one reader of `profile.docs` (spec 47 §5.2): `null` when absent or `null`, else the block, else a `DocsBlockError`. */
export function declaredDocs(profile: { docs?: unknown }): DocsBlock | null {
  if (profile.docs === undefined || profile.docs === null) return null;
  const parsed = DocsBlockSchema.safeParse(profile.docs);
  if (parsed.success) return parsed.data;
  // Every issue is custom, with a fixed text of DOCS_RULES (or NO_PROTO_KEY) and a path the schema already vetted.
  const issues = parsed.error.issues;
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : "";
  throw new DocsBlockError(`docs block: ${position(issues[0].path)} — ${issues[0].message}${more}`);
}
