import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import YAML from "yaml";
import { makeForge, profile, recipe, rule, scenario, tmpDir, writeFiles } from "./helpers/forge.js";
import { runCli } from "./helpers/cli.js";
import { git, remoteForge } from "./helpers/remote.js";
import { TSX_LOADER } from "./helpers/tsx-loader.js";
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
      recipes: { rewritten: ["base"], identicalToSibling: [], pruned: [], kept: [] },
      metaDiffers: [],
      // Spec 09 §4.5: always present, [] / null when the plan extracts nothing.
      params: [],
      // Spec 12 §4.5: always present, [] / false when no section hunk.
      sections: [],
      manifestEdited: false,
      profileEdited: null,
      // Ruling 38: a removed variant always warns about overrides.ingredients.disable.
      // Spec 25 §4.3: with no registered workspace, the warning gains the suffix.
      warnings: [
        "rule/wf--acme was removed — a workspace that disables it in overrides.ingredients.disable (craftar.yaml or craftar.local.yaml) " +
          "must now name rule/wf, or the base comes back enabled; unify cannot reach workspaces (no workspace of this Forge is registered on this machine)",
      ],
      // Spec 25 §4.2: always present, [] when no workspace was checked.
      impact: [],
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
    expect(out.recipes).toEqual({ rewritten: ["base--acme"], identicalToSibling: ["base--acme"], pruned: [], kept: [] });
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
      results[name] = snap;
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


/* ------------------------------------------------------------------ */
/* craftar ls pin (spec 16 §10.3): captures the exact output before  */
/* the catalogue commands, so a later change is a test failure.       */
/* ------------------------------------------------------------------ */
describe("craftar ls pin (spec 16 §10.3)", () => {
  it("prints the exact expected output on the golden acme-portal workspace", async () => {
    // Set up the golden scenario: import acme-portal to create a Forge and craftar.yaml
    const root = await tmpDir("craftar-ls-pin-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const portal = path.join(root, "acme-portal");
    const forge = path.join(root, "forge");

    // Copy the golden workspace
    async function cp(src: string, dst: string) {
      for (const rel of await listFiles(src)) {
        await fs.mkdir(path.dirname(path.join(dst, rel)), { recursive: true });
        await fs.copyFile(path.join(src, rel), path.join(dst, rel));
      }
    }
    await cp(path.join(__dirname, "golden", "acme-portal"), portal);

    // Import to create the Forge and craftar.yaml
    const imp = runCli([
      "import",
      "--from", "claude-code",
      "--workspace", portal,
      "--forge", forge,
      "--profile", "acme-portal",
      "--write-config",
    ]);
    expect(imp.code).toBe(0);

    // Run ls and capture output
    const r = runCli(["ls", "--workspace", portal]);
    expect(r.code).toBe(0);

    // The expected output.
    // The Forge name is "forge" (from importClaudeCode default), commit is "no git" (temp dir has no git).
    // The output is pinned so any change to ls is caught.
    const expected = `Forge forge @ no git · profile acme-portal

base — Always-on conventions, commands, agents, scripts and MCP servers.
  rule/commit-conventions
  rule/workflow
  agent/docs-author
  agent/release-helper
  command/commit-push
  skill/spec-driven
  script/check-branch
  mcp/playwright

stack-backend-node — Conventions + reviewer for repos matching projects/acme-api/**
  rule/backend-node
  agent/backend-node-reviewer

acme-portal-steering — Hand-written Kiro steering specific to acme-portal.
  steering/product

20 files across targets claude-code, kiro
`;

    expect(r.stdout).toBe(expected);
  });
});

/* ------------------------------------------------------------------ */
/* spec 16 §10.3: craftar recipes, ingredients, targets               */
/* ------------------------------------------------------------------ */
describe("cli — the read-only catalogue (spec 16 §10.3)", () => {
  const CAT_FORGE = {
    ingredients: [
      rule("angular-standards", "# A\n", { description: "Angular conventions" }),
      rule("commit-style", "# C\n"),
      rule("old-naming", "# O\n", { targets: ["kiro"] }),
      rule("workflow--acme", "# W\n", { as: "workflow" }),
      { meta: { type: "agent", name: "angular-reviewer" } },
    ],
    recipes: [
      recipe("base", ["rule/workflow--acme", "rule/commit-style", "rule/gone"], { description: "Shared conventions" }),
      recipe("stack-angular", ["rule/angular-standards", "agent/angular-reviewer"], { description: "Angular front end", slot: "frontend", extends: ["base"] }),
    ],
    profiles: [profile("acme", ["base"], ["claude-code", "kiro"])],
  };
  const CAT_WS = { profile: "acme", recipes: { add: ["stack-angular"] }, overrides: { ingredients: { disable: ["rule/commit-style"] } } };
  const GONE = 'recipe "base" references missing ingredient rule/gone';

  async function cat(config: Record<string, unknown> = CAT_WS) {
    const s = await scenario(CAT_FORGE, { config });
    cleanups.push(s.cleanup);
    await writeFiles(s.forgeRoot, { "craftar.forge.yaml": "name: acme-forge\nschema: 1\n" });
    return s;
  }
  async function bare() {
    const dir = await tmpDir("craftar-cat-bare-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
  }
  const json = (r: { code: number | null; stdout: string; stderr: string }) => {
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    return JSON.parse(r.stdout);
  };
  const keys = (o: object) => Object.keys(o).sort();

  it("recipes --json: exactly the key set of §4.2 at every level", async () => {
    const s = await cat();
    const j = json(runCli(["recipes", "--json", "--workspace", s.wsRoot]));
    expect(keys(j)).toEqual(["context", "forge", "recipes", "warnings"]);
    expect(keys(j.forge)).toEqual(["commit", "name"]);
    expect(keys(j.context)).toEqual(["kind", "profile", "recipes"]);
    for (const r of j.recipes) expect(keys(r)).toEqual(["description", "extends", "inUse", "ingredients", "name", "profiles", "removedByWorkspace", "slot"]);
    expect(keys(j.recipes[0].inUse)).toEqual(["by", "extendedBy", "order"]);
    expect(j.warnings).toEqual([GONE]);
  });

  it("ingredients --json: exactly the key set of §4.3 at every level", async () => {
    const s = await cat();
    const j = json(runCli(["ingredients", "--json", "--recipe", "stack-angular", "--workspace", s.wsRoot]));
    expect(keys(j)).toEqual(["context", "forge", "ingredients", "missing", "recipe", "warnings"]);
    expect(keys(j.recipe)).toEqual(["chain", "name"]);
    for (const c of j.recipe.chain) expect(keys(c)).toEqual(["ingredients", "recipe"]);
    for (const i of j.ingredients) expect(keys(i)).toEqual(["description", "disabled", "inUse", "name", "outputName", "recipes", "ref", "targets", "type"]);
    expect(j.missing).toEqual([{ ref: "rule/gone", recipes: ["base"] }]);
    expect(j.warnings).toEqual([GONE]);
  });

  it("targets --json: exactly the key set of §4.4 at every level, 24 cells", async () => {
    const dir = await bare();
    const j = json(runCli(["targets", "--json"], { cwd: dir }));
    expect(keys(j)).toEqual(["ingredientTypes", "targets", "warnings"]);
    expect(j.ingredientTypes).toEqual(["rule", "agent", "command", "skill", "mcp", "script", "steering", "hook"]);
    expect(j.targets.map((t: { name: string }) => t.name)).toEqual(["claude-code", "kiro", "agents-md"]);
    let cells = 0;
    for (const t of j.targets) {
      expect(keys(t)).toEqual(["capabilities", "inUse", "name"]);
      expect(Object.keys(t.capabilities)).toEqual(j.ingredientTypes);
      for (const c of Object.values(t.capabilities) as object[]) {
        expect(keys(c)).toEqual(["note", "output", "state"]);
        cells++;
      }
    }
    expect(cells).toBe(24);
    expect(j.targets[1].capabilities.rule).toEqual({
      state: "converted",
      output: [".kiro/steering/<name>.md"],
      note: "inclusion frontmatter and a banner are added; a .claude/rules/ reference becomes .kiro/steering/ when kiro writes that file, and otherwise follows the rule it names (kept for claude-code, AGENTS.md (rule: <x>), or <x> (rule not in this workspace) with a warning)",
    });
    expect(j.targets[1].capabilities.script).toEqual({ state: "unsupported", output: [], note: "skipped with a warning when aimed at this target" });
    expect(j.warnings).toEqual([]);
  });

  it("recipes and ingredients: --forge alone, --forge --profile, inside a workspace (cwd), --workspace", async () => {
    const s = await cat();
    for (const cmd of ["recipes", "ingredients"]) {
      expect(json(runCli([cmd, "--json", "--forge", s.forgeRoot])).context, cmd).toBeNull();
      expect(json(runCli([cmd, "--json", "--forge", s.forgeRoot, "--profile", "acme"])).context, cmd).toEqual({ kind: "profile", profile: "acme", recipes: ["base"] });
      const inWs = { kind: "workspace", profile: "acme", recipes: ["base", "stack-angular"] };
      expect(json(runCli([cmd, "--json"], { cwd: s.wsRoot })).context, cmd).toEqual(inWs);
      expect(json(runCli([cmd, "--json", "--workspace", s.wsRoot])).context, cmd).toEqual(inWs);
    }
  });

  it("recipes and ingredients: every refusal of §4.1 exits 1 with its message", async () => {
    const s = await cat();
    const outside = await bare();
    const notForge = await bare();
    const err = (msg: string) => `error: ${msg}\n`;
    for (const cmd of ["recipes", "ingredients"]) {
      const cases: Array<[string[], string | undefined, string]> = [
        [[cmd, "--forge", s.forgeRoot, "--workspace", s.wsRoot], undefined, err("pass either --forge or --workspace, not both — two sources for one Forge")],
        [[cmd], outside, err(`no craftar.yaml in ${outside} — run this inside a workspace, pass --workspace <dir>, or point at the Forge with --forge <dir>`)],
        [[cmd, "--workspace", outside], undefined, err(`no craftar.yaml in ${outside} — run this inside a workspace, pass --workspace <dir>, or point at the Forge with --forge <dir>`)],
        [[cmd, "--forge", notForge], undefined, err(`not a Forge: ${path.join(notForge, "craftar.forge.yaml")} not found`)],
        [[cmd, "--profile", "acme", "--workspace", s.wsRoot], undefined, err("--profile goes with --forge — inside a workspace the profile comes from craftar.yaml")],
        [[cmd, "--profile", "acme"], s.wsRoot, err("--profile goes with --forge — inside a workspace the profile comes from craftar.yaml")],
        [[cmd, "--forge", s.forgeRoot, "--profile", "nobody"], undefined, err('profile "nobody" not found in Forge (acme)')],
      ];
      for (const [args, cwd, stderr] of cases) {
        const r = runCli(args, cwd ? { cwd } : {});
        expect(r.code, args.join(" ")).toBe(1);
        expect(r.stderr, args.join(" ")).toBe(stderr);
        expect(r.stdout, args.join(" ")).toBe("");
      }
    }
  });

  it("recipes and ingredients: a workspace that does not load, or names an unknown profile, exits 1", async () => {
    for (const cmd of ["recipes", "ingredients"]) {
      const invalid = await cat();
      await fs.writeFile(path.join(invalid.wsRoot, "craftar.yaml"), "forge: 42\nprofile: acme\n");
      const r1 = runCli([cmd, "--workspace", invalid.wsRoot]);
      expect(r1.code, cmd).toBe(1);
      expect(r1.stderr.startsWith("error: invalid craftar.yaml: "), cmd).toBe(true);

      const gone = await cat();
      await fs.rm(gone.forgeRoot, { recursive: true, force: true });
      const r2 = runCli([cmd, "--workspace", gone.wsRoot]);
      expect(r2.code, cmd).toBe(1);
      expect(r2.stderr, cmd).toBe(`error: Forge not found at ${gone.forgeRoot}\n`);

      const unknown = await cat({ profile: "nobody" });
      const r3 = runCli([cmd, "--workspace", unknown.wsRoot]);
      expect(r3.code, cmd).toBe(1);
      expect(r3.stderr, cmd).toBe('error: profile "nobody" not found in Forge (acme)\n');
    }
  });

  it("ingredients: an unknown --recipe and an unknown --type exit 1", async () => {
    const s = await cat();
    const r1 = runCli(["ingredients", "--recipe", "nope", "--workspace", s.wsRoot]);
    expect([r1.code, r1.stderr]).toEqual([1, 'error: recipe "nope" not found in this Forge (base, stack-angular)\n']);
    const r2 = runCli(["ingredients", "--type", "widget", "--workspace", s.wsRoot]);
    expect([r2.code, r2.stderr]).toEqual([1, 'error: unknown ingredient type "widget" — one of rule, agent, command, skill, mcp, script, steering, hook\n']);
  });

  it("targets: no craftar.yaml (a bare dir, a Forge dir) → every inUse null, exit 0", async () => {
    const s = await cat();
    for (const cwd of [await bare(), s.forgeRoot]) {
      const j = json(runCli(["targets", "--json"], { cwd }));
      expect(j.targets.map((t: { inUse: unknown }) => t.inUse)).toEqual([null, null, null]);
      expect(j.warnings).toEqual([]);
    }
  });

  it("targets: in a workspace the resolved targets are true, the rest false; a profile with no targets is all false", async () => {
    const s = await cat();
    expect(json(runCli(["targets", "--json"], { cwd: s.wsRoot })).targets.map((t: { inUse: unknown }) => t.inUse)).toEqual([true, true, false]);
    expect(json(runCli(["targets", "--json", "--workspace", s.wsRoot])).targets.map((t: { inUse: unknown }) => t.inUse)).toEqual([true, true, false]);
    const none = await cat({ profile: "acme", targets: [] });
    expect(json(runCli(["targets", "--json", "--workspace", none.wsRoot])).targets.map((t: { inUse: unknown }) => t.inUse)).toEqual([false, false, false]);
  });

  it("targets: --workspace on a dir without craftar.yaml exits 1; --forge is an unknown option", async () => {
    const dir = await bare();
    const r = runCli(["targets", "--workspace", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      `error: craftar.yaml not found in ${dir} — run \`craftar init --workspace "${dir}" --forge <dir> --profile <name>\` to start one, or \`craftar import --workspace "${dir}" --from claude-code --forge <dir> --profile <name> --write-config\` to bring in an existing harness\n`,
    );
    const s = await cat();
    const f = runCli(["targets", "--forge", s.forgeRoot]);
    expect(f.code).toBe(1);
    expect(f.stderr).toContain("unknown option '--forge'");
  });

  it("targets: a workspace whose Forge is gone, or that names an unknown profile, prints the matrix with the warning, exit 0", async () => {
    const gone = await cat();
    await fs.rm(gone.forgeRoot, { recursive: true, force: true });
    const j1 = json(runCli(["targets", "--json", "--workspace", gone.wsRoot]));
    expect(j1.targets.map((t: { inUse: unknown }) => t.inUse)).toEqual([null, null, null]);
    expect(j1.warnings).toEqual([
      `targets in use not shown: Forge not found at ${gone.forgeRoot}`,
    ]);
    const unknown = await cat({ profile: "nobody" });
    const j2 = json(runCli(["targets", "--json", "--workspace", unknown.wsRoot]));
    expect(j2.warnings).toEqual(['targets in use not shown: profile "nobody" not found in Forge (acme)']);
    const t2 = runCli(["targets", "--workspace", unknown.wsRoot]);
    expect(t2.code).toBe(0);
    expect(t2.stdout.trimEnd().split("\n").at(-1)).toBe('  warn targets in use not shown: profile "nobody" not found in Forge (acme)');
  });

  it("a rule with a malformed section marker: ls exits 1 (it plans), recipes and ingredients exit 0 (they do not)", async () => {
    const s = await scenario(
      { ingredients: [rule("broken", "# B\n<!--craftar:section x-->\nbody\n")], recipes: [recipe("base", ["rule/broken"])], profiles: [profile("acme", ["base"])] },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    expect(runCli(["ls", "--workspace", s.wsRoot]).code).toBe(1);
    expect(runCli(["recipes", "--workspace", s.wsRoot]).code).toBe(0);
    expect(runCli(["ingredients", "--workspace", s.wsRoot]).code).toBe(0);
  });

  it("--json: stdout is one JSON document and the warnings are only inside it", async () => {
    const s = await cat();
    for (const args of [["recipes"], ["ingredients"], ["ingredients", "--recipe", "stack-angular"]]) {
      const r = runCli([...args, "--json", "--workspace", s.wsRoot]);
      const j = json(r);
      expect(j.warnings, args.join(" ")).toEqual([GONE]);
      expect(r.stdout.match(/references missing ingredient/g), args.join(" ")).toHaveLength(1);
      expect(r.stdout.endsWith("}\n"), args.join(" ")).toBe(true);
    }
  });

  it("text mode: recipes header, count line and warn line", async () => {
    const s = await cat();
    const r = runCli(["recipes", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("craftar recipes — forge acme-forge @ no git · workspace profile acme");
    expect(lines.at(-2)).toBe("  2 recipes, 2 in use · used by profiles: base (acme), stack-angular (—)");
    expect(lines.at(-1)).toBe(`  warn ${GONE}`);
    expect(lines.find((l) => l.includes(" base "))).toMatch(/^  ● base .*in use \(profile, extends stack-angular\)\s+— Shared conventions$/);
    expect(lines.find((l) => l.includes(" stack-angular "))).toMatch(/^  ● stack-angular \[slot frontend\]\s+2 ingredients\s+← base\s+in use \(workspace\)\s+— Angular front end$/);
  });

  it("text mode: ingredients header, count line and warn line; --recipe groups", async () => {
    const s = await cat();
    const r = runCli(["ingredients", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("craftar ingredients — forge acme-forge @ no git · workspace profile acme");
    expect(lines.at(-2)).toBe("  5 ingredients, 3 in use, 1 disabled, 1 in no recipe · 1 missing reference");
    expect(lines.at(-1)).toBe(`  warn ${GONE}`);
    expect(lines.filter((l) => !l.startsWith(" ") && l !== "")).toEqual([lines[0], "rule", "agent", "missing"]);
    expect(lines.find((l) => l.includes("rule/gone"))).toMatch(/^  rule\/gone\s+cited by base, not in this Forge$/);

    const g = runCli(["ingredients", "--recipe", "stack-angular", "--workspace", s.wsRoot]);
    const gl = g.stdout.trimEnd().split("\n");
    expect(gl[0]).toBe("craftar ingredients --recipe stack-angular — forge acme-forge @ no git · workspace profile acme");
    expect(gl.at(-2)).toBe("  2 recipes, 4 ingredients · 1 missing reference");
    expect(gl.filter((l) => !l.startsWith(" ") && l !== "").slice(1).map((l) => l.replace(/\s+/g, " "))).toEqual(["base", "stack-angular ← base [slot frontend]"]);
    expect(gl.find((l) => l.includes("rule/gone"))).toMatch(/^  ✗ rule\/gone\s+not in this Forge$/);
  });

  it("text mode: targets header, matrix, legend and one paths line per writing cell (14)", async () => {
    const s = await cat();
    const r = runCli(["targets"], { cwd: s.wsRoot });
    expect(r.code).toBe(0);
    const norm = r.stdout.trimEnd().split("\n").map((l) => l.trim().replace(/ {2,}/g, " "));
    expect(norm[0]).toBe("craftar targets — claude-code (in use) · kiro (in use) · agents-md");
    const at = norm.indexOf("claude-code kiro agents-md");
    expect(at).toBeGreaterThan(0);
    expect(norm.slice(at + 1, at + 9)).toEqual([
      "rule native converted converted",
      "agent native converted unsupported",
      "command native converted unsupported",
      "skill native converted unsupported",
      "mcp native native unsupported",
      "script native unsupported unsupported",
      "steering unsupported native unsupported",
      "hook native unsupported unsupported",
    ]);
    expect(norm).toContain("native written in the tool's own place for that type, as the Forge holds it");
    expect(norm).toContain("converted written in another form — see its line below");
    expect(norm).toContain("unsupported not written; sync warns and names an ingredient aimed at this target");
    const p = norm.indexOf("paths");
    expect(norm.slice(p + 1)).toEqual([
      "claude-code · rule .claude/rules/<name>.md",
      "kiro · rule .kiro/steering/<name>.md — inclusion frontmatter and a banner are added; a .claude/rules/ reference becomes .kiro/steering/ when kiro writes that file, and otherwise follows the rule it names (kept for claude-code, AGENTS.md (rule: <x>), or <x> (rule not in this workspace) with a warning)",
      "agents-md · rule AGENTS.md — always-on rules are embedded in AGENTS.md; a scoped rule is listed at the file another target writes, or embedded when none does; .claude/rules/ references in the bodies, link text included, point at the file a target writes or the rule's place in AGENTS.md, or read <x> (rule not in this workspace) with a warning",
      "claude-code · agent .claude/agents/<name>.md",
      "kiro · agent .kiro/agents/<name>.json — written as JSON; tools mapped to Kiro names, one with no equivalent dropped with a warning; .claude/rules/ references resolved as for a rule; resources taken from the ingredient, else derived from the steering files",
      "claude-code · command .claude/commands/<name>.md",
      "kiro · command .kiro/steering/commands/<name>.md — written as manual steering; .claude/rules/ references resolved as for a rule, in the body and the description",
      "claude-code · skill .claude/skills/<name>/<file>, .claude/skills/<name>.md",
      "kiro · skill .kiro/skills/<name>/<file> — in its text files (.md, .txt, .json, .yaml, .yml), .claude/rules/ references resolved as for a rule; other files are copied as they are; a single-file skill becomes <name>/SKILL.md",
      "claude-code · mcp .mcp.json",
      "kiro · mcp .kiro/settings/mcp.json",
      "claude-code · script .claude/scripts/<file>",
      "kiro · steering .kiro/steering/<name>.md",
      "claude-code · hook .claude/hooks/<file>",
    ]);
    const bareRun = runCli(["targets"], { cwd: await bare() });
    expect(bareRun.stdout.split("\n")[0]).toBe("craftar targets — claude-code · kiro · agents-md");
  });

  it("the header carries the first 8 characters of the Forge commit, --json the full SHA", async () => {
    const s = await cat();
    gitInit(s.forgeRoot);
    gitCommitAll(s.forgeRoot, "init");
    const sha = execFileSync("git", ["-C", s.forgeRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(json(runCli(["recipes", "--json", "--forge", s.forgeRoot])).forge).toEqual({ name: "acme-forge", commit: sha });
    expect(runCli(["recipes", "--forge", s.forgeRoot]).stdout.split("\n")[0]).toBe(`craftar recipes — forge acme-forge @ ${sha.slice(0, 8)}`);
    expect(runCli(["ingredients", "--forge", s.forgeRoot, "--profile", "acme"]).stdout.split("\n")[0]).toBe(
      `craftar ingredients — forge acme-forge @ ${sha.slice(0, 8)} · profile acme`,
    );
  });

  it("the three commands write nothing in the workspace or the Forge", async () => {
    const s = await cat();
    const before = { forge: await snapshot(s.forgeRoot), ws: await snapshot(s.wsRoot) };
    for (const args of [
      ["recipes"],
      ["recipes", "--json"],
      ["ingredients"],
      ["ingredients", "--json", "--recipe", "stack-angular", "--type", "rule"],
      ["targets"],
      ["targets", "--json"],
    ]) {
      expect(runCli([...args, "--workspace", s.wsRoot]).code, args.join(" ")).toBe(0);
      expect(runCli(args, { cwd: s.wsRoot }).code, args.join(" ")).toBe(0);
    }
    expect(json(runCli(["recipes", "--json", "--forge", s.forgeRoot, "--profile", "acme"])).context).not.toBeNull();
    expect({ forge: await snapshot(s.forgeRoot), ws: await snapshot(s.wsRoot) }).toEqual(before);
  });
});


describe("cli — the catalogue's text mode (spec 16 §4.2, §4.3)", () => {
  async function two() {
    const s = await scenario(
      {
        ingredients: [rule("a", "# A\n"), rule("long-rule-name--acme", "# L\n", { as: "long-rule-name", description: "Long one" })],
        recipes: [recipe("base", ["rule/a"]), recipe("stack-angular", ["rule/long-rule-name--acme"], { slot: "frontend", extends: ["base"] })],
        profiles: [profile("acme", ["stack-angular"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    return s;
  }

  it("--forge alone: no mark symbol and no 'in use' count", async () => {
    const s = await two();
    const r = runCli(["recipes", "--forge", s.forgeRoot]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/[●○◌]/);
    expect(r.stdout.trimEnd().split("\n").at(-1)).toBe("  2 recipes · used by profiles: base (acme), stack-angular (acme)");
    const i = runCli(["ingredients", "--forge", s.forgeRoot]);
    expect(i.code).toBe(0);
    expect(i.stdout).not.toMatch(/[●○◌]/);
    expect(i.stdout.trimEnd().split("\n").at(-1)).toBe("  2 ingredients, 0 in no recipe");
  });

  it("recipes rows: the ingredient count starts at one column for every row", async () => {
    const s = await two();
    const rows = runCli(["recipes", "--workspace", s.wsRoot]).stdout.split("\n").filter((l) => /^  [●○ ] /.test(l));
    expect(rows).toHaveLength(2);
    const at = rows.map((l) => l.search(/\d+ ingredients?/));
    expect(at[0]).toBeGreaterThan(0);
    expect(at[1]).toBe(at[0]);
    expect(rows.every((l) => l === l.trimEnd())).toBe(true);
  });

  it("ingredients rows: name → outputName, and targets starts at one column", async () => {
    const s = await two();
    const lines = runCli(["ingredients", "--workspace", s.wsRoot]).stdout.split("\n");
    const rows = lines.filter((l) => l.includes(" targets "));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatch(/^  ● long-rule-name--acme → long-rule-name\s+targets \*\s+in stack-angular\s+— Long one$/);
    expect(rows[0]).toMatch(/^  ● a\s+targets \*\s+in base$/);
    expect(rows[0].indexOf("targets ")).toBe(rows[1].indexOf("targets "));
  });
});


describe("cli — targets reads the workspace once craftar.yaml is there (spec 16 §4.4, §5.2)", () => {
  it("an explicit --workspace whose craftar.yaml is not valid YAML is a warning, exit 0", async () => {
    const s = await scenario({ recipes: [recipe("base", [])], profiles: [profile("acme", ["base"])] }, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), "forge: [unclosed\n");
    const r = runCli(["targets", "--json", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const j = JSON.parse(r.stdout);
    expect(j.targets.map((t: { inUse: unknown }) => t.inUse)).toEqual([null, null, null]);
    expect(j.warnings).toHaveLength(1);
    expect(j.warnings[0].startsWith("targets in use not shown: ")).toBe(true);
  });
});


describe("cli — the targets text has no trailing spaces and the catalogue drops marks without a context", () => {
  it("every line of targets, and of recipes --forge, has no trailing space; recipes --forge rows start with two spaces and the name", async () => {
    const s = await scenario({ recipes: [recipe("base", [])], profiles: [profile("acme", ["base"])] }, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    const t = runCli(["targets"], { cwd: s.wsRoot });
    expect(t.stdout.split("\n").filter((l) => l !== l.trimEnd())).toEqual([]);
    expect(t.stdout.split("\n").find((l) => l.trim().startsWith("steering"))!.startsWith("  steering")).toBe(true);
    const r = runCli(["recipes", "--forge", s.forgeRoot]);
    expect(r.stdout.split("\n").filter((l) => l !== l.trimEnd())).toEqual([]);
    expect(r.stdout.split("\n")[1]).toMatch(/^  base\s+0 ingredients$/);
  });
});


describe("cli — diff, pinned before spec 19", () => {
  // rule/a ("A one\nA two\n") and rule/b ("B one\nB two\n"),
  // recipe base listing both, profile acme using base, target claude-code.
  async function pinnedScenario() {
    const s = await scenario(
      {
        ingredients: [rule("a", "A one\nA two\n"), rule("b", "B one\nB two\n")],
        recipes: [recipe("base", ["rule/a", "rule/b"])],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    return s;
  }

  it("drift only, exit 0", async () => {
    const s = await pinnedScenario();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // Drift on b: append "hand\n"
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/b.md"), "hand\n");

    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "--- .claude/rules/b.md (disk, drift)\n" +
      "+++ .claude/rules/b.md (forge)\n" +
      "  B one\n" +
      "  B two\n" +
      "- hand\n",
    );
  });

  it("drift + update, byte for byte (spec test 9)", async () => {
    const s = await pinnedScenario();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // Update on a: rewrite the Forge ingredient
    await fs.writeFile(path.join(s.forgeRoot, "ingredients/rules/a/rule.md"), "A one\nA changed\n");
    // Drift on b: append "hand\n"
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/b.md"), "hand\n");

    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "--- .claude/rules/a.md (disk, update)\n" +
      "+++ .claude/rules/a.md (forge)\n" +
      "  A one\n" +
      "- A two\n" +
      "+ A changed\n" +
      "--- .claude/rules/b.md (disk, drift)\n" +
      "+++ .claude/rules/b.md (forge)\n" +
      "  B one\n" +
      "  B two\n" +
      "- hand\n",
    );
  });

  it("in sync", async () => {
    const s = await pinnedScenario();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);

    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("no differences\n");
  });

  it("a [path] nothing matches, without the flag", async () => {
    const s = await pinnedScenario();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // Drift on b so the workspace is not in sync — but the paths below should still show no differences
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/b.md"), "hand\n");

    for (const p of [".claude/rules/nope.md", "./.claude/rules/a.md", ".claude\\rules\\a.md"]) {
      const r = runCli(["diff", p, "--workspace", s.wsRoot]);
      expect(r.code, `path: ${p}`).toBe(0);
      expect(r.stdout, `path: ${p}`).toBe("no differences\n");
      expect(r.stderr, `path: ${p}`).toBe("");
    }
  });

  it("a [path] naming an unchanged file while another drifted", async () => {
    const s = await pinnedScenario();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // Drift on b
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/b.md"), "hand\n");

    const r = runCli(["diff", ".claude/rules/a.md", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("no differences\n");
  });
});


/**
 * A scenario for the `diff` tests of spec 19: the given ingredients in one `base` recipe, profile `acme`,
 * cleaned up after the test. Defaults to rule/a ("A one\nA two\n") and rule/b ("B one\nB two\n").
 */
async function diffScenario(
  ingredients = [rule("a", "A one\nA two\n"), rule("b", "B one\nB two\n")],
  recipeIngredients = ["rule/a", "rule/b"],
  local?: Record<string, unknown>,
) {
  const s = await scenario(
    { ingredients, recipes: [recipe("base", recipeIngredients)], profiles: [profile("acme", ["base"])] },
    { config: { profile: "acme" }, local },
  );
  cleanups.push(s.cleanup);
  return s;
}

describe("cli — diff shows orphans (spec 19)", () => {
  it("orphan printed as a removal (spec tests 5, 7)", async () => {
    const s = await diffScenario();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // Orphan on a: rewrite the recipe to list only rule/b
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), "name: base\ningredients:\n  - rule/b\n");

    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "--- .claude/rules/a.md (disk, orphan)\n" +
      "+++ .claude/rules/a.md (forge: no longer produced — sync removes it)\n" +
      "- A one\n" +
      "- A two\n",
    );
    // Confirm the state really is pending
    expect(runCli(["sync", "--check", "--workspace", s.wsRoot]).code).toBe(1);
  });

  it("orphan with no final newline", async () => {
    // A separate scenario: rule/c has no trailing newline
    const s = await diffScenario(
      [rule("c", "C one\nC two"), rule("b", "B one\nB two\n")],
      ["rule/b", "rule/c"],
    );
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // Orphan on c: rewrite the recipe to list only rule/b
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), "name: base\ningredients:\n  - rule/b\n");

    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "--- .claude/rules/c.md (disk, orphan)\n" +
      "+++ .claude/rules/c.md (forge: no longer produced — sync removes it)\n" +
      "- C one\n" +
      "- C two\n" +
      "\\ No newline at end of file\n",
    );
  });

  it("orphan-drift: header and one line (spec test 6)", async () => {
    const s = await diffScenario();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // Orphan on a: rewrite the recipe to list only rule/b
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), "name: base\ningredients:\n  - rule/b\n");
    // Drift on a: append "hand\n"
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/a.md"), "hand\n");

    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "--- .claude/rules/a.md (disk, orphan-drift)\n" +
      "  no longer produced by the Forge but hand-edited — kept; delete it yourself if unwanted\n",
    );
  });

  it("order (spec test 11)", async () => {
    const s = await diffScenario();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // Orphan on a: rewrite the recipe to list only rule/b
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), "name: base\ningredients:\n  - rule/b\n");
    // Drift on b: append "hand\n"
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/b.md"), "hand\n");

    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "--- .claude/rules/a.md (disk, orphan)\n" +
      "+++ .claude/rules/a.md (forge: no longer produced — sync removes it)\n" +
      "- A one\n" +
      "- A two\n" +
      "--- .claude/rules/b.md (disk, drift)\n" +
      "+++ .claude/rules/b.md (forge)\n" +
      "  B one\n" +
      "  B two\n" +
      "- hand\n",
    );
  });

  it("[path] reaches an orphan (spec test 8, first case)", async () => {
    const s = await diffScenario();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // Orphan on a: rewrite the recipe to list only rule/b
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), "name: base\ningredients:\n  - rule/b\n");
    // Drift on b: append "hand\n"
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/b.md"), "hand\n");

    // diff .claude/rules/a.md should show only the orphan
    const r = runCli(["diff", ".claude/rules/a.md", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "--- .claude/rules/a.md (disk, orphan)\n" +
      "+++ .claude/rules/a.md (forge: no longer produced — sync removes it)\n" +
      "- A one\n" +
      "- A two\n",
    );
  });

  it("no targets resolved (spec test 12, no flag)", async () => {
    const s = await diffScenario();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // No targets: write craftar.local.yaml with targets: []
    await fs.writeFile(path.join(s.wsRoot, "craftar.local.yaml"), "targets: []\n");

    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "--- .claude/rules/a.md (disk, orphan)\n" +
      "+++ .claude/rules/a.md (forge: no longer produced — sync removes it)\n" +
      "- A one\n" +
      "- A two\n" +
      "--- .claude/rules/b.md (disk, orphan)\n" +
      "+++ .claude/rules/b.md (forge: no longer produced — sync removes it)\n" +
      "- B one\n" +
      "- B two\n",
    );
  });

  it("empty orphan (spec test 13, no flag)", async () => {
    // A scenario with an empty rule/e
    const s = await diffScenario(
      [rule("e", ""), rule("b", "B one\nB two\n")],
      ["rule/b", "rule/e"],
    );
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // Orphan on e: rewrite the recipe to list only rule/b
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), "name: base\ningredients:\n  - rule/b\n");

    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    // Two header lines and ONE empty line (renderDiff("", "") returns "", and console.log("") prints \n)
    expect(r.stdout).toBe(
      "--- .claude/rules/e.md (disk, orphan)\n" +
      "+++ .claude/rules/e.md (forge: no longer produced — sync removes it)\n" +
      "\n",
    );
  });
});

describe("cli — diff --exit-code (spec 19)", () => {
  const D = (ws: string, ...extra: string[]) => runCli(["diff", ...extra, "--workspace", ws]);
  const C = (ws: string) => runCli(["sync", "--check", "--workspace", ws]);
  const ONLY_B = "name: base\ningredients:\n  - rule/b\n";
  const unmatched = (p: string) =>
    `error: ${p} is not a file craftar manages in this workspace — pass the workspace-relative path as \`craftar status\` prints it (forward slashes)\n`;

  async function synced(...args: Parameters<typeof diffScenario>) {
    const s = await diffScenario(...args);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    return s;
  }

  it("in sync: exit 0 and no differences, as sync --check (spec test 2)", async () => {
    const s = await synced();
    const r = D(s.wsRoot, "--exit-code");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("no differences\n");
    expect(r.stderr).toBe("");
    expect(C(s.wsRoot).code).toBe(0);
  });

  /** Each state on a fresh default scenario: the flag prints what the plain command prints, and exits 1 as sync --check does. */
  const states: Array<[string, (s: Awaited<ReturnType<typeof diffScenario>>) => Promise<void>, boolean]> = [
    ["drift", (s) => fs.appendFile(path.join(s.wsRoot, ".claude/rules/b.md"), "hand\n"), true],
    ["update", (s) => fs.writeFile(path.join(s.forgeRoot, "ingredients/rules/a/rule.md"), "A one\nA changed\n"), true],
    ["new", (s) => fs.rm(path.join(s.wsRoot, ".claude/rules/a.md")), true],
    ["collision", (s) => writeFiles(s.wsRoot, { ".claude/rules/a.md": "mine\n" }), false],
    ["orphan", (s) => fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), ONLY_B), true],
    [
      "orphan-drift",
      async (s) => {
        await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), ONLY_B);
        await fs.appendFile(path.join(s.wsRoot, ".claude/rules/a.md"), "hand\n");
      },
      true,
    ],
  ];
  for (const [state, make, sync] of states) {
    it(`${state}: exit 1, the same output as without the flag, and sync --check exits 1 (spec test 3)`, async () => {
      const s = await diffScenario();
      if (sync) expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
      await make(s);
      const { statuses } = JSON.parse(runCli(["status", "--json", "--workspace", s.wsRoot]).stdout) as { statuses: Array<{ path: string; state: string }> };
      const target = state === "drift" ? ".claude/rules/b.md" : ".claude/rules/a.md";
      expect(statuses.find((f) => f.path === target)?.state).toBe(state);
      const flagged = D(s.wsRoot, "--exit-code");
      const plain = D(s.wsRoot);
      expect(flagged.code).toBe(1);
      expect(flagged.stderr).toBe("");
      expect(flagged.stdout).toBe(plain.stdout);
      expect(flagged.stdout).not.toBe("no differences\n");
      expect(plain.code).toBe(0);
      expect(C(s.wsRoot).code).toBe(1);
    });
  }

  it("only adopt files: exit 0, as sync --check (spec test 4)", async () => {
    const s = await synced();
    await fs.rm(path.join(s.wsRoot, "craftar.lock"));
    const r = D(s.wsRoot, "--exit-code");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("no differences\n");
    expect(C(s.wsRoot).code).toBe(0);
  });

  it("no targets resolved: exit 1, as sync --check (spec test 12)", async () => {
    const s = await synced();
    await writeFiles(s.wsRoot, { "craftar.local.yaml": "targets: []\n" });
    expect(D(s.wsRoot, "--exit-code").code).toBe(1);
    expect(C(s.wsRoot).code).toBe(1);
  });

  it("an empty orphan still counts: exit 1 (spec test 13)", async () => {
    const s = await synced([rule("e", ""), rule("b", "B one\nB two\n")], ["rule/b", "rule/e"]);
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), ONLY_B);
    const r = D(s.wsRoot, "--exit-code");
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("--- .claude/rules/e.md (disk, orphan)\n+++ .claude/rules/e.md (forge: no longer produced — sync removes it)\n\n");
  });

  it("[path] considers only the named file (spec test 8)", async () => {
    const s = await synced();
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), ONLY_B);
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/b.md"), "hand\n");
    const orphan = D(s.wsRoot, "--exit-code", ".claude/rules/a.md");
    expect(orphan.code).toBe(1);
    expect(orphan.stdout).toBe(
      "--- .claude/rules/a.md (disk, orphan)\n" +
        "+++ .claude/rules/a.md (forge: no longer produced — sync removes it)\n" +
        "- A one\n" +
        "- A two\n",
    );

    const t = await synced();
    await fs.appendFile(path.join(t.wsRoot, ".claude/rules/b.md"), "hand\n");
    const clean = D(t.wsRoot, "--exit-code", ".claude/rules/a.md");
    expect(clean.code).toBe(0);
    expect(clean.stdout).toBe("no differences\n");
    expect(clean.stderr).toBe("");
  });

  it("a [path] nothing matches is an error, with nothing on stdout (spec test 14)", async () => {
    const s = await synced();
    for (const p of [".claude/rules/nope.md", "./.claude/rules/a.md", ".claude\\rules\\a.md"]) {
      const r = D(s.wsRoot, "--exit-code", p);
      expect(r.code, p).toBe(1);
      expect(r.stdout, p).toBe("");
      expect(r.stderr, p).toBe(unmatched(p));
    }
  });

  it("an empty status(): no differences and exit 0; a [path] is the error", async () => {
    const s = await diffScenario(undefined, undefined, { targets: [] });
    const r = D(s.wsRoot, "--exit-code");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("no differences\n");
    expect(r.stderr).toBe("");
    expect(C(s.wsRoot).code).toBe(0);
    const named = D(s.wsRoot, "--exit-code", ".claude/rules/a.md");
    expect(named.code).toBe(1);
    expect(named.stdout).toBe("");
    expect(named.stderr).toBe(unmatched(".claude/rules/a.md"));
  });

  it("writes nothing in the workspace or the Forge (spec test 10)", async () => {
    const s = await synced();
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), ONLY_B);
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/a.md"), "hand\n");
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/b.md"), "hand\n");
    const ws = await snapshot(s.wsRoot);
    const forge = await snapshot(s.forgeRoot);
    expect(D(s.wsRoot, "--exit-code").code).toBe(1);
    expect(D(s.wsRoot).code).toBe(0);
    expect(D(s.wsRoot, "--exit-code", "nope.md").code).toBe(1);
    expect(await snapshot(s.wsRoot)).toEqual(ws);
    expect(await snapshot(s.forgeRoot)).toEqual(forge);
  });

  it("a diff larger than the pipe buffer arrives whole to a slow reader (spec test 15)", async () => {
    const lines = Array.from({ length: 20000 }, (_, i) => `line ${i} ${"x".repeat(40)}\n`).join("");
    const s = await synced([rule("big", lines), rule("b", "B one\nB two\n")], ["rule/b", "rule/big"]);
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), ONLY_B);
    const repo = path.resolve(__dirname, "..");
    // spawnSync drains the pipe at once (and caps it at 1 MiB): a paused reader is what exposes a process.exit.
    // Under process.exit nothing reaches this reader at all — node drops the unread pipe when the child exits.
    const { code, stdout } = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", TSX_LOADER, path.join(repo, "src/cli.ts"), "diff", "--exit-code", "--workspace", s.wsRoot], {
        cwd: repo,
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.pause();
      setTimeout(() => {
        child.stdout.on("data", (d: string) => (out += d));
        child.stdout.resume();
      }, 1000);
      child.on("error", reject);
      child.on("close", (c) => resolve({ code: c, stdout: out }));
    });
    expect(code).toBe(1);
    const got = stdout.split("\n");
    expect(got.length).toBe(20003);
    expect(got[0]).toBe("--- .claude/rules/big.md (disk, orphan)");
    expect(got[20001]).toBe("- line 19999 " + "x".repeat(40));
    expect(got[20002]).toBe("");
  }, 30_000);
});

describe("cli — forge values: credentials refused, path-Forge warnings (spec 13 §4.2, §4.3)", () => {
  const ONE = { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] };

  it("a credential in either workspace file is refused, naming the file and never the value", async () => {
    for (const [file, other] of [["craftar.yaml", "craftar.local.yaml"], ["craftar.local.yaml", "craftar.yaml"]] as const) {
      const s = await scenario(ONE, { config: { profile: "acme" } });
      cleanups.push(s.cleanup);
      const secret = "https://alice:s3cr3t@example.com/acme/forge.git";
      if (file === "craftar.yaml") await fs.writeFile(path.join(s.wsRoot, file), `forge: ${secret}\nprofile: acme\n`);
      else await fs.writeFile(path.join(s.wsRoot, file), `forge: ${secret}\n`);
      const r = runCli(["status", "--workspace", s.wsRoot]);
      expect(r.code, file).toBe(1);
      expect(r.stderr, file).toBe(
        `error: ${file} › forge holds credentials in the URL — remove them and let git authenticate (credential helper, SSH agent; see README › Remote Forge)\n`,
      );
      expect(r.stderr + r.stdout, file).not.toContain("s3cr3t");
      expect(r.stderr + r.stdout, file).not.toContain("alice");
    }
  });

  it("a ref next to a path Forge is ignored with a warning; forge: from craftar.local.yaml warns not to commit", async () => {
    const s = await scenario(ONE, { config: { profile: "acme", ref: "v1" } });
    cleanups.push(s.cleanup);
    const j = JSON.parse(runCli(["status", "--json", "--workspace", s.wsRoot]).stdout);
    expect(j.warnings).toContain('ref "v1" is ignored: the Forge is a path (../forge), read as its working tree');
    await fs.writeFile(path.join(s.wsRoot, "craftar.local.yaml"), "forge: ../forge\n");
    const k = JSON.parse(runCli(["status", "--json", "--workspace", s.wsRoot]).stdout);
    expect(k.warnings.slice(0, 2)).toEqual([
      'ref "v1" is ignored: the Forge is a path (../forge), read as its working tree',
      "Forge overridden by craftar.local.yaml (../forge) — do not commit craftar.lock or the generated files",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* spec 13: a remote Forge through the cache (file:// remotes only)    */
/* ------------------------------------------------------------------ */
describe("cli — a remote Forge (spec 13 §4.1, §4.4, AC 1, 3, 4, 5)", () => {
  const SPEC = { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] };

  async function remoteWs(extra = "") {
    const r = await remoteForge(SPEC);
    const ws = await tmpDir("craftar-remote-ws-");
    const home = await tmpDir("craftar-home-");
    cleanups.push(r.cleanup, () => fs.rm(ws, { recursive: true, force: true }), () => fs.rm(home, { recursive: true, force: true }));
    await fs.writeFile(path.join(ws, "craftar.yaml"), `forge: ${r.url}\nprofile: acme\n${extra}`);
    const run = (args: string[], h = home) => runCli([...args, "--workspace", ws], { env: { CRAFTAR_HOME: h } });
    return { r, ws, home, run };
  }
  const short = (sha: string) => sha.slice(0, 8);

  it("AC 1: sync writes the files a path Forge at the same commit writes, byte for byte", async () => {
    const { r, ws, run } = await remoteWs();
    expect(run(["sync"]).code).toBe(0);
    const viaPath = await tmpDir("craftar-path-ws-");
    cleanups.push(() => fs.rm(viaPath, { recursive: true, force: true }));
    await fs.writeFile(path.join(viaPath, "craftar.yaml"), `forge: ${r.src.replace(/\\/g, "/")}\nprofile: acme\n`);
    expect(runCli(["sync", "--workspace", viaPath]).code).toBe(0);
    const strip = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== "craftar.yaml" && k !== "craftar.lock"));
    expect(strip(await snapshot(ws))).toEqual(strip(await snapshot(viaPath)));
  });

  it("AC 3: the header names the Forge, and shows the lock's commit once the Forge moved, until the next sync", async () => {
    const { r, run } = await remoteWs();
    const first = git(r.src, "rev-parse", "HEAD");
    expect(run(["sync"]).code).toBe(0);
    expect(run(["status"]).stdout.split("\n")[1]).toBe(`  forge ${r.url} @ main (default branch) ${short(first)}`);
    const next = await r.commit({ "README.md": "moved\n" });
    expect(run(["status"]).stdout.split("\n")[1]).toBe(`  forge ${r.url} @ main (default branch) ${short(next)} · lock ${short(first)}`);
    expect(run(["sync"]).code).toBe(0);
    expect(run(["status"]).stdout.split("\n")[1]).toBe(`  forge ${r.url} @ main (default branch) ${short(next)}`);
  });

  it("AC 4: a tag in ref does not move when the branch does", async () => {
    const r0 = await remoteWs("ref: v1\n");
    const tagged = git(r0.r.src, "rev-parse", "HEAD");
    git(r0.r.src, "tag", "v1");
    git(r0.r.src, "push", "-q", "origin", "v1");
    await r0.r.commit({ "README.md": "later\n" });
    const j = JSON.parse(r0.run(["status", "--json"]).stdout);
    expect(j.forge).toEqual({ kind: "remote", source: r0.r.url, ref: "v1", defaultBranch: null, commit: tagged, lockCommit: null, fetched: true });
  });

  it("AC 5: unreachable — sync fails naming --offline; readers warn and use the cache; --offline works; no cache fails everywhere", async () => {
    const { r, ws, home, run } = await remoteWs();
    expect(run(["sync"]).code).toBe(0);
    const sha = git(r.src, "rev-parse", "HEAD");
    await fs.rename(r.bare, r.bare + ".gone");
    for (const args of [["sync"], ["sync", "--dry-run"], ["sync", "--check"]]) {
      const x = run(args);
      expect(x.code, args.join(" ")).toBe(1);
      expect(x.stderr.startsWith(`error: cannot fetch the Forge ${r.url}: `), args.join(" ")).toBe(true);
      expect(x.stderr, args.join(" ")).toContain(`— run with --offline to use the cached copy (${short(sha)} fetched `);
    }
    const notFetched = `Forge ${r.url} not fetched (`;
    const st = run(["status", "--json"]);
    expect(st.code).toBe(0);
    expect(JSON.parse(st.stdout).warnings[0].startsWith(notFetched)).toBe(true);
    for (const args of [["diff"], ["explain", ".claude/rules/a.md"], ["ls"]]) {
      const x = run(args);
      expect(x.code, args.join(" ")).toBe(0);
      expect(x.stderr.startsWith(`warn ${notFetched}`), args.join(" ")).toBe(true);
    }
    for (const cmd of ["recipes", "ingredients"]) {
      const x = run([cmd, "--json"]);
      expect(x.code, cmd).toBe(0);
      expect(JSON.parse(x.stdout).warnings[0].startsWith(notFetched), cmd).toBe(true);
    }
    expect(run(["sync", "--offline"]).code).toBe(0);
    const empty = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(empty, { recursive: true, force: true }));
    for (const args of [["sync"], ["status"], ["diff"], ["ls"], ["recipes"], ["sync", "--offline"]]) {
      const x = run(args, empty);
      expect(x.code, `${args.join(" ")} without a cache`).toBe(1);
    }
  });

  it("Q13-1 (answered: like sync --check): with the remote unreachable, diff --exit-code exits 1 naming --offline; plain diff reads the cache with a warning", async () => {
    const { r, run } = await remoteWs();
    expect(run(["sync"]).code).toBe(0);
    const sha = git(r.src, "rev-parse", "HEAD");
    await fs.rename(r.bare, r.bare + ".gone");
    const gate = run(["diff", "--exit-code"]);
    expect(gate.code).toBe(1);
    expect(gate.stdout).toBe("");
    expect(gate.stderr.startsWith(`error: cannot fetch the Forge ${r.url}: `)).toBe(true);
    expect(gate.stderr).toContain(`— run with --offline to use the cached copy (${short(sha)} fetched `);
    const check = run(["sync", "--check"]);
    expect([check.code, check.stderr.split(": ").slice(0, 2).join(": ")]).toEqual([1, gate.stderr.split(": ").slice(0, 2).join(": ")]);
    const plain = run(["diff"]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toBe("no differences\n");
    expect(plain.stderr.startsWith(`warn Forge ${r.url} not fetched (`)).toBe(true);
    const offline = run(["diff", "--exit-code", "--offline"]);
    expect([offline.code, offline.stdout]).toEqual([0, "no differences\n"]);
  });

  it("status --json carries forge for a path Forge too", async () => {
    const s = await scenario(SPEC, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    expect(JSON.parse(runCli(["status", "--json", "--workspace", s.wsRoot]).stdout).forge).toEqual({
      kind: "path",
      source: "../forge",
      ref: null,
      defaultBranch: null,
      commit: null,
      lockCommit: null,
      fetched: false,
    });
  });

  it("forge unify on a remote Forge is refused before anything is fetched", async () => {
    const { r, home, run } = await remoteWs();
    const x = run(["forge", "unify", "rule/a", "--profile", "acme", "--take", "base"]);
    expect([x.code, x.stderr]).toEqual([1, `error: the Forge of this workspace is remote (${r.url}) — clone it and pass --forge <dir>\n`]);
    expect(await fs.readdir(home)).toEqual([]);
  });

  it("--forge with a URL is refused, for the forge commands and the catalogue", async () => {
    const { r, home } = await remoteWs();
    for (const args of [["forge", "variants"], ["recipes"], ["ingredients"]]) {
      const x = runCli([...args, "--forge", r.url], { env: { CRAFTAR_HOME: home } });
      expect([x.code, x.stderr], args.join(" ")).toEqual([1, "error: --forge takes a directory; to read a remote Forge, run inside a workspace that names it\n"]);
    }
  });

  it("targets never fetches: no cache → unmarked with a warning; once cached → marked, and no new fetch", async () => {
    const { home, run } = await remoteWs();
    const before = JSON.parse(run(["targets", "--json"]).stdout);
    expect(before.targets.map((t: { inUse: unknown }) => t.inUse)).toEqual([null, null, null]);
    expect(before.warnings).toHaveLength(1);
    expect(before.warnings[0].startsWith("targets in use not shown: ")).toBe(true);
    expect(run(["status"]).code).toBe(0);
    const entry = path.join(home, "forges", (await fs.readdir(path.join(home, "forges")))[0]);
    const stamp = await fs.readFile(path.join(entry, "fetched"), "utf8");
    const after = JSON.parse(run(["targets", "--json"]).stdout);
    expect(after.targets.map((t: { inUse: unknown }) => t.inUse)).toEqual([true, false, false]);
    expect(after.warnings).toEqual([]);
    expect(await fs.readFile(path.join(entry, "fetched"), "utf8")).toBe(stamp);
  });
});

describe("cli — import --write-config keeps a remote forge (spec 13 §4.5, AC 8)", () => {
  async function wsWith(craftarYaml: string) {
    const root = await tmpDir("craftar-import-remote-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const ws = path.join(root, "ws");
    await writeFiles(ws, { ".claude/rules/a.md": "# A\n", "craftar.yaml": craftarYaml });
    return { ws, forge: path.join(root, "forge") };
  }

  it("forge kept byte for byte, profile and targets set, and the report says the Forge must be pushed", async () => {
    const { ws, forge } = await wsWith("forge: git@example.com:acme/forge.git\nprofile: old\n");
    const r = runCli(["import", "--from", "claude-code", "--workspace", ws, "--forge", forge, "--profile", "acme", "--write-config"]);
    expect(r.code).toBe(0);
    expect(await fs.readFile(path.join(ws, "craftar.yaml"), "utf8")).toBe("forge: git@example.com:acme/forge.git\nprofile: acme\ntargets:\n  - claude-code\n");
    expect(r.stdout.split("\n")).toContain(
      "  workspace craftar.yaml edited (profile, targets) — forge kept (remote git@example.com:acme/forge.git); push the Forge for sync to see this import",
    );
  });

  it("a credential in that forge is refused before anything prints it, and the Forge is not created", async () => {
    const { ws, forge } = await wsWith("forge: https://alice:s3cr3t@example.com/acme/forge.git\nprofile: old\n");
    const r = runCli(["import", "--from", "claude-code", "--workspace", ws, "--forge", forge, "--profile", "acme", "--write-config"]);
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).not.toContain("s3cr3t");
    expect(r.stderr).toContain("craftar.yaml › forge holds credentials in the URL — remove them and let git authenticate");
    expect(await exists(forge)).toBe(false);
  });

  it("--forge with a URL is refused for import too", async () => {
    const { ws } = await wsWith("forge: ../forge\nprofile: acme\n");
    const r = runCli(["import", "--from", "claude-code", "--workspace", ws, "--forge", "https://example.com/acme/forge.git", "--profile", "acme"]);
    expect([r.code, r.stderr]).toEqual([1, "error: --forge takes a directory; to read a remote Forge, run inside a workspace that names it\n"]);
  });
});

describe("cli — a credential in a URL no parser accepts is still refused (review of spec 13)", () => {
  it("https with a bad port and ssh with a bad port: refused at load, the secret never printed", async () => {
    for (const forgeValue of ["https://SECRETTOKEN@127.0.0.1:badport/acme/forge.git", "ssh://u:SECRETPW@127.0.0.1:99999999/x"]) {
      const s = await scenario({ recipes: [recipe("base", [])], profiles: [profile("acme", ["base"])] }, { config: { profile: "acme" } });
      cleanups.push(s.cleanup);
      const home = await tmpDir("craftar-home-");
      cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
      await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), `forge: ${forgeValue}\nprofile: acme\n`);
      const r = runCli(["status", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } });
      expect(r.code, forgeValue).toBe(1);
      expect(r.stderr, forgeValue).toBe(
        "error: craftar.yaml › forge holds credentials in the URL — remove them and let git authenticate (credential helper, SSH agent; see README › Remote Forge)\n",
      );
      expect(r.stdout + r.stderr, forgeValue).not.toMatch(/SECRETTOKEN|SECRETPW/);
      expect(await fs.readdir(home), forgeValue).toEqual([]);
    }
  });
});

describe("cli — a remote Forge, the cases the review asked for (spec 13 §10.2, §10.3, AC 2)", () => {
  const SPEC = {
    ingredients: [rule("a", "# A\n"), rule("b", "# B\n")],
    recipes: [recipe("base", ["rule/a"]), recipe("stack", ["rule/b"], { extends: ["base"] })],
    profiles: [profile("acme", ["stack"], ["claude-code", "kiro"])],
  };
  async function remoteWs(extra = "") {
    const r = await remoteForge(SPEC);
    const ws = await tmpDir("craftar-remote-ws-");
    const home = await tmpDir("craftar-home-");
    cleanups.push(r.cleanup, () => fs.rm(ws, { recursive: true, force: true }), () => fs.rm(home, { recursive: true, force: true }));
    await fs.writeFile(path.join(ws, "craftar.yaml"), `forge: ${r.url}\nprofile: acme\n${extra}`);
    const run = (args: string[]) => runCli([...args, "--workspace", ws], { env: { CRAFTAR_HOME: home } });
    return { r, ws, home, run };
  }

  it("AC 2: the lock after a remote sync is schema 2 with ref null, the commit, the resolved recipes (extends parent first) and targets", async () => {
    const { r, ws, run } = await remoteWs();
    expect(run(["sync"]).code).toBe(0);
    const l = JSON.parse(await fs.readFile(path.join(ws, "craftar.lock"), "utf8"));
    expect([l.schema, l.forge, l.recipes, l.targets]).toEqual([
      2,
      { source: r.url, ref: null, commit: git(r.src, "rev-parse", "HEAD") },
      ["base", "stack"],
      ["claude-code", "kiro"],
    ]);
  });

  it("a ref is recorded in the lock as requested", async () => {
    const r0 = await remoteWs("ref: main\n");
    expect(r0.run(["sync"]).code).toBe(0);
    expect(JSON.parse(await fs.readFile(path.join(r0.ws, "craftar.lock"), "utf8")).forge.ref).toBe("main");
  });

  it("forge variants and forge diff through a remote workspace print what --forge on a clone prints; --offline too; a failed fetch warns on stderr", async () => {
    const { r, run, home } = await remoteWs();
    for (const args of [["forge", "variants", "--json"], ["forge", "diff", "rule/a", "--json"]]) {
      const viaClone = runCli([...args, "--forge", r.src]);
      const viaRemote = run(args);
      expect([viaRemote.code, viaRemote.stdout, viaRemote.stderr], args.join(" ")).toEqual([viaClone.code, viaClone.stdout, viaClone.stderr]);
      expect(run([...args, "--offline"]).stdout, `${args.join(" ")} --offline`).toBe(viaClone.stdout);
    }
    await fs.rename(r.bare, r.bare + ".gone");
    const x = run(["forge", "variants", "--json"]);
    expect(x.code).toBe(0);
    expect(x.stderr.startsWith(`warn Forge ${r.url} not fetched (`)).toBe(true);
  });

  it("forge: from craftar.local.yaml warns not to commit, on status, sync, diff, explain and ls", async () => {
    const s = await scenario(SPEC, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    await fs.writeFile(path.join(s.wsRoot, "craftar.local.yaml"), "forge: ../forge\n");
    const w = "Forge overridden by craftar.local.yaml (../forge) — do not commit craftar.lock or the generated files";
    expect(JSON.parse(runCli(["status", "--json", "--workspace", s.wsRoot]).stdout).warnings[0]).toBe(w);
    expect(runCli(["sync", "--workspace", s.wsRoot]).stdout.split("\n")).toContain(`  warn ${w}`);
    for (const args of [["diff"], ["explain", ".claude/rules/a.md"], ["ls"]]) {
      const x = runCli([...args, "--workspace", s.wsRoot]);
      expect([x.code, x.stderr], args.join(" ")).toEqual([0, `warn ${w}\n`]);
    }
  });

  it("targets with no cached copy points at a command that fetches, not at --offline", async () => {
    const { r, run } = await remoteWs();
    expect(JSON.parse(run(["targets", "--json"]).stdout).warnings).toEqual([
      `targets in use not shown: the Forge ${r.url} has no cached copy yet — run craftar status once to fetch it`,
    ]);
  });

  it("a relative CRAFTAR_HOME resolves from the current directory", async () => {
    const { r, ws } = await remoteWs();
    const cwd = await tmpDir("craftar-cwd-");
    cleanups.push(() => fs.rm(cwd, { recursive: true, force: true }));
    const x = runCli(["status", "--workspace", ws], { cwd, env: { CRAFTAR_HOME: "relhome" } });
    expect(x.code).toBe(0);
    expect(await fs.readdir(path.join(cwd, "relhome", "forges"))).toHaveLength(1);
  });
});

describe("cli — no message prints a credential before it is checked (review of spec 13, round 2)", () => {
  it("a ? or # inside the password is refused at load; a YAML syntax error names the place, not the line", async () => {
    const s = await scenario({ recipes: [recipe("base", [])], profiles: [profile("acme", ["base"])] }, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const run = () => runCli(["status", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } });
    await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), "forge: ssh://u:SECRET?x@h.invalid/r\nprofile: acme\n");
    const a = run();
    expect([a.code, a.stderr]).toEqual([
      1,
      "error: craftar.yaml › forge holds credentials in the URL — remove them and let git authenticate (credential helper, SSH agent; see README › Remote Forge)\n",
    ]);
    await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), "forge: https://u:SECRET@h.invalid/r: x\nprofile: acme\n");
    const b = run();
    expect(b.code).toBe(1);
    expect(b.stderr.startsWith("error: invalid craftar.yaml: ")).toBe(true);
    expect(b.stderr).toMatch(/line 1, column \d+/);
    expect(a.stdout + a.stderr + b.stdout + b.stderr).not.toContain("SECRET");
    expect(await fs.readdir(home)).toEqual([]);
  });
});

describe("cli — a workspace file's YAML never echoes a credential, on any command (review of spec 13, round 3)", () => {
  it("import with a YAML error in craftar.yaml, with and without --write-config: the secret is never printed", async () => {
    for (const extra of [[], ["--write-config"]]) {
      const root = await tmpDir("craftar-import-yaml-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const ws = path.join(root, "ws");
      await writeFiles(ws, { ".claude/rules/a.md": "# A\n", "craftar.yaml": "forge: https://u:SECRET@h.invalid/r: x\nprofile: acme\n" });
      const r = runCli(["import", "--from", "claude-code", "--workspace", ws, "--forge", path.join(root, "forge"), "--profile", "acme", ...extra]);
      expect(r.code, extra.join(" ")).toBe(1);
      expect(r.stderr, extra.join(" ")).toContain("import: craftar.yaml does not load (invalid craftar.yaml: ");
      expect(r.stdout + r.stderr, extra.join(" ")).not.toContain("SECRET");
    }
  });

  it("a YAML warning (an unknown tag) is not printed before the credential refusal", async () => {
    const s = await scenario({ recipes: [recipe("base", [])], profiles: [profile("acme", ["base"])] }, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    const home = await tmpDir("craftar-home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), "forge: !foo https://u:SECRET@h.invalid/r\nprofile: acme\n");
    const r = runCli(["status", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("craftar.yaml › forge holds credentials in the URL");
    expect(r.stdout + r.stderr).not.toContain("SECRET");
  });
});

describe("cli — the workspace registry (spec 21 §10.3)", () => {
  const SPEC = {
    ingredients: [rule("a", "# A\n")],
    recipes: [recipe("base", ["rule/a"]), recipe("frontend-angular", [], { slot: "frontend" })],
    profiles: [profile("acme", ["base", "frontend-angular"])],
  };

  /** A temporary root with its own CRAFTAR_HOME, a path Forge, and workspaces made on demand. */
  async function setup() {
    const root = await tmpDir("craftar-registry-cli-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    const forgeRoot = path.join(root, "forge");
    await makeForge(forgeRoot, SPEC);
    const ws = async (name: string) => {
      const dir = path.join(root, name);
      await writeFiles(dir, { "craftar.yaml": "forge: ../forge\nprofile: acme\n" });
      return dir;
    };
    const run = (args: string[], env: NodeJS.ProcessEnv = {}) => runCli(args, { env: { CRAFTAR_HOME: home, ...env } });
    const registry = path.join(home, "registry.json");
    const entries = async () => JSON.parse(await fs.readFile(registry, "utf8")).workspaces as Array<{ path: string; lastSync: string }>;
    return { root, home, forgeRoot, ws, run, registry, entries };
  }

  it("a writing sync registers; --dry-run and --check do not; a sync with nothing to write still updates lastSync", async () => {
    const s = await setup();
    const a = await s.ws("acme-a");
    expect(s.run(["sync", "--dry-run", "--workspace", a]).code).toBe(0);
    expect(await exists(s.registry)).toBe(false);
    expect(s.run(["sync", "--workspace", a]).code).toBe(0);
    const [first] = await s.entries();
    expect(first.path).toBe(await fs.realpath(a));
    const b = await s.ws("acme-b");
    expect(s.run(["sync", "--check", "--workspace", b]).code).toBe(1);
    expect((await s.entries()).map((e) => path.basename(e.path))).toEqual(["acme-a"]);
    await new Promise((r) => setTimeout(r, 20));
    const again = s.run(["sync", "--workspace", a]);
    expect(again.stdout).toContain("wrote 0,");
    expect(again.stdout).not.toContain("registry");
    const [second] = await s.entries();
    expect(second.lastSync > first.lastSync).toBe(true);
  });

  it("CRAFTAR_NO_REGISTRY: a non-empty value turns it off for sync and refuses every workspaces form; an empty one is unset", async () => {
    const s = await setup();
    const a = await s.ws("acme-a");
    const off = { CRAFTAR_NO_REGISTRY: "1" };
    const r = s.run(["sync", "--workspace", a], off);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("registry");
    expect(await exists(s.home)).toBe(false);
    for (const args of [["workspaces"], ["workspaces", "--json"], ["workspaces", "forget", a], ["workspaces", "prune"]]) {
      const x = s.run(args, off);
      expect(x.code, args.join(" ")).toBe(1);
      expect(x.stderr).toContain("the workspace registry is off (CRAFTAR_NO_REGISTRY is set)");
    }
    expect(await exists(s.home)).toBe(false);
    expect(s.run(["sync", "--workspace", a], { CRAFTAR_NO_REGISTRY: "" }).code).toBe(0);
    expect(await s.entries()).toHaveLength(1);
  });

  it("a CRAFTAR_HOME that cannot hold the registry: sync still writes its files and lock, exits 0, and warns", async () => {
    const s = await setup();
    const a = await s.ws("acme-a");
    await fs.writeFile(s.home, "not a directory\n");
    const r = s.run(["sync", "--workspace", a]);
    expect(r.code).toBe(0);
    expect(await exists(path.join(a, ".claude/rules/a.md"))).toBe(true);
    expect(await exists(path.join(a, "craftar.lock"))).toBe(true);
    expect(r.stdout).toContain(`warn registry not updated (${s.registry}): `);
  });

  it("a registry of schema 2, or of invalid JSON: sync warns and leaves its bytes; workspaces exits 1 naming it", async () => {
    const s = await setup();
    const a = await s.ws("acme-a");
    for (const body of [JSON.stringify({ schema: 2, workspaces: [] }) + "\n", "{ not json\n"]) {
      await writeFiles(s.home, { "registry.json": body });
      const r = s.run(["sync", "--workspace", a]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`warn registry not updated (${s.registry}): `);
      expect(await fs.readFile(s.registry, "utf8")).toBe(body);
      const w = s.run(["workspaces"]);
      expect(w.code).toBe(1);
      expect(w.stderr).toMatch(body.startsWith("{ not") ? `cannot read ${s.registry}` : "registry.json declares schema 2, which this craftar does not read — upgrade craftar");
    }
  });

  it("the table: up to date and drift, then missing; prune and forget; an error row is never pruned; nothing is written", async () => {
    const s = await setup();
    const ok = await s.ws("acme-ok");
    const drift = await s.ws("acme-drift");
    const gone = await s.ws("acme-gone");
    const broken = await s.ws("acme-broken");
    for (const w of [ok, drift, gone, broken]) expect(s.run(["sync", "--workspace", w]).code).toBe(0);
    await writeFiles(drift, { ".claude/rules/a.md": "# Edited\n" });
    await fs.rm(gone, { recursive: true });
    await writeFiles(broken, { "craftar.yaml": "forge: ../nowhere\nprofile: acme\n" });
    const before = await fs.stat(s.registry);
    const bytes = await fs.readFile(s.registry, "utf8");

    const t = s.run(["workspaces"]);
    expect(t.code).toBe(0);
    const out = t.stdout;
    expect(out).toContain("craftar workspaces — 4 registered\n");
    expect(out).not.toContain("(status read offline");
    expect(out).toMatch(/acme-ok\s+.*\n\s+profile acme · frontend=frontend-angular · claude-code\n\s+forge \.\.\/forge @ no git · synced \d{4}-\d\d-\d\d \d\d:\d\d UTC · up to date\n/);
    expect(out).toMatch(/forge \.\.\/forge @ no git · synced [^\n]* · drift\n/);
    expect(out).toMatch(/acme-gone[^\n]*\n\s+profile acme · frontend=frontend-angular · claude-code\n\s+synced [^\n]* · missing\n/);
    expect(out).toMatch(/synced [^\n]* · error\n/);
    expect(out).toContain(`warn ${await fs.realpath(broken)}: Forge not found at `);
    expect(await fs.readFile(s.registry, "utf8")).toBe(bytes);
    expect((await fs.stat(s.registry)).mtimeMs).toBe(before.mtimeMs);

    const p1 = s.run(["workspaces", "prune"]);
    expect(p1.code).toBe(0);
    expect(p1.stdout.trim()).toBe(`pruned ${path.join(await fs.realpath(s.root), "acme-gone")}`);
    expect(s.run(["workspaces", "prune"]).stdout.trim()).toBe("nothing to prune");
    const f = s.run(["workspaces", "forget", drift]);
    expect(f.code).toBe(0);
    expect(f.stdout.trim()).toBe(`forgot ${await fs.realpath(drift)}`);
    const again = s.run(["workspaces", "forget", drift]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain(`${await fs.realpath(drift)} is not registered`);
    expect((await s.entries()).map((e) => path.basename(e.path))).toEqual(["acme-broken", "acme-ok"]);
  });

  it("a Forge from craftar.local.yaml is recorded and marked (local override)", async () => {
    const s = await setup();
    const a = await s.ws("acme-a");
    await writeFiles(a, { "craftar.yaml": "forge: ../nowhere\nprofile: acme\n", "craftar.local.yaml": "forge: ../forge\n" });
    expect(s.run(["sync", "--workspace", a]).code).toBe(0);
    expect(JSON.parse(await fs.readFile(s.registry, "utf8")).workspaces[0].forge).toMatchObject({ source: "../forge", fromLocalFile: true });
    expect(s.run(["workspaces"]).stdout).toMatch(/forge \.\.\/forge \(local override\) @ no git · synced /);
  });

  it("an empty registry", async () => {
    const s = await setup();
    const r = s.run(["workspaces"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("craftar workspaces — no workspace registered (craftar sync registers one)");
  });

  it("--json: the full key set for a path Forge, a remote Forge and a missing row", async () => {
    const s = await setup();
    const a = await s.ws("acme-a");
    const r = await remoteForge(SPEC);
    cleanups.push(r.cleanup);
    const rem = path.join(s.root, "acme-remote");
    await writeFiles(rem, { "craftar.yaml": `forge: ${r.url}\nprofile: acme\n` });
    const gone = await s.ws("acme-gone");
    for (const w of [a, rem, gone]) expect(s.run(["sync", "--workspace", w]).code).toBe(0);
    await fs.rm(gone, { recursive: true });
    const j = JSON.parse(s.run(["workspaces", "--json"]).stdout);
    expect(Object.keys(j)).toEqual(["registry", "fetch", "workspaces", "warnings"]);
    expect(j.registry).toBe(s.registry);
    expect(j.fetch).toBe(false);
    const rowKeys = ["name", "path", "profile", "recipes", "stack", "targets", "forge", "lastSync", "status", "forgeMoved", "files"];
    const forgeKeys = ["kind", "source", "key", "ref", "defaultBranch", "commit", "lockCommit", "fromLocalFile", "fetched"];
    for (const row of j.workspaces) {
      expect(Object.keys(row)).toEqual(rowKeys);
      expect(Object.keys(row.forge)).toEqual(forgeKeys);
    }
    const by = Object.fromEntries(j.workspaces.map((w: { name: string }) => [w.name, w]));
    const sha = git(r.src, "rev-parse", "HEAD");
    expect(by["acme-a"]).toMatchObject({ status: "up-to-date", forgeMoved: null, files: { unchanged: 1 }, stack: { frontend: "frontend-angular" }, forge: { kind: "path", ref: null, commit: null, lockCommit: null, fetched: false } });
    expect(by["acme-remote"]).toMatchObject({ status: "up-to-date", forgeMoved: false, forge: { kind: "remote", source: r.url, ref: null, defaultBranch: "main", commit: sha, lockCommit: sha, fetched: false } });
    expect(by["acme-gone"]).toMatchObject({ status: "missing", forgeMoved: null, files: null, forge: { defaultBranch: null, lockCommit: null, fetched: false } });
    expect(j.warnings).toEqual([]);
  });

  it("a remote Forge: read offline from the cache without fetching; --fetch picks up a new commit", async () => {
    const s = await setup();
    const r = await remoteForge(SPEC);
    cleanups.push(r.cleanup);
    const rem = path.join(s.root, "acme-remote");
    await writeFiles(rem, { "craftar.yaml": `forge: ${r.url}\nprofile: acme\n` });
    expect(s.run(["sync", "--workspace", rem]).code).toBe(0);
    const entry = path.join(s.home, "forges", (await fs.readdir(path.join(s.home, "forges")))[0]);
    const refs = () => git(path.join(entry, "repo.git"), "for-each-ref");
    const stamp = () => fs.readFile(path.join(entry, "fetched"), "utf8");
    const [refs0, stamp0, reg0] = [refs(), await stamp(), await fs.readFile(s.registry, "utf8")];
    const next = await r.commit({ "README.md": "moved\n" });
    await fs.rename(r.bare, `${r.bare}.away`);
    const off = s.run(["workspaces"]);
    expect(off.code).toBe(0);
    expect(off.stdout).toContain("craftar workspaces — 1 registered (status read offline from the Forge cache)\n");
    expect(off.stdout).toContain(" · up to date\n");
    expect(refs()).toBe(refs0);
    expect(await stamp()).toBe(stamp0);
    expect(await fs.readFile(s.registry, "utf8")).toBe(reg0);
    await fs.rename(`${r.bare}.away`, r.bare);
    const on = JSON.parse(s.run(["workspaces", "--json", "--fetch"]).stdout);
    expect(on.fetch).toBe(true);
    expect(on.workspaces[0]).toMatchObject({ forgeMoved: true, forge: { commit: next, fetched: true } });
  });
});

describe("cli — add recipe / remove recipe (spec 22)", () => {
  const R2 = (x: string) => `error: recipe "${x}" not found in this Forge (base, front-a, front-b, front-c, stack-api)\n`;
  const R6 = (cmd: string) =>
    `error: ${cmd}: cannot edit craftar.yaml in place (it does not round-trip unchanged through the YAML writer) — reformat it by hand and re-run\n`;
  const BASE_YAML = "forge: ../forge\nprofile: acme\n";

  /** Spec 22 §9's Forge, profile acme = [stack-api, front-a]; synced unless asked not to. */
  async function recipeScenario(opts: { sync?: boolean; local?: Record<string, unknown> } = {}) {
    const s = await scenario(
      {
        ingredients: [
          rule("base", "base\n"),
          rule("api", "api\n"),
          rule("front-a", "front a\n"),
          rule("front-b", "front b\n"),
          rule("front-c", "owner {{owner}}\n"),
        ],
        recipes: [
          recipe("base", ["rule/base"]),
          recipe("stack-api", ["rule/api"], { extends: ["base"] }),
          recipe("front-a", ["rule/front-a"], { slot: "front" }),
          recipe("front-b", ["rule/front-b"], { slot: "front" }),
          recipe("front-c", ["rule/front-c"], { slot: "front" }),
        ],
        profiles: [profile("acme", ["stack-api", "front-a"])],
      },
      { config: { profile: "acme" }, local: opts.local },
    );
    cleanups.push(s.cleanup);
    if (opts.sync !== false) expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    return s;
  }
  const yamlOf = (s: { wsRoot: string }) => fs.readFile(path.join(s.wsRoot, "craftar.yaml"), "utf8");
  const setYaml = (s: { wsRoot: string }, text: string) => fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), text);
  const recipeCli = (s: { wsRoot: string }, ...args: string[]) => runCli([...args, "--workspace", s.wsRoot]);
  /** Snapshots the workspace (but craftar.yaml) and the Forge; the returned check asserts nothing else moved. */
  async function guard(s: { wsRoot: string; forgeRoot: string }) {
    const strip = (snap: Record<string, string>) => {
      delete snap["craftar.yaml"];
      return snap;
    };
    const ws = strip(await snapshot(s.wsRoot));
    const forgeBefore = await snapshot(s.forgeRoot);
    return async () => {
      expect(strip(await snapshot(s.wsRoot))).toEqual(ws);
      expect(await snapshot(s.forgeRoot)).toEqual(forgeBefore);
    };
  }

  it("test 1: a slot held by another recipe is refused without --replace (R3)", async () => {
    const s = await recipeScenario();
    const r = recipeCli(s, "add", "recipe", "front-b");
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe('error: recipe "front-b" occupies slot "front", held by "front-a" — pass --replace to swap them\n');
    expect(await yamlOf(s)).toBe(BASE_YAML);
  });

  it("tests 2–3: --replace swaps, the output says what the next sync does, and swapping back cancels", async () => {
    const s = await recipeScenario();
    const r = recipeCli(s, "add", "recipe", "front-b", "--replace");
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "craftar.yaml: recipes.add + front-b; recipes.remove + front-a\n" +
        "recipes: base → stack-api → front-b\n" +
        "next sync: 1 new, 1 orphan — run `craftar sync`\n",
    );
    expect(await yamlOf(s)).toBe(BASE_YAML + "recipes:\n  add:\n    - front-b\n  remove:\n    - front-a\n");
    expect(recipeCli(s, "status").stdout.split("\n")[0]).toBe("craftar status — profile acme · recipes base → stack-api → front-b");

    const back = recipeCli(s, "add", "recipe", "front-a", "--replace");
    expect(back.code).toBe(0);
    expect(back.stderr).toBe("");
    expect(back.stdout).toBe(
      "craftar.yaml: recipes.add - front-b; recipes.remove - front-a\n" +
        "recipes: base → stack-api → front-a\n" +
        "next sync: nothing to sync\n",
    );
    expect(await yamlOf(s)).toBe(BASE_YAML + "recipes:\n  add: []\n  remove: []\n");
  });

  it("test 4: remove of a recipe extends brings in is refused, naming the top-level recipe (R4)", async () => {
    const s = await recipeScenario();
    const r = recipeCli(s, "remove", "recipe", "base");
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe('error: recipe "base" comes in through "stack-api" (extends) — remove "stack-api", or change the Forge\n');
    expect(await yamlOf(s)).toBe(BASE_YAML);
  });

  it("test 5: remove of a profile recipe takes what only it brought in", async () => {
    const s = await recipeScenario();
    const r = recipeCli(s, "remove", "recipe", "stack-api");
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("craftar.yaml: recipes.remove + stack-api\nrecipes: front-a\nnext sync: 2 orphan — run `craftar sync`\n");
    expect(await yamlOf(s)).toBe(BASE_YAML + "recipes:\n  remove:\n    - stack-api\n");
  });

  it("test 6: add of a recipe in use changes nothing and writes nothing", async () => {
    const s = await recipeScenario();
    const r = recipeCli(s, "add", "recipe", "stack-api");
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("nothing to change: stack-api is already in use\n");
    expect(await yamlOf(s)).toBe(BASE_YAML);
  });

  it("test 7: an unknown name is R2; one written by hand is R5 for other calls and cleaned up by remove", async () => {
    const s = await recipeScenario();
    const unmoved = await guard(s);
    const r = recipeCli(s, "add", "recipe", "nope");
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(R2("nope"));

    await setYaml(s, BASE_YAML + "recipes:\n  add: [nope]\n");
    const st = recipeCli(s, "status");
    expect(st.code).toBe(1);
    expect(st.stderr).toBe('error: recipe "nope" not found (referenced by craftar.yaml recipes.add)\n');
    const other = recipeCli(s, "add", "recipe", "front-b", "--replace");
    expect(other.code).toBe(1);
    expect(other.stdout).toBe("");
    expect(other.stderr).toBe('error: recipe "nope" not found (referenced by craftar.yaml recipes.add)\n');

    const clean = recipeCli(s, "remove", "recipe", "nope");
    expect(clean.code).toBe(0);
    expect(clean.stderr).toBe("");
    expect(clean.stdout).toBe("craftar.yaml: recipes.add - nope\nrecipes: base → stack-api → front-a\nnext sync: nothing to sync\n");
    expect(await yamlOf(s)).toBe(BASE_YAML + "recipes:\n  add: []\n");
    await unmoved();
  });

  it("tests 8–9: a name twice is R7; one bad name refuses the whole call", async () => {
    const s = await recipeScenario();
    const twice = recipeCli(s, "add", "recipe", "front-b", "front-b", "--replace");
    expect(twice.code).toBe(1);
    expect(twice.stdout).toBe("");
    expect(twice.stderr).toBe('error: recipe "front-b" is named twice\n');
    const bad = recipeCli(s, "add", "recipe", "front-b", "nope", "--replace");
    expect(bad.code).toBe(1);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toBe(R2("nope"));
    expect(await yamlOf(s)).toBe(BASE_YAML);
  });

  it("test 10: craftar.local.yaml with recipes is refused for both commands (R1); with only targets it is not", async () => {
    const R1 = "error: craftar.local.yaml sets recipes, which replaces craftar.yaml's lists — edit it by hand, or remove its recipes key and re-run\n";
    const s = await recipeScenario({ sync: false, local: { recipes: { add: [] } } });
    const unmovedS = await guard(s);
    for (const args of [["add", "recipe", "front-b", "--replace"], ["remove", "recipe", "stack-api"]]) {
      const r = recipeCli(s, ...args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stdout, args.join(" ")).toBe("");
      expect(r.stderr, args.join(" ")).toBe(R1);
    }
    expect(await yamlOf(s)).toBe(BASE_YAML);

    await unmovedS();

    const t = await recipeScenario({ local: { targets: ["claude-code"] } });
    const unmovedT = await guard(t);
    const ok = recipeCli(t, "add", "recipe", "front-b", "--replace");
    expect(ok.code).toBe(0);
    expect(ok.stderr).toBe("");
    expect(ok.stdout).toBe(
      "craftar.yaml: recipes.add + front-b; recipes.remove + front-a\n" +
        "recipes: base → stack-api → front-b\n" +
        "next sync: 1 new, 1 orphan — run `craftar sync`\n",
    );
    await unmovedT();
  });

  it("tests 11–12: the README's padded flow form is R6, file untouched; the unpadded one is edited in place", async () => {
    const s = await recipeScenario();
    const unmoved = await guard(s);
    const padded = BASE_YAML + "recipes: { add: [], remove: [] }\n";
    await setYaml(s, padded);
    const r = recipeCli(s, "add", "recipe", "front-b", "--replace");
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(R6("add recipe"));
    expect(await yamlOf(s)).toBe(padded);

    await setYaml(s, "\uFEFF" + BASE_YAML.replace(/\n/g, "\r\n") + "recipes: {add: [], remove: []}\r\n");
    const r2 = recipeCli(s, "remove", "recipe", "stack-api");
    expect(r2.code).toBe(0);
    expect(r2.stderr).toBe("");
    expect(r2.stdout).toBe("craftar.yaml: recipes.remove + stack-api\nrecipes: front-a\nnext sync: 2 orphan — run `craftar sync`\n");
    expect(await yamlOf(s)).toBe("\uFEFF" + BASE_YAML.replace(/\n/g, "\r\n") + "recipes: {add: [], remove: [stack-api]}\r\n");
    await unmoved();
  });

  it("test 13: nothing to sync when no file moves; a plan warning goes to stderr", async () => {
    const s = await recipeScenario();
    const unmovedS = await guard(s);
    await setYaml(s, BASE_YAML + "recipes:\n  remove: [base]\n");
    const r = recipeCli(s, "add", "recipe", "base");
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("craftar.yaml: recipes.remove - base\nrecipes: base → stack-api → front-a\nnext sync: nothing to sync\n");

    await unmovedS();

    const t = await recipeScenario();
    const unmovedT = await guard(t);
    const w = recipeCli(t, "add", "recipe", "front-c", "--replace");
    expect(w.code).toBe(0);
    expect(w.stdout).toBe(
      "craftar.yaml: recipes.add + front-c; recipes.remove + front-a\n" +
        "recipes: base → stack-api → front-c\n" +
        "next sync: 1 new, 1 orphan — run `craftar sync`\n",
    );
    expect(w.stderr).toBe('warn param "owner" has no value in any layer — left verbatim (rule/front-c)\n');
    await unmovedT();
  });

  it("test 14: nothing but craftar.yaml is written, by any call", async () => {
    const s = await recipeScenario();
    const ws = await snapshot(s.wsRoot);
    const forgeBefore = await snapshot(s.forgeRoot);
    for (const args of [
      ["add", "recipe", "front-b"],
      ["remove", "recipe", "base"],
      ["add", "recipe", "nope"],
      ["add", "recipe", "front-b", "--replace"],
      ["remove", "recipe", "stack-api"],
      ["add", "recipe", "stack-api"],
    ])
      recipeCli(s, ...args);
    const after = await snapshot(s.wsRoot);
    delete ws["craftar.yaml"];
    delete after["craftar.yaml"];
    expect(after).toEqual(ws);
    expect(await snapshot(s.forgeRoot)).toEqual(forgeBefore);
  });

  it("test 15: --replace with no slot conflict is the same as without it", async () => {
    const s = await recipeScenario();
    const t = await recipeScenario();
    for (const w of [s, t]) expect(recipeCli(w, "remove", "recipe", "stack-api").code).toBe(0);
    const a = recipeCli(s, "add", "recipe", "stack-api", "--replace");
    const b = recipeCli(t, "add", "recipe", "stack-api");
    expect(a.code).toBe(0);
    expect(a.stdout).toBe("craftar.yaml: recipes.remove - stack-api\nrecipes: base → stack-api → front-a\nnext sync: nothing to sync\n");
    expect(b.stdout).toBe(a.stdout);
    expect(await yamlOf(t)).toBe(await yamlOf(s));
  });

  it("test 16: --replace removes every other holder of the slot", async () => {
    const s = await recipeScenario();
    const unmoved = await guard(s);
    await setYaml(s, BASE_YAML + "recipes:\n  add: [front-c]\n");
    const r = recipeCli(s, "add", "recipe", "front-b", "--replace");
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "craftar.yaml: recipes.add + front-b, - front-c; recipes.remove + front-a\n" +
        "recipes: base → stack-api → front-b\n" +
        "next sync: 1 new, 1 orphan — run `craftar sync`\n",
    );
    expect(await yamlOf(s)).toBe(BASE_YAML + "recipes:\n  add: [front-b]\n  remove:\n    - front-a\n");
    await unmoved();
  });

  it("test 17: an edit that resolves but does not plan is refused, craftar.yaml untouched (R5, §5.2 step 4)", async () => {
    const s = await scenario(
      {
        ingredients: [rule("b", "b\n"), rule("m", "<!-- craftar:section s -->\nx\n<!-- /craftar:section -->\n")],
        recipes: [recipe("base", ["rule/b"]), recipe("marked", ["rule/m"])],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    const unmoved = await guard(s);
    const r = runCli(["add", "recipe", "marked", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "error: craftar.forge.yaml declares schema: 1, but ingredients/rules/m/rule.md:1 holds a section marker — set schema: 2 in craftar.forge.yaml, so that craftar 0.6.2 and older refuse this Forge instead of emitting the markers\n",
    );
    expect(await fs.readFile(path.join(s.wsRoot, "craftar.yaml"), "utf8")).toBe(BASE_YAML);
    await unmoved();
  });

  it("§14 item 7: recipes --json carries the craftar.yaml wording in its warning", async () => {
    const s = await recipeScenario();
    await setYaml(s, BASE_YAML + "recipes:\n  add: [nope]\n");
    const r = recipeCli(s, "recipes", "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).warnings).toEqual([
      'cannot resolve this workspace (profile acme): recipe "nope" not found (referenced by craftar.yaml recipes.add) — nothing is marked as in use',
    ]);
  });

  it("test 18: a workspace warning is printed once, on stderr", async () => {
    const s = await recipeScenario();
    await setYaml(s, "forge: ../forge\nref: v1\nprofile: acme\n");
    const r = recipeCli(s, "add", "recipe", "front-b", "--replace");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      "craftar.yaml: recipes.add + front-b; recipes.remove + front-a\n" +
        "recipes: base → stack-api → front-b\n" +
        "next sync: 1 new, 1 orphan — run `craftar sync`\n",
    );
    expect(r.stderr).toBe('warn ref "v1" is ignored: the Forge is a path (../forge), read as its working tree\n');
  });
});

describe("cli — a missing craftar.yaml points at craftar init first (spec 23 §13 item 6)", () => {
  it("every command that loads a workspace through loadWorkspace names craftar init, then import", async () => {
    const dir = await tmpDir("craftar-no-yaml-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const expected = `error: craftar.yaml not found in ${dir} — run \`craftar init --workspace "${dir}" --forge <dir> --profile <name>\` to start one, or \`craftar import --workspace "${dir}" --from claude-code --forge <dir> --profile <name> --write-config\` to bring in an existing harness\n`;
    for (const args of [["status"], ["sync"], ["diff"], ["explain", "x.md"], ["ls"], ["add", "recipe", "base"], ["remove", "recipe", "base"], ["targets"]]) {
      const r = runCli([...args, "--workspace", dir]);
      expect([r.code, r.stderr], args.join(" ")).toEqual([1, expected]);
    }
  });
});

describe("cli — craftar init (spec 23 §9.2)", () => {
  const SPEC = {
    ingredients: [rule("a", "# A\n"), rule("b", "# B\n"), rule("p", "# P {{nope}}\n")],
    recipes: [recipe("base", ["rule/a"]), recipe("extra", ["rule/b"]), recipe("ph", ["rule/p"])],
    profiles: [profile("acme", ["base"])],
  };
  const COLLISION = "  warn 1 file(s) already in the workspace differ from the Forge and were left as they are — to bring them into the Forge, run craftar import";

  /** A temporary root with its own CRAFTAR_HOME and a path Forge; workspaces are siblings of the Forge. */
  async function setup() {
    const root = await tmpDir("craftar-init-cli-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    const forge = path.join(root, "forge");
    await makeForge(forge, SPEC);
    const run = (args: string[], env: NodeJS.ProcessEnv = {}) => runCli(args, { env: { CRAFTAR_HOME: home, ...env } });
    const init = (ws: string, extra: string[] = [], env: NodeJS.ProcessEnv = {}) =>
      run(["init", "--workspace", ws, "--forge", forge, "--profile", "acme", ...extra], env);
    const registry = path.join(home, "registry.json");
    return { root, home, forge, run, init, registry };
  }
  const withoutLock = (snap: Record<string, string>) => Object.fromEntries(Object.entries(snap).filter(([k]) => k !== "craftar.lock"));
  const lockBody = async (ws: string) => {
    const { generatedAt, ...rest } = JSON.parse(await fs.readFile(path.join(ws, "craftar.lock"), "utf8"));
    void generatedAt;
    return rest;
  };

  it("an empty directory: craftar.yaml, then the same workspace and report a hand-written craftar.yaml plus sync give; registered", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    await fs.mkdir(ws);
    const r = s.init(ws);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    const lines = r.stdout.split("\n");
    expect(lines.slice(0, 2)).toEqual([
      `craftar init — wrote craftar.yaml in ${ws}`,
      "  forge ../forge · profile acme · recipes base · targets claude-code (from the profile)",
    ]);
    expect(await fs.readFile(path.join(ws, "craftar.yaml"), "utf8")).toBe("forge: ../forge\nprofile: acme\n");

    const hand = path.join(s.root, "hand");
    await writeFiles(hand, { "craftar.yaml": "forge: ../forge\nprofile: acme\n" });
    const h = s.run(["sync", "--workspace", hand]);
    expect(h.code).toBe(0);
    expect(lines.slice(2).join("\n")).toBe(h.stdout);
    expect(withoutLock(await snapshot(ws))).toEqual(withoutLock(await snapshot(hand)));
    expect(await lockBody(ws)).toEqual(await lockBody(hand));
    const reg = JSON.parse(await fs.readFile(s.registry, "utf8")).workspaces.map((w: { path: string }) => w.path);
    expect(reg).toContain(await fs.realpath(ws));
  });

  it("craftar.yaml already there: N1, the file unchanged", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    await writeFiles(ws, { "craftar.yaml": "forge: elsewhere\nprofile: other\n" });
    const r = s.init(ws);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`error: craftar.yaml already exists in ${ws} — change recipes with craftar add recipe / remove recipe, or edit it\n`);
    expect(await snapshot(ws)).toEqual({ "craftar.yaml": "forge: elsewhere\nprofile: other\n" });
  });

  it("--workspace: created when missing, not created on a refusal, refused when it is a file (N9)", async () => {
    const s = await setup();
    const ws = path.join(s.root, "new", "deep");
    const r = s.init(ws);
    expect(r.code, r.stderr).toBe(0);
    expect(await fs.readFile(path.join(ws, "craftar.yaml"), "utf8")).toBe("forge: ../../forge\nprofile: acme\n");

    const never = path.join(s.root, "never");
    const n5 = s.run(["init", "--workspace", never, "--forge", s.forge, "--profile", "nope"]);
    expect(n5.code).toBe(1);
    expect(n5.stderr).toBe('error: profile "nope" not found in Forge (acme)\n');
    expect(await exists(never)).toBe(false);

    const file = path.join(s.root, "a-file");
    await fs.writeFile(file, "x\n");
    const n9 = s.init(file);
    expect(n9.code).toBe(1);
    expect(n9.stderr).toBe(`error: cannot use ${file} as a workspace: it is not a directory\n`);
    expect(await fs.readFile(file, "utf8")).toBe("x\n");
  });

  it("a differing file already there: left as it is, a collision, the import warning, exit 0", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    await writeFiles(ws, { ".claude/rules/a.md": "# mine\n" });
    const r = s.init(ws);
    expect(r.code, r.stderr).toBe(0);
    expect(await fs.readFile(path.join(ws, ".claude/rules/a.md"), "utf8")).toBe("# mine\n");
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines).toContain("  wrote 0, removed 0 orphan(s), skipped 1");
    expect(lines.at(-1)).toBe(COLLISION);
    // Without a collision there is no such line.
    const clean = path.join(s.root, "clean");
    expect(s.init(clean).stdout).not.toContain("already in the workspace differ");
  });

  it("a craftar.lock from an earlier sync: --no-sync counts update and orphan; without it, sync's report", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    await writeFiles(ws, { "craftar.yaml": "forge: ../forge\nprofile: acme\nrecipes:\n  add: [extra]\n" });
    expect(s.run(["sync", "--workspace", ws]).code).toBe(0);
    await writeFiles(s.forge, { "ingredients/rules/a/rule.md": "# A changed\n" });
    await fs.rm(path.join(ws, "craftar.yaml"));
    const dry = s.init(ws, ["--no-sync"]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout.split("\n")[2]).toBe("next sync: 1 update, 1 orphan — run `craftar sync`");
    await fs.rm(path.join(ws, "craftar.yaml"));
    const r = s.init(ws);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.split("\n").slice(2, 6)).toEqual([
      "craftar sync — profile acme · recipes base · targets claude-code",
      "  wrote 1, removed 1 orphan(s), skipped 0",
      "  + .claude/rules/a.md",
      "  - .claude/rules/b.md  (orphan: no longer produced by the Forge)",
    ]);
  });

  it("--no-sync: craftar.yaml only, the next sync line and the plan's warnings, nothing registered", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    const r = s.init(ws, ["--no-sync", "--add-recipe", "ph"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(
      [
        `craftar init — wrote craftar.yaml in ${ws}`,
        "  forge ../forge · profile acme · recipes base → ph · targets claude-code (from the profile)",
        "next sync: 2 new — run `craftar sync`",
        "  warn param \"nope\" has no value in any layer — left verbatim (rule/p)",
        "",
      ].join("\n"),
    );
    expect(await snapshot(ws)).toEqual({ "craftar.yaml": "forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - ph\n" });
    expect(await exists(s.registry)).toBe(false);
    // Then craftar sync gives the tree init without the flag gives (§6 case 7).
    expect(s.run(["sync", "--workspace", ws]).code).toBe(0);
    const other = path.join(s.root, "other");
    expect(s.init(other, ["--add-recipe", "ph"]).code).toBe(0);
    expect(withoutLock(await snapshot(ws))).toEqual(withoutLock(await snapshot(other)));
  });

  it("CRAFTAR_NO_REGISTRY=1: synced, not registered", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    const r = s.init(ws, [], { CRAFTAR_NO_REGISTRY: "1" });
    expect(r.code, r.stderr).toBe(0);
    expect(await fs.readFile(path.join(ws, ".claude/rules/a.md"), "utf8")).toBe("# A\n");
    expect(await exists(s.registry)).toBe(false);
  });

  it("the first block: targets labelled by where they come from; a recipe call that changes nothing is a note", async () => {
    const s = await setup();
    const a = path.join(s.root, "a");
    const r = s.init(a, ["--no-sync", "--targets", "claude-code,kiro", "--remove-recipe", "extra"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.split("\n").slice(1, 3)).toEqual(["  forge ../forge · profile acme · recipes base · targets claude-code, kiro", "  note extra is not in use"]);
    expect(await fs.readFile(path.join(a, "craftar.yaml"), "utf8")).toBe("forge: ../forge\nprofile: acme\ntargets:\n  - claude-code\n  - kiro\n");
    const b = path.join(s.root, "b");
    await writeFiles(b, { "craftar.local.yaml": "targets: [kiro]\n" });
    const l = s.init(b, ["--no-sync"]);
    expect(l.code, l.stderr).toBe(0);
    expect(l.stdout.split("\n")[1]).toBe("  forge ../forge · profile acme · recipes base · targets kiro (from craftar.local.yaml)");
    const n10 = s.init(b, ["--no-sync", "--targets", "kiro"]);
    expect(n10.code).toBe(1);
  });

  it("a credential in --forge is refused naming the flag, never the value; nothing written", async () => {
    const s = await setup();
    const ws = path.join(s.root, "ws");
    const r = s.run(["init", "--workspace", ws, "--forge", "https://alice:s3cr3t@example.invalid/acme/forge.git", "--profile", "acme"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("error: --forge holds credentials in the URL — remove them and let git authenticate (credential helper, SSH agent; see README › Remote Forge)\n");
    expect(r.stdout + r.stderr).not.toContain("s3cr3t");
    expect(await exists(ws)).toBe(false);
  });

  it("--forge and --profile are required (N2)", async () => {
    const s = await setup();
    const r = s.run(["init", "--workspace", path.join(s.root, "ws"), "--forge", s.forge]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("error: required option '--profile <name>' not specified\n");
  });
});

describe("cli — craftar doctor (spec 24 §9.2)", () => {
  const SPEC = { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] };

  async function setup() {
    const root = await tmpDir("craftar-doctor-cli-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    await makeForge(path.join(root, "forge"), SPEC);
    const ws = path.join(root, "acme-a");
    await writeFiles(ws, { "craftar.yaml": "forge: ../forge\nprofile: acme\n" });
    const run = (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
      runCli(["doctor", ...args], { cwd: opts.cwd, env: { CRAFTAR_HOME: home, ...opts.env } });
    return { root, home, ws, run };
  }

  it("exit 0 with warnings; 1 with an error; --strict turns a warning into exit 1", async () => {
    const s = await setup();
    const warn = s.run(["--workspace", s.ws]);
    expect(warn.code).toBe(0);
    expect(warn.stdout).toMatch(/\n {2}warn {3}lock {10}absent — never synced — craftar sync\n/);
    expect(warn.stdout).toMatch(/\nsummary: \d+ ok, 1 warn, 0 error\n$/);
    expect(s.run(["--workspace", s.ws, "--strict"]).code).toBe(1);
    await writeFiles(s.ws, { "craftar.yaml": "forge: ../nowhere\nprofile: acme\n" });
    const err = s.run(["--workspace", s.ws]);
    expect(err.code).toBe(1);
    expect(err.stdout).toMatch(/ error  config +Forge not found at /);
  });

  it("outside a workspace: machine checks only, exit 0; an explicit --workspace without craftar.yaml exits 1 on stderr, --json too", async () => {
    const s = await setup();
    const out = s.run([], { cwd: s.root });
    expect(out.code).toBe(0);
    expect(out.stdout.split("\n")[0]).toMatch(/· no workspace \(machine checks only\)$/);
    expect(out.stdout).not.toMatch(/ config /);
    for (const extra of [[], ["--json"]]) {
      const bad = s.run(["--workspace", s.root, ...extra]);
      expect(bad.code).toBe(1);
      expect(bad.stdout).toBe("");
      expect(bad.stderr).toContain(`no craftar.yaml in ${s.root} — run doctor inside a workspace, or without --workspace for the machine checks`);
    }
  });

  it("the current directory with craftar.yaml is checked without --workspace", async () => {
    const s = await setup();
    const r = s.run([], { cwd: s.ws });
    expect(r.stdout.split("\n")[0]).toContain(await fs.realpath(s.ws));
    expect(r.stdout).toMatch(/ ok {5}config /);
  });

  it("--json: the top-level keys and each check's keys in order, one entry per finding", async () => {
    const s = await setup();
    const j = JSON.parse(s.run(["--workspace", s.ws, "--json"]).stdout);
    expect(Object.keys(j)).toEqual(["version", "workspace", "fetch", "strict", "checks", "summary"]);
    expect(j).toMatchObject({ workspace: await fs.realpath(s.ws), fetch: false, strict: false });
    for (const c of j.checks) expect(Object.keys(c)).toEqual(["id", "scope", "level", "message", "fix"]);
    expect(j.checks.map((c: { id: string }) => c.id)).toEqual(["node", "git", "home", "registry", "cache", "config", "forge", "forge-inside", "plan", "params", "mcp-env", "lock", "registered"]);
    expect(Object.keys(j.summary)).toEqual(["ok", "warn", "error"]);
  });

  it("writes nothing: the workspace tree and the registry are byte-identical before and after", async () => {
    const s = await setup();
    expect(runCli(["sync", "--workspace", s.ws], { env: { CRAFTAR_HOME: s.home } }).code).toBe(0);
    const before = await snapshot(s.ws);
    const reg = await fs.readFile(path.join(s.home, "registry.json"), "utf8");
    expect(s.run(["--workspace", s.ws]).code).toBe(0);
    expect(await snapshot(s.ws)).toEqual(before);
    expect(await fs.readFile(path.join(s.home, "registry.json"), "utf8")).toBe(reg);
  });

  it("text: a message that already ends in its fix is not suffixed twice", async () => {
    const s = await setup();
    await writeFiles(s.home, { "registry.json": JSON.stringify({ schema: 9, workspaces: [] }) });
    const out = s.run([], { cwd: s.root }).stdout;
    expect(out).toMatch(/registry\.json declares schema 9, which this craftar does not read — upgrade craftar\n/);
    expect(out).not.toContain("upgrade craftar — upgrade craftar");
  });

  it("CRAFTAR_NO_REGISTRY: non-empty turns the registry off; empty still reads it", async () => {
    const s = await setup();
    await writeFiles(s.home, { "registry.json": JSON.stringify({ schema: 2, workspaces: [] }) });
    const line = (env: NodeJS.ProcessEnv) => JSON.parse(s.run(["--json"], { cwd: s.root, env }).stdout).checks.find((c: { id: string }) => c.id === "registry");
    expect(line({ CRAFTAR_NO_REGISTRY: "1" })).toMatchObject({ level: "ok", message: "off (CRAFTAR_NO_REGISTRY)" });
    expect(line({ CRAFTAR_NO_REGISTRY: "" })).toMatchObject({ level: "error", fix: "upgrade craftar" });
  });
});


describe("cli — forge impact (spec 25 §4.1)", () => {
  const SPEC = {
    ingredients: [rule("style", "# Style\n")],
    recipes: [recipe("base", ["rule/style"])],
    profiles: [profile("acme", ["base"]), profile("globex", ["base"])],
  };

  /** A temporary root with its own CRAFTAR_HOME, a path Forge, and workspaces made on demand. */
  async function setup() {
    const root = await tmpDir("craftar-forge-impact-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    const forge = path.join(root, "forge");
    await makeForge(forge, SPEC);
    const ws = async (name: string, profileName: string) => {
      const dir = path.join(root, name);
      await writeFiles(dir, { "craftar.yaml": `forge: ../forge\nprofile: ${profileName}\n` });
      return dir;
    };
    const run = (args: string[], env: NodeJS.ProcessEnv = {}) => runCli(args, { env: { CRAFTAR_HOME: home, ...env } });
    const registry = path.join(home, "registry.json");
    return { root, home, forge, ws, run, registry };
  }

  it("test 1: two path workspaces in sync", async () => {
    const s = await setup();
    const a = await s.ws("a", "acme");
    const b = await s.ws("b", "globex");
    expect(s.run(["sync", "--workspace", a]).code).toBe(0);
    expect(s.run(["sync", "--workspace", b]).code).toBe(0);
    const realA = await fs.realpath(a);
    const realB = await fs.realpath(b);
    const realForge = await fs.realpath(s.forge);

    const r = s.run(["forge", "impact", "--forge", s.forge]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");

    // Compute padding widths from literal paths
    const maxPath = Math.max(realA.length, realB.length);
    const maxProfile = Math.max("acme".length, "globex".length);
    const padA = realA.padEnd(maxPath);
    const padB = realB.padEnd(maxPath);
    const padAcme = "acme".padEnd(maxProfile);
    const padGlobex = "globex".padEnd(maxProfile);

    expect(r.stdout).toBe(
      `craftar forge impact — ${realForge} · 2 registered workspaces (2 by path)\n` +
      `  ${padA}  ${padAcme}  unchanged\n` +
      `  ${padB}  ${padGlobex}  unchanged\n`
    );
  });

  it("test 2: edit Forge rule → both lines show 1 update", async () => {
    const s = await setup();
    const a = await s.ws("a", "acme");
    const b = await s.ws("b", "globex");
    expect(s.run(["sync", "--workspace", a]).code).toBe(0);
    expect(s.run(["sync", "--workspace", b]).code).toBe(0);
    const realA = await fs.realpath(a);
    const realB = await fs.realpath(b);
    const realForge = await fs.realpath(s.forge);

    // Edit the Forge ingredient
    await fs.writeFile(path.join(s.forge, "ingredients/rules/style/rule.md"), "# Style!\n");

    const r = s.run(["forge", "impact", "--forge", s.forge]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");

    // Compute padding widths from literal paths
    const maxPath = Math.max(realA.length, realB.length);
    const maxProfile = Math.max("acme".length, "globex".length);
    const padA = realA.padEnd(maxPath);
    const padB = realB.padEnd(maxPath);
    const padAcme = "acme".padEnd(maxProfile);
    const padGlobex = "globex".padEnd(maxProfile);

    expect(r.stdout).toBe(
      `craftar forge impact — ${realForge} · 2 registered workspaces (2 by path)\n` +
      `  ${padA}  ${padAcme}  1 update\n` +
      `  ${padB}  ${padGlobex}  1 update\n`
    );
  });

  it("test 3: delete workspace → its line says missing; --json asserted whole", async () => {
    const s = await setup();
    const a = await s.ws("a", "acme");
    const b = await s.ws("b", "globex");
    expect(s.run(["sync", "--workspace", a]).code).toBe(0);
    expect(s.run(["sync", "--workspace", b]).code).toBe(0);
    const realA = await fs.realpath(a);
    const realB = await fs.realpath(b);
    const realForge = await fs.realpath(s.forge);

    // Delete workspace b
    await fs.rm(b, { recursive: true });

    const r = s.run(["forge", "impact", "--forge", s.forge]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("missing");

    const j = s.run(["forge", "impact", "--forge", s.forge, "--json"]);
    expect(j.code).toBe(0);
    expect(j.stderr).toBe("");
    const out = JSON.parse(j.stdout);
    expect(out).toEqual({
      forge: realForge,
      registry: "partial",
      workspaces: [
        { path: realA, profile: "acme", match: "path", via: null, ref: null, state: "unchanged", counts: {}, error: null },
        { path: realB, profile: "globex", match: "path", via: null, ref: null, state: "missing", counts: {}, error: null },
      ],
    });
  });

  it("test 4: break craftar.yaml → its line says error: <message>", async () => {
    const s = await setup();
    const a = await s.ws("a", "acme");
    expect(s.run(["sync", "--workspace", a]).code).toBe(0);
    const realA = await fs.realpath(a);
    const realForge = await fs.realpath(s.forge);

    // Break the craftar.yaml
    await fs.writeFile(path.join(a, "craftar.yaml"), "profile: [\n");

    const r = s.run(["forge", "impact", "--forge", s.forge]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    // Error message copied from a run: BAD_INDENT at line 2, column 1
    expect(r.stdout).toBe(
      `craftar forge impact — ${realForge} · 1 registered workspace (1 by path)\n` +
      `  ${realA}  acme  error: invalid craftar.yaml: BAD_INDENT at line 2, column 1\n`
    );
  });

  it("test 5: a remote workspace → after push (origin); with ref: main → pins main", async () => {
    const rf = await remoteForge(SPEC);
    cleanups.push(rf.cleanup);
    const root = await tmpDir("craftar-forge-impact-remote-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ${rf.url}\nprofile: acme\n` });

    const run = (args: string[]) => runCli(args, { env: { CRAFTAR_HOME: home } });
    expect(run(["sync", "--workspace", ws]).code).toBe(0);
    const realWs = await fs.realpath(ws);
    const realSrc = await fs.realpath(rf.src);

    const r = run(["forge", "impact", "--forge", rf.src]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      `craftar forge impact — ${realSrc} · 1 registered workspace (1 by remote)\n` +
      `  ${realWs}  acme  unchanged · after push (origin)\n`
    );

    // With ref: main → pins main
    await fs.writeFile(path.join(ws, "craftar.yaml"), `forge: ${rf.url}\nref: main\nprofile: acme\n`);
    expect(run(["sync", "--workspace", ws]).code).toBe(0);
    const r2 = run(["forge", "impact", "--forge", rf.src]);
    expect(r2.code).toBe(0);
    expect(r2.stderr).toBe("");
    expect(r2.stdout).toBe(
      `craftar forge impact — ${realSrc} · 1 registered workspace (1 by remote)\n` +
      `  ${realWs}  acme  unchanged · after push (origin), pins main\n`
    );
  });

  it("test 6: no registered workspace → specific message; CRAFTAR_NO_REGISTRY=1 → registry off message", async () => {
    const s = await setup();
    const realForge = await fs.realpath(s.forge);

    const r = s.run(["forge", "impact", "--forge", s.forge]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      `craftar forge impact — ${realForge}\n` +
      `  no registered workspace reads this Forge on this machine\n`
    );

    const off = s.run(["forge", "impact", "--forge", s.forge], { CRAFTAR_NO_REGISTRY: "1" });
    expect(off.code).toBe(0);
    expect(off.stderr).toBe("");
    expect(off.stdout).toBe(
      `craftar forge impact — ${realForge}\n` +
      `  the registry is off (CRAFTAR_NO_REGISTRY)\n`
    );
  });

  it("test 7: unreadable registry → code 1, stdout empty, stderr error message", async () => {
    const s = await setup();
    await fs.mkdir(s.home, { recursive: true });
    await fs.writeFile(s.registry, "not json\n");

    const r = s.run(["forge", "impact", "--forge", s.forge]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    // The error comes from readRegistry which includes the JSON.parse error
    expect(r.stderr).toBe(`error: cannot read ${s.registry}: Unexpected token 'o', \"not json\n\" is not valid JSON\n`);
  });

  it("test 8: --workspace with remote Forge → code 1, exact error message", async () => {
    const rf = await remoteForge(SPEC);
    cleanups.push(rf.cleanup);
    const root = await tmpDir("craftar-forge-impact-remote-ws-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ${rf.url}\nprofile: acme\n` });

    const r = runCli(["forge", "impact", "--workspace", ws], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`error: the Forge of this workspace is remote (${rf.url}) — clone it and pass --forge <dir>\n`);
  });

  it("test 9: writes nothing — snapshot before/after unchanged", async () => {
    const s = await setup();
    const a = await s.ws("a", "acme");
    const b = await s.ws("b", "globex");
    expect(s.run(["sync", "--workspace", a]).code).toBe(0);
    expect(s.run(["sync", "--workspace", b]).code).toBe(0);

    const beforeA = await snapshot(a);
    const beforeB = await snapshot(b);
    const beforeForge = await snapshot(s.forge);
    const beforeHome = await snapshot(s.home);

    expect(s.run(["forge", "impact", "--forge", s.forge]).code).toBe(0);
    expect(s.run(["forge", "impact", "--forge", s.forge, "--json"]).code).toBe(0);

    expect(await snapshot(a)).toEqual(beforeA);
    expect(await snapshot(b)).toEqual(beforeB);
    expect(await snapshot(s.forge)).toEqual(beforeForge);
    expect(await snapshot(s.home)).toEqual(beforeHome);
  });
});

describe("cli — forge unify impact (spec 25 §4.2–§4.3)", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  /**
   * Fixture: temp root with Forge containing rules wf (base), wf--acme (variant), and other;
   * recipes base=[rule/wf--acme] and other=[rule/other]; profiles acme=[base] and globex=[other].
   * Workspaces a/ (acme) and g/ (globex) created and synced on demand.
   */
  async function setup() {
    const root = await tmpDir("craftar-forge-unify-impact-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    await makeForge(forge, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" }), rule("other", "o\n")],
      recipes: [recipe("base", ["rule/wf--acme"]), recipe("other", ["rule/other"])],
      profiles: [profile("acme", ["base"]), profile("globex", ["other"])],
    });
    gitInit(forge);
    gitCommitAll(forge, "init");

    const wsA = path.join(root, "a");
    const wsG = path.join(root, "g");
    await writeFiles(wsA, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    await writeFiles(wsG, { "craftar.yaml": `forge: ../forge\nprofile: globex\n` });

    const env = { CRAFTAR_HOME: home };
    const run = (args: string[], e: NodeJS.ProcessEnv = {}) => runCli(args, { env: { ...env, ...e } });

    // Sync both workspaces to register them
    expect(run(["sync", "--workspace", wsA]).code).toBe(0);
    expect(run(["sync", "--workspace", wsG]).code).toBe(0);

    return { root, forge, home, wsA, wsG, env, run };
  }

  it("test 1: impact lines — unify --take base → stdout ends with impact lines, no next: line, no removed-variant warning (registry read, no one disables)", async () => {
    const s = await setup();
    const realA = await fs.realpath(s.wsA);
    const realG = await fs.realpath(s.wsG);

    // Unify wf base <- wf--acme with --take base: changes acme's .claude/rules/wf.md from b to a, globex unchanged
    const r = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge]);
    expect(r.code, r.stderr).toBe(0);

    // Build expected stdout: header, file touch, resolved, impact lines, no next: line, no warnings
    expect(r.stdout).toContain(`  impact: ${realA} (acme) 1 file changes — .claude/rules/wf.md\n`);
    expect(r.stdout).toContain(`  impact: ${realG} (globex) no effect\n`);
    // No next: line when at least one workspace was checked
    expect(r.stdout).not.toContain("next:");
    // No removed-variant warning (none concerned, registry read)
    expect(r.stdout).not.toContain("was removed");
  });

  it("test 2: --json: impact array with correct shape", async () => {
    const s = await setup();
    const realA = await fs.realpath(s.wsA);
    const realG = await fs.realpath(s.wsG);

    const r = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);

    expect(out.impact).toEqual([
      { path: realA, profile: "acme", match: "path", via: null, ref: null, state: "changed", files: [".claude/rules/wf.md"], error: null },
      { path: realG, profile: "globex", match: "path", via: null, ref: null, state: "no-effect", files: [], error: null },
    ]);
    expect(out.warnings).toEqual([]);
  });

  it("test 3: --no-impact: today's output with removed-variant warning, next: hint, impact: []", async () => {
    const s = await setup();

    // Run with --no-impact
    const r = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge, "--no-impact"]);
    expect(r.code, r.stderr).toBe(0);

    // Has the removed-variant warning with old text ending "; unify cannot reach workspaces" (no suffix, because --no-impact)
    expect(r.stdout).toContain(
      "rule/wf--acme was removed — a workspace that disables it in overrides.ingredients.disable (craftar.yaml or craftar.local.yaml) " +
        "must now name rule/wf, or the base comes back enabled; unify cannot reach workspaces\n",
    );
    // Has the next: hint
    expect(r.stdout).toContain("next: run `craftar status --workspace <dir>` in a workspace on profile acme to see what moved");
    // No impact lines
    expect(r.stdout).not.toContain("impact:");

    // --json shows impact: []
    // Need fresh Forge setup for JSON test
    const s2 = await setup();
    const j = s2.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s2.forge, "--no-impact", "--json"]);
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);
    expect(out.impact).toEqual([]);
  });

  it("test 4: unreadable registry → unify exits 0, warning about registry, removed-variant warning with registry suffix, impact: [], next: hint", async () => {
    const s = await setup();
    // Break the registry
    await fs.mkdir(s.home, { recursive: true });
    const registryPath = path.join(s.home, "registry.json");
    await fs.writeFile(registryPath, "not json\n");

    const r = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge]);
    expect(r.code, r.stderr).toBe(0);

    // Warning about registry unreadable (copy error message from output)
    expect(r.stdout).toContain("the registry could not be read");
    expect(r.stdout).toContain("no workspace was checked");

    // Removed-variant warning ends with "(the registry could not be read)"
    expect(r.stdout).toContain(
      "rule/wf--acme was removed — a workspace that disables it in overrides.ingredients.disable (craftar.yaml or craftar.local.yaml) " +
        "must now name rule/wf, or the base comes back enabled; unify cannot reach workspaces (the registry could not be read)",
    );

    // Has the next: hint
    expect(r.stdout).toContain("next:");

    // --json shows impact: []
    const s2 = await setup();
    await fs.mkdir(s2.home, { recursive: true });
    await fs.writeFile(path.join(s2.home, "registry.json"), "not json\n");
    const j = s2.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s2.forge, "--json"]);
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);
    expect(out.impact).toEqual([]);
  });

  it("test 5: workspace config does not load → its impact entry is error, unify exits 0", async () => {
    const s = await setup();
    const realA = await fs.realpath(s.wsA);

    // Break g's craftar.yaml
    await fs.writeFile(path.join(s.wsG, "craftar.yaml"), "profile: [\n");

    const j = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge, "--json"]);
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // wsA should be changed, wsG should be error
    expect(out.impact[0]).toEqual({
      path: realA,
      profile: "acme",
      match: "path",
      via: null,
      ref: null,
      state: "changed",
      files: [".claude/rules/wf.md"],
      error: null,
    });
    expect(out.impact[1].state).toBe("error");
    expect(out.impact[1].error).toContain("invalid craftar.yaml");

    // The removed-variant warning should end with "(the registry could not check 1 workspace)"
    expect(out.warnings[0]).toContain("(the registry could not check 1 workspace)");
  });

  it("test 6: conditional warnings, removed variant — workspace disables it → named in concerned", async () => {
    const s = await setup();
    const realG = await fs.realpath(s.wsG);

    // Add overrides.ingredients.disable to g's craftar.yaml
    await fs.writeFile(
      path.join(s.wsG, "craftar.yaml"),
      `forge: ../forge\nprofile: globex\noverrides:\n  ingredients:\n    disable:\n      - rule/wf--acme\n`,
    );
    // Re-sync to update the registration (not necessary for the test, but keeps registry consistent)
    expect(s.run(["sync", "--workspace", s.wsG]).code).toBe(0);

    const j = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge, "--json"]);
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // Warning should name the concerned workspace
    expect(out.warnings[0]).toEqual(
      "rule/wf--acme was removed — a workspace that disables it in overrides.ingredients.disable (craftar.yaml or craftar.local.yaml) " +
        `must now name rule/wf, or the base comes back enabled — concerned: ${realG} (craftar.yaml)`,
    );
  });

  it("test 6b: conditional warnings, removed variant — in craftar.local.yaml → named with (craftar.local.yaml)", async () => {
    const s = await setup();
    const realA = await fs.realpath(s.wsA);

    // Add overrides.ingredients.disable to a's craftar.local.yaml
    await fs.writeFile(
      path.join(s.wsA, "craftar.local.yaml"),
      `overrides:\n  ingredients:\n    disable:\n      - rule/wf--acme\n`,
    );

    const j = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge, "--json"]);
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // Warning should name the concerned workspace with (craftar.local.yaml)
    expect(out.warnings[0]).toEqual(
      "rule/wf--acme was removed — a workspace that disables it in overrides.ingredients.disable (craftar.yaml or craftar.local.yaml) " +
        `must now name rule/wf, or the base comes back enabled — concerned: ${realA} (craftar.local.yaml)`,
    );
  });

  it("test 6c: concerned plus one missing workspace → warning includes unchecked count", async () => {
    const s = await setup();
    const realG = await fs.realpath(s.wsG);

    // Create and sync a third workspace, then delete it
    const wsM = path.join(s.root, "m");
    await writeFiles(wsM, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    expect(s.run(["sync", "--workspace", wsM]).code).toBe(0);
    await fs.rm(wsM, { recursive: true });

    // Add overrides.ingredients.disable to g's craftar.yaml
    await fs.writeFile(
      path.join(s.wsG, "craftar.yaml"),
      `forge: ../forge\nprofile: globex\noverrides:\n  ingredients:\n    disable:\n      - rule/wf--acme\n`,
    );
    expect(s.run(["sync", "--workspace", s.wsG]).code).toBe(0);

    const j = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge, "--json"]);
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // Warning should name concerned and mention unchecked
    expect(out.warnings[0]).toEqual(
      "rule/wf--acme was removed — a workspace that disables it in overrides.ingredients.disable (craftar.yaml or craftar.local.yaml) " +
        `must now name rule/wf, or the base comes back enabled — concerned: ${realG} (craftar.yaml) (the registry could not check 1 workspace)`,
    );
  });

  it("test 7: none concerned + missing → warning with unchecked suffix; no registered workspace → none suffix; registry off → off suffix", async () => {
    // Test 7a: missing workspace → unchecked suffix
    const s = await setup();

    // Create and sync a third workspace, then delete it (no one disables the variant)
    const wsM = path.join(s.root, "m");
    await writeFiles(wsM, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    expect(s.run(["sync", "--workspace", wsM]).code).toBe(0);
    await fs.rm(wsM, { recursive: true });

    const j = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge, "--json"]);
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // None concerned, partial state → warning with unchecked suffix
    expect(out.warnings[0]).toEqual(
      "rule/wf--acme was removed — a workspace that disables it in overrides.ingredients.disable (craftar.yaml or craftar.local.yaml) " +
        "must now name rule/wf, or the base comes back enabled; unify cannot reach workspaces (the registry could not check 1 workspace)",
    );
  });

  it("test 7b: no registered workspace → none suffix", async () => {
    // Fresh setup with empty home
    const root = await tmpDir("craftar-forge-unify-impact-empty-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    await makeForge(forge, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
      recipes: [recipe("base", ["rule/wf--acme"])],
      profiles: [profile("acme", ["base"])],
    });
    gitInit(forge);
    gitCommitAll(forge, "init");

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", forge, "--json"], { env: { CRAFTAR_HOME: home } });
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);

    // No registered workspace → warning with none suffix
    expect(out.warnings[0]).toEqual(
      "rule/wf--acme was removed — a workspace that disables it in overrides.ingredients.disable (craftar.yaml or craftar.local.yaml) " +
        "must now name rule/wf, or the base comes back enabled; unify cannot reach workspaces (no workspace of this Forge is registered on this machine)",
    );
  });

  it("test 7c: CRAFTAR_NO_REGISTRY=1 → registry off suffix", async () => {
    const s = await setup();

    const r = s.run(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", s.forge, "--json"], { CRAFTAR_NO_REGISTRY: "1" });
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);

    // Registry off → warning with off suffix
    expect(out.warnings[0]).toEqual(
      "rule/wf--acme was removed — a workspace that disables it in overrides.ingredients.disable (craftar.yaml or craftar.local.yaml) " +
        "must now name rule/wf, or the base comes back enabled; unify cannot reach workspaces (the registry is off)",
    );
  });

  it("test 8a: W1 (param) — workspace with overrides.params → concerned", async () => {
    // This test requires take: param. Use the same forge shape as the spec 09 tests.
    const root = await tmpDir("craftar-forge-unify-param-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    await makeForge(forge, {
      ingredients: [rule("deploy", "use globex-api\n"), rule("deploy--acme", "use acme-api\n", { as: "deploy" })],
      recipes: [recipe("base", ["rule/deploy--acme"])],
      profiles: [profile("acme", ["base"])],
    });
    gitInit(forge);
    gitCommitAll(forge, "init");

    // Create a workspace with overrides.params.deploy.api
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\noverrides:\n  params:\n    deploy.api: test\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);
    const realWs = await fs.realpath(ws);

    // Save a plan and apply it with take: param
    const planDir = await tmpDir("craftar-plan-");
    cleanups.push(() => fs.rm(planDir, { recursive: true, force: true }));
    const planPath = path.join(planDir, "plan.yaml");
    expect(runCli(["forge", "unify", "rule/deploy", "--profile", "acme", "--save-plan", planPath, "--forge", forge], { env }).code).toBe(0);

    const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
    // The hunk's pre-filled params should have globex-api → key
    Object.assign(plan.files[0].hunks[0], { take: "param", params: [{ token: "globex-api", key: "deploy.api" }] });
    const editedPath = path.join(planDir, "edited.yaml");
    await fs.writeFile(editedPath, YAML.stringify(plan));

    const j = runCli(["forge", "unify", "rule/deploy", "--profile", "acme", "--plan", editedPath, "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // W1 warning should name the concerned workspace — whole string assertion
    const w1Warning = out.warnings.find((w: string) => w.includes("is now a parameter of"));
    expect(w1Warning).toEqual(
      `deploy.api is now a parameter of rule/deploy — a workspace that sets overrides.params.deploy.api (craftar.yaml or ` +
        `craftar.local.yaml) now overrides rule/deploy too — concerned: ${realWs} (craftar.yaml)`,
    );
  });

  it("test 8b: W1 (param) — none concerned with registry read → no W1 warning", async () => {
    const root = await tmpDir("craftar-forge-unify-param-none-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    await makeForge(forge, {
      ingredients: [rule("deploy", "use globex-api\n"), rule("deploy--acme", "use acme-api\n", { as: "deploy" })],
      recipes: [recipe("base", ["rule/deploy--acme"])],
      profiles: [profile("acme", ["base"])],
    });
    gitInit(forge);
    gitCommitAll(forge, "init");

    // Create a workspace without overrides.params.deploy.api
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    // Save and modify a plan for take: param
    const planDir = await tmpDir("craftar-plan-");
    cleanups.push(() => fs.rm(planDir, { recursive: true, force: true }));
    const planPath = path.join(planDir, "plan.yaml");
    expect(runCli(["forge", "unify", "rule/deploy", "--profile", "acme", "--save-plan", planPath, "--forge", forge], { env }).code).toBe(0);

    const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
    Object.assign(plan.files[0].hunks[0], { take: "param", params: [{ token: "globex-api", key: "deploy.api" }] });
    const editedPath = path.join(planDir, "edited.yaml");
    await fs.writeFile(editedPath, YAML.stringify(plan));

    const j = runCli(["forge", "unify", "rule/deploy", "--profile", "acme", "--plan", editedPath, "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // No W1 warning (none concerned, registry read)
    const w1Warning = out.warnings.find((w: string) => w.includes("is now a parameter of"));
    expect(w1Warning).toBeUndefined();
  });

  it("test 8c: W3 (section) — (a) workspace with overrides.sections → concerned, (b) without → no warning", async () => {
    // Inline the sectionForge fixture: rule/review-posture, variant --acme, section flavors
    const baseBody = "# Review posture\n\nDispatch reviewers.\n\nshared line\n";
    const variantBody = "# Review posture\n\nDispatch reviewers.\n\n| Repo | Reviewer |\n|---|---|\n| `acme-api` | backend |\n\nshared line\n";

    // Case (a): workspace with overrides.sections → W3 warning names the concerned workspace
    {
      const root = await tmpDir("craftar-forge-unify-section-a-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forge = path.join(root, "forge");
      const homeDir = path.join(root, "home");
      await makeForge(forge, {
        ingredients: [
          rule("review-posture", baseBody),
          rule("review-posture--acme", variantBody, { as: "review-posture" }),
        ],
        recipes: [recipe("base", ["rule/review-posture"]), recipe("base--acme", ["rule/review-posture--acme"])],
        profiles: [profile("acme", ["base--acme"])],
      });
      gitInit(forge);
      gitCommitAll(forge, "init");

      const ws = path.join(root, "ws");
      await writeFiles(ws, {
        "craftar.yaml": `forge: ../forge\nprofile: acme\noverrides:\n  sections:\n    rule/review-posture:\n      flavors: override content\n`,
      });
      const env = { CRAFTAR_HOME: homeDir };
      expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);
      const realWs = await fs.realpath(ws);

      // Save and edit plan for take: section
      const planDir = path.join(root, "plan");
      await fs.mkdir(planDir, { recursive: true });
      const planPath = path.join(planDir, "plan.yaml");
      expect(runCli(["forge", "unify", "rule/review-posture", "--profile", "acme", "--save-plan", planPath, "--forge", forge]).code).toBe(0);
      const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
      plan.files[0].hunks[0].take = "section";
      plan.files[0].hunks[0].section = { name: "flavors" };
      const editedPath = path.join(planDir, "edited.yaml");
      await fs.writeFile(editedPath, YAML.stringify(plan));

      const j = runCli(["forge", "unify", "rule/review-posture", "--profile", "acme", "--plan", editedPath, "--forge", forge, "--json"], { env });
      expect(j.code, j.stderr).toBe(0);
      const out = JSON.parse(j.stdout);

      // W3 warning should name the concerned workspace — whole string assertion
      const w3Warning = out.warnings.find((w: string) => w.includes("is now a section of"));
      expect(w3Warning).toEqual(
        `flavors is now a section of rule/review-posture — a workspace that sets overrides.sections.rule/review-posture.flavors (craftar.yaml or ` +
          `craftar.local.yaml) now applies there — concerned: ${realWs} (craftar.yaml)`,
      );
    }

    // Case (b): workspace without the section override → no W3 warning, but sections were created
    {
      const root = await tmpDir("craftar-forge-unify-section-b-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forge = path.join(root, "forge");
      const homeDir = path.join(root, "home");
      await makeForge(forge, {
        ingredients: [
          rule("review-posture", baseBody),
          rule("review-posture--acme", variantBody, { as: "review-posture" }),
        ],
        recipes: [recipe("base", ["rule/review-posture"]), recipe("base--acme", ["rule/review-posture--acme"])],
        profiles: [profile("acme", ["base--acme"])],
      });
      gitInit(forge);
      gitCommitAll(forge, "init");

      const ws = path.join(root, "ws");
      await writeFiles(ws, {
        "craftar.yaml": `forge: ../forge\nprofile: acme\n`,
      });
      const env = { CRAFTAR_HOME: homeDir };
      expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

      // Save and edit plan for take: section
      const planDir = path.join(root, "plan");
      await fs.mkdir(planDir, { recursive: true });
      const planPath = path.join(planDir, "plan.yaml");
      expect(runCli(["forge", "unify", "rule/review-posture", "--profile", "acme", "--save-plan", planPath, "--forge", forge]).code).toBe(0);
      const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
      plan.files[0].hunks[0].take = "section";
      plan.files[0].hunks[0].section = { name: "flavors" };
      const editedPath = path.join(planDir, "edited.yaml");
      await fs.writeFile(editedPath, YAML.stringify(plan));

      const j = runCli(["forge", "unify", "rule/review-posture", "--profile", "acme", "--plan", editedPath, "--forge", forge, "--json"], { env });
      expect(j.code, j.stderr).toBe(0);
      const out = JSON.parse(j.stdout);

      // No W3 warning (none concerned, registry read)
      const w3Warning = out.warnings.find((w: string) => w.startsWith("flavors is now a section of"));
      expect(w3Warning).toBeUndefined();

      // But sections array should have the created section with written: true
      expect(out.sections.length).toBe(1);
      expect(out.sections[0].written).toBe(true);
    }
  });
});

describe("cli — forge unify --prune-recipes (spec 25 §4.4)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn().catch(() => {});
  });

  // Fixture: Forge with base variant that can be unified to match its sibling
  async function pruneFixture() {
    const root = await tmpDir("craftar-prune-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    // Base and variant with identical content after --take base
    await makeForge(forge, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
      recipes: [recipe("base", ["rule/wf"]), recipe("base--acme", ["rule/wf--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });
    gitInit(forge);
    gitCommitAll(forge, "init");

    return { root, forge, home };
  }

  it("test 1: proven prune — recipe file deleted, profile repointed, every plan identical", async () => {
    const { root, forge, home } = await pruneFixture();
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // Recipe file should be gone
    expect(await exists(path.join(forge, "recipes/base--acme.yaml"))).toBe(false);

    // Profile should be repointed
    const profileText = await fs.readFile(path.join(forge, "profiles/acme/profile.yaml"), "utf8");
    expect(profileText).toContain("recipes:\n  - base\n");
    expect(profileText).not.toContain("base--acme");

    // JSON output
    expect(out.recipes).toEqual({
      rewritten: ["base--acme"],
      identicalToSibling: ["base--acme"],
      pruned: [{ recipe: "base--acme", sibling: "base", profiles: ["profiles/acme/profile.yaml"] }],
      kept: [],
    });

    // Warning about coverage
    expect(out.warnings).toEqual([
      "pruned against the 1 workspace registered on this machine — a workspace synced elsewhere (CI, another machine, CRAFTAR_NO_REGISTRY) is not covered",
    ]);

    // Next sync should update the file (because the base has "a" not "b")
    const status = runCli(["status", "--workspace", ws, "--json"], { env });
    expect(status.code, status.stderr).toBe(0);
    const statuses = JSON.parse(status.stdout).statuses;
    const fileUpdate = statuses.find((s: { path: string }) => s.path === ".claude/rules/wf.md");
    expect(fileUpdate.path).toBe(".claude/rules/wf.md");
    expect(fileUpdate.state).toBe("update");
  });

  it("test 2: text mode of test 1 — stdout includes pruned recipe line", async () => {
    const { root, forge, home } = await pruneFixture();
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge], { env });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("  pruned recipe base--acme → base (profiles/acme/profile.yaml)");
  });

  it("test 3: refused — extends — a recipe extends the candidate", async () => {
    const { root, forge, home } = await pruneFixture();
    // Add a recipe that extends base--acme
    await writeFiles(forge, {
      "recipes/stack.yaml": `name: stack\nextends: [base--acme]\ningredients: []\n`,
    });
    gitCommitAll(forge, "add stack");

    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    expect(out.recipes.kept).toEqual([{ recipe: "base--acme", reason: "recipe stack extends it" }]);
    expect(out.recipes.pruned).toEqual([]);

    // Recipe file should still exist
    expect(await exists(path.join(forge, "recipes/base--acme.yaml"))).toBe(true);
  });

  it("test 4: refused — recipes.add in craftar.yaml names the candidate", async () => {
    const { root, forge, home } = await pruneFixture();
    const ws = path.join(root, "ws");
    // Add the candidate to recipes.add
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - base--acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);
    const realWs = await fs.realpath(ws);

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    expect(out.recipes.kept).toEqual([{ recipe: "base--acme", reason: `${realWs} names it in recipes.add (craftar.yaml)` }]);
    expect(out.recipes.pruned).toEqual([]);
  });

  it("test 4b: refused — recipes.remove in craftar.local.yaml names the candidate", async () => {
    const { root, forge, home } = await pruneFixture();
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);
    const realWs = await fs.realpath(ws);

    // Add the candidate to recipes.remove in local file
    await writeFiles(ws, { "craftar.local.yaml": `recipes:\n  remove:\n    - base--acme\n` });

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    expect(out.recipes.kept).toEqual([{ recipe: "base--acme", reason: `${realWs} names it in recipes.remove (craftar.local.yaml)` }]);
  });

  it("test 5: refused — the proof fails because a param default would move", async () => {
    const root = await tmpDir("craftar-prune-param-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    // Fixture: base and base--acme with a variant, plus recipe p between them with different param.
    // Profile: [base--acme, p, base] — removing base--acme means p becomes last-wins for tone.
    // The proof should fail because after editing, the workspace's plan differs.
    await makeForge(forge, {
      ingredients: [
        rule("wf", "tone is {{tone}}\n"),
        rule("wf--acme", "tone is {{tone}}\n", { as: "wf" }),
      ],
      recipes: [
        recipe("base", ["rule/wf"], { params: { tone: { default: "base" } } }),
        recipe("base--acme", ["rule/wf--acme"], { params: { tone: { default: "base" } } }),
        recipe("p", [], { params: { tone: { default: "p" } } }),
      ],
      profiles: [profile("acme", ["base--acme", "p", "base"])],
    });
    gitInit(forge);
    gitCommitAll(forge, "init");

    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);
    const realWs = await fs.realpath(ws);

    // Currently: [base--acme, p, base] → last wins is "base" (from recipe base).
    // After prune (remove base--acme): [base, p] → last wins is "p".
    // So the file would change from "tone is base\n" to "tone is p\n".
    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // The prune should be refused because after removing base--acme, the param order changes
    expect(out.recipes.kept.length).toBe(1);
    expect(out.recipes.kept[0].recipe).toBe("base--acme");
    expect(out.recipes.kept[0].reason).toBe(`${realWs}: .claude/rules/wf.md would change`);
  });

  it("test 6: refused — no registered workspace", async () => {
    const { root, forge } = await pruneFixture();
    // Use a fresh home with no registry
    const freshHome = path.join(root, "fresh-home");
    await fs.mkdir(freshHome, { recursive: true });
    const env = { CRAFTAR_HOME: freshHome };

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    expect(out.recipes.kept).toEqual([{ recipe: "base--acme", reason: "no workspace of this Forge is registered on this machine" }]);
  });

  it("test 6b: refused — workspace plan throws", async () => {
    const { root, forge, home } = await pruneFixture();
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    // Make the workspace's plan throw by breaking the YAML syntax
    await fs.writeFile(path.join(ws, "craftar.yaml"), "forge: ../forge\nprofile: {{invalid\n");

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // Should be kept with an error message about unchecked workspaces
    expect(out.recipes.kept.length).toBe(1);
    expect(out.recipes.kept[0].recipe).toBe("base--acme");
    expect(out.recipes.kept[0].reason).toBe("the registry could not check 1 workspace");
  });

  it("test 7: profile list shapes — sibling after suffixed", async () => {
    const root = await tmpDir("craftar-prune-shape-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    // Profile: [base--acme, x, base] → [base, x]
    await makeForge(forge, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
      recipes: [
        recipe("base", ["rule/wf"]),
        recipe("base--acme", ["rule/wf--acme"]),
        recipe("x", []),
      ],
      profiles: [profile("acme", ["base--acme", "x", "base"])],
    });
    gitInit(forge);
    gitCommitAll(forge, "init");

    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    expect(out.recipes.pruned.length).toBe(1);
    const profileText = await fs.readFile(path.join(forge, "profiles/acme/profile.yaml"), "utf8");
    expect(profileText).toContain("recipes:\n  - base\n  - x\n");
  });

  it("test 7b: profile list shapes — sibling before suffixed", async () => {
    const root = await tmpDir("craftar-prune-shape-before-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    // Profile: [base, x, base--acme] → [base, x]
    await makeForge(forge, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
      recipes: [
        recipe("base", ["rule/wf"]),
        recipe("base--acme", ["rule/wf--acme"]),
        recipe("x", []),
      ],
      profiles: [profile("acme", ["base", "x", "base--acme"])],
    });
    gitInit(forge);
    gitCommitAll(forge, "init");

    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    expect(out.recipes.pruned.length).toBe(1);
    const profileText = await fs.readFile(path.join(forge, "profiles/acme/profile.yaml"), "utf8");
    expect(profileText).toContain("recipes:\n  - base\n  - x\n");
  });

  it("test 8: a candidate whose profile unify also edits for take: param — both edits land", async () => {
    const root = await tmpDir("craftar-prune-param-edit-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    // Fixture with a param hunk
    await makeForge(forge, {
      ingredients: [rule("deploy", "use globex-api\n"), rule("deploy--acme", "use acme-api\n", { as: "deploy" })],
      recipes: [recipe("base", ["rule/deploy"]), recipe("base--acme", ["rule/deploy--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });
    gitInit(forge);
    gitCommitAll(forge, "init");

    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    // Save and apply a plan with take: param
    const planDir = path.join(root, "plan");
    await fs.mkdir(planDir, { recursive: true });
    const planPath = path.join(planDir, "plan.yaml");
    expect(runCli(["forge", "unify", "rule/deploy", "--profile", "acme", "--save-plan", planPath, "--forge", forge], { env }).code).toBe(0);

    const plan = YAML.parse(await fs.readFile(planPath, "utf8"));
    Object.assign(plan.files[0].hunks[0], { take: "param", params: [{ token: "globex-api", key: "deploy.api" }] });
    const editedPath = path.join(planDir, "edited.yaml");
    await fs.writeFile(editedPath, YAML.stringify(plan));

    const j = runCli(["forge", "unify", "rule/deploy", "--profile", "acme", "--plan", editedPath, "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    // Both edits should land: param extraction AND prune
    expect(out.params.length).toBe(1);
    expect(out.params[0].key).toBe("deploy.api");
    expect(out.recipes.pruned.length).toBe(1);

    // Profile should have both the param AND the repointed recipe
    const profileText = await fs.readFile(path.join(forge, "profiles/acme/profile.yaml"), "utf8");
    expect(profileText).toContain("deploy.api: acme-api");
    expect(profileText).toContain("recipes:\n  - base\n");
    expect(profileText).not.toContain("base--acme");
  });

  it("test 9: --prune-recipes --no-impact is refused before anything is read", async () => {
    const root = await tmpDir("craftar-prune-noimpact-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");

    await makeForge(forge, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
      recipes: [recipe("base", ["rule/wf"]), recipe("base--acme", ["rule/wf--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });
    gitInit(forge);
    gitCommitAll(forge, "init");

    // Snapshot the Forge before
    const forgeBefore = await snapshot(forge);

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--no-impact", "--forge", forge]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("error: --prune-recipes needs the impact passes — drop --no-impact\n");

    // Forge should be unchanged
    const forgeAfter = await snapshot(forge);
    expect(forgeAfter).toEqual(forgeBefore);
  });

  it("test 10: a profile file git does not hold refuses the whole unify before any write", async () => {
    const root = await tmpDir("craftar-prune-unheld-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const home = path.join(root, "home");

    // Forge with acme profile that uses base--acme
    await makeForge(forge, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })],
      recipes: [recipe("base", ["rule/wf"]), recipe("base--acme", ["rule/wf--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });
    gitInit(forge);
    // Add the profile directory to .gitignore BEFORE committing
    await fs.writeFile(path.join(forge, ".gitignore"), "profiles/acme/\n");
    gitCommitAll(forge, "init");
    // Now the profile exists but is ignored by git

    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    // Snapshot
    const forgeBefore = await snapshot(forge);

    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--prune-recipes", "--forge", forge, "--json"], { env });
    expect(r.code).toBe(1);
    // Should report the profile is not held by git
    expect(r.stderr).toContain("unify can only change files git can restore");

    // Forge unchanged
    const forgeAfter = await snapshot(forge);
    expect(forgeAfter).toEqual(forgeBefore);
  });

  it("test 11: without --prune-recipes the identical-to-sibling warning ends with the prune hint", async () => {
    const { root, forge, home } = await pruneFixture();
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ../forge\nprofile: acme\n` });
    const env = { CRAFTAR_HOME: home };
    expect(runCli(["sync", "--workspace", ws], { env }).code).toBe(0);

    // Without --prune-recipes
    const j = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--take", "base", "--forge", forge, "--json"], { env });
    expect(j.code, j.stderr).toBe(0);
    const out = JSON.parse(j.stdout);

    const warning = out.warnings.find((w: string) => w.includes("recipe base--acme is now identical to base"));
    expect(warning).toContain("— or restore the Forge with git and rerun this unify with --prune-recipes");
  });
});
