import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, scenario, type Scenario } from "./helpers/forge.js";

// At the gate sync ignores a value a layer gives craftar.rules.index, so drift promote must not read one either.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const RULE = ".claude/rules/note.md";
const KEY = "craftar.rules.index";

function gitInit(dir: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: "craftar-test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "craftar-test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "maintenance.auto", "false"]);
  execFileSync("git", ["-C", dir, "config", "gc.auto", "0"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"], { env });
}

/** A rule that holds the placeholder inside a line, so no list is expanded and the file stays promotable; the workspace sets the key. */
async function withOverride(schema: number): Promise<Scenario> {
  const s = await scenario(
    {
      ingredients: [{ meta: { type: "rule", name: "note" }, files: { "rule.md": `See {{${KEY}}} here\n` } }],
      recipes: [recipe("base", ["rule/note"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    },
    { config: { profile: "acme", overrides: { params: { [KEY]: "a value" } } } },
  );
  cleanups.push(s.cleanup);
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
  gitInit(s.forgeRoot);
  expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
  await fs.appendFile(path.join(s.wsRoot, RULE), "A hand edit.\n");
  return s;
}

describe("drift promote and a value for craftar.rules.index", () => {
  it("at schema 7 the override is not a reason to refuse", async () => {
    const s = await withOverride(7);
    const r = runCli(["drift", "promote", RULE, "--workspace", s.wsRoot]);
    expect(r.stderr).not.toContain("takes param");
    expect(r.code).toBe(0);
  });

  it("at schema 7 a variant does not list the key as flattened", async () => {
    const s = await withOverride(7);
    const r = runCli(["drift", "promote", RULE, "--json", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.outcome).toBe("variant");
    expect(j.flattened.params).toEqual([]);
  });

  it("below schema 7 the key is an ordinary param, and the override still refuses", async () => {
    const s = await withOverride(6);
    const r = runCli(["drift", "promote", RULE, "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`takes param "${KEY}"`);
  });
});
