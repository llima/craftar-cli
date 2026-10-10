import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { capture, spawnInherited } from "../src/core/proc.js";
import { tmpDir } from "./helpers/forge.js";

// design D3 — the two ways craftar runs an external program besides git: no shell, an argument array.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const node = (script: string, ...rest: string[]) => ["-e", script, ...rest];

describe("capture", () => {
  it("returns the stdout of a process that exits 0, given the env", async () => {
    expect(await capture(process.execPath, node("console.log(process.env.CRAFTAR_PROBE)"), { ...process.env, CRAFTAR_PROBE: "1.2.3" })).toBe("1.2.3\n");
  });
  it("rejects on a non-zero exit and when the program does not exist", async () => {
    await expect(capture(process.execPath, node("process.exit(3)"), process.env)).rejects.toMatchObject({ code: 3 });
    await expect(capture("craftar-no-such-program", ["--version"], process.env)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("passes an argument as one argument: no shell reads it", async () => {
    expect(await capture(process.execPath, node("console.log(process.argv[1])", "a b; echo c && $(d)"), process.env)).toBe("a b; echo c && $(d)\n");
  });
});

describe("spawnInherited", () => {
  it("resolves with the exit code", async () => {
    const cwd = await tmpDir("craftar-proc-");
    cleanups.push(() => fs.rm(cwd, { recursive: true, force: true }));
    expect(await spawnInherited({ file: process.execPath, args: node("process.exit(0)"), cwd, env: process.env, stdin: "ignore" })).toEqual({ code: 0 });
    expect(await spawnInherited({ file: process.execPath, args: node("process.exit(103)"), cwd, env: process.env, stdin: "ignore" })).toEqual({ code: 103 });
  });
  it("runs in the given directory, with the given env, and an ignored stdin ends at once", async () => {
    const cwd = await fs.realpath(await tmpDir("craftar-proc-"));
    cleanups.push(() => fs.rm(cwd, { recursive: true, force: true }));
    const script = [
      "const fs = require('node:fs');",
      "if (fs.realpathSync(process.cwd()) !== process.argv[1]) process.exit(4);",
      "if (process.env.DOTNET_NOLOGO !== '1') process.exit(5);",
      "setTimeout(() => process.exit(6), 10000);",
      "process.stdin.on('data', () => {}).on('end', () => process.exit(0));",
    ].join("");
    expect(await spawnInherited({ file: process.execPath, args: node(script, cwd), cwd, env: { ...process.env, DOTNET_NOLOGO: "1" }, stdin: "ignore" })).toEqual({ code: 0 });
  });
  it("rejects when the program does not exist", async () => {
    const cwd = await tmpDir("craftar-proc-");
    cleanups.push(() => fs.rm(cwd, { recursive: true, force: true }));
    await expect(spawnInherited({ file: "craftar-no-such-program", args: [], cwd, env: process.env, stdin: "ignore" })).rejects.toMatchObject({ code: "ENOENT" });
  });
});
