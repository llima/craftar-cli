import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCli } from "./helpers/cli.js";
import { acmePrimary } from "./helpers/agents-md-primary.js";
import type { Scenario } from "./helpers/forge.js";

// Spec 41 §4.10: drift promote never carries a reworded text into the Forge (D20); drift show says why.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "craftar-test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "craftar-test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
});
function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "maintenance.auto", "false"]);
  execFileSync("git", ["-C", dir, "config", "gc.auto", "0"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"], { env: gitEnv() });
}
const porcelain = (dir: string) => execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });

const AGENT = ".claude/agents/api-reviewer.md";
const D20 = `${AGENT} holds references agents-md.primary reworded — edit the Forge's ingredient`;

async function editedAgent(primary: boolean): Promise<Scenario> {
  const s = kept(await acmePrimary({ schema: 5, params: primary ? { "agents-md.primary": true } : undefined }));
  gitInit(s.forgeRoot);
  expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
  await fs.appendFile(path.join(s.wsRoot, AGENT), "One more line by hand.\n");
  return s;
}

describe("drift and agents-md.primary (spec 41 §4.10)", () => {
  it("drift show: a hand-edited file the mode reworded is not promotable, with the reason", async () => {
    const s = await editedAgent(true);
    const r = runCli(["drift", "show", "--json", "--workspace", s.wsRoot]);
    const row = JSON.parse(r.stdout).files.find((f: { path: string }) => f.path === AGENT);
    expect(row).toMatchObject({ path: AGENT, state: "drift", promotable: false, reason: "reworded by agents-md.primary" });
  });

  it("drift promote: refused with D20, the Forge untouched", async () => {
    const s = await editedAgent(true);
    const r = runCli(["drift", "promote", AGENT, "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(D20);
    expect(porcelain(s.forgeRoot)).toBe("");
  });

  it("(control) mode off: the same hand edit is promotable", async () => {
    const s = await editedAgent(false);
    const r = runCli(["drift", "show", "--json", "--workspace", s.wsRoot]);
    const row = JSON.parse(r.stdout).files.find((f: { path: string }) => f.path === AGENT);
    expect(row).toMatchObject({ path: AGENT, state: "drift", promotable: true, reason: null });
  });
});
