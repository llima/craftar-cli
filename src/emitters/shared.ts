import { detectEol, withEol, type Eol } from "../core/text.js";
import type { EmitContext, PlannedFile } from "./types.js";

export function appliesTo(targets: "*" | string[], target: string): boolean {
  return targets === "*" || targets.includes(target);
}

/** Text file that keeps the EOL of the file it replaces (LF when new). */
export async function textFile(ctx: EmitContext, relPath: string, text: string, target: PlannedFile["target"], ingredient: string): Promise<PlannedFile> {
  const existing = await ctx.readExisting(relPath);
  const eol: Eol = existing ? detectEol(existing.toString("utf8")) : "lf";
  return { path: relPath, content: Buffer.from(withEol(text, eol), "utf8"), target, ingredient };
}

/** Output basename: a variant (`workflow--acme` with `as: workflow`) emits under the original name. */
export function outName(m: { name: string; as?: string }): string {
  return m.as ?? m.name;
}
