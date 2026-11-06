import { envReferences, mcpServers, MCP_FILE, outName, textFile } from "./shared.js";
import type { Ingredient } from "../schema/index.js";
import type { ResolvedIngredient } from "../core/resolve.js";
import type { Emitter, PlannedFile } from "./types.js";

/**
 * GitHub Copilot target (spec 61 §3.4, §5.2): `.github/instructions/<name>.instructions.md`, `.github/copilot-instructions.md`,
 * `.github/agents/<name>.agent.md`, `.github/prompts/<name>.prompt.md`, `.vscode/mcp.json`.
 * Skills reach Copilot through the agent-skills target; the matrix warns for them here.
 */
export const copilot: Emitter<"copilot"> = {
  target: "copilot",
  async emit(ctx) {
    const out: PlannedFile[] = [];
    const t = "copilot";
    const always: string[] = [];
    const mcp: ResolvedIngredient[] = [];
    for (const ing of ctx.aimed) {
      const m = ctx.meta(ing);
      switch (m.type) {
        case "rule": {
          if (m.inclusion === "always") {
            always.push(await ctx.text(ing, m.file, t));
          } else if (m.inclusion === "fileMatch") {
            const items = Array.isArray(m.fileMatchPattern) ? m.fileMatchPattern : [m.fileMatchPattern ?? "**"];
            if (items.some((p) => p.includes(","))) ctx.warn(`copilot: rule ${ing.ref}: a glob holds a comma, which Copilot reads as a separator`);
            const fm = `---\napplyTo: ${JSON.stringify(items.join(","))}\n---\n`;
            const body = await ctx.text(ing, m.file, t);
            out.push(await textFile(ctx, `.github/instructions/${outName(m)}.instructions.md`, fm + "\n" + body, t, ing.ref, { keepBom: false }));
          } else {
            ctx.warn(`copilot: rule ${ing.ref} (${m.inclusion}) has no Copilot equivalent — skipped`);
          }
          break;
        }
        case "agent": {
          const tools = mapTools(outName(m), m.tools, (msg) => ctx.warn(msg));
          const lines = [`name: ${JSON.stringify(outName(m))}`];
          if (m.description) lines.push(`description: ${JSON.stringify(m.description)}`);
          if (tools.length) lines.push(`tools: ${JSON.stringify(tools)}`);
          if (m.model) lines.push(`model: ${JSON.stringify(m.model)}`);
          const doc = `---\n${lines.join("\n")}\n---\n` + (await ctx.text(ing, m.file, t));
          out.push(await textFile(ctx, `.github/agents/${outName(m)}.agent.md`, doc, t, ing.ref, { keepBom: false }));
          break;
        }
        case "command": {
          const lines: string[] = [];
          if (m.description) lines.push(`description: ${JSON.stringify(m.description)}`);
          if (m.argumentHint) lines.push(`argument-hint: ${JSON.stringify(m.argumentHint)}`);
          lines.push("agent: agent");
          if (m.allowedTools) ctx.warn(`copilot: command "${outName(m)}": allowed-tools has no prompt-file field; dropped`);
          const doc = `---\n${lines.join("\n")}\n---\n` + (await ctx.text(ing, m.file, t));
          out.push(await textFile(ctx, `.github/prompts/${outName(m)}.prompt.md`, doc, t, ing.ref, { keepBom: false }));
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
    if (always.length) {
      // Every always-on rule, in resolution order, one blank line between bodies; the file belongs to no one rule.
      const text = always.map((b) => b.replace(/\n+$/, "")).join("\n\n") + "\n";
      out.push(await textFile(ctx, ".github/copilot-instructions.md", text, t, "rule/*", { keepBom: false }));
    }
    if (mcp.length) {
      // mcpServers renders and runs credentialIn first; each server is kept whole, only `${NAME}` becomes `${env:NAME}`.
      const servers = envReferences(mcpServers(ctx, t, MCP_FILE.copilot, mcp));
      out.push(await textFile(ctx, MCP_FILE.copilot, JSON.stringify({ servers }, null, 2) + "\n", t, "mcp/*", { keepBom: false }));
    }
    return out;
  },
};

/** Copilot's tool aliases (docs.github.com, custom agents configuration), keyed by a lower-cased Claude Code tool name. */
const ALIASES = new Map<string, string>([
  ["read", "read"], ["edit", "edit"], ["write", "edit"], ["multiedit", "edit"], ["notebookedit", "edit"],
  ["grep", "search"], ["glob", "search"], ["ls", "search"],
  ["bash", "execute"], ["shell", "execute"],
  ["webfetch", "web"], ["websearch", "web"],
  ["task", "agent"], ["agent", "agent"],
  ["todowrite", "todo"],
]);

function mapTools(agent: string, tools: readonly string[], warn: (msg: string) => void): string[] {
  const out: string[] = [];
  for (const raw of tools) {
    const trimmed = raw.trim();
    const key = trimmed.replace(/\(.*\)$/, "").toLowerCase();
    if (!key) continue;
    const alias = ALIASES.get(key);
    if (alias === undefined) {
      warn(`copilot: agent "${agent}": tool "${trimmed}" has no Copilot alias; dropped`);
      continue;
    }
    // Warn when a scoped tool (has a (…) part) maps to an alias — the scope is dropped
    if (/\(.*\)$/.test(trimmed)) {
      warn(`copilot: agent "${agent}": tool "${trimmed}" maps to ${alias}; its scope is dropped`);
    }
    if (!out.includes(alias)) out.push(alias);
  }
  return out;
}
