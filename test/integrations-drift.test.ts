import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runCli } from "./helpers/cli.js";
import { driftList } from "../src/core/drift.js";
import type { FileStatus } from "../src/core/sync.js";
import { hashNormalized } from "../src/core/text.js";
import { profile, recipe, rule, writeFiles, type ForgeSpec, type WorkspaceSpec } from "./helpers/forge.js";
import { ado, forgeAt, mcp, PM, snapshot, states, sync, STORIES } from "./helpers/integrations.js";

// Spec 33 step 33i: drift × the integrations block.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Git environment variables for predictable commits. */
const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "craftar-test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "craftar-test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
});

/** Initialize a git repo with one commit. */
function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "maintenance.auto", "false"]);
  execFileSync("git", ["-C", dir, "config", "gc.auto", "0"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"], { env: gitEnv() });
}

/** Git porcelain output for the Forge. */
const porcelain = (dir: string) => execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });

describe("promote renders with the effective profile's params", () => {
  it("1. a rule citing an integration param, hand-edited elsewhere, is compared as rendered", async () => {
    // Build the spec by hand: forgeAt(3, ado()) with rule("where", "Org {{integrations.pm.org}}\nline two\n") in place of the helper's where
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\nline two\n"),
        rule("stories-azure-devops", STORIES),
        mcp("azure-devops", { command: "npx", args: ["-y", "ado-mcp"] }),
      ],
      recipes: [
        recipe("base", ["rule/workflow", "rule/where"]),
        recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops"], { slot: "pm" }),
      ],
      profiles: [profile("acme", ["base"], ["claude-code", "kiro"], { integrations: PM })],
    };
    const s = await forgeAt(3, spec);
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });
    
    // Sync the workspace
    await sync(s.wsRoot);
    gitInit(s.forgeRoot);
    
    // Edit the file elsewhere (not in the org line)
    await fs.writeFile(path.join(s.wsRoot, ".claude/rules/where.md"), "Org acme\nline two, by hand\n");
    
    // Run drift promote --dry-run --json
    const r = runCli(["drift", "promote", ".claude/rules/where.md", "--workspace", s.wsRoot, "--dry-run", "--json"], { env });
    
    // The JSON output (pinned after commit 1)
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    
    // After commit 1, the outcome is variant. The base was rendered with the effective params,
    // so the comparison is: "Org acme\nline two\n" vs "Org acme\nline two, by hand\n".
    // The difference is in line 2, not in the param, so it's a variant.
    // The flattened params show what the base cited.
    expect(j.outcome).toBe("variant");
    expect(j.promoted).toBe("rule/where--acme");
    expect(j.flattened.params).toEqual(["integrations.pm.org"]);
    
    // The key assertions: written files include the variant
    expect(j.written).toEqual([
      { path: "ingredients/rules/where--acme/ingredient.yaml", action: "created" },
      { path: "ingredients/rules/where--acme/rule.md", action: "created" },
      { path: "recipes/base.yaml", action: "edited" },
    ]);
  });

  it("control: the same Forge at schema 2 with the recipe listed by hand and the two keys in params", async () => {
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\nline two\n"),
        rule("stories-azure-devops", STORIES),
        mcp("azure-devops", { command: "npx", args: ["-y", "ado-mcp"] }),
      ],
      recipes: [
        recipe("base", ["rule/workflow", "rule/where"]),
        recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops"], { slot: "pm" }),
      ],
      profiles: [profile("acme", ["base", "pm-azure-devops"], ["claude-code", "kiro"], { params: { "integrations.pm.org": "acme", "integrations.pm.project": "Platform" } })],
    };
    const s = await forgeAt(2, spec);
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });
    
    // Sync the workspace
    await sync(s.wsRoot);
    gitInit(s.forgeRoot);
    
    // Edit the file elsewhere (not in the org line)
    await fs.writeFile(path.join(s.wsRoot, ".claude/rules/where.md"), "Org acme\nline two, by hand\n");
    
    // Run drift promote --dry-run --json
    const r = runCli(["drift", "promote", ".claude/rules/where.md", "--workspace", s.wsRoot, "--dry-run", "--json"], { env });
    
    // The JSON is the same before and after commit 1 for schema 2
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.outcome).toBe("variant");
    expect(j.promoted).toBe("rule/where--acme");
    expect(j.flattened.params).toEqual(["integrations.pm.org"]);
  });
});


describe("drift × the integrations block", () => {
  it("2. drift show says no, and why", async () => {
    const s = await forgeAt(3, ado());
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });
    
    // Sync the workspace
    await sync(s.wsRoot);
    
    // Hand-edit both the stories rule (provided by block) and the where rule (not provided)
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/stories-azure-devops.md"), "by hand\n");
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/where.md"), "by hand\n");
    
    const r = runCli(["drift", "show", "--workspace", s.wsRoot], { env });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      `drift         .claude/rules/stories-azure-devops.md  rule/stories-azure-devops  forge: same  promote: no (provided by integrations.pm)\n` +
      `drift         .claude/rules/where.md                 rule/where                 forge: same  promote: yes\n`,
    );
  });

  it("3. --json", async () => {
    const s = await forgeAt(3, ado());
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });
    
    await sync(s.wsRoot);
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/stories-azure-devops.md"), "by hand\n");
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/where.md"), "by hand\n");
    
    const r = runCli(["drift", "show", "--workspace", s.wsRoot, "--json"], { env });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    
    expect(j.files).toEqual([
      { path: ".claude/rules/stories-azure-devops.md", state: "drift", target: "claude-code", ingredient: "rule/stories-azure-devops", forge: "same", promotable: false, reason: "provided by integrations.pm" },
      { path: ".claude/rules/where.md", state: "drift", target: "claude-code", ingredient: "rule/where", forge: "same", promotable: true, reason: null },
    ]);
    expect(Object.keys(j.files[0])).toEqual(["path", "state", "target", "ingredient", "forge", "promotable", "reason"]);
  });

  it("4. drift promote refuses, the Forge untouched", async () => {
    const s = await forgeAt(3, ado());
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });
    
    await sync(s.wsRoot);
    gitInit(s.forgeRoot);
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/stories-azure-devops.md"), "by hand\n");
    
    const before = await snapshot(s.forgeRoot);
    const r = runCli(["drift", "promote", ".claude/rules/stories-azure-devops.md", "--workspace", s.wsRoot], { env });
    const after = await snapshot(s.forgeRoot);
    
    expect([r.code, r.stdout, r.stderr]).toEqual([
      1,
      "",
      "error: .claude/rules/stories-azure-devops.md comes from recipe pm-azure-devops, which profile acme selects through integrations.pm — edit rule/stories-azure-devops in the Forge, or `craftar drift discard .claude/rules/stories-azure-devops.md`\n",
    ]);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(porcelain(s.forgeRoot)).toBe("");
  });

  it("5. drift discard still works on it", async () => {
    const s = await forgeAt(3, ado());
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });
    
    await sync(s.wsRoot);
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/stories-azure-devops.md"), "by hand\n");
    
    const r = runCli(["drift", "discard", ".claude/rules/stories-azure-devops.md", "--workspace", s.wsRoot], { env });
    expect(r.code).toBe(0);
    
    // The file should be regenerated to its original content
    const content = await fs.readFile(path.join(s.wsRoot, ".claude/rules/stories-azure-devops.md"), "utf8");
    expect(content).toBe("Stories live in Azure DevOps, organisation acme, project Platform.\n");
  });

  it("6. (control) the other drifted file promotes", async () => {
    const s = await forgeAt(3, ado());
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });
    
    await sync(s.wsRoot);
    gitInit(s.forgeRoot);
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/where.md"), "by hand\n");
    
    const r = runCli(["drift", "promote", ".claude/rules/where.md", "--workspace", s.wsRoot, "--dry-run"], { env });
    expect(r.code).toBe(0);
  });

  it("7. (control) schema 2, the recipe listed by hand: promotable, as spec 30 shipped it", async () => {
    const spec: ForgeSpec = ado({}, PM, { recipes: ["base", "pm-azure-devops"], params: { "integrations.pm.org": "acme", "integrations.pm.project": "Platform" } });
    const s = await forgeAt(2, spec);
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });
    
    await sync(s.wsRoot);
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/stories-azure-devops.md"), "by hand\n");
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/where.md"), "by hand\n");
    
    const r = runCli(["drift", "show", "--workspace", s.wsRoot, "--json"], { env });
    const j = JSON.parse(r.stdout);
    
    expect(j.files.map((f: { promotable: boolean; reason: string | null }) => [f.promotable, f.reason])).toEqual([
      [true, null],
      [true, null],
    ]);
  });

  it("8. listed in base and in the integration recipe: promotable (not provided by the block alone)", async () => {
    // Case 23 from 33f: the rule is in BOTH base AND the integration recipe
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\n"),
        rule("stories-azure-devops", STORIES),
        mcp("azure-devops", { command: "npx", args: ["-y", "ado-mcp"] }),
      ],
      recipes: [
        recipe("base", ["rule/workflow", "rule/where", "rule/stories-azure-devops"]),  // stories in base too!
        recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops"], { slot: "pm" }),
      ],
      profiles: [profile("acme", ["base"], ["claude-code", "kiro"], { integrations: PM })],
    };
    const s = await forgeAt(3, spec);
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });
    
    await sync(s.wsRoot);
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/stories-azure-devops.md"), "by hand\n");
    
    const r = runCli(["drift", "show", "--workspace", s.wsRoot, "--json"], { env });
    const j = JSON.parse(r.stdout);
    const row = j.files.find((f: { path: string }) => f.path === ".claude/rules/stories-azure-devops.md");
    
    expect(row.promotable).toBe(true);
    expect(row.reason).toBe(null);
  });

  it("9. the recipe removed by the workspace: 'no longer produced' wins", async () => {
    const s = await forgeAt(3, ado());
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });
    
    await sync(s.wsRoot);
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/stories-azure-devops.md"), "by hand\n");
    
    // Update craftar.yaml to remove the integration recipe
    const configPath = path.join(s.wsRoot, "craftar.yaml");
    const config = await fs.readFile(configPath, "utf8");
    await fs.writeFile(configPath, config + "\nrecipes:\n  remove: [pm-azure-devops]\n");
    
    const r = runCli(["drift", "show", "--workspace", s.wsRoot, "--json"], { env });
    const j = JSON.parse(r.stdout);
    const row = j.files.find((f: { path: string }) => f.path === ".claude/rules/stories-azure-devops.md");
    
    expect(row.state).toBe("orphan-drift");
    expect(row.reason).toBe("no longer produced");
  });

  it("10. unit — driftList's order of reasons", () => {
    const planned = (p: string, target: "claude-code" | "kiro" | "agents-md", ingredient: string, body: string) => ({ path: p, content: Buffer.from(body), target, ingredient });
    const drift = (p: string, target: "claude-code" | "kiro" | "agents-md", ingredient: string, lockBody: string, planBody: string): FileStatus => ({
      path: p,
      state: "drift",
      target,
      ingredient,
      planned: planned(p, target, ingredient, planBody),
      lock: { path: p, hash: hashNormalized(Buffer.from(lockBody)), target, ingredient },
    });
    const orphanDrift = (p: string, target: "claude-code" | "kiro" | "agents-md", ingredient: string): FileStatus => ({
      path: p,
      state: "orphan-drift",
      target,
      ingredient,
      lock: { path: p, hash: hashNormalized(Buffer.from("was\n")), target, ingredient },
    });
    
    const provided = new Map([["rule/x", { slot: "pm", recipe: "pm-x" }]]);
    
    // A drift on claude-code with the ref in provided → "provided by integrations.pm"
    const rows1 = driftList([drift(".claude/rules/x.md", "claude-code", "rule/x", "x\n", "x\n")], provided);
    expect(rows1[0].reason).toBe("provided by integrations.pm");
    
    // The same ref on kiro → "provided by integrations.pm" (before "kiro file")
    const rows2 = driftList([drift(".kiro/steering/x.md", "kiro", "rule/x", "x\n", "x\n")], provided);
    expect(rows2[0].reason).toBe("provided by integrations.pm");
    
    // An orphan-drift of that ref → "no longer produced" (no longer produced wins)
    const rows3 = driftList([orphanDrift(".claude/rules/x.md", "claude-code", "rule/x")], provided);
    expect(rows3[0].reason).toBe("no longer produced");
    
    // With no map (spec 30's own tests) → null for the drift
    const rows4 = driftList([drift(".claude/rules/x.md", "claude-code", "rule/x", "x\n", "x\n")]);
    expect(rows4[0].reason).toBe(null);
  });

  // Builder's note: test what happens when the rule is listed in base AND in the integration recipe
  // and the user edits it. This is case 8's Forge.
  it("print-once: drift promote on a rule listed in base AND in the integration recipe", async () => {
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\n"),
        rule("stories-azure-devops", STORIES),
        mcp("azure-devops", { command: "npx", args: ["-y", "ado-mcp"] }),
      ],
      recipes: [
        recipe("base", ["rule/workflow", "rule/where", "rule/stories-azure-devops"]),  // stories in base too!
        recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops"], { slot: "pm" }),
      ],
      profiles: [profile("acme", ["base"], ["claude-code", "kiro"], { integrations: PM })],
    };
    const s = await forgeAt(3, spec);
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });
    
    await sync(s.wsRoot);
    gitInit(s.forgeRoot);
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/stories-azure-devops.md"), "by hand\n");
    
    const r = runCli(["drift", "promote", ".claude/rules/stories-azure-devops.md", "--workspace", s.wsRoot, "--dry-run", "--json"], { env });
    
    // Print the output for pinning
    console.log("--- print-once: drift promote on dual-listed rule ---");
    console.log("code:", r.code);
    console.log("stdout:", r.stdout);
    console.log("stderr:", r.stderr);
    
    // The claims that must hold:
    // - It does not crash with a stack trace or an internal error
    // - If it exits 0, no planned write touches recipes/pm-azure-devops.yaml's meaning for other profiles silently
    // - If it refuses, the message is one of spec 30's own D… refusals
    expect(r.code).toBe(0);  // This may need adjustment after seeing the output
  });
});
