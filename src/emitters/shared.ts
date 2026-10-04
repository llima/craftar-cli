import { detectEol, hasBom, withEol, type Eol } from "../core/text.js";
import type { EmitContext, PlannedFile } from "./types.js";
import type { ResolvedIngredient } from "../core/resolve.js";

export function appliesTo(targets: "*" | string[], target: string): boolean {
  return targets === "*" || targets.includes(target);
}

/** The characters of a rule name in a `.claude/rules/<name>.md` reference (spec 15 §4.1). */
export const RULE_NAME_CHARS = "A-Za-z0-9._-";

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
 * Resolve `.claude/rules/<x>.md` references in a body (spec 15 §4.1–§4.3, spec 17 §4.2–§4.3).
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
    // B (steering): kiro writes a steering with this name
    const steering = steeringsByName.get(name);
    if (steering && hasKiro && appliesTo(steering.meta.targets, "kiro")) return "B";
    if (rule) {
      if (appliesTo(rule.meta.targets, "agents-md")) return "C";
      return "D";
    }
    return "unknown";
  };

  // Right boundary: not followed by letter, digit, `_`, `-`, or `.` followed by one of those (spec 15 §4.1)
  const rightBoundary = (after: string): boolean => {
    if (!after) return true;
    const c = after[0];
    if (/[A-Za-z0-9_-]/.test(c)) return false;
    if (c === "." && after.length > 1 && /[A-Za-z0-9_-]/.test(after[1])) return false;
    return true;
  };

  // Blanket rewrite for kiro mode: .claude/rules/ → .kiro/steering/
  const kiroRewrite = (s: string): string => s.replace(/\.claude\/rules\//g, ".kiro/steering/");

  interface Match {
    offset: number;
    length: number;
    replacement: string;
    reworded?: { ref: string; kind: string };
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
    const state = ruleState(name);
    const rule = rulesByName.get(name);
    let replacement: string;
    let reworded: { ref: string; kind: string } | undefined;

    if (mode === "kiro") {
      // Kiro mode (spec 17 §4.3)
      switch (state) {
        case "K1":
          replacement = `[${kiroRewrite(text)}](${ruleFile("kiro", { name })}${frag ?? ""})`;
          break;
        case "K2":
          // unchanged — exempt from directory rewrite; keep original text exactly
          replacement = match;
          break;
        case "K3":
          replacement = `[${kiroRewrite(text)}](AGENTS.md)`; // fragment dropped
          break;
        case "D":
          reworded = { ref: `.claude/rules/${name}.md`, kind: `${rule!.ref} reaches no target here` };
          replacement = `${kiroRewrite(text)} (${name}, rule not in this workspace)`;
          break;
        case "unknown":
          // Unknown name gets blanket rewrite and is reported (no kind string)
          reworded = { ref: `.claude/rules/${name}.md`, kind: "" };
          replacement = `[${kiroRewrite(text)}](${ruleFile("kiro", { name })}${frag ?? ""})`;
          break;
        default:
          continue;
      }
    } else {
      // agents-md mode (spec 15 §4.3)
      switch (state) {
        case "A":
          continue;
        case "B":
          replacement = `[${text}](${ruleFile("kiro", { name })}${frag ?? ""})`;
          break;
        case "C":
          replacement = `[${text}](AGENTS.md)`;
          break;
        case "D":
          reworded = { ref: `.claude/rules/${name}.md`, kind: `${rule!.ref} reaches no target here` };
          replacement = `${text} (${name}, rule not in this workspace)`;
          break;
        case "unknown":
          if (hasCc) continue;
          reworded = { ref: `.claude/rules/${name}.md`, kind: "no such rule" };
          replacement = `${text} (${name}, rule not in this workspace)`;
          break;
        default:
          continue;
      }
    }
    matches.push({ offset, length: match.length, replacement, reworded });
  }

  // Token pattern: .claude/rules/<name>.md (not in a link) with left boundary
  const tokenPattern = new RegExp(
    `(^|[^/${RULE_NAME_CHARS}])(\\.claude\\/rules\\/([${RULE_NAME_CHARS}]+)\\.md)`,
    "g",
  );
  let tokenMatch;
  while ((tokenMatch = tokenPattern.exec(body)) !== null) {
    const [match, before, token, name] = tokenMatch as RegExpExecArray & [string, string, string, string];
    const offset = tokenMatch.index + before.length;
    const fullOffset = tokenMatch.index + match.length;
    const after = body.slice(fullOffset);
    if (!rightBoundary(after)) continue;
    if (matches.some((m) => offset >= m.offset && offset < m.offset + m.length)) continue;
    const state = ruleState(name);
    const rule = rulesByName.get(name);
    let replacement: string;
    let reworded: { ref: string; kind: string } | undefined;

    if (mode === "kiro") {
      // Kiro mode (spec 17 §4.3)
      switch (state) {
        case "K1":
          replacement = ruleFile("kiro", { name });
          break;
        case "K2":
          // unchanged — exempt from directory rewrite; keep original text exactly
          replacement = token;
          break;
        case "K3":
          replacement = `AGENTS.md (rule: ${name})`;
          break;
        case "D":
          reworded = { ref: `.claude/rules/${name}.md`, kind: `${rule!.ref} reaches no target here` };
          replacement = `${name} (rule not in this workspace)`;
          break;
        case "unknown":
          // Unknown name gets blanket rewrite and is reported (no kind string)
          reworded = { ref: `.claude/rules/${name}.md`, kind: "" };
          replacement = ruleFile("kiro", { name });
          break;
        default:
          continue;
      }
    } else {
      // agents-md mode (spec 15 §4.3)
      switch (state) {
        case "A":
          continue;
        case "B":
          replacement = ruleFile("kiro", { name });
          break;
        case "C":
          replacement = `AGENTS.md (rule: ${name})`;
          break;
        case "D":
          reworded = { ref: `.claude/rules/${name}.md`, kind: `${rule!.ref} reaches no target here` };
          replacement = `${name} (rule not in this workspace)`;
          break;
        case "unknown":
          if (hasCc) continue;
          reworded = { ref: `.claude/rules/${name}.md`, kind: "no such rule" };
          replacement = `${name} (rule not in this workspace)`;
          break;
        default:
          continue;
      }
    }
    matches.push({ offset, length: token.length, replacement, reworded });
  }

  matches.sort((a, b) => a.offset - b.offset);

  const rewordedWithOffset: Array<{ offset: number; ref: string; citing: string; kind: string }> = [];
  for (const m of matches) {
    if (m.reworded) {
      rewordedWithOffset.push({ offset: m.offset, ref: m.reworded.ref, citing, kind: m.reworded.kind });
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
    const otherPattern = new RegExp(
      `(^|[^/${RULE_NAME_CHARS}])\\.claude\\/(${otherDirs.join("|")})\\/([A-Za-z0-9._/-]+)`,
      "g",
    );
    let otherMatch;
    while ((otherMatch = otherPattern.exec(result)) !== null) {
      let path = otherMatch[3].replace(/[./]+$/, "");
      if (!path) continue;
      const fullPath = `.claude/${otherMatch[2]}/${path}`;
      if (!report.others.some((o) => o.path === fullPath && o.citing === citing)) {
        report.others.push({ path: fullPath, citing });
      }
    }
  }

  return { text: result, report };
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Text file that keeps the EOL and the BOM of the file it replaces (LF, no BOM when new). */
export async function textFile(ctx: EmitContext, relPath: string, text: string, target: PlannedFile["target"], ingredient: string): Promise<PlannedFile> {
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

/**
 * The MCP servers a target writes into its one JSON file, keyed by `outName` so a variant keeps the
 * server name its workspace uses. The file holds one entry per name, so when two ingredients write
 * the same name the earlier one is dropped — said out loud, never silently.
 */
export function mcpServers(ctx: EmitContext, target: string, file: string): Record<string, unknown> {
  // A null prototype, so a server named `__proto__` is an entry and not the object's prototype.
  const servers: Record<string, unknown> = Object.create(null);
  // A Map, so a server named `constructor` or `toString` is not mistaken for one already written.
  const writtenBy = new Map<string, string>();
  for (const ing of ctx.resolution.ingredients) {
    if (ing.meta.type !== "mcp" || !appliesTo(ing.meta.targets, target)) continue;
    const key = outName(ing.meta);
    const prev = writtenBy.get(key);
    if (prev) ctx.warn(`${target}: two ingredients write the MCP server "${key}" into ${file}: ${prev} and ${ing.ref} (last wins)`);
    // Last wins on the value, but a reassigned key keeps the slot where it was first written, so
    // after a collision the surviving server can sit in the dropped one's position. It is warned
    // about above. Such a file does not adopt: `sameJson` is key-order sensitive, so a workspace
    // file with no lock entry reads as `collision`.
    servers[key] = ing.meta.server;
    writtenBy.set(key, ing.ref);
  }
  return servers;
}
