import { promises as fs } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { exists } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, profile, recipe, rule, scenario, tmpDir, writeFiles } from "./helpers/forge.js";

// No command prints the source of a Forge YAML file: neither a syntax error's line nor a yaml warning's.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const M = ["ZZ", "MARKER", "ZZ"].join("");
const URL = `https://user:${M}@pkgs.example.com/x`;
const BROKEN = `zz:\n  - k: v\n   url: ${URL}\n`;
const HEADS: Record<string, string> = {
  "craftar.forge.yaml": "name: test-forge\nschema: 1\n",
  "recipes/base.yaml": "name: base\ningredients: [rule/style]\n",
  "profiles/acme/profile.yaml": "name: acme\nrecipes: [base]\n",
  "ingredients/rules/style/ingredient.yaml": "type: rule\nname: style\n",
};
const COMMANDS: string[][] = [["status"], ["sync"], ["forge", "variants"], ["recipes"], ["ingredients"], ["ls"], ["diff"]];

async function fresh() {
  const s = await scenario(
    { ingredients: [rule("style", "# Style\n")], recipes: [recipe("base", ["rule/style"])], profiles: [profile("acme", ["base"])] },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  return s;
}

describe("a Forge file with a YAML syntax error on a line holding a credential", () => {
  it.each(Object.keys(HEADS))("%s: every command exits 1 naming the file and the place; the line is nowhere", async (rel) => {
    const s = await fresh();
    await writeFiles(s.forgeRoot, { [rel]: HEADS[rel] + BROKEN });
    for (const command of COMMANDS) {
      const r = runCli([...command, "--workspace", s.wsRoot]);
      const where = `${command.join(" ")} / ${rel}`;
      expect(r.code, where).toBe(1);
      expect(r.stdout + r.stderr, where).not.toContain(M);
      expect(r.stderr, where).toMatch(new RegExp(`^error: invalid \\S*${path.basename(rel).replace(/\./g, "\\.")}: MISSING_CHAR at line 5, column 1\\n$`));
    }
    expect(await exists(path.join(s.wsRoot, ".claude"))).toBe(false);
    expect(await exists(path.join(s.wsRoot, "craftar.lock"))).toBe(false);
  });

  it("doctor reports it as one config line without the source", async () => {
    const s = await fresh();
    await writeFiles(s.forgeRoot, { "profiles/acme/profile.yaml": HEADS["profiles/acme/profile.yaml"] + BROKEN });
    const r = runCli(["doctor", "--json", "--workspace", s.wsRoot]);
    expect(r.stdout + r.stderr).not.toContain(M);
    const config = JSON.parse(r.stdout).checks.filter((c: { id: string }) => c.id === "config");
    expect(config).toHaveLength(1);
    expect(config[0].level).toBe("error");
    expect(config[0].message).toMatch(/^invalid \S*profile\.yaml: MISSING_CHAR at line 5, column 1$/);
  });
});

describe("a Forge file that loads, with a tag YAML cannot resolve on a line holding a credential", () => {
  it("every command runs as before and prints no yaml warning", async () => {
    const s = await fresh();
    await fs.writeFile(path.join(s.forgeRoot, "profiles/acme/profile.yaml"), `name: acme\nrecipes: [base]\ndescription: !secret ${URL}\n`);
    for (const command of COMMANDS) {
      const r = runCli([...command, "--workspace", s.wsRoot]);
      const where = command.join(" ");
      expect(r.code, where).toBe(0);
      expect(r.stdout + r.stderr, where).not.toContain(M);
      expect(r.stderr, where).not.toContain("YAMLWarning");
    }
  });
});

/** A fake but stable identity, so `git commit` never depends on the host's ambient config. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "craftar-test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "craftar-test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "maintenance.auto", "false"]);
  execFileSync("git", ["-C", dir, "config", "gc.auto", "0"]);
}

function gitCommitAll(dir: string, message: string): void {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", message], { env: gitEnv() });
}

describe("forge unify --plan with a plan that is not valid YAML", () => {
  it("the error names the file and the place, never the line", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })], profiles: [profile("acme", [])] });
    gitInit(root);
    gitCommitAll(root, "init");

    const planDir = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(planDir, { recursive: true, force: true }));
    const planPath = path.join(planDir, "plan.yaml");
    await fs.writeFile(planPath, BROKEN);

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--plan", planPath, "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).not.toContain(M);
    expect(r.stderr).toBe(`error: invalid ${planPath}: MISSING_CHAR at line 3, column 1\n`);
  });
});
