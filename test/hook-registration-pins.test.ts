import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { loadWorkspace, plan, type Plan } from "../src/core/sync.js";
import { hasBom } from "../src/core/text.js";
import { profile, recipe, scenario, type ForgeSpec, type IngredientSpec, type WorkspaceSpec } from "./helpers/forge.js";

/**
 * Spec 43 §12 / §5.2: pins BEFORE any src/ change. These tests pin the current bytes of
 * .claude/settings.craftar.example.json for a Forge whose hook has no registration. They MUST
 * pass before this spec lands and stay green and unmodified through every later task.
 *
 * These tests cannot "fail first" — they pin today's bytes, not new behaviour.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const EX = ".claude/settings.craftar.example.json";

/** Fixtures per the task preamble: M (mcp ingredient), H without registration (hook ingredient). */
const M: IngredientSpec = {
  meta: { type: "mcp", name: "tracker", authEnv: ["ACME_TOKEN"], server: { command: "npx", args: ["acme-tracker"] } },
};

/** H without registration: a hook with files only, no registration key. */
const H_NO_REG: IngredientSpec = {
  meta: { type: "hook", name: "guard-path", files: ["guard-path.py"] },
  files: { "guard-path.py": 'print("ok")\n' },
};

async function planFor(ingredients: IngredientSpec[], files?: WorkspaceSpec["files"], targets = ["claude-code"]): Promise<Plan> {
  const forge: ForgeSpec = {
    ingredients,
    recipes: [recipe("base", ingredients.map((i) => `${i.meta.type === "mcp" ? "mcp" : i.meta.type}/${i.meta.name}`))],
    profiles: [profile("acme", ["base"], targets)],
  };
  const s = await scenario(forge, { config: { profile: "acme" }, files });
  cleanups.push(s.cleanup);
  return plan(await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME }));
}

const text = (p: Plan, rel: string) => p.files.find((f) => f.path === rel)?.content.toString("utf8");

describe("hook-registration-pins — settings example file before registration feature", () => {
  it("1. mcp with authEnv + hook without registration → example file is env-only JSON", async () => {
    // A Forge with one mcp declaring authEnv and one hook with no registration, targets claude-code
    const p = await planFor([M, H_NO_REG]);
    // The planned example file is exactly this string
    expect(text(p, EX)).toBe('{\n  "env": {\n    "ACME_TOKEN": ""\n  }\n}\n');
    // The file is tagged mcp/*
    const f = p.files.find((f) => f.path === EX)!;
    expect(f.ingredient).toBe("mcp/*");
  });

  it("2. hook without registration and no mcp → no example file", async () => {
    // Same Forge without the mcp ingredient
    const p = await planFor([H_NO_REG]);
    expect(p.files.map((f) => f.path)).not.toContain(EX);
  });

  it("3. CRLF + BOM preservation: existing file keeps both", async () => {
    // An existing on-disk example file in CRLF with a UTF-8 BOM holding the same JSON
    const bomCrlf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]), // UTF-8 BOM
      Buffer.from('{\n  "env": {\n    "ACME_TOKEN": ""\n  }\n}\n'.replace(/\n/g, "\r\n")),
    ]);
    const p = await planFor([M, H_NO_REG], { [EX]: bomCrlf });
    const f = p.files.find((f) => f.path === EX)!;
    // The planned content keeps CRLF and the BOM
    expect(hasBom(f.content)).toBe(true);
    const expected = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{\r\n  "env": {\r\n    "ACME_TOKEN": ""\r\n  }\r\n}\r\n'),
    ]);
    expect(Buffer.from(f.content).equals(expected)).toBe(true);
  });

  it("4. full planned paths and sha256 hashes (literal object)", async () => {
    // Same as 1: the full list of planned paths and the sha256 of every planned file
    const p = await planFor([M, H_NO_REG]);
    const hashOf = (content: Buffer): string =>
      "sha256:" + createHash("sha256").update(content.toString("utf8").replace(/\r\n?/g, "\n").replace(/^\uFEFF/, ""), "utf8").digest("hex");

    // Build observed object: paths sorted, each with its hash
    const observed: Record<string, string> = {};
    for (const f of [...p.files].sort((a, b) => a.path.localeCompare(b.path))) {
      observed[f.path] = hashOf(f.content);
    }

    // The pinned literal object — computed once now, never at runtime
    expect(observed).toEqual({
      ".claude/hooks/guard-path.py": "sha256:3a66aebdedbad3cf107d24e72a07d4b735819b1cf4020fdd922f63c064708172",
      ".claude/settings.craftar.example.json": "sha256:89ad04b3a98e99d55e5825d83633359c81d836659287f6710d7f824d633995f0",
      ".mcp.json": "sha256:d2d0f6fcf0f720ba5c0c53c5abf8489812db35b0d88464455d50531be02dfbbd",
    });
  });
});
