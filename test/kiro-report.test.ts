import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { listFiles } from "../src/core/forge.js";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { kiroReport, textLines } from "../src/importers/kiro-report.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";

// Spec 29 §4.2 / §9 slice B — what differs under .kiro/ from what sync would generate, by status(), with no lock.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const BANNER = (name: string) => `<!-- GENERATED from .claude/rules/${name}.md by craftar -- do not edit. -->`;
/** A steering mirror as the kiro emitter writes it (frontmatter, banner, body), with the given line ending. */
const mirror = (name: string, bodyText: string, eol = "\r\n") => `---\ninclusion: always\n---\n\n${BANNER(name)}\n\n${bodyText}`.replace(/\n/g, eol);
const MARKER = "MARKER-LINE-9f3";
const TOKEN = "ghp_" + "x".repeat(36); // assembled at runtime on purpose

/** Three rules and a command with their Kiro mirrors: one hand-edited, one LF-only, one exact; plus strays. */
const WORKSPACE: Record<string, string> = {
  ".claude/rules/workflow.md": "# Workflow\n\nOne.\n",
  ".claude/rules/style.md": "# Style\n",
  ".claude/rules/exact.md": "# Exact\n",
  ".claude/commands/open-pr.md": "---\ndescription: Open a PR\n---\n\nDo it.\n",
  ".kiro/steering/workflow.md": mirror("workflow", `# Workflow\n\nOne.\n${MARKER}\ntoken ${TOKEN}\n`),
  ".kiro/steering/style.md": mirror("style", "# Style\n", "\n"),
  ".kiro/steering/exact.md": mirror("exact", "# Exact\n"),
  ".kiro/steering/team.md": "---\ninclusion: always\n---\n\n# Team notes\n",
  ".kiro/steering/commands/open-pr.md": "Do it, differently.\n",
  ".kiro/steering/commands/legacy-deploy.md": "old\n",
  ".kiro/agents/ghost.json": "{}\n",
  ".kiro/hooks/stray.json": "{}\n", // outside the four locations: never listed
};

async function setup(files: Record<string, string> = WORKSPACE) {
  const root = await tmpDir("craftar-import-report-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const ws = path.join(root, "acme-portal");
  await writeFiles(ws, files);
  return { root, ws, forge: path.join(root, "forge"), out: path.join(root, "out", "report.md") };
}
const imported = async (files?: Record<string, string>, report = true) => {
  const s = await setup(files);
  const r = await importClaudeCode({ workspaceRoot: s.ws, forgeRoot: s.forge, profileName: "acme", report });
  return { s, r };
};

describe("textLines", () => {
  it("counts lines whatever the line ending, without a trailing empty one, a BOM aside", () => {
    expect([textLines(""), textLines("a"), textLines("a\n"), textLines("a\r\nb\r\n"), textLines("\uFEFFa\nb"), textLines("a\n\n")]).toEqual([0, 1, 1, 2, 2, 2]);
  });
});

describe("import with report: the Kiro part", () => {
  it("the hand-edited mirror and the command mirror are collisions, with line counts; the steering one is marked bigger than the rule", async () => {
    const { r } = await imported();
    expect(r.kiro).toEqual({
      kind: "computed",
      collisions: [
        { path: ".kiro/steering/commands/open-pr.md", from: "command/open-pr", workspaceLines: 1, generatedLines: 9, note: "" },
        { path: ".kiro/steering/workflow.md", from: "rule/workflow", workspaceLines: 11, generatedLines: 9, note: "steering bigger than the rule" },
      ],
      unsourced: [".kiro/agents/ghost.json", ".kiro/steering/commands/legacy-deploy.md"],
    });
    expect(r.warnings).toEqual([]);
  });

  it("a mirror equal apart from line endings, an exact one and a hand-written steering file are not collisions", async () => {
    const { r } = await imported();
    const paths = r.kiro!.kind === "computed" ? r.kiro!.collisions.map((c) => c.path) : null;
    for (const p of [".kiro/steering/style.md", ".kiro/steering/exact.md", ".kiro/steering/team.md"]) expect(paths).not.toContain(p);
  });

  it("an agent JSON equal apart from formatting is not a collision", async () => {
    const agent = "---\nname: reviewer\ndescription: Reviews.\ntools: Read\n---\n\nWalk the rules.\n";
    const first = await imported({ ".claude/agents/reviewer.md": agent, ".kiro/steering/keep.md": "---\ninclusion: always\n---\n\n# Keep\n" });
    expect(first.r.kiro).toEqual({ kind: "computed", collisions: [], unsourced: [] });
    // what sync would write for that agent, re-indented by hand
    const { loadWorkspaceConfig, plan } = await import("../src/core/sync.js");
    const p = await plan(await loadWorkspaceConfig(first.s.ws, { forge: first.s.forge, profile: "acme", targets: ["claude-code", "kiro"] }, null));
    const json = p.files.find((f) => f.path.startsWith(".kiro/agents/") && f.path.endsWith(".json"))!;
    await writeFiles(first.s.ws, { [json.path]: JSON.stringify(JSON.parse(json.content.toString("utf8")), null, 8) });
    const again = await kiroReport({ workspaceRoot: first.s.ws, forgeRoot: first.s.forge, profile: "acme", targets: ["claude-code", "kiro"] });
    expect(again).toEqual({ kind: "computed", collisions: [], unsourced: [] });
  });

  it("the mirror is bigger than the rule only when its body, frontmatter and banner aside, has more lines", async () => {
    // same line count as the rule, different text: a collision, not "bigger"
    const { r } = await imported({ ".claude/rules/workflow.md": "# Workflow\n\nOne.\n", ".kiro/steering/workflow.md": mirror("workflow", "# Workflow\n\nUno.\n") });
    expect(r.kiro).toEqual({ kind: "computed", collisions: [{ path: ".kiro/steering/workflow.md", from: "rule/workflow", workspaceLines: 9, generatedLines: 9, note: "" }], unsourced: [] });
  });

  it("no .kiro/ at all: kind none, and nothing is planned", async () => {
    const { r } = await imported({ ".claude/rules/workflow.md": "# Workflow\n" });
    expect(r.kiro).toEqual({ kind: "none" });
  });

  it("without the option the report holds no kiro key", async () => {
    const { r } = await imported(undefined, false);
    expect("kiro" in r).toBe(false);
  });

  it("the workspace's own forge, profile, targets and lock are not read", async () => {
    const s = await setup({ ...WORKSPACE, "craftar.yaml": "forge: ../nowhere\nprofile: someone-else\n", "craftar.local.yaml": "targets: []\n", "craftar.lock": "{ not json" });
    const r = await importClaudeCode({ workspaceRoot: s.ws, forgeRoot: s.forge, profileName: "acme", report: true });
    expect(r.kiro!.kind).toBe("computed");
    expect((r.kiro as { collisions: unknown[] }).collisions).toHaveLength(2);
  });

  it("the workspace's overrides are honoured, as import honoured them to prove the reuse: no collision sync would not have", async () => {
    const s = await setup({ ".claude/rules/deploy.md": "use acme-api here\n", ".kiro/steering/deploy.md": mirror("deploy", "use acme-api here\n") });
    await importClaudeCode({ workspaceRoot: s.ws, forgeRoot: s.forge, profileName: "acme" });
    // the Forge rule becomes a template; the value lives in the workspace's own overrides, not in the profile
    await writeFiles(s.forge, { "ingredients/rules/deploy/rule.md": "use {{deploy.api}} here\n" });
    const meta = path.join(s.forge, "ingredients/rules/deploy/ingredient.yaml");
    await fs.writeFile(meta, (await fs.readFile(meta, "utf8")) + "params:\n  deploy.api:\n    default: globex-api\n");
    await writeFiles(s.ws, { "craftar.yaml": "forge: ../forge\nprofile: acme\noverrides:\n  params:\n    deploy.api: acme-api\n" });
    const r = await importClaudeCode({ workspaceRoot: s.ws, forgeRoot: s.forge, profileName: "acme", report: true });
    expect(r.reused).toContain("rule/deploy");
    expect(r.kiro).toEqual({ kind: "computed", collisions: [], unsourced: [] });
    // (control) without the override the same mirror is a collision: the plan renders the default
    await fs.rm(path.join(s.ws, "craftar.yaml"));
    const k = await kiroReport({ workspaceRoot: s.ws, forgeRoot: s.forge, profile: "acme", targets: ["claude-code", "kiro"] });
    expect(k.kind === "computed" && k.collisions.map((c) => c.path)).toEqual([".kiro/steering/deploy.md"]);
  });

  it("a mirror that differs only by a BOM and its line endings is not a collision", async () => {
    const { r } = await imported({ ".claude/rules/style.md": "# Style\n", ".kiro/steering/style.md": "\uFEFF" + mirror("style", "# Style\n", "\n") });
    expect(r.kiro).toEqual({ kind: "computed", collisions: [], unsourced: [] });
  });

  it("a location that is a file, not a directory, is not listed and does not stop the report", async () => {
    const { r } = await imported({ ".claude/rules/style.md": "# Style\n", ".kiro/steering/style.md": mirror("style", "# Style\n"), ".kiro/agents": "not a directory\n" });
    expect(r.kiro).toEqual({ kind: "computed", collisions: [], unsourced: [] });
  });

  it("a plan that throws after the flush: not computed, with the first line of the message; the Forge written, no throw", async () => {
    const s = await setup();
    const r = await importClaudeCode({ workspaceRoot: s.ws, forgeRoot: s.forge, profileName: "acme" });
    expect(r.created).toContain("rule/workflow");
    const k = await kiroReport({ workspaceRoot: s.ws, forgeRoot: s.forge, profile: "acme", targets: ["claude-code", "kiro"] }, { plan: async () => { throw new Error("boom\nsecond line"); } });
    expect(k).toEqual({ kind: "not-computed", message: "boom" });
    expect((await listFiles(s.forge)).length).toBeGreaterThan(0);
  });

  it("a plan sync would refuse — a declared parameter with no value — is not computed, naming the key: never a collision against a file sync does not write", async () => {
    const s = await setup();
    await importClaudeCode({ workspaceRoot: s.ws, forgeRoot: s.forge, profileName: "acme" });
    const dir = path.join(s.forge, "ingredients/rules/exact");
    const meta = path.join(dir, "ingredient.yaml");
    await fs.writeFile(meta, YAML.stringify({ ...YAML.parse(await fs.readFile(meta, "utf8")), params: { "team.name": { description: "the team" } } }));
    const body = (await listFiles(dir)).find((f) => f.endsWith(".md"))!;
    await fs.appendFile(path.join(dir, body), "Team: {{team.name}}\n");
    const k = await kiroReport({ workspaceRoot: s.ws, forgeRoot: s.forge, profile: "acme", targets: ["claude-code", "kiro"] });
    expect(k).toEqual({ kind: "not-computed", message: "sync refused: declared parameter(s) with no value: team.name" });
  });

  it("a Forge that no longer loads: not computed, no throw", async () => {
    const s = await setup();
    await importClaudeCode({ workspaceRoot: s.ws, forgeRoot: s.forge, profileName: "acme" });
    const k = await kiroReport({ workspaceRoot: s.ws, forgeRoot: s.forge, profile: "nobody", targets: ["kiro"] });
    expect(k.kind).toBe("not-computed");
    expect((k as { message: string }).message).toContain('profile "nobody" not found');
  });
});
