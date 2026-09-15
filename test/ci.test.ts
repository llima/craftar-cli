import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("supersedes runs on feature branches but never on main, where a cancelled run would skip a release", () => {
    expect(ci.concurrency.group).toBe("ci-${{ github.ref }}");
    expect(ci.concurrency["cancel-in-progress"]).toBe("${{ github.ref != 'refs/heads/main' }}");
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

  it("declares the bin without a ./ prefix, which npm publish strips as invalid", () => {
    expect(pkg.bin).toEqual({ craftar: "bin/craftar.js" });
  });
});

describe("release contract", () => {
  type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
  type Job = { steps: Step[]; [key: string]: unknown };
  const raw = read(".github/workflows/release.yml");
  const release = YAML.parse(raw) as { on: unknown; permissions: unknown; jobs: Record<string, Job> };
  const ciRaw = read(".github/workflows/ci.yml");
  const ci = YAML.parse(ciRaw);
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

  it("tags the commit ci tested, never github.sha at the tip of main", () => {
    const tag = steps("publish").find((s) => s.name === "Tag and release");
    expect(tag?.env?.SHA).toBe(HEAD_SHA);
  });

  it("refuses to publish when the attestation would name another commit than the one ci tested", () => {
    const publish = steps("publish").find((s) => s.name === "Publish");
    expect(publish?.env?.HEAD_SHA).toBe(HEAD_SHA);
    const run = publish?.run ?? "";
    expect(run).toMatch(/GITHUB_SHA/);
    expect(run.indexOf("GITHUB_SHA")).toBeLessThan(run.indexOf("npm publish --provenance"));
  });

  it("keeps publishing out of every other workflow — only release.yml publishes", () => {
    const dir = path.join(REPO, ".github/workflows");
    const others = readdirSync(dir).filter((f) => f !== "release.yml");
    expect(others).toContain("ci.yml");
    for (const f of others) expect(readFileSync(path.join(dir, f), "utf8"), f).not.toMatch(/npm publish|id-token/);
  });

  it("uses Node 24 and publishes with provenance, without a stored token", () => {
    for (const job of ["check", "publish"]) {
      const setups = steps(job).filter((s) => s.uses?.startsWith("actions/setup-node@"));
      expect(setups.map((s) => String(s.with?.["node-version"])), job).toEqual(["24"]);
    }
    const runs = steps("publish").map((s) => s.run ?? "");
    expect(runs.some((r) => r.includes("npm publish --provenance"))).toBe(true);
    expect(raw).not.toMatch(/NODE_AUTH_TOKEN|secrets[.[]/);
  });

  it("turns off setup-node's package-manager cache in both jobs, so no cache reaches the OIDC job", () => {
    for (const job of ["check", "publish"]) {
      const setups = steps(job).filter((s) => s.uses?.startsWith("actions/setup-node@"));
      expect(setups.length, job).toBeGreaterThan(0);
      for (const s of setups) expect(s.with?.["package-manager-cache"], job).toBe(false);
    }
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
  type StubEnv = {
    STUB_NPM_VIEW_STDOUT?: string;
    STUB_NPM_VIEW_STDERR?: string;
    STUB_NPM_VIEW_EXIT?: number;
    STUB_NPM_PUBLISH_EXIT?: number;
    STUB_NPM_VERSION?: string;
    STUB_GH_VIEW_EXIT?: number;
    STUB_GH_CREATE_EXIT?: number;
    STUB_GIT_EXIT?: number;
  };
  type Options = { stubs?: StubEnv; env?: Record<string, string>; cwd?: string };
  type Run = { status: number | null; output: string; githubOutput: string; log: string[] };
  const release = YAML.parse(read(".github/workflows/release.yml")) as {
    jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
  };
  const dirs: string[] = [];
  // Every stub appends its full argument list to $STUB_LOG and answers per subcommand. An
  // unconfigured or unexpected call exits 99, so it can never pass for a deliberate case.
  const STUBS: Record<"npm" | "gh" | "git", string> = {
    npm: [
      "#!/bin/sh",
      'printf \'%s\\n\' "npm $*" >> "$STUB_LOG"',
      'case "$1" in',
      "  view)",
      '    if [ -n "$STUB_NPM_VIEW_STDOUT" ]; then printf \'%s\\n\' "$STUB_NPM_VIEW_STDOUT"; fi',
      '    if [ -n "$STUB_NPM_VIEW_STDERR" ]; then printf \'%s\\n\' "$STUB_NPM_VIEW_STDERR" >&2; fi',
      '    exit "${STUB_NPM_VIEW_EXIT:-99}" ;;',
      '  publish) exit "${STUB_NPM_PUBLISH_EXIT:-99}" ;;',
      '  --version)',
      '    if [ -z "$STUB_NPM_VERSION" ]; then echo "npm stub: no version configured" >&2; exit 99; fi',
      '    printf \'%s\\n\' "$STUB_NPM_VERSION"',
      "    exit 0 ;;",
      "esac",
      'echo "npm stub: unexpected call: $*" >&2',
      "exit 99",
      "",
    ].join("\n"),
    gh: [
      "#!/bin/sh",
      'printf \'%s\\n\' "gh $*" >> "$STUB_LOG"',
      'case "$1 $2" in',
      '  "release view") exit "${STUB_GH_VIEW_EXIT:-99}" ;;',
      '  "release create") exit "${STUB_GH_CREATE_EXIT:-99}" ;;',
      "esac",
      'echo "gh stub: unexpected call: $*" >&2',
      "exit 99",
      "",
    ].join("\n"),
    git: ["#!/bin/sh", 'printf \'%s\\n\' "git $*" >> "$STUB_LOG"', 'exit "${STUB_GIT_EXIT:-99}"', ""].join("\n"),
  };

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const runStep = (job: string, name: string, options: Options = {}): Run => {
    const script = release.jobs[job].steps.find((s) => s.name === name)?.run;
    if (!script) throw new Error(`no run script for step "${name}" in job ${job}`);
    const dir = mkdtempSync(path.join(tmpdir(), "craftar-release-step-"));
    dirs.push(dir);
    const bin = path.join(dir, "bin");
    // A ":" in the stub dir would split PATH and let the real npm, gh or git answer instead.
    if (bin.includes(":")) throw new Error(`stub dir ${bin} cannot be prepended to PATH`);
    const tmp = path.join(dir, "tmp");
    mkdirSync(bin);
    mkdirSync(tmp);
    const file = path.join(dir, "step.sh");
    const githubOutput = path.join(dir, "github-output");
    const summary = path.join(dir, "step-summary");
    const log = path.join(dir, "stub-log");
    writeFileSync(file, script);
    writeFileSync(githubOutput, "");
    writeFileSync(summary, "");
    writeFileSync(log, "");
    for (const [command, body] of Object.entries(STUBS)) writeFileSync(path.join(bin, command), body, { mode: 0o755 });
    const stubEnv = Object.fromEntries(Object.entries(options.stubs ?? {}).map(([key, value]) => [key, String(value)]));
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", file], {
      cwd: options.cwd ?? dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TMPDIR: tmp,
        // Defence in depth: should a real npm ever answer, it has no registry to reach.
        npm_config_registry: "http://127.0.0.1:9/",
        VERSION: "0.0.9",
        GITHUB_OUTPUT: githubOutput,
        GITHUB_STEP_SUMMARY: summary,
        STUB_LOG: log,
        ...options.env,
        ...stubEnv,
      },
    });
    expect(result.error).toBeUndefined();
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      githubOutput: readFileSync(githubOutput, "utf8"),
      log: readFileSync(log, "utf8").split("\n").filter(Boolean),
    };
  };

  // A minimal checkout for the lockstep script: package.json, package-lock.json and src/cli.ts.
  const versionWorkspace = (cliVersion: string): string => {
    const dir = mkdtempSync(path.join(tmpdir(), "craftar-release-version-"));
    dirs.push(dir);
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "craftar", version: "0.0.9" }));
    writeFileSync(
      path.join(dir, "package-lock.json"),
      JSON.stringify({ name: "craftar", version: "0.0.9", packages: { "": { version: "0.0.9" } } }),
    );
    writeFileSync(path.join(dir, "src", "cli.ts"), `program.version("${cliVersion}");\n`);
    return dir;
  };

  const VERSION_FILES = "Version files agree";
  const REGISTRY = "Is this version already on npm?";
  const TAG = "Tag is free";
  const NPM_GATE = "npm supports trusted publishing";
  const PUBLISH = "Publish";
  const RELEASE = "Tag and release";
  const FAKE_SHA = "0123456789abcdef0123456789abcdef01234567";
  const MOVED_SHA = "89abcdef0123456789abcdef0123456789abcdef";
  const RELEASE_ENV = { SHA: FAKE_SHA, GITHUB_REPOSITORY: "llima/craftar-cli", GH_TOKEN: "dummy" };
  // The Publish guard compares GITHUB_SHA with the commit ci tested. The runner exports a
  // GITHUB_SHA of its own, so every publish case sets both variables explicitly.
  const PUBLISH_ENV = { GITHUB_SHA: FAKE_SHA, HEAD_SHA: FAKE_SHA };
  const MOVED_MAIN_ENV = { GITHUB_SHA: MOVED_SHA, HEAD_SHA: FAKE_SHA };
  const publishes = (log: string[]) => log.filter((line) => line.startsWith("npm publish"));
  const creates = (log: string[]) => log.filter((line) => line.startsWith("gh release create"));

  it("version: agreeing version files output the version", () => {
    const r = runStep("check", VERSION_FILES, { cwd: versionWorkspace("0.0.9") });
    expect(r.status, r.output).toBe(0);
    expect(r.githubOutput).toContain("version=0.0.9");
  });

  it("version: a src/cli.ts out of lockstep fails without an output", () => {
    const r = runStep("check", VERSION_FILES, { cwd: versionWorkspace("0.0.8") });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("version files disagree");
    expect(r.githubOutput).not.toMatch(/version=/);
  });

  it("registry: a published version, even with an npm warning, sets publish=false", () => {
    const r = runStep("check", REGISTRY, {
      stubs: { STUB_NPM_VIEW_STDOUT: "0.0.9", STUB_NPM_VIEW_STDERR: "npm warn config something", STUB_NPM_VIEW_EXIT: 0 },
    });
    expect(r.status, r.output).toBe(0);
    expect(r.log).toEqual(["npm view craftar@0.0.9 version"]);
    expect(r.githubOutput).toContain("publish=false");
  });

  it("registry: E404 sets publish=true", () => {
    const r = runStep("check", REGISTRY, { stubs: { STUB_NPM_VIEW_STDERR: "npm error code E404", STUB_NPM_VIEW_EXIT: 1 } });
    expect(r.status, r.output).toBe(0);
    expect(r.githubOutput).toContain("publish=true");
  });

  it("registry: any other npm error fails without deciding", () => {
    const r = runStep("check", REGISTRY, { stubs: { STUB_NPM_VIEW_STDERR: "npm error code ETIMEDOUT", STUB_NPM_VIEW_EXIT: 1 } });
    expect(r.status).not.toBe(0);
    expect(r.log).toEqual(["npm view craftar@0.0.9 version"]);
    expect(r.githubOutput).not.toMatch(/publish=/);
  });

  it("registry: an answer naming another version fails without deciding", () => {
    const r = runStep("check", REGISTRY, { stubs: { STUB_NPM_VIEW_STDOUT: "0.0.8", STUB_NPM_VIEW_EXIT: 0 } });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("unexpected npm view output: 0.0.8");
    expect(r.githubOutput).not.toMatch(/publish=/);
  });

  it("tag: an absent tag (git exit 2) passes", () => {
    const r = runStep("check", TAG, { stubs: { STUB_GIT_EXIT: 2 } });
    expect(r.status, r.output).toBe(0);
    expect(r.log).toEqual(["git ls-remote --exit-code --tags origin refs/tags/v0.0.9"]);
  });

  it("tag: an existing tag fails", () => {
    const r = runStep("check", TAG, { stubs: { STUB_GIT_EXIT: 0 } });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("exists");
  });

  it("tag: a git failure fails with its exit code", () => {
    const r = runStep("check", TAG, { stubs: { STUB_GIT_EXIT: 128 } });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("128");
  });

  it("gate: an npm older than 11.5.1 fails before anything publishes", () => {
    const r = runStep("publish", NPM_GATE, { stubs: { STUB_NPM_VERSION: "11.5.0" } });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("older than 11.5.1");
    expect(publishes(r.log)).toEqual([]);
  });

  it("gate: 11.5.1 and anything newer pass", () => {
    for (const version of ["11.5.1", "12.0.0"]) {
      const r = runStep("publish", NPM_GATE, { stubs: { STUB_NPM_VERSION: version } });
      expect(r.status, `${version}: ${r.output}`).toBe(0);
    }
  });

  it("publish: a version already on npm skips the publish", () => {
    const r = runStep("publish", PUBLISH, { stubs: { STUB_NPM_VIEW_STDOUT: "0.0.9", STUB_NPM_VIEW_EXIT: 0 } });
    expect(r.status, r.output).toBe(0);
    expect(r.log).toContain("npm view craftar@0.0.9 version");
    expect(publishes(r.log)).toEqual([]);
  });

  it("publish: E404 publishes with provenance and public access", () => {
    const r = runStep("publish", PUBLISH, {
      env: PUBLISH_ENV,
      stubs: { STUB_NPM_VIEW_STDERR: "npm error code E404", STUB_NPM_VIEW_EXIT: 1, STUB_NPM_PUBLISH_EXIT: 0 },
    });
    expect(r.status, r.output).toBe(0);
    expect(publishes(r.log)).toEqual(["npm publish --provenance --access public"]);
  });

  it("publish: a main that moved past the tested commit fails the step without publishing", () => {
    const r = runStep("publish", PUBLISH, {
      env: MOVED_MAIN_ENV,
      stubs: { STUB_NPM_VIEW_STDERR: "npm error code E404", STUB_NPM_VIEW_EXIT: 1, STUB_NPM_PUBLISH_EXIT: 0 },
    });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain(FAKE_SHA);
    expect(r.output).toContain(MOVED_SHA);
    expect(publishes(r.log)).toEqual([]);
  });

  it("publish: any other npm view error fails without publishing", () => {
    const r = runStep("publish", PUBLISH, {
      stubs: { STUB_NPM_VIEW_STDERR: "npm error code E500", STUB_NPM_VIEW_EXIT: 1, STUB_NPM_PUBLISH_EXIT: 0 },
    });
    expect(r.status).not.toBe(0);
    expect(r.log).toEqual(["npm view craftar@0.0.9 version"]);
    expect(publishes(r.log)).toEqual([]);
  });

  it("publish: an answer naming another version fails without publishing", () => {
    const r = runStep("publish", PUBLISH, { env: PUBLISH_ENV, stubs: { STUB_NPM_VIEW_STDOUT: "0.0.8", STUB_NPM_VIEW_EXIT: 0 } });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("unexpected npm view output: 0.0.8");
    expect(publishes(r.log)).toEqual([]);
  });

  it("publish: a failed npm publish fails the step", () => {
    const r = runStep("publish", PUBLISH, {
      env: PUBLISH_ENV,
      stubs: { STUB_NPM_VIEW_STDERR: "npm error code E404", STUB_NPM_VIEW_EXIT: 1, STUB_NPM_PUBLISH_EXIT: 1 },
    });
    expect(r.status).not.toBe(0);
    expect(publishes(r.log)).toHaveLength(1);
  });

  it("release: an existing release is left alone", () => {
    const r = runStep("publish", RELEASE, { env: RELEASE_ENV, stubs: { STUB_GH_VIEW_EXIT: 0, STUB_GH_CREATE_EXIT: 0 } });
    expect(r.status, r.output).toBe(0);
    expect(r.log).toContain("gh release view v0.0.9 --repo llima/craftar-cli");
    expect(creates(r.log)).toEqual([]);
  });

  it("release: a missing release is created at the tested commit", () => {
    const r = runStep("publish", RELEASE, { env: RELEASE_ENV, stubs: { STUB_GH_VIEW_EXIT: 1, STUB_GH_CREATE_EXIT: 0 } });
    expect(r.status, r.output).toBe(0);
    const create = creates(r.log);
    expect(create).toHaveLength(1);
    expect(create[0]).toContain("v0.0.9");
    expect(create[0]).toContain("--repo llima/craftar-cli");
    expect(create[0]).toContain(`--target ${FAKE_SHA}`);
  });

  it("release: a failed release create fails the step", () => {
    const r = runStep("publish", RELEASE, { env: RELEASE_ENV, stubs: { STUB_GH_VIEW_EXIT: 1, STUB_GH_CREATE_EXIT: 1 } });
    expect(r.status).not.toBe(0);
    expect(creates(r.log)).toHaveLength(1);
  });
});
