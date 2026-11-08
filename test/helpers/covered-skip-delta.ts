/**
 * The deliberate delta of the covered agents-md skip (the user's choice "CLI: calar o aviso coberto", 2026-11-08), filtered by
 * name out of the off pins that cannot be regenerated without importing another delta (they hold the state of an earlier release
 * on purpose, or a machine's own doctor line), so they keep proving that nothing else moved:
 * - the `agents-md: N <type> ingredient(s) have no AGENTS.md equivalent — skipped: …` warning, which is now silent for an
 *   ingredient another target of the workspace writes — as an array item, a doctor check's message, and a line of printed text;
 * - its consequence in `doctor`: the one `plan` `ok` line printed when no plan warning is left, and the summary's counts.
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
    const s = o.summary as Record<string, unknown> | undefined;
    if (s && typeof s === "object" && "warn" in s && "ok" in s) o.summary = "<summary>";
    return o;
  }
  return v;
}

export function withoutCoveredSkip(v: unknown): unknown {
  return walk(v);
}
