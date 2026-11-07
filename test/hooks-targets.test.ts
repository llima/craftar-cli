/**
 * Spec 61 slice 3, H1 (ruled 2026-11-07, "Codex + Antigravity"): a hook's registration — Claude Code's events, matchers and
 * command — is written by `codex` to `.codex/hooks.json` (Claude Code's shape, names kept) and by `antigravity` to
 * `.agents/hooks.json` (one named hook per ingredient, events and tool-name matchers translated by a measured table); what has no
 * equivalent is skipped with a warning. Cursor and Copilot read `.claude/settings.json`, so their hook cells read "through
 * claude-code". The hook's files stay `claude-code`'s.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { HOOKS_CONTENT_HIDDEN, diffReport } from "../src/core/report.js";
import { antigravityMatcher } from "../src/emitters/hooks.js";
import { profile, recipe, scenario, type IngredientSpec } from "./helpers/forge.js";

type Scenario = Awaited<ReturnType<typeof scenario>>;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function planned(targets: string[], ingredients: IngredientSpec[]) {
  const refs = ingredients.map((i) => `${i.meta.type}/${i.meta.name}`);
  const s: Scenario = await scenario({ ingredients, recipes: [recipe("base", refs)], profiles: [profile("acme", ["base"], targets)] }, { config: { profile: "acme" } });
  cleanups.push(s.cleanup);
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 16 }));
  const p = await plan(await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME }));
  const json = (rel: string) => JSON.parse(p.files.find((f) => f.path === rel)!.content.toString("utf8"));
  return { p, json, paths: p.files.map((f) => f.path) };
}

const hook = (name: string, registration: unknown[], extra: Record<string, unknown> = {}): IngredientSpec => ({
  meta: { type: "hook", name, files: [`${name}.sh`], registration, ...extra },
  files: { [`${name}.sh`]: "#!/bin/sh\nexit 0\n" },
});
const guard = hook("guard", [
  { event: "PreToolUse", matcher: "Bash|Edit", command: "./.claude/hooks/guard.sh", timeout: 10 },
  { event: "Stop", command: "./.claude/hooks/guard.sh" },
]);

describe("codex: .codex/hooks.json in Claude Code's shape", () => {
  it("events, matchers and the command kept; type command; timeout in seconds; owned by hook/*", async () => {
    const { p, json } = await planned(["claude-code", "codex"], [guard]);
    expect(json(".codex/hooks.json")).toEqual({
      hooks: {
        PreToolUse: [{ matcher: "Bash|Edit", hooks: [{ type: "command", command: "./.claude/hooks/guard.sh", timeout: 10 }] }],
        Stop: [{ hooks: [{ type: "command", command: "./.claude/hooks/guard.sh" }] }],
      },
    });
    const f = p.files.find((x) => x.path === ".codex/hooks.json")!;
    expect([f.target, f.ingredient]).toEqual(["codex", "hook/*"]);
    expect(p.warnings.filter((w) => w.startsWith("codex:"))).toEqual([]);
  });

  it("an event Codex lacks and an entry with args are skipped, shell dropped — each warned; a hook with no registration writes nothing", async () => {
    const odd = hook("odd", [
      { event: "Notification", command: "./.claude/hooks/odd.sh" },
      { event: "PreToolUse", command: "python3", args: ["./.claude/hooks/odd.sh"] },
      { event: "PostToolUse", command: "./.claude/hooks/odd.sh", shell: "bash" },
    ]);
    const bare: IngredientSpec = { meta: { type: "hook", name: "bare", files: ["bare.sh"] }, files: { "bare.sh": "#!/bin/sh\n" } };
    const { p, json } = await planned(["claude-code", "codex"], [odd, bare]);
    expect(json(".codex/hooks.json")).toEqual({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "./.claude/hooks/odd.sh" }] }] } });
    expect(p.warnings).toContain("codex: hook hook/odd: event Notification has no Codex equivalent; skipped");
    expect(p.warnings).toContain("codex: hook hook/odd: an PreToolUse entry uses args, and Codex runs a command string with no argv form; skipped");
    expect(p.warnings).toContain("codex: hook hook/odd: shell has no Codex key; dropped");
    expect(p.warnings).toContain("codex: hook hook/bare has no registration, so nothing is written for it");
  });

  it("without claude-code among the targets the hook's files reach nothing, and a registration naming CLAUDE_PROJECT_DIR is warned", async () => {
    const env = hook("env", [{ event: "Stop", command: "${CLAUDE_PROJECT_DIR}/.claude/hooks/env.sh" }]);
    const { p } = await planned(["codex"], [env]);
    expect(p.warnings).toContain("codex: hook hook/env: its files are written by the claude-code target only, which does not write them here (not among the targets, or the hook is not aimed at it)");
    expect(p.warnings).toContain("codex: hook hook/env: its registration names CLAUDE_PROJECT_DIR, which Codex is not documented to set");
  });

  it("a credential substituted into a registration fails the plan before any reshape, naming no value", async () => {
    const tok = "ghp_" + "x".repeat(36);
    const leak: IngredientSpec = {
      meta: { type: "hook", name: "leak", files: ["leak.sh"], params: { tok: { default: tok } }, registration: [{ event: "Stop", command: "./x.sh {{tok}}" }] },
      files: { "leak.sh": "#!/bin/sh\n" },
    };
    await expect(planned(["codex"], [leak])).rejects.toThrow(/registration\[0\]/);
    await expect(planned(["codex"], [leak])).rejects.not.toThrow(tok);
  });
});

describe("antigravity: .agents/hooks.json, translated", () => {
  it("one named hook per ingredient; a tool event as a group with a translated matcher; Stop as handlers directly", async () => {
    const { p, json } = await planned(["claude-code", "antigravity"], [guard]);
    expect(json(".agents/hooks.json")).toEqual({
      guard: {
        PreToolUse: [{ matcher: "run_command|replace_file_content|multi_replace_file_content", hooks: [{ type: "command", command: "./.claude/hooks/guard.sh", timeout: 10 }] }],
        Stop: [{ type: "command", command: "./.claude/hooks/guard.sh" }],
      },
    });
    expect(p.files.find((x) => x.path === ".agents/hooks.json")!.ingredient).toBe("hook/*");
    expect(p.warnings.filter((w) => w.startsWith("antigravity:"))).toEqual([]);
  });

  it("an event with no equivalent, an untranslatable matcher, args and a matcher on Stop are each skipped or dropped with a warning", async () => {
    const odd = hook("odd", [
      { event: "UserPromptSubmit", command: "./.claude/hooks/odd.sh" },
      { event: "PreToolUse", matcher: "mcp__github__.*", command: "./.claude/hooks/odd.sh" },
      { event: "PostToolUse", command: "python3", args: ["x"] },
      { event: "SessionStart", matcher: "startup", command: "./.claude/hooks/odd.sh" },
    ]);
    const { p, json } = await planned(["claude-code", "antigravity"], [odd]);
    expect(json(".agents/hooks.json")).toEqual({ odd: { SessionStart: [{ type: "command", command: "./.claude/hooks/odd.sh" }] } });
    expect(p.warnings).toContain("antigravity: hook hook/odd: event UserPromptSubmit has no Antigravity equivalent; skipped");
    expect(p.warnings).toContain("antigravity: hook hook/odd: the PreToolUse matcher has no Antigravity translation (only a list of Claude Code tool names does); skipped");
    expect(p.warnings).toContain("antigravity: hook hook/odd: an PostToolUse entry uses args, and Antigravity runs a command string; skipped");
    expect(p.warnings).toContain("antigravity: hook hook/odd: Antigravity ignores a matcher on SessionStart; dropped");
  });

  it("antigravityMatcher: a list of Claude Code names translates; none or * is *; anything else is null", () => {
    expect(antigravityMatcher(undefined)).toBe("*");
    expect(antigravityMatcher("*")).toBe("*");
    expect(antigravityMatcher("Read")).toBe("view_file");
    expect(antigravityMatcher("Edit|MultiEdit")).toBe("replace_file_content|multi_replace_file_content");
    expect(antigravityMatcher("Bash,Grep")).toBe("run_command|grep_search");
    expect(antigravityMatcher("Bash.*")).toBeNull();
    expect(antigravityMatcher("NotebookEdit")).toBeNull();
  });
});

describe("cursor and copilot: through claude-code", () => {
  it("with claude-code among the targets, no hooks file and no hook warning; without it, the hook is warned", async () => {
    const withCc = await planned(["claude-code", "cursor", "copilot"], [guard]);
    expect(withCc.paths.filter((x) => x.includes("hooks.json") || x.startsWith(".github/hooks/"))).toEqual([]);
    expect(withCc.p.warnings.filter((w) => /^(cursor|copilot): .*hook/.test(w))).toEqual([]);
    const without = await planned(["cursor", "copilot"], [guard]);
    expect(without.p.warnings).toContain("cursor: 1 hook ingredient(s) have no Cursor equivalent — skipped: hook/guard");
    expect(without.p.warnings).toContain("copilot: 1 hook ingredient(s) have no Copilot equivalent — skipped: hook/guard");
  });
});

describe("review round: files nobody writes, and the hooks files on drift", () => {
  it("a hook not aimed at claude-code (or with no claude-code target) writes its registration but says its files reach nothing", async () => {
    const onlyCodex = hook("only", [{ event: "Stop", command: "bash scripts/only.sh" }], { targets: ["codex"] });
    const { p } = await planned(["claude-code", "codex"], [onlyCodex]);
    expect(p.warnings).toContain("codex: hook hook/only: its files are written by the claude-code target only, which does not write them here (not among the targets, or the hook is not aimed at it)");
    const none = await planned(["antigravity"], [hook("x", [{ event: "Stop", command: "./run.sh" }])]);
    expect(none.p.warnings).toContain("antigravity: hook hook/x: its files are written by the claude-code target only, which does not write them here (not among the targets, or the hook is not aimed at it)");
    expect(none.json(".agents/hooks.json")).toEqual({ x: { Stop: [{ type: "command", command: "./run.sh" }] } });
  });

  it("a matcher with spaces around a name is a regex for Claude Code, so it has no translation", () => {
    expect(antigravityMatcher("Bash | Edit")).toBeNull();
  });
});

describe("review round 2: the diff tool of craftar mcp withholds a hand-edited hooks file", () => {
  it("withholdMcp true → the hooks note, nothing of the disk; false (the CLI) → the file's text", async () => {
    const s: Scenario = await scenario({ ingredients: [guard], recipes: [recipe("base", ["hook/guard"])], profiles: [profile("acme", ["base"], ["claude-code", "codex", "antigravity"])] }, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema: 16 }));
    const load = () => loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    let w = await load();
    let p = await plan(w);
    await apply(w, p, await status(w, p, await readLock(w.root)), {});
    for (const f of [".codex/hooks.json", ".agents/hooks.json"]) await fs.writeFile(path.join(s.wsRoot, f), '{"SENTINEL-DISK": true}\n');
    w = await load();
    p = await plan(w);
    const rows = (await status(w, p, await readLock(w.root))).filter((r) => r.path.endsWith("hooks.json"));
    expect(rows.map((r) => r.state)).toEqual(["drift", "drift"]);
    const hidden = await diffReport(w, rows, { withholdMcp: true });
    expect(hidden.map((r) => r.note)).toEqual([HOOKS_CONTENT_HIDDEN, HOOKS_CONTENT_HIDDEN]);
    expect(JSON.stringify(hidden)).not.toContain("SENTINEL-DISK");
    const shown = await diffReport(w, rows, { withholdMcp: false });
    expect(shown.every((r) => r.note === null && r.disk!.includes("SENTINEL-DISK"))).toBe(true);
  });
});
