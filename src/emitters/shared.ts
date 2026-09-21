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

/**
 * The MCP servers a target writes into its one JSON file, keyed by `outName` so a variant keeps the
 * server name its workspace uses. The file holds one entry per name, so when two ingredients write
 * the same name the earlier one is dropped — said out loud, never silently.
 */
export function mcpServers(ctx: EmitContext, target: string, file: string): Record<string, unknown> {
  // A null prototype, so a server named `__proto__` is an entry and not the object's prototype.
  const servers: Record<string, unknown> = Object.create(null);
  // A Map, so a server named `constructor` or `toString` is not mistaken for one already written.
  const writtenBy = new Map<string, string>();
  for (const ing of ctx.resolution.ingredients) {
    if (ing.meta.type !== "mcp" || !appliesTo(ing.meta.targets, target)) continue;
    const key = outName(ing.meta);
    const prev = writtenBy.get(key);
    if (prev) ctx.warn(`${target}: two ingredients write the MCP server "${key}" into ${file}: ${prev} and ${ing.ref} (last wins)`);
    servers[key] = ing.meta.server;
    writtenBy.set(key, ing.ref);
  }
  return servers;
}
