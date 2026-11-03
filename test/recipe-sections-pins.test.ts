import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCli } from "./helpers/cli.js";
import { acmeRecipeSections, DEFAULT_EXECUTION } from "./helpers/recipe-sections.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { explainFile } from "../src/core/report.js";

/**
 * Spec 54 §9: pin what a Forge below the recipe-sections gate gets today, BEFORE any source change, so the build can
 * prove Part A changes nothing there — no byte, warning, `--json` value or exit code, and `explain`'s section layer
 * stays the string union. Regenerate only with REGEN_PINS=1 against a source the pin was taken from.
 */

const PIN_FILE = path.resolve(__dirname, "pins/recipe-sections-off.json");

type Scenario = Awaited<ReturnType<typeof acmeRecipeSections>>;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = (s: Scenario): Scenario => (cleanups.push(s.cleanup), s);

function normalize(value: unknown, roots: string[]): unknown {
  if (typeof value === "string") {
    let s = value;
    for (const r of roots) {
      s = s.split(r).join("<root>");
      s = s.split(r.replace(/\\/g, "/")).join("<root>");
      s = s.split(r.replace(/\//g, "\\")).join("<root>");
    }
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, roots));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v, roots);
    return out;
  }
  return value;
}

const OPEN_PR = ".claude/commands/open-pr.md";

async function observe(s: Scenario) {
  const W = ["--workspace", s.wsRoot];
  const roots = [s.root, await fs.realpath(s.root)];
  const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
  const p = await plan(ws);
  const planned: Record<string, string> = {};
  for (const f of [...p.files].sort((a, b) => a.path.localeCompare(b.path))) planned[f.path] = f.content.toString("utf8");
  const fresh = runCli(["status", "--json", ...W]);
  const freshExit = { syncCheck: runCli(["sync", "--check", ...W]).code, status: fresh.code, diffExitCode: runCli(["diff", "--exit-code", ...W]).code };
  const synced = runCli(["sync", ...W]);
  if (synced.code !== 0) throw new Error(`sync failed: ${synced.stderr}`);
  const lock = JSON.parse(await fs.readFile(path.join(s.wsRoot, "craftar.lock"), "utf8"));
  delete lock.generatedAt;
  const explainText = runCli(["explain", OPEN_PR, ...W]);
  const explained = explainFile(ws, p, OPEN_PR);
  return normalize(
    {
      planned,
      planWarnings: p.warnings,
      freshStatus: JSON.parse(fresh.stdout),
      freshExit,
      lock,
      syncedStatus: JSON.parse(runCli(["status", "--json", ...W]).stdout),
      syncedExit: { syncCheck: runCli(["sync", "--check", ...W]).code },
      explainText: { code: explainText.code, stdout: explainText.stdout },
      explainSections: explained?.sections ?? null,
    },
    roots,
  );
}

describe("recipe-sections=off baseline pin (spec 54 §9)", () => {
  it("a profile value and a workspace value below the gate (schema 9)", async () => {
    const s = kept(
      await acmeRecipeSections({
        schema: 9,
        portalSections: { "command/open-pr": { execution: "Run it through Kiro.\n" } },
        overrides: { "command/open-pr": { checklist: "- [ ] lint\n" } },
      }),
    );
    const observed = { profileAndWorkspace: await observe(s) };
    const t = kept(await acmeRecipeSections({ schema: 9, workspaceProfile: "globex" }));
    Object.assign(observed, { defaultsOnly: await observe(t) });

    if (process.env.REGEN_PINS === "1") {
      await fs.mkdir(path.dirname(PIN_FILE), { recursive: true });
      await fs.writeFile(PIN_FILE, JSON.stringify(observed, null, 2) + "\n");
      return;
    }
    expect(observed).toEqual(JSON.parse(await fs.readFile(PIN_FILE, "utf8")));
  });

  it("the deliberate delta, recorded before the change: today a recipe holding sections at schema 9 loads and plans the default", async () => {
    // Spec 54 §4.1 turns this into a load refusal. This case is replaced by that refusal's test when the gate lands.
    const s = kept(await acmeRecipeSections({ schema: 9, kiroSections: { "command/open-pr": { execution: "Run it through Kiro.\n" } } }));
    const p = await plan(await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME }));
    expect(p.files.find((f) => f.path === OPEN_PR)!.content.toString("utf8")).toContain(DEFAULT_EXECUTION);
  });
});
