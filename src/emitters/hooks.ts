import type { ResolvedIngredient } from "../core/resolve.js";
import { appliesTo, effectiveTargets, hookRegistrations, outName, type HooksObject } from "./shared.js";
import type { EmitBase } from "./types.js";

/**
 * Hooks for the new targets (spec 61 slice 3, H1 ruled 2026-11-07): a `hook` ingredient's `registration` — written in Claude Code's
 * terms (its event names, its tool names in `matcher`, `command` / `args` / `timeout` / `shell`) — is rendered once, through
 * `hookRegistrations` (so params, the credential check and the uncovered-path warning are the ones `claude-code` applies), then
 * reshaped per target here. What a target cannot express is skipped with a warning, never dropped silently. The hook's files stay
 * `claude-code`'s (`.claude/hooks/`); no new target copies them.
 */

/** Codex's events (spec 61 slice 3, measured 2026-11-07): the same names as Claude Code's, where Codex has them. */
const CODEX_EVENTS = new Set([
  "SessionStart",
  "SessionEnd",
  "SubagentStart",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "UserPromptSubmit",
  "SubagentStop",
  "Stop",
]);

/** The rendered entries of one hook ingredient, event by event, through the one render (`hookRegistrations`). */
function rendered(ctx: EmitBase, ing: ResolvedIngredient): HooksObject | null {
  return hookRegistrations(ctx, [ing]);
}

/**
 * The notes every new target that writes hooks shares (spec 61 slice 3): a hook with no registration writes nothing for it; a hook's
 * files are written by the `claude-code` target only, so when `claude-code` will not write them — not among the workspace's targets,
 * or the hook not aimed at it (`effectiveTargets`, the carrier test) — the files reach nothing and that is said; and
 * `${CLAUDE_PROJECT_DIR}` is set by Claude Code (and Cursor), not documented for Codex or Antigravity.
 */
function sharedNotes(ctx: EmitBase, target: string, label: string, ing: ResolvedIngredient, obj: HooksObject | null): void {
  const claudeWrites = ctx.resolution.targets.includes("claude-code") && appliesTo(effectiveTargets(ing.meta, ctx.resolution), "claude-code");
  if (!claudeWrites)
    ctx.warn(`${target}: hook ${ing.ref}: its files are written by the claude-code target only, which does not write them here (not among the targets, or the hook is not aimed at it)`);
  if (obj === null) {
    ctx.warn(`${target}: hook ${ing.ref} has no registration, so nothing is written for it`);
    return;
  }
  const texts = Object.values(obj).flatMap((groups) => groups.flatMap((g) => g.hooks.flatMap((h) => [h.command, ...(h.args ?? [])])));
  if (texts.some((x) => x.includes("CLAUDE_PROJECT_DIR")))
    ctx.warn(`${target}: hook ${ing.ref}: its registration names CLAUDE_PROJECT_DIR, which ${label} is not documented to set`);
}

/**
 * The `.codex/hooks.json` document (Claude Code's shape: event → `{ matcher?, hooks: [{ type, command, timeout? }] }`), or null
 * when nothing is written. Matchers and event names are kept: Codex uses Claude Code's names and matches `Edit` / `Write` to its
 * `apply_patch`. An event Codex does not have, or an entry with `args` (Codex runs a command string, with no argv form), is skipped
 * and warned; a `shell` is dropped and warned.
 */
export function codexHooks(ctx: EmitBase, hooks: readonly ResolvedIngredient[]): { hooks: HooksObject } | null {
  const out: HooksObject = Object.create(null);
  for (const ing of hooks) {
    const obj = rendered(ctx, ing);
    sharedNotes(ctx, "codex", "Codex", ing, obj);
    if (obj === null) continue;
    for (const [event, groups] of Object.entries(obj)) {
      if (!CODEX_EVENTS.has(event)) {
        ctx.warn(`codex: hook ${ing.ref}: event ${event} has no Codex equivalent; skipped`);
        continue;
      }
      for (const g of groups) {
        const handlers = [];
        for (const h of g.hooks) {
          if (h.args !== undefined) {
            ctx.warn(`codex: hook ${ing.ref}: an ${event} entry uses args, and Codex runs a command string with no argv form; skipped`);
            continue;
          }
          if (h.shell !== undefined) ctx.warn(`codex: hook ${ing.ref}: shell has no Codex key; dropped`);
          const handler: Record<string, unknown> = { type: "command", command: h.command };
          if (h.timeout !== undefined) handler.timeout = h.timeout;
          handlers.push(handler);
        }
        if (!handlers.length) continue;
        const group: Record<string, unknown> = {};
        if (g.matcher !== undefined) group.matcher = g.matcher;
        group.hooks = handlers;
        // `group` is Codex's group shape ({ matcher?, hooks: [{ type, command, timeout? }] }), narrower than HookGroup's handler (no
        // args / shell): the cast only lets it sit in the same per-event map that is serialized as JSON.
        (out[event] ??= []).push(group as never);
      }
    }
  }
  return Object.keys(out).length ? { hooks: out } : null;
}

/** Antigravity's events (measured 2026-11-07): Claude Code's names where they are the same; the tool events take a matcher. */
const ANTIGRAVITY_TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);
const ANTIGRAVITY_OTHER_EVENTS = new Set(["SessionStart", "Stop"]);

/**
 * Claude Code's tool names → Antigravity's (its tool reference, measured 2026-11-07; the pairing is INFERRED from each tool's
 * description, not published by Google — said in the cell note). A matcher that is not a plain list of these names — a regex, an MCP
 * tool, an unknown name, a name with spaces around it — has no translation, and its entry is skipped with a warning. Antigravity's
 * matcher is a regex (measured), so the translated names are joined with `|`; it sits on a group wrapping `hooks` (measured verbatim).
 */
export const ANTIGRAVITY_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Bash: ["run_command"],
  Read: ["view_file"],
  Write: ["write_to_file"],
  Edit: ["replace_file_content", "multi_replace_file_content"],
  MultiEdit: ["multi_replace_file_content"],
  Glob: ["find_by_name"],
  Grep: ["grep_search"],
  LS: ["list_dir"],
  WebSearch: ["search_web"],
  WebFetch: ["read_url_content"],
  Task: ["invoke_subagent"],
};

/** A Claude Code matcher in Antigravity's names, `*` for none or a match-all, or null when it cannot be translated. */
export function antigravityMatcher(matcher: string | undefined): string | null {
  if (matcher === undefined || matcher === "" || matcher === "*") return "*";
  // Claude Code reads an exact name or a list of names separated by `|` or `,` (measured); anything else, spaces included, is a regex.
  const names = matcher.split(/[|,]/);
  if (names.some((n) => !Object.hasOwn(ANTIGRAVITY_TOOLS, n))) return null;
  return [...new Set(names.flatMap((n) => ANTIGRAVITY_TOOLS[n]))].join("|");
}

/**
 * The `.agents/hooks.json` document — one named hook per ingredient (its output name), each event an array: for PreToolUse and
 * PostToolUse a group `{ matcher, hooks: [{ type, command, timeout? }] }`, the matcher translated (`antigravityMatcher`); for
 * SessionStart and Stop the handlers directly, a matcher there dropped with a warning (Antigravity ignores it). An event Antigravity
 * does not have, an untranslatable matcher, or an entry with `args` (a command string only) is skipped and warned; `shell` is dropped
 * and warned. Null when nothing is written.
 */
export function antigravityHooks(ctx: EmitBase, hooks: readonly ResolvedIngredient[]): Record<string, Record<string, unknown[]>> | null {
  const out: Record<string, Record<string, unknown[]>> = Object.create(null);
  for (const ing of hooks) {
    const obj = rendered(ctx, ing);
    sharedNotes(ctx, "antigravity", "Antigravity", ing, obj);
    if (obj === null) continue;
    const named: Record<string, unknown[]> = Object.create(null);
    for (const [event, groups] of Object.entries(obj)) {
      const tool = ANTIGRAVITY_TOOL_EVENTS.has(event);
      if (!tool && !ANTIGRAVITY_OTHER_EVENTS.has(event)) {
        ctx.warn(`antigravity: hook ${ing.ref}: event ${event} has no Antigravity equivalent; skipped`);
        continue;
      }
      for (const g of groups) {
        const handlers: Record<string, unknown>[] = [];
        for (const h of g.hooks) {
          if (h.args !== undefined) {
            ctx.warn(`antigravity: hook ${ing.ref}: an ${event} entry uses args, and Antigravity runs a command string; skipped`);
            continue;
          }
          if (h.shell !== undefined) ctx.warn(`antigravity: hook ${ing.ref}: shell has no Antigravity key; dropped`);
          const handler: Record<string, unknown> = { type: "command", command: h.command };
          if (h.timeout !== undefined) handler.timeout = h.timeout;
          handlers.push(handler);
        }
        if (!handlers.length) continue;
        if (tool) {
          const matcher = antigravityMatcher(g.matcher);
          if (matcher === null) {
            ctx.warn(`antigravity: hook ${ing.ref}: the ${event} matcher has no Antigravity translation (only a list of Claude Code tool names does); skipped`);
            continue;
          }
          (named[event] ??= []).push({ matcher, hooks: handlers });
        } else {
          if (g.matcher !== undefined) ctx.warn(`antigravity: hook ${ing.ref}: Antigravity ignores a matcher on ${event}; dropped`);
          (named[event] ??= []).push(...handlers);
        }
      }
    }
    if (Object.keys(named).length) out[outName(ing.meta)] = named;
  }
  return Object.keys(out).length ? out : null;
}
