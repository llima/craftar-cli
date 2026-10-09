import { detectEol, hasBom, withEol, type Eol } from "../core/text.js";
import type { EmitBase, PlannedFile } from "./types.js";
import type { ResolvedIngredient } from "../core/resolve.js";
import type { Ingredient } from "../schema/index.js";

export function appliesTo(targets: "*" | string[], target: string): boolean {
  return targets === "*" || targets.includes(target);
}

/** The characters of a rule name in a `.claude/rules/<name>.md` reference (spec 15 §4.1). */
export const RULE_NAME_CHARS = "A-Za-z0-9._-";

/** Token pattern for rule references: `.claude/rules/<name>.md` with left boundary (spec 15 §4.1). */
const TOKEN_PATTERN_SOURCE = `(^|[^/${RULE_NAME_CHARS}])(\\.claude\\/rules\\/([${RULE_NAME_CHARS}]+)\\.md)`;

/**
 * The target that writes a rule's own file in this workspace, `claude-code` first, else `kiro`, else none
 * (spec 14 §4.1): a workspace target the rule's `targets` admit.
 */
export function ruleWriter(targets: readonly string[], ruleTargets: "*" | string[]): "claude-code" | "kiro" | null {
  if (targets.includes("claude-code") && appliesTo(ruleTargets, "claude-code")) return "claude-code";
  if (targets.includes("kiro") && appliesTo(ruleTargets, "kiro")) return "kiro";
  return null;
}

/** Report of what resolveRuleRefs reworded or found dead (spec 15 §4.5). */
export interface RefReport {
  reworded: Array<{ ref: string; citing: string; kind: string }>;
  others: Array<{ path: string; citing: string }>;
}

/** The kind string for an unknown name (no rule or steering with that name). */
export const UNKNOWN_NAME_KIND = "";

/** Lookup maps for rule reference resolution (spec 15 §4.2), built once per AGENTS.md. */
export interface RuleLookup {
  rulesByName: Map<string, ResolvedIngredient>;
  steeringsByName: Map<string, ResolvedIngredient>;
}

/** Build the lookup maps for rule reference resolution, once per AGENTS.md. */
export function buildRuleLookup(ingredients: ResolvedIngredient[]): RuleLookup {
  const rulesByName = new Map<string, ResolvedIngredient>();
  const steeringsByName = new Map<string, ResolvedIngredient>();
  for (const ing of ingredients) {
    const name = outName(ing.meta);
    if (ing.meta.type === "rule") rulesByName.set(name, ing);
    else if (ing.meta.type === "steering") steeringsByName.set(name, ing);
  }
  return { rulesByName, steeringsByName };
}

/**
 * Resolve `.claude/rules/<x>.md` references in a body (spec 15 §4.1–§4.3, spec 17 §4.2–§4.3, spec 20).
 * Mode "agents-md" (default) is for AGENTS.md; mode "kiro" is for kiro files.
 * Returns the transformed text and a report of what was reworded or found dead.
 */
export function resolveRuleRefs(
  body: string,
  citing: string,
  lookup: RuleLookup,
  targets: readonly string[],
  mode: "agents-md" | "kiro" = "agents-md",
): { text: string; report: RefReport } {
  const report: RefReport = { reworded: [], others: [] };
  const hasCc = targets.includes("claude-code");
  const hasKiro = targets.includes("kiro");
  const hasMd = targets.includes("agents-md");
  const { rulesByName, steeringsByName } = lookup;

  // Determine rule state (spec 15 §4.2 for agents-md, spec 17 §4.2 for kiro)
  // agents-md: A (claude-code writes), B (kiro writes), C (agents-md), D (rule exists), unknown
  // kiro:     K1 (kiro writes), K2 (claude-code writes), K3 (agents-md has it), D, unknown
  type State = "A" | "B" | "C" | "D" | "K1" | "K2" | "K3" | "unknown";
  const ruleState = (name: string): State => {
    const rule = rulesByName.get(name);
    if (mode === "kiro") {
      // K1: kiro writes it — a rule or steering that admits kiro (spec 17 §4.2)
      if (rule && hasKiro && appliesTo(rule.meta.targets, "kiro")) return "K1";
      const steering = steeringsByName.get(name);
      if (steering && hasKiro && appliesTo(steering.meta.targets, "kiro")) return "K1";
      // K2: a rule and claude-code writes it
      if (rule && hasCc && appliesTo(rule.meta.targets, "claude-code")) return "K2";
      // K3: a rule aimed at agents-md, and agents-md is a workspace target
      if (rule && hasMd && appliesTo(rule.meta.targets, "agents-md")) return "K3";
      // D: any other rule
      if (rule) return "D";
      // unknown: anything else
      return "unknown";
    }
    // agents-md mode (spec 15 §4.2)
    if (rule) {
      const writer = ruleWriter(targets, rule.meta.targets);
      if (writer === "claude-code") return "A";
      if (writer === "kiro") return "B";
    }
    // B (steering): kiro writes a steering with this name — checked before C/D (spec 15 §4.2)
    const steering = steeringsByName.get(name);
    if (steering && hasKiro && appliesTo(steering.meta.targets, "kiro")) return "B";
    if (rule) {
      if (appliesTo(rule.meta.targets, "agents-md")) return "C";
      return "D";
    }
    return "unknown";
  };

  // Right boundary: not followed by letter, digit, `_`, `-`, or `.` followed by one of those (spec 15 §4.1)
  // NOTE: The right boundary class is NOT the same as RULE_NAME_CHARS (which includes `.` for names).
  const rightBoundary = (after: string): boolean => {
    if (!after) return true;
    const c = after[0];
    if (/[A-Za-z0-9_-]/.test(c)) return false;
    if (c === "." && after.length > 1 && /[A-Za-z0-9_-]/.test(after[1])) return false;
    return true;
  };

  // Blanket rewrite for kiro mode: .claude/rules/ → .kiro/steering/
  const kiroRewrite = (s: string): string => s.replace(/\.claude\/rules\//g, ".kiro/steering/");

  // Resolve a single token reference (spec 20 §4.1): used for tokens and link text references.
  // Returns the replacement text and, if it rewords to "not in this workspace", the reworded entry.
  const resolveToken = (name: string): { text: string; reworded?: { ref: string; kind: string } } => {
    const state = ruleState(name);
    const rule = rulesByName.get(name);
    if (mode === "kiro") {
      switch (state) {
        case "K1": return { text: ruleFile("kiro", { name }) };
        case "K2": return { text: `.claude/rules/${name}.md` };  // unchanged
        case "K3": return { text: `AGENTS.md (rule: ${name})` };
        case "D": return { text: `${name} (rule not in this workspace)`, reworded: { ref: `.claude/rules/${name}.md`, kind: `${rule!.ref} reaches no target here` } };
        case "unknown": return { text: ruleFile("kiro", { name }), reworded: { ref: `.claude/rules/${name}.md`, kind: UNKNOWN_NAME_KIND } };
      }
    } else {
      switch (state) {
        case "A": return { text: `.claude/rules/${name}.md` };  // unchanged
        case "B": return { text: ruleFile("kiro", { name }) };
        case "C": return { text: `AGENTS.md (rule: ${name})` };
        case "D": return { text: `${name} (rule not in this workspace)`, reworded: { ref: `.claude/rules/${name}.md`, kind: `${rule!.ref} reaches no target here` } };
        case "unknown":
          if (hasCc) return { text: `.claude/rules/${name}.md` };  // unchanged
          return { text: `${name} (rule not in this workspace)`, reworded: { ref: `.claude/rules/${name}.md`, kind: "no such rule" } };
      }
    }
    return { text: `.claude/rules/${name}.md` };  // fallback
  };

  // Collapse: a link whose text is exactly its path becomes the token form (spec 20 §4.2).
  // Returns the token form if collapsible, null otherwise.
  const collapse = (text: string, name: string): string | null => {
    const exactPath = `.claude/rules/${name}.md`;
    const backtickedPath = `\`${exactPath}\``;
    if (text !== exactPath && text !== backtickedPath) return null;
    const hasBackticks = text === backtickedPath;
    const tokenText = `${name} (rule not in this workspace)`;
    return hasBackticks ? `\`${tokenText}\`` : tokenText;
  };

  // Resolve references inside link text (spec 20 §4.1). Returns the resolved text and any reworded
  // entries from the text's references. In kiro mode, non-references get the directory rewrite
  // except for K2 links (Ruling 4: non-references stay as written).
  const resolveTextRefs = (text: string, isK2: boolean): { resolved: string; reworded: Array<{ offset: number; ref: string; kind: string }> } => {
    const textPattern = new RegExp(TOKEN_PATTERN_SOURCE, "g");
    const textMatches: Array<{ offset: number; length: number; replacement: string; reworded?: { ref: string; kind: string } }> = [];
    let textMatch;
    while ((textMatch = textPattern.exec(text)) !== null) {
      const [match, before, token, name] = textMatch as RegExpExecArray & [string, string, string, string];
      const offset = textMatch.index + before.length;
      const fullOffset = textMatch.index + match.length;
      const after = text.slice(fullOffset);
      if (!rightBoundary(after)) continue;
      const { text: replacement, reworded } = resolveToken(name);
      textMatches.push({ offset, length: token.length, replacement, reworded });
    }
    // Build the result: gaps get the blanket rewrite in kiro mode, unless this is a K2 link (Ruling 4)
    let resolved = "";
    let lastEnd = 0;
    const rewordedEntries: Array<{ offset: number; ref: string; kind: string }> = [];
    for (const m of textMatches) {
      const gap = text.slice(lastEnd, m.offset);
      resolved += (mode === "kiro" && !isK2) ? kiroRewrite(gap) : gap;
      resolved += m.replacement;
      lastEnd = m.offset + m.length;
      if (m.reworded) rewordedEntries.push({ offset: m.offset, ref: m.reworded.ref, kind: m.reworded.kind });
    }
    const tail = text.slice(lastEnd);
    resolved += (mode === "kiro" && !isK2) ? kiroRewrite(tail) : tail;
    return { resolved, reworded: rewordedEntries };
  };

  // Collect all matches from the original body with their offsets. Warning order follows the
  // original body (spec 15 §4.5, spec 20 §4.3); matches are applied in order, and in kiro mode the
  // gaps between them get the directory rewrite.
  interface Match {
    offset: number;
    length: number;
    replacement: string;
    reworded: Array<{ offset: number; ref: string; kind: string }>;
  }
  const matches: Match[] = [];

  // Link pattern: [text](.claude/rules/<name>.md) or [text](.claude/rules/<name>.md#frag)
  const linkPattern = new RegExp(
    `\\[([^\\]]+)\\]\\(\\.claude\\/rules\\/([${RULE_NAME_CHARS}]+)\\.md(#[^)]*)?\\)`,
    "g",
  );
  let linkMatch;
  while ((linkMatch = linkPattern.exec(body)) !== null) {
    const [match, text, name, frag] = linkMatch as RegExpExecArray & [string, string, string, string | undefined];
    const offset = linkMatch.index;
    // Warning offset is at the target's start, not at `[` (spec 20 §4.3)
    const targetOffset = offset + 1 + text.length + 2;  // `[` + text + `](`
    const state = ruleState(name);
    const rule = rulesByName.get(name);
    let replacement: string;
    const reworded: Array<{ offset: number; ref: string; kind: string }> = [];

    // Resolve references in the link's text (spec 20 §4.1)
    const isK2 = mode === "kiro" && state === "K2";
    const { resolved: resolvedText, reworded: textReworded } = resolveTextRefs(text, isK2);
    // Add text reworded entries, positioned before the link's target (spec 20 §4.3)
    for (const tw of textReworded) reworded.push({ offset: offset + 1 + tw.offset, ref: tw.ref, kind: tw.kind });

    if (mode === "kiro") {
      // Kiro mode (spec 17 §4.3)
      switch (state) {
        case "K1":
          // Fragment gets the blanket rewrite too (spec 17 §4.3)
          replacement = `[${resolvedText}](${ruleFile("kiro", { name })}${kiroRewrite(frag ?? "")})`;
          break;
        case "K2":
          // unchanged target — but text references are resolved (spec 20 §4.1, Ruling 4)
          replacement = `[${resolvedText}](${`.claude/rules/${name}.md`}${frag ?? ""})`;
          break;
        case "K3":
          replacement = `[${resolvedText}](AGENTS.md)`; // fragment dropped
          break;
        case "D": {
          // Check for collapse (spec 20 §4.2)
          const collapsed = collapse(text, name);
          if (collapsed) {
            replacement = collapsed;
            reworded.length = 0;  // Collapsed: only one entry, from the token form
          } else {
            replacement = `${resolvedText} (${name}, rule not in this workspace)`;
          }
          reworded.push({ offset: targetOffset, ref: `.claude/rules/${name}.md`, kind: `${rule!.ref} reaches no target here` });
          break;
        }
        case "unknown": {
          // Unknown name gets blanket rewrite and is reported (no kind string)
          // Fragment gets the blanket rewrite too (spec 17 §4.3)
          reworded.push({ offset: targetOffset, ref: `.claude/rules/${name}.md`, kind: UNKNOWN_NAME_KIND });
          replacement = `[${resolvedText}](${ruleFile("kiro", { name })}${kiroRewrite(frag ?? "")})`;
          break;
        }
        default:
          continue;
      }
    } else {
      // agents-md mode (spec 15 §4.3)
      switch (state) {
        case "A":
          // State A: link unchanged, but text is now resolved like a token (spec 20 §4.1)
          // The text resolution already happened; we only emit a match if the text changed
          if (resolvedText !== text) {
            replacement = `[${resolvedText}](${`.claude/rules/${name}.md`}${frag ?? ""})`;
          } else {
            continue;  // No change needed
          }
          break;
        case "B":
          replacement = `[${resolvedText}](${ruleFile("kiro", { name })}${frag ?? ""})`;
          break;
        case "C":
          replacement = `[${resolvedText}](AGENTS.md)`;
          break;
        case "D": {
          // Check for collapse (spec 20 §4.2)
          const collapsed = collapse(text, name);
          if (collapsed) {
            replacement = collapsed;
            reworded.length = 0;  // Collapsed: only one entry, from the token form
          } else {
            replacement = `${resolvedText} (${name}, rule not in this workspace)`;
          }
          reworded.push({ offset: targetOffset, ref: `.claude/rules/${name}.md`, kind: `${rule!.ref} reaches no target here` });
          break;
        }
        case "unknown":
          if (hasCc) {
            // With claude-code, unknown links are not consumed — but text is resolved (spec 20 §4.1)
            if (resolvedText !== text) {
              replacement = `[${resolvedText}](${`.claude/rules/${name}.md`}${frag ?? ""})`;
            } else {
              continue;  // No change needed
            }
          } else {
            // Without claude-code: collapse or reword (spec 20 §4.2)
            const collapsed = collapse(text, name);
            if (collapsed) {
              replacement = collapsed;
              reworded.length = 0;  // Collapsed: clear text entries
            } else {
              replacement = `${resolvedText} (${name}, rule not in this workspace)`;
            }
            reworded.push({ offset: targetOffset, ref: `.claude/rules/${name}.md`, kind: "no such rule" });
          }
          break;
        default:
          continue;
      }
    }
    matches.push({ offset, length: match.length, replacement, reworded });
  }

  // Token pattern: .claude/rules/<name>.md (not in a link) with left boundary
  const tokenPattern = new RegExp(TOKEN_PATTERN_SOURCE, "g");
  let tokenMatch;
  while ((tokenMatch = tokenPattern.exec(body)) !== null) {
    const [match, before, token, name] = tokenMatch as RegExpExecArray & [string, string, string, string];
    // The offset of the actual token, not the left boundary; used for overlap checks and ordering
    const offset = tokenMatch.index + before.length;
    const fullOffset = tokenMatch.index + match.length;
    const after = body.slice(fullOffset);
    if (!rightBoundary(after)) continue;
    // Skip if this offset overlaps with a link match (link pattern already captured it)
    if (matches.some((m) => offset >= m.offset && offset < m.offset + m.length)) continue;
    const { text: replacement, reworded } = resolveToken(name);
    const rewordedEntries: Array<{ offset: number; ref: string; kind: string }> = [];
    if (reworded) rewordedEntries.push({ offset, ref: reworded.ref, kind: reworded.kind });
    // Always add the match even if unchanged (K2, state A, unknown with claude-code) so the token
    // is excluded from gap rewriting in kiro mode
    matches.push({ offset, length: token.length, replacement, reworded: rewordedEntries });
  }

  // Sort by offset for correct warning order
  matches.sort((a, b) => a.offset - b.offset);

  // Collect reworded entries with their original offsets for sorting (spec 15 §4.5, spec 20 §4.3)
  const rewordedWithOffset: Array<{ offset: number; ref: string; citing: string; kind: string }> = [];
  for (const m of matches) {
    for (const rw of m.reworded) {
      rewordedWithOffset.push({ offset: rw.offset, ref: rw.ref, citing, kind: rw.kind });
    }
  }

  // Build the result segment by segment: gaps get the blanket rewrite in kiro mode
  let result = "";
  let lastEnd = 0;
  for (const m of matches) {
    const gap = body.slice(lastEnd, m.offset);
    result += mode === "kiro" ? kiroRewrite(gap) : gap;
    result += m.replacement;
    lastEnd = m.offset + m.length;
  }
  const tail = body.slice(lastEnd);
  result += mode === "kiro" ? kiroRewrite(tail) : tail;

  // Sort by offset and deduplicate by (ref, citing), keeping first occurrence (spec 15 §4.5)
  rewordedWithOffset.sort((a, b) => a.offset - b.offset);
  const seen = new Set<string>();
  for (const e of rewordedWithOffset) {
    const key = `${e.ref}|${e.citing}`;
    if (!seen.has(key)) {
      seen.add(key);
      report.reworded.push({ ref: e.ref, citing: e.citing, kind: e.kind });
    }
  }

  // Collect other .claude/ paths only in agents-md mode (spec 15 §4.5) — not in kiro mode (spec 17 §2)
  if (mode === "agents-md" && !hasCc) {
    const otherDirs = ["agents", "commands", "skills", "scripts", "hooks"];
    // The path class adds `/` for subdirectories; in `[.../-]` the `/` goes before `-` to avoid a range error.
    const otherPattern = new RegExp(
      `(^|[^/${RULE_NAME_CHARS}])\\.claude\\/(${otherDirs.join("|")})\\/([A-Za-z0-9._/-]+)`,
      "g",
    );
    let otherMatch;
    while ((otherMatch = otherPattern.exec(result)) !== null) {
      // Trim trailing `.` or `/` from the path, and skip if empty after trimming
      let path = otherMatch[3].replace(/[./]+$/, "");
      if (!path) continue;
      const fullPath = `.claude/${otherMatch[2]}/${path}`;
      // Deduplicate by (path, citing)
      if (!report.others.some((o) => o.path === fullPath && o.citing === citing)) {
        report.others.push({ path: fullPath, citing });
      }
    }
  }

  return { text: result, report };
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Text file that keeps the EOL and the BOM of the file it replaces (LF, no BOM when new). */
export async function textFile(ctx: EmitBase, relPath: string, text: string, target: PlannedFile["target"], ingredient: string): Promise<PlannedFile> {
  const existing = await ctx.readExisting(relPath);
  const eol: Eol = existing ? detectEol(existing.toString("utf8")) : "lf";
  const body = Buffer.from(withEol(text, eol), "utf8");
  const content = existing && hasBom(existing) ? Buffer.concat([UTF8_BOM, body]) : body;
  return { path: relPath, content, target, ingredient };
}

/** Output basename: a variant (`workflow--acme` with `as: workflow`) emits under the original name. */
export function outName(m: { name: string; as?: string }): string {
  return m.as ?? m.name;
}

/** The file a target writes for a rule: the path AGENTS.md lists when that target writes it (spec 14). */
export function ruleFile(target: "claude-code" | "kiro", m: { name: string; as?: string }): string {
  return target === "claude-code" ? `.claude/rules/${outName(m)}.md` : `.kiro/steering/${outName(m)}.md`;
}

/** The path to the example settings file generated by claude-code (spec 27 §4.2). */
export const EXAMPLE_SETTINGS = ".claude/settings.craftar.example.json";

/** A resolved MCP ingredient: the meta is narrowed to the mcp type. */
type McpResolved = ResolvedIngredient & { meta: Extract<Ingredient, { type: "mcp" }> };

/** Result of mcpSurvivors: survivors keyed by outName and collisions in walk order. */
interface McpSurvivorsResult {
  survivors: Map<string, McpResolved>;
  collisions: Array<{ key: string; prev: string; next: string }>;
}

/**
 * Determine the surviving MCP ingredient per server name. One pass over collected in walk order;
 * survivors is a Map keyed by outName, last value wins; collisions holds each (key, prev ref, next
 * ref) in the order they occur. A reassigned key stays in the slot where it was first set, so the
 * collision's surviving server can sit in the dropped one's slot — such a file does not adopt
 * (`sameJson` is key-order sensitive).
 */
function mcpSurvivors(collected: readonly ResolvedIngredient[]): McpSurvivorsResult {
  const survivors = new Map<string, McpResolved>();
  const collisions: Array<{ key: string; prev: string; next: string }> = [];
  for (const ing of collected) {
    if (ing.meta.type !== "mcp") continue;
    const key = outName(ing.meta);
    const prev = survivors.get(key);
    if (prev) collisions.push({ key, prev: prev.ref, next: ing.ref });
    survivors.set(key, ing as McpResolved);
  }
  return { survivors, collisions };
}

/**
 * The MCP servers of `collected` — the `mcp` ingredients the target's walk yielded, in walk order
 * (spec 18 §3.3). Keyed by `outName` so a variant keeps the server name its workspace uses. The
 * file holds one entry per name, so when two ingredients write the same name the earlier one is
 * dropped — said out loud, never silently.
 */
export function mcpServers(ctx: EmitBase, target: string, file: string, collected: readonly ResolvedIngredient[]): Record<string, unknown> {
  const { survivors, collisions } = mcpSurvivors(collected);
  for (const c of collisions) {
    ctx.warn(`${target}: two ingredients write the MCP server "${c.key}" into ${file}: ${c.prev} and ${c.next} (last wins)`);
  }
  const servers: Record<string, unknown> = Object.create(null);
  for (const [key, ing] of survivors) {
    servers[key] = ing.meta.server;
  }
  return servers;
}

/**
 * The declared authEnv names of the MCP ingredients' survivors (spec 27 §5.2).
 * De-duplicated, sorted by code unit. Pure; reads no environment.
 */
export function authEnvNames(collected: readonly ResolvedIngredient[]): string[] {
  const { survivors } = mcpSurvivors(collected);
  const names = new Set<string>();
  for (const ing of survivors.values()) {
    if (ing.meta.authEnv) for (const name of ing.meta.authEnv) names.add(name);
  }
  return [...names].sort();
}
