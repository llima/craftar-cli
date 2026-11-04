import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpDir } from "./forge.js";
import { removeWithRetry } from "./fs.js";

// No test starts Docker (node-cli.md § Local services). The CLI's Compose calls are exercised with a fake docker,
// the trick of fake-git.ts: a copy of node named `docker` (`docker.exe` on win32) alone on the child's PATH, and
// NODE_OPTIONS preloading a hook that acts only in that copy. Node takes docker's first argument (`compose`) as its
// script, so the hook reads the rest from process.argv, records the call with its working directory, and answers:
// `compose version --short` prints 2.30.0, `ps` prints an empty list, anything else exits 0.

const EXE = process.platform === "win32" ? ".exe" : "";

const HOOK = `"use strict";
const fs = require("fs");
const path = require("path");
if (path.basename(process.execPath).toLowerCase().replace(/\\.exe$/, "") === "docker") {
  const script = process.argv[1] ? path.basename(process.argv[1]) : "";
  const args = [script, ...process.argv.slice(2)];
  const log = process.env.CRAFTAR_TEST_DOCKER_LOG;
  if (log) fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
  if (args[1] === "version") process.stdout.write("2.30.0\\n");
  else if (args.includes("ps")) process.stdout.write("[]\\n");
  process.exit(0);
}
`;

export interface FakeDocker {
  dir: string;
  log: string;
  /** The env for runCli: the fake alone on PATH, the hook preloaded, the log named. */
  env: (extra?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

export async function fakeDocker(): Promise<FakeDocker> {
  const dir = await fs.realpath(await tmpDir("craftar-fake-docker-"));
  const docker = path.join(dir, "docker" + EXE);
  await fs.copyFile(process.execPath, docker);
  await fs.chmod(docker, 0o755);
  const hook = path.join(dir, "hook.cjs");
  await fs.writeFile(hook, HOOK);
  const log = path.join(dir, "docker.log");
  return {
    dir,
    log,
    // NODE_OPTIONS reads `\` inside double quotes as an escape: on win32 the hook's path is given with `/`.
    env: (extra = {}) => ({ PATH: dir, Path: dir, NODE_OPTIONS: `--require "${hook.replace(/\\/g, "/")}"`, CRAFTAR_TEST_DOCKER_LOG: log, ...extra }),
    cleanup: () => removeWithRetry(dir),
  };
}

export interface DockerCall {
  args: string[];
  cwd: string;
}

export async function readDockerLog(log: string): Promise<DockerCall[]> {
  const text = await fs.readFile(log, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as DockerCall);
}
