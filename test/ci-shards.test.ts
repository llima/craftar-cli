import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import config from "../vitest.config.js";
import { WIN32_TEST_TIMEOUT } from "./helpers/timeouts.js";

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
    expect(config.test?.testTimeout).toBe(win ? 180000 : 30000);
    expect(config.test?.maxWorkers).toBe(6);
    expect(WIN32_TEST_TIMEOUT).toBe(180000);
  });

  it("keeps runCli's spawn limit under the per-test limit on each platform", () => {
    const cliTs = readFileSync(path.join(REPO, "test/helpers/cli.ts"), "utf8");
    // Parse the two numbers from CLI_SPAWN_TIMEOUT constant
    const match = cliTs.match(/export const CLI_SPAWN_TIMEOUT = process\.platform === "win32" \? (\d+)_000 : (\d+)_000/);
    expect(match).not.toBeNull();
    const winTimeout = Number(match![1]) * 1000;
    const otherTimeout = Number(match![2]) * 1000;
    expect(winTimeout).toBe(170000);
    expect(otherTimeout).toBe(25000);
    const spawnTimeout = win ? winTimeout : otherTimeout;
    const testTimeout = config.test?.testTimeout ?? 0;
    expect(spawnTimeout).toBeLessThan(testTimeout);
    // Verify cli.ts uses the constant
    expect(cliTs).toContain("timeout: CLI_SPAWN_TIMEOUT");
    // Verify report-pins.test.ts uses the constant
    const reportPins = readFileSync(path.join(REPO, "test/report-pins.test.ts"), "utf8");
    expect(reportPins).toContain("timeout: CLI_SPAWN_TIMEOUT");
  });
});


describe("Windows runner sampler", () => {
  /** Returns lines in Invoke-Sample that match `$row += (not '')` but lack `# col:`. */
  function unlabelled(script: string): string[] {
    const invokeSampleMatch = script.match(/function Invoke-Sample \{[\s\S]*?^\}/m);
    if (!invokeSampleMatch) return [];
    const body = invokeSampleMatch[0];
    const lines: string[] = [];
    for (const line of body.split("\n")) {
      if (/\$row \+= (?!'')/.test(line) && !line.includes("# col:")) {
        lines.push(line.trim());
      }
    }
    return lines;
  }

  it("writes each column in the header's order", () => {
    const script = readFileSync(path.join(REPO, ".github/scripts/ci-sampler.ps1"), "utf8");
    const invokeSampleMatch = script.match(/function Invoke-Sample \{[\s\S]*?^\}/m);
    expect(invokeSampleMatch).not.toBeNull();
    const invokeSampleBody = invokeSampleMatch![0];
    const colComments: string[] = [];
    const regex = /\$row \+= (?!'')[^\n]*# col: (\w+)/g;
    let match;
    while ((match = regex.exec(invokeSampleBody)) !== null) {
      colComments.push(match[1]);
    }
    const headerLine = script.split("\n").find((l) => l.includes("$header = 'time,"));
    expect(headerLine).toBeDefined();
    const header = headerLine!.match(/'([^']+)'/)?.[1].split(",") ?? [];
    expect(colComments).toEqual(header);
  });

  it("labels every $row += line with # col:", () => {
    const script = readFileSync(path.join(REPO, ".github/scripts/ci-sampler.ps1"), "utf8");
    // Real script: every line should be labelled
    expect(unlabelled(script)).toEqual([]);
    // Mutated copy: removing one comment should show the offending line
    const mutated = script.replace("# col: node", "");
    expect(unlabelled(mutated)).toEqual(["try { $row += @(Get-Process -Name 'node' -ErrorAction SilentlyContinue).Count } catch { $row += '' }"]);
  });

  it("never assigns PowerShell's automatic $PID", () => {
    const script = readFileSync(path.join(REPO, ".github/scripts/ci-sampler.ps1"), "utf8");
    expect(script).not.toMatch(/\$pid\s*=/i);
  });

  it("reads each summary column at its header index", () => {
    const script = readFileSync(path.join(REPO, ".github/scripts/ci-sampler.ps1"), "utf8");
    const headerLine = script.split("\n").find((l) => l.includes("$header = 'time,"));
    expect(headerLine).toBeDefined();
    const header = headerLine!.match(/'([^']+)'/)?.[1].split(",") ?? [];
    const cols = ["cpu_pct", "proc_queue", "avail_mb", "commit_pct", "pages_per_s", "pagefile_mb", "disk_queue", "disk_busy_pct", "node", "git"];
    for (const name of cols) {
      const idx = header.indexOf(name);
      const pattern = new RegExp(`^\\s*${name} = if \\(\\$cols\\[${idx}\\]\\)`, "m");
      expect(script).toMatch(pattern);
    }
  });

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
    expect(script).toMatch(/^[\x00-\x7f]*$/);
    expect(script).toContain("'start'");
    expect(script).toContain("'sample'");
    expect(script).toContain("'report'");
    expect(script).toContain("Start-Process");
    expect(script).toContain("Stop-Process");
    expect(script).toContain("time,cpu_pct,proc_queue,avail_mb,commit_pct,pages_per_s,pagefile_mb,disk_queue,disk_busy_pct,node,git,msmpeng_cpu_s");
    expect(script).toContain("sampler: rows=");
  });

  it("never cancels or shortens the release gate", () => {
    expect(ci.concurrency["cancel-in-progress"]).toBe("${{ github.ref != 'refs/heads/main' }}");
    expect(job["timeout-minutes"]).toBe(35);
  });
});

// Values under 30 s are deliberate hang guards and are allowed; the floor is deliberate.
// A named constant, an exponent literal, and vi.setConfig is not scanned.
function shortLimits(text: string): number[] {
  const out: number[] = [];

  // Pattern 1: For each `timeout:` occurrence, extract the value up to `,` or `}` at paren depth 0,
  // strip block comments, skip if it contains `atLeastWin32(` or looks like a regex, then collect literals.
  // For `process.platform === "win32" ? A : B` ternaries, only read A (the win32 branch).
  const timeoutRegex = /\btimeout:\s*/g;
  let tm;
  while ((tm = timeoutRegex.exec(text)) !== null) {
    // Skip if inside a regex literal (preceded by / after removing whitespace)
    let beforeIdx = tm.index - 1;
    while (beforeIdx >= 0 && /\s/.test(text[beforeIdx])) beforeIdx--;
    if (beforeIdx >= 0 && text[beforeIdx] === "/") continue;

    let start = tm.index + tm[0].length;
    let depth = 0;
    let end = start;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (depth === 0 && (ch === "," || ch === "}")) {
        end = i;
        break;
      }
    }
    let valueText = text.slice(start, end);
    // Strip block comments
    valueText = valueText.replace(/\/\*.*?\*\//g, "");
    // Skip if contains atLeastWin32( or looks like regex patterns
    if (valueText.includes("atLeastWin32(") || /\\[dD?+*]/.test(valueText)) continue;
    // For `process.platform === "win32" ? A : B`, only read A (win32 branch)
    const win32Ternary = valueText.match(/process\.platform\s*===\s*"win32"\s*\?\s*([\d_]+)\s*:\s*[\d_]+/);
    if (win32Ternary) {
      const v = Number(win32Ternary[1].replace(/_/g, ""));
      if (v >= 30000 && v < WIN32_TEST_TIMEOUT) out.push(v);
      continue;
    }
    // Collect all whole-number literals (any other ternary reads every literal)
    const numRegex = /\b\d[\d_]*\b/g;
    let nm;
    while ((nm = numRegex.exec(valueText)) !== null) {
      const v = Number(nm[0].replace(/_/g, ""));
      if (v >= 30000 && v < WIN32_TEST_TIMEOUT) out.push(v);
    }
  }

  // Pattern 2: a numeric last argument closing a call, allowing:
  // - optional trailing comma before )
  // - number on its own line
  // - ) followed by ; or ,
  // - trailing // or /* */ comment
  const pattern2 = /,\s*([\d_]+)\s*,?\s*\)\s*[;,]?\s*(?:\/\/[^\n]*|\/\*.*?\*\/)?\s*$/gm;
  let m;
  while ((m = pattern2.exec(text)) !== null) {
    const v = Number(m[1].replace(/_/g, ""));
    if (v >= 30000 && v < WIN32_TEST_TIMEOUT) out.push(v);
  }
  return out;
}

describe("per-test limits", () => {
  it("the limit scan catches each form it claims", () => {
    // Use string concatenation to prevent the scanner from matching these test strings
    const T = "timeout";
    const cases: [string, number[]][] = [
      [`it("a", { ${T}: 60000 }, async () => {`, [60000]],
      [`it("a", { ${T}: 60_000, retry: 1 }, async () => {`, [60000]],
      [`it("a", {\n  ${T}: 60_000,\n}, async () => {`, [60000]],
      [`it("a", { retry: 1, ${T}: 60_000 }, async () => {`, [60000]],
      ['it("a", () => run(), 90_000)', [90000]],
      ['it("a", body, 90_000);', [90000]],
      ['  }, 120_000);', [120000]],
      ['}, 120_000)', [120000]],
      [`describe("a", { ${T}: 100000 }, () => {`, [100000]],
      [`it("a", { ${T}: 5000 }, async () => {`, []],
      [`it("a", { ${T}: atLeastWin32(60_000) }, async () => {`, []],
      [`it("a", { ${T}: 180_000 }, async () => {`, []],
      ['const x = { size: 60000 };', []],
      // Platform ternary: only read win32 branch
      [`{ ${T}: process.platform === "win32" ? 60_000 : 30_000 }`, [60000]],
      [`{ ${T}: process.platform === "win32" ? 180_000 : 30_000 }`, []],
      // Non-win32 ternary: reads every literal
      [`{ ${T}: isWin ? 60_000 : 30_000 }`, [60000, 30000]],
      // Comments and trailing commas
      ['}, 60_000)' + '; // slow', [60000]],
      ['},\n  60_000' + ',\n);', [60000]],
      ['}, 60_000)' + ',', [60000]],
      [`{ ${T}: 60_000 /* win */ }`, [60000]],
    ];
    for (const [input, expected] of cases) {
      expect(shortLimits(input), `input: ${JSON.stringify(input)}`).toEqual(expected);
    }
  });

  it("no explicit timeout cuts a test below 180 s on Windows", () => {
    const testDir = path.join(REPO, "test");
    const testFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".test.ts")) testFiles.push(full);
      }
    };
    walk(testDir);

    const bad: string[] = [];
    for (const file of testFiles) {
      const content = readFileSync(file, "utf8");
      const rel = path.relative(REPO, file);
      for (const v of shortLimits(content)) {
        bad.push(`${rel}:${v}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
