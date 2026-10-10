/**
 * Unit tests for src/core/services.ts core functions per spec 31 §4.2–§4.8.
 * Tests for parseFragment (kept from before).
 * Tests for the spec-provided code: projectName, composeArgv, readPs, dockerVersion,
 * compareVersions, dockerFault, pendingLine, upRefusal, recordedServices, statusReport.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseFragment,
  projectName,
  composeArgv,
  downArgv,
  readPs,
  dockerVersion,
  recordedServices,
  compareVersions,
  dockerFault,
  pendingLine,
  upRefusal,
  statusReport,
  fragmentPaths,
  MIN_COMPOSE,
  type DockerRunner,
  type DockerInfo,
  type Recorded,
} from "../src/core/services.js";
import type { Lock } from "../src/schema/index.js";
import { hashNormalized } from "../src/core/text.js";

describe("parseFragment", () => {
  it("parses a valid fragment", () => {
    const result = parseFragment("services:\n  echo:\n    image: alpine\n");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fragment.services).toEqual({ echo: { image: "alpine" } });
    }
  });

  it("refuses invalid YAML", () => {
    const result = parseFragment("services: [unterminated");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not valid YAML after rendering/);
    }
  });

  it("refuses when not a mapping (null)", () => {
    const result = parseFragment("null\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("a fragment must be a YAML mapping");
    }
  });

  it("refuses when not a mapping (array)", () => {
    const result = parseFragment("[]\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("a fragment must be a YAML mapping");
    }
  });

  it("refuses when not a mapping (scalar)", () => {
    const result = parseFragment("hello\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("a fragment must be a YAML mapping");
    }
  });

  it("refuses top-level name", () => {
    const result = parseFragment("name: myproject\nservices:\n  x:\n    image: x\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("a fragment must not declare a top-level name — the project name is craftar's");
    }
  });

  it("refuses include", () => {
    const result = parseFragment("include: []\nservices:\n  x:\n    image: x\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("a fragment must not declare include — every file of the stack is in craftar.lock");
    }
  });

  it("refuses __proto__ key in services", () => {
    const result = parseFragment("services:\n  __proto__:\n    image: x\n  echo:\n    image: y\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("a __proto__ key is not allowed");
    }
  });

  it("refuses __proto__ key in volumes", () => {
    const result = parseFragment("services:\n  x:\n    image: x\nvolumes:\n  __proto__: {}\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("a __proto__ key is not allowed");
    }
  });

  it("refuses volumes: [] (must be a mapping)", () => {
    const result = parseFragment("services:\n  x:\n    image: x\nvolumes: []\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("volumes must be a mapping");
    }
  });

  it("refuses networks: [] (must be a mapping)", () => {
    const result = parseFragment("services:\n  x:\n    image: x\nnetworks: []\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("networks must be a mapping");
    }
  });

  it("refuses empty services", () => {
    const result = parseFragment("services: {}\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("a fragment must declare at least one service");
    }
  });

  it("refuses no services key", () => {
    const result = parseFragment("volumes:\n  data: {}\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("a fragment must declare at least one service");
    }
  });

  it("passes through unknown keys (version, x-*, etc.)", () => {
    const result = parseFragment("version: '3.8'\nx-foo: bar\nservices:\n  echo:\n    image: alpine\n");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing passthrough
      expect((result.fragment as any).version).toBe("3.8");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing passthrough
      expect((result.fragment as any)["x-foo"]).toBe("bar");
    }
  });
});

/* ------------------------------------------------------------------ */
/* projectName tests                                                    */
/* ------------------------------------------------------------------ */

describe("projectName", () => {
  it("basic path produces craftar-<slug>-<8 hex>", () => {
    const name = projectName("/home/acme/portal");
    expect(name).toMatch(/^craftar-portal-[0-9a-f]{8}$/);
  });

  it("same input twice → same output (stable)", () => {
    const a = projectName("/home/acme/portal");
    const b = projectName("/home/acme/portal");
    expect(a).toBe(b);
  });

  it("the hash is the first 8 hex digits of SHA-256 of the real path", () => {
    const p = "/home/acme/portal";
    const name = projectName(p);
    const expected = createHash("sha256").update(p).digest("hex").slice(0, 8);
    expect(name.endsWith(`-${expected}`)).toBe(true);
  });

  it('"/" (empty basename) → craftar--<hash>', () => {
    const name = projectName("/");
    expect(name).toMatch(/^craftar--[0-9a-f]{8}$/);
  });

  it('"/srv/!!!" (all-invalid chars) → craftar--<hash>', () => {
    const name = projectName("/srv/!!!");
    expect(name).toMatch(/^craftar--[0-9a-f]{8}$/);
  });

  it("a 60-char basename is cut to 40", () => {
    const longName = "a".repeat(60);
    const name = projectName(`/home/acme/${longName}`);
    const match = name.match(/^craftar-(.+)-[0-9a-f]{8}$/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBe(40);
    expect(match![1]).toBe("a".repeat(40));
  });

  it("two different paths with same basename differ (hash differs)", () => {
    const a = projectName("/home/acme/portal");
    const b = projectName("/other/path/portal");
    expect(a).not.toBe(b);
  });
});

/* ------------------------------------------------------------------ */
/* composeArgv tests                                                    */
/* ------------------------------------------------------------------ */

describe("composeArgv", () => {
  it("up basic", () => {
    const argv = composeArgv("up", {
      project: "p",
      stack: "/w/.craftar/compose.yaml",
      envFile: null,
    });
    expect(argv).toEqual(["compose", "-p", "p", "-f", "/w/.craftar/compose.yaml", "up", "-d"]);
  });

  it("up with envFile, wait, services", () => {
    const argv = composeArgv("up", {
      project: "p",
      stack: "/w/.craftar/compose.yaml",
      envFile: "/w/.env",
      wait: true,
      services: ["echo"],
    });
    expect(argv).toEqual([
      "compose", "-p", "p", "-f", "/w/.craftar/compose.yaml", "--env-file", "/w/.env",
      "up", "-d", "--wait", "echo",
    ]);
  });

  it("up with stack:null (no -f)", () => {
    const argv = composeArgv("up", {
      project: "p",
      stack: null,
      envFile: null,
    });
    expect(argv).toEqual(["compose", "-p", "p", "up", "-d"]);
  });

  it('services:["-v"] throws "service name "-v" starts with "-" — refused"', () => {
    expect(() =>
      composeArgv("up", {
        project: "p",
        stack: "/w/.craftar/compose.yaml",
        envFile: null,
        services: ["-v"],
      }),
    ).toThrow('service name "-v" starts with "-" — refused');
  });

  it("down with stack:null (no -f)", () => {
    const argv = composeArgv("down", {
      project: "p",
      stack: null,
      envFile: null,
    });
    expect(argv).toEqual(["compose", "-p", "p", "down"]);
  });

  it("down with volumes:true", () => {
    const argv = composeArgv("down", {
      project: "p",
      stack: "/w/.craftar/compose.yaml",
      envFile: null,
      volumes: true,
    });
    expect(argv).toEqual(["compose", "-p", "p", "-f", "/w/.craftar/compose.yaml", "down", "--volumes"]);
  });

  it("ps", () => {
    const argv = composeArgv("ps", {
      project: "p",
      stack: "/w/.craftar/compose.yaml",
      envFile: null,
    });
    expect(argv).toEqual(["compose", "-p", "p", "-f", "/w/.craftar/compose.yaml", "ps", "--all", "--format", "json"]);
  });
});

/* ------------------------------------------------------------------ */
/* downArgv tests (C3)                                                  */
/* ------------------------------------------------------------------ */

describe("downArgv", () => {
  const stackPath = "/w/.craftar/compose.yaml";
  const intactRecorded: Recorded = { entries: 3, stack: true, services: [{ name: "echo", ingredient: "service/echo" }], pending: [], warnings: [] };
  const pendingRecorded: Recorded = { entries: 3, stack: true, services: [], pending: [{ path: ".craftar/services/echo/compose.yaml", reason: "missing" }], warnings: [] };
  const belowFloorRecorded: Recorded = intactRecorded;
  const dockerOk: DockerInfo = { available: true, compose: "5.5.1", belowFloor: false, reason: null };
  const dockerOld: DockerInfo = { available: true, compose: "2.19.0", belowFloor: true, reason: "too old" };

  it("intact + env → -f and --env-file both", () => {
    const argv = downArgv("p", intactRecorded, dockerOk, stackPath, "/w/.env", false);
    expect(argv).toEqual(["compose", "-p", "p", "-f", stackPath, "--env-file", "/w/.env", "down"]);
  });

  it("intact, no .env → -f only", () => {
    const argv = downArgv("p", intactRecorded, dockerOk, stackPath, null, false);
    expect(argv).toEqual(["compose", "-p", "p", "-f", stackPath, "down"]);
  });

  it("pending file → neither -f nor --env-file", () => {
    const argv = downArgv("p", pendingRecorded, dockerOk, stackPath, "/w/.env", false);
    expect(argv).toEqual(["compose", "-p", "p", "down"]);
  });

  it("belowFloor → neither -f nor --env-file", () => {
    const argv = downArgv("p", belowFloorRecorded, dockerOld, stackPath, "/w/.env", false);
    expect(argv).toEqual(["compose", "-p", "p", "down"]);
  });

  it("r: null → neither -f nor --env-file (lock could not be read)", () => {
    const argv = downArgv("p", null, dockerOk, stackPath, "/w/.env", false);
    expect(argv).toEqual(["compose", "-p", "p", "down"]);
  });

  it("volumes → ends with ['down', '--volumes']", () => {
    const argv = downArgv("p", intactRecorded, dockerOk, stackPath, "/w/.env", true);
    expect(argv.slice(-2)).toEqual(["down", "--volumes"]);
  });
});

/* ------------------------------------------------------------------ */
/* readPs tests                                                         */
/* ------------------------------------------------------------------ */

describe("readPs", () => {
  it('readPs("") → {containers:[], unread:0}', () => {
    expect(readPs("")).toEqual({ containers: [], unread: 0 });
  });

  it("an array of two rows", () => {
    const json = JSON.stringify([
      { Service: "s1", State: "running", Health: "healthy", Publishers: [{ TargetPort: 80, PublishedPort: 8080, Protocol: "tcp" }] },
      { Service: "s2", State: "exited", Health: "", Publishers: [] },
    ]);
    const result = readPs(json);
    expect(result.containers).toHaveLength(2);
    expect(result.containers[0]).toEqual({
      service: "s1",
      state: "running",
      health: "healthy",
      ports: [{ host: 8080, container: 80, protocol: "tcp" }],
    });
    expect(result.containers[1]).toEqual({
      service: "s2",
      state: "exited",
      health: null,
      ports: [],
    });
    expect(result.unread).toBe(0);
  });

  it("one object per line with a blank line between", () => {
    const line1 = JSON.stringify({ Service: "s1", State: "running", Health: null, Publishers: [] });
    const line2 = JSON.stringify({ Service: "s2", State: "exited", Health: null, Publishers: [] });
    const result = readPs(`${line1}\n\n${line2}`);
    expect(result.containers).toHaveLength(2);
    expect(result.containers[0].service).toBe("s1");
    expect(result.containers[1].service).toBe("s2");
    expect(result.unread).toBe(0);
  });

  it("garbage throws 'docker compose ps: output not understood'", () => {
    expect(() => readPs("not json at all")).toThrow("docker compose ps: output not understood");
  });

  it("a row missing Service → unread: 1", () => {
    const json = JSON.stringify([
      { State: "running", Health: "healthy", Publishers: [] },
      { Service: "s2", State: "exited", Health: null, Publishers: [] },
    ]);
    const result = readPs(json);
    expect(result.containers).toHaveLength(1);
    expect(result.containers[0].service).toBe("s2");
    expect(result.unread).toBe(1);
  });

  it("duplicate publisher (IPv4 and IPv6) counted once", () => {
    const json = JSON.stringify([
      {
        Service: "s1",
        State: "running",
        Health: null,
        Publishers: [
          { TargetPort: 80, PublishedPort: 8080, Protocol: "tcp" },
          { TargetPort: 80, PublishedPort: 8080, Protocol: "tcp" },
        ],
      },
    ]);
    const result = readPs(json);
    expect(result.containers[0].ports).toHaveLength(1);
  });

  it('Health: "" → null', () => {
    const json = JSON.stringify([{ Service: "s", State: "running", Health: "", Publishers: [] }]);
    const result = readPs(json);
    expect(result.containers[0].health).toBe(null);
  });
});

/* ------------------------------------------------------------------ */
/* compareVersions tests                                                */
/* ------------------------------------------------------------------ */

describe("compareVersions", () => {
  it("2.9.0 < 2.20.0 (numeric, not string)", () => {
    expect(compareVersions("2.9.0", "2.20.0")).toBe(-1);
  });

  it("2.20.0 === 2.20.0", () => {
    expect(compareVersions("2.20.0", "2.20.0")).toBe(0);
  });

  it("2.24.5 > 2.20.0", () => {
    expect(compareVersions("2.24.5", "2.20.0")).toBe(1);
  });

  it("1.9.0 < 1.10.0 (string would say otherwise)", () => {
    expect(compareVersions("1.9.0", "1.10.0")).toBe(-1);
  });
});

/* ------------------------------------------------------------------ */
/* dockerVersion tests                                                  */
/* ------------------------------------------------------------------ */

describe("dockerVersion", () => {
  it('"5.5.1" → {available:true, compose:"5.5.1", belowFloor:false, reason:null}', async () => {
    const run: DockerRunner = async () => ({ code: 0, stdout: "5.5.1\n", stderr: "" });
    const result = await dockerVersion(run);
    expect(result).toEqual({ available: true, compose: "5.5.1", belowFloor: false, reason: null });
  });

  it("v2.19.1 → available:true, belowFloor:true, reason:'too old'", async () => {
    const run: DockerRunner = async () => ({ code: 0, stdout: "v2.19.1\n", stderr: "" });
    const result = await dockerVersion(run);
    expect(result.available).toBe(true);
    expect(result.compose).toBe("2.19.1");
    expect(result.belowFloor).toBe(true);
    expect(result.reason).toBe("too old");
  });

  it('"2.24.5-desktop.1" → compose extracts numeric part "2.24.5" only (E2)', async () => {
    const run: DockerRunner = async () => ({ code: 0, stdout: "2.24.5-desktop.1\n", stderr: "" });
    const result = await dockerVersion(run);
    expect(result.available).toBe(true);
    expect(result.compose).toBe("2.24.5"); // just the numeric part
    expect(result.belowFloor).toBe(false);
  });

  it("exit 1 → available:false, reason:'no compose plugin'", async () => {
    const run: DockerRunner = async () => ({ code: 1, stdout: "", stderr: "unknown command" });
    const result = await dockerVersion(run);
    expect(result).toEqual({ available: false, compose: null, belowFloor: false, reason: "no compose plugin" });
  });

  it('"not a version" → available:false, reason:"no compose plugin"', async () => {
    const run: DockerRunner = async () => ({ code: 0, stdout: "not a version\n", stderr: "" });
    const result = await dockerVersion(run);
    expect(result).toEqual({ available: false, compose: null, belowFloor: false, reason: "no compose plugin" });
  });

  it("runner rejects → available:false, reason:'no docker'", async () => {
    const run: DockerRunner = async () => {
      throw new Error("ENOENT");
    };
    const result = await dockerVersion(run);
    expect(result).toEqual({ available: false, compose: null, belowFloor: false, reason: "no docker" });
  });
});

/* ------------------------------------------------------------------ */
/* dockerFault tests                                                    */
/* ------------------------------------------------------------------ */

describe("dockerFault", () => {
  it('"no docker" → the line with DOCKER_FIX', () => {
    const d: DockerInfo = { available: false, compose: null, belowFloor: false, reason: "no docker" };
    const result = dockerFault(d, true);
    expect(result).toBe(`docker not found — install Docker with the Compose plugin ${MIN_COMPOSE} or later`);
  });

  it('"no compose plugin" → the line with DOCKER_FIX', () => {
    const d: DockerInfo = { available: false, compose: null, belowFloor: false, reason: "no compose plugin" };
    const result = dockerFault(d, true);
    expect(result).toBe(`the docker compose plugin is missing — install Docker with the Compose plugin ${MIN_COMPOSE} or later`);
  });

  it('"too old" with needFloor:true → the upgrade line', () => {
    const d: DockerInfo = { available: true, compose: "2.19.0", belowFloor: true, reason: "too old" };
    const result = dockerFault(d, true);
    expect(result).toBe(`Docker Compose 2.19.0 is older than ${MIN_COMPOSE} — upgrade Docker Compose`);
  });

  it('"too old" with needFloor:false → null (down and status do not need the floor)', () => {
    const d: DockerInfo = { available: true, compose: "2.19.0", belowFloor: true, reason: "too old" };
    const result = dockerFault(d, false);
    expect(result).toBe(null);
  });

  it("reason:null → null", () => {
    const d: DockerInfo = { available: true, compose: "5.5.1", belowFloor: false, reason: null };
    expect(dockerFault(d, true)).toBe(null);
    expect(dockerFault(d, false)).toBe(null);
  });
});

/* ------------------------------------------------------------------ */
/* pendingLine tests                                                    */
/* ------------------------------------------------------------------ */

describe("pendingLine", () => {
  it('"missing" → the run craftar sync line', () => {
    const result = pendingLine({ path: ".craftar/foo.yaml", reason: "missing" });
    expect(result).toBe(".craftar/foo.yaml — missing — run craftar sync");
  });

  it('"edited" → the overwrite-drift line per spec §16.1', () => {
    const result = pendingLine({ path: ".craftar/foo.yaml", reason: "edited" });
    expect(result).toBe(
      ".craftar/foo.yaml — edited — run craftar sync --overwrite-drift to regenerate it, or delete it if craftar status calls it orphan-drift"
    );
  });

  it('"unrecorded" → the run craftar status line', () => {
    const result = pendingLine({ path: ".craftar/compose.yaml", reason: "unrecorded" });
    expect(result).toBe(".craftar/compose.yaml is not craftar's — run craftar status");
  });
});

/* ------------------------------------------------------------------ */
/* upRefusal tests                                                      */
/* ------------------------------------------------------------------ */

describe("upRefusal", () => {
  it('["-v"] refused first even with no entries', () => {
    const r: Recorded = { entries: 0, stack: false, services: [], pending: [], warnings: [] };
    const result = upRefusal(r, ["-v"]);
    expect(result).toEqual(['service name "-v" starts with "-" — refused']);
  });

  it("entries:0 → no services in this workspace line", () => {
    const r: Recorded = { entries: 0, stack: false, services: [], pending: [], warnings: [] };
    const result = upRefusal(r, []);
    expect(result).toEqual(["no services in this workspace — craftar sync writes them when a recipe brings a service ingredient"]);
  });

  it("pending → the pending lines", () => {
    const r: Recorded = {
      entries: 2,
      stack: true,
      services: [],
      pending: [
        { path: ".craftar/services/echo/compose.yaml", reason: "missing" },
        { path: ".craftar/services/redis/compose.yaml", reason: "edited" },
      ],
      warnings: [],
    };
    const result = upRefusal(r, []);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("missing");
    expect(result[1]).toContain("edited");
  });

  it("clean → []", () => {
    const r: Recorded = {
      entries: 2,
      stack: true,
      services: [{ name: "echo", ingredient: "service/echo" }],
      pending: [],
      warnings: [],
    };
    const result = upRefusal(r, []);
    expect(result).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* recordedServices tests                                               */
/* ------------------------------------------------------------------ */

describe("recordedServices", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const makeStack = (includes: string[]) => {
    const lines = ["# Generated by craftar", "include:"];
    for (const p of includes) {
      lines.push(`  - path: ${p}`);
    }
    return lines.join("\n") + "\n";
  };

  const makeFragment = (serviceName: string) => `services:\n  ${serviceName}:\n    image: alpine\n`;

  it("null lock → entries:0, stack:false, services:[], pending:[], warnings:[]", async () => {
    const result = await recordedServices(tmpDir, null);
    expect(result).toEqual({ entries: 0, stack: false, services: [], pending: [], warnings: [] });
  });

  it("schema 2 lock has no services entry → the same", async () => {
    const lock: Lock = {
      schema: 2,
      forge: { source: "../forge", ref: null, commit: null },
      profile: "acme",
      recipes: ["base"],
      targets: ["claude-code"],
      generatedAt: new Date().toISOString(),
      files: [],
    };
    const result = await recordedServices(tmpDir, lock);
    expect(result).toEqual({ entries: 0, stack: false, services: [], pending: [], warnings: [] });
  });

  it("four intact entries → one service {name:'echo', ingredient:'service/echo'}", async () => {
    const stackContent = makeStack(["services/echo/compose.yaml"]);
    const fragmentContent = makeFragment("echo");
    const gitattributes = "* -text\n";

    await fs.mkdir(path.join(tmpDir, ".craftar/services/echo"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".craftar/compose.yaml"), stackContent);
    await fs.writeFile(path.join(tmpDir, ".craftar/services/echo/compose.yaml"), fragmentContent);
    await fs.writeFile(path.join(tmpDir, ".craftar/.gitattributes"), gitattributes);

    const lock: Lock = {
      schema: 3,
      forge: { source: "../forge", ref: null, commit: null },
      profile: "acme",
      recipes: ["base"],
      targets: ["claude-code"],
      generatedAt: new Date().toISOString(),
      files: [
        { path: ".craftar/compose.yaml", hash: hashNormalized(Buffer.from(stackContent)), target: "services", ingredient: "service/*" },
        { path: ".craftar/services/echo/compose.yaml", hash: hashNormalized(Buffer.from(fragmentContent)), target: "services", ingredient: "service/echo" },
        { path: ".craftar/.gitattributes", hash: hashNormalized(Buffer.from(gitattributes)), target: "services", ingredient: "service/*" },
      ],
    };

    const result = await recordedServices(tmpDir, lock);
    expect(result.entries).toBe(3);
    expect(result.stack).toBe(true);
    expect(result.services).toEqual([{ name: "echo", ingredient: "service/echo" }]);
    expect(result.pending).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("fragment deleted → pending missing", async () => {
    const stackContent = makeStack(["services/echo/compose.yaml"]);
    const fragmentContent = makeFragment("echo");

    await fs.mkdir(path.join(tmpDir, ".craftar/services/echo"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".craftar/compose.yaml"), stackContent);
    // NOT writing the fragment

    const lock: Lock = {
      schema: 3,
      forge: { source: "../forge", ref: null, commit: null },
      profile: "acme",
      recipes: ["base"],
      targets: ["claude-code"],
      generatedAt: new Date().toISOString(),
      files: [
        { path: ".craftar/compose.yaml", hash: hashNormalized(Buffer.from(stackContent)), target: "services", ingredient: "service/*" },
        { path: ".craftar/services/echo/compose.yaml", hash: hashNormalized(Buffer.from(fragmentContent)), target: "services", ingredient: "service/echo" },
      ],
    };

    const result = await recordedServices(tmpDir, lock);
    expect(result.pending).toContainEqual({ path: ".craftar/services/echo/compose.yaml", reason: "missing" });
  });

  it("fragment edited → pending edited", async () => {
    const stackContent = makeStack(["services/echo/compose.yaml"]);
    const fragmentContent = makeFragment("echo");

    await fs.mkdir(path.join(tmpDir, ".craftar/services/echo"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".craftar/compose.yaml"), stackContent);
    await fs.writeFile(path.join(tmpDir, ".craftar/services/echo/compose.yaml"), "modified content\n");

    const lock: Lock = {
      schema: 3,
      forge: { source: "../forge", ref: null, commit: null },
      profile: "acme",
      recipes: ["base"],
      targets: ["claude-code"],
      generatedAt: new Date().toISOString(),
      files: [
        { path: ".craftar/compose.yaml", hash: hashNormalized(Buffer.from(stackContent)), target: "services", ingredient: "service/*" },
        { path: ".craftar/services/echo/compose.yaml", hash: hashNormalized(Buffer.from(fragmentContent)), target: "services", ingredient: "service/echo" },
      ],
    };

    const result = await recordedServices(tmpDir, lock);
    expect(result.pending).toContainEqual({ path: ".craftar/services/echo/compose.yaml", reason: "edited" });
  });

  it("a recorded LF script re-saved with CRLF is NOT pending (hashNormalized)", async () => {
    const stackContent = makeStack(["services/echo/compose.yaml"]);
    const fragmentLF = makeFragment("echo");
    const fragmentCRLF = fragmentLF.replace(/\n/g, "\r\n");

    await fs.mkdir(path.join(tmpDir, ".craftar/services/echo"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".craftar/compose.yaml"), stackContent);
    await fs.writeFile(path.join(tmpDir, ".craftar/services/echo/compose.yaml"), fragmentCRLF);

    const lock: Lock = {
      schema: 3,
      forge: { source: "../forge", ref: null, commit: null },
      profile: "acme",
      recipes: ["base"],
      targets: ["claude-code"],
      generatedAt: new Date().toISOString(),
      files: [
        { path: ".craftar/compose.yaml", hash: hashNormalized(Buffer.from(stackContent)), target: "services", ingredient: "service/*" },
        { path: ".craftar/services/echo/compose.yaml", hash: hashNormalized(Buffer.from(fragmentLF)), target: "services", ingredient: "service/echo" },
      ],
    };

    const result = await recordedServices(tmpDir, lock);
    // CRLF and LF hash the same, so it's NOT pending
    expect(result.pending.find((p) => p.path.includes("echo"))).toBeUndefined();
  });

  it("stack edited AND fragment deleted → two pending, stack:true, services:[]", async () => {
    const stackContent = makeStack(["services/echo/compose.yaml"]);
    const fragmentContent = makeFragment("echo");

    await fs.mkdir(path.join(tmpDir, ".craftar/services/echo"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".craftar/compose.yaml"), "edited stack\n");
    // NOT writing the fragment

    const lock: Lock = {
      schema: 3,
      forge: { source: "../forge", ref: null, commit: null },
      profile: "acme",
      recipes: ["base"],
      targets: ["claude-code"],
      generatedAt: new Date().toISOString(),
      files: [
        { path: ".craftar/compose.yaml", hash: hashNormalized(Buffer.from(stackContent)), target: "services", ingredient: "service/*" },
        { path: ".craftar/services/echo/compose.yaml", hash: hashNormalized(Buffer.from(fragmentContent)), target: "services", ingredient: "service/echo" },
      ],
    };

    const result = await recordedServices(tmpDir, lock);
    expect(result.stack).toBe(true);
    expect(result.services).toEqual([]);
    expect(result.pending).toHaveLength(2);
    expect(result.pending.map((p) => p.reason).sort()).toEqual(["edited", "missing"]);
  });

  it("stack missing → stack:true (entry exists), pending has missing", async () => {
    const stackContent = makeStack(["services/echo/compose.yaml"]);
    const fragmentContent = makeFragment("echo");

    await fs.mkdir(path.join(tmpDir, ".craftar/services/echo"), { recursive: true });
    // NOT writing the stack
    await fs.writeFile(path.join(tmpDir, ".craftar/services/echo/compose.yaml"), fragmentContent);

    const lock: Lock = {
      schema: 3,
      forge: { source: "../forge", ref: null, commit: null },
      profile: "acme",
      recipes: ["base"],
      targets: ["claude-code"],
      generatedAt: new Date().toISOString(),
      files: [
        { path: ".craftar/compose.yaml", hash: hashNormalized(Buffer.from(stackContent)), target: "services", ingredient: "service/*" },
        { path: ".craftar/services/echo/compose.yaml", hash: hashNormalized(Buffer.from(fragmentContent)), target: "services", ingredient: "service/echo" },
      ],
    };

    const result = await recordedServices(tmpDir, lock);
    expect(result.stack).toBe(true);
    expect(result.pending).toContainEqual({ path: ".craftar/compose.yaml", reason: "missing" });
  });

  it("no stack entry + an edited script → unrecorded then edited, stack:false", async () => {
    const fragmentContent = makeFragment("echo");

    await fs.mkdir(path.join(tmpDir, ".craftar/services/echo"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".craftar/services/echo/compose.yaml"), "edited\n");

    const lock: Lock = {
      schema: 3,
      forge: { source: "../forge", ref: null, commit: null },
      profile: "acme",
      recipes: ["base"],
      targets: ["claude-code"],
      generatedAt: new Date().toISOString(),
      files: [
        { path: ".craftar/services/echo/compose.yaml", hash: hashNormalized(Buffer.from(fragmentContent)), target: "services", ingredient: "service/echo" },
      ],
    };

    const result = await recordedServices(tmpDir, lock);
    expect(result.stack).toBe(false);
    expect(result.pending).toContainEqual({ path: ".craftar/compose.yaml", reason: "unrecorded" });
    expect(result.pending).toContainEqual({ path: ".craftar/services/echo/compose.yaml", reason: "edited" });
  });

  it("the stack includes a path the lock does not record → that path unrecorded", async () => {
    const stackContent = makeStack(["services/echo/compose.yaml", "services/redis/compose.yaml"]);
    const fragmentContent = makeFragment("echo");

    await fs.mkdir(path.join(tmpDir, ".craftar/services/echo"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".craftar/compose.yaml"), stackContent);
    await fs.writeFile(path.join(tmpDir, ".craftar/services/echo/compose.yaml"), fragmentContent);

    const lock: Lock = {
      schema: 3,
      forge: { source: "../forge", ref: null, commit: null },
      profile: "acme",
      recipes: ["base"],
      targets: ["claude-code"],
      generatedAt: new Date().toISOString(),
      files: [
        { path: ".craftar/compose.yaml", hash: hashNormalized(Buffer.from(stackContent)), target: "services", ingredient: "service/*" },
        { path: ".craftar/services/echo/compose.yaml", hash: hashNormalized(Buffer.from(fragmentContent)), target: "services", ingredient: "service/echo" },
        // redis is in the stack but NOT in the lock
      ],
    };

    const result = await recordedServices(tmpDir, lock);
    expect(result.pending).toContainEqual({ path: ".craftar/services/redis/compose.yaml", reason: "unrecorded" });
  });

  it('a recorded stack whose text is "foo: 1" (hash matching) → throws the "not a craftar stack" error', async () => {
    const fakeStack = "foo: 1\n";

    await fs.mkdir(path.join(tmpDir, ".craftar"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".craftar/compose.yaml"), fakeStack);

    const lock: Lock = {
      schema: 3,
      forge: { source: "../forge", ref: null, commit: null },
      profile: "acme",
      recipes: ["base"],
      targets: ["claude-code"],
      generatedAt: new Date().toISOString(),
      files: [
        { path: ".craftar/compose.yaml", hash: hashNormalized(Buffer.from(fakeStack)), target: "services", ingredient: "service/*" },
      ],
    };

    await expect(recordedServices(tmpDir, lock)).rejects.toThrow(".craftar/compose.yaml: recorded by craftar.lock but not a craftar stack");
  });

  it('an intact fragment that is "[]" → a warning, no service', async () => {
    const stackContent = makeStack(["services/bad/compose.yaml"]);
    const badFragment = "[]\n";

    await fs.mkdir(path.join(tmpDir, ".craftar/services/bad"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".craftar/compose.yaml"), stackContent);
    await fs.writeFile(path.join(tmpDir, ".craftar/services/bad/compose.yaml"), badFragment);

    const lock: Lock = {
      schema: 3,
      forge: { source: "../forge", ref: null, commit: null },
      profile: "acme",
      recipes: ["base"],
      targets: ["claude-code"],
      generatedAt: new Date().toISOString(),
      files: [
        { path: ".craftar/compose.yaml", hash: hashNormalized(Buffer.from(stackContent)), target: "services", ingredient: "service/*" },
        { path: ".craftar/services/bad/compose.yaml", hash: hashNormalized(Buffer.from(badFragment)), target: "services", ingredient: "service/bad" },
      ],
    };

    const result = await recordedServices(tmpDir, lock);
    expect(result.services).toEqual([]);
    expect(result.warnings).toContainEqual(".craftar/services/bad/compose.yaml: cannot be read as a Compose fragment");
  });

  it("C2: a hash-matching stack whose include is /etc/x → throws the not-a-stack error", async () => {
    // A stack with an absolute path in include is not a craftar stack
    const stackContent = "# Generated by craftar\ninclude:\n  - path: /etc/evil.yaml\n";

    await fs.mkdir(path.join(tmpDir, ".craftar"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".craftar/compose.yaml"), stackContent);

    const lock: Lock = {
      schema: 3,
      forge: { source: "../forge", ref: null, commit: null },
      profile: "acme",
      recipes: ["base"],
      targets: ["claude-code"],
      generatedAt: new Date().toISOString(),
      files: [
        { path: ".craftar/compose.yaml", hash: hashNormalized(Buffer.from(stackContent)), target: "services", ingredient: "service/*" },
      ],
    };

    await expect(recordedServices(tmpDir, lock)).rejects.toThrow(".craftar/compose.yaml: recorded by craftar.lock but not a craftar stack");
  });

  it("C2: a hash-matching stack whose include is ../x → throws the not-a-stack error", async () => {
    // A stack with a .. segment in include is not a craftar stack
    const stackContent = "# Generated by craftar\ninclude:\n  - path: ../evil.yaml\n";

    await fs.mkdir(path.join(tmpDir, ".craftar"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".craftar/compose.yaml"), stackContent);

    const lock: Lock = {
      schema: 3,
      forge: { source: "../forge", ref: null, commit: null },
      profile: "acme",
      recipes: ["base"],
      targets: ["claude-code"],
      generatedAt: new Date().toISOString(),
      files: [
        { path: ".craftar/compose.yaml", hash: hashNormalized(Buffer.from(stackContent)), target: "services", ingredient: "service/*" },
      ],
    };

    await expect(recordedServices(tmpDir, lock)).rejects.toThrow(".craftar/compose.yaml: recorded by craftar.lock but not a craftar stack");
  });
});

/* ------------------------------------------------------------------ */
/* statusReport tests                                                   */
/* ------------------------------------------------------------------ */

describe("statusReport", () => {
  it("key order is workspace, project, composeFile, docker, services, pending, warnings", () => {
    const r: Recorded = { entries: 0, stack: false, services: [], pending: [], warnings: [] };
    const d: DockerInfo = { available: true, compose: "5.5.1", belowFloor: false, reason: null };
    const report = statusReport("/home/ws", r, d, null, null);
    expect(Object.keys(report)).toEqual(["workspace", "project", "composeFile", "docker", "services", "pending", "warnings"]);
  });

  it("a declared service with no container → not created", () => {
    const r: Recorded = {
      entries: 2,
      stack: true,
      services: [{ name: "echo", ingredient: "service/echo" }],
      pending: [],
      warnings: [],
    };
    const d: DockerInfo = { available: true, compose: "5.5.1", belowFloor: false, reason: null };
    const report = statusReport("/home/ws", r, d, { containers: [], unread: 0 }, null);
    expect(report.services).toContainEqual({
      name: "echo",
      ingredient: "service/echo",
      state: "not created",
      health: null,
      ports: [],
    });
  });

  it("a container whose service is not declared → ingredient: null", () => {
    const r: Recorded = {
      entries: 2,
      stack: true,
      services: [],
      pending: [],
      warnings: [],
    };
    const d: DockerInfo = { available: true, compose: "5.5.1", belowFloor: false, reason: null };
    const report = statusReport("/home/ws", r, d, {
      containers: [{ service: "orphan", state: "running", health: null, ports: [] }],
      unread: 0,
    }, null);
    expect(report.services).toContainEqual({
      name: "orphan",
      ingredient: null,
      state: "running",
      health: null,
      ports: [],
    });
  });

  it("unread: 2 → the warning", () => {
    const r: Recorded = { entries: 0, stack: true, services: [], pending: [], warnings: [] };
    const d: DockerInfo = { available: true, compose: "5.5.1", belowFloor: false, reason: null };
    const report = statusReport("/home/ws", r, d, { containers: [], unread: 2 }, null);
    expect(report.warnings).toContain("docker compose ps: 2 row(s) not understood");
  });

  it("composeFile: null when the stack is unrecorded", () => {
    const r: Recorded = { entries: 1, stack: false, services: [], pending: [], warnings: [] };
    const d: DockerInfo = { available: true, compose: "5.5.1", belowFloor: false, reason: null };
    const report = statusReport("/home/ws", r, d, null, null);
    expect(report.composeFile).toBe(null);
  });
});

/* ------------------------------------------------------------------ */
/* fragmentPaths tests (E2: returns [] for invalid YAML, not throw)   */
/* ------------------------------------------------------------------ */

describe("fragmentPaths", () => {
  it("valid craftar stack → workspace-relative POSIX paths", () => {
    const stack = "include:\n  - path: services/echo/compose.yaml\n  - path: services/redis/compose.yaml\n";
    expect(fragmentPaths(stack)).toEqual([".craftar/services/echo/compose.yaml", ".craftar/services/redis/compose.yaml"]);
  });

  it("invalid YAML (syntax error) → empty array, not throw", () => {
    const bad = "include: [\n  - path: foo\n"; // broken YAML
    expect(fragmentPaths(bad)).toEqual([]);
  });

  it("not a mapping → empty array", () => {
    const notMapping = "- a\n- b\n";
    expect(fragmentPaths(notMapping)).toEqual([]);
  });

  it("no include key → empty array", () => {
    const noInclude = "services:\n  echo:\n    image: x\n";
    expect(fragmentPaths(noInclude)).toEqual([]);
  });

  it("absolute path in include → empty array", () => {
    const absPath = "include:\n  - path: /etc/compose.yaml\n";
    expect(fragmentPaths(absPath)).toEqual([]);
  });

  it(".. segment in include path → empty array", () => {
    const dotDot = "include:\n  - path: ../escape/compose.yaml\n";
    expect(fragmentPaths(dotDot)).toEqual([]);
  });
});
