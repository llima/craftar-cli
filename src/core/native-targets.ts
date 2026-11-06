/**
 * Native-targets helpers (spec 61 §7).
 *
 * These functions determine whether a Forge schema is high enough to allow native targets
 * (cursor), and provide near-miss messages for use below the schema gate.
 */

import { TARGETS, LEGACY_TARGETS, type Target, type LegacyTarget, FORGE_SCHEMA_NATIVE_TARGETS } from "../schema/index.js";

/**
 * The targets that require Forge schema 15 (FORGE_SCHEMA_NATIVE_TARGETS).
 * These are targets in TARGETS that are not in LEGACY_TARGETS.
 */
export const NATIVE_TARGETS = TARGETS.filter((t) => !(LEGACY_TARGETS as readonly string[]).includes(t)) as readonly Target[];

/**
 * Returns `true` when `manifest.schema` is high enough to allow native targets (cursor) in
 * ingredients, profiles, and section markers.
 *
 * This is the ONE comparison with FORGE_SCHEMA_NATIVE_TARGETS.
 */
export function readsNativeTargets(manifest: { schema: number }): boolean {
  return manifest.schema >= FORGE_SCHEMA_NATIVE_TARGETS;
}

/**
 * Returns the near-miss message for a native target found below the schema gate.
 * Used by `loadForge` (key: `targets`) and section pass (key: `section <name> targets=`)
 * to produce consistent error messages.
 *
 * @param file - The file where the target was found (Forge-relative path)
 * @param key - The context key (e.g. "targets" or "section tone targets=")
 * @param target - The native target that was found
 * @returns The error message to display
 */
export function nativeTargetNearMiss(file: string, key: string, target: string): string {
  return `${file}: ${key}: ${target} needs schema: ${FORGE_SCHEMA_NATIVE_TARGETS} in craftar.forge.yaml`;
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
