/**
 * Golden test for the agent-skills target (spec 61 §6, §9): the acme-agent-skills scenario synced at schema 15, byte for byte.
 * Regenerated only with test/helpers/regen-golden-agent-skills.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles } from "../src/core/forge.js";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { acmeAgentSkills } from "./helpers/agent-skills.js";
import type { Scenario } from "./helpers/forge.js";

const GOLDEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "golden/acme-agent-skills");
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function synced(): Promise<{ s: Scenario; paths: string[]; warnings: string[] }> {
  const s = await acmeAgentSkills();
  cleanups.push(s.cleanup);
  const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
  const p = await plan(ws);
  await apply(ws, p, await status(ws, p, await readLock(ws.root)), {});
  return { s, paths: p.files.map((f) => f.path).sort(), warnings: p.warnings };
}

describe("golden — acme-agent-skills (spec 61 §6, §9)", () => {
  it("a sync writes exactly the golden files, byte for byte", async () => {
    const { s, paths } = await synced();
    expect(paths).toEqual((await listFiles(GOLDEN)).sort());
    expect(paths).toEqual([
      ".agents/skills/deploy/SKILL.md",
      ".agents/skills/deploy/logo.png",
      ".agents/skills/deploy/run.sh",
      ".agents/skills/docs/SKILL.md",
      ".agents/skills/review/SKILL.md",
    ]);
    for (const rel of paths) {
      expect((await fs.readFile(path.join(s.wsRoot, rel))).equals(await fs.readFile(path.join(GOLDEN, rel))), rel).toBe(true);
    }
  });

  it("the skipped types are said once per type", async () => {
    const { warnings } = await synced();
    expect(warnings).toEqual(expect.arrayContaining([
      "agent-skills: 1 rule ingredient(s) have no Agent Skills equivalent — skipped: rule/style",
      "agent-skills: 1 agent ingredient(s) have no Agent Skills equivalent — skipped: agent/helper",
      "agent-skills: 1 mcp ingredient(s) have no Agent Skills equivalent — skipped: mcp/api",
    ]));
  });
});
