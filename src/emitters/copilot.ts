import { serializeFrontmatter } from "../core/frontmatter.js";
import type { Ingredient } from "../schema/index.js";
import type { ResolvedIngredient } from "../core/resolve.js";
import { mcpServers, MCP_FILE, outName, textFile } from "./shared.js";
import type { Emitter, PlannedFile } from "./types.js";

/**
 * Copilot target (spec 61 §3.4, §5.2): `.github/instructions/<name>.instructions.md`,
 * `.github/agents/<name>.md`, `.github/prompts/<name>.prompt.md`, `.vscode/mcp.json`.
 * Text files keep the line endings of the file they replace (LF when new) and never carry a BOM.
 */
export const copilot: Emitter<"copilot"> = {
  target: "copilot",
  async emit(ctx) {
    const out: PlannedFile[] = [];
    const t = "copilot";
    const mcp: ResolvedIngredient[] = [];
    for (const ing of ctx.aimed) {
      const m = ctx.meta(ing);
      switch (m.type) {
        case "rule": {
          const path = `.github/instructions/${outName(m)}.instructions.md`;
          const body = await ctx.text(ing, m.file, t);
          out.push(await textFile(ctx, path, ruleFrontmatter(m) + "\n" + body, t, ing.ref, { keepBom: false }));
          break;
        }
        case "agent": {
          const path = `.github/agents/${outName(m)}.md`;
          const body = await ctx.text(ing, m.file, t);
          if ((m.tools?.length ?? 0) > 0)
            ctx.warn(`copilot: agent "${outName(m)}": tools have no Copilot field and are dropped`);
          // Never the agent's frontmatterRaw: that is Claude Code's frontmatter.
          const doc = serializeFrontmatter({ name: outName(m), description: m.description }, body);
          out.push(await textFile(ctx, path, doc, t, ing.ref, { keepBom: false }));
          break;
        }
        case "command": {
          const path = `.github/prompts/${outName(m)}.prompt.md`;
          const body = await ctx.text(ing, m.file, t);
          // Description as frontmatter when present.
          const doc = m.description ? serializeFrontmatter({ description: m.description }, body) : body;
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
    if (mcp.length) {
      // mcpServers renders and runs credentialIn first; the reshape keeps type: stdio.
      const servers = copilotMcpServers(mcpServers(ctx, t, MCP_FILE.copilot, mcp));
      out.push(await textFile(ctx, MCP_FILE.copilot, JSON.stringify({ servers }, null, 2) + "\n", t, "mcp/*", { keepBom: false }));
    }
    return out;
  },
};

/**
 * Copilot rules frontmatter: applyTo from fileMatchPattern (spec 61 §3.4).
 * description when present, then applyTo when fileMatch inclusion.
 * Always returns a frontmatter block (even if minimal) to ensure the output differs from the source.
 */
function ruleFrontmatter(m: Extract<Ingredient, { type: "rule" }>): string {
  const lines: string[] = [];
  if (m.description) lines.push(`description: ${JSON.stringify(m.description)}`);
  if (m.inclusion === "fileMatch") {
    const p = m.fileMatchPattern;
    // applyTo is a list of globs
    const patterns = Array.isArray(p) ? p : [p ?? "**"];
    lines.push(`applyTo: ${JSON.stringify(patterns)}`);
  }
  // Always emit frontmatter to mark this as a Copilot instruction file
  return `---\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}---\n`;
}

/**
 * Reshape the shared mcpServers output into Copilot's .vscode/mcp.json format:
 * { servers: { <name>: { type: "stdio", command, args, env } } }
 */
function copilotMcpServers(servers: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    const s = server as { command?: string; args?: string[]; env?: Record<string, string> };
    result[name] = {
      type: "stdio",
      command: s.command,
      ...(s.args && s.args.length > 0 ? { args: s.args } : {}),
      ...(s.env && Object.keys(s.env).length > 0 ? { env: s.env } : {}),
    };
  }
  return result;
}
