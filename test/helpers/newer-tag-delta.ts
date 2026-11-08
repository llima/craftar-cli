/**
 * The deliberate delta of `forge.newerTag` (1.9.0, the user's rulings of 2026-11-08): `status --json` gains the key, last in
 * `forge`, `null` for every pin's Forge (a path Forge, or a remote one with no newer `vX.Y.Z` tag). Filtered by name out of the
 * off pins that hold an earlier release's state on purpose, so they keep proving that nothing else moved. Only a `null` value is
 * dropped: a pin whose run names a newer tag still differs.
 */
const IN_TEXT = /,(\r?\n[ \t]*)"newerTag": null(?=\r?\n[ \t]*\})/g;

function walk(v: unknown): unknown {
  if (typeof v === "string") return v.replace(IN_TEXT, "");
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!(k === "newerTag" && x === null)) o[k] = walk(x);
    return o;
  }
  return v;
}

export function withoutNewerTag<T>(v: T): T {
  return walk(v) as T;
}
