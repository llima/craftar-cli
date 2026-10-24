import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles } from "../src/core/forge.js";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { acmePrimary } from "./helpers/agents-md-primary.js";
import type { Scenario } from "./helpers/forge.js";

// Spec 41 §11.3: the acme workspace synced under agents-md.primary, byte for byte; regenerated only with
// test/helpers/regen-golden-agents-md-primary.ts.

const GOLDEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "golden/agents-md-primary");
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function synced(): Promise<{ s: Scenario; paths: string[] }> {
  const s = await acmePrimary({ schema: 5, params: { "agents-md.primary": true } });
  cleanups.push(s.cleanup);
  const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
  const p = await plan(ws);
  await apply(ws, p, await status(ws, p, await readLock(ws.root)), {});
  return { s, paths: p.files.map((f) => f.path).sort() };
}

describe("golden — agents-md.primary (spec 41 §11.3)", () => {
  it("a sync writes exactly the golden files, byte for byte", async () => {
    const { s, paths } = await synced();
    expect(paths).toEqual((await listFiles(GOLDEN)).sort());
    for (const rel of paths) expect((await fs.readFile(path.join(s.wsRoot, rel))).equals(await fs.readFile(path.join(GOLDEN, rel))), rel).toBe(true);
  });

  it("no always-on rule with the default targets outside AGENTS.md; AGENTS.md holds style and release", async () => {
    const files = await listFiles(GOLDEN);
    expect(files.filter((f) => f.startsWith(".claude/rules/"))).toEqual([".claude/rules/api.md"]);
    expect(files.filter((f) => f.startsWith(".kiro/steering/") && !f.startsWith(".kiro/steering/commands/")).sort()).toEqual([
      ".kiro/steering/api.md",
      ".kiro/steering/kiro-notes.md",
    ]);
    const agents = await fs.readFile(path.join(GOLDEN, "AGENTS.md"), "utf8");
    expect(agents).toContain("<!-- rule: style -->");
    expect(agents).toContain("<!-- rule: release -->");
  });

  it("no .md or .json text under .claude/ or .kiro/ names a rule file the plan does not write (copied scripts excepted)", async () => {
    const files = await listFiles(GOLDEN);
    const written = new Set(files);
    const ref = /\.(?:claude\/rules|kiro\/steering)\/[A-Za-z0-9._-]+\.md/g;
    const texts = files.filter((f) => /^\.(claude|kiro)\//.test(f) && /\.(md|json)$/.test(f));
    expect(texts.length).toBeGreaterThan(5);
    for (const f of texts) {
      let text = await fs.readFile(path.join(GOLDEN, f), "utf8");
      // A Kiro agent's `resources` are the resources check's (planner's are written by hand to fail it); its text is checked here.
      if (f.startsWith(".kiro/agents/")) {
        const agent = JSON.parse(text) as { description: string; prompt: string };
        text = `${agent.description}\n${agent.prompt}`;
      }
      // The kiro banner names its source as `.claude/rules/<x>.md` and is not resolved (spec 17 §2); the mode does not touch it.
      text = text.replace(/<!-- GENERATED from \S+ by craftar[^>]*-->/g, "");
      for (const m of text.matchAll(ref)) expect(written.has(m[0]), `${f} names ${m[0]}`).toBe(true);
    }
    // The copied scripts keep their reference, by design (spec 41 §4.4).
    expect(await fs.readFile(path.join(GOLDEN, ".claude/scripts/lint.sh"), "utf8")).toContain(".claude/rules/style.md");
  });
});
