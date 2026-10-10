import { describe, it, expect, afterEach } from "vitest";
import { forgeAt, ado, sync } from "./helpers/integrations.js";
import { recipe, profile } from "./helpers/forge.js";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { renderImportReport } from "../src/core/import-report.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.map((f) => f()));
  cleanups.length = 0;
});

/** A Forge at `schema` and a workspace synced from it. */
async function synced(schema: number, spec: ReturnType<typeof ado>) {
  const s = await forgeAt(schema, spec);
  cleanups.push(s.cleanup);
  await sync(s.wsRoot);
  return s;
}

describe("import --report — leftToRecipes section (spec 33 §4.2 / A4)", () => {
  it("31. at schema 3, the report has the 'Left to an integration recipe' section", async () => {
    const s = await synced(3, ado());
    const report = await importClaudeCode({ workspaceRoot: s.wsRoot, forgeRoot: s.forgeRoot, profileName: "acme", report: true });
    const text = renderImportReport({ workspace: s.wsRoot, forge: s.forgeRoot, report, now: new Date(), version: "test" });
    expect(text).toContain("## Left to an integration recipe (1)");
    expect(text).toContain("- pm-azure-devops (integrations.pm): rule/stories-azure-devops, mcp/azure-devops");
  });

  it("32. the section is after 'Rejected' and before 'Kiro collisions'", async () => {
    const s = await synced(3, ado());
    const report = await importClaudeCode({ workspaceRoot: s.wsRoot, forgeRoot: s.forgeRoot, profileName: "acme", report: true });
    const text = renderImportReport({ workspace: s.wsRoot, forge: s.forgeRoot, report, now: new Date(), version: "test" });
    const rejectedIdx = text.indexOf("## Rejected");
    const leftToIdx = text.indexOf("## Left to an integration recipe");
    const kiroIdx = text.indexOf("## Kiro collisions");
    expect(rejectedIdx).toBeLessThan(leftToIdx);
    expect(leftToIdx).toBeLessThan(kiroIdx);
  });

  it("33. at schema 2, no 'Left to an integration recipe' section (below the gate)", async () => {
    const s = await synced(2, ado());
    const report = await importClaudeCode({ workspaceRoot: s.wsRoot, forgeRoot: s.forgeRoot, profileName: "acme", report: true });
    const text = renderImportReport({ workspace: s.wsRoot, forge: s.forgeRoot, report, now: new Date(), version: "test" });
    expect(text).not.toContain("## Left to an integration recipe");
    // The section goes from Rejected straight to Kiro
    const rejectedIdx = text.indexOf("## Rejected");
    const kiroIdx = text.indexOf("## Kiro collisions");
    const between = text.slice(rejectedIdx, kiroIdx);
    expect(between).not.toContain("## Left to");
  });

  it("34. multiple integration recipes: each gets a bullet", async () => {
    // Create a Forge with two integration recipes in different slots
    const spec = ado();
    spec.ingredients = spec.ingredients!.concat([
      { meta: { type: "rule", name: "ci-github-actions" }, files: { "rule.md": "# CI rules for GitHub Actions\n" } },
      { meta: { type: "mcp", name: "github-actions", server: { command: "npx", args: ["-y", "gha-mcp"] } } },
    ]);
    spec.recipes = spec.recipes!.concat([
      recipe("ci-github-actions", ["rule/ci-github-actions", "mcp/github-actions"], { slot: "ci" }),
    ]);
    spec.profiles = [profile("acme", ["base"], ["claude-code", "kiro"], { integrations: { pm: { kind: "azure-devops", org: "acme", project: "Platform" }, ci: { kind: "github-actions" } } })];
    const s = await synced(3, spec);
    const report = await importClaudeCode({ workspaceRoot: s.wsRoot, forgeRoot: s.forgeRoot, profileName: "acme", report: true });
    const text = renderImportReport({ workspace: s.wsRoot, forge: s.forgeRoot, report, now: new Date(), version: "test" });
    expect(text).toContain("## Left to an integration recipe (2)");
    expect(text).toContain("- pm-azure-devops (integrations.pm):");
    expect(text).toContain("- ci-github-actions (integrations.ci):");
  });
});
