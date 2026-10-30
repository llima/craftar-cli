import path from "node:path";
import { serializeFrontmatter } from "../core/frontmatter.js";
import { listFiles } from "../core/forge.js";
import { decodeForScan } from "../core/secrets.js";
import { RULES_INDEX_LINE } from "../core/rules-index.js";
import {
  authEnvNames,
  buildRuleLookup,
  EXAMPLE_SETTINGS,
  expandRulesIndex,
  flatSkills,
  flatSkillWarning,
  formatDeadRefs,
  formatScannedRefs,
  hookRegistrations,
  mcpServers,
  MCP_FILE,
  outName,
  resolveRuleRefs,
  ruleFile,
  settingsExample,
  textFile,
  unresolvedRuleRefs,
  UNKNOWN_NAME_KIND,
  type RefReport,
  type RuleLookup,
} from "./shared.js";
import type { Emitter, EmitBase, PlannedFile } from "./types.js";
import type { ResolvedIngredient } from "../core/resolve.js";
import type { Ingredient } from "../schema/index.js";

/**
 * Claude Code target: `.claude/{rules,agents,commands,skills,scripts,hooks}` + `.mcp.json`.
 * Files are emitted verbatim from the Forge so that `import` → `sync` on the source workspace is a no-op.
 *
 * Under agents-md.primary (spec 41 §4.4), references to rules in bodies are resolved through
 * resolveRuleRefs, and copied files are scanned and warned about but not rewritten.
 */
export const claudeCode: Emitter<"claude-code"> = {
  target: "claude-code",
  async emit(ctx) {
    const out: PlannedFile[] = [];
    const t = "claude-code";
    const mcp: ResolvedIngredient[] = [];
    const hooks: ResolvedIngredient[] = [];
    const primary = ctx.resolution.primary;

    // Under the mode, build the lookup once
    const lookup: RuleLookup | null = primary ? buildRuleLookup(ctx.resolution.ingredients, ctx.resolution) : null;
    const targets = ctx.resolution.targets;

    // Collect reports for the warning (spec 41 §4.4)
    const reports: RefReport[] = [];
    const scannedHits: Array<{ path: string; line: number; name: string }> = [];

    // Resolve function under primary mode, returns original text when mode is off
    const resolve = (text: string, citing: string): string => {
      if (!primary || !lookup) return text;
      const { text: resolved, report } = resolveRuleRefs(text, citing, lookup, targets, "agents-md");
      reports.push(report);
      return resolved;
    };

    // Track whether a file was reworded
    // Each [original, resolved] pair is one text of the file, compared on its own (spec 41 §4.4)
    const checkReworded = (path: string, ...pairs: Array<[string | null | undefined, string | null | undefined]>): void => {
      if (primary && pairs.some(([original, resolved]) => original !== resolved)) ctx.reportReworded(path);
    };

    // Scan a file for unresolved references (spec 41 §4.4): files copied as bytes or other TEXT_EXT
    const scanFile = (path: string, content: Buffer): void => {
      if (!primary || !lookup) return;
      const text = decodeForScan(content);
      if (text === null) return; // Binary file
      const hits = unresolvedRuleRefs(text, lookup, targets, "agents-md");
      for (const h of hits) {
        scannedHits.push({ path, line: h.line, name: h.name });
      }
    };

    // An agent's or a command's metadata, then its body (spec 41 §4.4, kiro's order): its frontmatterRaw when it has
    // one, else its description. With the mode off `resolve` returns each text as given.
    const resolveDoc = (path: string, citing: string, m: { frontmatterRaw?: string; description?: string }, rawBody: string) => {
      const raw = m.frontmatterRaw != null ? resolve(m.frontmatterRaw, citing) : null;
      const description = m.frontmatterRaw == null && m.description !== undefined ? resolve(m.description, citing) : m.description;
      const body = resolve(rawBody, citing);
      checkReworded(path, [m.frontmatterRaw ?? m.description, raw ?? description], [rawBody, body]);
      return { raw, description, body };
    };

    // What this target writes comes from its walk; the matrix decides the rest and warns (spec 18).
    for (const ing of ctx.aimed) {
      const m = ing.meta;
      switch (m.type) {
        case "rule": {
          const rawBody = await ctx.text(ing, m.file, "claude-code");
          const resolved = resolve(rawBody, ing.ref);
          const path = ruleFile("claude-code", m);
          // Expand the rules index at the gate (spec 44 §4.4), after resolve, before frontmatter
          let body = resolved;
          if (ctx.resolution.rulesIndex) {
            const indexResult = expandRulesIndex(resolved, "claude-code", buildRuleLookup(ctx.resolution.ingredients, ctx.resolution), ctx.resolution);
            body = indexResult.text;
            if (indexResult.listed > 0 || indexResult.undescribed.length > 0 || (indexResult.misplaced && indexResult.misplaced.length > 0)) {
              ctx.reportIndex({ path, rules: indexResult.listed, undescribed: indexResult.undescribed, misplaced: indexResult.misplaced });
            }
          }
          // If frontmatterRaw is set, serialize with it; otherwise emit body only (no generated paths:)
          // frontmatterRaw is NOT resolved (spec 41 §4.4)
          const doc = m.frontmatterRaw != null ? serializeFrontmatter({}, body, { raw: m.frontmatterRaw }) : body;
          checkReworded(path, [rawBody, body]);
          out.push(await textFile(ctx, path, doc, t, ing.ref));
          break;
        }
        case "agent": {
          const path = `.claude/agents/${outName(m)}.md`;
          const { raw, description, body } = resolveDoc(path, ing.ref, m, await ctx.text(ing, m.file, "claude-code"));
          // At the gate, report if the placeholder is in an agent body (spec 44 §4.5)
          if (ctx.resolution.rulesIndex && RULES_INDEX_LINE.test(body)) {
            ctx.reportIndexLeft(path);
          }
          const doc = serializeFrontmatter({ name: outName(m), description, tools: m.tools, model: m.model }, body, { raw });
          out.push(await textFile(ctx, path, doc, t, ing.ref));
          break;
        }
        case "command": {
          const path = `.claude/commands/${outName(m)}.md`;
          const { raw, description, body } = resolveDoc(path, ing.ref, m, await ctx.text(ing, m.file, "claude-code"));
          // At the gate, report if the placeholder is in a command body (spec 44 §4.5)
          if (ctx.resolution.rulesIndex && RULES_INDEX_LINE.test(body)) {
            ctx.reportIndexLeft(path);
          }
          const doc = serializeFrontmatter(
            { description, "argument-hint": m.argumentHint, "allowed-tools": m.allowedTools },
            body,
            { raw },
          );
          out.push(await textFile(ctx, path, doc, t, ing.ref));
          break;
        }
        case "skill": {
          if (m.layout === "file") {
            const path = `.claude/skills/${outName(m)}.md`;
            const rawText = await ctx.text(ing, "SKILL.md", "claude-code");
            const text = resolve(rawText, ing.ref);
            checkReworded(path, [rawText, text]);
            // At the gate, report if the placeholder is in a skill body (spec 44 §4.5)
            if (ctx.resolution.rulesIndex && RULES_INDEX_LINE.test(text)) {
              ctx.reportIndexLeft(path);
            }
            out.push(await textFile(ctx, path, text, t, ing.ref));
          } else {
            // Directory skill: resolve .md files, scan others
            for (const f of await listFiles(ing.dir)) {
              if (f === "ingredient.yaml") continue;
              const path = `.claude/skills/${outName(m)}/${f}`;
              if (claudeResolves(m, f)) {
                const rawText = await ctx.text(ing, f, "claude-code");
                const text = resolve(rawText, ing.ref);
                checkReworded(path, [rawText, text]);
                // At the gate, report if the placeholder is in a skill body (spec 44 §4.5)
                if (ctx.resolution.rulesIndex && RULES_INDEX_LINE.test(text)) {
                  ctx.reportIndexLeft(path);
                }
                out.push(await textFile(ctx, path, text, t, ing.ref));
              } else if (TEXT_EXT.test(f)) {
                // Other text files: not resolved, but scanned
                const rawText = await ctx.text(ing, f, "claude-code");
                if (primary && lookup) {
                  scanFile(path, Buffer.from(rawText, "utf8"));
                }
                out.push(await textFile(ctx, path, rawText, t, ing.ref));
              } else {
                // Binary files: copied as bytes, scanned
                const content = await ctx.bytes(ing, f);
                scanFile(path, content);
                out.push({ path, content, target: t, ingredient: ing.ref });
              }
            }
          }
          break;
        }
        case "script":
          for (const f of m.files) {
            const path = `.claude/scripts/${f}`;
            const file = await anyFileWithScan(ctx, ing, f, path, t, lookup, targets, primary, scanFile);
            out.push(file);
          }
          break;
        case "hook":
          hooks.push(ing); // collected for registration below
          for (const f of m.files) {
            const path = `.claude/hooks/${f}`;
            const file = await anyFileWithScan(ctx, ing, f, path, t, lookup, targets, primary, scanFile);
            out.push(file);
          }
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

    // Emit the claude-code warning (spec 41 §4.4)
    if (primary) {
      emitClaudeCodeWarning(ctx, reports, scannedHits);
    }

    // Emit the flat skill warning (spec 44 §5): after the walk, once, with sorted names
    const flat = flatSkills(ctx.resolution, targets);
    if (flat.length > 0) {
      ctx.warn(flatSkillWarning(flat, "claude-code"));
    }

    const servers = mcpServers(ctx, t, MCP_FILE["claude-code"], mcp);
    if (Object.keys(servers).length) {
      const json = JSON.stringify({ mcpServers: servers }, null, 2) + "\n";
      out.push(await textFile(ctx, MCP_FILE["claude-code"], json, t, "mcp/*"));
    }

    // Write the example file when authEnvNames is non-empty or hooks have registration (spec 27 §4.2, spec 43 §5.1)
    const names = authEnvNames(mcp);
    const hooksObj = hookRegistrations(ctx, hooks);

    // Build env object on null prototype so __proto__ is a key, not the prototype
    const env: Record<string, string> | null = names.length > 0 ? Object.create(null) : null;
    if (env) {
      for (const name of names) env[name] = "";
    }

    const exampleObj = settingsExample(env, hooksObj);
    if (exampleObj) {
      const exJson = JSON.stringify(exampleObj, null, 2) + "\n";
      out.push(await textFile(ctx, EXAMPLE_SETTINGS, exJson, t, "mcp/*"));
    }
    return out;
  },
};

/**
 * Whether the claude-code emitter resolves rule references in this file of an ingredient under agents-md.primary
 * (spec 41 §4.4): a rule's, an agent's or a command's body file, a file-layout skill's SKILL.md and every `.md` file of a
 * directory skill. Every other file is copied as written and scanned. An agent's and a command's metadata are resolved
 * too (`frontmatterRaw` when present, else `description`). The one answer, read by the emitter and by import (§4.10).
 */
export function claudeResolves(meta: Ingredient, file: string): boolean {
  // Compared as the emitters read them (`emittedFile`): `./rule.md` and `/rule.md` name the file listed as `rule.md`.
  const eq = (a: string, b: string) => path.posix.join(".", a) === path.posix.join(".", b);
  switch (meta.type) {
    case "rule":
    case "agent":
    case "command":
      return eq(file, meta.file);
    case "skill":
      return meta.layout === "file" ? eq(file, "SKILL.md") : /\.md$/i.test(file);
    default:
      return false;
  }
}

/** Files claude-code emits as text, through `ctx.text` (substituted); anything else is copied as raw bytes. */
export const TEXT_EXT = /\.(md|txt|json|ya?ml|ps1|py|sh|js|ts|cjs|mjs|toml|xml|csv)$/i;

/** Emit a file for scripts/hooks: scan but do not rewrite (spec 41 §4.4). */
async function anyFileWithScan(
  ctx: EmitBase,
  ing: ResolvedIngredient,
  file: string,
  relPath: string,
  target: PlannedFile["target"],
  lookup: RuleLookup | null,
  targets: readonly string[],
  primary: boolean,
  scanFile: (path: string, content: Buffer) => void,
): Promise<PlannedFile> {
  if (TEXT_EXT.test(file)) {
    const text = await ctx.text(ing, file, "claude-code");
    if (primary && lookup) {
      scanFile(relPath, Buffer.from(text, "utf8"));
    }
    return textFile(ctx, relPath, text, target, ing.ref);
  }
  const content = await ctx.bytes(ing, file);
  scanFile(relPath, content);
  return { path: relPath, content, target, ingredient: ing.ref };
}

/** Emit the claude-code warning for dead references and scanned files (spec 41 §4.4). */
function emitClaudeCodeWarning(
  ctx: EmitBase,
  reports: RefReport[],
  scannedHits: Array<{ path: string; line: number; name: string }>,
): void {
  // Collect D entries: dead references (kind not empty, not UNKNOWN_NAME_KIND)
  // Unknown names produce nothing in claude-code (claude-code is a target, so they are unchanged — state A-like)
  const dead: Array<{ ref: string; citing: string; kind: string }> = [];
  const seenDead = new Set<string>();

  for (const report of reports) {
    for (const e of report.reworded) {
      if (e.kind === UNKNOWN_NAME_KIND) continue; // Unknown names are unchanged with claude-code
      const key = `${e.ref}|${e.citing}`;
      if (!seenDead.has(key)) {
        seenDead.add(key);
        dead.push(e);
      }
    }
  }

  // Dedupe scanned hits by path+line+name
  const seenScanned = new Set<string>();
  const dedupedHits: Array<{ path: string; line: number; name: string }> = [];
  // Sort by path then line
  const sortedHits = [...scannedHits].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  for (const h of sortedHits) {
    const key = `${h.path}:${h.line}:${h.name}`;
    if (!seenScanned.has(key)) {
      seenScanned.add(key);
      dedupedHits.push(h);
    }
  }

  if (dead.length === 0 && dedupedHits.length === 0) return;

  const parts: string[] = [];
  if (dead.length > 0) {
    parts.push(formatDeadRefs(dead));
  }
  if (dedupedHits.length > 0) {
    parts.push(formatScannedRefs(dedupedHits));
  }
  ctx.warn(`claude-code: ${parts.join("; ")}`);
}
