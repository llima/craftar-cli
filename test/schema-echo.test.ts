import { promises as fs } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { exists } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, profile, recipe, rule, scenario, tmpDir, writeFiles } from "./helpers/forge.js";

// No command prints a value read from a file the schema refuses, nor the text of a file that is not valid JSON.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const M = ["ZZ", "MARKER", "ZZ"].join("");
const URL = `https://user:${M}@pkgs.example.com/x`;
const COMMANDS: string[][] = [["status"], ["sync"], ["forge", "variants"], ["recipes"], ["ingredients"], ["ls"], ["diff"]];
const WORKSPACE_COMMANDS: string[][] = [["status"], ["sync"], ["ls"], ["diff"]];
const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A Forge file the schema refuses, the credential sitting where the refused value is. */
const REFUSED: Record<string, { text: string; fault: string }> = {
  "profiles/acme/profile.yaml": {
    text: `name: acme\nrecipes: [base]\nscm:\n  kind: ${URL}\n`,
    fault: "scm.kind: Invalid enum value. Expected 'azure-devops' | 'github' | 'gitlab' | 'other'",
  },
  "ingredients/rules/style/ingredient.yaml": {
    text: `type: rule\nname: style\ntargets: ${URL}\n`,
    fault: 'targets: Invalid input (Expected array, received string | Invalid literal value, expected "*")',
  },
  "craftar.forge.yaml": {
    text: `name: test-forge\nschema: ${URL}\n`,
    fault: "schema: Invalid input (Invalid literal value, expected 1 | Invalid literal value, expected 2)",
  },
};

async function fresh() {
  const s = await scenario(
    { ingredients: [rule("style", "# Style\n")], recipes: [recipe("base", ["rule/style"])], profiles: [profile("acme", ["base"])] },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  return s;
}

describe("a Forge file the schema refuses, with a credential as the refused value", () => {
  it.each(Object.keys(REFUSED))("%s: every command exits 1 with one line naming the file and the key; the value is nowhere", async (rel) => {
    const s = await fresh();
    await writeFiles(s.forgeRoot, { [rel]: REFUSED[rel].text });
    for (const command of COMMANDS) {
      const r = runCli([...command, "--workspace", s.wsRoot]);
      const where = `${command.join(" ")} / ${rel}`;
      expect(r.code, where).toBe(1);
      expect(r.stdout + r.stderr, where).not.toContain(M);
      expect(r.stderr, where).toMatch(new RegExp(`^error: invalid \\S*${re(path.basename(rel))}: ${re(REFUSED[rel].fault)}\\n$`));
    }
    expect(await exists(path.join(s.wsRoot, ".claude"))).toBe(false);
    expect(await exists(path.join(s.wsRoot, "craftar.lock"))).toBe(false);
  });

  it("doctor reports it as one config line: the file, the first key, never the value", async () => {
    const s = await fresh();
    await writeFiles(s.forgeRoot, { "profiles/acme/profile.yaml": REFUSED["profiles/acme/profile.yaml"].text });
    const r = runCli(["doctor", "--json", "--workspace", s.wsRoot]);
    expect(r.stdout + r.stderr).not.toContain(M);
    const config = JSON.parse(r.stdout).checks.filter((c: { id: string }) => c.id === "config");
    expect(config).toHaveLength(1);
    expect(config[0].level).toBe("error");
    expect(config[0].message).toMatch(/^invalid \S*profile\.yaml \(scm\.kind: Invalid enum value\. Expected 'azure-devops' \| 'github' \| 'gitlab' \| 'other'\)$/);
  });

  it("two refused keys: the command names both on one line, doctor the first and how many follow", async () => {
    const s = await fresh();
    await writeFiles(s.forgeRoot, { "profiles/acme/profile.yaml": `name: acme\nrecipes: [base]\nscm:\n  kind: ${URL}\n  prTool: ${URL}\n` });
    const r = runCli(["status", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).not.toContain(M);
    expect(r.stderr).toMatch(
      /^error: invalid \S*profile\.yaml: scm\.kind: Invalid enum value\. Expected 'azure-devops' \| 'github' \| 'gitlab' \| 'other'; scm\.prTool: Invalid enum value\. Expected 'az' \| 'rest' \| 'gh' \| 'glab'\n$/,
    );
    const d = runCli(["doctor", "--json", "--workspace", s.wsRoot]);
    expect(d.stdout + d.stderr).not.toContain(M);
    const config = JSON.parse(d.stdout).checks.filter((c: { id: string }) => c.id === "config");
    expect(config[0].message).toMatch(/^invalid \S*profile\.yaml \(scm\.kind: Invalid enum value\. Expected 'azure-devops' \| 'github' \| 'gitlab' \| 'other', and 1 more\)$/);
  });
});

describe("a craftar.yaml the schema refuses, with a credential as the refused value", () => {
  it("every workspace command exits 1 naming the file and the key, never the value", async () => {
    const s = await fresh();
    await fs.appendFile(path.join(s.wsRoot, "craftar.yaml"), `targets:\n  - ${URL}\n`);
    for (const command of WORKSPACE_COMMANDS) {
      const r = runCli([...command, "--workspace", s.wsRoot]);
      const where = command.join(" ");
      expect(r.code, where).toBe(1);
      expect(r.stdout + r.stderr, where).not.toContain(M);
      expect(r.stderr, where).toBe("error: invalid craftar.yaml: targets.0: Invalid enum value. Expected 'claude-code' | 'kiro' | 'agents-md'\n");
    }
    const d = runCli(["doctor", "--json", "--workspace", s.wsRoot]);
    expect(d.stdout + d.stderr).not.toContain(M);
  });
});

describe("a craftar.lock that does not read", () => {
  it("not valid JSON: the commands say so and quote nothing of the file", async () => {
    const s = await fresh();
    await fs.writeFile(path.join(s.wsRoot, "craftar.lock"), `{"schema": 2, "k": ${M}}\n`);
    for (const command of [["status"], ["sync"], ["diff"]]) {
      const r = runCli([...command, "--workspace", s.wsRoot]);
      const where = command.join(" ");
      expect(r.code, where).toBe(1);
      expect(r.stdout + r.stderr, where).not.toContain(M);
      expect(r.stderr, where).toBe("error: craftar.lock is not valid JSON\n");
    }
    const d = runCli(["doctor", "--json", "--workspace", s.wsRoot]);
    expect(d.stdout + d.stderr).not.toContain(M);
    const lock = JSON.parse(d.stdout).checks.filter((c: { id: string }) => c.id === "lock");
    expect(lock).toHaveLength(1);
    expect(lock[0].level).toBe("error");
    expect(lock[0].message).toBe("craftar.lock is not valid JSON");
  });

  it("refused by the schema: the commands name the lock and the keys, never a value", async () => {
    const s = await fresh();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    const file = path.join(s.wsRoot, "craftar.lock");
    const lock = JSON.parse(await fs.readFile(file, "utf8"));
    lock.files[0].target = M;
    await fs.writeFile(file, JSON.stringify(lock, null, 2) + "\n");
    for (const command of [["status"], ["sync"], ["diff"]]) {
      const r = runCli([...command, "--workspace", s.wsRoot]);
      const where = command.join(" ");
      expect(r.code, where).toBe(1);
      expect(r.stdout + r.stderr, where).not.toContain(M);
      expect(r.stderr, where).toBe("error: craftar.lock is not a valid lock: files.0.target: Invalid enum value. Expected 'claude-code' | 'kiro' | 'agents-md'\n");
    }
    const d = runCli(["doctor", "--json", "--workspace", s.wsRoot]);
    expect(d.stdout + d.stderr).not.toContain(M);
    const check = JSON.parse(d.stdout).checks.filter((c: { id: string }) => c.id === "lock");
    expect(check[0].message).toBe("craftar.lock is not a valid lock (files.0.target: Invalid enum value. Expected 'claude-code' | 'kiro' | 'agents-md')");
  });

  it("a lock that cannot be read is not called invalid JSON", async () => {
    const s = await fresh();
    await fs.mkdir(path.join(s.wsRoot, "craftar.lock"));
    const r = runCli(["status", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^error: EISDIR\b/);
    expect(r.stderr).not.toContain("not valid JSON");
  });
});

describe("a registry that is not valid JSON", () => {
  it("workspaces and doctor quote nothing of the file", async () => {
    const file = path.join(process.env.CRAFTAR_HOME!, "registry.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `{"schema": 1, "k": ${M}}\n`);
    cleanups.push(() => fs.rm(file, { force: true }));
    const s = await fresh();
    const w = runCli(["workspaces"]);
    expect(w.stdout + w.stderr).not.toContain(M);
    expect(w.stdout + w.stderr).toContain("not valid JSON");
    const d = runCli(["doctor", "--json", "--workspace", s.wsRoot]);
    expect(d.stdout + d.stderr).not.toContain(M);
    const registry = JSON.parse(d.stdout).checks.filter((c: { id: string }) => c.id === "registry");
    expect(registry).toHaveLength(1);
    expect(registry[0].level).toBe("error");
    expect(registry[0].message).toMatch(/^cannot read \S*registry\.json: not valid JSON$/);
  });
});

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
}

describe("forge unify --plan with a plan the schema refuses", () => {
  it("the error names the file and the keys on one line, never the refused value", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })], profiles: [profile("acme", [])] });
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "add", "-A"]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "init"], { env: gitEnv() });

    const planDir = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(planDir, { recursive: true, force: true }));
    const planPath = path.join(planDir, "plan.yaml");
    await fs.writeFile(planPath, `schema: ${URL}\n`);

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--plan", planPath, "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stdout + r.stderr).not.toContain(M);
    expect(r.stderr).toMatch(new RegExp(`^error: ${re(planPath)}: schema: Invalid literal value, expected 1; [^\\n]*\\n$`));
  });
});
