import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import config from "../vitest.config.js";

// The Windows half of the CI matrix runs the suite in two shards per Node version (tech-debt E23.2, E23.3): the suite
// there took 18–30 min of a 35 min limit. Ubuntu runs it whole. This file only reads files, so it can run by hand,
// unlike test/ci.test.ts.
const REPO = path.resolve(__dirname, "..");
const ci = YAML.parse(readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8"));
const job = ci.jobs.test;

type Cell = { os: string; node: number; shard: string };
function cells(): Cell[] {
  const m = job.strategy.matrix;
  const out: Cell[] = [];
  for (const os of m.os) for (const node of m.node) for (const shard of m.shard) {
    const cell = { os, node, shard };
    const excluded = (m.exclude ?? []).some((e: Partial<Cell>) =>
      Object.entries(e).every(([k, v]) => cell[k as keyof Cell] === v));
    if (!excluded) out.push(cell);
  }
  return out;
}

describe("CI shards", () => {
  it("runs Ubuntu whole and Windows in shards 1/2 and 2/2, for each Node version", () => {
    const got = cells().map((c) => `${c.os} ${c.node} ${c.shard}`).sort();
    expect(got).toEqual([
      "ubuntu-latest 22 1/1",
      "ubuntu-latest 24 1/1",
      "windows-latest 22 1/2",
      "windows-latest 22 2/2",
      "windows-latest 24 1/2",
      "windows-latest 24 2/2",
    ]);
  });

  it("hands the shard to vitest through the environment, never interpolated into the script", () => {
    const test = job.steps.find((s: { run?: string }) => s.run?.startsWith("npm test"));
    expect(test.run).toBe("npm test -- --shard=$SHARD");
    expect(test.env).toEqual({ SHARD: "${{ matrix.shard }}" });
    // windows-latest runs a step under pwsh by default, where $SHARD is a PowerShell variable (empty) and vitest
    // refuses --shard= with no value; bash reads it from the environment.
    expect(test.shell).toBe("bash");
  });

  it("names each job with its shard, so the two Windows halves are told apart", () => {
    expect(job.name).toBe("${{ matrix.os }} · node ${{ matrix.node }} · shard ${{ matrix.shard }}");
  });

  it("keeps the job limit at 35 minutes (E23.1)", () => {
    expect(job["timeout-minutes"]).toBe(35);
  });
});

describe("vitest limits", () => {
  const win = process.platform === "win32";

  it("gives a hook 30 s on Windows, where three retrying removals can pass the 10 s default (E26.5)", () => {
    expect(config.test?.hookTimeout).toBe(win ? 30000 : 10000);
  });

  it("keeps the per-test limit and the worker cap", () => {
    expect(config.test?.testTimeout).toBe(win ? 60000 : 30000);
    expect(config.test?.maxWorkers).toBe(6);
  });
});


describe("Windows runner sampler", () => {
  it("starts the sampler right before the suite and reports right after it, on Windows only", () => {
    const steps = job.steps as { name?: string; shell?: string; if?: string; run?: string }[];
    const npmTestIdx = steps.findIndex((s) => s.run?.startsWith("npm test"));
    const startIdx = steps.findIndex((s) => s.name === "Start the runner sampler (Windows)");
    const reportIdx = steps.findIndex((s) => s.name === "Runner samples (Windows)");

    expect(startIdx).toBe(npmTestIdx - 1);
    expect(reportIdx).toBe(npmTestIdx + 1);

    const start = steps[startIdx];
    const report = steps[reportIdx];

    expect(start.shell).toBe("pwsh");
    expect(start.if).toBe("runner.os == 'Windows'");
    expect(start.run).toBe("./.github/scripts/ci-sampler.ps1 -Mode start");

    expect(report.shell).toBe("pwsh");
    expect(report.if).toBe("always() && runner.os == 'Windows'");
    expect(report.run).toBe("./.github/scripts/ci-sampler.ps1 -Mode report");
  });

  it("adds no action and reads no secret", () => {
    const steps = job.steps as { uses?: string }[];
    const allowed = ["actions/checkout@v4", "actions/setup-node@v4"];
    for (const step of steps) {
      if (step.uses) expect(allowed).toContain(step.uses);
    }
    const raw = readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8");
    expect(raw).not.toContain("secrets.");
  });

  it("the sampler script exists, is ASCII, and has the three modes", () => {
    const script = readFileSync(path.join(REPO, ".github/scripts/ci-sampler.ps1"), "utf8");
    for (let i = 0; i < script.length; i++) {
      expect(script.charCodeAt(i)).toBeLessThan(128);
    }
    expect(script).toContain("'start'");
    expect(script).toContain("'sample'");
    expect(script).toContain("'report'");
    expect(script).toContain("Start-Process");
    expect(script).toContain("Stop-Process");
    expect(script).toContain("time,cpu_pct,proc_queue,avail_mb,commit_pct,pagefile_mb,pages_per_s,disk_queue,disk_busy_pct,node,git,msmpeng_cpu_s");
    expect(script).toContain("sampler: rows=");
  });

  it("never cancels or shortens the release gate", () => {
    expect(ci.concurrency["cancel-in-progress"]).toBe("${{ github.ref != 'refs/heads/main' }}");
    expect(job["timeout-minutes"]).toBe(35);
  });
});
