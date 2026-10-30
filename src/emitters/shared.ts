import { detectEol, hasBom, withEol, type Eol } from "../core/text.js";
import type { EmitBase, PlannedFile } from "./types.js";
import type { ResolvedIngredient } from "../core/resolve.js";
import { paramsFor } from "../core/resolve.js";
import type { Ingredient, Target } from "../schema/index.js";
import { rendersServers, renderServer, renderLeaves, credentialIn, credentialMessage, entropyMessage, undeclaredMessage, type RenderedLeaves } from "../core/mcp-server.js";
import { RULES_INDEX_LINE, RULES_INDEX_KEY, RULES_INDEX_TOKEN } from "../core/rules-index.js";
import type { Resolution } from "../core/resolve.js";

export function appliesTo(targets: "*" | string[], target: string): boolean {
  return targets === "*" || targets.includes(target);
}

/**
 * The MCP file each target writes (spec 42 §5.2: shared by the emitters and doctor's mcp-launcher).
 * agents-md writes no MCP file (its mcp cell is unsupported), so it has no entry.
 */
export const MCP_FILE = { "claude-code": ".mcp.json", kiro: ".kiro/settings/mcp.json" } as const satisfies Record<Exclude<Target, "agents-md">, string>;

/**
 * The targets an ingredient is aimed at in this workspace (spec 41 §4.3): its declared `targets`, except, under
 * agents-md.primary, an always-on rule with the default targets, which is aimed at agents-md alone. The one
 * answer to "is this rule AGENTS.md-only"; returns `meta.targets` itself when the mode is off.
 */
export function effectiveTargets(meta: Ingredient, resolution: { primary: boolean }): "*" | string[] {
  return agentsMdOnly(meta, resolution) ? ["agents-md"] : meta.targets;
}

/** Under agents-md.primary, an always-on rule with the default targets: written to AGENTS.md alone (spec 41 §4.2). */
export function agentsMdOnly(meta: Ingredient, resolution: { primary: boolean }): boolean {
  return resolution.primary && meta.type === "rule" && meta.inclusion === "always" && meta.targets === "*";
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

/**
 * Format the "dead references" part of a warning (spec 17 §4.5, spec 41 §4.4): references to rules
 * that exist but reach no target. Used by both kiro.ts and claude-code.ts emitters.
 */
export function formatDeadRefs(dead: Array<{ ref: string; citing: string; kind: string }>): string {
  const entries = dead.map((e) => `${e.ref} (in ${e.citing}; ${e.kind})`).join(", ");
  return `${dead.length} reference(s) to rule files this workspace does not have — reworded: ${entries}`;
}

/**
 * Format the "scanned files" part of a warning (spec 41 §4.4): references left as written in
 * files craftar copies. Used by both claude-code.ts and kiro.ts emitters.
 */
export function formatScannedRefs(hits: Array<{ path: string; line: number; name: string }>): string {
  const entries = hits.map((h) => `${h.path}:${h.line} (${h.name})`).join(", ");
  return `${hits.length} reference(s) left as written in files craftar copies: ${entries}`;
}

/** Lookup maps for rule reference resolution (spec 15 §4.2), built once per AGENTS.md. */
export interface RuleLookup {
  rulesByName: Map<string, ResolvedIngredient>;
  steeringsByName: Map<string, ResolvedIngredient>;
  /** Effective targets for each rule (spec 41 §4.3). */
  ruleTargets: Map<string, "*" | string[]>;
}

/** Build the lookup maps for rule reference resolution, once per AGENTS.md. */
export function buildRuleLookup(ingredients: ResolvedIngredient[], resolution: { primary: boolean } = { primary: false }): RuleLookup {
  const rulesByName = new Map<string, ResolvedIngredient>();
  const steeringsByName = new Map<string, ResolvedIngredient>();
  const ruleTargets = new Map<string, "*" | string[]>();
  for (const ing of ingredients) {
    const name = outName(ing.meta);
    if (ing.meta.type === "rule") {
      rulesByName.set(name, ing);
      ruleTargets.set(name, effectiveTargets(ing.meta, resolution));
    } else if (ing.meta.type === "steering") {
      steeringsByName.set(name, ing);
    }
  }
  return { rulesByName, steeringsByName, ruleTargets };
}

/** Rule reference state (spec 15 §4.2 for agents-md, spec 17 §4.2 for kiro). */
export type RuleRefState = "A" | "B" | "C" | "D" | "K1" | "K2" | "K3" | "unknown";

/**
 * Determine rule state for a single name (spec 15 §4.2 for agents-md, spec 17 §4.2 for kiro).
 * agents-md: A (claude-code writes), B (kiro writes), C (agents-md), D (rule exists), unknown
 * kiro:     K1 (kiro writes), K2 (claude-code writes), K3 (agents-md has it), D, unknown
 */
export function ruleRefState(
  name: string,
  lookup: RuleLookup,
  targets: readonly string[],
  mode: "agents-md" | "kiro",
): RuleRefState {
  const { rulesByName, steeringsByName, ruleTargets: effective } = lookup;
  const hasCc = targets.includes("claude-code");
  const hasKiro = targets.includes("kiro");
  const hasMd = targets.includes("agents-md");
  const rule = rulesByName.get(name);
  const ruleTargets = effective.get(name);
  if (mode === "kiro") {
    // K1: kiro writes it — a rule or steering that admits kiro (spec 17 §4.2)
    if (rule && ruleTargets && hasKiro && appliesTo(ruleTargets, "kiro")) return "K1";
    const steering = steeringsByName.get(name);
    if (steering && hasKiro && appliesTo(steering.meta.targets, "kiro")) return "K1";
    // K2: a rule and claude-code writes it
    if (rule && ruleTargets && hasCc && appliesTo(ruleTargets, "claude-code")) return "K2";
    // K3: a rule aimed at agents-md, and agents-md is a workspace target
    if (rule && ruleTargets && hasMd && appliesTo(ruleTargets, "agents-md")) return "K3";
    // D: any other rule
    if (rule) return "D";
    // unknown: anything else
    return "unknown";
  }
  // agents-md mode (spec 15 §4.2)
  if (rule && ruleTargets) {
    const writer = ruleWriter(targets, ruleTargets);
    if (writer === "claude-code") return "A";
    if (writer === "kiro") return "B";
  }
  // B (steering): kiro writes a steering with this name — checked before C/D (spec 15 §4.2)
  const steering = steeringsByName.get(name);
  if (steering && hasKiro && appliesTo(steering.meta.targets, "kiro")) return "B";
  if (rule && ruleTargets) {
    if (hasMd && appliesTo(ruleTargets, "agents-md")) return "C";
    return "D";
  }
  return "unknown";
}

/** The result of ruleReference (spec 44 §4.3). */
export interface RuleReferenceResult {
  state: RuleRefState;
  text: string;
  reworded?: { ref: string; kind: string };
}

/**
 * How a target names a rule: state (from ruleRefState), text (the replacement), and reworded (when
 * the reference is to a rule that exists but reaches no target here, or an unknown name) (spec 44 §4.3).
 * The resolveToken closure in resolveRuleRefs calls this; no second switch over the states anywhere.
 */
export function ruleReference(
  name: string,
  lookup: RuleLookup,
  targets: readonly string[],
  mode: "agents-md" | "kiro",
): RuleReferenceResult {
  const state = ruleRefState(name, lookup, targets, mode);
  const hasCc = targets.includes("claude-code");
  const rule = lookup.rulesByName.get(name);
  if (mode === "kiro") {
    switch (state) {
      case "K1": return { state, text: ruleFile("kiro", { name }) };
      case "K2": return { state, text: `.claude/rules/${name}.md` };  // unchanged
      case "K3": return { state, text: `AGENTS.md (rule: ${name})` };
      case "D": return { state, text: `${name} (rule not in this workspace)`, reworded: { ref: `.claude/rules/${name}.md`, kind: `${rule!.ref} reaches no target here` } };
      case "unknown": return { state, text: ruleFile("kiro", { name }), reworded: { ref: `.claude/rules/${name}.md`, kind: UNKNOWN_NAME_KIND } };
    }
  } else {
    switch (state) {
      case "A": return { state, text: `.claude/rules/${name}.md` };  // unchanged
      case "B": return { state, text: ruleFile("kiro", { name }) };
      case "C": return { state, text: `AGENTS.md (rule: ${name})` };
      case "D": return { state, text: `${name} (rule not in this workspace)`, reworded: { ref: `.claude/rules/${name}.md`, kind: `${rule!.ref} reaches no target here` } };
      case "unknown":
        if (hasCc) return { state, text: `.claude/rules/${name}.md` };  // unchanged
        return { state, text: `${name} (rule not in this workspace)`, reworded: { ref: `.claude/rules/${name}.md`, kind: "no such rule" } };
    }
  }
  return { state, text: `.claude/rules/${name}.md` };  // fallback
}

/**
 * References in a text the emitter copies without resolving (spec 41 §4.4): each `.claude/rules/<x>.md` token whose rule
 * this emitter's target does not write — in "agents-md" mode a state other than A or an unchanged unknown, in "kiro" mode a
 * state other than K1 — with its 1-based line. The text is never changed.
 */
export function unresolvedRuleRefs(
  text: string,
  lookup: RuleLookup,
  targets: readonly string[],
  mode: "agents-md" | "kiro",
): Array<{ line: number; name: string }> {
  const hasCc = targets.includes("claude-code");
  const result: Array<{ line: number; name: string }> = [];
  const tokenPattern = new RegExp(TOKEN_PATTERN_SOURCE, "g");
  let tokenMatch;
  while ((tokenMatch = tokenPattern.exec(text)) !== null) {
    const [match, before, _token, name] = tokenMatch as RegExpExecArray & [string, string, string, string];
    const fullOffset = tokenMatch.index + match.length;
    const after = text.slice(fullOffset);
    if (!rightBoundary(after)) continue;
    const state = ruleRefState(name, lookup, targets, mode);
    // In agents-md mode: listed when state is B, C, D, or unknown when claude-code is not a target
    // In kiro mode: listed when state is not K1
    const listed = mode === "agents-md"
      ? (state === "B" || state === "C" || state === "D" || (state === "unknown" && !hasCc))
      : (state !== "K1");
    if (listed) {
      // Find line number (1-based)
      const offset = tokenMatch.index + before.length;
      const line = text.slice(0, offset).split("\n").length;
      // Dedupe by (line, name)
      if (!result.some((r) => r.line === line && r.name === name)) {
        result.push({ line, name });
      }
    }
  }
  return result;
}

/**
 * Right boundary: not followed by letter, digit, `_`, `-`, or `.` followed by one of those (spec 15 §4.1).
 * NOTE: the right boundary's class is NOT RULE_NAME_CHARS (which includes `.` for names) — by design.
 */
function rightBoundary(after: string): boolean {
  if (!after) return true;
  const c = after[0];
  if (/[A-Za-z0-9_-]/.test(c)) return false;
  if (c === "." && after.length > 1 && /[A-Za-z0-9_-]/.test(after[1])) return false;
  return true;
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
  const { rulesByName } = lookup;

  // Local shorthand for state lookup
  const ruleState = (name: string): RuleRefState => ruleRefState(name, lookup, targets, mode);

  // Blanket rewrite for kiro mode: .claude/rules/ → .kiro/steering/
  const kiroRewrite = (s: string): string => s.replace(/\.claude\/rules\//g, ".kiro/steering/");

  // Resolve a single token reference (spec 20 §4.1): used for tokens and link text references.
  // Returns the replacement text and, if it rewords to "not in this workspace", the reworded entry.
  const resolveToken = (name: string): { text: string; reworded?: { ref: string; kind: string } } => ruleReference(name, lookup, targets, mode);

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
 * ref) in the order they occur — it is warned about by `mcpServers`. A reassigned key stays in the
 * slot where it was first set, so the collision's surviving server can sit in the dropped one's
 * slot — such a file does not adopt (`sameJson` is key-order sensitive), so a workspace file with
 * no lock entry reads as `collision`.
 */
function mcpSurvivors(collected: readonly ResolvedIngredient[]): McpSurvivorsResult {
  // A Map, so a server named `constructor` or `toString` is not mistaken for one already written.
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
 *
 * At schema 4, renders the server's declared params and checks the substituted values (spec 34 §4.2–§4.3).
 */
export function mcpServers(ctx: EmitBase, target: string, file: string, collected: readonly ResolvedIngredient[]): Record<string, unknown> {
  const { survivors, collisions } = mcpSurvivors(collected);
  for (const c of collisions) {
    ctx.warn(`${target}: two ingredients write the MCP server "${c.key}" into ${file}: ${c.prev} and ${c.next} (last wins)`);
  }
  // A null prototype, so a server named `__proto__` is an entry and not the object's prototype.
  const servers: Record<string, unknown> = Object.create(null);
  for (const [key, ing] of survivors) {
    // Below schema 4: emit as written
    if (!rendersServers(ctx.forge.manifest)) {
      servers[key] = ing.meta.server;
      continue;
    }
    // At schema 4: render the server's declared params
    const params = paramsFor(ing, ctx.resolution);
    const r = renderServer(ing.meta, params);
    // Missing: declared, cited, no value
    for (const k of r.missing) ctx.missing(k, ing.ref);
    // Undeclared but valued: left and warned once
    for (const k of r.undeclared) ctx.warnOnce(undeclaredMessage(ing.ref, k));
    // Credential check
    const check = credentialIn(r.substituted);
    if (check.error) throw new Error(credentialMessage(ing.ref, check.error));
    for (const w of check.warnings) ctx.warnOnce(entropyMessage(ing.ref, w));
    servers[key] = r.server;
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

/* ------------------------------------------------------------------ */
/* Hook registration (spec 43)                                         */
/* ------------------------------------------------------------------ */

/** A resolved hook ingredient: the meta is narrowed to the hook type. */
type HookResolved = ResolvedIngredient & { meta: Extract<Ingredient, { type: "hook" }> };

/** A handler in the hooks object. */
interface HookHandler {
  type: "command";
  command: string;
  args?: string[];
  timeout?: number;
  shell?: "bash" | "powershell";
}

/** A matcher group in the hooks object. */
interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}

/** The hooks object for the example file. */
export type HooksObject = Record<string, HookGroup[]>;

/** Pattern to find .claude/hooks/<x> references in command/args (spec 43 §5.6). */
const HOOK_PATH_PATTERN = /\.claude\/hooks\/([^\s"']+)/g;

/** A registration entry from the hook ingredient's registration array. */
type HookRegistrationEntry = NonNullable<Extract<Ingredient, { type: "hook" }>["registration"]>[number];

/** The result of renderRegistration: the rendered entry plus its render data. */
export interface RenderedRegistration {
  event: string;
  matcher: string | undefined;
  handler: HookHandler;
  rendered: RenderedLeaves;
}

/**
 * Render one registration entry: build the handler with keys in spec order (spec 43 §5.1).
 * Renders command, args, and matcher; event, timeout, and shell are not rendered.
 * The handler's keys are in order: type, command, args, timeout, shell.
 */
export function renderRegistration(
  entry: HookRegistrationEntry,
  declared: Record<string, unknown>,
  params: Record<string, unknown>,
  ref: string,
): RenderedRegistration {
  // Render the entry using renderLeaves (spec 43 §4.3)
  const toRender: Record<string, unknown> = {};
  if (entry.command) toRender.command = entry.command;
  if (entry.args) toRender.args = entry.args;
  if (entry.matcher) toRender.matcher = entry.matcher;

  const rendered = renderLeaves(toRender, declared, params, ref);
  const renderedValue = rendered.value as typeof toRender;
  const renderedCommand = (renderedValue.command ?? entry.command) as string;
  const renderedArgs = renderedValue.args as string[] | undefined;
  const renderedMatcher = renderedValue.matcher as string | undefined;

  // Build the handler with keys in order: type, command, args, timeout, shell (spec 43 §5.1)
  const handler: HookHandler = Object.create(null);
  handler.type = "command";
  handler.command = renderedCommand;
  if (renderedArgs !== undefined) handler.args = renderedArgs;
  if (entry.timeout !== undefined) handler.timeout = entry.timeout;
  if (entry.shell !== undefined) handler.shell = entry.shell;

  return { event: entry.event, matcher: renderedMatcher, handler, rendered };
}

/**
 * Build the hooks registration object for the example file (spec 43 §5.1).
 * Renders each entry's declared params and checks the substituted values.
 * Returns null if no hook declares a registration.
 */
export function hookRegistrations(
  ctx: EmitBase,
  hooks: readonly ResolvedIngredient[],
): HooksObject | null {
  // Filter to hooks with registration
  const withReg = hooks.filter(
    (ing): ing is HookResolved => ing.meta.type === "hook" && ing.meta.registration !== undefined
  );

  if (withReg.length === 0) return null;

  // A null prototype map so __proto__ is a key, not the prototype
  const result: HooksObject = Object.create(null);

  for (const ing of withReg) {
    const meta = ing.meta;
    const declared = meta.params ?? {};
    const params = paramsFor(ing, ctx.resolution);
    const files = new Set(meta.files);

    for (let i = 0; i < meta.registration!.length; i++) {
      const entry = meta.registration![i];

      // Render the entry using the shared builder (spec 43 §7.2)
      const { event, matcher, handler, rendered } = renderRegistration(entry, declared, params, ing.ref);

      // Handle the four cases (spec 43 §4.3)
      for (const k of rendered.missing) ctx.missing(k, ing.ref);
      for (const k of rendered.undeclared) ctx.warnOnce(undeclaredMessage(ing.ref, k, "registration"));

      // Credential check (spec 43 §4.3)
      const check = credentialIn(rendered.substituted);
      if (check.error) {
        throw new Error(
          credentialMessage(ing.ref, check.error, {
            prefix: `registration[${i}].`,
            remedy: "have the hook read it from the environment",
          })
        );
      }
      for (const w of check.warnings) {
        ctx.warnOnce(
          entropyMessage(ing.ref, w, {
            prefix: `registration[${i}].`,
            remedy: "have the hook read it from the environment",
          })
        );
      }

      // Check for uncovered .claude/hooks/<x> paths (spec 43 §5.6)
      const checkPath = (value: string) => {
        HOOK_PATH_PATTERN.lastIndex = 0;
        let match;
        while ((match = HOOK_PATH_PATTERN.exec(value)) !== null) {
          const cited = match[1];
          if (!files.has(cited)) {
            ctx.warnOnce(
              `${ing.ref}: registration cites .claude/hooks/${cited}, which this ingredient does not write`
            );
          }
        }
      };
      checkPath(handler.command);
      if (handler.args) {
        for (const arg of handler.args) checkPath(arg);
      }

      // Build the group with keys in order: matcher (optional), hooks
      const group: HookGroup = Object.create(null);
      if (matcher !== undefined) group.matcher = matcher;
      group.hooks = [handler];

      // Add to the event's list (create if first)
      if (!result[event]) {
        result[event] = [];
      }
      result[event].push(group);
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Build the settings example object (spec 43 §5.1).
 * Keys in order: env (when non-empty), hooks (when non-null).
 */
export function settingsExample(
  env: Record<string, string> | null,
  hooks: HooksObject | null,
): Record<string, unknown> | null {
  const hasEnv = env !== null && Object.keys(env).length > 0;
  const hasHooks = hooks !== null && Object.keys(hooks).length > 0;

  if (!hasEnv && !hasHooks) return null;

  // Build with key order: env, hooks (spec 43 §5.1)
  const result: Record<string, unknown> = {};
  if (hasEnv) result.env = env;
  if (hasHooks) result.hooks = hooks;

  return result;
}


/* ------------------------------------------------------------------ */
/* Rules index expansion (spec 44 §4.3–§4.5)                           */
/* ------------------------------------------------------------------ */

/** The result of expandRulesIndex. */
export interface ExpandRulesIndexResult {
  /** The text with the placeholder expanded, or unchanged if no placeholder was found. */
  text: string;
  /** The number of rules listed in the expanded index. */
  listed: number;
  /** Names of rules listed without a description. */
  undescribed: string[];
  /** True when at least one placeholder line was expanded (spec 44 finding 2). */
  expanded: boolean;
}

/**
 * A description holding `<!-- craftar:` is a section marker and must not appear in the index
 * (spec 44 §4.4). Throws with a message naming the rule.
 */
// Differs from `markerLine` (spec §4.4 refuses `<!-- craftar:` anywhere in a description, not only at column 0).
const MARKER_IN_DESCRIPTION = /<!--[ \t]*\/?[ \t]*craftar:/;

/**
 * Fold a description for display: collapse runs of whitespace to single space, trim ends (spec 44 §4.4).
 */
function foldDescription(desc: string): string {
  return desc.replace(/\s+/g, " ").trim();
}

/**
 * Expand `{{craftar.rules.index}}` placeholders in a text, building an index of the profile's rules
 * for the given target (spec 44 §4.3–§4.5).
 *
 * @param text The text that may contain the placeholder.
 * @param target Which target's index to build: "claude-code", "kiro", or "agents-md".
 * @param lookup The rule lookup for reference resolution.
 * @param resolution The resolution with all ingredients and targets.
 * @returns The result with expanded text, list count, undescribed names, and misplaced line numbers.
 */
export function expandRulesIndex(
  text: string,
  target: "claude-code" | "kiro" | "agents-md",
  lookup: RuleLookup,
  resolution: Resolution,
): ExpandRulesIndexResult {
  // Scan first — when no line matches RULES_INDEX_LINE and none matches RULES_INDEX_TOKEN,
  // return unchanged without building anything; build the list only when a line will be expanded.
  const lines = text.split("\n");
  const hasAloneLine = lines.some((line) => RULES_INDEX_LINE.test(line));
  const hasMisplacedToken = !hasAloneLine && lines.some((line) => RULES_INDEX_TOKEN.test(line));

  // If no placeholder at all, return unchanged
  if (!hasAloneLine && !hasMisplacedToken) {
    return { text, listed: 0, undescribed: [], expanded: false };
  }

  // If only misplaced tokens (no alone lines), return unchanged text
  // (a misplaced placeholder is found by plan() in the planned files, not here)
  if (!hasAloneLine) {
    return { text, listed: 0, undescribed: [], expanded: false };
  }

  // We have at least one line to expand — now build the index
  const undescribed: string[] = [];

  // Build the index content once (it's the same for all occurrences)
  const rules = resolution.ingredients.filter((ing) => ing.meta.type === "rule");
  const mode = target === "kiro" ? "kiro" : "agents-md";

  // Group rules by inclusion for display order
  const alwaysOn: Array<{ name: string; path: string; desc: string | null }> = [];
  const scoped: Array<{ name: string; path: string; scope: string | null; desc: string | null }> = [];
  const onRequest: Array<{ name: string; path: string; desc: string | null }> = [];

  for (const ing of rules) {
    if (ing.meta.type !== "rule") continue;
    const meta = ing.meta;
    const name = outName(meta);

    // Get the reference for this rule in the current target's index (spec 44 §4.3)
    const ref = ruleReference(name, lookup, resolution.targets, mode);
    const state = ref.state;

    // State D (and unknown): rule exists but reaches no target here — ABSENT from every index (no warning)
    if (state === "D" || state === "unknown") continue;

    // Build the path string: wrap in backticks for A, B, K1, K2 (file paths); as-is for C, K3 (AGENTS.md refs)
    const isPathState = state === "A" || state === "B" || state === "K1" || state === "K2";
    const path = isPathState ? `\`${ref.text}\`` : ref.text;

    // Check description validity
    const rawDesc = meta.description;
    let desc: string | null = null;
    if (rawDesc !== undefined && rawDesc.trim() !== "") {
      if (MARKER_IN_DESCRIPTION.test(rawDesc)) {
        throw new Error(
          `${RULES_INDEX_KEY}: description of rule/${meta.name} contains a section marker — remove it`
        );
      }
      desc = foldDescription(rawDesc);
    } else {
      undescribed.push(name);
    }

    // Categorize by inclusion
    const inclusion = meta.inclusion;
    if (inclusion === "always") {
      alwaysOn.push({ name, path, desc });
    } else if (inclusion === "fileMatch") {
      // A fileMatch rule with no pattern adds nothing (spec 44 §4.4)
      const pattern = meta.fileMatchPattern;
      const scope = pattern
        ? `applies to \`${Array.isArray(pattern) ? pattern.join("`, `") : pattern}\``
        : null;
      scoped.push({ name, path, scope, desc });
    } else {
      // manual or auto
      onRequest.push({ name, path, desc });
    }
  }

  // Sort each group by name in code-point order
  const sortByName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  alwaysOn.sort(sortByName);
  scoped.sort(sortByName);
  onRequest.sort(sortByName);

  // Build the index lines (spec 44 §4.4): each group only when it holds a rule
  const indexLines: string[] = [];

  // When the index lists no rule at all, the whole index is `- (no rules)` (no group heading)
  if (alwaysOn.length === 0 && scoped.length === 0 && onRequest.length === 0) {
    indexLines.push("- (no rules)");
  } else {
    if (alwaysOn.length > 0) {
      if (indexLines.length > 0) indexLines.push("");
      indexLines.push("Always on:");
      for (const r of alwaysOn) {
        indexLines.push(r.desc ? `- ${r.path} — ${r.desc}` : `- ${r.path}`);
      }
    }

    if (scoped.length > 0) {
      if (indexLines.length > 0) indexLines.push("");
      indexLines.push("Scoped:");
      for (const r of scoped) {
        const descPart = r.desc ? ` — ${r.desc}` : "";
        const scopePart = r.scope ? ` (${r.scope})` : "";
        indexLines.push(`- ${r.path}${descPart}${scopePart}`);
      }
    }

    if (onRequest.length > 0) {
      if (indexLines.length > 0) indexLines.push("");
      indexLines.push("On request:");
      for (const r of onRequest) {
        indexLines.push(r.desc ? `- ${r.path} — ${r.desc}` : `- ${r.path}`);
      }
    }
  }

  const indexContent = indexLines.join("\n");
  const listed = alwaysOn.length + scoped.length + onRequest.length;

  // Find and replace all placeholders
  const resultLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Check if this line has the placeholder alone (using RULES_INDEX_LINE)
    if (RULES_INDEX_LINE.test(line)) {
      // Replace with the index content
      resultLines.push(indexContent);
    } else {
      // Keep the line as-is (including any misplaced tokens — detected by plan() later)
      resultLines.push(line);
    }
  }

  return {
    text: resultLines.join("\n"),
    listed,
    undescribed,
    expanded: true,  // We got here only if hasAloneLine was true
  };
}


/* ------------------------------------------------------------------ */
/* Flat skill detection (spec 44 §5)                                   */
/* ------------------------------------------------------------------ */

/**
 * The outNames of skills this resolution writes as a single file to claude-code, sorted by code point.
 * A skill is "flat" when (1) its layout is "file", and (2) effectiveTargets admits "claude-code".
 * Claude Code does not list such skills.
 */
export function flatSkills(
  resolution: { ingredients: readonly { meta: { type: string; name: string; as?: string; layout?: string; targets: "*" | string[] } }[]; primary: boolean },
  targets: readonly string[],
): string[] {
  if (!targets.includes("claude-code")) return [];

  const names: string[] = [];
  for (const ing of resolution.ingredients) {
    const meta = ing.meta;
    if (meta.type !== "skill") continue;
    if (meta.layout !== "file") continue;
    // Check effectiveTargets admits "claude-code"
    const eff = effectiveTargets(meta as Parameters<typeof effectiveTargets>[0], resolution);
    if (!appliesTo(eff, "claude-code")) continue;
    names.push(outName(meta));
  }
  return names.sort();
}

/**
 * Build the warning message for flat skills (spec 44 §5):
 * "{prefix}: Claude Code does not list a skill written as one file — {paths}; set layout: dir in each ingredient.yaml"
 */
export function flatSkillWarning(names: string[], prefix = "claude-code"): string {
  const paths = names.map((n) => `.claude/skills/${n}.md`).join(", ");
  return `${prefix}: Claude Code does not list a skill written as one file — ${paths}; set layout: dir in each ingredient.yaml`;
}
