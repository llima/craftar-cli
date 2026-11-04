import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { runDoctor } from "../src/core/doctor.js";
import { acmePrimary } from "./helpers/agents-md-primary.js";
import type { IngredientSpec, Scenario } from "./helpers/forge.js";

// Tech-debt E27.5 (a hand-written Kiro resource spelled with `\`) and E27.8 (decision 16: a resource naming a manual
// steering file the plan writes, which Kiro does not load through resources — measured with kiro-cli 2.29.1, spec 41 §18.2).
// Both under agents-md.primary, where the resources check lives (spec 41 §4.5–§4.6).

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const extra: IngredientSpec[] = [
  { meta: { type: "rule", name: "notes", inclusion: "manual" }, files: { "rule.md": "# Notes\nOn request.\n" } },
  {
    meta: {
      type: "agent",
      name: "scout",
      resources: [
        "file://.kiro\\steering\\gone.md",
        "file://.kiro\\steering\\notes.md",
        "file://.kiro/steering/commands/review.md",
        "file://.kiro/steering/api.md",
      ],
    },
    files: { "agent.md": "Scout.\n" },
  },
];

async function planned(primary: boolean) {
  const s: Scenario = await acmePrimary({ schema: 5, params: primary ? { "agents-md.primary": true } : {}, extraIngredients: extra });
  cleanups.push(s.cleanup);
  const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
  return { s, p: await plan(ws) };
}

const scout = (rows: Array<{ agent: string; path: string }>) => rows.filter((r) => r.agent === "scout");

describe("Kiro resources: backslash spelling and manual steering (E27.5, E27.8)", () => {
  it("a resource spelled with backslashes is checked as the path it names (E27.5)", async () => {
    const { p } = await planned(true);
    expect(scout(p.kiroResources!.unplanned)).toEqual([{ agent: "scout", path: ".kiro/steering/gone.md" }]);
    expect(scout(p.kiroResources!.present)).toEqual([]);
  });

  it("a planned manual rule and a command are listed as manual, a fileMatch rule is not (E27.8)", async () => {
    const { p } = await planned(true);
    expect(scout(p.kiroResources!.manual)).toEqual([
      { agent: "scout", path: ".kiro/steering/commands/review.md" },
      { agent: "scout", path: ".kiro/steering/notes.md" },
    ]);
    const w = p.warnings.filter((x) => x.startsWith("kiro: agent resources name manual steering files"));
    expect(w).toEqual([
      "kiro: agent resources name manual steering files, which Kiro does not load through resources — scout → .kiro/steering/commands/review.md, scout → .kiro/steering/notes.md",
    ]);
    expect(p.kiroResources!.manualWarning).toBe(w[0]);
  });

  it("doctor's kiro-resources warns once per manual entry and owns the plan's warning", async () => {
    const { s } = await planned(true);
    const r = await runDoctor({ version: "0.0.0", home: process.env.CRAFTAR_HOME!, workspace: s.wsRoot, fetch: false, strict: false, registryOff: true, env: {}, nodeVersion: "22.11.0", gitVersion: async () => "2.53.0" });
    const lines = r.checks.filter((c) => c.id === "kiro-resources" && c.message.includes("manual"));
    expect(lines.map((c) => [c.level, c.message])).toEqual([
      ["warn", "agent scout lists .kiro/steering/commands/review.md, a manual steering file Kiro does not load through resources"],
      ["warn", "agent scout lists .kiro/steering/notes.md, a manual steering file Kiro does not load through resources"],
    ]);
    expect(r.checks.some((c) => c.message.includes("kiro: agent resources name manual steering files"))).toBe(false);
  });

  it("with the mode off nothing is checked or warned", async () => {
    const { p } = await planned(false);
    expect(p.kiroResources).toBeNull();
    expect(p.warnings.filter((x) => x.startsWith("kiro: agent resources"))).toEqual([]);
  });
});
