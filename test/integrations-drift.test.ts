import { afterEach, describe, expect, it } from "vitest";
import { promises as fs, realpathSync } from "node:fs";
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

  it("1b. a hand edit of a declared param's value, in a body that also cites an integration param, is inferred — not made a variant", async () => {
    // Build the spec by hand: rule that cites an integration param AND declares a param with a default
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\nTeam {{team}}\n", { params: { team: { default: "core" } } }),
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

    // The synced file is "Org acme\nTeam core\n" (integration param rendered, declared default used)
    // Hand edit: change the team param's value only
    await fs.writeFile(path.join(s.wsRoot, ".claude/rules/where.md"), "Org acme\nTeam platform\n");

    // Run drift promote --dry-run --json
    const r = runCli(["drift", "promote", ".claude/rules/where.md", "--workspace", s.wsRoot, "--dry-run", "--json"], { env });

    // With the effective params (correct code), the base renders as "Org acme\nTeam core\n".
    // The hand edit is "Org acme\nTeam platform\n". The difference is only in the team param's value,
    // so the outcome should be `params` — the profile gains `team: platform`, no variant.
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);

    // Pin the whole JSON (temp paths built from test variables).
    // realpathSync.native: the CLI prints the native realpath; on Windows CI os.tmpdir() is an 8.3 short path.
    expect(j).toEqual({
      workspace: realpathSync.native(s.wsRoot),
      forge: realpathSync.native(s.forgeRoot),
      profile: "acme",
      dryRun: true,
      path: ".claude/rules/where.md",
      ingredient: "rule/where",
      outcome: "params",
      promoted: null,
      written: [{ path: "profiles/acme/profile.yaml", action: "edited" }],
      params: [{ key: "team", old: null, value: "platform" }],
      sections: [],
      flattened: { params: [], sections: [] },
      dependents: [".kiro/steering/where.md"],
      nextSync: { counts: { update: 1 } },
      impact: { registry: "none", workspaces: [] },
      warnings: [],
    });
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
    expect(j.warnings).toEqual([]);
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
    
    const r = runCli(["drift", "promote", ".claude/rules/where.md", "--workspace", s.wsRoot, "--dry-run", "--json"], { env });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.outcome).toBe("variant");
    expect(j.written.map((w: { path: string }) => w.path)).toEqual([
      "ingredients/rules/where--acme/ingredient.yaml",
      "ingredients/rules/where--acme/rule.md",
      "recipes/base.yaml",
    ]);
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
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    
    expect(j.files.map((f: { promotable: boolean; reason: string | null }) => [f.promotable, f.reason])).toEqual([
      [true, null],
      [true, null],
    ]);
    expect(j.warnings).toEqual([]);
  });

  it("7b. (control) schema 2, a full block the profile does not list by hand: drift show and promote are today's", async () => {
    // At schema 2 the block is inert — the profile does NOT list pm-azure-devops by hand.
    // sync writes only workflow.md and where.md (base's rules).
    // The block's recipe is NOT selected, so stories-azure-devops is NOT written.
    const s = await forgeAt(2, ado());
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });

    await sync(s.wsRoot);
    gitInit(s.forgeRoot);

    // Check what sync wrote — should NOT include stories-azure-devops
    const claudeDir = path.join(s.wsRoot, ".claude", "rules");
    const files = await fs.readdir(claudeDir);
    expect(files.sort()).toEqual(["where.md", "workflow.md"]);

    // Append to where.md (a rule that is in base, not from the block)
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/where.md"), "by hand\n");

    // drift show --json
    const r1 = runCli(["drift", "show", "--workspace", s.wsRoot, "--json"], { env });
    expect(r1.code).toBe(0);
    const j1 = JSON.parse(r1.stdout);

    // Pin the whole files array
    expect(j1.files).toEqual([
      { path: ".claude/rules/where.md", state: "drift", target: "claude-code", ingredient: "rule/where", forge: "same", promotable: true, reason: null },
    ]);

    // drift promote --dry-run --json — pin the WHOLE object with temp paths from variables
    const r2 = runCli(["drift", "promote", ".claude/rules/where.md", "--workspace", s.wsRoot, "--dry-run", "--json"], { env });
    expect(r2.code).toBe(0);
    const j2 = JSON.parse(r2.stdout);

    expect(j2).toEqual({
      workspace: realpathSync.native(s.wsRoot),
      forge: realpathSync.native(s.forgeRoot),
      profile: "acme",
      dryRun: true,
      path: ".claude/rules/where.md",
      ingredient: "rule/where",
      outcome: "variant",
      promoted: "rule/where--acme",
      written: [
        { path: "ingredients/rules/where--acme/ingredient.yaml", action: "created" },
        { path: "ingredients/rules/where--acme/rule.md", action: "created" },
        { path: "recipes/base.yaml", action: "edited" },
      ],
      params: [],
      sections: [],
      flattened: { params: ["integrations.pm.org"], sections: [] },
      dependents: [".kiro/steering/where.md"],
      nextSync: { counts: { update: 1 } },
      impact: { registry: "none", workspaces: [] },
      warnings: [],
    });
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

  // §6.9: schema 3, block { pm: { kind: "jira", org: "acme" } }, no pm-jira recipe, workspace recipes: { remove: ["pm-jira"] }, synced.
  // drift show lists the file as promotable; drift promote exits 1 because the profile does not resolve.
  it("§6.9. no-recipe with recipes.remove — drift show is promotable, drift promote exits 1", async () => {
    const spec: ForgeSpec = {
      ingredients: [rule("workflow", "# Workflow\n")],
      recipes: [recipe("base", ["rule/workflow"])],
      profiles: [profile("acme", ["base"], ["claude-code"], { integrations: { pm: { kind: "jira", org: "acme" } } })],
    };
    const s = await forgeAt(3, spec, { config: { profile: "acme", recipes: { remove: ["pm-jira"] } } });
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });

    await sync(s.wsRoot);
    gitInit(s.forgeRoot);
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/workflow.md"), "by hand\n");

    // drift show --json: the file is promotable (show never fails for this), but warnings say what happened
    const r1 = runCli(["drift", "show", "--workspace", s.wsRoot, "--json"], { env });
    expect(r1.code).toBe(0);
    const j1 = JSON.parse(r1.stdout);
    expect(j1.files).toEqual([
      { path: ".claude/rules/workflow.md", state: "drift", target: "claude-code", ingredient: "rule/workflow", forge: "same", promotable: true, reason: null },
    ]);
    expect(j1.warnings).toEqual([
      'profile acme does not resolve on its own (recipe "pm-jira" not found (referenced by integrations.pm of profile acme)) — what its integrations provide was not computed, and craftar drift promote will refuse',
    ]);

    // drift promote: exits 1 because the profile does not resolve (no pm-jira recipe, but the remove takes it out)
    const r2 = runCli(["drift", "promote", ".claude/rules/workflow.md", "--workspace", s.wsRoot, "--dry-run"], { env });
    expect([r2.code, r2.stdout, r2.stderr]).toEqual([
      1,
      "",
      'error: drift promote: profile acme does not resolve (recipe "pm-jira" not found (referenced by integrations.pm of profile acme))\n',
    ]);
    // Forge untouched
    expect(porcelain(s.forgeRoot)).toBe("");
  });

  // §6.9 with a second slot: two missing recipes, workspace resolves only because recipes.remove silences BOTH
  it("§6.9 with a second slot — drift show says promotable (limit), promote refuses", async () => {
    // Block has two slots: pm (kind: jira, no recipe) and idp (kind: nothere, no recipe).
    // Both are removed. The workspace resolves via recipes.remove, but the profile alone does not.
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\n"),
      ],
      recipes: [recipe("base", ["rule/workflow", "rule/where"])],
      profiles: [profile("acme", ["base"], ["claude-code"], { integrations: { pm: { kind: "jira", org: "acme" }, idp: { kind: "nothere" } } })],
    };
    const s = await forgeAt(3, spec, { config: { profile: "acme", recipes: { remove: ["pm-jira", "idp-nothere"] } } });
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });

    await sync(s.wsRoot);
    gitInit(s.forgeRoot);
    // Hand-edit both rules
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/where.md"), "by hand\n");
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/workflow.md"), "by hand\n");

    // drift show --json: both files read promotable: true (that is the known limit - we couldn't compute provided)
    const r1 = runCli(["drift", "show", "--workspace", s.wsRoot, "--json"], { env });
    expect(r1.code).toBe(0);
    const j1 = JSON.parse(r1.stdout);
    expect(j1.files).toEqual([
      { path: ".claude/rules/where.md", state: "drift", target: "claude-code", ingredient: "rule/where", forge: "same", promotable: true, reason: null },
      { path: ".claude/rules/workflow.md", state: "drift", target: "claude-code", ingredient: "rule/workflow", forge: "same", promotable: true, reason: null },
    ]);
    expect(j1.warnings).toEqual([
      'profile acme does not resolve on its own (recipe "pm-jira" not found (referenced by integrations.pm of profile acme)) — what its integrations provide was not computed, and craftar drift promote will refuse',
    ]);

    // text mode: same warning on stderr
    const r1t = runCli(["drift", "show", "--workspace", s.wsRoot], { env });
    expect([r1t.code, r1t.stderr]).toEqual([0, 'warn profile acme does not resolve on its own (recipe "pm-jira" not found (referenced by integrations.pm of profile acme)) — what its integrations provide was not computed, and craftar drift promote will refuse\n']);

    // drift promote on a file: exits 1 because the profile does not resolve
    const r2 = runCli(["drift", "promote", ".claude/rules/where.md", "--workspace", s.wsRoot, "--dry-run"], { env });
    expect([r2.code, r2.stderr]).toEqual([1, 'error: drift promote: profile acme does not resolve (recipe "pm-jira" not found (referenced by integrations.pm of profile acme))\n']);
    // Forge untouched
    expect(porcelain(s.forgeRoot)).toBe("");
  });
});

import { makeWorkspace } from "./helpers/forge.js";

describe("promote and a recipe the block selects, shared with another profile", () => {
  // P1 — selected only by the blocks, the rule also in `base`
  // (the Forge of test/integrations-after-main.test.ts C4)
  it("P1. selected only by the blocks, the rule also in base — D19", async () => {
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\n"),
        rule("stories-azure-devops", STORIES),
        mcp("azure-devops", { command: "npx", args: ["-y", "ado-mcp"] }),
      ],
      recipes: [
        recipe("base", ["rule/workflow", "rule/where", "rule/stories-azure-devops"]),
        recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops"], { slot: "pm" }),
      ],
      profiles: [
        profile("acme", ["base"], ["claude-code", "kiro"], { integrations: PM }),
        profile("globex", ["base"], ["claude-code", "kiro"], { integrations: PM }),
      ],
    };
    const s = await forgeAt(3, spec);
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });

    gitInit(s.forgeRoot);
    await sync(s.wsRoot);

    // Read globex's recipes BEFORE
    const recipesBefore = runCli(["recipes", "--forge", s.forgeRoot, "--profile", "globex", "--json"], { env });
    expect(recipesBefore.code).toBe(0);
    const globexContextBefore = JSON.parse(recipesBefore.stdout).context.recipes;

    // Hand-edit the rule
    const rulePath = path.join(s.wsRoot, ".claude/rules/stories-azure-devops.md");
    const content = await fs.readFile(rulePath, "utf8");
    await fs.writeFile(rulePath, content.replace("organisation acme", "organisation other"));

    // Run drift promote
    const r = runCli(["drift", "promote", ".claude/rules/stories-azure-devops.md", "--workspace", s.wsRoot, "--json"], { env });

    expect([r.code, r.stdout]).toEqual([1, ""]);
    expect(r.stderr).toBe("error: .claude/rules/stories-azure-devops.md reaches this workspace through recipe pm-azure-devops, which profile acme selects through integrations.pm and another profile also resolves — promote cannot fork a recipe a block selects; edit rule/stories-azure-devops in the Forge, or `craftar drift discard .claude/rules/stories-azure-devops.md`\n");

    // Forge untouched
    expect(porcelain(s.forgeRoot)).toBe("");

    // status still exits 0 for this workspace
    const st = runCli(["status", "--workspace", s.wsRoot, "--json"], { env });
    expect(st.code).toBe(0);

    // globex's recipes are unchanged
    const recipesAfter = runCli(["recipes", "--forge", s.forgeRoot, "--profile", "globex", "--json"], { env });
    expect(recipesAfter.code).toBe(0);
    expect(JSON.parse(recipesAfter.stdout).context.recipes).toEqual(globexContextBefore);
  });

  // P2 — listed by hand AND selected, the rule only in pm-azure-devops... not provided alone because acme lists the recipe
  it("P2. listed by hand AND selected — D19", async () => {
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\n"),
        rule("stories-azure-devops", STORIES),
        mcp("azure-devops", { command: "npx", args: ["-y", "ado-mcp"] }),
      ],
      recipes: [
        recipe("base", ["rule/workflow", "rule/where"]),
        recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops"], { slot: "pm" }),
      ],
      profiles: [
        profile("acme", ["base", "pm-azure-devops"], ["claude-code", "kiro"], { integrations: PM }),
        profile("globex", ["base", "pm-azure-devops"], ["claude-code", "kiro"]),
      ],
    };
    const s = await forgeAt(3, spec);
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });

    gitInit(s.forgeRoot);
    await sync(s.wsRoot);

    // Read globex's recipes BEFORE
    const recipesBefore = runCli(["recipes", "--forge", s.forgeRoot, "--profile", "globex", "--json"], { env });
    expect(recipesBefore.code).toBe(0);
    const globexContextBefore = JSON.parse(recipesBefore.stdout).context.recipes;

    // Hand-edit the rule
    const rulePath = path.join(s.wsRoot, ".claude/rules/stories-azure-devops.md");
    const content = await fs.readFile(rulePath, "utf8");
    await fs.writeFile(rulePath, content.replace("organisation acme", "organisation other"));

    // Run drift promote
    const r = runCli(["drift", "promote", ".claude/rules/stories-azure-devops.md", "--workspace", s.wsRoot, "--json"], { env });

    expect([r.code, r.stdout]).toEqual([1, ""]);
    expect(r.stderr).toBe("error: .claude/rules/stories-azure-devops.md reaches this workspace through recipe pm-azure-devops, which profile acme selects through integrations.pm and another profile also resolves — promote cannot fork a recipe a block selects; edit rule/stories-azure-devops in the Forge, or `craftar drift discard .claude/rules/stories-azure-devops.md`\n");

    // Forge untouched
    expect(porcelain(s.forgeRoot)).toBe("");

    // status still exits 0 for this workspace
    const st = runCli(["status", "--workspace", s.wsRoot, "--json"], { env });
    expect(st.code).toBe(0);

    // globex's recipes are unchanged
    const recipesAfter = runCli(["recipes", "--forge", s.forgeRoot, "--profile", "globex", "--json"], { env });
    expect(recipesAfter.code).toBe(0);
    expect(JSON.parse(recipesAfter.stdout).context.recipes).toEqual(globexContextBefore);
  });

  // P3 (control) — the same as P2 but acme has NO block: promote exits 0 and forks as `main` does
  it("P3. (control) listed by hand, no block — forks as main does", async () => {
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\n"),
        rule("stories-azure-devops", STORIES),
        mcp("azure-devops", { command: "npx", args: ["-y", "ado-mcp"] }),
      ],
      recipes: [
        recipe("base", ["rule/workflow", "rule/where"]),
        recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops"], { slot: "pm" }),
      ],
      profiles: [
        profile("acme", ["base", "pm-azure-devops"], ["claude-code", "kiro"], { integrations: {} }),
        profile("globex", ["base", "pm-azure-devops"], ["claude-code", "kiro"]),
      ],
    };
    const s = await forgeAt(3, spec);
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });

    gitInit(s.forgeRoot);
    await sync(s.wsRoot);

    // Hand-edit the rule
    const rulePath = path.join(s.wsRoot, ".claude/rules/stories-azure-devops.md");
    const content = await fs.readFile(rulePath, "utf8");
    await fs.writeFile(rulePath, content.replace("organisation {{integrations.pm.org}}", "organisation other"));

    // Run drift promote --dry-run --json
    const r = runCli(["drift", "promote", ".claude/rules/stories-azure-devops.md", "--workspace", s.wsRoot, "--dry-run", "--json"], { env });

    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.outcome).toBe("variant");
    expect(j.written.map((w: { path: string }) => w.path)).toEqual([
      "ingredients/rules/stories-azure-devops--acme/ingredient.yaml",
      "ingredients/rules/stories-azure-devops--acme/rule.md",
      "recipes/pm-azure-devops--acme.yaml",
      "profiles/acme/profile.yaml",
    ]);
  });

  // P4 (control, the in-place case stays) — ONE profile, the rule in `base` and in `pm-azure-devops`
  it("P4. (control) one profile, dual-listed rule — edit in place", async () => {
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\n"),
        rule("stories-azure-devops", STORIES),
        mcp("azure-devops", { command: "npx", args: ["-y", "ado-mcp"] }),
      ],
      recipes: [
        recipe("base", ["rule/workflow", "rule/where", "rule/stories-azure-devops"]),
        recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops"], { slot: "pm" }),
      ],
      profiles: [profile("acme", ["base"], ["claude-code", "kiro"], { integrations: PM })],
    };
    const s = await forgeAt(3, spec);
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });

    gitInit(s.forgeRoot);
    await sync(s.wsRoot);

    // Hand-edit the rule
    const rulePath = path.join(s.wsRoot, ".claude/rules/stories-azure-devops.md");
    const content = await fs.readFile(rulePath, "utf8");
    await fs.writeFile(rulePath, content.replace("organisation acme", "organisation other"));

    // Run drift promote --dry-run --json
    const r = runCli(["drift", "promote", ".claude/rules/stories-azure-devops.md", "--workspace", s.wsRoot, "--dry-run", "--json"], { env });

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const j = JSON.parse(r.stdout);
    expect(j).toEqual({
      workspace: realpathSync.native(s.wsRoot),
      forge: realpathSync.native(s.forgeRoot),
      profile: "acme",
      dryRun: true,
      path: ".claude/rules/stories-azure-devops.md",
      ingredient: "rule/stories-azure-devops",
      outcome: "variant",
      promoted: "rule/stories-azure-devops--acme",
      written: [
        { path: "ingredients/rules/stories-azure-devops--acme/ingredient.yaml", action: "created" },
        { path: "ingredients/rules/stories-azure-devops--acme/rule.md", action: "created" },
        { path: "recipes/base.yaml", action: "edited" },
        { path: "recipes/pm-azure-devops.yaml", action: "edited" },
      ],
      params: [],
      sections: [],
      flattened: { params: ["integrations.pm.org", "integrations.pm.project"], sections: [] },
      dependents: [".kiro/steering/stories-azure-devops.md"],
      nextSync: { counts: { update: 1 } },
      impact: { registry: "none", workspaces: [] },
      warnings: [],
    });
  });

  it("P5. a block-selected recipe and a sibling profile that does not resolve — D19 says the sibling does not resolve", async () => {
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\n"),
        rule("stories-azure-devops", STORIES),
        mcp("azure-devops", { command: "npx", args: ["-y", "ado-mcp"] }),
      ],
      recipes: [
        recipe("base", ["rule/workflow", "rule/where", "rule/stories-azure-devops"]),
        recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops"], { slot: "pm" }),
      ],
      // globex names a recipe the Forge does not have: it does not resolve, so promote cannot tell what it uses.
      profiles: [profile("acme", ["base"], ["claude-code", "kiro"], { integrations: PM }), profile("globex", ["no-such-recipe"], ["claude-code"])],
    };
    const s = await forgeAt(3, spec);
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });
    gitInit(s.forgeRoot);
    await sync(s.wsRoot);
    const rulePath = path.join(s.wsRoot, ".claude/rules/stories-azure-devops.md");
    await fs.writeFile(rulePath, (await fs.readFile(rulePath, "utf8")).replace("organisation acme", "organisation other"));
    const r = runCli(["drift", "promote", ".claude/rules/stories-azure-devops.md", "--workspace", s.wsRoot, "--json"], { env });
    expect([r.code, r.stdout]).toEqual([1, ""]);
    expect(r.stderr).toBe(
      "error: .claude/rules/stories-azure-devops.md reaches this workspace through recipe pm-azure-devops, which profile acme selects through integrations.pm, and profile globex does not resolve, so promote cannot tell whether it also uses it — promote cannot fork a recipe a block selects; fix profile globex, edit rule/stories-azure-devops in the Forge, or `craftar drift discard .claude/rules/stories-azure-devops.md`\n",
    );
    expect(porcelain(s.forgeRoot)).toBe("");
  });

  it("P6. (control) listed by hand, no block, and a sibling profile that does not resolve — still forks, never edits in place", async () => {
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        rule("where", "Org {{integrations.pm.org}}\n"),
        rule("stories-azure-devops", STORIES),
        mcp("azure-devops", { command: "npx", args: ["-y", "ado-mcp"] }),
      ],
      recipes: [
        recipe("base", ["rule/workflow", "rule/where"]),
        recipe("pm-azure-devops", ["mcp/azure-devops", "rule/stories-azure-devops"], { slot: "pm" }),
      ],
      // globex does not resolve: promote cannot tell whether it uses pm-azure-devops, so it must not edit that recipe in place.
      profiles: [
        profile("acme", ["base", "pm-azure-devops"], ["claude-code", "kiro"], { integrations: {} }),
        profile("globex", ["no-such-recipe"], ["claude-code"]),
      ],
    };
    const s = await forgeAt(3, spec);
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });
    gitInit(s.forgeRoot);
    await sync(s.wsRoot);
    const rulePath = path.join(s.wsRoot, ".claude/rules/stories-azure-devops.md");
    await fs.writeFile(rulePath, (await fs.readFile(rulePath, "utf8")).replace("organisation {{integrations.pm.org}}", "organisation other"));
    const r = runCli(["drift", "promote", ".claude/rules/stories-azure-devops.md", "--workspace", s.wsRoot, "--dry-run", "--json"], { env });
    expect(r.code, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.outcome).toBe("variant");
    expect(j.written.map((w: { path: string }) => w.path)).toEqual([
      "ingredients/rules/stories-azure-devops--acme/ingredient.yaml",
      "ingredients/rules/stories-azure-devops--acme/rule.md",
      "recipes/pm-azure-devops--acme.yaml",
      "profiles/acme/profile.yaml",
    ]);
  });
});


// Spec 33l: drift promote and drift show give the same reason for a service file the block provides.
describe("service file provided by integrations block", () => {
  const FRAGMENT = ".craftar/services/echo/compose.yaml";
  const echo = {
    meta: { type: "service", name: "echo" },
    files: { "compose.yaml": "services:\n  echo:\n    image: example/echo:1\n" },
  };

  it("1. drift show --json: a service file from a block-selected recipe has target services, promotable false, reason 'service file'", async () => {
    // schema 3 Forge, recipe pm-jira with service/echo, profile acme with integrations.pm.kind: jira
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        echo,
      ],
      recipes: [
        recipe("base", ["rule/workflow"]),
        recipe("pm-jira", ["service/echo"], { slot: "pm" }),
      ],
      profiles: [profile("acme", ["base"], ["claude-code"], { integrations: { pm: { kind: "jira" } } })],
    };
    const s = await forgeAt(3, spec);
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });

    await sync(s.wsRoot);
    await fs.appendFile(path.join(s.wsRoot, FRAGMENT), "# hand edit\n");

    const r = runCli(["drift", "show", "--json", "--workspace", s.wsRoot], { env });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.files.length).toBe(1);
    const row = parsed.files[0];
    expect(row.path).toBe(FRAGMENT);
    expect(row.target).toBe("services");
    expect(row.promotable).toBe(false);
    expect(row.reason).toBe("service file");
  });

  it("2. drift promote on that path exits 1 with the D5_SERVICE message, not D18", async () => {
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        echo,
      ],
      recipes: [
        recipe("base", ["rule/workflow"]),
        recipe("pm-jira", ["service/echo"], { slot: "pm" }),
      ],
      profiles: [profile("acme", ["base"], ["claude-code"], { integrations: { pm: { kind: "jira" } } })],
    };
    const s = await forgeAt(3, spec);
    cleanups.push(s.cleanup);
    const env = { CRAFTAR_HOME: path.join(s.root, "home") };
    await fs.mkdir(env.CRAFTAR_HOME, { recursive: true });

    gitInit(s.forgeRoot);
    await sync(s.wsRoot);
    await fs.appendFile(path.join(s.wsRoot, FRAGMENT), "# hand edit\n");

    const r = runCli(["drift", "promote", FRAGMENT, "--workspace", s.wsRoot], { env });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      `error: ${FRAGMENT} is a service file — promote reads only what the claude-code target wrote; change the service ingredient in the Forge\n`,
    );
    expect(porcelain(s.forgeRoot)).toBe("");
  });
});
