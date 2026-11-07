/**
 * Spec 63 §5–§8, §11 and criteria 2, 3, 4, 7, 8: what the `opencode` target writes — `.opencode/agents/<name>.md` with
 * `permissions` derived from `tools`, `.opencode/commands/<name>.md`, and the MCP servers in `.opencode/opencode.json`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { loadWorkspace, plan, apply, readLock, status } from "../src/core/sync.js";
import { profile, recipe, scenario, type IngredientSpec } from "./helpers/forge.js";
import { atLeastWin32 } from "./helpers/timeouts.js";

type Scenario = Awaited<ReturnType<typeof scenario>>;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const T = { timeout: atLeastWin32(30_000) };

async function ws(targets: string[], ingredients: IngredientSpec[]): Promise<Scenario> {
  const refs = ingredients.map((i) => `${i.meta.type}/${i.meta.name}`);
  const s = await scenario({ ingredients, recipes: [recipe("base", refs)], profiles: [profile("acme", ["base"], targets)] }, { config: { profile: "acme" } });
  cleanups.push(s.cleanup);
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 18 }));
  return s;
}
const planOf = async (s: Scenario) => plan(await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME }));
const fileOf = (p: Awaited<ReturnType<typeof planOf>>, rel: string) => p.files.find((f) => f.path === rel)?.content.toString("utf8");
const ow = (p: Awaited<ReturnType<typeof planOf>>) => p.warnings.filter((w) => w.startsWith("opencode:"));

const agent = (extra: Record<string, unknown>, body = "You review acme code.\n"): IngredientSpec => ({
  meta: { type: "agent", name: "reviewer", description: "Reviews acme code: read-only #1", ...extra },
  files: { "agent.md": body },
});

const PERM = (rules: Array<[string, string, string]>) =>
  "permissions:\n" + rules.map(([a, r, e]) => `  - action: ${JSON.stringify(a)}\n    resource: ${JSON.stringify(r)}\n    effect: ${JSON.stringify(e)}\n`).join("");

describe("opencode agents (spec 63 §5, §6)", () => {
  it("1. criterion 2's agent: the exact file of §5", T, async () => {
    const p = await planOf(await ws(["opencode"], [agent({ tools: ["Read", "Bash(git status *)", "mcp__acme__search"] })]));
    expect(fileOf(p, ".opencode/agents/reviewer.md")).toBe(
      "---\n" +
        'description: "Reviews acme code: read-only #1"\n' +
        'mode: "subagent"\n' +
        PERM([
          ["*", "*", "deny"],
          ["read", "*", "allow"],
          ["read", "*.env", "ask"],
          ["read", "*.env.*", "ask"],
          ["read", "*.env.example", "allow"],
          ["shell", "git status *", "allow"],
          ["acme_search", "*", "allow"],
          ["external_directory", "*", "ask"],
        ]) +
        "---\n\nYou review acme code.\n",
    );
    expect(ow(p)).toEqual([]);
  });

  it("2. tools [*] and no tools: no permissions key", T, async () => {
    const p = await planOf(await ws(["opencode"], [agent({ tools: ["*"] }), { ...agent({}), meta: { ...agent({}).meta, name: "plain" } }]));
    expect(fileOf(p, ".opencode/agents/reviewer.md")).toBe('---\ndescription: "Reviews acme code: read-only #1"\nmode: "subagent"\n---\n\nYou review acme code.\n');
    expect(fileOf(p, ".opencode/agents/plain.md")).toBe('---\ndescription: "Reviews acme code: read-only #1"\nmode: "subagent"\n---\n\nYou review acme code.\n');
  });

  it("3. a scoped Read denies the .env files; TodoWrite and an unknown scope get no rule and a warning", T, async () => {
    const p = await planOf(await ws(["opencode"], [agent({ tools: ["Read(src/**)", "TodoWrite", "WebFetch(https://x)", "Grep(src/**)", "Edit(//etc/hosts)", "Bash(npm test:*)", "Skill(deploy)"] })]));
    expect(fileOf(p, ".opencode/agents/reviewer.md")).toBe(
      '---\ndescription: "Reviews acme code: read-only #1"\nmode: "subagent"\n' +
        PERM([
          ["*", "*", "deny"],
          ["read", "src/**", "allow"],
          ["read", "*.env", "deny"],
          ["read", "*.env.*", "deny"],
          ["edit", "/etc/hosts", "allow"],
          ["shell", "npm test *", "allow"],
          ["skill", "deploy", "allow"],
          ["external_directory", "*", "ask"],
        ]) +
        "---\n\nYou review acme code.\n",
    );
    expect(ow(p)).toEqual([
      'opencode: agent "reviewer": tool "TodoWrite" has no OpenCode permission; no rule written',
      'opencode: agent "reviewer": tool "WebFetch(https://x)": its scope cannot be translated; no rule written',
      'opencode: agent "reviewer": tool "Grep(src/**)": its scope cannot be translated; no rule written',
    ]);
  });

  it("4. a duplicate allow is written once; an MCP name outside [A-Za-z0-9_] is untranslatable; a whole server is <srv>_*", T, async () => {
    const p = await planOf(await ws(["opencode"], [agent({ tools: ["WebSearch", "websearch", "mcp__acme-docs__search", "mcp__acme", "Task"] })]));
    expect(fileOf(p, ".opencode/agents/reviewer.md")).toBe(
      '---\ndescription: "Reviews acme code: read-only #1"\nmode: "subagent"\n' +
        PERM([
          ["*", "*", "deny"],
          ["websearch", "*", "allow"],
          ["acme_*", "*", "allow"],
          ["subagent", "*", "allow"],
        ]) +
        "---\n\nYou review acme code.\n",
    );
    expect(ow(p)).toEqual(['opencode: agent "reviewer": tool "mcp__acme-docs__search" has no OpenCode permission; no rule written']);
  });

  it("5. model: provider/model kept; inherit and absent write none; sonnet dropped with a warning; no description written empty and warned", T, async () => {
    const p = await planOf(
      await ws(["opencode"], [
        agent({ model: "anthropic/claude-sonnet-5-5#high" }),
        { meta: { type: "agent", name: "b", model: "inherit" }, files: { "agent.md": "B.\n" } },
        { meta: { type: "agent", name: "c", description: "C", model: "sonnet" }, files: { "agent.md": "C.\n" } },
      ]),
    );
    expect(fileOf(p, ".opencode/agents/reviewer.md")).toBe('---\ndescription: "Reviews acme code: read-only #1"\nmode: "subagent"\nmodel: "anthropic/claude-sonnet-5-5#high"\n---\n\nYou review acme code.\n');
    expect(fileOf(p, ".opencode/agents/b.md")).toBe('---\ndescription: ""\nmode: "subagent"\n---\n\nB.\n');
    expect(fileOf(p, ".opencode/agents/c.md")).toBe('---\ndescription: "C"\nmode: "subagent"\n---\n\nC.\n');
    expect(ow(p)).toEqual([
      'opencode: agent "b" has no description, which OpenCode uses to pick a subagent; written empty',
      'opencode: agent "c": model is not in OpenCode\'s provider/model form; dropped',
    ]);
  });
});

describe("opencode commands (spec 63 §7)", () => {
  const cmd: IngredientSpec = { meta: { type: "command", name: "test", description: "Run acme tests", argumentHint: "[file]", allowedTools: "Bash(npm test)" }, files: { "command.md": "Run tests for $ARGUMENTS\n" } };
  it("6. written with or without agent-skills; argument-hint and allowed-tools dropped, one warning each", T, async () => {
    for (const targets of [["opencode"], ["opencode", "agent-skills"]]) {
      const p = await planOf(await ws(targets, [cmd]));
      expect(fileOf(p, ".opencode/commands/test.md")).toBe('---\ndescription: "Run acme tests"\n---\n\nRun tests for $ARGUMENTS\n');
      expect(ow(p)).toEqual([
        'opencode: command "test": argument-hint has no OpenCode field; dropped',
        'opencode: command "test": allowed-tools has no OpenCode field; dropped',
      ]);
    }
  });
});

describe("opencode MCP (spec 63 §8)", () => {
  const mcp = (name: string, server: Record<string, unknown>): IngredientSpec => ({ meta: { type: "mcp", name, server } });
  it("7. local and remote servers reshaped, ${X} → {env:X}, copied keys kept, unknown keys, types and missing keys warned", T, async () => {
    const p = await planOf(
      await ws(["opencode"], [
        mcp("tracker", { command: "npx", args: ["-y", "acme-tracker"], env: { ACME_TOKEN: "${ACME_TOKEN}", ROOT: "${workspaceFolder}" }, cwd: "tools", alwaysAllow: ["x"] }),
        mcp("docs", { type: "http", url: "https://docs.acme.test/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" }, timeout: 5000 }),
        mcp("odd", { type: "websocket", url: "wss://x.test" }),
        mcp("nourl", { type: "remote" }),
      ]),
    );
    expect(fileOf(p, ".opencode/opencode.json")).toBe(
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          mcp: {
            servers: {
              tracker: { type: "local", command: ["npx", "-y", "acme-tracker"], environment: { ACME_TOKEN: "{env:ACME_TOKEN}", ROOT: "${workspaceFolder}" }, cwd: "tools" },
              docs: { type: "remote", url: "https://docs.acme.test/mcp", headers: { Authorization: "Bearer {env:DOCS_TOKEN}" }, timeout: 5000 },
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    expect(ow(p)).toEqual([
      'opencode: MCP server "tracker": key "alwaysAllow" has no OpenCode field; dropped',
      'opencode: MCP server "tracker": ${workspaceFolder} has no OpenCode form; left as written',
      'opencode: MCP server "odd": type "websocket" has no OpenCode form; skipped',
      'opencode: MCP server "nourl": no url for a remote server; skipped',
    ]);
  });

  it("8. sync, then a hand edit: drift; a hand-written .opencode/opencode.json before the first sync is a collision", T, async () => {
    const s = await ws(["opencode"], [mcp("tracker", { command: "npx" }), agent({})]);
    await fs.mkdir(path.join(s.wsRoot, ".opencode"), { recursive: true });
    await fs.writeFile(path.join(s.wsRoot, ".opencode", "opencode.json"), '{"model":"acme/x"}\n');
    const w = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(w);
    const st = await status(w, p, await readLock(w.root));
    expect(st.find((x) => x.path === ".opencode/opencode.json")?.state).toBe("collision");
    await fs.rm(path.join(s.wsRoot, ".opencode", "opencode.json"));
    await apply(w, p, await status(w, p, await readLock(w.root)), {});
    expect((await readLock(s.wsRoot))!.schema).toBe(7);
  });
});

describe("line endings (criterion 8)", () => {
  it("9. a CRLF agent, command and opencode.json on disk keep CRLF when rewritten, and no file gets a BOM", T, async () => {
    const s = await ws(["opencode"], [agent({}), { meta: { type: "command", name: "test", description: "D" }, files: { "command.md": "Go.\n" } }, { meta: { type: "mcp", name: "m", server: { command: "x" } } }]);
    for (const [rel, text] of [[".opencode/agents/reviewer.md", "﻿old\r\nfile\r\n"], [".opencode/commands/test.md", "old\r\n"], [".opencode/opencode.json", "{\r\n}\r\n"]] as const) {
      await fs.mkdir(path.dirname(path.join(s.wsRoot, rel)), { recursive: true });
      await fs.writeFile(path.join(s.wsRoot, rel), text);
    }
    const p = await planOf(s);
    for (const rel of [".opencode/agents/reviewer.md", ".opencode/commands/test.md", ".opencode/opencode.json"]) {
      const c = fileOf(p, rel)!;
      expect(c.includes("\r\n"), rel).toBe(true);
      expect(c.replace(/\r\n/g, "").includes("\n"), rel).toBe(false);
      expect(c.startsWith("﻿"), rel).toBe(false);
    }
  });
});

describe("drift (criterion 7)", () => {
  it("10. a hand edit of an opencode agent or of .opencode/opencode.json is not promotable, and drift promote refuses each", T, async () => {
    const { runCli } = await import("./helpers/cli.js");
    const s = await ws(["opencode"], [agent({}), { meta: { type: "mcp", name: "m", server: { command: "x" } } }]);
    const W = ["--workspace", s.wsRoot];
    // drift promote gates on git before anything else: the Forge is a repository with a commit.
    const env = { ...process.env, GIT_AUTHOR_NAME: "craftar-test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "craftar-test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
    execFileSync("git", ["init", "-q", s.forgeRoot]);
    execFileSync("git", ["-C", s.forgeRoot, "config", "maintenance.auto", "false"]);
    execFileSync("git", ["-C", s.forgeRoot, "add", "-A"]);
    execFileSync("git", ["-C", s.forgeRoot, "commit", "-q", "-m", "init"], { env });
    expect(runCli(["sync", ...W]).code).toBe(0);
    await fs.appendFile(path.join(s.wsRoot, ".opencode", "agents", "reviewer.md"), "edited\n");
    await fs.writeFile(path.join(s.wsRoot, ".opencode", "opencode.json"), "{}\n");
    const shown = JSON.parse(runCli(["drift", "show", "--json", ...W]).stdout) as { files: Array<{ path: string; promotable: boolean; reason: string | null }> };
    const row = (p: string) => shown.files.find((f) => f.path === p);
    expect(row(".opencode/agents/reviewer.md")).toMatchObject({ promotable: false, reason: "opencode file" });
    expect(row(".opencode/opencode.json")).toMatchObject({ promotable: false, reason: ".mcp.json" });
    const a = runCli(["drift", "promote", ".opencode/agents/reviewer.md", "--forge", s.forgeRoot, ...W]);
    expect([a.code, a.stderr]).toEqual([1, expect.stringContaining(".opencode/agents/reviewer.md is an opencode file — promote reads only what the claude-code target wrote")]);
    const m = runCli(["drift", "promote", ".opencode/opencode.json", "--forge", s.forgeRoot, ...W]);
    expect([m.code, m.stderr]).toEqual([1, expect.stringContaining(".opencode/opencode.json holds every mcp ingredient in one file")]);
  });
});

describe("rule references (spec 63 §9)", () => {
  it("11. a .claude/rules/ reference in an agent body: claude-code's file, else AGENTS.md, else not in this workspace", T, async () => {
    const style: IngredientSpec = { meta: { type: "rule", name: "style" }, files: { "rule.md": "Use tabs.\n" } };
    const a = agent({}, "See .claude/rules/style.md.\n");
    const body = async (targets: string[]) => fileOf(await planOf(await ws(targets, [style, a])), ".opencode/agents/reviewer.md")!.split("---\n\n")[1];
    expect(await body(["opencode", "claude-code"])).toBe("See .claude/rules/style.md.\n");
    expect(await body(["opencode", "agents-md"])).toBe("See AGENTS.md (rule: style).\n");
    expect(await body(["opencode"])).toBe("See style (rule not in this workspace).\n");
  });
});
