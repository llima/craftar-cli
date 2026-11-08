import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";

// Spec 62 §4.4, §5.3 step 4: import says which Forge paths it wrote, so `craftar setup` stages them by name.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function listFiles(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(root, r)));
    else out.push(r);
  }
  return out.sort();
}

describe("ImportReport.forgeWrites", () => {
  it("lists every Forge path the flush wrote, sorted, Forge-relative with /", async () => {
    const root = await tmpDir("craftar-import-writes-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const ws = path.join(root, "ws");
    await writeFiles(ws, {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".claude/agents/reviewer.md": "---\nname: reviewer\ndescription: Reviews.\ntools: Read\n---\n\nBody.\n",
    });
    const r = await importClaudeCode({ workspaceRoot: ws, forgeRoot: forge, profileName: "acme" });
    expect(r.forgeWrites).toEqual(await listFiles(forge));
    expect(r.forgeWrites!.length).toBeGreaterThan(3);
  });

  it("omits a file the import left unchanged on a re-import", async () => {
    const root = await tmpDir("craftar-import-writes-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const ws = path.join(root, "ws");
    await writeFiles(ws, { ".claude/rules/workflow.md": "# Workflow\n" });
    await importClaudeCode({ workspaceRoot: ws, forgeRoot: forge, profileName: "acme" });
    const again = await importClaudeCode({ workspaceRoot: ws, forgeRoot: forge, profileName: "acme" });
    expect(again.forgeWrites).not.toContain("ingredients/rules/workflow/rule.md");
  });
});
