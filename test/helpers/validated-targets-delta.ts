/**
 * The deliberate delta of the native targets' CLI validation (1.5.0, ruled 2026-11-07), filtered by name out of the slice-2 and
 * slice-3 off pins so they keep proving that nothing else moved:
 * - F1: copilot's new `.github/mcp.json` — its plan file, lock entry and status rows, the `+ .github/mcp.json` line of `sync` and the
 *   one it adds to the `wrote N` / `unchanged N` counts; and the copilot `command` and `mcp` cells of `targets --json`;
 * - F2: the `tools: ` line claude-code no longer writes for an agent with no tools — the line itself, and the hash of every
 *   `.claude/agents/*.md` in the plan, the lock and the status rows.
 */
const CLI_MCP = ".github/mcp.json";
const AGENT = /^\.claude\/agents\/[^/]+\.md$/;
const SYNC_LINE = /^\s*\+ \.github\/mcp\.json\s*$/;
const EMPTY_TOOLS = /^tools: \r?$/;

function lines(s: string, hasCliMcp: boolean): string {
  return s
    .split("\n")
    .filter((l) => !SYNC_LINE.test(l) && !EMPTY_TOOLS.test(l))
    .map((l) => (hasCliMcp ? l.replace(/\bwrote (\d+)/, (_, n) => `wrote ${Number(n) - 1}`).replace(/\bunchanged (\d+)/, (_, n) => `unchanged ${Number(n) - 1}`) : l))
    .join("\n");
}

function text(s: string, hasCliMcp: boolean): string {
  const t = s.trim();
  if (t.startsWith("{")) {
    try {
      return JSON.stringify(walk(JSON.parse(t), false), null, 2) + "\n";
    } catch {
      /* not JSON: fall through */
    }
  }
  return lines(s, hasCliMcp);
}

function mentionsCliMcp(v: unknown): boolean {
  return JSON.stringify(v ?? null).includes(`"path":"${CLI_MCP}"`) || JSON.stringify(v ?? null).includes(`+ ${CLI_MCP}`);
}

function walk(v: unknown, hasCliMcp: boolean): unknown {
  if (typeof v === "string") return text(v, hasCliMcp);
  if (Array.isArray(v)) return v.filter((x) => !(x && typeof x === "object" && (x as { path?: unknown }).path === CLI_MCP)).map((x) => walk(x, hasCliMcp));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    // a scenario record: its sync line and counts carry the new file only when its plan holds it
    const scenario = "plan" in v && "sync" in v ? mentionsCliMcp((v as { plan: unknown }).plan) : hasCliMcp;
    for (const [k, x] of Object.entries(v)) o[k] = walk(x, scenario);
    if (typeof o.path === "string" && AGENT.test(o.path)) {
      if ("hash" in o) o.hash = "<agent>";
      if ("sha256" in o) o.sha256 = "<agent>";
    }
    if (o.name === "copilot" && o.capabilities && typeof o.capabilities === "object") {
      o.capabilities = { ...(o.capabilities as Record<string, unknown>), command: "<validated>", mcp: "<validated>" };
    }
    return o;
  }
  return v;
}

export function withoutValidatedDelta(v: unknown): unknown {
  return walk(v, false);
}
