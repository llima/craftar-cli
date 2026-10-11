import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exists, listFiles } from "../src/core/forge.js";
import { onPath } from "../src/core/proc.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, scenario, writeFiles } from "./helpers/forge.js";
import { git } from "./helpers/remote.js";

// git is looked for in the absolute entries of PATH only — never in craftar's working directory, which is a
// workspace or a Forge: directories that come from a clone. A `git` planted there must not run.
// Off Windows the planted program is a script that leaves a mark and answers like git: without the lookup it RUNS
// for an empty PATH entry. On Windows it is a .cmd, which no shell-less spawn runs either way — there the proof is
// test/proc.test.ts (a real executable planted in the child's directory) and the scan below.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const WIN = process.platform === "win32";
const FAKE_SHA = "feedface".repeat(5);
const MARK = "planted-git-ran.txt";
const PLANTED: Record<string, string> = WIN
  ? { "git.cmd": `@echo ran>> ${MARK}\r\n@echo ${FAKE_SHA}\r\n` }
  : { git: `#!/bin/sh\necho ran >> ${MARK}\ncase "$1" in --version) echo "git version 9.9.9";; *) echo ${FAKE_SHA};; esac\n` };

async function planted() {
  const s = await scenario(
    { ingredients: [rule("style", "# Style\n")], recipes: [recipe("base", ["rule/style"])], profiles: [profile("acme", ["base"])] },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  for (const root of [s.wsRoot, s.forgeRoot]) {
    await writeFiles(root, PLANTED);
    if (!WIN) await fs.chmod(path.join(root, "git"), 0o755);
  }
  return s;
}
/** PATH values under which the platform's own lookup reaches the working directory before, or instead of, the real git. */
async function paths(): Promise<string[]> {
  const real = await onPath("git", process.env);
  expect(real, "the real git must be on an absolute PATH entry to run this test").not.toBeNull();
  const dir = path.dirname(real!);
  return ["", ".", `${path.delimiter}${dir}`, `.${path.delimiter}${dir}`];
}
const run = (args: string[], cwd: string, PATH: string) => runCli(args, { cwd, env: { PATH, Path: PATH } });

describe("a git planted in craftar's working directory is never run", () => {
  it("in a workspace: status, doctor and ls", async () => {
    const s = await planted();
    for (const PATH of await paths()) {
      for (const args of [["status"], ["doctor"], ["doctor", "--json"], ["ls"]]) {
        const r = run(args, s.wsRoot, PATH);
        expect(r.stdout + r.stderr, `${args.join(" ")}, PATH=${JSON.stringify(PATH)}`).not.toContain(FAKE_SHA);
        expect(r.stdout + r.stderr, `${args.join(" ")}, PATH=${JSON.stringify(PATH)}`).not.toContain("9.9.9");
      }
    }
    expect(await exists(path.join(s.wsRoot, MARK))).toBe(false);
    expect(await exists(path.join(s.forgeRoot, MARK))).toBe(false);
  });

  it("in a Forge: forge variants, recipes and ingredients with --forge .", async () => {
    const s = await planted();
    for (const PATH of await paths()) {
      for (const args of [["forge", "variants", "--forge", "."], ["recipes", "--forge", "."], ["ingredients", "--forge", ".", "--profile", "acme"]]) {
        const r = run(args, s.forgeRoot, PATH);
        expect(r.code, `${args.join(" ")}, PATH=${JSON.stringify(PATH)}`).toBe(0);
        expect(r.stdout + r.stderr, `${args.join(" ")}, PATH=${JSON.stringify(PATH)}`).not.toContain(FAKE_SHA);
      }
    }
    expect(await exists(path.join(s.forgeRoot, MARK))).toBe(false);
  });

  it("with the real git on PATH after an empty entry, the commands answer as they do with a clean PATH (control)", async () => {
    const s = await planted();
    const dir = path.dirname((await onPath("git", process.env))!);
    for (const args of [["status"], ["ls"]]) {
      const clean = run(args, s.wsRoot, dir);
      const dirty = run(args, s.wsRoot, `${dir}${path.delimiter}`);
      expect([dirty.code, dirty.stdout], args.join(" ")).toEqual([clean.code, clean.stdout]);
    }
  });

  it.runIf(!WIN)("an ssh planted there is not what git starts for an ssh Forge", async () => {
    const s = await planted();
    await writeFiles(s.wsRoot, { ssh: `#!/bin/sh\necho ran >> planted-ssh-ran.txt\nexit 1\n`, "craftar.yaml": "forge: ssh://git@127.0.0.1:1/acme/forge.git\nprofile: acme\n" });
    await fs.chmod(path.join(s.wsRoot, "ssh"), 0o755);
    const dir = path.dirname((await onPath("git", process.env))!);
    const mark = path.join(s.wsRoot, "planted-ssh-ran.txt");
    // Nothing of the developer's git or ssh setup decides which ssh git starts.
    const status = (PATH: string) =>
      runCli(["status"], { cwd: s.wsRoot, env: { PATH, Path: PATH, GIT_SSH: undefined, GIT_SSH_COMMAND: undefined, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" } });

    for (const PATH of [`${path.delimiter}${dir}`, `.${path.delimiter}${dir}`]) {
      expect(status(PATH).code, `PATH=${JSON.stringify(PATH)}`).toBe(1);
    }
    expect(await exists(mark)).toBe(false);

    // Positive control: the same ssh in a directory PATH names by its absolute path IS what git starts (it leaves
    // its mark in git's working directory, the workspace) — so its absence above is the lookup's doing, not this
    // environment's.
    const tools = path.join(s.root, "tools");
    await fs.mkdir(tools);
    await fs.copyFile(path.join(s.wsRoot, "ssh"), path.join(tools, "ssh"));
    await fs.chmod(path.join(tools, "ssh"), 0o755);
    expect(status(`${tools}${path.delimiter}${dir}`).code).toBe(1);
    expect(await exists(mark)).toBe(true);
  });
});

describe("one runner (the lookup cannot be bypassed)", () => {
  it("src/core/proc.ts is the only file under src/ that imports node:child_process", async () => {
    const src = path.resolve(__dirname, "..", "src");
    const offenders: string[] = [];
    for (const f of await listFiles(src)) {
      if (!f.endsWith(".ts") || f === "core/proc.ts") continue;
      if (/["']node:child_process["']|["']child_process["']/.test(await fs.readFile(path.join(src, f), "utf8"))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe("a workspace in sync whose git is no longer found", () => {
  it("the next writing sync rewrites craftar.lock once, forge.commit going from the sha to null; no file changes, no gate flips", async () => {
    const s = await scenario(
      { ingredients: [rule("style", "# Style\n")], recipes: [recipe("base", ["rule/style"])], profiles: [profile("acme", ["base"])] },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    git(s.forgeRoot, "init", "-q");
    git(s.forgeRoot, "add", "-A");
    git(s.forgeRoot, "commit", "-q", "-m", "forge");
    const sha = git(s.forgeRoot, "rev-parse", "HEAD").trim();
    const dir = path.dirname((await onPath("git", process.env))!);
    const lock = async () => JSON.parse(await fs.readFile(path.join(s.wsRoot, "craftar.lock"), "utf8"));
    const files = async () => Object.fromEntries(await Promise.all((await listFiles(s.wsRoot)).filter((f) => f !== "craftar.lock").map(async (f) => [f, await fs.readFile(path.join(s.wsRoot, f), "base64")] as const)));

    expect(run(["sync"], s.wsRoot, dir).code).toBe(0);
    expect((await lock()).forge.commit).toBe(sha);
    const before = await files();

    // git only behind a relative entry: not found
    const relative = `.${path.delimiter}bin`;
    expect(run(["sync", "--check"], s.wsRoot, relative).code).toBe(0);
    expect(run(["status"], s.wsRoot, relative).code).toBe(0);
    expect((await lock()).forge.commit).toBe(sha);
    expect(run(["sync"], s.wsRoot, relative).code).toBe(0);
    expect((await lock()).forge.commit).toBeNull();
    expect(await files()).toEqual(before);

    // once: a second writing sync under the same PATH leaves the lock's bytes alone
    const bytes = await fs.readFile(path.join(s.wsRoot, "craftar.lock"));
    expect(run(["sync"], s.wsRoot, relative).code).toBe(0);
    expect((await fs.readFile(path.join(s.wsRoot, "craftar.lock"))).equals(bytes)).toBe(true);

    // found again: the commit comes back
    expect(run(["sync"], s.wsRoot, dir).code).toBe(0);
    expect((await lock()).forge.commit).toBe(sha);
  });
});
