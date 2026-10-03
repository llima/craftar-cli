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
  const files = (await listFiles(root)).filter((f) => f !== ".git" && !f.startsWith(".git/"));
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
  execFileSync("git", ["-C", dir, "config", "maintenance.auto", "false"]);
  execFileSync("git", ["-C", dir, "config", "gc.auto", "0"]);
}

function gitCommitAll(dir: string, message: string): void {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", message], { env: gitEnv() });
}

describe("cli", () => {
  it("snapshot() never reads .git/ — git's background maintenance races it (0.8.1)", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, "a.txt"), "a\n");
    gitInit(root);
    gitCommitAll(root, "init");
    const keys = Object.keys(await snapshot(root));
    expect(keys).toContain("a.txt");
    expect(keys.filter((k) => k === ".git" || k.startsWith(".git/"))).toEqual([]);
  });

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

  it("every Forge command refuses unknown ingredient keys, naming the file and every key, and writes nothing (spec 07, AC 1)", async () => {
    const s = await scenario(
      {
        ingredients: [rule("a", "# A\n", { incluson: "always", origin: { workspace: "acme", path: "a.md", line: 3 } })],
        recipes: [recipe("base", ["rule/a"])],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    const before = { forge: await snapshot(s.forgeRoot), ws: await snapshot(s.wsRoot) };
    for (const args of [["status"], ["sync"], ["forge", "variants"], ["forge", "unify", "rule/a", "--profile", "acme", "--take", "base"]]) {
      const r = runCli([...args, "--workspace", s.wsRoot]);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toContain(path.join("ingredients", "rules", "a", "ingredient.yaml"));
      expect(r.stderr, args.join(" ")).toContain("incluson");
      expect(r.stderr, args.join(" ")).toContain("line");
    }
    expect({ forge: await snapshot(s.forgeRoot), ws: await snapshot(s.wsRoot) }).toEqual(before);
  });

  it("sync --check fails once the Forge carries an MCP key the locked .mcp.json lacks (spec 07, AC 5)", async () => {
    const meta = (server: Record<string, unknown>) => ({ type: "mcp", name: "r", server });
    const s = await scenario(
      { ingredients: [{ meta: meta({ url: "https://mcp.acme.dev" }) }], recipes: [recipe("base", ["mcp/r"])], profiles: [profile("acme", ["base"])] },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    await fs.writeFile(path.join(s.forgeRoot, "ingredients/mcp/r/ingredient.yaml"), YAML.stringify(meta({ url: "https://mcp.acme.dev", headers: { "X-Team": "acme" } })));
    expect(runCli(["sync", "--check", "--workspace", s.wsRoot]).code).toBe(1);
  });

  it("sync --check keeps failing on a hand-edited orphan after a sync has already reported it", async () => {
    const s = await scenario(
      { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    const A = ".claude/rules/a.md";
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    await fs.appendFile(path.join(s.wsRoot, A), "hand edit\n");
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), YAML.stringify(recipe("base", [])));

    const first = runCli(["sync", "--workspace", s.wsRoot]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("no longer produced by the Forge but hand-edited");

    const check = runCli(["sync", "--check", "--workspace", s.wsRoot]);
    expect(check.code).toBe(1);
    expect(check.stdout).toContain("orphan-drift");
    const st = runCli(["status", "--workspace", s.wsRoot]);
    expect(st.stdout).toContain("orphan-drift");
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

  it("import that fails says the Forge was left untouched and writes nothing into it", async () => {
    const root = await tmpDir("craftar-cli-import-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await writeFiles(path.join(root, "api"), { ".claude/rules/workflow.md": "# Workflow\n", ".mcp.json": "{ not json" });
    const r = runCli(["import", "--from", "claude-code", "--workspace", path.join(root, "api"), "--forge", path.join(root, "forge"), "--profile", "api"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("The Forge was left untouched.");
    expect(await exists(path.join(root, "forge"))).toBe(false);
  });

  it("a second workspace whose MCP server differs imports as a variant and syncs back to its own .mcp.json", async () => {
    // Adopt, don't collide: since 0.2.1 the differing server becomes mcp/srv--b; it must be
    // emitted under its original name, or the workspace's own .mcp.json reads as a collision.
    const root = await tmpDir("craftar-cli-import-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const ws = (name: string, args: string[]) =>
      writeFiles(path.join(root, name), {
        ".claude/rules/workflow.md": "# Workflow\n",
        ".mcp.json": JSON.stringify({ mcpServers: { srv: { command: "npx", args } } }, null, 2) + "\n",
      });
    await ws("a", ["public-server"]);
    await ws("b", ["acme-server"]);
    expect(runCli(["import", "--from", "claude-code", "--workspace", path.join(root, "a"), "--forge", forge, "--profile", "a"]).code).toBe(0);
    const imp = runCli(["import", "--from", "claude-code", "--workspace", path.join(root, "b"), "--forge", forge, "--profile", "b", "--write-config"]);
    expect(imp.code).toBe(0);
    expect(await exists(path.join(forge, "ingredients/mcp/srv--b"))).toBe(true);

    const st = runCli(["status", "--workspace", path.join(root, "b"), "--json"]);
    expect(st.code).toBe(0);
    const mcp = JSON.parse(st.stdout).statuses.find((s: { path: string }) => s.path === ".mcp.json");
    expect(mcp.state).not.toBe("collision");
    expect(["adopt", "unchanged"]).toContain(mcp.state);
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
      // Ruling 42: the cascade reports `rewritten` and `identicalToSibling`, and nothing else.
      recipes: { rewritten: ["base"], identicalToSibling: [] },
      metaDiffers: [],
      // Spec 09 §4.5: always present, [] / null when the plan extracts nothing.
      params: [],
      // Spec 12 §4.5: always present, [] / false when no section hunk.
      sections: [],
      manifestEdited: false,
      profileEdited: null,
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

  it("forge unify --take variant keeps a variant that differs only in an undeclared server key (spec 07, AC 6)", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [
        { meta: { type: "mcp", name: "srv", server: { url: "https://mcp.acme.dev" } } },
        { meta: { type: "mcp", name: "srv--acme", as: "srv", server: { url: "https://mcp.acme.dev", headers: { "X-Team": "acme" } } } },
      ],
    });
    gitInit(root);
    gitCommitAll(root, "init");
    const r = runCli(["forge", "unify", "mcp/srv", "--profile", "acme", "--take", "variant", "--forge", root, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.metaDiffers).toEqual(["server"]);
    expect(out.resolved).toBe(false);
    expect(await exists(path.join(root, "ingredients/mcp/srv--acme"))).toBe(true);
  });

  it("forge variants refuses a Forge with an unknown ingredient key, naming the file and the key (spec 07, AC 1)", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("workflow", "a\n", { incluson: "always" })] });
    const r = runCli(["forge", "variants", "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(path.join("ingredients", "rules", "workflow", "ingredient.yaml"));
    expect(r.stderr).toContain("incluson");
  });

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
  // On Windows a directory junction needs no privilege, so this runs on both platforms.
  it("refuses a target that reaches inside the Forge through a symlink, and writes nothing", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    // A real `recipes/` directory, so the link below resolves inside the Forge — without a recipe
    // `makeForge` creates no `recipes/`, and the link would dangle instead (a separate case).
    await makeForge(root, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
      recipes: [recipe("base", ["rule/wf"])],
    });
    gitInit(root);
    gitCommitAll(root, "init");

    const outside = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(outside, { recursive: true, force: true }));
    const link = path.join(outside, "into-forge");
    await fs.symlink(path.join(root, "recipes"), link, process.platform === "win32" ? "junction" : "dir");

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

describe("cli — forge unify acceptance criterion 2", () => {
  it("applies an unmodified plan (every decision at keep): nothing changes and the variant stays", async () => {
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
    expect(runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", planPath, "--forge", root]).code).toBe(0);

    const before = await snapshot(root);
    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--plan", planPath, "--forge", root, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.resolved).toBe(false);
    expect(out.unresolved).toBe(2);
    expect(out.written).toEqual([]);
    expect(out.removed).toEqual([]);
    expect(out.variantRemoved).toBeNull();
    expect(await snapshot(root)).toEqual(before);
    expect(gitStatus(root)).toBe("");
  });
});

describe("cli — forge unify refuses index-flagged paths (Ruling 39)", () => {
  for (const [flag, reason] of [
    ["--skip-worktree", "skip-worktree"],
    ["--assume-unchanged", "assume-unchanged"],
  ] as const) {
    it(`refuses a variant file marked ${flag} whose local edit git cannot restore`, async () => {
      const root = await tmpDir("craftar-cli-forge-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
      gitInit(root);
      gitCommitAll(root, "init");
      execFileSync("git", ["-C", root, "update-index", flag, "ingredients/rules/wf--acme/rule.md"]);
      const flagged = path.join(root, "ingredients/rules/wf--acme/rule.md");
      await fs.writeFile(flagged, "b\nlocal edit only here\n");

      const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", root]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`(${reason})`);
      expect(await fs.readFile(flagged, "utf8")).toBe("b\nlocal edit only here\n");
    });
  }
});

describe("cli — forge unify checks the cascade's own files are held by git (Ruling 37)", () => {
  it("refuses when only a recipe the cascade would rewrite is untracked (showUntrackedFiles=no), and leaves it unchanged", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    gitInit(root);
    gitCommitAll(root, "init");
    execFileSync("git", ["-C", root, "config", "status.showUntrackedFiles", "no"]);
    const recipeFile = path.join(root, "recipes/local.yaml");
    await writeFiles(root, { "recipes/local.yaml": "name: local\ningredients:\n  - rule/wf--acme\n" });

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "variant", "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("recipes/local.yaml");
    expect(r.stderr).toContain("(untracked)");
    expect(await fs.readFile(recipeFile, "utf8")).toBe("name: local\ningredients:\n  - rule/wf--acme\n");
    expect(await fs.readFile(path.join(root, "ingredients/rules/wf/rule.md"), "utf8")).toBe("a\n");
  });
});

describe("cli — forge unify's held-by-git refusal names every path, Forge-relative (Ruling 37 nits)", () => {
  it("lists every path git does not hold, not just the first", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    gitInit(root);
    gitCommitAll(root, "init");
    execFileSync("git", ["-C", root, "config", "status.showUntrackedFiles", "no"]);
    await writeFiles(root, { "ingredients/rules/wf--acme/one.md": "1\n", "ingredients/rules/wf--acme/two.md": "2\n" });

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ingredients/rules/wf--acme/one.md is not held by git (untracked)");
    expect(r.stderr).toContain("ingredients/rules/wf--acme/two.md is not held by git (untracked)");
  });

  it("prints paths relative to the Forge, not to an enclosing repository", async () => {
    const repo = await tmpDir("craftar-cli-repo-");
    cleanups.push(() => fs.rm(repo, { recursive: true, force: true }));
    const root = path.join(repo, "nested", "forge");
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    gitInit(repo);
    gitCommitAll(repo, "init");
    execFileSync("git", ["-C", repo, "config", "status.showUntrackedFiles", "no"]);
    await writeFiles(root, { "ingredients/rules/wf--acme/scratch.md": "x\n" });

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("  ingredients/rules/wf--acme/scratch.md is not held by git (untracked)");
    expect(r.stderr).not.toContain("nested/forge/ingredients");
  });
});

describe("cli — forge unify's held-by-git refusal caps its list (docs-author nit)", () => {
  it("lists the first ten paths git does not hold and counts the rest", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    gitInit(root);
    gitCommitAll(root, "init");
    execFileSync("git", ["-C", root, "config", "status.showUntrackedFiles", "no"]);
    const names = Array.from({ length: 13 }, (_, i) => `n${String(i).padStart(2, "0")}.md`); // sorts as git lists them
    await writeFiles(root, Object.fromEntries(names.map((n) => [`ingredients/rules/wf--acme/${n}`, "x\n"])));

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("13 path(s)");
    const listed = r.stderr.split(/\r?\n/).filter((l) => l.includes("is not held by git ("));
    expect(listed).toHaveLength(10);
    for (const n of names.slice(0, 10)) expect(r.stderr).toContain(`ingredients/rules/wf--acme/${n} is not held by git (untracked)`);
    for (const n of names.slice(10)) expect(r.stderr).not.toContain(n);
    expect(r.stderr).toContain("… and 3 more");
  });
});

// Ruling 42 (a product decision): the recipe cascade only rewrites `ingredients` from the variant
// to the base. It never deletes a recipe and never edits a profile or an `extends`, and it reports
// a suffixed recipe left identical to its sibling instead of removing it.
describe("cli — forge unify's cascade rewrites ingredients only (Ruling 42)", () => {
  const ingredients = [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" }), rule("other", "o\n")];
  const base = recipe("base", ["rule/wf"], { params: { x: { default: "from-base" } } });
  const baseAcme = recipe("base--acme", ["rule/wf--acme"], { params: { x: { default: "from-base" } } });
  const extra = recipe("extra", ["rule/other"], { params: { x: { default: "from-extra" } } });

  async function committedForge(spec: Parameters<typeof makeForge>[1]): Promise<string> {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, spec);
    gitInit(root);
    gitCommitAll(root, "init");
    return root;
  }

  function unify(root: string) {
    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "variant", "--forge", root, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  }

  /** The source text of a recipe's `extends` node, exactly as written on disk ("" when absent). */
  async function extendsText(file: string): Promise<string> {
    const text = await fs.readFile(file, "utf8");
    const node = YAML.parseDocument(text).get("extends", true) as { range?: [number, number, number] } | undefined;
    return node?.range ? text.slice(node.range[0], node.range[1]) : "";
  }

  it("deletes no recipe and leaves every profile and every recipe's extends byte-identical", async () => {
    const root = await committedForge({
      ingredients,
      recipes: [base, baseAcme, extra, recipe("stack--acme", ["rule/other"], { extends: ["base--acme", "extra"] })],
      profiles: [profile("acme", ["stack--acme", "base--acme"]), profile("beta", ["base", "extra"])],
    });
    const recipeFiles = (await fs.readdir(path.join(root, "recipes"))).sort();
    const profilesBefore = await snapshot(path.join(root, "profiles"));
    const extendsBefore = Object.fromEntries(
      await Promise.all(recipeFiles.map(async (f) => [f, await extendsText(path.join(root, "recipes", f))] as const)),
    );

    const out = unify(root);
    expect(out.resolved).toBe(true);
    expect(out.variantRemoved).toBe("rule/wf--acme");
    expect((await fs.readdir(path.join(root, "recipes"))).sort()).toEqual(recipeFiles);
    expect(await snapshot(path.join(root, "profiles"))).toEqual(profilesBefore);
    for (const f of recipeFiles) expect(await extendsText(path.join(root, "recipes", f)), f).toBe(extendsBefore[f]);
    // The one edit the cascade makes: the variant's ref, rewritten to the base's.
    const rewritten = YAML.parse(await fs.readFile(path.join(root, "recipes/base--acme.yaml"), "utf8"));
    expect(rewritten.ingredients).toEqual(["rule/wf"]);
  });

  it("reports a recipe left identical to its sibling in identicalToSibling and in the warnings", async () => {
    const root = await committedForge({ ingredients, recipes: [base, baseAcme], profiles: [profile("acme", ["base--acme"])] });
    const out = unify(root);
    expect(out.recipes).toEqual({ rewritten: ["base--acme"], identicalToSibling: ["base--acme"] });
    expect(out.warnings.join("\n")).toContain("recipe base--acme is now identical to base");
    expect(await exists(path.join(root, "recipes/base--acme.yaml"))).toBe(true);

    const text = runCli(["forge", "variants", "--forge", root]); // the Forge still loads and lists no variant
    expect(text.code).toBe(0);
  });

  it("prints the identical-recipe report in the text output", async () => {
    const root = await committedForge({ ingredients, recipes: [base, baseAcme], profiles: [profile("acme", ["base--acme"])] });
    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "variant", "--forge", root]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("recipes now identical to a sibling: base--acme");
    expect(r.stdout).toContain("recipe base--acme is now identical to base");
  });

  // The reviewer's shapes: each must resolve to the same recipe order and the same param values
  // before and after unify. Only the variant ingredient's ref changes, by design.
  const shapes: Array<{ name: string; recipes: ReturnType<typeof recipe>[]; profile: string[]; add?: string[] }> = [
    { name: "E: transitive extends [x, base--acme], x.extends [base]", recipes: [base, baseAcme, recipe("x", [], { extends: ["base"], params: { x: { default: "from-x" } } })], profile: ["x", "base--acme"] },
    { name: "E2: [stack, base], stack.extends [base--acme]", recipes: [base, baseAcme, recipe("stack", [], { extends: ["base--acme"] })], profile: ["stack", "base"] },
    { name: "A1: profile [base--acme, extra, base]", recipes: [base, baseAcme, extra], profile: ["base--acme", "extra", "base"] },
    { name: "A2: profile [base, extra, base--acme]", recipes: [base, baseAcme, extra], profile: ["base", "extra", "base--acme"] },
    { name: "B1: extends [base--acme, extra, base]", recipes: [base, baseAcme, extra, recipe("stack", [], { extends: ["base--acme", "extra", "base"] })], profile: ["stack"] },
    { name: "B2: extends [base, extra, base--acme]", recipes: [base, baseAcme, extra, recipe("stack", [], { extends: ["base", "extra", "base--acme"] })], profile: ["stack"] },
    { name: "G: workspace recipes.add [base] on a profile using base--acme", recipes: [base, baseAcme, extra], profile: ["base--acme", "extra"], add: ["base"] },
  ];
  for (const shape of shapes) {
    it(`resolves exactly as before — ${shape.name}`, async () => {
      const { loadForge } = await import("../src/core/forge.js");
      const { resolve } = await import("../src/core/resolve.js");
      const { WorkspaceConfigSchema } = await import("../src/schema/index.js");
      const root = await committedForge({ ingredients, recipes: shape.recipes, profiles: [profile("acme", shape.profile)] });
      const ws = WorkspaceConfigSchema.parse({ forge: root, profile: "acme", recipes: { add: shape.add ?? [] } });
      const view = async () => {
        const r = resolve(await loadForge(root), ws);
        return { recipes: r.recipes, params: r.params };
      };

      const before = await view();
      unify(root);
      expect(await view()).toEqual(before);
    });
  }
});

describe("cli — forge unify --save-plan through a dangling symlink (Ruling 30, CI round)", () => {
  // On Windows a directory junction needs no privilege, so this runs on both platforms.
  it("refuses a target whose path passes through a dangling symlink, and writes nothing", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    gitInit(root);
    gitCommitAll(root, "init");

    const outside = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(outside, { recursive: true, force: true }));
    const link = path.join(outside, "dangling");
    await fs.symlink(path.join(root, "not-there-yet"), link, process.platform === "win32" ? "junction" : "dir"); // points into the Forge, at nothing

    const before = await snapshot(root);
    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", path.join(link, "plan.yaml"), "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot be resolved");
    expect(r.stderr).toContain("cannot prove the target lies outside the Forge");
    expect(r.stderr).not.toContain("ENOENT: no such file");
    expect(await snapshot(root)).toEqual(before);
  });

  it("refuses a target whose path passes through a symlink loop, and writes nothing", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })] });
    gitInit(root);
    gitCommitAll(root, "init");

    const outside = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(outside, { recursive: true, force: true }));
    const type = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(path.join(outside, "loopb"), path.join(outside, "loopa"), type);
    await fs.symlink(path.join(outside, "loopa"), path.join(outside, "loopb"), type);

    const before = await snapshot(root);
    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", path.join(outside, "loopa", "plan.yaml"), "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot prove the target lies outside the Forge");
    // `lstat` through a symlink loop fails with ELOOP on Linux, so the path cannot even be
    // inspected; on Windows `lstat` sees the junction and `realpath` fails, the other branch.
    if (process.platform !== "win32") expect(r.stderr).toContain("cannot be inspected (ELOOP)");
    else expect(r.stderr).toContain("exists but cannot be resolved");
    expect(await snapshot(root)).toEqual(before);
  });
});

describe("cli — suggested hunk classes (spec 08)", () => {
  const BASE = "# W\nBump `package.json` before the PR.\nshared\nStep 6: open the PR.\nend\n";
  const VARIANT = "# W\nBump `Directory.Build.props` before the PR.\nshared\nStep 5: open the PR.\nend\nonly here\n";
  async function classForge(): Promise<string> {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [
        rule("wf", BASE),
        { meta: { type: "rule", name: "wf--acme", as: "wf" }, files: { "rule.md": VARIANT, "extra.md": "x\n" } },
        rule("m", "same\n"),
        rule("m--acme", "same\n", { as: "m", targets: ["kiro"] }),
      ],
    });
    gitInit(root);
    gitCommitAll(root, "init");
    return root;
  }

  it("forge diff prints the class and reason after the unchanged prefix, and --json carries suggestion next to kind", async () => {
    const root = await classForge();
    const text = runCli(["forge", "diff", "rule/wf", "--forge", root]);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain("hunk 1  [inline]  lines 2–2  value: 1 token differs → param.package_json");
    expect(text.stdout).toContain("hunk 2  [inline]  lines 4–4  evolution: numbering differs");
    expect(text.stdout).toContain("block: only in the variant");
    const json = runCli(["forge", "diff", "rule/wf", "--forge", root, "--json"]);
    const hunks = JSON.parse(json.stdout)[0].diff.files[0].hunks;
    expect(hunks[0].kind).toBe("inline");
    expect(hunks[0].suggestion).toEqual({ class: "value", reason: "1 token differs", tokens: [{ a: "package.json", b: "Directory.Build.props", param: "param.package_json" }] });
    for (const h of hunks) expect("tokens" in h.suggestion).toBe(h.suggestion.class === "value");
  });

  it("forge variants appends the class counts, none for a variant without hunks, and --json carries classes", async () => {
    const root = await classForge();
    const text = runCli(["forge", "variants", "--forge", root]);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toMatch(/acme \([^)]*\) \[1 evolution · 1 value · 2 block\]/);
    expect(text.stdout).toMatch(/acme \(meta only\)(?! \[)/);
    const { groups } = JSON.parse(runCli(["forge", "variants", "--forge", root, "--json"]).stdout);
    const wf = groups.find((g: { base: string }) => g.base === "rule/wf").variants[0];
    expect(wf.classes).toEqual({ evolution: 1, value: 1, block: 2 });
    expect(wf.classes.evolution + wf.classes.value + wf.classes.block).toBe(wf.distance.hunks);
  });

  it("--save-plan writes a suggestion per hunk and none on one-sided entries; --plan ignores it", async () => {
    const planDir = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(planDir, { recursive: true, force: true }));
    const root = await classForge();
    const planPath = path.join(planDir, "plan.yaml");
    expect(runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", planPath, "--forge", root]).code).toBe(0);
    const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
    const paired = plan.files.find((f: { file: string }) => f.file === "rule.md");
    expect(paired.hunks.map((h: { suggestion: { class: string } }) => h.suggestion.class)).toEqual(["value", "evolution", "block"]);
    expect(paired.hunks.every((h: { take: string }) => h.take === "keep")).toBe(true);
    for (const f of plan.files.filter((f: { onlyIn?: string }) => f.onlyIn)) expect(f).not.toHaveProperty("suggestion");

    for (const h of paired.hunks) h.take = "variant";
    for (const f of plan.files.filter((f: { onlyIn?: string }) => f.onlyIn)) f.take = "variant";
    const variants = {
      edited: plan,
      mangled: { ...plan, files: plan.files.map((f: { hunks?: object[] }) => (f.hunks ? { ...f, hunks: f.hunks.map((h) => ({ ...h, suggestion: { class: "bogus" } })) } : f)) },
      removed: { ...plan, files: plan.files.map((f: { hunks?: object[] }) => (f.hunks ? { ...f, hunks: f.hunks.map(({ suggestion: _, ...h }: { suggestion?: unknown }) => h) } : f)) },
    };
    const results: Record<string, Record<string, string>> = {};
    for (const [name, p] of Object.entries(variants)) {
      const forgeRoot = await classForge();
      const file = path.join(planDir, `${name}.yaml`);
      await fs.writeFile(file, YAML.stringify(p));
      const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--plan", file, "--forge", forgeRoot]);
      expect(r.code, `${name}: ${r.stderr}`).toBe(0);
      const snap = await snapshot(forgeRoot);
      results[name] = Object.fromEntries(Object.entries(snap).filter(([k]) => !k.startsWith(".git/")));
    }
    expect(results.mangled).toEqual(results.edited);
    expect(results.removed).toEqual(results.edited);
  });
});

describe("cli — forge unify take: param (spec 09)", () => {
  async function paramForge(extra: Record<string, string> = {}): Promise<string> {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [rule("deploy", "use globex-api\nshared\nport 8080\n"), rule("deploy--acme", "use acme-api\nshared\nport 9090\n", { as: "deploy" })],
      recipes: [recipe("base", ["rule/deploy"]), recipe("base--acme", ["rule/deploy--acme"])],
      profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"])],
    });
    await writeFiles(root, extra);
    gitInit(root);
    gitCommitAll(root, "init");
    return root;
  }
  async function savedPlan(root: string, edit: (plan: any) => void): Promise<string> {
    const dir = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const planPath = path.join(dir, "plan.yaml");
    expect(runCli(["forge", "unify", "rule/deploy", "--profile", "acme", "--save-plan", planPath, "--forge", root]).code).toBe(0);
    const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
    edit(plan);
    const edited = path.join(dir, "edited.yaml");
    await fs.writeFile(edited, YAML.stringify(plan));
    return edited;
  }
  const asParams = (plan: any, keys: string[]) =>
    plan.files[0].hunks.forEach((h: any, i: number) => Object.assign(h, { take: "param", params: [{ ...h.params[0], key: keys[i] }] }));

  it("saves pre-filled params, applies an edited plan, and writes the base, its declarations and the profile", async () => {
    const root = await paramForge();
    const planPath = await savedPlan(root, (plan) => {
      expect(plan.files[0].hunks.map((h: any) => h.params)).toEqual([[{ token: "globex-api", key: "param.globex_api" }], [{ token: "8080", key: "param.8080" }]]);
      asParams(plan, ["deploy.api", "deploy.port"]);
    });
    const r = runCli(["forge", "unify", "rule/deploy", "--profile", "acme", "--plan", planPath, "--forge", root, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.params).toEqual([
      { key: "deploy.api", default: "globex-api", value: "acme-api" },
      { key: "deploy.port", default: "8080", value: "9090" },
    ]);
    expect(out.profileEdited).toBe("profiles/acme/profile.yaml");
    expect(out.variantRemoved).toBe("rule/deploy--acme");
    expect(out.warnings.join("\n")).toContain("deploy.api is now a parameter of rule/deploy");
    // Spec 10 removed W2: import now recognises a templated base.
    expect(out.warnings.join("\n")).not.toContain("craftar import does not recognise a templated ingredient yet");
    expect(await fs.readFile(path.join(root, "ingredients/rules/deploy/rule.md"), "utf8")).toBe("use {{deploy.api}}\nshared\nport {{deploy.port}}\n");
    expect(YAML.parse(await fs.readFile(path.join(root, "ingredients/rules/deploy/ingredient.yaml"), "utf8")).params).toEqual({
      "deploy.api": { default: "globex-api" },
      "deploy.port": { default: "8080" },
    });
    expect(YAML.parse(await fs.readFile(path.join(root, "profiles/acme/profile.yaml"), "utf8")).params).toEqual({ "deploy.api": "acme-api", "deploy.port": "9090" });
  });

  it("prints the param and profile lines in text mode", async () => {
    const root = await paramForge();
    const planPath = await savedPlan(root, (plan) => asParams(plan, ["deploy.api", "deploy.port"]));
    const r = runCli(["forge", "unify", "rule/deploy", "--profile", "acme", "--plan", planPath, "--forge", root]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('param deploy.api — default "globex-api" (rule/deploy) · "acme-api" (profile acme)');
    expect(r.stdout).toContain("~ ingredient.yaml");
    expect(r.stdout).toContain("~ profiles/acme/profile.yaml");
  });

  it("a Forge-level refusal writes nothing", async () => {
    const root = await paramForge({ "profiles/acme/profile.yaml": "name: acme\nrecipes:\n  - base--acme\nparams:\n  deploy.api: other\n" });
    const planPath = await savedPlan(root, (plan) => asParams(plan, ["deploy.api", "deploy.port"]));
    const r = runCli(["forge", "unify", "rule/deploy", "--profile", "acme", "--plan", planPath, "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("profile acme already sets deploy.api");
    expect(gitStatus(root)).toBe("");
  });

  it("refuses when the profile it would edit is not held by git", async () => {
    const root = await paramForge();
    const planPath = await savedPlan(root, (plan) => asParams(plan, ["deploy.api", "deploy.port"]));
    execFileSync("git", ["-C", root, "update-index", "--skip-worktree", "profiles/acme/profile.yaml"]);
    const r = runCli(["forge", "unify", "rule/deploy", "--profile", "acme", "--plan", planPath, "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("profile.yaml is not held by git");
  });
});

describe("cli — forge unify take: param, review follow-ups (spec 09)", () => {
  const EXTRACTED = path.resolve(__dirname, "golden/forge-param-expected");
  async function committedCopy(src: string, extra: Record<string, string> = {}): Promise<string> {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(async () => {
      await fs.chmod(path.join(root, "ingredients/rules"), 0o755).catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    });
    for (const rel of await listFiles(src)) {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.copyFile(path.join(src, rel), path.join(root, rel));
    }
    await writeFiles(root, extra);
    gitInit(root);
    gitCommitAll(root, "init");
    return root;
  }
  async function planFor(root: string, name: string, profileName: string, edit: (plan: any) => void): Promise<string> {
    const dir = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const saved = path.join(dir, "saved.yaml");
    const s = runCli(["forge", "unify", `rule/${name}`, "--profile", profileName, "--save-plan", saved, "--forge", root]);
    expect(s.code, s.stderr).toBe(0);
    const plan = YAML.parse(await fs.readFile(saved, "utf8"));
    edit(plan);
    const edited = path.join(dir, "edited.yaml");
    await fs.writeFile(edited, YAML.stringify(plan));
    return edited;
  }

  it("reuses a key already extracted: the second variant writes only its profile (edge case 6, AC 14)", async () => {
    const root = await committedCopy(EXTRACTED, {
      "ingredients/rules/deploy--initech/ingredient.yaml": "type: rule\nname: deploy--initech\nas: deploy\n",
      "ingredients/rules/deploy--initech/rule.md": "# Deploy\n\nBuild `initech-api` first.\nKeep the pipeline green.\nDeploy `initech-api` and `initech-web` together.\n",
      "recipes/base--initech.yaml": "name: base--initech\ningredients:\n  - rule/deploy--initech\n  - rule/ports\n  - rule/notes\n",
      "profiles/initech/profile.yaml": "name: initech\nrecipes:\n  - base--initech\n",
    });
    const before = { body: await fs.readFile(path.join(root, "ingredients/rules/deploy/rule.md"), "utf8"), meta: await fs.readFile(path.join(root, "ingredients/rules/deploy/ingredient.yaml"), "utf8") };
    const plan = await planFor(root, "deploy", "initech", (p) => {
      const [h1, h2] = p.files[0].hunks;
      Object.assign(h1, { take: "param", params: [{ token: "{{deploy.api}}", key: "deploy.api" }] });
      Object.assign(h2, { take: "param", params: [{ token: "{{deploy.api}}", key: "deploy.api" }, { token: "{{deploy.web}}", key: "deploy.web" }] });
    });
    const r = runCli(["forge", "unify", "rule/deploy", "--profile", "initech", "--plan", plan, "--forge", root, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.written).toEqual([]);
    expect(out.params).toEqual([
      { key: "deploy.api", default: "globex-api", value: "initech-api" },
      { key: "deploy.web", default: "globex-web", value: "initech-web" },
    ]);
    expect(out.profileEdited).toBe("profiles/initech/profile.yaml");
    expect(out.variantRemoved).toBe("rule/deploy--initech");
    expect(await fs.readFile(path.join(root, "ingredients/rules/deploy/rule.md"), "utf8")).toBe(before.body);
    expect(await fs.readFile(path.join(root, "ingredients/rules/deploy/ingredient.yaml"), "utf8")).toBe(before.meta);
    expect(YAML.parse(await fs.readFile(path.join(root, "profiles/initech/profile.yaml"), "utf8")).params).toEqual({ "deploy.api": "initech-api", "deploy.web": "initech-web" });
  });

  it("--json written lists ingredient.yaml when the declarations were written", async () => {
    const root = await committedCopy(path.resolve(__dirname, "golden/forge-param"));
    const plan = await planFor(root, "ports", "acme", (p) => Object.assign(p.files[0].hunks[0], { take: "param", params: [{ token: "8080", key: "ports.api" }] }));
    const out = JSON.parse(runCli(["forge", "unify", "rule/ports", "--profile", "acme", "--plan", plan, "--forge", root, "--json"]).stdout);
    expect(out.written).toEqual(["ingredient.yaml", "rule.md"]);
  });

  it("refuses when the profile it would edit is ignored, or untracked and hidden from git status (AC 10)", async () => {
    const ignored = await committedCopy(path.resolve(__dirname, "golden/forge-param"));
    execFileSync("git", ["-C", ignored, "rm", "-q", "--cached", "profiles/acme/profile.yaml"]);
    await fs.writeFile(path.join(ignored, ".gitignore"), "profiles/acme/profile.yaml\n");
    gitCommitAll(ignored, "ignore the acme profile");
    const p1 = await planFor(ignored, "ports", "acme", (p) => Object.assign(p.files[0].hunks[0], { take: "param", params: [{ token: "8080", key: "ports.api" }] }));
    const r1 = runCli(["forge", "unify", "rule/ports", "--profile", "acme", "--plan", p1, "--forge", ignored]);
    expect(r1.code).toBe(1);
    expect(r1.stderr).toContain("profiles/acme/profile.yaml is not held by git");

    const untracked = await committedCopy(path.resolve(__dirname, "golden/forge-param"));
    execFileSync("git", ["-C", untracked, "rm", "-q", "--cached", "profiles/acme/profile.yaml"]);
    execFileSync("git", ["-C", untracked, "commit", "-q", "-m", "untrack the acme profile"], { env: gitEnv() }); // no add -A: it would re-add the file
    execFileSync("git", ["-C", untracked, "config", "status.showUntrackedFiles", "no"]);
    const p2 = await planFor(untracked, "ports", "acme", (p) => Object.assign(p.files[0].hunks[0], { take: "param", params: [{ token: "8080", key: "ports.api" }] }));
    const r2 = runCli(["forge", "unify", "rule/ports", "--profile", "acme", "--plan", p2, "--forge", untracked]);
    expect(r2.code).toBe(1);
    expect(r2.stderr).toContain("profiles/acme/profile.yaml is not held by git");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a late failure names the profile it already wrote (AC 11)", async () => {
    const root = await committedCopy(path.resolve(__dirname, "golden/forge-param"));
    const plan = await planFor(root, "ports", "acme", (p) => Object.assign(p.files[0].hunks[0], { take: "param", params: [{ token: "8080", key: "ports.api" }] }));
    // Removing the variant's directory is the last step; a read-only parent makes it fail after every other write.
    await fs.chmod(path.join(root, "ingredients/rules"), 0o555);
    const r = runCli(["forge", "unify", "rule/ports", "--profile", "acme", "--plan", plan, "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("profiles/acme/profile.yaml");
  });

  it("a mixed plan: a workspace on the base sees update only where the evolution hunk moved it", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [rule("deploy", "use globex-api\nshared\nStep 6\n"), rule("deploy--acme", "use acme-api\nshared\nStep 5\n", { as: "deploy" })],
      recipes: [recipe("base", ["rule/deploy"]), recipe("base--acme", ["rule/deploy--acme"])],
      profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"])],
    });
    gitInit(root);
    gitCommitAll(root, "init");
    const ws: Record<string, string> = {};
    for (const p of ["acme", "globex"]) {
      ws[p] = await tmpDir(`craftar-cli-ws-${p}-`);
      cleanups.push(() => fs.rm(ws[p], { recursive: true, force: true }));
      await fs.writeFile(path.join(ws[p], "craftar.yaml"), YAML.stringify({ forge: root, profile: p }));
      expect(runCli(["sync", "--workspace", ws[p]]).code).toBe(0);
    }
    const plan = await planFor(root, "deploy", "acme", (p) => {
      Object.assign(p.files[0].hunks[0], { take: "param", params: [{ token: "globex-api", key: "deploy.api" }] });
      p.files[0].hunks[1].take = "variant";
    });
    expect(runCli(["forge", "unify", "rule/deploy", "--profile", "acme", "--plan", plan, "--forge", root]).code).toBe(0);
    const states = (w: string) => JSON.parse(runCli(["status", "--workspace", w, "--json"]).stdout).statuses.filter((s: { state: string }) => s.state !== "unchanged");
    expect(states(ws.acme)).toEqual([]);
    expect(states(ws.globex).map((s: { path: string; state: string }) => [s.path, s.state])).toEqual([[".claude/rules/deploy.md", "update"]]);
    expect(runCli(["sync", "--workspace", ws.globex]).code).toBe(0);
    expect(await fs.readFile(path.join(ws.globex, ".claude/rules/deploy.md"), "utf8")).toBe("use globex-api\nshared\nStep 5\n");
  });

  it("a key with a reused site and a literal site is not treated as reused: P16 still guards another profile", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [
        rule("deploy", "use {{deploy.api}} here\nshared\nalso globex-api there\n", { params: { "deploy.api": { default: "globex-api" } } }),
        rule("deploy--initech", "use initech-api here\nshared\nalso initech-api there\n", { as: "deploy" }),
      ],
      recipes: [recipe("base", ["rule/deploy"]), recipe("base--initech", ["rule/deploy--initech"])],
      profiles: [profile("initech", ["base--initech"]), profile("globex", ["base"], ["claude-code"], { params: { "deploy.api": "other-api" } })],
    });
    gitInit(root);
    gitCommitAll(root, "init");
    const plan = await planFor(root, "deploy", "initech", (p) => {
      Object.assign(p.files[0].hunks[0], { take: "param", params: [{ token: "{{deploy.api}}", key: "deploy.api" }] });
      Object.assign(p.files[0].hunks[1], { take: "param", params: [{ token: "globex-api", key: "deploy.api" }] });
    });
    const r = runCli(["forge", "unify", "rule/deploy", "--profile", "initech", "--plan", plan, "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("profile globex sets deploy.api");
    expect(gitStatus(root)).toBe("");
  });
});

describe("cli — import prints how a templated base was reused (spec 10 §4.2)", () => {
  it("prints the inferred, param, profile and split lines once each", async () => {
    const root = await tmpDir("craftar-cli-import-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    await writeFiles(path.join(root, "a"), { ".claude/rules/deploy.md": "use globex-api here\n" });
    expect(runCli(["import", "--from", "claude-code", "--forge", forge, "--profile", "a", "--workspace", path.join(root, "a")]).code).toBe(0);
    await fs.writeFile(path.join(forge, "ingredients/rules/deploy/rule.md"), "use {{deploy.api}} here\n");
    const meta = path.join(forge, "ingredients/rules/deploy/ingredient.yaml");
    await fs.writeFile(meta, (await fs.readFile(meta, "utf8")) + "params:\n  deploy.api:\n    default: globex-api\n");
    await writeFiles(path.join(root, "b"), { ".claude/rules/deploy.md": "use initech-api here\n", ".claude/rules/z.md": "# Z\n" });
    const r = runCli(["import", "--from", "claude-code", "--forge", forge, "--profile", "b", "--workspace", path.join(root, "b")]);
    expect(r.code, r.stderr).toBe(0);
    const count = (needle: string) => r.stdout.split(needle).length - 1;
    expect(count('inferred rule/deploy — deploy.api = "initech-api"')).toBe(1);
    expect(count('param deploy.api: (unset) → "initech-api"')).toBe(1);
    expect(count("profile profiles/b/profile.yaml created")).toBe(1);
    expect(count("recipes: base--b (this workspace has rule/z, which base lacks)")).toBe(1);
  });
});

describe("cli — sections (spec 11 §4.2, §4.3)", () => {
  const RP = (table: string) => `# Review posture\n\nDispatch reviewers after every commit.\n\n${table}\nNever edit what a reviewer reads.\n`;
  const ACME = "| Repo | Reviewer |\n|---|---|\n| `acme-api` | backend-reviewer |\n";
  const GLOBEX = "| Repo | Reviewer |\n|---|---|\n| `globex-api` | backend-reviewer |\n| `globex-web` | frontend-reviewer |\n| `globex-desktop` | desktop-reviewer |\n";
  const MARKED = (table: string) => RP(`<!-- craftar:section flavors -->\n${table}<!-- /craftar:section -->\n`);

  it("explain prints the sections line once, with each layer, and none for AGENTS.md (AC 10)", async () => {
    const body = "# R\n\n<!-- craftar:section flavors -->\nshared\n<!-- /craftar:section -->\n<!-- craftar:section extra -->\nmore\n<!-- /craftar:section -->\n<!-- craftar:section note -->\nn\n<!-- /craftar:section -->\n";
    const s = await scenario(
      {
        ingredients: [rule("review-posture", body, { inclusion: "always" })],
        recipes: [recipe("base", ["rule/review-posture"])],
        profiles: [profile("globex", ["base"], ["claude-code", "agents-md"], { sections: { "rule/review-posture": { flavors: "globex\n" } } })],
      },
      { config: { profile: "globex", overrides: { sections: { "rule/review-posture": { note: "" } } } } },
    );
    cleanups.push(s.cleanup);
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), "name: test-forge\nschema: 2\n");
    const r = runCli(["explain", ".claude/rules/review-posture.md", "--workspace", s.wsRoot]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.split("  sections    flavors (profile globex), extra (default), note (workspace)\n").length - 1).toBe(1);
    expect(r.stdout.indexOf("via recipes")).toBeLessThan(r.stdout.indexOf("sections"));
    expect(r.stdout.indexOf("sections")).toBeLessThan(r.stdout.indexOf("profile     globex"));
    const agents = runCli(["explain", "AGENTS.md", "--workspace", s.wsRoot]);
    expect(agents.code, agents.stderr).toBe(0);
    expect(agents.stdout).not.toContain("sections");
  });

  it("explain prints no sections line for an ingredient without markers", async () => {
    const s = await scenario(
      { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    const r = runCli(["explain", ".claude/rules/a.md", "--workspace", s.wsRoot]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toContain("sections");
  });

  it("import prints the forge, sectioned, section, profile and recipes lines once each, and rendered with its sections", async () => {
    const root = await tmpDir("craftar-cli-import-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const imp = (p: string) => runCli(["import", "--from", "claude-code", "--forge", forge, "--profile", p, "--workspace", path.join(root, p)]);
    await writeFiles(path.join(root, "acme"), { ".claude/rules/review-posture.md": RP(ACME) });
    await writeFiles(path.join(root, "globex"), { ".claude/rules/review-posture.md": RP(GLOBEX) });
    expect(imp("acme").code).toBe(0);
    expect(imp("globex").stdout).toContain("variant rule/review-posture--globex");
    await fs.writeFile(path.join(forge, "ingredients/rules/review-posture/rule.md"), MARKED(ACME));

    const a = imp("acme");
    expect(a.code, a.stderr).toBe(0);
    const count = (out: string, needle: string) => out.split(needle).length - 1;
    expect(count(a.stdout, "forge craftar.forge.yaml edited (schema: 2)\n")).toBe(1);

    const g = imp("globex");
    expect(g.code, g.stderr).toBe(0);
    expect(count(g.stdout, "0 created, 1 reused, 0 variants, 0 rejected")).toBe(1);
    expect(count(g.stdout, "sectioned rule/review-posture — flavors\n")).toBe(1);
    expect(count(g.stdout, "section rule/review-posture flavors: (default) → 5 lines\n")).toBe(1);
    expect(count(g.stdout, "profile profiles/globex/profile.yaml edited (sections, recipes)\n")).toBe(1);
    expect(count(g.stdout, "recipes: base\n")).toBe(1);
    expect(count(g.stdout, "warn profile globex now sets section flavors of rule/review-posture — every workspace on globex renders it at its next sync; import cannot reach them")).toBe(1);
    expect(g.stdout).not.toContain("forge craftar.forge.yaml edited");
    expect(g.stdout).not.toContain("globex-desktop");

    const again = imp("globex");
    expect(again.code, again.stderr).toBe(0);
    expect(count(again.stdout, "rendered rule/review-posture — sections flavors\n")).toBe(1);
    expect(again.stdout).not.toContain("sectioned");
    expect(again.stdout).not.toContain("section rule/review-posture flavors:");
  });

  it("forge unify prints U1 and exits 1 with the Forge untouched", async () => {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [rule("review-posture", MARKED(ACME)), rule("review-posture--globex", RP(GLOBEX), { as: "review-posture" })],
      recipes: [recipe("base", ["rule/review-posture"]), recipe("base--globex", ["rule/review-posture--globex"])],
      profiles: [profile("acme", ["base"]), profile("globex", ["base--globex"])],
    });
    gitInit(root);
    gitCommitAll(root, "init");
    const before = await snapshot(root);
    const r = runCli(["forge", "unify", "rule/review-posture", "--profile", "globex", "--take", "variant", "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      "error: unify: ingredients/rules/review-posture/rule.md would lose or change section markers (sections flavors would become none) — take base for the marker lines, or take: section to fill the section",
    );
    expect(await snapshot(root)).toEqual(before);
    expect(gitStatus(root)).toBe("");
  });
});

describe("forge unify take: section (spec 12)", () => {
  // Helper functions for section extraction tests
  async function sectionForge(extra: Record<string, string> = {}): Promise<string> {
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    // Base and variant with only the table differing — creates a block hunk
    const baseBody = "# Review posture\n\nDispatch reviewers.\n\nshared line\n";
    const variantBody = "# Review posture\n\nDispatch reviewers.\n\n| Repo | Reviewer |\n|---|---|\n| `acme-api` | backend |\n\nshared line\n";
    await makeForge(root, {
      ingredients: [
        rule("review-posture", baseBody),
        rule("review-posture--acme", variantBody, { as: "review-posture" }),
      ],
      recipes: [recipe("base", ["rule/review-posture"]), recipe("base--acme", ["rule/review-posture--acme"])],
      profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"])],
    });
    await writeFiles(root, extra);
    gitInit(root);
    gitCommitAll(root, "init");
    return root;
  }

  async function savedSectionPlan(root: string, edit: (plan: any) => void): Promise<string> {
    const dir = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const planPath = path.join(dir, "plan.yaml");
    expect(runCli(["forge", "unify", "rule/review-posture", "--profile", "acme", "--save-plan", planPath, "--forge", root]).code).toBe(0);
    const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
    edit(plan);
    const edited = path.join(dir, "edited.yaml");
    await fs.writeFile(edited, YAML.stringify(plan));
    return edited;
  }

  it("a full run: --save-plan → edit → --plan exits 0, writes manifest, body with markers, profile with value, removes variant", async () => {
    const root = await sectionForge();
    const planPath = await savedSectionPlan(root, (plan) => {
      // The hunk should have a pre-filled section (from the heading slug or as block)
      expect(plan.files[0].hunks.length).toBe(1);
      expect(plan.files[0].hunks[0].suggestion.class).toBe("block");
      expect(plan.files[0].hunks[0].section).toBeDefined();
      // Set take: section and use the pre-filled name or a custom one
      plan.files[0].hunks[0].take = "section";
      plan.files[0].hunks[0].section = { name: "flavors" }; // No lines needed for a block hunk
    });

    const r = runCli(["forge", "unify", "rule/review-posture", "--profile", "acme", "--plan", planPath, "--forge", root]);
    expect(r.code, r.stderr).toBe(0);

    // Text report checks
    expect(r.stdout).toContain("forge craftar.forge.yaml edited (schema: 2)");
    expect(r.stdout).toContain("section rule/review-posture flavors — default");
    expect(r.stdout).toContain("(profile acme)");
    expect(r.stdout).toContain("~ profiles/acme/profile.yaml");
    expect(r.stdout).toContain("removed variant rule/review-posture--acme");
    // W3 warning
    expect(r.stdout).toContain("warn flavors is now a section of rule/review-posture");
    expect(r.stdout).toContain("overrides.sections.rule/review-posture.flavors");

    // Verify files on disk
    const body = await fs.readFile(path.join(root, "ingredients/rules/review-posture/rule.md"), "utf8");
    expect(body).toContain("<!-- craftar:section flavors -->");
    expect(body).toContain("<!-- /craftar:section -->");

    const profileYaml = YAML.parse(await fs.readFile(path.join(root, "profiles/acme/profile.yaml"), "utf8"));
    expect(profileYaml.sections?.["rule/review-posture"]?.flavors).toBeDefined();

    const manifest = YAML.parse(await fs.readFile(path.join(root, "craftar.forge.yaml"), "utf8"));
    expect(manifest.schema).toBe(2);

    // Variant directory is gone
    expect(await fs.access(path.join(root, "ingredients/rules/review-posture--acme")).then(() => true, () => false)).toBe(false);
  });

  it("--json includes sections array and manifestEdited: true", async () => {
    const root = await sectionForge();
    const planPath = await savedSectionPlan(root, (plan) => {
      plan.files[0].hunks[0].take = "section";
      plan.files[0].hunks[0].section = { name: "flavors" };
    });

    const r = runCli(["forge", "unify", "rule/review-posture", "--profile", "acme", "--plan", planPath, "--forge", root, "--json"]);
    expect(r.code, r.stderr).toBe(0);

    const out = JSON.parse(r.stdout);
    expect(out.manifestEdited).toBe(true);
    expect(out.sections).toHaveLength(1);
    expect(out.sections[0]).toMatchObject({
      key: "rule/review-posture",
      name: "flavors",
      file: "rule.md",
      existing: false,
      written: true,
    });
    expect(typeof out.sections[0].defaultLines).toBe("number");
    expect(typeof out.sections[0].valueLines).toBe("number");
    expect(out.profileEdited).toBe("profiles/acme/profile.yaml");
  });

  it("a plan without section hunks has sections: [] and manifestEdited: false", async () => {
    const root = await sectionForge();
    // Use --take base to resolve without sections
    const r = runCli(["forge", "unify", "rule/review-posture", "--profile", "acme", "--take", "base", "--forge", root, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.sections).toEqual([]);
    expect(out.manifestEdited).toBe(false);
  });

  it("an existing section: shows '— existing ·', no manifest line, no W3", async () => {
    // Create a Forge where the base already has markers
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const baseBody = "# Review posture\n\n<!-- craftar:section flavors -->\n| globex |\n<!-- /craftar:section -->\n";
    const variantBody = "# Review posture\n\n| acme |\n| acme-web |\n";
    await makeForge(root, {
      manifest: { schema: 2 },
      ingredients: [
        rule("review-posture", baseBody),
        rule("review-posture--acme", variantBody, { as: "review-posture" }),
      ],
      recipes: [recipe("base", ["rule/review-posture"]), recipe("base--acme", ["rule/review-posture--acme"])],
      profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"])],
    });
    gitInit(root);
    gitCommitAll(root, "init");

    const dir = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const planPath = path.join(dir, "plan.yaml");
    expect(runCli(["forge", "unify", "rule/review-posture", "--profile", "acme", "--save-plan", planPath, "--forge", root]).code).toBe(0);
    const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
    // Hunks touching existing section should have pre-filled name
    for (const h of plan.files[0].hunks) {
      h.take = "section";
      h.section = { name: "flavors" };
    }
    const edited = path.join(dir, "edited.yaml");
    await fs.writeFile(edited, YAML.stringify(plan));

    const r = runCli(["forge", "unify", "rule/review-posture", "--profile", "acme", "--plan", edited, "--forge", root]);
    expect(r.code, r.stderr).toBe(0);

    // Text report: existing section format
    expect(r.stdout).toContain("— existing ·");
    // No manifest line (already schema: 2)
    expect(r.stdout).not.toContain("forge craftar.forge.yaml edited");
    // No W3 warning for existing section
    expect(r.stdout).not.toContain("is now a section of");
  });

  it("an already-in-place value: line ends with ' — already in place'", async () => {
    // Forge A: run a full extraction to learn the exact value
    const rootA = await sectionForge();
    const planA = await savedSectionPlan(rootA, (plan) => {
      plan.files[0].hunks[0].take = "section";
      plan.files[0].hunks[0].section = { name: "flavors" };
    });
    expect(runCli(["forge", "unify", "rule/review-posture", "--profile", "acme", "--plan", planA, "--forge", rootA]).code).toBe(0);
    const profileA = YAML.parse(await fs.readFile(path.join(rootA, "profiles/acme/profile.yaml"), "utf8"));
    const extractedValue = profileA.sections["rule/review-posture"].flavors;

    // Forge B: identical structure, but pre-write the value into the profile
    const rootB = await sectionForge({
      "profiles/acme/profile.yaml": YAML.stringify({
        name: "acme",
        recipes: ["base--acme"],
        params: {},
        sections: { "rule/review-posture": { flavors: extractedValue } },
      }),
    });
    const profileBefore = await fs.readFile(path.join(rootB, "profiles/acme/profile.yaml"), "utf8");
    const planB = await savedSectionPlan(rootB, (plan) => {
      plan.files[0].hunks[0].take = "section";
      plan.files[0].hunks[0].section = { name: "flavors" };
    });

    const rText = runCli(["forge", "unify", "rule/review-posture", "--profile", "acme", "--plan", planB, "--forge", rootB]);
    expect(rText.code, rText.stderr).toBe(0);
    // The section line ends with "— already in place"
    expect(rText.stdout).toMatch(/section rule\/review-posture flavors.*— already in place/);
    // No profile edit line (the value is in place, so the profile is not touched)
    expect(rText.stdout).not.toContain("~ profiles/acme/profile.yaml");
    // Profile bytes unchanged
    expect(await fs.readFile(path.join(rootB, "profiles/acme/profile.yaml"), "utf8")).toBe(profileBefore);
    // But the manifest IS bumped (pinning fix 21d4f5d — a new section adds markers, so schema: 2 is required)
    expect(rText.stdout).toContain("forge craftar.forge.yaml edited (schema: 2)");
    const manifestB = YAML.parse(await fs.readFile(path.join(rootB, "craftar.forge.yaml"), "utf8"));
    expect(manifestB.schema).toBe(2);

    // --json: sections[0].written === false and manifestEdited === true
    const rootC = await sectionForge({
      "profiles/acme/profile.yaml": YAML.stringify({
        name: "acme",
        recipes: ["base--acme"],
        params: {},
        sections: { "rule/review-posture": { flavors: extractedValue } },
      }),
    });
    const planC = await savedSectionPlan(rootC, (plan) => {
      plan.files[0].hunks[0].take = "section";
      plan.files[0].hunks[0].section = { name: "flavors" };
    });
    const rJson = runCli(["forge", "unify", "rule/review-posture", "--profile", "acme", "--plan", planC, "--forge", rootC, "--json"]);
    expect(rJson.code, rJson.stderr).toBe(0);
    const out = JSON.parse(rJson.stdout);
    expect(out.sections[0].written).toBe(false);
    expect(out.manifestEdited).toBe(true);
  });

  it("mustHold: an untracked manifest makes the run exit 1 naming it, Forge untouched", async () => {
    const root = await sectionForge();
    // Untrack the manifest
    execFileSync("git", ["-C", root, "rm", "-q", "--cached", "craftar.forge.yaml"]);
    execFileSync("git", ["-C", root, "config", "status.showUntrackedFiles", "no"]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "untrack manifest"], { env: gitEnv() });

    const planPath = await savedSectionPlan(root, (plan) => {
      plan.files[0].hunks[0].take = "section";
      plan.files[0].hunks[0].section = { name: "flavors" };
    });

    const before = await snapshot(root);
    const r = runCli(["forge", "unify", "rule/review-posture", "--profile", "acme", "--plan", planPath, "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("craftar.forge.yaml is not held by git");
    expect(await snapshot(root)).toEqual(before);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a late failure after the manifest write names craftar.forge.yaml in the recovery commands", async () => {
    // Use a helper that restores the permission in cleanup so the temp dir can be removed
    const root = await tmpDir("craftar-cli-forge-");
    cleanups.push(async () => {
      await fs.chmod(path.join(root, "ingredients/rules"), 0o755).catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    });
    // Build the same Forge structure as sectionForge
    const baseBody = "# Review posture\n\nDispatch reviewers.\n\nshared line\n";
    const variantBody = "# Review posture\n\nDispatch reviewers.\n\n| Repo | Reviewer |\n|---|---|\n| `acme-api` | backend |\n\nshared line\n";
    await makeForge(root, {
      ingredients: [
        rule("review-posture", baseBody),
        rule("review-posture--acme", variantBody, { as: "review-posture" }),
      ],
      recipes: [recipe("base", ["rule/review-posture"]), recipe("base--acme", ["rule/review-posture--acme"])],
      profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"])],
    });
    gitInit(root);
    gitCommitAll(root, "init");

    // Save and edit the plan
    const dir = await tmpDir("craftar-cli-plan-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const planPath = path.join(dir, "plan.yaml");
    expect(runCli(["forge", "unify", "rule/review-posture", "--profile", "acme", "--save-plan", planPath, "--forge", root]).code).toBe(0);
    const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
    plan.files[0].hunks[0].take = "section";
    plan.files[0].hunks[0].section = { name: "flavors" };
    const edited = path.join(dir, "edited.yaml");
    await fs.writeFile(edited, YAML.stringify(plan));

    // Make ingredients/rules read-only: the variant removal (last write) will fail
    await fs.chmod(path.join(root, "ingredients/rules"), 0o555);

    const r = runCli(["forge", "unify", "rule/review-posture", "--profile", "acme", "--plan", edited, "--forge", root]);
    expect(r.code).toBe(1);
    // stderr names craftar.forge.yaml (the manifest was touched)
    expect(r.stderr).toContain("craftar.forge.yaml");
    // stderr names the profile (it was edited)
    expect(r.stderr).toContain("profiles/acme/profile.yaml");
    // stderr names the body file (it was written with markers)
    expect(r.stderr).toContain("ingredients/rules/review-posture/rule.md");
    // The recovery line shows git checkout for those paths
    expect(r.stderr).toContain("git -C");
    expect(r.stderr).toContain("checkout --");
  });

  // Table-driven refusal tests: each scenario exits 1, emits the fragment, and leaves the Forge untouched.
  const refusalCases: Array<{
    name: string;
    fragment: string;
    setup: () => Promise<{ root: string; planPath: string }>;
  }> = [
    {
      name: "S5: lines out of range",
      fragment: "out of range",
      setup: async () => {
        const root = await tmpDir("craftar-cli-s5-");
        cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
        // Base and variant with a block hunk
        await makeForge(root, {
          ingredients: [
            rule("wf", "a\nb\nc\n"),
            rule("wf--acme", "a\nB\nc\n", { as: "wf" }),
          ],
          recipes: [recipe("base", ["rule/wf"]), recipe("base--acme", ["rule/wf--acme"])],
          profiles: [profile("acme", ["base--acme"])],
        });
        gitInit(root);
        gitCommitAll(root, "init");
        const dir = await tmpDir("craftar-cli-plan-");
        cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
        const planPath = path.join(dir, "plan.yaml");
        expect(runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", planPath, "--forge", root]).code).toBe(0);
        const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
        plan.files[0].hunks[0].take = "section";
        plan.files[0].hunks[0].section = { name: "data", lines: "1-100" }; // out of range
        const edited = path.join(dir, "edited.yaml");
        await fs.writeFile(edited, YAML.stringify(plan));
        return { root, planPath: edited };
      },
    },
    {
      name: "S5 without lines: existing section covers take: base hunk (Case D)",
      fragment: "section flavors (lines ",
      setup: async () => {
        const root = await tmpDir("craftar-cli-s5-");
        cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
        // Base with markers at lines 3-7: opener, a, b, c, closer
        // Variant without markers: a, B, C (b and c changed)
        const baseBody = "H\n\n<!-- craftar:section flavors -->\na\nb\nc\n<!-- /craftar:section -->\n\nF\n";
        const variantBody = "H\n\na\nB\nC\n\nF\n";
        await makeForge(root, {
          ingredients: [
            rule("wf", baseBody),
            rule("wf--acme", variantBody, { as: "wf" }),
          ],
          recipes: [recipe("base", ["rule/wf"]), recipe("base--acme", ["rule/wf--acme"])],
          profiles: [profile("acme", ["base--acme"])],
        });
        gitInit(root);
        gitCommitAll(root, "init");
        const dir = await tmpDir("craftar-cli-plan-");
        cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
        const planPath = path.join(dir, "plan.yaml");
        expect(runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", planPath, "--forge", root]).code).toBe(0);
        const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
        // Hunk 1: section flavors, hunk 2: base (covers hunk 2, which is inside span 3-7)
        plan.files[0].hunks[0].take = "section";
        plan.files[0].hunks[0].section = { name: "flavors" };
        plan.files[0].hunks[1].take = "base";
        const edited = path.join(dir, "edited.yaml");
        await fs.writeFile(edited, YAML.stringify(plan));
        return { root, planPath: edited };
      },
    },
    {
      name: "S12: variant holds a section marker",
      fragment: "holds a section marker",
      setup: async () => {
        const root = await tmpDir("craftar-cli-s12-");
        cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
        // Variant has a marker
        await makeForge(root, {
          ingredients: [
            rule("wf", "a\nb\n"),
            rule("wf--acme", "a\n<!-- craftar:section x -->\ny\n<!-- /craftar:section -->\n", { as: "wf" }),
          ],
          recipes: [recipe("base", ["rule/wf"]), recipe("base--acme", ["rule/wf--acme"])],
          profiles: [profile("acme", ["base--acme"])],
        });
        gitInit(root);
        gitCommitAll(root, "init");
        const dir = await tmpDir("craftar-cli-plan-");
        cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
        const planPath = path.join(dir, "plan.yaml");
        expect(runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", planPath, "--forge", root]).code).toBe(0);
        const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
        // Set take: section on hunks
        for (const h of plan.files[0].hunks) {
          h.take = "section";
          h.section = { name: "s" };
        }
        const edited = path.join(dir, "edited.yaml");
        await fs.writeFile(edited, YAML.stringify(plan));
        return { root, planPath: edited };
      },
    },
    {
      name: "S13: another profile sets the section",
      fragment: "it names no marker today and would start to apply",
      setup: async () => {
        const root = await tmpDir("craftar-cli-s13-");
        cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
        await makeForge(root, {
          ingredients: [
            rule("wf", "a\nb\n"),
            rule("wf--acme", "a\nB\n", { as: "wf" }),
          ],
          recipes: [recipe("base", ["rule/wf"]), recipe("base--acme", ["rule/wf--acme"])],
          profiles: [
            profile("acme", ["base--acme"]),
            // globex sets section 'data' on rule/wf — this would start to apply after acme's extraction
            { name: "globex", recipes: ["base"], targets: ["claude-code"], params: {}, sections: { "rule/wf": { data: "other\n" } } },
          ],
        });
        gitInit(root);
        gitCommitAll(root, "init");
        const dir = await tmpDir("craftar-cli-plan-");
        cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
        const planPath = path.join(dir, "plan.yaml");
        expect(runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", planPath, "--forge", root]).code).toBe(0);
        const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
        plan.files[0].hunks[0].take = "section";
        plan.files[0].hunks[0].section = { name: "data" }; // same name globex already sets
        const edited = path.join(dir, "edited.yaml");
        await fs.writeFile(edited, YAML.stringify(plan));
        return { root, planPath: edited };
      },
    },
    {
      name: "S16: profile sections is an alias",
      fragment: "sections is an alias",
      setup: async () => {
        const root = await tmpDir("craftar-cli-s16-");
        cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
        await makeForge(root, {
          ingredients: [
            rule("wf", "a\nb\n"),
            rule("wf--acme", "a\nB\n", { as: "wf" }),
          ],
          recipes: [recipe("base", ["rule/wf"]), recipe("base--acme", ["rule/wf--acme"])],
          profiles: [profile("acme", ["base--acme"])],
        });
        // Overwrite the profile with a YAML alias
        await fs.writeFile(path.join(root, "profiles/acme/profile.yaml"), "name: acme\nrecipes:\n  - base--acme\nx: &s {}\nsections: *s\n");
        gitInit(root);
        gitCommitAll(root, "init");
        const dir = await tmpDir("craftar-cli-plan-");
        cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
        const planPath = path.join(dir, "plan.yaml");
        expect(runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", planPath, "--forge", root]).code).toBe(0);
        const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
        plan.files[0].hunks[0].take = "section";
        plan.files[0].hunks[0].section = { name: "data" };
        const edited = path.join(dir, "edited.yaml");
        await fs.writeFile(edited, YAML.stringify(plan));
        return { root, planPath: edited };
      },
    },
  ];

  it.each(refusalCases)("$name: exits 1, emits fragment, Forge untouched", async ({ fragment, setup }) => {
    const { root, planPath } = await setup();
    const before = await snapshot(root);
    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--plan", planPath, "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(fragment);
    expect(await snapshot(root)).toEqual(before);
  });
});
