import { detectEol, hasBom, withEol, type Eol } from "../core/text.js";
import type { EmitContext, PlannedFile } from "./types.js";

export function appliesTo(targets: "*" | string[], target: string): boolean {
  return targets === "*" || targets.includes(target);
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Text file that keeps the EOL and the BOM of the file it replaces (LF, no BOM when new). */
export async function textFile(ctx: EmitContext, relPath: string, text: string, target: PlannedFile["target"], ingredient: string): Promise<PlannedFile> {
  const existing = await ctx.readExisting(relPath);
  const eol: Eol = existing ? detectEol(existing.toString("utf8")) : "lf";
  const body = Buffer.from(withEol(text, eol), "utf8");
  const content = existing && hasBom(existing) ? Buffer.concat([UTF8_BOM, body]) : body;
  return { path: relPath, content, target, ingredient };
}

/** Output basename: a variant (`workflow--acme` with `as: workflow`) emits under the original name. */
export function outName(m: { name: string; as?: string }): string {
  return m.as ?? m.name;
}
