import { serializeFrontmatter } from "../core/frontmatter.js";
import type { Ingredient } from "../schema/index.js";
import type { ResolvedIngredient } from "../core/resolve.js";
import { envReferences, mcpServers, MCP_FILE, outName, ownRuleRefs, textFile } from "./shared.js";
import type { Emitter, PlannedFile } from "./types.js";

/**
 * Cursor target (spec 61 §3.3, §5.2): `.cursor/rules/<name>.mdc`, `.cursor/agents/<name>.md`, `.cursor/mcp.json`.
 * Text files keep the line endings of the file they replace (LF when new) and never carry a BOM.
 * Commands and skills reach Cursor through the agent-skills target; the matrix warns for them here.
 */
export const cursor: Emitter<"cursor"> = {
  target: "cursor",
  async emit(ctx) {
    const out: PlannedFile[] = [];
    const t = "cursor";
    const mcp: ResolvedIngredient[] = [];
    const refs = ownRuleRefs(ctx, t);
    for (const ing of ctx.aimed) {
      const m = ctx.meta(ing);
      switch (m.type) {
        case "rule": {
          const path = `.cursor/rules/${outName(m)}.mdc`;
          const body = refs.index(refs.resolve(await ctx.text(ing, m.file, t), ing.ref), path);
          // Warn if a fileMatchPattern item holds a comma, which Cursor reads as a separator.
          if (m.inclusion === "fileMatch") {
            const patterns = Array.isArray(m.fileMatchPattern) ? m.fileMatchPattern : [m.fileMatchPattern ?? ""];
            for (const pat of patterns) {
              if (pat.includes(",")) {
                ctx.warn(`cursor: rule ${ing.ref}: a glob holds a comma, which Cursor reads as a separator`);
                break; // One warning per rule, not per pattern
              }
            }
          }
          out.push(await textFile(ctx, path, ruleFrontmatter(m) + "\n" + body, t, ing.ref, { keepBom: false }));
          break;
        }
        case "agent": {
          const path = `.cursor/agents/${outName(m)}.md`;
          const body = refs.resolve(await ctx.text(ing, m.file, t), ing.ref);
          if ((m.tools?.length ?? 0) > 0)
            ctx.warn(`cursor: agent "${outName(m)}": tools have no Cursor field and are dropped`);
          // Never the agent's frontmatterRaw: that is Claude Code's frontmatter.
          const doc = serializeFrontmatter({ name: outName(m), description: m.description, model: m.model }, body);
          out.push(await textFile(ctx, path, doc, t, ing.ref, { keepBom: false }));
          break;
        }
        case "mcp":
          mcp.push(ing);
          break;
        default: {
          const never: never = m;
          throw new Error(`internal: ${t} has no case for ${(never as Ingredient).type}`);
        }
      }
    }
    refs.finish();
    if (mcp.length) {
      // mcpServers renders and runs credentialIn first; the reshape after it changes no value it checked.
      const servers = envReferences(mcpServers(ctx, t, MCP_FILE.cursor, mcp));
      out.push(await textFile(ctx, MCP_FILE.cursor, JSON.stringify({ mcpServers: servers }, null, 2) + "\n", t, "mcp/*", { keepBom: false }));
    }
    return out;
  },
};

/** The .mdc frontmatter: keys in a fixed order, strings as JSON. A Claude `paths:` block (frontmatterRaw) is not reused. */
function ruleFrontmatter(m: Extract<Ingredient, { type: "rule" }>): string {
  const lines: string[] = [];
  if (m.description) lines.push(`description: ${JSON.stringify(m.description)}`);
  if (m.inclusion === "fileMatch") {
    const p = m.fileMatchPattern;
    lines.push(`globs: ${JSON.stringify(Array.isArray(p) ? p.join(",") : (p ?? "**"))}`);
  }
  lines.push(`alwaysApply: ${m.inclusion === "always"}`);
  return `---\n${lines.join("\n")}\n---\n`;
}
