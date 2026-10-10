/** One refused key of a schema refusal: where, and what the schema expected — never the value it received. */
export type SchemaIssue = { path: string; text: string };

type RawIssue = { code?: unknown; path?: unknown; message?: unknown; options?: unknown; unionErrors?: unknown };

const rawIssues = (e: unknown): RawIssue[] | null => {
  const issues = e !== null && typeof e === "object" ? (e as { issues?: unknown }).issues : undefined;
  return Array.isArray(issues) ? (issues as RawIssue[]) : null;
};

const quoted = (o: unknown) => (typeof o === "string" ? `'${o}'` : String(o));

/**
 * The text of one zod issue. zod's own message is kept except where it quotes the input: an enum mismatch is
 * reworded from the schema's options, and a union is its members' texts. No other field of the issue is read —
 * `received` holds the value for an enum and a literal.
 */
function issueText(i: RawIssue): string {
  if (i.code === "invalid_enum_value") return `Invalid enum value. Expected ${(Array.isArray(i.options) ? i.options : []).map(quoted).join(" | ")}`;
  if (i.code === "invalid_union") {
    const inner = [...new Set((Array.isArray(i.unionErrors) ? i.unionErrors : []).flatMap((u) => (rawIssues(u) ?? []).map(issueText)))];
    return inner.length ? `Invalid input (${inner.join(" | ")})` : "Invalid input";
  }
  return typeof i.message === "string" ? i.message : "Invalid input";
}

/** The issues of a schema refusal (a zod error, or a `SchemaError`); `[]` for anything else. */
export function schemaIssues(e: unknown): SchemaIssue[] {
  if (e instanceof SchemaError) return e.issues;
  return (rawIssues(e) ?? []).map((i) => ({ path: (Array.isArray(i.path) ? i.path : []).join(".") || "top level", text: issueText(i) }));
}

/** `scm.kind: Invalid enum value. Expected 'a' | 'b'; name: Required` — every issue, on one line. */
export function schemaFault(e: unknown): string {
  return schemaIssues(e).map((i) => `${i.path}: ${i.text}`).join("; ");
}

/** A schema refusal as `<what>: <fault>`, keeping its issues for a caller that words them itself (doctor). */
export class SchemaError extends Error {
  readonly what: string;
  readonly issues: SchemaIssue[];
  constructor(what: string, e: unknown) {
    const issues = schemaIssues(e);
    super(`${what}: ${issues.map((i) => `${i.path}: ${i.text}`).join("; ")}`);
    this.what = what;
    this.issues = issues;
    this.name = "SchemaError";
  }
}

/** The message of any caught error; a zod error that was not wrapped is worded by `schemaFault`, never by its own dump. */
export function errorText(e: unknown): string {
  if (!(e instanceof SchemaError) && rawIssues(e)?.length) return schemaFault(e);
  return e instanceof Error ? e.message : String(e);
}

/** A `schema` number as a refusal prints it: the number when it is a whole one, never any other value read from the file. */
export const shownSchema = (v: unknown): string => (typeof v === "number" && Number.isInteger(v) ? String(v) : "(not a whole number)");
