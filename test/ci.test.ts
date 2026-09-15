import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
  type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
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
    expect(check.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(check.if).toContain("github.event.workflow_run.event == 'push'");
    expect(check["timeout-minutes"]).toBe(10);
  });

  it("publishes behind the npm environment with exactly the OIDC and release permissions", () => {
    const publish = release.jobs.publish;
    expect(publish.needs).toBe("check");
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
    expect(runs).toContain("npm ci");
    expect(runs.some((r) => r.includes("npm publish --provenance"))).toBe(true);
    expect(raw).not.toMatch(/NODE_AUTH_TOKEN|secrets\./);
  });

  it("pins every action to a full commit SHA", () => {
    const uses = Object.values(release.jobs).flatMap((j) => j.steps).map((s) => s.uses).filter((u): u is string => Boolean(u));
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });
});
