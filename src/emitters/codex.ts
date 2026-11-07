import { tomlDocument } from "../core/toml.js";
import { outName, ownRuleRefs, textFile } from "./shared.js";
import type { Emitter, PlannedFile } from "./types.js";

/**
 * Codex target (spec 61 §3.1, §5.2, slice 2): `.codex/agents/<name>.toml` — `name`, `description` and `developer_instructions`
 * (the body), the three keys Codex requires, in that order, through the one TOML writer (`src/core/toml.ts`). Rules reach Codex
 * through `agents-md` (it reads `AGENTS.md` only), commands and skills through `agent-skills`, and its MCP servers live in the shared
 * `.codex/config.toml` (D5) — the matrix warns for each here. Text keeps the line endings of the file it replaces (LF when new), no BOM.
 */
export const codex: Emitter<"codex"> = {
  target: "codex",
  async emit(ctx) {
    const out: PlannedFile[] = [];
    const t = "codex";
    const refs = ownRuleRefs(ctx, t);
    // The matrix says codex writes agents alone (`Written<"codex">` is pinned to "agent" in capabilities.ts), so the walk yields
    // nothing else and there is no switch to fall through.
    for (const ing of ctx.aimed) {
      const m = ctx.meta(ing);
      const name = outName(m);
      const path = `.codex/agents/${name}.toml`;
      const body = refs.resolve(await ctx.text(ing, m.file, t), ing.ref);
      if (!m.description) ctx.warn(`codex: agent "${name}" has no description, which Codex requires; written empty`);
      if (m.model) ctx.warn(`codex: agent "${name}": model is not written (the Forge names Claude Code's models); dropped`);
      if ((m.tools?.length ?? 0) > 0) ctx.warn(`codex: agent "${name}": tools have no Codex field and are dropped`);
      const doc = tomlDocument([
        ["name", name],
        ["description", m.description ?? ""],
        ["developer_instructions", { multiline: body }],
      ]);
      out.push(await textFile(ctx, path, doc, t, ing.ref, { keepBom: false }));
    }
    refs.finish();
    return out;
  },
};
