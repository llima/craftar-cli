import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadWorkspace, plan, type Plan } from "../src/core/sync.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, scenario, type ForgeSpec } from "./helpers/forge.js";

/**
 * Spec 47 §5.2 / §11 item 8: a profile's `docs:` block changes no emitted byte. Written BEFORE any src/ change: it passes
 * today because ProfileSchema strips the unknown key, and must stay green and unmodified through the build. A pin, not a
 * fail-first test.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const PIN = path.join(__dirname, "pins", "docs-block-off.json");

const WELL_FORMED = {
  categories: [{ path: "architecture", frontmatter: ["title", "date"] }, { path: "tech-debt", name: "dated" }],
  uncovered: "error",
  related: "resolve",
};
const MALFORMED = { categories: "not a list", related: 7, __proto__x: 1, extra: { deep: [1, 2] } };

function forge(docs?: unknown): ForgeSpec {
  return {
    ingredients: [
      rule("style", "# Style\n\nKeep it short.\n"),
      rule("scoped", "# Scoped\n", { inclusion: "fileMatch", fileMatchPattern: ["src/**/*.ts"] }),
      { meta: { type: "mcp", name: "tracker", server: { command: "npx", args: ["acme-tracker"] } } },
    ],
    recipes: [recipe("base", ["rule/style", "rule/scoped", "mcp/tracker"])],
    profiles: [profile("acme", ["base"], ["claude-code", "kiro", "agents-md"], docs === undefined ? {} : { docs })],
  };
}

async function planned(docs?: unknown): Promise<{ p: Plan; wsRoot: string }> {
  const s = await scenario(forge(docs), { config: { profile: "acme" } });
  cleanups.push(s.cleanup);
  return { p: await plan(await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME })), wsRoot: s.wsRoot };
}

const hashes = (p: Plan) =>
  Object.fromEntries(p.files.map((f) => [f.path, createHash("sha256").update(f.content).digest("hex")] as const).sort(([a], [b]) => (a < b ? -1 : 1)));

describe("docs-block-pins — a profile's docs: block changes no planned byte (spec 47 §11 item 8)", () => {
  it("the plan without a block matches the pin", async () => {
    const { p } = await planned();
    const pin = JSON.parse(await fs.readFile(PIN, "utf8"));
    expect({ files: hashes(p), warnings: p.warnings }).toEqual(pin);
  });

  for (const [label, docs] of [
    ["a well-formed block", WELL_FORMED],
    ["a malformed block", MALFORMED],
    ["docs: null", null],
  ] as const) {
    it(`${label}: the same paths, bytes and warnings as the pin`, async () => {
      const { p } = await planned(docs);
      const pin = JSON.parse(await fs.readFile(PIN, "utf8"));
      expect({ files: hashes(p), warnings: p.warnings }).toEqual(pin);
    });
  }

  it("a workspace synced with a malformed block stays in sync (sync --check exit 0)", async () => {
    const s = await scenario(forge(MALFORMED), { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    const synced = runCli(["sync", "--workspace", s.wsRoot]);
    expect(synced.code).toBe(0);
    const check = runCli(["sync", "--check", "--workspace", s.wsRoot]);
    expect(check.code).toBe(0);
  });
});
