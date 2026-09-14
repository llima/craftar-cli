import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { profile, recipe, rule, scenario, tmpDir, writeFiles } from "./helpers/forge.js";
import { runCli } from "./helpers/cli.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

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
});
