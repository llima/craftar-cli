import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { renderImportReport } from "../src/core/import-report.js";
import type { ImportReport } from "../src/importers/claude-code.js";
import { runCli } from "./helpers/cli.js";
import { profile } from "./helpers/forge.js";
import { ado, forgeAt, PM, sync } from "./helpers/integrations.js";

// Spec 33 §4.2 / A4 — the report's "Left to an integration recipe" section.

// Copied from test/import-report.test.ts (they are not exported).
const base = (over: Partial<ImportReport> = {}): ImportReport => ({
  created: ["craftar.forge.yaml", "rule/workflow"],
  reused: ["rule/commit", "rule/plain", "rule/guess", "rule/parts"],
  variants: [{ name: "rule/review--acme", reason: "differs from rule/review already in the Forge" }],
  rejected: [],
  recipes: ["base"],
  profile: "acme",
  warnings: [],
  rendered: [{ name: "rule/commit", keys: ["scm.org"], sections: ["extra"] }],
  inferred: [{ name: "rule/guess", values: { org: "SECRET-LOOKING-VALUE" } }],
  params: [],
  sectioned: [{ name: "rule/parts", sections: ["who", "where"] }],
  sections: [],
  recipeSplits: [],
  leftToRecipes: [],
  profileWrite: { path: "profiles/acme/profile.yaml", action: "created", fields: [] },
  manifestWrite: "created",
  configWrite: null,
  configForgeKept: null,
  ...over,
});
const render = (report: ImportReport) =>
  renderImportReport({ workspace: "/work/acme-portal", forge: "/work/forge", report, now: new Date("2026-10-09T14:03:22.987Z"), version: "9.9.9" });
/** The text after the closing `---` of the frontmatter. */
const body = (text: string) => text.slice(text.indexOf("\n---\n", 4) + 5);

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A Forge at `schema` and a workspace synced from it. */
async function synced(schema: number, spec: ReturnType<typeof ado>) {
  const s = await forgeAt(schema, spec);
  cleanups.push(s.cleanup);
  await sync(s.wsRoot);
  return s;
}

describe("import --report — leftToRecipes section (spec 33 §4.2 / A4)", () => {
  it("31. the section, between Rejected and the Kiro sections", () => {
    // base() has rejected: [] so the heading is ## Rejected (0); no need to override
    const text = render(base({
      leftToRecipes: [
        { recipe: "pm-common", slot: "pm", refs: ["rule/stories-azure-devops"] },
        { recipe: "pm-azure-devops", slot: "pm", refs: ["mcp/azure-devops", "agent/api-reviewer"] },
      ],
    }));
    expect(body(text)).toContain(
      "## Rejected (0)\n\n## Left to an integration recipe (2)\n- pm-common (integrations.pm): rule/stories-azure-devops\n- pm-azure-devops (integrations.pm): mcp/azure-devops, agent/api-reviewer\n\n## Kiro collisions"
    );
  });

  it("32. (control) absent when nothing was left — the report's bytes are today's", () => {
    const a = render(base({ leftToRecipes: [] }));
    const b = render(base());
    expect(a).toBe(b);
    expect(a).not.toContain("Left to an integration recipe");
  });

  it("33. end to end", async () => {
    const s = await synced(3, ado());
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-report-"));
    cleanups.push(() => fs.rm(outDir, { recursive: true, force: true }));
    const out = path.join(outDir, "report.md");
    const cli = runCli(["import", "--from", "claude-code", "--forge", s.forgeRoot, "--profile", "acme", "--workspace", s.wsRoot, "--report", out]);
    expect(cli.code).toBe(0);
    const file = await fs.readFile(out, "utf8");
    expect(file).toContain("## Left to an integration recipe (1)\n- pm-azure-devops (integrations.pm): rule/stories-azure-devops, mcp/azure-devops\n");
    expect(file).toContain("## Created (0)");
    expect(file).toContain("## Variants (0)");
    expect(file).toContain("## Rejected (0)");
    // Print once, then pin: the Kiro section headings (no collision, no unsourced file)
    expect(file).toContain("## Kiro collisions (0)");
    expect(file).toContain("## Unsourced Kiro files (0)");
  });

  it("34. (control) schema 2, hand-listed: no section", async () => {
    // Case 30's Forge: schema 2, recipes listed by hand
    const spec = ado({}, PM, { recipes: ["base", "pm-azure-devops"], params: { "integrations.pm.org": "acme", "integrations.pm.project": "Platform" } });
    const s = await synced(2, spec);
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-report-"));
    cleanups.push(() => fs.rm(outDir, { recursive: true, force: true }));
    const out = path.join(outDir, "report.md");
    runCli(["import", "--from", "claude-code", "--forge", s.forgeRoot, "--profile", "acme", "--workspace", s.wsRoot, "--report", out]);
    const file = await fs.readFile(out, "utf8");
    expect(file).not.toContain("Left to an integration recipe");
  });
});
