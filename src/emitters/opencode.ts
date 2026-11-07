import type { Emitter, PlannedFile } from "./types.js";

/**
 * OpenCode target (spec 63): rules reach OpenCode through `agents-md` (it reads `AGENTS.md`) and skills through `agent-skills`;
 * the matrix warns for every other type until this emitter writes it, so the walk yields nothing yet.
 */
export const opencode: Emitter<"opencode"> = {
  target: "opencode",
  async emit(ctx) {
    const out: PlannedFile[] = [];
    for (const ing of ctx.aimed) throw new Error(`internal: opencode writes no ${ing.meta.type} yet (${ing.ref})`);
    return out;
  },
};
