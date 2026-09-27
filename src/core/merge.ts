/**
 * Layer merge: objects merge key by key; arrays and scalars from the stronger layer replace the weaker one.
 * Shared by `loadWorkspace` (craftar.yaml under craftar.local.yaml) and import's workspace layer, so both
 * read `overrides.params` the same way. `any`: it merges parsed YAML of any shape, validated by the caller.
 */
export function deepMerge(a: any, b: any): any {
  if (b === undefined) return a;
  if (Array.isArray(a) || Array.isArray(b)) return b;
  if (a && b && typeof a === "object" && typeof b === "object") {
    const out = { ...a };
    for (const k of Object.keys(b)) out[k] = k in a ? deepMerge(a[k], b[k]) : b[k];
    return out;
  }
  return b;
}
