/**
 * Unit tests for src/core/services.ts core functions.
 * Tests for parseFragment (direct unit tests for each refusal reason).
 * Tests for step 31d: projectName, composeArgv, readPs, dockerVersion, recordedServices, canUseStack.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseFragment,
  projectName,
  composeArgv,
  readPs,
  dockerVersion,
  recordedServices,
  canUseStack,
  compareVersions,
  type DockerRunner,
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
    // Use JSON.parse to create a real __proto__ key in the object, then convert to YAML
    // For YAML parsing, __proto__ in services map should be refused
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
/* Step 31d tests                                                       */
/* ------------------------------------------------------------------ */

describe("projectName", () => {
  it('"/home/acme/My Portal!" → matches /^craftar-my-portal--[0-9a-f]{8}$/', () => {
    const name = projectName("/home/acme/My Portal!");
    expect(name).toMatch(/^craftar-my-portal--[0-9a-f]{8}$/);
  });

  it("same input twice → same output", () => {
    const a = projectName("/home/acme/portal");
    const b = projectName("/home/acme/portal");
    expect(a).toBe(b);
  });

  it("a 60-char basename is cut to 40", () => {
    const longName = "a".repeat(60);
    const name = projectName(`/home/acme/${longName}`);
    // Slug is cut to 40, so the pattern is craftar-<40 chars>-<8 hex>
    expect(name).toMatch(/^craftar-a{40}-[0-9a-f]{8}$/);
  });

  it("two different paths with one basename differ", () => {
    const a = projectName("/home/acme/portal");
    const b = projectName("/other/path/portal");
    expect(a).not.toBe(b);
  });

  it('/ (basename empty) → matches /^craftar--[0-9a-f]{8}$/', () => {
    const name = projectName("/");
    expect(name).toMatch(/^craftar--[0-9a-f]{8}$/);
  });
});

describe("composeArgv", () => {
  it("up basic", () => {
    const argv = composeArgv("up", {
      project: "p",
      stack: "/w/.craftar/compose.yaml",
      envFile: null,
      wait: false,
      services: [],
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
      "compose",
      "-p",
      "p",
      "-f",
      "/w/.craftar/compose.yaml",
      "--env-file",
      "/w/.env",
      "up",
      "-d",
      "--wait",
      "echo",
    ]);
  });

  it('services:["-v"] throws', () => {
    expect(() =>
      composeArgv("up", {
        project: "p",
        stack: "/w/.craftar/compose.yaml",
        envFile: null,
        services: ["-v"],
      }),
    ).toThrow('service name "-v" starts with "-"');
  });

  it("down with stack:null", () => {
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

describe("readPs", () => {
  it('readPs("") → []', () => {
    expect(readPs("")).toEqual([]);
  });

  it("an array of two rows", () => {
    const json = JSON.stringify([
      { Name: "c1", Service: "s1", State: "running", Health: "healthy", Publishers: [{ TargetPort: 80, PublishedPort: 8080, Protocol: "tcp" }] },
      { Name: "c2", Service: "s2", State: "exited", Health: "", Publishers: [] },
    ]);
    const result = readPs(json);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      name: "c1",
      service: "s1",
      state: "running",
      health: "healthy",
      ports: [{ host: 8080, container: 80, protocol: "tcp" }],
    });
    expect(result[1]).toEqual({
      name: "c2",
      service: "s2",
      state: "exited",
      health: null,
      ports: [],
    });
  });

  it("same two rows one per line", () => {
    const line1 = JSON.stringify({ Name: "c1", Service: "s1", State: "running", Health: "healthy", Publishers: [{ TargetPort: 80, PublishedPort: 8080, Protocol: "tcp" }] });
    const line2 = JSON.stringify({ Name: "c2", Service: "s2", State: "exited", Health: "", Publishers: [] });
    const result = readPs(`${line1}\n${line2}`);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("c1");
    expect(result[1].name).toBe("c2");
  });

  it('Health: "" → health: null', () => {
    const json = JSON.stringify([{ Name: "c", Service: "s", State: "running", Health: "" }]);
    const result = readPs(json);
    expect(result[0].health).toBe(null);
  });
});

describe("dockerVersion", () => {
  it('runner answering "5.5.1\\n" → {available:true, compose:"5.5.1"}', async () => {
    const run: DockerRunner = async () => ({ code: 0, stdout: "5.5.1\n", stderr: "" });
    const result = await dockerVersion(run);
    expect(result).toEqual({ available: true, compose: "5.5.1", reason: null });
  });

  it("v2.19.1 → available but below floor", async () => {
    const run: DockerRunner = async () => ({ code: 0, stdout: "v2.19.1\n", stderr: "" });
    const result = await dockerVersion(run);
    expect(result.available).toBe(true);
    expect(result.belowFloor).toBe(true);
    expect(result.reason).toBe("too old");
  });

  it("runner rejecting with ENOENT → {available:false, compose:null}", async () => {
    const run: DockerRunner = async () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    const result = await dockerVersion(run);
    expect(result).toEqual({ available: false, compose: null, reason: "no docker" });
  });

  it("non-zero exit → no compose plugin", async () => {
    const run: DockerRunner = async () => ({ code: 1, stdout: "", stderr: "plugin not found" });
    const result = await dockerVersion(run);
    expect(result).toEqual({ available: true, compose: null, reason: "no compose plugin" });
  });
});

describe("compareVersions", () => {
  it("2.9.0 < 2.20.0", () => {
    expect(compareVersions("2.9.0", "2.20.0")).toBeLessThan(0);
  });

  it("2.20.0 === 2.20.0", () => {
    expect(compareVersions("2.20.0", "2.20.0")).toBe(0);
  });

  it("2.24.5 > 2.20.0", () => {
    expect(compareVersions("2.24.5", "2.20.0")).toBeGreaterThan(0);
  });
});

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

  it("lock with four entries and files intact → stack:true, pending:[], services with echo", async () => {
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
        { path: ".craftar/compose.yaml", hash: hashNormalized(stackContent), target: "services", ingredient: "service/*" },
        { path: ".craftar/services/echo/compose.yaml", hash: hashNormalized(fragmentContent), target: "services", ingredient: "service/echo" },
        { path: ".craftar/.gitattributes", hash: hashNormalized(gitattributes), target: "services", ingredient: "service/*" },
      ],
    };

    const result = await recordedServices(tmpDir, lock);
    expect(result.stack).toBe(true);
    expect(result.pending).toEqual([]);
    expect(result.services).toEqual([{ name: "echo", ingredient: "service/echo" }]);
    expect(result.warnings).toEqual([]);
  });

  it("fragment deleted → pending missing", async () => {
    const stackContent = makeStack(["services/echo/compose.yaml"]);

    await fs.mkdir(path.join(tmpDir, ".craftar/services/echo"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".craftar/compose.yaml"), stackContent);
    // Note: NOT writing the fragment file

    const lock: Lock = {
      schema: 3,
      forge: { source: "../forge", ref: null, commit: null },
      profile: "acme",
      recipes: ["base"],
      targets: ["claude-code"],
      generatedAt: new Date().toISOString(),
      files: [
        { path: ".craftar/compose.yaml", hash: hashNormalized(stackContent), target: "services", ingredient: "service/*" },
        { path: ".craftar/services/echo/compose.yaml", hash: "sha256:something", target: "services", ingredient: "service/echo" },
      ],
    };

    const result = await recordedServices(tmpDir, lock);
    expect(result.stack).toBe(true);
    expect(result.pending).toContainEqual({ path: ".craftar/services/echo/compose.yaml", reason: "missing" });
  });

  it("fragment edited → pending edited", async () => {
    const stackContent = makeStack(["services/echo/compose.yaml"]);
    const fragmentContent = makeFragment("echo");
    const editedFragment = makeFragment("echo-edited");

    await fs.mkdir(path.join(tmpDir, ".craftar/services/echo"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".craftar/compose.yaml"), stackContent);
    await fs.writeFile(path.join(tmpDir, ".craftar/services/echo/compose.yaml"), editedFragment); // Wrong content!

    const lock: Lock = {
      schema: 3,
      forge: { source: "../forge", ref: null, commit: null },
      profile: "acme",
      recipes: ["base"],
      targets: ["claude-code"],
      generatedAt: new Date().toISOString(),
      files: [
        { path: ".craftar/compose.yaml", hash: hashNormalized(stackContent), target: "services", ingredient: "service/*" },
        { path: ".craftar/services/echo/compose.yaml", hash: hashNormalized(fragmentContent), target: "services", ingredient: "service/echo" }, // Original hash
      ],
    };

    const result = await recordedServices(tmpDir, lock);
    expect(result.stack).toBe(true);
    expect(result.pending).toContainEqual({ path: ".craftar/services/echo/compose.yaml", reason: "edited" });
  });

  it("lock without stack entry but with fragment entry → stack:false, pending with unrecorded", async () => {
    const fragmentContent = makeFragment("echo");

    await fs.mkdir(path.join(tmpDir, ".craftar/services/echo"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".craftar/services/echo/compose.yaml"), fragmentContent);

    const lock: Lock = {
      schema: 3,
      forge: { source: "../forge", ref: null, commit: null },
      profile: "acme",
      recipes: ["base"],
      targets: ["claude-code"],
      generatedAt: new Date().toISOString(),
      files: [
        // Stack not recorded — was a collision
        { path: ".craftar/services/echo/compose.yaml", hash: hashNormalized(fragmentContent), target: "services", ingredient: "service/echo" },
      ],
    };

    const result = await recordedServices(tmpDir, lock);
    expect(result.stack).toBe(false);
    expect(result.pending).toContainEqual({ path: ".craftar/compose.yaml", reason: "unrecorded" });
  });

  it("stack edited → services: [], pending with edited", async () => {
    const stackContent = makeStack(["services/echo/compose.yaml"]);
    const fragmentContent = makeFragment("echo");

    await fs.mkdir(path.join(tmpDir, ".craftar/services/echo"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".craftar/compose.yaml"), "edited content\n");
    await fs.writeFile(path.join(tmpDir, ".craftar/services/echo/compose.yaml"), fragmentContent);

    const lock: Lock = {
      schema: 3,
      forge: { source: "../forge", ref: null, commit: null },
      profile: "acme",
      recipes: ["base"],
      targets: ["claude-code"],
      generatedAt: new Date().toISOString(),
      files: [
        { path: ".craftar/compose.yaml", hash: hashNormalized(stackContent), target: "services", ingredient: "service/*" },
        { path: ".craftar/services/echo/compose.yaml", hash: hashNormalized(fragmentContent), target: "services", ingredient: "service/echo" },
      ],
    };

    const result = await recordedServices(tmpDir, lock);
    expect(result.stack).toBe(false);
    expect(result.services).toEqual([]);
    expect(result.pending).toContainEqual({ path: ".craftar/compose.yaml", reason: "edited" });
  });

  it("fragment unparsable → warning", async () => {
    const stackContent = makeStack(["services/bad/compose.yaml"]);
    const badFragment = "not: yaml: ["; // Invalid YAML

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
        { path: ".craftar/compose.yaml", hash: hashNormalized(stackContent), target: "services", ingredient: "service/*" },
        { path: ".craftar/services/bad/compose.yaml", hash: hashNormalized(badFragment), target: "services", ingredient: "service/bad" },
      ],
    };

    const result = await recordedServices(tmpDir, lock);
    expect(result.stack).toBe(true);
    expect(result.warnings).toContainEqual(".craftar/services/bad/compose.yaml: cannot be read as a Compose fragment");
  });

  it("schema 1 or 2 lock has no services entry → {stack:false, services:[], pending:[], warnings:[]}", async () => {
    const lock: Lock = {
      schema: 2,
      forge: { source: "../forge", ref: null, commit: null },
      profile: "acme",
      recipes: ["base"],
      targets: ["claude-code"],
      generatedAt: new Date().toISOString(),
      files: [], // No service entries
    };

    const result = await recordedServices(tmpDir, lock);
    expect(result).toEqual({ stack: false, services: [], pending: [], warnings: [] });
  });
});

describe("canUseStack", () => {
  it("stack:true and pending:[] → true", () => {
    expect(canUseStack({ stack: true, services: [], pending: [], warnings: [] })).toBe(true);
  });

  it("stack:false → false", () => {
    expect(canUseStack({ stack: false, services: [], pending: [], warnings: [] })).toBe(false);
  });

  it("stack:true but pending has items → false", () => {
    expect(canUseStack({ stack: true, services: [], pending: [{ path: "x", reason: "missing" }], warnings: [] })).toBe(false);
  });
});
