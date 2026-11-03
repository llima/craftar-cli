import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCli } from "./helpers/cli.js";
import { acmeCopies, acmeHoisted, type Family } from "./helpers/profile-extends.js";
import { loadWorkspace, plan } from "../src/core/sync.js";

/**
 * Spec 54 §9: pin what a Forge below the profile-extends gate gets today, BEFORE any source change, so Part B can prove
 * it changes nothing there — no byte, warning, `--json` value or exit code for the three workspaces, the catalogue or
 * `explain`. Regenerate only with REGEN_PINS=1 against the source the pin was taken from.
 */

const PIN_FILE = path.resolve(__dirname, "pins/profile-extends-off.json");

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = (f: Family): Family => (cleanups.push(f.cleanup), f);

function normalize(value: unknown, roots: string[]): unknown {
  if (typeof value === "string") {
    let s = value;
    for (const r of roots) {
      s = s.split(r).join("<root>");
      s = s.split(r.replace(/\\/g, "/")).join("<root>");
      s = s.split(r.replace(/\//g, "\\")).join("<root>");
    }
    return s.replace(/(schema \d+, generated )\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/g, "$1<timestamp>");
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, roots));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v, roots);
    return out;
  }
  return value;
}

async function observeWorkspace(wsRoot: string, explainPath: string) {
  const W = ["--workspace", wsRoot];
  const p = await plan(await loadWorkspace(wsRoot, { home: process.env.CRAFTAR_HOME }));
  const planned: Record<string, string> = {};
  for (const f of [...p.files].sort((a, b) => a.path.localeCompare(b.path))) planned[f.path] = f.content.toString("utf8");
  const fresh = runCli(["status", "--json", ...W]);
  const synced = runCli(["sync", ...W]);
  if (synced.code !== 0) throw new Error(`sync failed: ${synced.stderr}`);
  const lock = JSON.parse(await fs.readFile(path.join(wsRoot, "craftar.lock"), "utf8"));
  delete lock.generatedAt;
  const explained = runCli(["explain", explainPath, ...W]);
  return {
    planned,
    planWarnings: p.warnings,
    freshStatus: JSON.parse(fresh.stdout),
    freshExit: fresh.code,
    syncStdout: synced.stdout,
    lock,
    checkExit: runCli(["sync", "--check", ...W]).code,
    explain: { code: explained.code, stdout: explained.stdout },
  };
}

async function observe(f: Family) {
  const roots = [f.root, await fs.realpath(f.root)];
  const F = ["--forge", f.forgeRoot];
  const json = (args: string[]) => {
    const r = runCli(args);
    return { code: r.code, json: r.code === 0 ? JSON.parse(r.stdout) : null, stderr: r.code === 0 ? "" : r.stderr };
  };
  return normalize(
    {
      portal: await observeWorkspace(f.ws.portal, ".claude/rules/house.md"),
      shop: await observeWorkspace(f.ws.shop, ".claude/rules/house.md"),
      globex: await observeWorkspace(f.ws.globex, ".claude/rules/style.md"),
      ingredientsGlobex: json(["ingredients", ...F, "--profile", "globex", "--json"]),
      ingredientsForge: json(["ingredients", ...F, "--json"]),
      recipesForge: json(["recipes", ...F, "--json"]),
    },
    roots,
  );
}

describe("profile-extends=off baseline pin (spec 54 §9)", () => {
  it("a client written as two copies, at schema 11 (the highest before this change)", async () => {
    const observed = await observe(kept(await acmeCopies(11)));
    if (process.env.REGEN_PINS === "1") {
      await fs.mkdir(path.dirname(PIN_FILE), { recursive: true });
      await fs.writeFile(PIN_FILE, JSON.stringify(observed, null, 2) + "\n");
      return;
    }
    expect(observed).toEqual(JSON.parse(await fs.readFile(PIN_FILE, "utf8")));
  });

  it("the same Forge at schema 10 gives the same observation", async () => {
    expect(await observe(kept(await acmeCopies(10)))).toEqual(JSON.parse(await fs.readFile(PIN_FILE, "utf8")));
  });

  it("the deliberate delta: a profile holding extends or abstract below the gate now fails the load (spec 54 §5.2)", async () => {
    // Before the change this Forge loaded and the child resolved only its own recipes (recorded in c6f765e).
    const f = kept(await acmeHoisted(11));
    await expect(loadWorkspace(f.ws.portal, { home: process.env.CRAFTAR_HOME })).rejects.toThrow("profiles/acme/profile.yaml: abstract in a profile needs schema: 12");
  });
});
