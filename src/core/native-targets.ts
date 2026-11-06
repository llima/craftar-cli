/**
 * Native-targets helpers (spec 61 §7; slice 2's plan, G1).
 *
 * Which Forge schema each target needs, the one comparison with it, the near miss below it, and the lock schema an owner needs.
 */

import {
  TARGETS,
  LEGACY_TARGETS,
  SLICE_1_TARGETS,
  type Owner,
  type Target,
  FORGE_SCHEMA_NATIVE_TARGETS,
  FORGE_SCHEMA_SLICE_2_TARGETS,
} from "../schema/index.js";

/**
 * The Forge schema a Forge file needs to name each target (in an ingredient's or a profile's `targets`, or a section's `targets=`):
 * the legacy three at every schema, slice 1's at 15, slice 2's at 16. A `Record` over every target, so a new one does not compile
 * until its gate is written.
 */
export const TARGET_SINCE: Record<Target, number> = {
  "claude-code": 1,
  kiro: 1,
  "agents-md": 1,
  cursor: FORGE_SCHEMA_NATIVE_TARGETS,
  copilot: FORGE_SCHEMA_NATIVE_TARGETS,
  "agent-skills": FORGE_SCHEMA_NATIVE_TARGETS,
  codex: FORGE_SCHEMA_SLICE_2_TARGETS,
};

/** The targets that require a Forge schema above 1: every target that is not a legacy one. */
export const NATIVE_TARGETS = TARGETS.filter((t) => !(LEGACY_TARGETS as readonly string[]).includes(t)) as readonly Target[];

/** Whether a Forge at `schema` may name `target`. The ONE comparison with the targets' gates. */
export function allowsTarget(schema: number, target: Target): boolean {
  return schema >= TARGET_SINCE[target];
}

/**
 * The near-miss message for a target named below its gate. Used by `loadForge` (key: `targets`) and the section pass
 * (key: `section <name> targets=`), so both say the same.
 *
 * @param file - The file where the target was found (Forge-relative path), or null to omit the file prefix
 * @param key - The context key (e.g. "targets" or "section tone targets=")
 * @param target - The target that was found
 */
export function nativeTargetNearMiss(file: string | null, key: string, target: Target): string {
  const prefix = file ? `${file}: ` : "";
  return `${prefix}${key}: ${target} needs schema: ${TARGET_SINCE[target]} in craftar.forge.yaml`;
}

/**
 * The lock schema an owner needs (spec 61 §7, slice 2's G1): 2 for a legacy target, 3 for `services`, 4 for a slice-1 target,
 * 5 for any later one. `apply()` writes the highest its targets and entries need.
 */
export function lockSchemaFor(owner: Owner): 2 | 3 | 4 | 5 {
  if (owner === "services") return 3;
  if ((LEGACY_TARGETS as readonly string[]).includes(owner)) return 2;
  if ((SLICE_1_TARGETS as readonly string[]).includes(owner)) return 4;
  return 5;
}
