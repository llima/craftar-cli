import { listFiles } from "../core/forge.js";
import type { Ingredient } from "../schema/index.js";
import { TEXT_EXT } from "./claude-code.js";
import { decodeForScan } from "../core/secrets.js";
import { buildRuleLookup, formatScannedRefs, outName, textFile, unresolvedRuleRefs } from "./shared.js";
import type { Emitter, PlannedFile } from "./types.js";

// A skill folder's text files are rendered through ctx.text, as claude-code renders them (TEXT_EXT, one list); every other file is copied as bytes.

/**
 * The standard skills folder (spec 61 §6, Ruling 3): `.agents/skills/<name>/`, read by Cursor, Copilot, Codex, Antigravity and
 * others. A command is written there as a skill only a person invokes (spec 61 §9, Ruling 6).
 */
export const agentSkills: Emitter<"agent-skills"> = {
  target: "agent-skills",
  async emit(ctx) {
    const out: PlannedFile[] = [];
    const t = "agent-skills";
    /** outName, lower-cased (Windows and macOS fold case), → the ref of the skill or command that writes `.agents/skills/<outName>/`. */
    const owners = new Map<string, { ref: string; type: "skill" | "command" }>();
    const claim = (name: string, ref: string, type: "skill" | "command") => {
      const key = name.toLowerCase();
      const prev = owners.get(key);
      if (prev && prev.type !== type) {
        const [cmd, skill] = type === "command" ? [ref, prev.ref] : [prev.ref, ref];
        throw new Error(`agent-skills: ${cmd} and ${skill} both write .agents/skills/${name}/ — rename one of them`);
      }
      owners.set(key, { ref, type });
    };
    // Skill files are copied as written, never rewritten (spec 14, spec 41 §4.4): a `.claude/rules/<x>.md` reference whose file no
    // target of the workspace writes is named, by path and line, in one warning — never a line of the file.
    const lookup = buildRuleLookup(ctx.resolution.ingredients, ctx.resolution);
    const hits: Array<{ path: string; line: number; name: string }> = [];
    const scan = (f: PlannedFile): PlannedFile => {
      const text = decodeForScan(f.content);
      if (text !== null) for (const h of unresolvedRuleRefs(text, lookup, ctx.resolution.targets, "agents-md")) hits.push({ path: f.path, line: h.line, name: h.name });
      return f;
    };
    for (const ing of ctx.aimed) {
      const m = ctx.meta(ing);
      switch (m.type) {
        case "skill": {
          const dir = `.agents/skills/${outName(m)}`;
          claim(outName(m), ing.ref, "skill");
          if (m.layout === "file") {
            out.push(scan(await textFile(ctx, `${dir}/SKILL.md`, await ctx.text(ing, "SKILL.md", t), t, ing.ref, { keepBom: false })));
          } else {
            for (const f of await listFiles(ing.dir)) {
              if (f === "ingredient.yaml") continue;
              const path = `${dir}/${f}`;
              if (TEXT_EXT.test(f)) out.push(scan(await textFile(ctx, path, await ctx.text(ing, f, t), t, ing.ref, { keepBom: false })));
              else out.push({ path, content: await ctx.bytes(ing, f), target: t, ingredient: ing.ref });
            }
          }
          break;
        }
        case "command": {
          claim(outName(m), ing.ref, "command");
          const lines = [`name: ${JSON.stringify(outName(m))}`];
          if (m.description) lines.push(`description: ${JSON.stringify(m.description)}`);
          else ctx.warn(`agent-skills: command "${outName(m)}" has no description, which the Agent Skills format expects; a reader may skip it`);
          if (m.argumentHint) lines.push(`argument-hint: ${JSON.stringify(m.argumentHint)}`);
          lines.push("disable-model-invocation: true");
          if ((m.allowedTools?.length ?? 0) > 0) ctx.warn(`agent-skills: command "${outName(m)}": allowed-tools is not written to a skill; dropped`);
          const doc = `---\n${lines.join("\n")}\n---\n` + (await ctx.text(ing, m.file, t));
          out.push(scan(await textFile(ctx, `.agents/skills/${outName(m)}/SKILL.md`, doc, t, ing.ref, { keepBom: false })));
          break;
        }
        default: {
          const never: never = m;
          throw new Error(`internal: ${t} has no case for ${(never as Ingredient).type}`);
        }
      }
    }
    if (hits.length) {
      const sorted = [...hits].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
      ctx.warn(`agent-skills: ${formatScannedRefs(sorted)}`);
    }
    return out;
  },
};
