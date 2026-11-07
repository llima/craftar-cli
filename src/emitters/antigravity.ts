import type { Ingredient } from "../schema/index.js";
import type { ResolvedIngredient } from "../core/resolve.js";
import { mcpServers, MCP_FILE, outName, ownRuleRefs, textFile } from "./shared.js";
import type { Emitter, PlannedFile } from "./types.js";
import { antigravityHooks } from "./hooks.js";

/** Antigravity's workspace hooks file (spec 61 slice 3, H1): dedicated to hooks, one named hook per ingredient. */
export const ANTIGRAVITY_HOOKS = ".agents/hooks.json";

/** Antigravity's rule size limit, per file (spec 61 §3.5): over it, the tool's behaviour is not measured, so the plan warns. */
const RULE_MAX_BYTES = 24000;

/** The `model` values Antigravity names (spec 61 §3.5); any other is not written. */
const MODELS = new Set(["inherit", "flash", "pro"]);

/**
 * Google Antigravity target (spec 61 §3.5, §5.2, slice 2): `.agents/rules/<name>.md`, `.agents/agents/<name>.md`,
 * `.agents/mcp_config.json`. Every rule carries its frontmatter — the tool drops a rule without one, or with a bad `trigger`, and
 * says nothing — and with `agents-md` among the targets an always-on rule with the default targets is left to `AGENTS.md`, which
 * Antigravity reads (D3). Since slice 3 (H1) a hook's registration is written to `.agents/hooks.json`, translated (`antigravityHooks`). Commands and skills
 * reach it through the agent-skills target; the matrix warns for them here. Text keeps
 * the line endings of the file it replaces (LF when new) and never carries a BOM.
 */
export const antigravity: Emitter<"antigravity"> = {
  target: "antigravity",
  async emit(ctx) {
    const out: PlannedFile[] = [];
    const t = "antigravity";
    const mcp: ResolvedIngredient[] = [];
    const hooks: ResolvedIngredient[] = [];
    const refs = ownRuleRefs(ctx, t);
    for (const ing of ctx.aimed) {
      const m = ctx.meta(ing);
      switch (m.type) {
        case "rule": {
          const path = `.agents/rules/${outName(m)}.md`;
          const body = refs.index(refs.resolve(await ctx.text(ing, m.file, t), ing.ref), path);
          const doc = ruleFrontmatter(m, ing.ref, (msg) => ctx.warn(msg)) + "\n" + body;
          if (Buffer.byteLength(doc, "utf8") > RULE_MAX_BYTES)
            ctx.warn(`antigravity: rule ${ing.ref} is over ${RULE_MAX_BYTES} bytes, Antigravity's limit for a rule file`);
          out.push(await textFile(ctx, path, doc, t, ing.ref, { keepBom: false }));
          break;
        }
        case "agent": {
          const name = outName(m);
          const lines = [`name: ${JSON.stringify(name)}`];
          if (m.description) lines.push(`description: ${JSON.stringify(m.description)}`);
          else ctx.warn(`antigravity: agent "${name}" has no description, which Antigravity requires`);
          // Antigravity's tool names were not measured (spec 61 §3.5): writing Claude Code's could be ignored with no message.
          if ((m.tools?.length ?? 0) > 0) ctx.warn(`antigravity: agent "${name}": tools are not written (Antigravity's tool names are not measured); dropped`);
          if (m.model && !MODELS.has(m.model)) ctx.warn(`antigravity: agent "${name}": model is not one Antigravity names (inherit, flash, pro); inherit written`);
          lines.push(`model: ${m.model && MODELS.has(m.model) ? m.model : "inherit"}`);
          const doc = `---\n${lines.join("\n")}\n---\n` + refs.resolve(await ctx.text(ing, m.file, t), ing.ref);
          out.push(await textFile(ctx, `.agents/agents/${name}.md`, doc, t, ing.ref, { keepBom: false }));
          break;
        }
        case "mcp":
          mcp.push(ing);
          break;
        case "hook":
          hooks.push(ing); // collected into .agents/hooks.json below
          break;
        default: {
          const never: never = m;
          throw new Error(`internal: ${t} has no case for ${(never as Ingredient).type}`);
        }
      }
    }
    refs.finish();
    if (mcp.length) {
      // mcpServers renders and runs credentialIn first; the reshape after it changes no value it checked: a remote server's `url`
      // becomes `serverUrl` (Antigravity's key for Streamable HTTP), in its place, every other key kept.
      const servers = Object.fromEntries(Object.entries(mcpServers(ctx, t, MCP_FILE.antigravity, mcp)).map(([k, v]) => [k, serverUrl(v)]));
      out.push(await textFile(ctx, MCP_FILE.antigravity, JSON.stringify({ mcpServers: servers }, null, 2) + "\n", t, "mcp/*", { keepBom: false }));
    }
    const hookDoc = hooks.length ? antigravityHooks(ctx, hooks) : null;
    if (hookDoc) out.push(await textFile(ctx, ANTIGRAVITY_HOOKS, JSON.stringify(hookDoc, null, 2) + "\n", t, "hook/*", { keepBom: false }));
    return out;
  },
};

/** A server with `url` renamed `serverUrl`, the key order otherwise kept; any other server returned as it is. */
function serverUrl(server: unknown): unknown {
  if (server === null || typeof server !== "object" || Array.isArray(server) || !Object.hasOwn(server, "url")) return server;
  return Object.fromEntries(Object.entries(server as Record<string, unknown>).map(([k, v]) => [k === "url" ? "serverUrl" : k, v]));
}

/**
 * The rule frontmatter (spec 61 §3.5): `trigger` always — `always_on`, `glob` with `globs` (the patterns joined with commas; a
 * glob holding a comma is warned), `manual`, or `model_decision` for an auto rule; an auto rule with no `description` cannot be
 * one (the tool drops it), so it is written `manual` and warned. `description` follows whenever the rule has one.
 */
function ruleFrontmatter(m: Extract<Ingredient, { type: "rule" }>, ref: string, warn: (msg: string) => void): string {
  const lines: string[] = [];
  if (m.inclusion === "always") lines.push("trigger: always_on");
  else if (m.inclusion === "fileMatch") lines.push("trigger: glob");
  else if (m.inclusion === "auto" && m.description) lines.push("trigger: model_decision");
  else {
    if (m.inclusion === "auto") warn(`antigravity: rule ${ref} is auto with no description, which Antigravity needs to decide; written as manual`);
    lines.push("trigger: manual");
  }
  if (m.description) lines.push(`description: ${JSON.stringify(m.description)}`);
  if (m.inclusion === "fileMatch") {
    const items = Array.isArray(m.fileMatchPattern) ? m.fileMatchPattern : [m.fileMatchPattern ?? "**"];
    if (items.some((p) => p.includes(","))) warn(`antigravity: rule ${ref}: a glob holds a comma, which Antigravity may read as a separator`);
    lines.push(`globs: ${JSON.stringify(items.join(","))}`);
  }
  return `---\n${lines.join("\n")}\n---\n`;
}
