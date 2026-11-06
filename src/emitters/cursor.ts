/**
 * Cursor emitter (spec 61 §7).
 *
 * The Cursor target is a placeholder for future development. Currently all cells are unsupported,
 * so this emitter yields nothing.
 */

import type { Emitter, PlannedFile, EmitContext } from "./types.js";

/**
 * The Cursor emitter. All ingredient types are unsupported, so it yields no files.
 */
export const cursor: Emitter<"cursor"> = {
  target: "cursor",
  async emit(ctx: EmitContext<"cursor">): Promise<PlannedFile[]> {
    // All cells are unsupported; nothing to emit.
    // The walk must be consumed to record skipped ingredients.
    for (const _ing of ctx.aimed) {
      // Iteration itself causes the walk to warn for each ingredient.
    }
    return [];
  },
};
