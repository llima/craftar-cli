import { detectEol, withEol, type Eol } from "../core/text.js";
import { serializeFrontmatter } from "../core/frontmatter.js";
import { listFiles } from "../core/forge.js";
import type { Emitter, EmitContext, PlannedFile } from "./types.js";

/**
 * Claude Code target: `.claude/{rules,agents,commands,skills,scripts,hooks}` + `.mcp.json`.
 * Files are emitted verbatim from the Forge so that `import` → `sync` on the source workspace is a no-op.
 */
export const claudeCode: Emitter = {
  target: "claude-code",
  async emit(ctx) {
    const out: PlannedFile[] = [];
    const mcp: Record<string, unknown> = {};
    const t = "claude-code";

    for (const ing of ctx.resolution.ingredients) {
      if (!appliesTo(ing.meta.targets, t)) continue;
      const m = ing.meta;
      switch (m.type) {
        case "rule":
          out.push(await textFile(ctx, `.claude/rules/${outName(m)}.md`, await ctx.text(ing, m.file), t, ing.ref));
          break;
        case "agent": {
          const body = await ctx.text(ing, m.file);
          const fm = m.frontmatterRaw ?? null;
          const doc = serializeFrontmatter({ name: outName(m), description: m.description, tools: m.tools, model: m.model }, body, { raw: fm });
          out.push(await textFile(ctx, `.claude/agents/${outName(m)}.md`, doc, t, ing.ref));
          break;
        }
        case "command": {
          const body = await ctx.text(ing, m.file);
          const doc = serializeFrontmatter(
            { description: m.description, "argument-hint": m.argumentHint, "allowed-tools": m.allowedTools },
            body,
            { raw: m.frontmatterRaw ?? null },
          );
          out.push(await textFile(ctx, `.claude/commands/${outName(m)}.md`, doc, t, ing.ref));
          break;
        }
        case "skill": {
          if (m.layout === "file") {
            out.push(await textFile(ctx, `.claude/skills/${outName(m)}.md`, await ctx.text(ing, "SKILL.md"), t, ing.ref));
          } else {
            for (const f of await listFiles(ing.dir)) {
              if (f === "ingredient.yaml") continue;
              out.push(await anyFile(ctx, ing, f, `.claude/skills/${outName(m)}/${f}`, t));
            }
          }
          break;
        }
        case "script":
          for (const f of m.files) out.push(await anyFile(ctx, ing, f, `.claude/scripts/${f}`, t));
          break;
        case "hook":
          for (const f of m.files) out.push(await anyFile(ctx, ing, f, `.claude/hooks/${f}`, t));
          break;
        case "mcp":
          mcp[m.name] = m.server;
          break;
        case "steering":
          break; // Kiro-only by nature
      }
    }

    if (Object.keys(mcp).length) {
      const json = JSON.stringify({ mcpServers: mcp }, null, 2) + "\n";
      out.push(await textFile(ctx, ".mcp.json", json, t, "mcp/*"));
    }
    return out;
  },
};

export function appliesTo(targets: "*" | string[], target: string): boolean {
  return targets === "*" || targets.includes(target);
}

/** Text file that keeps the EOL of the file it replaces (LF when new). */
export async function textFile(ctx: EmitContext, relPath: string, text: string, target: PlannedFile["target"], ingredient: string): Promise<PlannedFile> {
  const existing = await ctx.readExisting(relPath);
  const eol: Eol = existing ? detectEol(existing.toString("utf8")) : "lf";
  return { path: relPath, content: Buffer.from(withEol(text, eol), "utf8"), target, ingredient };
}

const TEXT_EXT = /\.(md|txt|json|ya?ml|ps1|py|sh|js|ts|cjs|mjs|toml|xml|csv)$/i;

async function anyFile(ctx: EmitContext, ing: Parameters<EmitContext["text"]>[0], file: string, relPath: string, target: PlannedFile["target"]): Promise<PlannedFile> {
  if (TEXT_EXT.test(file)) return textFile(ctx, relPath, await ctx.text(ing, file), target, ing.ref);
  return { path: relPath, content: await ctx.bytes(ing, file), target, ingredient: ing.ref };
}


function outName(m: { name: string; as?: string }): string {
  return m.as ?? m.name;
}
