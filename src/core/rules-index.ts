/**
 * Rules index (spec 44 §4): the gate and the reserved prefix.
 */

import { FORGE_SCHEMA_RULES_INDEX } from "../schema/index.js";

/** The rules-index key (spec 44 §4.2). */
export const RULES_INDEX_KEY = "craftar.rules.index";

/** Whether the Forge reads the rules index (spec 44 §4.1). */
export function readsRulesIndex(manifest: { schema: number }): boolean {
  return manifest.schema >= FORGE_SCHEMA_RULES_INDEX;
}
