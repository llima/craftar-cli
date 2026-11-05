import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import config from "../vitest.config.js";
import { CLI_SPAWN_TIMEOUT } from "./helpers/cli.js";
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

  it("adds no action and reads no secret", () => {
    const steps = job.steps as { uses?: string }[];
    const allowed = ["actions/checkout@v4", "actions/setup-node@v4"];
    for (const step of steps) {
      if (step.uses) expect(allowed).toContain(step.uses);
    }
    const raw = readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8");
    expect(raw).not.toContain("secrets.");
  });

  it("never cancels or shortens the release gate", () => {
    expect(ci.concurrency["cancel-in-progress"]).toBe("${{ github.ref != 'refs/heads/main' }}");
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
    expect(config.test?.maxWorkers).toBe(win ? 4 : 6);
    expect(WIN32_TEST_TIMEOUT).toBe(180000);
    // Verify the config source has the platform-aware maxWorkers
    const vitestConfig = readFileSync(path.join(REPO, "vitest.config.ts"), "utf8");
    expect(vitestConfig).toContain('maxWorkers: process.platform === "win32" ? 4 : 6');
  });

  it("keeps runCli's spawn limit under the per-test limit on each platform", () => {
    const cliTs = readFileSync(path.join(REPO, "test/helpers/cli.ts"), "utf8");
    const reportPins = readFileSync(path.join(REPO, "test/report-pins.test.ts"), "utf8");
    // Verify constant value and that it is below the test timeout
    expect(CLI_SPAWN_TIMEOUT).toBe(win ? 170000 : 25000);
    expect(CLI_SPAWN_TIMEOUT).toBeLessThan(config.test?.testTimeout ?? 0);
    // Verify both files use the constant
    expect(cliTs).toContain("timeout: CLI_SPAWN_TIMEOUT");
    expect(reportPins).toContain("timeout: CLI_SPAWN_TIMEOUT");
  });
});


// Values under 30 s are deliberate hang guards and are allowed; the floor is deliberate.
// A named constant, an exponent literal, arithmetic (60 * 1000), vi.setConfig, a call closed mid-line (}, 60_000); });,
// and a regex literal containing a quote or // can confuse the comment stripper — none of these are scanned.

/** Strip comments outside strings: one linear pass with states code / single / double / template / line / block. */
function stripComments(text: string): string {
  const out: string[] = [];
  type State = "code" | "single" | "double" | "template" | "line" | "block";
  let state: State = "code";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === "code") {
      if (ch === "'" ) { out.push(ch); state = "single"; }
      else if (ch === '"') { out.push(ch); state = "double"; }
      else if (ch === "`") { out.push(ch); state = "template"; }
      else if (ch === "/" && next === "/") { state = "line"; i++; }
      else if (ch === "/" && next === "*") { state = "block"; i++; }
      else { out.push(ch); }
    } else if (state === "single") {
      out.push(ch);
      if (ch === "\\") { out.push(text[++i] ?? ""); }
      else if (ch === "'") { state = "code"; }
    } else if (state === "double") {
      out.push(ch);
      if (ch === "\\") { out.push(text[++i] ?? ""); }
      else if (ch === '"') { state = "code"; }
    } else if (state === "template") {
      out.push(ch);
      if (ch === "\\") { out.push(text[++i] ?? ""); }
      else if (ch === "`") { state = "code"; }
    } else if (state === "line") {
      if (ch === "\n") { out.push(ch); state = "code"; }
    } else if (state === "block") {
      if (ch === "*" && next === "/") { out.push(" "); state = "code"; i++; }
    }
  }
  return out.join("");
}

function shortLimits(text: string): number[] {
  const out: number[] = [];

  // Strip comments outside strings before scanning
  text = stripComments(text);

  // Pattern 1: For each `timeout:` occurrence, extract the value up to `,` or `}` at paren depth 0.
  // For `process.platform === "win32" ? A : B` or `'win32'` ternaries, only read A (the win32 branch).
  const timeoutRegex = /\btimeout:\s*/g;
  let tm;
  while ((tm = timeoutRegex.exec(text)) !== null) {
    let start = tm.index + tm[0].length;
    let depth = 0;
    let end = text.length;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (depth === 0 && (ch === "," || ch === "}")) {
        end = i;
        break;
      }
    }
    const valueText = text.slice(start, end);
    // Skip if contains atLeastWin32(
    if (valueText.includes("atLeastWin32(")) continue;
    // For `process.platform === "win32" ? A : B` or 'win32', only read A (win32 branch)
    const win32Ternary = valueText.match(/process\.platform\s*===\s*["']win32["']\s*\?\s*([\d_]+)\s*:\s*[\d_]+/);
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
  const pattern2 = /,\s*([\d_]+)\s*,?\s*\)\s*[;,]?\s*$/gm;
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
      // Comments before/around timeout (strip first)
      [`{ /* slow */ ${T}: 60_000 }`, [60000]],
      [`// see a/b/\n{ ${T}: 60_000 }`, [60000]],
      [`{ ${T}: 60_000 // matches \\d+\n}`, [60000]],
      [`{ ${T}: 60_000 // see (spec\n}`, [60000]],
      // No terminator (end of text)
      [`{ ${T}: 60_000`, [60000]],
      // Single quotes in platform ternary
      [`{ ${T}: process.platform === 'win32' ? 60_000 : 30_000 }`, [60000]],
      // Strings containing comment-like patterns (must not be stripped)
      ['it("a", () => rule({ paths: ["src/**/x", "docs/*.md"] }), 60_000);\n/** next helper */', [60000]],
      ['it("a", () => load("file:///tmp/f"), 60_000);', [60000]],
      ['it("a", () => norm("//x"), 60_000);', [60000]],
      ["it(\"a\", () => s.split('/*'), 60_000);", [60000]],
      ['it("a", () => `a//b${x}`, 60_000);', [60000]],
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
