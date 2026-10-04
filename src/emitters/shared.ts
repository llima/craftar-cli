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

/**
 * Resolve `.claude/rules/<x>.md` references in a body emitted into AGENTS.md (spec 15 §4.1–§4.3).
 * Returns the transformed text and a report of what was reworded or found dead.
 */
export function resolveRuleRefs(
  body: string,
  citing: string,
  ingredients: ResolvedIngredient[],
  targets: readonly string[],
): { text: string; report: RefReport } {
  const report: RefReport = { reworded: [], others: [] };
  const hasCc = targets.includes("claude-code");
  const hasKiro = targets.includes("kiro");

  // Build a lookup map by output name
  const byOutName = new Map<string, ResolvedIngredient>();
  for (const ing of ingredients) {
    byOutName.set(outName(ing.meta), ing);
  }

  // Determine rule state: A, B, C, D, or unknown (spec 15 §4.2)
  const ruleState = (name: string): "A" | "B" | "C" | "D" | "unknown" => {
    const ing = byOutName.get(name);
    if (!ing) return "unknown";
    const type = ing.meta.type;
    // A: claude-code writes it
    if (type === "rule" && hasCc && appliesTo(ing.meta.targets, "claude-code")) return "A";
    // B: kiro writes it (rule or steering)
    if ((type === "rule" || type === "steering") && hasKiro && appliesTo(ing.meta.targets, "kiro")) return "B";
    // C: aimed at agents-md (text is in AGENTS.md)
    if (type === "rule" && appliesTo(ing.meta.targets, "agents-md")) return "C";
    // D: rule exists but not written by any target here
    if (type === "rule") return "D";
    // Not a rule or steering: unknown
    return "unknown";
  };

  // Helper to get the ingredient ref for reporting
  const ingRef = (name: string): string | undefined => byOutName.get(name)?.ref;

  // Right boundary: not followed by letter, digit, `_`, `-`, or `.` followed by one of those (spec 15 §4.1)
  const rightBoundary = (after: string): boolean => {
    if (!after) return true;
    const c = after[0];
    if (/[A-Za-z0-9_-]/.test(c)) return false;
    if (c === "." && after.length > 1 && /[A-Za-z0-9_-]/.test(after[1])) return false;
    return true;
  };

  // Left boundary: not preceded by `/` or a name character (spec 15 §4.1)
  const leftBoundary = (before: string): boolean => {
    if (!before) return true;
    const c = before[before.length - 1];
    return c !== "/" && !/[A-Za-z0-9._-]/.test(c);
  };

  // Process links first: [text](.claude/rules/<x>.md) or [text](.claude/rules/<x>.md#frag)
  // Pattern: `[<text>](.claude/rules/<name>.md)` or `[<text>](.claude/rules/<name>.md#<frag>)`
  const linkPattern = new RegExp(
    `\\[([^\\]]+)\\]\\(\\.claude\\/rules\\/([${RULE_NAME_CHARS}]+)\\.md(#[^)]*)?\\)`,
    "g",
  );

  let result = body.replace(linkPattern, (match, text: string, name: string, frag: string | undefined) => {
    // A link already bounds the path with `(` and `)` or `#`, so no boundary checks needed (spec 15 §4.1).
    const state = ruleState(name);
    switch (state) {
      case "A":
        return match; // unchanged
      case "B":
        return `[${text}](.kiro/steering/${name}.md${frag ?? ""})`;
      case "C":
        return `[${text}](AGENTS.md)`; // fragment dropped
      case "D": {
        report.reworded.push({ ref: `.claude/rules/${name}.md`, citing, kind: `rule/${ingRef(name)!.split("/")[1]} reaches no target here` });
        return `${text} (${name}, rule not in this workspace)`;
      }
      case "unknown":
        if (hasCc) return match;
        report.reworded.push({ ref: `.claude/rules/${name}.md`, citing, kind: "no such rule" });
        return `${text} (${name}, rule not in this workspace)`;
    }
  });

  // Process token references: .claude/rules/<x>.md (not in a link)
  // We need to be careful not to match references we already processed as links
  // The pattern matches .claude/rules/<name>.md with boundaries
  const tokenPattern = new RegExp(
    `(^|[^/A-Za-z0-9._-])(\\.claude\\/rules\\/([${RULE_NAME_CHARS}]+)\\.md)`,
    "g",
  );

  result = result.replace(tokenPattern, (match, before: string, ref: string, name: string, offset: number) => {
    // `before` is the captured boundary character (or empty at start)
    // Check right boundary
    const fullOffset = offset + match.length;
    const after = result.slice(fullOffset);
    if (!rightBoundary(after)) return match;

    const state = ruleState(name);
    switch (state) {
      case "A":
        return match; // unchanged
      case "B":
        return `${before}.kiro/steering/${name}.md`;
      case "C":
        return `${before}AGENTS.md (rule: ${name})`;
      case "D": {
        report.reworded.push({ ref: `.claude/rules/${name}.md`, citing, kind: `rule/${ingRef(name)!.split("/")[1]} reaches no target here` });
        return `${before}${name} (rule not in this workspace)`;
      }
      case "unknown":
        if (hasCc) return match;
        report.reworded.push({ ref: `.claude/rules/${name}.md`, citing, kind: "no such rule" });
        return `${before}${name} (rule not in this workspace)`;
    }
  });

  // Collect other .claude/ paths (agents, commands, skills, scripts, hooks) only when no claude-code (spec 15 §4.5)
  if (!hasCc) {
    const otherDirs = ["agents", "commands", "skills", "scripts", "hooks"];
    // Note: RULE_NAME_CHARS is `A-Za-z0-9._-`, so we add `/` before the `-` to avoid a bad range
    const otherPattern = new RegExp(
      `(^|[^/A-Za-z0-9._-])\\.claude\\/(${otherDirs.join("|")})\\/([A-Za-z0-9._/-]+)`,
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
