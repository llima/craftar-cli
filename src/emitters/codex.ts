import type { Ingredient } from "../schema/index.js";
import type { ResolvedIngredient } from "../core/resolve.js";
import { tomlDocument } from "../core/toml.js";
import { codexHooks } from "./hooks.js";
import { outName, ownRuleRefs, textFile } from "./shared.js";
import type { Emitter, PlannedFile } from "./types.js";

/**
 * Codex target (spec 61 §3.1, §5.2, slice 2): `.codex/agents/<name>.toml` — `name`, `description` and `developer_instructions`
 * (the body), the three keys Codex requires, in that order, through the one TOML writer (`src/core/toml.ts`). Rules reach Codex
 * through `agents-md` (it reads `AGENTS.md` only), commands and skills through `agent-skills`, and its MCP servers live in the shared
 * `.codex/config.toml` (D5) — the matrix warns for each here. Since slice 3 (H1) a hook's registration is written to
 * `.codex/hooks.json` (`codexHooks`). Text keeps the line endings of the file it replaces (LF when new), no BOM.
 */
/** Codex's project hooks file (spec 61 slice 3, H1): dedicated to hooks, Claude Code's shape. */
export const CODEX_HOOKS = ".codex/hooks.json";

export const codex: Emitter<"codex"> = {
  target: "codex",
  async emit(ctx) {
    const out: PlannedFile[] = [];
    const t = "codex";
    const refs = ownRuleRefs(ctx, t);
    const hooks: ResolvedIngredient[] = [];
    for (const ing of ctx.aimed) {
      const m = ctx.meta(ing);
      switch (m.type) {
        case "agent": {
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
          break;
        }
        case "hook":
          hooks.push(ing); // collected into .codex/hooks.json below
          break;
        default: {
          const never: never = m;
          throw new Error(`internal: ${t} has no case for ${(never as Ingredient).type}`);
        }
      }
    }
    const doc = hooks.length ? codexHooks(ctx, hooks) : null;
    if (doc) out.push(await textFile(ctx, CODEX_HOOKS, JSON.stringify(doc, null, 2) + "\n", t, "hook/*", { keepBom: false }));
    refs.finish();
    return out;
  },
};
