import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { makeForge, profile, recipe, rule, scenario, tmpDir, writeFiles } from "./helpers/forge.js";
import { runCli } from "./helpers/cli.js";
import { exists, listFiles } from "../src/core/forge.js";
import { UnifyPlanSchema } from "../src/schema/index.js";

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
    // Finding 7: pin a fragment of the zod error itself, not just the file-path prefix any
    // message naming the path would satisfy — "profile" is one of the fields the fixture omits.
    expect(r.stderr).toContain('"profile"');
    expect(r.stderr).toContain("Required");
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

  it("forge unify tells an empty git repo (no commits yet) apart from no git repo at all (Ruling 22)", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    gitInit(root); // no commit yet — a real repo, but an empty one

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "variant", "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("has no commits yet");
    expect(r.stderr).not.toContain("is not a git repository");
  });

  it("forge unify refuses a --plan saved for a different ingredient (Ruling 23)", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" }), rule("zz", "a\n"), rule("zz--acme", "b\n", { as: "zz" })],
    });
    gitInit(root);
    gitCommitAll(root, "init");

    const planDir = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(planDir, { recursive: true, force: true }));
    const planPath = path.join(planDir, "plan.yaml");
    const save = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", planPath, "--forge", root]);
    expect(save.code).toBe(0);

    const r = runCli(["forge", "unify", "rule/zz", "--profile", "acme", "--plan", planPath, "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("the plan is for rule/wf");
    expect(r.stderr).not.toContain("stale");
    expect(await exists(path.join(root, "ingredients/rules/zz--acme"))).toBe(true);
  });

  it("forge unify refuses a --plan saved for a different profile of the same ingredient, before it can be misdiagnosed as stale (Ruling 23)", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" }), rule("wf--beta", "c\n", { as: "wf" })],
    });
    gitInit(root);
    gitCommitAll(root, "init");

    const planDir = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(planDir, { recursive: true, force: true }));
    const planPath = path.join(planDir, "plan.yaml");
    const save = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", planPath, "--forge", root]);
    expect(save.code).toBe(0);

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "beta", "--plan", planPath, "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("the plan is for rule/wf (profile acme)");
    expect(r.stderr).not.toContain("stale");
    expect(await exists(path.join(root, "ingredients/rules/wf--beta"))).toBe(true);
  });

  it("forge unify refuses an invalid --take value without touching the variant (Finding 6)", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "sideways", "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--take must be "base" or "variant"');
    expect(await exists(path.join(root, "ingredients/rules/wf--acme"))).toBe(true);
  });

  it("forge unify refuses a hand-edited one-sided entry the diff does not have, instead of deleting the file (Ruling 20, blocker)", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [
        { meta: { type: "rule", name: "wf" }, files: { "rule.md": "a\n", "extra.md": "shared\n" } },
        { meta: { type: "rule", name: "wf--acme", as: "wf" }, files: { "rule.md": "b\n", "extra.md": "shared\n" } },
      ],
    });
    gitInit(root);
    gitCommitAll(root, "init");

    const planDir = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(planDir, { recursive: true, force: true }));
    const planPath = path.join(planDir, "plan.yaml");
    const save = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", planPath, "--forge", root]);
    expect(save.code).toBe(0);

    // extra.md is shared and identical, so the diff never lists it as one-sided at all — this is
    // an entry only a hand edit could produce.
    const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
    plan.files[0].hunks[0].take = "base";
    plan.files.push({ file: "extra.md", onlyIn: "base", take: "variant" });
    await fs.writeFile(planPath, YAML.stringify(plan));

    const apply = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--plan", planPath, "--forge", root]);
    expect(apply.code).toBe(1);
    expect(apply.stderr).toContain("extra.md");
    expect(await exists(path.join(root, "ingredients/rules/wf/extra.md"))).toBe(true);
  });

  it("forge unify refuses a hand-edited onlyIn:variant entry naming a file the variant does not have, instead of ENOENT (Finding 5)", async () => {
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

    const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
    plan.files.push({ file: "nope.md", onlyIn: "variant", take: "variant" });
    await fs.writeFile(planPath, YAML.stringify(plan));

    const apply = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--plan", planPath, "--forge", root]);
    expect(apply.code).toBe(1);
    expect(apply.stderr).not.toContain("ENOENT");
    expect(apply.stderr).toContain("nope.md");
  });

  it("forge unify leaves the variant in place (not a dangling reference) when the recipe cascade cannot rewrite an aliased reference (Ruling 21)", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    const aliased = "name: aliased\nx: &shared\n  - rule/wf--acme\ningredients: *shared\n";
    await writeFiles(root, { "recipes/aliased.yaml": aliased });
    gitInit(root);
    gitCommitAll(root, "init");

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "variant", "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("aliased");

    // Ruling 33 supersedes the original expectation here (the merge used to run before the
    // cascade refused): the cascade's dry pass now refuses before anything is written, so the
    // base is untouched and the variant directory still stands.
    expect(await fs.readFile(path.join(root, "ingredients/rules/wf/rule.md"), "utf8")).toBe("a\n");
    expect(await exists(path.join(root, "ingredients/rules/wf--acme"))).toBe(true);
  });

  it("forge unify --json prints the apply-path object (Finding 8)", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
      recipes: [recipe("base", ["rule/wf--acme"])],
    });
    gitInit(root);
    gitCommitAll(root, "init");

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "variant", "--forge", root, "--json"]);
    expect(r.code).toBe(0);
    // Ruling 35: the full shape, every key always present — `[]` when empty.
    expect(JSON.parse(r.stdout)).toEqual({
      base: "rule/wf",
      profile: "acme",
      resolved: true,
      written: ["rule.md"],
      removed: [],
      unresolved: 0,
      variantRemoved: "rule/wf--acme",
      recipes: { rewritten: ["base"], deleted: [], profileRepointed: [], extendsRepointed: [] },
      metaDiffers: [],
      // Ruling 38: a removed variant always warns about overrides.ingredients.disable.
      warnings: [
        "rule/wf--acme was removed — a workspace that disables it in overrides.ingredients.disable (craftar.yaml or craftar.local.yaml) " +
          "must now name rule/wf, or the base comes back enabled; unify cannot reach workspaces",
      ],
    });
  });

  it("forge unify --save-plan --json prints its own shape, not the apply-path object (Finding 8, Ruling 24)", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    gitInit(root);
    gitCommitAll(root, "init");

    const planDir = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(planDir, { recursive: true, force: true }));
    const planPath = path.join(planDir, "plan.yaml");

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", planPath, "--forge", root, "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ base: "rule/wf", profile: "acme", plan: planPath, unresolved: 1 });
  });

  it("forge unify's text report names the touched paths, the resolved/unresolved counts, the cascade and a status hint (spec 7.4)", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
      recipes: [recipe("base", ["rule/wf--acme"])],
    });
    gitInit(root);
    gitCommitAll(root, "init");

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "variant", "--forge", root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("rule.md");
    expect(r.stdout).toContain("resolved yes");
    expect(r.stdout).toContain("unresolved 0");
    expect(r.stdout).toContain("removed variant");
    expect(r.stdout).toContain("rule/wf--acme");
    expect(r.stdout).toContain("recipes rewritten: base");
    expect(r.stdout).toContain("craftar status --workspace <dir>");
  });

  it("forge unify --plan with one hunk resolved and one left at keep updates only that hunk and leaves the variant and every recipe untouched (spec AC4)", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [rule("wf", "a\nc\ne\n"), rule("wf--acme", "b\nc\nf\n", { as: "wf" })],
      recipes: [recipe("base", ["rule/wf--acme"])],
    });
    gitInit(root);
    gitCommitAll(root, "init");

    const planDir = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(planDir, { recursive: true, force: true }));
    const planPath = path.join(planDir, "plan.yaml");
    const save = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", planPath, "--forge", root]);
    expect(save.code).toBe(0);

    const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
    expect(plan.files[0].hunks).toHaveLength(2); // "a"→"b" and "e"→"f", separated by the common "c"
    plan.files[0].hunks[0].take = "variant"; // resolve the first hunk
    // the second hunk stays "keep"
    await fs.writeFile(planPath, YAML.stringify(plan));

    const before = await fs.readFile(path.join(root, "recipes/base.yaml"), "utf8");
    const apply = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--plan", planPath, "--forge", root]);
    expect(apply.code).toBe(0);
    expect(await fs.readFile(path.join(root, "ingredients/rules/wf/rule.md"), "utf8")).toBe("b\nc\ne\n");
    expect(await exists(path.join(root, "ingredients/rules/wf--acme"))).toBe(true);
    expect(await fs.readFile(path.join(root, "recipes/base.yaml"), "utf8")).toBe(before);
  });

  it("forge unify's full resolution rewrites a recipe and deletes its now-duplicate suffixed sibling (spec AC8)", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
      recipes: [recipe("base", ["rule/wf"]), recipe("base--acme", ["rule/wf--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });
    gitInit(root);
    gitCommitAll(root, "init");

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "variant", "--forge", root, "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.resolved).toBe(true);
    expect(out.recipes.rewritten).toEqual(["base--acme"]);
    expect(out.recipes.deleted).toEqual(["base--acme"]);
    expect(out.recipes.profileRepointed).toEqual(["base--acme -> base"]);

    expect(await exists(path.join(root, "recipes/base--acme.yaml"))).toBe(false);
    const profileText = await fs.readFile(path.join(root, "profiles/acme/profile.yaml"), "utf8");
    expect(profileText).not.toContain("base--acme");
    expect(profileText).toContain("base");
  });

  // Ruling 30: this test used to check Ruling 25's hint. That hint is gone, so its old assertion
  // (`not.toContain("sits inside the Forge")`) could never fail; it now checks the refusal and the
  // outside plan's content instead.
  it("refuses a --save-plan target inside the Forge (Ruling 30)", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    gitInit(root);
    gitCommitAll(root, "init");

    // Ruling 30 supersedes Ruling 25's hint: a target inside the Forge is now refused, not noted.
    const inside = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", path.join(root, "plan.yaml"), "--forge", root]);
    expect(inside.code).toBe(1);
    expect(inside.stderr).toContain("inside the Forge");
    expect(await exists(path.join(root, "plan.yaml"))).toBe(false);

    const planDir = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(planDir, { recursive: true, force: true }));
    const outside = runCli([
      "forge",
      "unify",
      "rule/wf",
      "--profile",
      "acme",
      "--save-plan",
      path.join(planDir, "plan.yaml"),
      "--forge",
      root,
    ]);
    expect(outside.code).toBe(0);
    const saved = UnifyPlanSchema.parse(YAML.parse(await fs.readFile(path.join(planDir, "plan.yaml"), "utf8")));
    expect(saved.base).toBe("rule/wf");
  });
});

describe("cli — forge unify final review", () => {
  // C1 (Ruling 28): `ingredient.yaml` never enters the diff, so a variant that differs only in
  // its metadata resolved with zero decisions and was deleted. The nested MCP `server` is the case
  // that was reported: a comparison that filters keys at every depth sees both servers as `{}`.
  const mcpBase = { type: "mcp", name: "srv", server: { command: "npx", args: ["public-server"] } };
  const mcpVariant = {
    type: "mcp",
    name: "srv--acme",
    as: "srv",
    server: { command: "npx", args: ["acme-private-server"], env: { TOKEN_VAR: "ACME_TOKEN" } },
  };

  async function mcpForge(): Promise<string> {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [{ meta: mcpBase }, { meta: mcpVariant }] });
    gitInit(root);
    gitCommitAll(root, "init");
    return root;
  }

  it("forge unify --take variant leaves a variant whose nested MCP server differs unresolved, and names the field (Ruling 28)", async () => {
    const root = await mcpForge();
    const variantYaml = await fs.readFile(path.join(root, "ingredients/mcp/srv--acme/ingredient.yaml"), "utf8");

    const r = runCli(["forge", "unify", "mcp/srv", "--profile", "acme", "--take", "variant", "--forge", root, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.resolved).toBe(false);
    expect(out.variantRemoved).toBeNull();
    expect(out.metaDiffers).toEqual(["server"]);
    expect(await fs.readFile(path.join(root, "ingredients/mcp/srv--acme/ingredient.yaml"), "utf8")).toBe(variantYaml);

    const text = runCli(["forge", "unify", "mcp/srv", "--profile", "acme", "--take", "variant", "--forge", root]);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain("resolved no");
    expect(text.stdout).toContain("server");
    expect(text.stdout).toContain("ingredient.yaml");
    expect(text.stdout).toContain("--take base");
    expect(await exists(path.join(root, "ingredients/mcp/srv--acme"))).toBe(true);
  });

  it("forge unify --take base resolves the same MCP variant, discarding its metadata (Ruling 28)", async () => {
    const root = await mcpForge();
    const baseYaml = await fs.readFile(path.join(root, "ingredients/mcp/srv/ingredient.yaml"), "utf8");
    const r = runCli(["forge", "unify", "mcp/srv", "--profile", "acme", "--take", "base", "--forge", root, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.resolved).toBe(true);
    expect(out.variantRemoved).toBe("mcp/srv--acme");
    expect(await exists(path.join(root, "ingredients/mcp/srv--acme"))).toBe(false);
    expect(await fs.readFile(path.join(root, "ingredients/mcp/srv/ingredient.yaml"), "utf8")).toBe(baseYaml);
  });

  it("forge unify --plan leaves an agent whose model and tools differ unresolved, while still writing the resolved hunks (Ruling 28)", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [
        { meta: { type: "agent", name: "rev" }, files: { "agent.md": "a\n" } },
        { meta: { type: "agent", name: "rev--acme", as: "rev", model: "opus", tools: ["Read", "Bash"] }, files: { "agent.md": "b\n" } },
      ],
    });
    gitInit(root);
    gitCommitAll(root, "init");

    const planDir = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(planDir, { recursive: true, force: true }));
    const planPath = path.join(planDir, "plan.yaml");
    expect(runCli(["forge", "unify", "agent/rev", "--profile", "acme", "--save-plan", planPath, "--forge", root]).code).toBe(0);
    const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
    plan.files[0].hunks[0].take = "variant";
    await fs.writeFile(planPath, YAML.stringify(plan));

    const r = runCli(["forge", "unify", "agent/rev", "--profile", "acme", "--plan", planPath, "--forge", root, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.resolved).toBe(false);
    expect(out.unresolved).toBe(0);
    expect(out.written).toEqual(["agent.md"]);
    expect(out.metaDiffers).toEqual(["model", "tools"]);
    expect(await fs.readFile(path.join(root, "ingredients/agents/rev/agent.md"), "utf8")).toBe("b\n");
    expect(await exists(path.join(root, "ingredients/agents/rev--acme"))).toBe(true);
  });
});

describe("cli — forge unify cascade (Ruling 32)", () => {
  it("repoints a dangling extends, claims no profile repoint no profile had, and warns about workspaces", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
      recipes: [
        recipe("base", ["rule/wf"]),
        recipe("base--acme", ["rule/wf--acme"]),
        recipe("stack--acme", ["rule/other"], { extends: ["base--acme"] }),
      ],
      profiles: [profile("acme", ["stack--acme"])],
    });
    gitInit(root);
    gitCommitAll(root, "init");

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "variant", "--forge", root, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.recipes.deleted).toEqual(["base--acme"]);
    expect(out.recipes.profileRepointed).toEqual([]);
    expect(out.recipes.extendsRepointed).toEqual(["stack--acme: base--acme -> base"]);
    expect(out.warnings.join("\n")).toContain("recipes.add");
    // Ruling 38: the deleted recipe also names recipes.remove, and the removed variant warns about
    // overrides.ingredients.disable, naming the ref a workspace must switch to.
    expect(out.warnings.join("\n")).toContain("recipes.remove");
    expect(out.warnings.join("\n")).toContain("overrides.ingredients.disable");
    expect(out.warnings.join("\n")).toContain("must now name rule/wf");
    expect(out.warnings.join("\n")).toContain("base--acme");

    const stack = YAML.parse(await fs.readFile(path.join(root, "recipes/stack--acme.yaml"), "utf8"));
    expect(stack.extends).toEqual(["base"]);
  });

  it("names the workspace follow-up in the text report when a recipe is deleted", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
      recipes: [recipe("base", ["rule/wf"]), recipe("base--acme", ["rule/wf--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });
    gitInit(root);
    gitCommitAll(root, "init");

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "variant", "--forge", root]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("profiles repointed: base--acme -> base");
    expect(r.stdout).toContain("recipes.add");
    expect(r.stdout).toContain("recipes.remove"); // Ruling 38
    expect(r.stdout).toContain("overrides.ingredients.disable"); // Ruling 38
  });
});

function gitStatus(dir: string): string {
  return execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });
}

describe("cli — forge unify cascade refusals write nothing (Ruling 33)", () => {
  it("refuses an aliased recipe reference before writing anything: git status stays clean", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    await writeFiles(root, { "recipes/aliased.yaml": "name: aliased\nx: &shared\n  - rule/wf--acme\ningredients: *shared\n" });
    gitInit(root);
    gitCommitAll(root, "init");

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "variant", "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("aliased");
    expect(gitStatus(root)).toBe("");
    expect(await fs.readFile(path.join(root, "ingredients/rules/wf/rule.md"), "utf8")).toBe("a\n");
  });

  it("refuses an aliased profile reference before writing anything: git status stays clean", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
      recipes: [recipe("base", ["rule/wf"]), recipe("base--acme", ["rule/wf--acme"])],
    });
    await writeFiles(root, { "profiles/acme/profile.yaml": "name: acme\nmine: &r [base--acme]\nrecipes: *r\n" });
    gitInit(root);
    gitCommitAll(root, "init");

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "variant", "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('profile "acme"');
    expect(gitStatus(root)).toBe("");
  });

  // A write that fails after writing began (a read-only recipe here; an I/O error or a locked file
  // on Windows in the wild) cannot be prevented by the dry pass — it must name what was written.
  // Root ignores the read-only bit on POSIX, so the scenario cannot fail there.
  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "names the paths already written and the git recovery when a write fails midway",
    async () => {
      const root = await tmpDir("craftar-cli-forge-");
      const recipeFile = path.join(root, "recipes/base.yaml");
      cleanups.push(async () => {
        await fs.chmod(recipeFile, 0o644).catch(() => undefined);
        await fs.rm(root, { recursive: true, force: true });
      });
      await makeForge(root, {
        ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
        recipes: [recipe("base", ["rule/wf--acme"])],
      });
      gitInit(root);
      gitCommitAll(root, "init");
      await fs.chmod(recipeFile, 0o444);

      const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "variant", "--forge", root]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("ingredients/rules/wf/rule.md");
      expect(r.stderr).toContain("git -C");
      expect(r.stderr).toContain("checkout --");
      // The variant is still there: removal comes last.
      expect(await exists(path.join(root, "ingredients/rules/wf--acme"))).toBe(true);
    },
  );
});

describe("cli — forge unify --save-plan never writes into the Forge, never overwrites (Ruling 30)", () => {
  async function committedForge(): Promise<string> {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    gitInit(root);
    gitCommitAll(root, "init");
    return root;
  }

  it("refuses a target inside the Forge and writes nothing", async () => {
    const root = await committedForge();
    const before = await snapshot(root);
    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", path.join(root, "plan.yaml"), "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("inside the Forge");
    expect(await snapshot(root)).toEqual(before);
  });

  it("refuses a target that reaches back into the Forge through a `..` segment", async () => {
    const root = await committedForge();
    const before = await snapshot(root);
    // Leaves the Forge and walks back in: only a resolved path shows where it lands.
    const sneaky = [root, "..", path.basename(root), "recipes", "plan.yaml"].join(path.sep);
    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", sneaky, "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("inside the Forge");
    expect(await snapshot(root)).toEqual(before);
  });

  it("refuses to overwrite a Forge file with uncommitted edits, which git could not bring back", async () => {
    const root = await committedForge();
    const ruleFile = path.join(root, "ingredients/rules/wf/rule.md");
    await fs.writeFile(ruleFile, "a\nuncommitted work\n");
    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", ruleFile, "--forge", root]);
    expect(r.code).toBe(1);
    expect(await fs.readFile(ruleFile, "utf8")).toBe("a\nuncommitted work\n");
  });

  it("refuses a target that already exists outside the Forge, keeping the plan the user edited", async () => {
    const root = await committedForge();
    const planDir = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(planDir, { recursive: true, force: true }));
    const planPath = path.join(planDir, "plan.yaml");
    await fs.writeFile(planPath, "edited by hand\n");
    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", planPath, "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("already exists");
    expect(await fs.readFile(planPath, "utf8")).toBe("edited by hand\n");
  });
});

describe("cli — forge unify --save-plan symlink escape (Ruling 30)", () => {
  // Creating a symlink needs privileges on Windows; this runs on Linux CI.
  it.skipIf(process.platform === "win32")("refuses a target that reaches inside the Forge through a symlink, and writes nothing", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    gitInit(root);
    gitCommitAll(root, "init");

    const outside = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(outside, { recursive: true, force: true }));
    const link = path.join(outside, "into-forge");
    await fs.symlink(path.join(root, "recipes"), link, "dir");

    const before = await snapshot(root);
    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", path.join(link, "plan.yaml"), "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("inside the Forge");
    expect(await snapshot(root)).toEqual(before);
    expect(await exists(path.join(root, "recipes/plan.yaml"))).toBe(false);
  });
});

describe("cli — forge unify refuses paths git does not hold (Ruling 37)", () => {
  it("refuses a Forge that its enclosing repository ignores, changing nothing", async () => {
    const repo = await tmpDir("craftar-cli-repo-");
    cleanups.push(() => fs.rm(repo, { recursive: true, force: true }));
    gitInit(repo);
    await fs.writeFile(path.join(repo, ".gitignore"), "forge/\n");
    gitCommitAll(repo, "init");
    const root = path.join(repo, "forge");
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "variant", "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not held by git (ignored)");
    expect(await fs.readFile(path.join(root, "ingredients/rules/wf/rule.md"), "utf8")).toBe("a\n");
    expect(await exists(path.join(root, "ingredients/rules/wf--acme"))).toBe(true);
  });

  it("refuses when the variant directory holds a file .gitignore matches, and keeps that file", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    await fs.writeFile(path.join(root, ".gitignore"), "*.local.md\n");
    gitInit(root);
    gitCommitAll(root, "init");
    const ignored = path.join(root, "ingredients/rules/wf--acme/notes.local.md");
    await fs.writeFile(ignored, "only copy\n");

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "variant", "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("notes.local.md");
    expect(r.stderr).toContain("ignored");
    expect(await fs.readFile(ignored, "utf8")).toBe("only copy\n");
  });

  it("refuses an untracked file in the variant even under status.showUntrackedFiles=no", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    gitInit(root);
    gitCommitAll(root, "init");
    execFileSync("git", ["-C", root, "config", "status.showUntrackedFiles", "no"]);
    const untracked = path.join(root, "ingredients/rules/wf--acme/scratch.md");
    await fs.writeFile(untracked, "not committed\n");

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not held by git (untracked)");
    expect(await exists(untracked)).toBe(true);
  });
});
