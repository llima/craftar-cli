import { toCrlf } from "../core/text.js";
import { serializeFrontmatter } from "../core/frontmatter.js";
import { listFiles } from "../core/forge.js";
import { buildRuleLookup, mcpServers, outName, resolveRuleRefs, ruleFile, RULE_NAME_CHARS, UNKNOWN_NAME_KIND, type RefReport } from "./shared.js";
import type { Emitter, EmitBase, PlannedFile } from "./types.js";
import type { Ingredient } from "../schema/index.js";
import type { ResolvedIngredient } from "../core/resolve.js";

/** Files kiro copies as text, through `ctx.text` (substituted); anything else is copied as raw bytes. */
export const KIRO_TEXT_EXT = /\.(md|txt|json|ya?ml)$/i;

/**
 * Kiro target. Reproduces, then extends, the behaviour of the hand-written
 * `.claude/scripts/sync-steering.ps1` this target was extracted from:
 *   - steering = frontmatter(inclusion) + GENERATED banner + rule body
 *   - `.claude/rules/` references are resolved: kiro-written rules → `.kiro/steering/`,
 *     claude-code-written rules → unchanged, agents-md-only rules → `AGENTS.md`,
 *     dead rules → `<x> (rule not in this workspace)`, unknown → `.kiro/steering/` with a warning (spec 17)
 *   - UTF-8 without BOM, CRLF (the exact shape Kiro already consumes)
 * and additionally generates what the script never did: agents JSON, commands and skills.
 */
export const kiro: Emitter<"kiro"> = {
  target: "kiro",
  async emit(ctx) {
    const out: PlannedFile[] = [];
    const t = "kiro";
    const banner = String(ctx.resolution.params["kiro.banner"] ?? "<!-- GENERATED from {{source}} by craftar -- do not edit. -->");
    const ruleNames = new Set(ctx.resolution.ingredients.filter((i) => i.meta.type === "rule").map((i) => outName(i.meta)));
    const scopedRules = ctx.resolution.ingredients.filter((i) => i.meta.type === "rule" && i.meta.inclusion === "fileMatch").map((i) => outName(i.meta));
    const targets = ctx.resolution.targets;
    const lookup = buildRuleLookup(ctx.resolution.ingredients);

    // Collect reports for the warning (spec 17 §4.5)
    const reports: RefReport[] = [];
    const resolve = (text: string, citing: string): string => {
      const { text: resolved, report } = resolveRuleRefs(text, citing, lookup, targets, "kiro");
      reports.push(report);
      return resolved;
    };

    const mcp: ResolvedIngredient[] = [];
    // What this target writes comes from its walk; the matrix decides the rest and warns (spec 18).
    // `ctx.resolution.ingredients` above is for lookups only.
    for (const ing of ctx.aimed) {
      const m = ing.meta;
      switch (m.type) {
        case "rule": {
          const body = resolve(await ctx.text(ing, m.file), ing.ref);
          const fm =
            m.inclusion === "fileMatch"
              ? `---\ninclusion: fileMatch\nfileMatchPattern: ${JSON.stringify(Array.isArray(m.fileMatchPattern) ? m.fileMatchPattern.join(",") : m.fileMatchPattern ?? "**")}\n---\n\n`
              : `---\ninclusion: ${m.inclusion}\n---\n\n`;
          const head = banner.replace("{{source}}", `.claude/rules/${outName(m)}.md`) + "\n\n";
          out.push(crlf(ruleFile("kiro", m), fm + head + body, ing.ref));
          break;
        }
        case "steering":
          // Steering bodies are emitted as written (spec 17 §2)
          out.push(crlf(`.kiro/steering/${outName(m)}.md`, await ctx.text(ing, m.file), ing.ref));
          break;
        case "agent": {
          // Resolve description first, then body (spec 17 §4.5 order: description before prompt)
          const description = resolve(m.description ?? "", ing.ref);
          // Read the body once and derive both versions from it
          const rawBody = await ctx.text(ing, m.file);
          const body = resolve(rawBody, ing.ref);
          const tools = mapTools(m.tools, ctx);
          // agentResources reads the blanket-rewritten text, not the resolved text (spec 17 §4.6)
          const resources = m.resources ?? agentResources(outName(m), rewrite(m.description ?? "") + "\n" + rewrite(rawBody), ruleNames, scopedRules);
          const json = JSON.stringify({ name: outName(m), description, prompt: body.replace(/^\n+/, "").replace(/\n+$/, ""), tools, allowedTools: tools, resources }, null, 2) + "\n";
          out.push(crlf(`.kiro/agents/${outName(m)}.json`, json, ing.ref));
          break;
        }
        case "command": {
          // Resolve description and raw frontmatter first, then body (spec 17 §4.5 order: frontmatter before body)
          // When frontmatterRaw is set, the description field is unused (serializeFrontmatter ignores it),
          // so we skip resolving it to avoid spurious reports.
          const resolvedDescription = !m.frontmatterRaw && m.description !== undefined ? resolve(m.description, ing.ref) : undefined;
          const resolvedFm = m.frontmatterRaw ? resolve(m.frontmatterRaw, ing.ref) : null;
          const body = resolve(await ctx.text(ing, m.file), ing.ref);
          const doc = serializeFrontmatter(
            { description: resolvedDescription, "argument-hint": m.argumentHint, "allowed-tools": m.allowedTools },
            body,
            { raw: resolvedFm },
          );
          out.push(crlf(`.kiro/steering/commands/${outName(m)}.md`, `---\ninclusion: manual\n---\n\n` + doc, ing.ref));
          break;
        }
        case "skill": {
          if (m.layout === "file") {
            out.push(crlf(`.kiro/skills/${outName(m)}/SKILL.md`, resolve(await ctx.text(ing, "SKILL.md"), ing.ref), ing.ref));
          } else {
            for (const f of await listFiles(ing.dir)) {
              if (f === "ingredient.yaml") continue;
              out.push(await copy(ctx, ing, f, `.kiro/skills/${outName(m)}/${f}`, resolve));
            }
          }
          break;
        }
        case "mcp":
          // Kiro reads MCP servers from .kiro/settings/mcp.json
          mcp.push(ing);
          break;
        default: {
          const never: never = m; // a cell that writes has no case here
          throw new Error(`internal: ${t} has no case for ${(never as Ingredient).type}`);
        }
      }
    }

    // Emit one warning for all dead and unknown references (spec 17 §4.5)
    emitKiroWarning(ctx, reports);

    const servers = mcpServers(ctx, t, ".kiro/settings/mcp.json", mcp);
    if (Object.keys(servers).length) {
      out.push(crlf(".kiro/settings/mcp.json", JSON.stringify({ mcpServers: servers }, null, 2) + "\n", "mcp/*"));
    }
    return out;
  },
};

/** Emit the kiro warning for dead and unknown references (spec 17 §4.5). */
function emitKiroWarning(ctx: EmitBase, reports: RefReport[]): void {
  // Collect entries: D (has kind with "reaches no target") and unknown (empty kind)
  const dead: Array<{ ref: string; citing: string; kind: string }> = [];
  const unknown: Array<{ ref: string; citing: string }> = [];
  const seenDead = new Set<string>();
  const seenUnknown = new Set<string>();

  for (const report of reports) {
    for (const e of report.reworded) {
      const key = `${e.ref}|${e.citing}`;
      if (e.kind !== UNKNOWN_NAME_KIND) {
        // D: has a kind string (e.g. "rule/x reaches no target here")
        if (!seenDead.has(key)) {
          seenDead.add(key);
          dead.push(e);
        }
      } else {
        // unknown: empty kind string (UNKNOWN_NAME_KIND)
        if (!seenUnknown.has(key)) {
          seenUnknown.add(key);
          unknown.push({ ref: e.ref, citing: e.citing });
        }
      }
    }
  }

  if (dead.length === 0 && unknown.length === 0) return;

  const parts: string[] = [];
  if (dead.length > 0) {
    const entries = dead.map((e) => `${e.ref} (in ${e.citing}; ${e.kind})`).join(", ");
    parts.push(`${dead.length} reference(s) to rule files this workspace does not have — reworded: ${entries}`);
  }
  if (unknown.length > 0) {
    const entries = unknown.map((e) => `${e.ref} (in ${e.citing})`).join(", ");
    if (dead.length > 0) {
      parts.push(`${unknown.length} reference(s) to names that are no rule or steering here — rewritten to .kiro/steering/ as before: ${entries}`);
    } else {
      parts.push(`${unknown.length} reference(s) to names that are no rule or steering of this workspace — rewritten to .kiro/steering/ as before: ${entries}`);
    }
  }
  ctx.warn(`kiro: ${parts.join("; ")}`);
}

export function rewrite(text: string): string {
  return text.replace(/\.claude\/rules\//g, ".kiro/steering/");
}

function crlf(path: string, text: string, ingredient: string): PlannedFile {
  return { path, content: Buffer.from(toCrlf(text), "utf8"), target: "kiro", ingredient };
}

async function copy(ctx: EmitBase, ing: ResolvedIngredient, file: string, relPath: string, resolve: (text: string, citing: string) => string): Promise<PlannedFile> {
  if (KIRO_TEXT_EXT.test(file)) return crlf(relPath, resolve(await ctx.text(ing, file), ing.ref), ing.ref);
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

function mapTools(tools: string[], ctx: EmitBase): string[] {
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
  for (const m of text.matchAll(new RegExp(`\\.(?:claude\\/rules|kiro\\/steering)\\/([${RULE_NAME_CHARS}]+)\\.md`, "g"))) {
    const name = m[1];
    if (known.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}
