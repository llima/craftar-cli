import { toCrlf } from "../core/text.js";
import { serializeFrontmatter } from "../core/frontmatter.js";
import { listFiles } from "../core/forge.js";
import { appliesTo, outName } from "./shared.js";
import type { Emitter, EmitContext, PlannedFile } from "./types.js";
import type { ResolvedIngredient } from "../core/resolve.js";

/**
 * Kiro target. Reproduces, then extends, the behaviour of the hand-written
 * `.claude/scripts/sync-steering.ps1` this target was extracted from:
 *   - steering = frontmatter(inclusion) + GENERATED banner + rule body
 *   - `.claude/rules/` references are rewritten to `.kiro/steering/`
 *   - UTF-8 without BOM, CRLF (the exact shape Kiro already consumes)
 * and additionally generates what the script never did: agents JSON, commands and skills.
 */
export const kiro: Emitter = {
  target: "kiro",
  async emit(ctx) {
    const out: PlannedFile[] = [];
    const t = "kiro";
    const banner = String(ctx.resolution.params["kiro.banner"] ?? "<!-- GENERATED from {{source}} by craftar -- do not edit. -->");
    const ruleNames = new Set(ctx.resolution.ingredients.filter((i) => i.meta.type === "rule").map((i) => outName(i.meta)));
    const scopedRules = ctx.resolution.ingredients.filter((i) => i.meta.type === "rule" && i.meta.inclusion === "fileMatch").map((i) => outName(i.meta));

    for (const ing of ctx.resolution.ingredients) {
      if (!appliesTo(ing.meta.targets, t)) continue;
      const m = ing.meta;
      switch (m.type) {
        case "rule": {
          const body = rewrite(await ctx.text(ing, m.file));
          const fm =
            m.inclusion === "fileMatch"
              ? `---\ninclusion: fileMatch\nfileMatchPattern: ${JSON.stringify(Array.isArray(m.fileMatchPattern) ? m.fileMatchPattern.join(",") : m.fileMatchPattern ?? "**")}\n---\n\n`
              : `---\ninclusion: ${m.inclusion}\n---\n\n`;
          const head = banner.replace("{{source}}", `.claude/rules/${outName(m)}.md`) + "\n\n";
          out.push(crlf(`.kiro/steering/${outName(m)}.md`, fm + head + body, ing.ref));
          break;
        }
        case "steering":
          out.push(crlf(`.kiro/steering/${outName(m)}.md`, await ctx.text(ing, m.file), ing.ref));
          break;
        case "agent": {
          const body = rewrite(await ctx.text(ing, m.file));
          const description = rewrite(m.description ?? "");
          const tools = mapTools(m.tools, ctx);
          const resources = m.resources ?? agentResources(outName(m), description + "\n" + body, ruleNames, scopedRules);
          const json = JSON.stringify({ name: outName(m), description, prompt: body.replace(/^\n+/, "").replace(/\n+$/, ""), tools, allowedTools: tools, resources }, null, 2) + "\n";
          out.push(crlf(`.kiro/agents/${outName(m)}.json`, json, ing.ref));
          break;
        }
        case "command": {
          const body = rewrite(await ctx.text(ing, m.file));
          const doc = serializeFrontmatter(
            { description: m.description, "argument-hint": m.argumentHint, "allowed-tools": m.allowedTools },
            body,
            { raw: m.frontmatterRaw ? rewrite(m.frontmatterRaw) : null },
          );
          out.push(crlf(`.kiro/steering/commands/${outName(m)}.md`, `---\ninclusion: manual\n---\n\n` + doc, ing.ref));
          break;
        }
        case "skill": {
          if (m.layout === "file") {
            out.push(crlf(`.kiro/skills/${outName(m)}/SKILL.md`, rewrite(await ctx.text(ing, "SKILL.md")), ing.ref));
          } else {
            for (const f of await listFiles(ing.dir)) {
              if (f === "ingredient.yaml") continue;
              out.push(await copy(ctx, ing, f, `.kiro/skills/${outName(m)}/${f}`));
            }
          }
          break;
        }
        case "mcp":
          // Kiro reads MCP servers from .kiro/settings/mcp.json
          break;
        case "script":
        case "hook":
          ctx.warn(`kiro: ${m.type} ${ing.ref} has no Kiro equivalent — skipped`);
          break;
      }
    }

    const mcp = ctx.resolution.ingredients.filter((i) => i.meta.type === "mcp" && appliesTo(i.meta.targets, t));
    if (mcp.length) {
      const servers: Record<string, unknown> = {};
      for (const i of mcp) if (i.meta.type === "mcp") servers[i.meta.name] = i.meta.server;
      out.push(crlf(".kiro/settings/mcp.json", JSON.stringify({ mcpServers: servers }, null, 2) + "\n", "mcp/*"));
    }
    return out;
  },
};

export function rewrite(text: string): string {
  return text.replace(/\.claude\/rules\//g, ".kiro/steering/");
}

function crlf(path: string, text: string, ingredient: string): PlannedFile {
  return { path, content: Buffer.from(toCrlf(text), "utf8"), target: "kiro", ingredient };
}

async function copy(ctx: EmitContext, ing: ResolvedIngredient, file: string, relPath: string): Promise<PlannedFile> {
  if (/\.(md|txt|json|ya?ml)$/i.test(file)) return crlf(relPath, rewrite(await ctx.text(ing, file)), ing.ref);
  return { path: relPath, content: await ctx.bytes(ing, file), target: "kiro", ingredient: ing.ref };
}

const TOOL_MAP: Record<string, string | null> = {
  read: "read",
  grep: "grep",
  glob: "glob",
  bash: "shell",
  edit: "write",
  write: "write",
  multiedit: "write",
  notebookedit: "write",
  webfetch: "web_fetch",
  websearch: "web_search",
  agent: null,
  task: null,
  askuserquestion: null,
  todowrite: null,
};

function mapTools(tools: string[], ctx: EmitContext): string[] {
  const out: string[] = [];
  for (const raw of tools) {
    const key = raw.trim().replace(/\(.*\)$/, "").toLowerCase();
    if (!key) continue;
    const mapped = key in TOOL_MAP ? TOOL_MAP[key] : key;
    if (mapped === null) {
      ctx.warn(`kiro: tool "${raw.trim()}" has no Kiro equivalent; dropped`);
      continue;
    }
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/**
 * Kiro custom agents do not auto-load steering, so each agent declares what it reads.
 * A stack reviewer (`backend-api-reviewer` ← scoped rule `backend-api`, `frontend-reviewer` ← `frontend-angular`)
 * gets its own rule + `repo-discovery`; any other agent gets the whole steering tree.
 */
export function agentResources(agentName: string, text: string, known: Set<string>, scoped: string[]): string[] {
  const cited = referencedRules(text, known);
  const bound = scoped.find((r) => agentName.startsWith(r) || (agentName.startsWith(r.split("-")[0] + "-") && cited.includes(r)));
  if (!bound) return ["file://.kiro/steering/**/*.md"];
  const list = [bound];
  if (known.has("repo-discovery")) list.push("repo-discovery");
  return list.map((r) => `file://.kiro/steering/${r}.md`);
}

/** Rule names referenced as `.claude/rules/<name>.md` or `.kiro/steering/<name>.md`, in order of first appearance. */
export function referencedRules(text: string, known: Set<string>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\.(?:claude\/rules|kiro\/steering)\/([A-Za-z0-9._-]+)\.md/g)) {
    const name = m[1];
    if (known.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}
