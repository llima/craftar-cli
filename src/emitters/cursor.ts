/**
 * Cursor emitter (spec 61 §7).
 *
 * Writes rules to `.cursor/rules/<name>.mdc`, agents to `.cursor/agents/<name>.md`,
 * and MCP servers to `.cursor/mcp.json`.
 */

import { serializeFrontmatter } from "../core/frontmatter.js";
import { mcpServers, MCP_FILE, outName, textFile } from "./shared.js";
import type { Emitter, PlannedFile } from "./types.js";
import type { ResolvedIngredient } from "../core/resolve.js";
import type { Ingredient } from "../schema/index.js";

/**
 * Cursor emitter: writes rules, agents, and MCP configuration.
 *
 * - Rules: `.cursor/rules/<name>.mdc` with Cursor's MDC format (YAML frontmatter + markdown body)
 * - Agents: `.cursor/agents/<name>.md` with frontmatter for name, description, and tools
 * - MCP: `.cursor/mcp.json` with `mcpServers` object
 */
export const cursor: Emitter<"cursor"> = {
  target: "cursor",
  async emit(ctx) {
    const out: PlannedFile[] = [];
    const t = "cursor";
    const mcp: ResolvedIngredient[] = [];

    for (const ing of ctx.aimed) {
      const m = ctx.meta(ing);
      switch (m.type) {
        case "rule": {
          const body = await ctx.text(ing, m.file, "cursor");
          const path = `.cursor/rules/${outName(m)}.mdc`;
          // Cursor rules use MDC format: YAML frontmatter with alwaysApply, description, and/or globs
          // An "always" inclusion rule becomes alwaysApply: true
          // A scoped rule uses globs from the ingredient's inclusion paths
          const frontmatter = cursorRuleFrontmatter(m);
          const doc = m.frontmatterRaw != null
            ? serializeFrontmatter(frontmatter, body, { raw: m.frontmatterRaw })
            : serializeFrontmatter(frontmatter, body);
          out.push(await textFile(ctx, path, doc, t, ing.ref));
          break;
        }
        case "agent": {
          const body = await ctx.text(ing, m.file, "cursor");
          const path = `.cursor/agents/${outName(m)}.md`;
          // Cursor agents use frontmatter with name, description, and tools
          const doc = serializeFrontmatter(
            { name: outName(m), description: m.description, tools: m.tools },
            body,
            { raw: m.frontmatterRaw }
          );
          out.push(await textFile(ctx, path, doc, t, ing.ref));
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

    // Emit MCP configuration
    const servers = mcpServers(ctx, t, MCP_FILE["cursor"], mcp);
    if (Object.keys(servers).length) {
      const json = JSON.stringify({ mcpServers: servers }, null, 2) + "\n";
      out.push(await textFile(ctx, MCP_FILE["cursor"], json, t, "mcp/*"));
    }

    return out;
  },
};

/**
 * Build Cursor rule frontmatter from an ingredient's metadata.
 *
 * Cursor rules use three key frontmatter fields:
 * - `alwaysApply`: true to include in every chat session
 * - `description`: for Agent to decide relevance (when alwaysApply is false and no globs)
 * - `globs`: file patterns for auto-attachment (when alwaysApply is false)
 *
 * Mapping from craftar rule inclusion:
 * - "always" → alwaysApply: true
 * - "auto" with fileMatchPattern → globs field
 * - "fileMatch" → globs field
 * - "manual" → neither (requires @-mention in chat)
 */
function cursorRuleFrontmatter(m: Extract<Ingredient, { type: "rule" }>): Record<string, unknown> {
  const fm: Record<string, unknown> = {};

  if (m.inclusion === "always") {
    fm.alwaysApply = true;
  } else if (m.inclusion === "auto") {
    // Auto: use description for intelligent application
    if (m.description) {
      fm.description = m.description;
    }
  } else if (m.inclusion === "fileMatch" && m.fileMatchPattern) {
    // File match: convert to Cursor globs format
    const patterns = Array.isArray(m.fileMatchPattern) ? m.fileMatchPattern : [m.fileMatchPattern];
    fm.globs = patterns.join(", ");
  }
  // "manual" inclusion: no alwaysApply, no description, no globs → requires @-mention

  return fm;
}
