import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";

const REPO = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

describe("CI contract", () => {
  const ci = YAML.parse(read(".github/workflows/ci.yml"));
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));

  it("tests on Linux and Windows — the CRLF lesson lives on Windows", () => {
    expect(ci.jobs.test.strategy.matrix.os).toEqual(["ubuntu-latest", "windows-latest"]);
  });

  it("tests the engines floor and the current Node, and declares nothing older", () => {
    expect(ci.jobs.test.strategy.matrix.node).toEqual([22, 24]);
    expect(pkg.engines.node).toBe(">=22");
    expect(lock.packages[""].engines.node).toBe(">=22");
  });

  it("runs install, typecheck, build and test", () => {
    const runs = ci.jobs.test.steps.map((s: { run?: string }) => s.run).filter(Boolean);
    expect(runs).toEqual(expect.arrayContaining(["npm ci", "npm run typecheck", "npm run build", "npm test"]));
  });

  it("is read-only", () => {
    expect(ci.permissions).toEqual({ contents: "read" });
  });

  it("bounds the job so a hang doesn't burn the runner", () => {
    expect(ci.jobs.test["timeout-minutes"]).toBe(15);
  });
});

describe("package publish metadata", () => {
  const pkg = JSON.parse(read("package.json"));

  it("builds before every publish, in CI or by hand", () => {
    expect(pkg.scripts.prepublishOnly).toBe("npm run build");
  });

  it("points npm and provenance at the public repository", () => {
    expect(pkg.repository).toEqual({ type: "git", url: "git+https://github.com/llima/craftar-cli.git" });
    expect(pkg.homepage).toBe("https://craftar.dev");
    expect(pkg.bugs).toEqual({ url: "https://github.com/llima/craftar-cli/issues" });
  });
});

describe("release contract", () => {
  type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
  type Job = { steps: Step[]; [key: string]: unknown };
  const raw = read(".github/workflows/release.yml");
  const release = YAML.parse(raw) as { on: unknown; permissions: unknown; jobs: Record<string, Job> };
  const ci = YAML.parse(read(".github/workflows/ci.yml"));
  const HEAD_SHA = "${{ github.event.workflow_run.head_sha }}";
  const steps = (job: string) => release.jobs[job].steps;

  it("runs only after ci completes on main", () => {
    expect(release.on).toEqual({ workflow_run: { workflows: ["ci"], types: ["completed"], branches: ["main"] } });
    expect(ci.name).toBe("ci");
  });

  it("grants nothing at workflow level", () => {
    expect(release.permissions).toEqual({});
  });

  it("checks read-only, and only for a successful push run", () => {
    const check = release.jobs.check;
    expect(check.permissions).toEqual({ contents: "read" });
    expect(check.if).toBe(
      "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push'",
    );
    expect(check["timeout-minutes"]).toBe(10);
  });

  it("has exactly the check and publish jobs", () => {
    expect(Object.keys(release.jobs)).toEqual(["check", "publish"]);
  });

  it("publishes behind the npm environment with exactly the OIDC and release permissions", () => {
    const publish = release.jobs.publish;
    expect(publish.needs).toBe("check");
    expect(publish.if).toBe("needs.check.outputs.publish == 'true'");
    expect(publish.environment).toBe("npm");
    expect(publish.permissions).toEqual({ contents: "write", "id-token": "write" });
    expect(publish["timeout-minutes"]).toBe(15);
  });

  it("checks out the commit ci tested, never the tip of main", () => {
    for (const job of ["check", "publish"]) {
      const checkouts = steps(job).filter((s) => s.uses?.startsWith("actions/checkout@"));
      expect(checkouts.length, job).toBeGreaterThan(0);
      for (const s of checkouts) expect(s.with?.ref, job).toBe(HEAD_SHA);
    }
  });

  it("uses Node 24 and publishes with provenance, without a stored token", () => {
    for (const job of ["check", "publish"]) {
      const setups = steps(job).filter((s) => s.uses?.startsWith("actions/setup-node@"));
      expect(setups.map((s) => String(s.with?.["node-version"])), job).toEqual(["24"]);
    }
    const runs = steps("publish").map((s) => s.run ?? "");
    expect(runs.some((r) => r.includes("npm publish --provenance"))).toBe(true);
    expect(raw).not.toMatch(/NODE_AUTH_TOKEN|secrets\./);
  });

  it("installs without dependency scripts, before the publish step", () => {
    for (const job of ["check", "publish"]) {
      const installs = steps(job).map((s) => s.run ?? "").filter((r) => /\bnpm ci\b/.test(r));
      expect(installs.length, job).toBeGreaterThan(0);
      for (const r of installs) expect(r, job).toBe("npm ci --ignore-scripts");
    }
    const runs = steps("publish").map((s) => s.run ?? "");
    const install = runs.indexOf("npm ci --ignore-scripts");
    const publish = runs.findIndex((r) => r.includes("npm publish --provenance"));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(publish).toBeGreaterThan(install);
  });

  it("pins every action to a full commit SHA", () => {
    const uses = Object.values(release.jobs).flatMap((j) => j.steps).map((s) => s.uses).filter((u): u is string => Boolean(u));
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });
});

// GitHub runs `shell: bash` steps as `bash --noprofile --norc -eo pipefail {0}`. Skipped on
// Windows, where `bash` on PATH may resolve to WSL instead of the runner's shell.
describe.skipIf(process.platform === "win32")("release step scripts under bash -e", () => {
  type Stub = { command: "npm" | "git"; stdout?: string; stderr?: string; code: number };
  type Run = { status: number | null; output: string; githubOutput: string };
  const release = YAML.parse(read(".github/workflows/release.yml")) as {
    jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
  };
  const dirs: string[] = [];
  const STUB = [
    "#!/bin/sh",
    'if [ -n "$STUB_STDOUT" ]; then printf \'%s\\n\' "$STUB_STDOUT"; fi',
    'if [ -n "$STUB_STDERR" ]; then printf \'%s\\n\' "$STUB_STDERR" >&2; fi',
    'exit "$STUB_CODE"',
    "",
  ].join("\n");

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const runStep = (job: string, name: string, stub: Stub): Run => {
    const script = release.jobs[job].steps.find((s) => s.name === name)?.run;
    if (!script) throw new Error(`no run script for step "${name}" in job ${job}`);
    const dir = mkdtempSync(path.join(tmpdir(), "craftar-release-step-"));
    dirs.push(dir);
    const bin = path.join(dir, "bin");
    const tmp = path.join(dir, "tmp");
    mkdirSync(bin);
    mkdirSync(tmp);
    const file = path.join(dir, "step.sh");
    const githubOutput = path.join(dir, "github-output");
    const summary = path.join(dir, "step-summary");
    writeFileSync(file, script);
    writeFileSync(githubOutput, "");
    writeFileSync(summary, "");
    writeFileSync(path.join(bin, stub.command), STUB, { mode: 0o755 });
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", file], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TMPDIR: tmp,
        VERSION: "0.0.9",
        GITHUB_OUTPUT: githubOutput,
        GITHUB_STEP_SUMMARY: summary,
        STUB_STDOUT: stub.stdout ?? "",
        STUB_STDERR: stub.stderr ?? "",
        STUB_CODE: String(stub.code),
      },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}`, githubOutput: readFileSync(githubOutput, "utf8") };
  };

  const REGISTRY = "Is this version already on npm?";
  const TAG = "Tag is free";

  it("registry: a published version, even with an npm warning, sets publish=false", () => {
    const r = runStep("check", REGISTRY, { command: "npm", stdout: "0.0.9", stderr: "npm warn config something", code: 0 });
    expect(r.status, r.output).toBe(0);
    expect(r.githubOutput).toContain("publish=false");
  });

  it("registry: E404 sets publish=true", () => {
    const r = runStep("check", REGISTRY, { command: "npm", stderr: "npm error code E404", code: 1 });
    expect(r.status, r.output).toBe(0);
    expect(r.githubOutput).toContain("publish=true");
  });

  it("registry: any other npm error fails without deciding", () => {
    const r = runStep("check", REGISTRY, { command: "npm", stderr: "npm error code ETIMEDOUT", code: 1 });
    expect(r.status).not.toBe(0);
    expect(r.githubOutput).not.toMatch(/publish=/);
  });

  it("tag: an absent tag (git exit 2) passes", () => {
    const r = runStep("check", TAG, { command: "git", code: 2 });
    expect(r.status, r.output).toBe(0);
  });

  it("tag: an existing tag fails", () => {
    const r = runStep("check", TAG, { command: "git", code: 0 });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("exists");
  });

  it("tag: a git failure fails with its exit code", () => {
    const r = runStep("check", TAG, { command: "git", code: 128 });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("128");
  });
});
