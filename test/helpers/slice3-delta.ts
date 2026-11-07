/**
 * Spec 61 slice 3's deliberate delta (H1, ruled 2026-11-07), filtered by name out of the slice-1 and slice-2 off pins so they keep
 * proving that nothing else moved: the hook skip warnings of cursor, copilot, codex and antigravity (cursor and copilot become
 * "through claude-code", codex and antigravity write hooks); the new `codex: hook …` / `antigravity: hook …` warnings; the files
 * `.codex/hooks.json` and `.agents/hooks.json` and their lock entries; and the hook cell of cursor, copilot, codex and antigravity in
 * `targets --json` (agent-skills' hook cell did not move, so it is compared).
 */
const LINE = /(cursor|copilot|codex|antigravity): 1 hook ingredient\(s\) have no (Cursor|Copilot|Codex|Antigravity) equivalent|(^|\s|")(codex|antigravity): hook /;
const HOOK_FILES = new Set([".codex/hooks.json", ".agents/hooks.json"]);
const NATIVE = new Set(["cursor", "copilot", "codex", "antigravity"]);

function stripText(s: string): string {
  // A JSON document printed on stdout (status --json, targets --json): filter its arrays, not its lines
  const t = s.trim();
  if (t.startsWith("{")) {
    try {
      return JSON.stringify(withoutSlice3Delta(JSON.parse(t)), null, 2) + "\n";
    } catch {
      /* not JSON: fall through */
    }
  }
  return s
    .split("\n")
    .filter((l) => !LINE.test(l))
    .join("\n");
}

export function withoutSlice3Delta(v: unknown): unknown {
  if (typeof v === "string") return stripText(v);
  if (Array.isArray(v))
    return v
      .filter((x) => !(typeof x === "string" && LINE.test(x)))
      .filter((x) => !(x && typeof x === "object" && typeof (x as { message?: unknown }).message === "string" && LINE.test((x as { message: string }).message)))
      .filter((x) => !(x && typeof x === "object" && HOOK_FILES.has((x as { path?: string }).path ?? "")))
      .map(withoutSlice3Delta);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = withoutSlice3Delta(x);
    // a target row of targets --json: a native target's hook cell is slice 3's
    if (typeof o.name === "string" && NATIVE.has(o.name) && o.capabilities && typeof o.capabilities === "object") {
      o.capabilities = { ...(o.capabilities as Record<string, unknown>), hook: "<slice 3>" };
    }
    return o;
  }
  return v;
}
