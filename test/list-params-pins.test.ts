import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCli } from "./helpers/cli.js";
import { acmeLists, type Scenario } from "./helpers/list-params.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { FORGE_SCHEMA_SECTION_FILES } from "../src/schema/index.js";

/**
 * Spec 55 §9 (Part A): pin what a Forge that declares no `type: list` gets today, BEFORE any source change of Part A, so the
 * build can prove it changes nothing below the gate. The Forge sits at the highest schema craftar reads today, below the
 * list-params gate; its profile gives two YAML lists and its rule cites them unfiltered and with every filter, beside Angular
 * pipes — every filtered form is left as written and a list renders as its items joined by ",".
 */

const PIN_FILE = path.resolve(__dirname, "pins/list-params-off.json");

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

  // Create an empty temp directory so docker is never found — avoids docker-related checks in doctor
  const emptyDir = path.join(wsRoot, ".craftar-test-no-docker");
  await fs.mkdir(emptyDir, { recursive: true });
  const noDocker = { PATH: emptyDir, Path: emptyDir };

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
  const doctorResult = runCli(["doctor", "--strict", "--json", ...W], { env: noDocker });
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
  return JSON.parse(await fs.readFile(PIN_FILE, "utf8"));
}

describe("list-params=off baseline pin (spec 55 §9)", () => {
  it("a Forge that declares no type: list is unchanged below the gate", async () => {
    const s = kept(await acmeLists({ schema: FORGE_SCHEMA_SECTION_FILES }));
    const observed = await buildObserved(s);
    if (process.env.REGEN_PINS === "1") {
      await fs.mkdir(path.dirname(PIN_FILE), { recursive: true });
      await fs.writeFile(PIN_FILE, JSON.stringify(observed, null, 2) + "\n");
      return;
    }
    expect(observed).toEqual(await loadPin());
  });
});
