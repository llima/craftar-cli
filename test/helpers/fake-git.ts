import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpDir } from "./forge.js";

// Spec 37 §10: no test runs a real `git clone` and none reaches the network. The CLI's clone step is exercised with
// a fake git: a copy of node named `git` (`git.exe` on win32) alone on an absolute PATH entry — the trick
// test/local-bin.test.ts uses — and NODE_OPTIONS preloading a hook. The hook does nothing in any process but that
// copy (so the craftar process under test, which inherits NODE_OPTIONS, is untouched). In the copy it reads git's
// argument list from process.argv (node took the first argument, `clone`, as its script) and, for a clone, records
// the call and creates the destination — or exits 128 for a destination named in CRAFTAR_TEST_CLONE_FAIL. Any other
// git call (the Forge load's `git -C <forge> rev-parse HEAD`) exits 1: the commit reads null, as on a machine
// without git (`gitHead`). Nothing is written in the workspace but the destinations.

const EXE = process.platform === "win32" ? ".exe" : "";

const HOOK = `"use strict";
const fs = require("fs");
const path = require("path");
if (path.basename(process.execPath).toLowerCase().replace(/\\.exe$/, "") === "git") {
  const script = process.argv[1] ? path.basename(process.argv[1]) : "";
  if (script !== "clone") process.exit(1);
  const args = ["clone", ...process.argv.slice(2)];
  const log = process.env.CRAFTAR_TEST_CLONE_LOG;
  if (log) fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd(), allow: process.env.GIT_ALLOW_PROTOCOL ?? null, prompt: process.env.GIT_TERMINAL_PROMPT ?? null }) + "\\n");
  const dest = args[args.length - 1];
  const fail = (process.env.CRAFTAR_TEST_CLONE_FAIL || "").split(",").filter(Boolean);
  if (fail.includes(dest)) process.exit(128);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "CLONED"), "");
  process.exit(0);
}
`;

export interface FakeGit {
  dir: string;
  git: string;
  log: string;
  /** The env for runCli: the fake alone on PATH, the hook preloaded, the log named. */
  env: (extra?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

export async function fakeGit(): Promise<FakeGit> {
  const dir = await fs.realpath(await tmpDir("craftar-fake-git-"));
  const git = path.join(dir, "git" + EXE);
  await fs.copyFile(process.execPath, git);
  await fs.chmod(git, 0o755);
  const hook = path.join(dir, "hook.cjs");
  await fs.writeFile(hook, HOOK);
  const log = path.join(dir, "clone.log");
  return {
    dir,
    git,
    log,
    env: (extra = {}) => ({ PATH: dir, Path: dir, NODE_OPTIONS: `--require "${hook}"`, CRAFTAR_TEST_CLONE_LOG: log, ...extra }),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

export interface CloneCall {
  args: string[];
  cwd: string;
  allow: string | null;
  prompt: string | null;
}

export async function readCloneLog(log: string): Promise<CloneCall[]> {
  const text = await fs.readFile(log, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as CloneCall);
}
