import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { templatedMetadataEdit } from "../src/core/metadata-params.js";
import { FORGE_SCHEMA_METADATA_PARAMS } from "../src/schema/index.js";
import { runCli } from "./helpers/cli.js";
import { acmeMeta } from "./helpers/metadata-params.js";

/** Spec 50 §5.6: drift promote refuses a hand edit of a templated metadata field; drift show says why (§11 items 19, 22). */

const GATE = FORGE_SCHEMA_METADATA_PARAMS;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
type Scenario = Awaited<ReturnType<typeof acmeMeta>>;
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
  execFileSync("git", ["-C", dir, "config", "gc.auto", "0"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"], { env: gitEnv() });
}
const porcelain = (dir: string) => execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });

const RULE = ".claude/rules/paths.md";
const COMMAND = ".claude/commands/ship.md";
const REASON = "metadata renders a parameter";

async function synced(schema = GATE): Promise<Scenario> {
  const s = kept(await acmeMeta({ schema }));
  gitInit(s.forgeRoot);
  const r = runCli(["sync", "--workspace", s.wsRoot]);
  expect(r.code, r.stderr).toBe(0);
  return s;
}
async function edit(s: Scenario, rel: string, from: string, to: string) {
  const abs = path.join(s.wsRoot, rel);
  const text = await fs.readFile(abs, "utf8");
  expect(text).toContain(from);
  await fs.writeFile(abs, text.replace(from, to));
}
const rowOf = (s: Scenario, rel: string) =>
  JSON.parse(runCli(["drift", "show", "--json", "--workspace", s.wsRoot]).stdout).files.find((f: { path: string }) => f.path === rel);

describe("spec 50 §5.6: drift and a templated metadata field", () => {
  it("drift show: an edit to paths: the base renders from {{glob}} is not promotable, with a reason of its own (item 22)", async () => {
    const s = await synced();
    await edit(s, RULE, "paths: src/**", "paths: lib/**");
    expect(rowOf(s, RULE)).toMatchObject({ state: "drift", promotable: false, reason: REASON });
  });

  it("drift promote: refused before any write, the Forge untouched (item 19)", async () => {
    const s = await synced();
    await edit(s, RULE, "paths: src/**", "paths: lib/**");
    const r = runCli(["drift", "promote", RULE, "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${RULE} changes frontmatterRaw, which the Forge renders from a parameter`);
    expect(r.stderr).not.toContain("lib/**");
    expect(porcelain(s.forgeRoot)).toBe("");
  });

  it("a command's argument-hint edited by hand is refused too", async () => {
    const s = await synced();
    await edit(s, COMMAND, "argument-hint: <acme-version>", "argument-hint: <tag>");
    expect(rowOf(s, COMMAND)).toMatchObject({ promotable: false, reason: REASON });
  });

  it("an edit to the body alone carries as today (item 19)", async () => {
    const s = await synced();
    await edit(s, RULE, "# Paths\n", "# Paths\nOne more line by hand.\n");
    expect(rowOf(s, RULE)).toMatchObject({ state: "drift", promotable: true, reason: null });
    const r = runCli(["drift", "promote", RULE, "--workspace", s.wsRoot]);
    expect(r.code, r.stderr).toBe(0);
  });

  it("below the gate the field is literal and the edit is promotable as before", async () => {
    const s = await synced(GATE - 1);
    await edit(s, COMMAND, "argument-hint: <{{org}}-version>", "argument-hint: <tag>");
    expect(rowOf(s, COMMAND)).toMatchObject({ promotable: true, reason: null });
  });
});

describe("templatedMetadataEdit (pure)", () => {
  const cmd = { type: "command", name: "c", description: "Ship {{org}}", argumentHint: "<v>", file: "command.md", targets: "*" } as never;
  it("names a cited field the edit changed, and nothing for an uncited one or the body", () => {
    const planned = "---\ndescription: Ship acme\nargument-hint: <v>\n---\nBody.\n";
    expect(templatedMetadataEdit(cmd, planned, planned.replace("Ship acme", "Ship beta"))).toBe("description");
    expect(templatedMetadataEdit(cmd, planned, planned.replace("<v>", "<w>"))).toBeNull();
    expect(templatedMetadataEdit(cmd, planned, planned.replace("Body.", "Body, edited."))).toBeNull();
  });
  it("reads CRLF as LF", () => {
    const planned = "---\ndescription: Ship acme\nargument-hint: <v>\n---\nBody.\n";
    expect(templatedMetadataEdit(cmd, planned, planned.replace(/\n/g, "\r\n"))).toBeNull();
  });
});
