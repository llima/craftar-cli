import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capture, onPath, spawnInherited } from "../src/core/proc.js";
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
  it("runs in the directory it is given", async () => {
    const cwd = await fs.realpath(await tmpDir("craftar-proc-"));
    cleanups.push(() => fs.rm(cwd, { recursive: true, force: true }));
    expect(await capture(process.execPath, node("console.log(require('node:fs').realpathSync(process.cwd()))"), process.env, cwd)).toBe(`${cwd}\n`);
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

// The program is looked up on PATH only — never in the child's working directory (spec 32 §7).
// A copy of node itself, under a name no real program has, is the planted program: it is a real executable on
// every platform, so "it did not run" is a fact about the lookup and not about the file.
const TOOL = "craftar-fake-tool";
const EXE = process.platform === "win32" ? ".exe" : "";
async function planted(): Promise<string> {
  const dir = await fs.realpath(await tmpDir("craftar-proc-planted-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.copyFile(process.execPath, path.join(dir, TOOL + EXE));
  await fs.chmod(path.join(dir, TOOL + EXE), 0o755);
  return dir;
}
/** The process environment with PATH replaced, whatever the key's case (Windows spells it `Path`). */
function withPath(value: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toUpperCase() !== "PATH") env[k] = v;
  env.PATH = value;
  return env;
}

describe("the program lookup never uses the child's working directory", () => {
  it("capture does not run a program planted there — PATH empty, '.', with an empty entry, or without that directory", async () => {
    const cwd = await planted();
    const elsewhere = await fs.realpath(await tmpDir("craftar-proc-elsewhere-"));
    cleanups.push(() => fs.rm(elsewhere, { recursive: true, force: true }));
    for (const value of ["", ".", `${elsewhere}${path.delimiter}`, elsewhere]) {
      await expect(capture(TOOL, ["-e", "console.log('ran')"], withPath(value), cwd), `PATH=${JSON.stringify(value)}`).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("spawnInherited does not run it either", async () => {
    const cwd = await planted();
    for (const value of ["", "."]) {
      await expect(spawnInherited({ file: TOOL, args: ["-e", "process.exit(0)"], cwd, env: withPath(value), stdin: "ignore" }), `PATH=${JSON.stringify(value)}`).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("the same program on PATH, as an absolute entry, is found and runs — from another working directory (control)", async () => {
    const dir = await planted();
    const cwd = await fs.realpath(await tmpDir("craftar-proc-cwd-"));
    cleanups.push(() => fs.rm(cwd, { recursive: true, force: true }));
    expect(await capture(TOOL, ["-e", "console.log('ran')"], withPath(dir), cwd)).toBe("ran\n");
    expect(await spawnInherited({ file: TOOL, args: ["-e", "process.exit(7)"], cwd, env: withPath(dir), stdin: "ignore" })).toEqual({ code: 7 });
  });
});


describe("onPath — where a program is looked for", () => {
  it("finds it in an absolute PATH entry, skipping the empty and the relative ones, and returns its absolute path", async () => {
    const dir = await planted();
    expect(await onPath(TOOL, withPath(`${path.delimiter}.${path.delimiter}${dir}`))).toBe(path.join(dir, TOOL + EXE));
  });

  it("is null when it is on no absolute entry, when PATH is absent, for a relative path, and for a directory of that name", async () => {
    const dir = await planted();
    expect(await onPath(TOOL, withPath(""))).toBeNull();
    expect(await onPath(TOOL, withPath("."))).toBeNull();
    expect(await onPath(TOOL, {})).toBeNull();
    expect(await onPath(`.${path.sep}${TOOL}`, withPath(dir))).toBeNull();
    const other = await fs.realpath(await tmpDir("craftar-proc-dir-"));
    cleanups.push(() => fs.rm(other, { recursive: true, force: true }));
    await fs.mkdir(path.join(other, `craftar-other-tool${EXE}`));
    expect(await onPath("craftar-other-tool", withPath(other))).toBeNull();
  });

  it("an absolute path is returned as given", async () => {
    expect(await onPath(process.execPath, {})).toBe(process.execPath);
  });

  it.runIf(process.platform === "win32")("on Windows: PATH is read whatever its key's case, and a .cmd is not a program", async () => {
    const dir = await planted();
    expect(await onPath(TOOL, { Path: dir })).toBe(path.join(dir, `${TOOL}.exe`));
    const cmds = await fs.realpath(await tmpDir("craftar-proc-cmd-"));
    cleanups.push(() => fs.rm(cmds, { recursive: true, force: true }));
    await fs.writeFile(path.join(cmds, "craftar-cmd-tool.cmd"), "@echo ran\r\n");
    expect(await onPath("craftar-cmd-tool", { PATH: cmds })).toBeNull();
  });

  it.runIf(process.platform !== "win32")("elsewhere: a file that is not executable is not a program", async () => {
    const dir = await fs.realpath(await tmpDir("craftar-proc-plain-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, "craftar-plain-tool"), "#!/bin/sh\n", { mode: 0o644 });
    expect(await onPath("craftar-plain-tool", withPath(dir))).toBeNull();
  });

  it("a relative PATH entry is not looked in, even when it leads to the program from craftar's own working directory", async () => {
    // Under node_modules/ so that the entry can be spelled relative to this process on every platform (a temp
    // directory is on another drive on Windows CI).
    const dir = await fs.mkdtemp(path.join(process.cwd(), "node_modules", ".craftar-proc-rel-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.copyFile(process.execPath, path.join(dir, TOOL + EXE));
    await fs.chmod(path.join(dir, TOOL + EXE), 0o755);
    const relative = path.relative(process.cwd(), dir);
    expect(path.isAbsolute(relative)).toBe(false);
    expect(await onPath(TOOL, withPath(relative))).toBeNull();
    expect(await onPath(TOOL, withPath(`.${path.sep}${relative}`))).toBeNull();
    expect(await onPath(TOOL, withPath(dir))).toBe(path.join(dir, TOOL + EXE));
  });
});