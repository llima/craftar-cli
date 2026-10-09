import { serializeFrontmatter } from "../core/frontmatter.js";
import { listFiles } from "../core/forge.js";
import { authEnvNames, EXAMPLE_SETTINGS, mcpServers, outName, ruleFile, textFile } from "./shared.js";
import type { Emitter, EmitBase, PlannedFile } from "./types.js";
import type { ResolvedIngredient } from "../core/resolve.js";
import type { Ingredient } from "../schema/index.js";

/**
 * Claude Code target: `.claude/{rules,agents,commands,skills,scripts,hooks}` + `.mcp.json`.
 * Files are emitted verbatim from the Forge so that `import` → `sync` on the source workspace is a no-op.
 */
export const claudeCode: Emitter<"claude-code"> = {
  target: "claude-code",
  async emit(ctx) {
    const out: PlannedFile[] = [];
    const t = "claude-code";
    const mcp: ResolvedIngredient[] = [];

    // What this target writes comes from its walk; the matrix decides the rest and warns (spec 18).
    for (const ing of ctx.aimed) {
      const m = ing.meta;
      switch (m.type) {
        case "rule":
          out.push(await textFile(ctx, ruleFile("claude-code", m), await ctx.text(ing, m.file), t, ing.ref));
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
          mcp.push(ing); // collected into .mcp.json below
          break;
        default: {
          const never: never = m; // a cell that writes has no case here
          throw new Error(`internal: ${t} has no case for ${(never as Ingredient).type}`);
        }
      }
    }

    const servers = mcpServers(ctx, t, ".mcp.json", mcp);
    if (Object.keys(servers).length) {
      const json = JSON.stringify({ mcpServers: servers }, null, 2) + "\n";
      out.push(await textFile(ctx, ".mcp.json", json, t, "mcp/*"));
    }

    // Write the example file when authEnvNames is non-empty (spec 27 §4.2)
    const names = authEnvNames(mcp);
    if (names.length) {
      // Build env object on null prototype so __proto__ is a key, not the prototype
      const env: Record<string, string> = Object.create(null);
      for (const name of names) env[name] = "";
      const exJson = JSON.stringify({ env }, null, 2) + "\n";
      out.push(await textFile(ctx, EXAMPLE_SETTINGS, exJson, t, "mcp/*"));
    }
    return out;
  },
};

/** Files claude-code emits as text, through `ctx.text` (substituted); anything else is copied as raw bytes. */
export const TEXT_EXT = /\.(md|txt|json|ya?ml|ps1|py|sh|js|ts|cjs|mjs|toml|xml|csv)$/i;

async function anyFile(ctx: EmitBase, ing: Parameters<EmitBase["text"]>[0], file: string, relPath: string, target: PlannedFile["target"]): Promise<PlannedFile> {
  if (TEXT_EXT.test(file)) return textFile(ctx, relPath, await ctx.text(ing, file), target, ing.ref);
  return { path: relPath, content: await ctx.bytes(ing, file), target, ingredient: ing.ref };
}
