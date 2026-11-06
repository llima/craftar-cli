/**
 * Native-targets helpers (spec 61 §7).
 *
 * These functions determine whether a Forge schema is high enough to allow native targets
 * (cursor), and provide near-miss detection for typos.
 */

import { TARGETS, LEGACY_TARGETS, type Target, type LegacyTarget } from "../schema/index.js";

/**
 * The targets that require Forge schema 15 (FORGE_SCHEMA_NATIVE_TARGETS).
 * These are targets in TARGETS that are not in LEGACY_TARGETS.
 */
export const NATIVE_TARGETS = TARGETS.filter((t) => !(LEGACY_TARGETS as readonly string[]).includes(t)) as readonly Target[];

/**
 * Returns `true` when `schema` is high enough to allow native targets (cursor) in
 * ingredients, profiles, and section markers.
 */
export function readsNativeTargets(schema: number): boolean {
  return schema >= 15;
}

/**
 * For a string that is not a valid target, returns the closest native target if it looks
 * like a typo (Levenshtein distance ≤ 2). Used by `loadForge` to give a helpful hint.
 */
export function nativeTargetNearMiss(input: string): Target | null {
  const lower = input.toLowerCase();
  for (const t of NATIVE_TARGETS) {
    if (levenshtein(lower, t) <= 2) return t;
  }
  return null;
}

/**
 * Returns the first native target found in a list, or `null` if all are legacy targets.
 * Used by the sync to decide whether to write lock schema 4.
 */
export function firstNewTarget(targets: readonly string[]): Target | null {
  for (const t of targets) {
    if ((NATIVE_TARGETS as readonly string[]).includes(t)) return t as Target;
  }
  return null;
}

/**
 * Simple Levenshtein distance for short strings (target names are ≤ 10 chars).
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return matrix[b.length][a.length];
}
