import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCli } from "./helpers/cli.js";
import { acmeIndex } from "./helpers/rules-index.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import type { Scenario } from "./helpers/forge.js";

/**
 * Spec 44 §11.1: pin what a workspace that does not use `{{craftar.rules.index}}` gets today,
 * BEFORE any source change, so a later change can prove it changes nothing for it.
 */

const PIN_FILE = path.resolve(__dirname, "pins/rules-index-off.json");

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

/**
 * Recursively normalize a value, replacing any occurrence of the scenario's temp root
 * (both raw path and realpath, with `/` and `\` separators) with `<root>`, and
 * normalizing time-dependent lock messages.
 */
function normalize(value: unknown, roots: string[]): unknown {
  if (typeof value === "string") {
    let s = value;
    for (const r of roots) {
      // Replace both slash styles
      s = s.split(r).join("<root>");
      s = s.split(r.replace(/\\/g, "/")).join("<root>");
      s = s.split(r.replace(/\//g, "\\")).join("<root>");
    }
    // Normalize lock check message: "schema 2, generated 2026-10-23 23:13 UTC" -> "schema 2, generated <timestamp>"
    s = s.replace(/^(schema \d+, generated )\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/, "$1<timestamp>");
    return s;
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalize(v, roots));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalize(v, roots);
    }
    return out;
  }
  return value;
}

interface Observed {
  planned: Record<string, string>;
  planWarnings: string[];
  freshStatus: unknown;
  freshExit: { syncCheck: number | null; status: number | null; diffExitCode: number | null };
  lock: unknown;
  syncedStatus: unknown;
  syncedExit: { syncCheck: number | null; status: number | null; diffExitCode: number | null; doctorStrict: number | null };
  doctorWorkspace: Array<{ id: string; level: string; message: string; fix: string | null }>;
}

async function buildObserved(s: Scenario): Promise<Observed> {
  const wsRoot = s.wsRoot;
  const W = ["--workspace", wsRoot];

  // Get both raw and realpath versions of the root
  const realRoot = await fs.realpath(s.root);
  const roots = [s.root, realRoot];

  // Compute plan
  const ws = await loadWorkspace(wsRoot, { home: process.env.CRAFTAR_HOME });
  const p = await plan(ws);

  // planned: { [path]: utf8 content } sorted by path
  const planned: Record<string, string> = {};
  const sortedPaths = [...p.files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sortedPaths) {
    planned[f.path] = f.content.toString("utf8");
  }

  // planWarnings
  const planWarnings = p.warnings;

  // freshStatus: status --json BEFORE any sync
  const freshStatusResult = runCli(["status", "--json", ...W]);
  const freshStatus = JSON.parse(freshStatusResult.stdout);

  // freshExit: exit codes before any sync
  const freshExit = {
    syncCheck: runCli(["sync", "--check", ...W]).code,
    status: freshStatusResult.code,
    diffExitCode: runCli(["diff", "--exit-code", ...W]).code,
  };

  // Run sync
  const syncResult = runCli(["sync", ...W]);
  if (syncResult.code !== 0) {
    throw new Error(`sync failed: ${syncResult.stderr}`);
  }

  // lock: craftar.lock after sync, with generatedAt deleted
  const lockText = await fs.readFile(path.join(wsRoot, "craftar.lock"), "utf8");
  const lock = JSON.parse(lockText);
  delete lock.generatedAt;

  // syncedStatus: status --json after sync
  const syncedStatusResult = runCli(["status", "--json", ...W]);
  const syncedStatus = JSON.parse(syncedStatusResult.stdout);

  // syncedExit: exit codes after sync
  const doctorResult = runCli(["doctor", "--strict", "--json", ...W]);
  const syncedExit = {
    syncCheck: runCli(["sync", "--check", ...W]).code,
    status: syncedStatusResult.code,
    diffExitCode: runCli(["diff", "--exit-code", ...W]).code,
    doctorStrict: doctorResult.code,
  };

  // doctorWorkspace: from doctor --strict --json, filtered to scope === "workspace"
  const doctorJson = JSON.parse(doctorResult.stdout);
  const doctorWorkspace = (doctorJson.checks as Array<{ id: string; scope: string; level: string; message: string; fix: string | null }>)
    .filter((c) => c.scope === "workspace")
    .map((c) => ({ id: c.id, level: c.level, message: c.message, fix: c.fix }));

  const observed: Observed = {
    planned,
    planWarnings,
    freshStatus,
    freshExit,
    lock,
    syncedStatus,
    syncedExit,
    doctorWorkspace,
  };

  return normalize(observed, roots) as Observed;
}

/** Load the pinned baseline for comparison. */
async function loadPin(): Promise<Observed> {
  const pinText = await fs.readFile(PIN_FILE, "utf8");
  return JSON.parse(pinText);
}

describe("rules-index=off baseline pin", () => {
  it("a Forge with neither the placeholder nor a craftar. key is unchanged at schema 6", async () => {
    const s = kept(await acmeIndex({ schema: 6 }));
    const observed = await buildObserved(s);

    if (process.env.REGEN_PINS === "1") {
      // Write mode: generate the pin file
      await fs.mkdir(path.dirname(PIN_FILE), { recursive: true });
      await fs.writeFile(PIN_FILE, JSON.stringify(observed, null, 2) + "\n");
      console.log(`Pin written to ${PIN_FILE}`);
      return;
    }

    // Compare mode: load the pin and compare
    const expected = await loadPin();
    expect(observed).toEqual(expected);
  });

  it.todo("a Forge with neither the placeholder nor a craftar. key is unchanged at schema 7");
});
