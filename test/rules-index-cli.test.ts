import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCli } from "./helpers/cli.js";
import { acmeIndex } from "./helpers/rules-index.js";
import { driftList } from "../src/core/drift.js";
import type { FileStatus } from "../src/core/sync.js";
import { hashNormalized } from "../src/core/text.js";
import type { Scenario } from "./helpers/forge.js";

// Spec 44 §4.5, §4.6: D21 — an indexed file is not promotable.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "craftar-test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "craftar-test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
});
function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "maintenance.auto", "false"]);
  execFileSync("git", ["-C", dir, "config", "gc.auto", "0"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"], { env: gitEnv() });
}
const porcelain = (dir: string) => execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });

const README = ".claude/rules/readme.md";
const D21 = `${README} holds the generated rules index — edit the Forge's rule, or the description of the rule it lists`;

describe("rules-index CLI (spec 44 §4.5–§4.6)", () => {
  it("1. craftar explain prints the index line after sections or via recipes", async () => {
    const s = kept(await acmeIndex({ schema: 7, literal: true }));
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);

    // Run explain on the indexed file
    const r = runCli(["explain", README, "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);

    // The output should contain "index       craftar.rules.index (4 rules)"
    // It should appear after sections (or after "via recipes" if no sections line) and before params
    const lines = r.stdout.split("\n");
    const indexLine = lines.find((l) => l.includes("index") && l.includes("craftar.rules.index"));
    expect(indexLine).toContain("index");
    expect(indexLine).toContain("craftar.rules.index (4 rules)");
  });

  it("2. driftList with indexed gives reason 'holds the rules index'", () => {
    const planned = (p: string, target: "claude-code" | "kiro" | "agents-md", ingredient: string, body: string) => ({ path: p, content: Buffer.from(body), target, ingredient });
    const drift = (p: string, target: "claude-code" | "kiro" | "agents-md", ingredient: string, lockBody: string, planBody: string): FileStatus => ({
      path: p,
      state: "drift",
      target,
      ingredient,
      planned: planned(p, target, ingredient, planBody),
      lock: { path: p, hash: hashNormalized(lockBody), target, ingredient },
    });

    // Hand-edited indexed path
    const indexed = new Set([README]);
    const rows = driftList([drift(README, "claude-code", "rule/readme", "x\n", "x\n")], new Map(), new Set(), indexed);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      path: README,
      promotable: false,
      reason: "holds the rules index",
    });

    // A path both reworded and indexed reads "reworded by agents-md.primary"
    const reworded = new Set([README]);
    const rows2 = driftList([drift(README, "claude-code", "rule/readme", "x\n", "x\n")], new Map(), reworded, indexed);
    expect(rows2[0].reason).toBe("reworded by agents-md.primary");
  });

  it("3. drift promote refuses indexed path with D21, Forge untouched", async () => {
    const s = kept(await acmeIndex({ schema: 7, literal: true }));
    gitInit(s.forgeRoot);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);

    // Hand-edit the indexed file
    await fs.appendFile(path.join(s.wsRoot, README), "Hand edit.\n");

    const r = runCli(["drift", "promote", README, "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(D21);
    expect(porcelain(s.forgeRoot)).toBe("");
  });

  it("4. drift show (text and --json) lists the indexed reason", async () => {
    const s = kept(await acmeIndex({ schema: 7, literal: true }));
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);

    // Hand-edit the indexed file
    await fs.appendFile(path.join(s.wsRoot, README), "Hand edit.\n");

    // Text output
    const r1 = runCli(["drift", "show", "--workspace", s.wsRoot]);
    expect(r1.code).toBe(0);
    expect(r1.stdout).toContain("holds the rules index");

    // JSON output
    const r2 = runCli(["drift", "show", "--json", "--workspace", s.wsRoot]);
    expect(r2.code).toBe(0);
    const json = JSON.parse(r2.stdout);
    const row = json.files.find((f: { path: string }) => f.path === README);
    expect(row).toMatchObject({
      path: README,
      promotable: false,
      reason: "holds the rules index",
    });
  });
});
