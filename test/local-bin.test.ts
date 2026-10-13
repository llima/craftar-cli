import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execProgram, isLocalBin, onPath, pathEntries, spawnInherited } from "../src/core/proc.js";
import { dockerRunner, dockerVersion } from "../src/core/services.js";
import { tmpDir } from "./helpers/forge.js";

// 0.28.2 — `npx craftar` puts `<cwd>/node_modules/.bin`, and every ancestor's, first on PATH. craftar runs in a
// workspace or a Forge, so a program committed there would be the one it runs: those entries are skipped, in the
// lookup and in the PATH the program gets, for git, dotnet and docker alike.
// No test here runs Docker: the planted program is a copy of node under a name no real program has.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const TOOL = "craftar-fake-bin-tool";
const EXE = process.platform === "win32" ? ".exe" : "";
const D = path.delimiter;

/** The process environment with PATH replaced, whatever the key's case (Windows spells it `Path`). */
function withPath(value: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toUpperCase() !== "PATH") env[k] = v;
  env.PATH = value;
  return env;
}

// Two copies of node for the whole file. LOCAL is the very entry npx adds for this process — the
// `node_modules/.bin` of the directory the tests run in. PROJECT is a made-up project elsewhere: its
// `node_modules/.bin` is skipped only when craftar is said to run inside it.
const LOCAL = path.join(process.cwd(), "node_modules", ".bin");
let PROJECT = "";
let PROJECT_BIN = "";
beforeAll(async () => {
  await fs.mkdir(LOCAL, { recursive: true });
  await fs.copyFile(process.execPath, path.join(LOCAL, TOOL + EXE));
  await fs.chmod(path.join(LOCAL, TOOL + EXE), 0o755);
  PROJECT = await fs.realpath(await tmpDir("craftar-local-bin-"));
  PROJECT_BIN = path.join(PROJECT, "node_modules", ".bin");
  await fs.mkdir(path.join(PROJECT, "packages", "app"), { recursive: true });
  await fs.mkdir(PROJECT_BIN, { recursive: true });
  await fs.copyFile(process.execPath, path.join(PROJECT_BIN, TOOL + EXE));
  await fs.chmod(path.join(PROJECT_BIN, TOOL + EXE), 0o755);
});
afterAll(async () => {
  await fs.rm(path.join(LOCAL, TOOL + EXE), { force: true });
  await fs.rm(PROJECT, { recursive: true, force: true });
});

describe("isLocalBin — the node_modules/.bin of a directory or of one above it", () => {
  it("elsewhere: the directory's own, every ancestor's and the root's; nothing else", () => {
    const cwd = "/work/acme/packages/app";
    for (const entry of [
      "/work/acme/packages/app/node_modules/.bin",
      "/work/acme/packages/node_modules/.bin",
      "/work/acme/node_modules/.bin",
      "/work/node_modules/.bin",
      "/node_modules/.bin",
      "/work/acme/node_modules/.bin/",
      "/work/acme//node_modules/./.bin",
      "/work/acme/x/../node_modules/.bin",
    ])
      expect(isLocalBin(entry, cwd, false), entry).toBe(true);
    for (const entry of [
      "/usr/bin",
      "/work/acme/node_modules",
      "/work/acme/node_modules/.bin/sub",
      "/work/acme/packages/app/sub/node_modules/.bin", // below, not above
      "/work/acme/packages/other/node_modules/.bin", // a sibling
      "/work/acme-2/node_modules/.bin", // a name that only starts the same
      "/work/ACME/node_modules/.bin", // another directory: case counts off Windows
      "/home/dev/.npm/_npx/0123abcd/node_modules/.bin", // npx's own cache
      "/usr/lib/node_modules/.bin",
    ])
      expect(isLocalBin(entry, cwd, false), entry).toBe(false);
    expect(isLocalBin("/node_modules/.bin", "/", false)).toBe(true);
  });

  it("win32: either separator, any case, a drive root; another drive is another place", () => {
    const cwd = "C:\\Work\\Acme\\app";
    for (const entry of [
      "C:\\Work\\Acme\\app\\node_modules\\.bin",
      "c:\\work\\acme\\NODE_MODULES\\.BIN",
      "C:/Work/Acme/node_modules/.bin",
      "C:\\Work\\node_modules\\.bin\\",
      "C:\\node_modules\\.bin",
    ])
      expect(isLocalBin(entry, cwd, true), entry).toBe(true);
    for (const entry of ["D:\\Work\\Acme\\node_modules\\.bin", "C:\\Work\\Acme2\\node_modules\\.bin", "C:\\Work\\Acme\\app\\sub\\node_modules\\.bin", "C:\\Program Files\\nodejs", "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\.bin"])
      expect(isLocalBin(entry, cwd, true), entry).toBe(false);
  });
});

describe("pathEntries — the entries npm and npx add are not looked in", () => {
  it("drops them and keeps the order of the rest", () => {
    const cwd = "/work/acme/app";
    const value = ["/work/acme/app/node_modules/.bin", "/work/acme/node_modules/.bin", "/work/node_modules/.bin", "/node_modules/.bin", "/usr/local/bin", "/home/dev/.npm/_npx/0123abcd/node_modules/.bin", "/usr/bin"].join(":");
    expect(pathEntries(value, false, cwd)).toEqual(["/usr/local/bin", "/home/dev/.npm/_npx/0123abcd/node_modules/.bin", "/usr/bin"]);
    // From another directory the same entries are ordinary absolute ones.
    expect(pathEntries(value, false, "/srv/other")).toEqual(["/work/acme/app/node_modules/.bin", "/work/acme/node_modules/.bin", "/work/node_modules/.bin", "/usr/local/bin", "/home/dev/.npm/_npx/0123abcd/node_modules/.bin", "/usr/bin"]);
  });

  it("win32: the same, quoted or not", () => {
    const value = ['"C:\\Work\\Acme\\node_modules\\.bin"', "c:/work/node_modules/.bin", "C:\\Windows"].join(";");
    expect(pathEntries(value, true, "C:\\Work\\Acme\\app")).toEqual(["C:\\Windows"]);
  });

  it("by default the directory is the one this process runs in", () => {
    expect(pathEntries([LOCAL, PROJECT_BIN].join(D))).toEqual([PROJECT_BIN]);
  });
});

describe("onPath — a program in such an entry is not found", () => {
  it("not in the node_modules/.bin of the directory craftar runs in, nor of one above it; found from elsewhere (control)", async () => {
    const env = withPath(PROJECT_BIN);
    expect(await onPath(TOOL, env, PROJECT)).toBeNull();
    expect(await onPath(TOOL, env, path.join(PROJECT, "packages", "app"))).toBeNull();
    const elsewhere = await fs.realpath(await tmpDir("craftar-local-bin-elsewhere-"));
    cleanups.push(() => fs.rm(elsewhere, { recursive: true, force: true }));
    expect(await onPath(TOOL, env, elsewhere)).toBe(path.join(PROJECT_BIN, TOOL + EXE));
  });

  it("the entry npx adds for this very process is skipped, and the next entry that has the program is taken", async () => {
    expect(await onPath(TOOL, withPath(LOCAL))).toBeNull();
    expect(await onPath(TOOL, withPath([LOCAL, PROJECT_BIN].join(D)))).toBe(path.join(PROJECT_BIN, TOOL + EXE));
  });
});

describe("running a program — the lookup and the PATH the program gets", () => {
  it("execProgram and spawnInherited do not run a program that is only in this process's node_modules/.bin", async () => {
    await expect(execProgram(TOOL, ["-e", "console.log('ran')"], { env: withPath(LOCAL) })).rejects.toMatchObject({ code: "ENOENT" });
    await expect(spawnInherited({ file: TOOL, args: ["-e", "process.exit(0)"], cwd: PROJECT, env: withPath(LOCAL), stdin: "ignore" })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("the program they run gets a PATH without that entry — what it starts in turn is not found there either", async () => {
    const env = withPath([LOCAL, PROJECT_BIN, LOCAL].join(D));
    expect((await execProgram(TOOL, ["-e", "console.log(process.env.PATH)"], { env })).stdout).toBe(`${PROJECT_BIN}\n`);
    const script = `process.exit(process.env.PATH === ${JSON.stringify(PROJECT_BIN)} ? 0 : 9)`;
    expect(await spawnInherited({ file: TOOL, args: ["-e", script], cwd: PROJECT, env, stdin: "ignore" })).toEqual({ code: 0 });
  });
});

describe("docker is found as git and dotnet are", () => {
  /** `dockerRunner` reads the process's own PATH: set it for one call, and put it back. */
  async function withProcessPath<T>(value: string, body: () => Promise<T>): Promise<T> {
    const keys = Object.keys(process.env).filter((k) => k.toUpperCase() === "PATH");
    const saved = keys.map((k) => [k, process.env[k]] as const);
    for (const k of keys) delete process.env[k];
    process.env.PATH = value;
    try {
      return await body();
    } finally {
      delete process.env.PATH;
      for (const [k, v] of saved) process.env[k] = v;
    }
  }

  it("the runner does not start a program that is only in this process's node_modules/.bin", async () => {
    const outcome = await withProcessPath(LOCAL, () => dockerRunner(TOOL, ["-e", "console.log('ran')"]).then((r) => `ran with code ${r.code}`, (e: NodeJS.ErrnoException) => e.code));
    expect(outcome).toBe("ENOENT");
  });

  it("nor one reached only by a relative PATH entry or an empty one — the rule git and dotnet have had since 0.27.2", async () => {
    const relative = path.relative(process.cwd(), LOCAL);
    for (const value of [relative, `.${path.sep}${relative}`, "", "."]) {
      const outcome = await withProcessPath(value, () => dockerRunner(TOOL, ["-e", "console.log('ran')"]).then((r) => `ran with code ${r.code}`, (e: NodeJS.ErrnoException) => e.code));
      expect(outcome, `PATH=${JSON.stringify(value)}`).toBe("ENOENT");
    }
  });

  it("on another absolute entry it runs: stdout, stderr and the exit code come back as before (control)", async () => {
    const ok = await withProcessPath(PROJECT_BIN, () => dockerRunner(TOOL, ["-e", "console.log('out'); console.error('err')"]));
    expect(ok).toEqual({ code: 0, stdout: "out\n", stderr: "err\n" });
    const failed = await withProcessPath(PROJECT_BIN, () => dockerRunner(TOOL, ["-e", "console.log('out'); console.error('err'); process.exit(3)"]));
    expect(failed).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
  });

  it("a docker that is only there reads as no docker at all", async () => {
    // What `services` and `doctor` ask: `docker compose version --short`, here of a program named docker that is not found.
    const info = await withProcessPath(LOCAL, () => dockerVersion((_file, args) => dockerRunner(TOOL, args)));
    expect(info).toEqual({ available: false, compose: null, belowFloor: false, reason: "no docker" });
  });
});
