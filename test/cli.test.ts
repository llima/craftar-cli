import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { makeForge, profile, recipe, rule, scenario, tmpDir, writeFiles } from "./helpers/forge.js";
import { runCli } from "./helpers/cli.js";
import { exists, listFiles } from "../src/core/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Every file under root with its content, so a before/after comparison catches an in-place edit. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files = await listFiles(root);
  return Object.fromEntries(await Promise.all(files.map(async (f) => [f, await fs.readFile(path.join(root, f), "utf8")] as const)));
}

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
}

function gitCommitAll(dir: string, message: string): void {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", message], { env: gitEnv() });
}

describe("cli", () => {
  it("status prints the unresolved-param warning and exits 0; sync --check still passes", async () => {
    const s = await scenario(
      { ingredients: [rule("a", "Org: {{missing}}\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);

    const st = runCli(["status", "--workspace", s.wsRoot]);
    expect(st.code).toBe(0);
    expect(st.stdout).toContain('param "missing" has no value in any layer');

    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    const check = runCli(["sync", "--check", "--workspace", s.wsRoot]);
    expect(check.code).toBe(0);
    expect(check.stdout).toContain("workspace in sync");
  });

  it("import prints a rejection with its location and never the value", async () => {
    const root = await tmpDir("craftar-cli-import-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const token = "ghp_" + "x".repeat(36);
    await writeFiles(path.join(root, "api"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": JSON.stringify({ mcpServers: { github: { command: "npx", env: { GITHUB_TOKEN: token } } } }),
    });
    const r = runCli(["import", "--from", "claude-code", "--workspace", path.join(root, "api"), "--forge", path.join(root, "forge"), "--profile", "api"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("1 rejected");
    expect(r.stdout).toContain("rejected mcp/github — secret-like value (github-token) in .mcp.json → mcpServers.github.env.GITHUB_TOKEN");
    expect(r.stdout + r.stderr).not.toContain(token);
  });

  it("import fails on a malformed .mcp.json without echoing its content", async () => {
    const root = await tmpDir("craftar-cli-import-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const token = "ghp_" + "x".repeat(36);
    await writeFiles(path.join(root, "api"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": '{"mcpServers":{"gh":{"env":{"T":' + token + "}}}}",
    });
    const r = runCli(["import", "--from", "claude-code", "--workspace", path.join(root, "api"), "--forge", path.join(root, "forge"), "--profile", "api"]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain(".mcp.json is not valid JSON — fix the file and re-run import");
    expect(r.stdout + r.stderr).not.toContain("ghp_");
  });

  it("forge variants lists variants as JSON and leaves the Forge untouched", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("workflow", "a\nb\n"), rule("workflow--acme", "a\nB\n", { as: "workflow" })] });
    const before = await snapshot(root);

    const r = runCli(["forge", "variants", "--forge", root, "--json"]);

    expect(r.code).toBe(0);
    const { groups } = JSON.parse(r.stdout);
    expect(groups).toHaveLength(1);
    expect(groups[0].base).toBe("rule/workflow");
    expect(groups[0].variants[0].profile).toBe("acme");

    const text = runCli(["forge", "variants", "--forge", root]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("1 base with variants, 1 variant total");
    expect(text.stdout).toContain("acme (2 lines, 1 hunk)");

    expect(await snapshot(root)).toEqual(before);
  });

  it("forge variants lists an orphan variant in both modes and still exits 0", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("orphan--acme", "body\n", { as: "orphan" })] });

    const r = runCli(["forge", "variants", "--forge", root, "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      groups: [],
      orphans: [{ ref: "rule/orphan--acme", profile: "acme", missingBase: "rule/orphan" }],
    });

    const text = runCli(["forge", "variants", "--forge", root]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("variant of rule/orphan, which is not in this Forge");
    expect(text.stdout).toContain("1 orphan");
  });

  it("forge variants finds the Forge through a workspace's craftar.yaml", async () => {
    const s = await scenario(
      {
        ingredients: [rule("workflow", "a\nb\n"), rule("workflow--acme", "a\nB\n", { as: "workflow" })],
        recipes: [recipe("base", ["rule/workflow"])],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);

    const r = runCli(["forge", "variants", "--workspace", s.wsRoot, "--json"]);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).groups[0].base).toBe("rule/workflow");
  });

  it("forge variants finds the Forge from the craftar.yaml in the current directory when no flag is given", async () => {
    const s = await scenario(
      {
        ingredients: [rule("workflow", "a\nb\n"), rule("workflow--acme", "a\nB\n", { as: "workflow" })],
        recipes: [recipe("base", ["rule/workflow"])],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    const r = runCli(["forge", "variants", "--json"], { cwd: s.wsRoot });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).groups[0].base).toBe("rule/workflow");
  });

  it("forge commands refuse --forge and --workspace together", () => {
    const r = runCli(["forge", "variants", "--forge", ".", "--workspace", "."]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not both");
  });

  it("forge commands count an empty flag value as given, so an empty --forge still conflicts with --workspace", () => {
    const r = runCli(["forge", "variants", "--forge", "", "--workspace", "."]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not both");
  });

  it("forge commands with no flag outside a workspace name both ways to point at a Forge", async () => {
    const empty = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(empty, { recursive: true, force: true }));
    const r = runCli(["forge", "variants"], { cwd: empty });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--forge");
    expect(r.stderr).toContain("--workspace");
  });

  it("forge commands explain how to point at a Forge when there is no craftar.yaml", async () => {
    const empty = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(empty, { recursive: true, force: true }));
    const r = runCli(["forge", "variants", "--workspace", empty]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--forge");
    expect(r.stderr).toContain("--workspace");
  });

  it("forge variants labels each kind of variant in text mode, and says so when there are none", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [
        rule("edited", "a\nb\n"),
        rule("edited--acme", "a\nB\n", { as: "edited" }),
        rule("meta", "same\n"),
        rule("meta--acme", "same\n", { as: "meta", targets: ["kiro"] }),
        rule("eol", "one\ntwo\n"),
        rule("eol--acme", "one\r\ntwo\r\n", { as: "eol" }),
      ],
    });

    const r = runCli(["forge", "variants", "--forge", root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/acme \(2 lines, 1 hunks?\)/);
    expect(r.stdout).toContain("acme (meta only)");
    expect(r.stdout).toContain("acme (identical after normalization)");
    expect(r.stdout).toContain("3 bases with variants, 3 variants total");

    const empty = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(empty, { recursive: true, force: true }));
    await makeForge(empty, { ingredients: [rule("alone", "x\n")] });
    const none = runCli(["forge", "variants", "--forge", empty]);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain("no variants");
    expect(none.stdout).not.toContain("bases with variants");
  });

  it("forge diff prints hunks per variant, exits 1 on a bad ref or profile, and writes nothing", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [
        rule("workflow", "a\nold\n"),
        rule("workflow--acme", "a\nnew\n", { as: "workflow" }),
        { meta: { type: "command", name: "workflow--acme", as: "workflow" }, files: { "command.md": "unrelated\n" } },
      ],
    });
    const before = await snapshot(root);

    const ok = runCli(["forge", "diff", "rule/workflow", "--forge", root, "--json"]);
    expect(ok.code).toBe(0);
    const report = JSON.parse(ok.stdout);
    expect(report).toHaveLength(1);
    expect(report[0].profile).toBe("acme");
    expect(report[0].distance).toMatchObject({ lines: 2, hunks: 1 });
    expect(report[0].diff.files[0].hunks[0].kind).toBe("inline");

    const text = runCli(["forge", "diff", "rule/workflow", "--forge", root]);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/rule\/workflow {2}base ↔ acme — 2 lines, 1 hunks?/);
    expect(text.stdout).toContain("hunk 1  [inline]  lines 2–2");
    expect(text.stdout).toContain("- old");
    expect(text.stdout).toContain("+ new");

    expect(runCli(["forge", "diff", "rule/nope", "--forge", root]).code).toBe(1);
    expect(runCli(["forge", "diff", "rule/workflow", "--forge", root, "--against", "other"]).code).toBe(1);

    expect(await snapshot(root)).toEqual(before);
  });

  it("forge diff prints one section per variant in ref order, with counts, block hunks and one-sided files", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [
        rule("wf", "a\nold\nc\n"),
        rule("wf--acme", "a\nnew\nc\n", { as: "wf" }),
        { meta: { type: "rule", name: "wf--beta", as: "wf" }, files: { "rule.md": "a\nold\nc\nadded\n", "extra.md": "x\n" } },
        rule("solo", "z\n"),
      ],
    });

    const text = runCli(["forge", "diff", "rule/wf", "--forge", root]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("rule/wf  base ↔ acme — 2 lines, 1 hunk");
    expect(text.stdout).toContain("rule/wf  base ↔ beta — 2 lines, 2 hunks");
    expect(text.stdout).toContain("hunk 1  [block]  after line 3");
    expect(text.stdout).toContain("only in the variant: extra.md");
    expect(text.stdout.indexOf("base ↔ acme")).toBeLessThan(text.stdout.indexOf("base ↔ beta"));

    const beta = runCli(["forge", "diff", "rule/wf", "--forge", root, "--against", "beta"]);
    expect(beta.code).toBe(0);
    expect(beta.stdout).toContain("base ↔ beta");
    expect(beta.stdout).not.toContain("base ↔ acme");

    const solo = runCli(["forge", "diff", "rule/solo", "--forge", root]);
    expect(solo.code).toBe(1);
    expect(solo.stderr).toContain("has no variants");

    const other = runCli(["forge", "diff", "rule/wf", "--forge", root, "--against", "other"]);
    expect(other.code).toBe(1);
    expect(other.stderr).toContain("no variant for profile other");
  });

  it("forge diff marks the side that has no final newline, in text and in JSON", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [rule("eof", "a\nb\n"), rule("eof--acme", "a\nb", { as: "eof" })],
    });

    const text = runCli(["forge", "diff", "rule/eof", "--forge", root]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("\\ No newline at end of file");

    const r = runCli(["forge", "diff", "rule/eof", "--forge", root, "--json"]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(Array.isArray(report)).toBe(true);
    expect(report[0]).toMatchObject({ ref: "rule/eof--acme", profile: "acme" });
    expect(report[0].distance).toHaveProperty("sameBodyDifferentMeta");
    expect(report[0].distance).not.toHaveProperty("metaDiffers");
    expect(report[0].diff.files[0].hunks[0].b.noEofNewline).toBe(true);
  });

  it("forge diff does not take a name ending in -- for a variant with an empty profile", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("workflow", "a\n"), rule("workflow--", "b\n", { as: "workflow" })] });
    const r = runCli(["forge", "diff", "rule/workflow", "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("has no variants");
    expect(r.stderr).not.toContain("TypeError");
  });

  it("forge unify refuses a Forge that is not a git repository", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "variant", "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not a git repository");
  });

  it("forge unify refuses a Forge with uncommitted changes", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    gitInit(root);
    gitCommitAll(root, "init");
    await fs.writeFile(path.join(root, "ingredients/rules/wf/rule.md"), "a-dirty\n");

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "variant", "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("is not a clean git checkout");
  });

  it("forge unify refuses an unknown base ingredient", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });

    const r = runCli(["forge", "unify", "rule/nope", "--profile", "acme", "--take", "variant", "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("rule/nope is not an ingredient of this Forge");
  });

  it("forge unify refuses a profile with no variant", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n")] });

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "variant", "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("rule/wf has no variant for profile acme");
  });

  it("forge unify refuses zero or several front ends", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });

    const zero = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--forge", root]);
    expect(zero.code).toBe(1);
    expect(zero.stderr).toContain("pass exactly one of --take, --plan or --save-plan");

    const two = runCli([
      "forge",
      "unify",
      "rule/wf",
      "--profile",
      "acme",
      "--take",
      "variant",
      "--save-plan",
      path.join(root, "plan.yaml"),
      "--forge",
      root,
    ]);
    expect(two.code).toBe(1);
    expect(two.stderr).toContain("pass exactly one of --take, --plan or --save-plan");
  });

  it("forge unify refuses a plan that fails its schema", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    gitInit(root);
    gitCommitAll(root, "init");

    const planDir = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(planDir, { recursive: true, force: true }));
    const planPath = path.join(planDir, "plan.yaml");
    await fs.writeFile(planPath, YAML.stringify({ schema: 1, base: "rule/wf" }));

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--plan", planPath, "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(planPath);
  });

  it("forge unify refuses a --plan whose base changed since it was saved", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    gitInit(root);
    gitCommitAll(root, "init");

    const planDir = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(planDir, { recursive: true, force: true }));
    const planPath = path.join(planDir, "plan.yaml");

    const save = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", planPath, "--forge", root]);
    expect(save.code).toBe(0);

    // A meta field other than name/as/origin — description is hashed, so the base's fingerprint moves.
    await fs.writeFile(
      path.join(root, "ingredients/rules/wf/ingredient.yaml"),
      YAML.stringify({ type: "rule", name: "wf", description: "edited" }),
    );
    gitCommitAll(root, "edit base");

    const apply = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--plan", planPath, "--forge", root]);
    expect(apply.code).toBe(1);
    expect(apply.stderr).toContain("the plan is stale: the base changed since it was saved");
  });

  it("forge unify refuses a --plan whose variant changed since it was saved", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    gitInit(root);
    gitCommitAll(root, "init");

    const planDir = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(planDir, { recursive: true, force: true }));
    const planPath = path.join(planDir, "plan.yaml");

    const save = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", planPath, "--forge", root]);
    expect(save.code).toBe(0);

    await fs.writeFile(path.join(root, "ingredients/rules/wf--acme/rule.md"), "b-edited\n");
    gitCommitAll(root, "edit variant");

    const apply = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--plan", planPath, "--forge", root]);
    expect(apply.code).toBe(1);
    expect(apply.stderr).toContain("the plan is stale: the variant changed since it was saved");
  });

  it("forge unify --take variant makes the base identical to the variant and removes it", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    gitInit(root);
    gitCommitAll(root, "init");

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "variant", "--forge", root]);
    expect(r.code).toBe(0);
    expect(await fs.readFile(path.join(root, "ingredients/rules/wf/rule.md"), "utf8")).toBe("b\n");
    expect(await exists(path.join(root, "ingredients/rules/wf--acme"))).toBe(false);
  });

  it("forge unify --take base discards the variant without changing the base", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    gitInit(root);
    gitCommitAll(root, "init");

    const before = await fs.readFile(path.join(root, "ingredients/rules/wf/rule.md"), "utf8");
    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", root]);
    expect(r.code).toBe(0);
    expect(await fs.readFile(path.join(root, "ingredients/rules/wf/rule.md"), "utf8")).toBe(before);
    expect(await exists(path.join(root, "ingredients/rules/wf--acme"))).toBe(false);
  });

  it("forge unify saves a plan, applies an edited one, and leaves the Forge untouched until then", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    gitInit(root);
    gitCommitAll(root, "init");

    const planDir = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(planDir, { recursive: true, force: true }));
    const planPath = path.join(planDir, "plan.yaml");

    const before = await snapshot(root);
    const save = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", planPath, "--forge", root]);
    expect(save.code).toBe(0);
    expect(await snapshot(root)).toEqual(before); // --save-plan writes nothing into the Forge

    const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
    plan.files[0].hunks[0].take = "variant";
    await fs.writeFile(planPath, YAML.stringify(plan));

    const apply = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--plan", planPath, "--forge", root]);
    expect(apply.code).toBe(0);
    expect(await fs.readFile(path.join(root, "ingredients/rules/wf/rule.md"), "utf8")).toBe("b\n");
    expect(await exists(path.join(root, "ingredients/rules/wf--acme"))).toBe(false);
  });
});
