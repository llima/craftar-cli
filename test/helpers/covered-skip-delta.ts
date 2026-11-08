/**
 * The deliberate delta of the covered agents-md skip (the user's choice "CLI: calar o aviso coberto", 2026-11-08), filtered by
 * name out of the off pins that cannot be regenerated without importing another delta (they hold the state of an earlier release
 * on purpose, or a machine's own doctor line), so they keep proving that nothing else moved:
 * - the `agents-md: N <type> ingredient(s) have no AGENTS.md equivalent — skipped: …` warning, which is now silent for an
 *   ingredient another target of the workspace writes — as an array item, a doctor check's message, and a line of printed text;
 * - its consequence in `doctor`: the one `plan` `ok` line printed when no plan warning is left, and the summary's counts
 *   (recounted from the checks left).
 * Dropping every such line on both sides would also hide a skip that must stay warned, so a test that filters with
 * `withoutCoveredSkip` also asserts `skipResidue(observed, expected)` is empty: every skip line the run still prints names
 * the same type and a subset of the refs of a line the pin holds. That such lines stay warned at all is
 * test/agents-md-covered-skip.test.ts's to prove.
 */
const SKIP = /agents-md: \d+ \S+ ingredient\(s\) have no AGENTS\.md equivalent — skipped: [^\n"]*/;
const SKIP_WHOLE = new RegExp(`^${SKIP.source}$`);
const SKIP_LINE = new RegExp(`^.*${SKIP.source}\\r?$`);

function text(s: string): string {
  const t = s.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.stringify(walk(JSON.parse(t)), null, 2) + "\n";
    } catch {
      /* not JSON: fall through */
    }
  }
  return s
    .split("\n")
    .filter((l) => !SKIP_LINE.test(l))
    .join("\n");
}

const isSkipCheck = (x: unknown) => !!x && typeof x === "object" && typeof (x as { message?: unknown }).message === "string" && SKIP_WHOLE.test((x as { message: string }).message);
const isPlanOk = (x: unknown) => !!x && typeof x === "object" && (x as { id?: unknown }).id === "plan" && (x as { level?: unknown }).level === "ok";

function walk(v: unknown): unknown {
  if (typeof v === "string") return text(v);
  if (Array.isArray(v)) return v.filter((x) => !(typeof x === "string" && SKIP_WHOLE.test(x)) && !isSkipCheck(x) && !isPlanOk(x)).map(walk);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x);
    // a doctor report: its summary is recounted from the checks left, so a count that moved for any other reason still shows
    const s = o.summary as Record<string, unknown> | undefined;
    if (s && typeof s === "object" && "warn" in s && "ok" in s && Array.isArray(o.checks)) {
      const counts: Record<string, number> = { ok: 0, warn: 0, error: 0 };
      for (const c of o.checks as Array<{ level?: string }>) if (c && typeof c.level === "string") counts[c.level] = (counts[c.level] ?? 0) + 1;
      o.summary = counts;
    }
    return o;
  }
  return v;
}

export function withoutCoveredSkip(v: unknown): unknown {
  return walk(v);
}

const PARSE = /agents-md: (\d+) (\S+) ingredient\(s\) have no AGENTS\.md equivalent — skipped: ([^\n"\\]*)/g;

function skipLines(v: unknown, out: Array<{ type: string; refs: string[]; count: number; line: string }>): void {
  if (typeof v === "string") {
    for (const m of v.matchAll(PARSE)) out.push({ count: Number(m[1]), type: m[2], refs: m[3].split(", ").map((r) => r.trim()), line: m[0] });
  } else if (Array.isArray(v)) for (const x of v) skipLines(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) skipLines(x, out);
}

/** The skip lines of `observed` that no line of `expected` covers (same type, a subset of its refs, a count equal to its refs). */
export function skipResidue(observed: unknown, expected: unknown): string[] {
  const seen: Array<{ type: string; refs: string[]; count: number; line: string }> = [];
  const pinned: typeof seen = [];
  skipLines(observed, seen);
  skipLines(expected, pinned);
  return seen
    .filter((o) => o.count !== o.refs.length || !pinned.some((p) => p.type === o.type && o.refs.every((r) => p.refs.includes(r))))
    .map((o) => o.line);
}
