import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { exists } from "../src/core/forge.js";
import { apply, loadWorkspace, mergeWorkspaceConfig, plan, readLock, status } from "../src/core/sync.js";
import { mcpWriters } from "../src/core/write-actions.js";
import { workspaceId } from "../src/ui/routes.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, type ForgeSpec } from "./helpers/forge.js";
import { build, OVERRIDDEN, OVERRIDE_FILES } from "./helpers/local-override.js";
import { get } from "./helpers/ui.js";

/**
 * Spec 56 §4.3: a profile resolving its override `rule/y` and a root variant `rule/y-shared` (`as: y`) is refused as an
 * unset declared parameter is — `plan()` stays total, `apply()` is the gate, and every surface that answers "would sync
 * fail" decides it, naming refs only.
 */

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true });
});

const CONFLICT: ForgeSpec = {
  ingredients: [...OVERRIDDEN.ingredients!, rule("y-shared", "# S\n", { as: "y" })],
  recipes: [...OVERRIDDEN.recipes!, recipe("extra", ["rule/y-shared"])],
  profiles: [profile("acme", ["base"]), profile("globex", ["base"])],
};
const LINE = "profile acme resolves its override rule/y and the root variant rule/y-shared (as: y) — remove one from its recipes";

/** A Forge whose acme workspace synced clean, then took the recipe `extra` through `recipes.add`: the conflict. */
async function conflicted() {
  const s = await build(cleanups, CONFLICT, { extra: OVERRIDE_FILES, workspaces: [{ name: "acme", config: { profile: "acme" } }] });
  const ws = s.ws.acme;
  const cfg = YAML.parse(await fs.readFile(path.join(ws, "craftar.yaml"), "utf8"));
  await fs.writeFile(path.join(ws, "craftar.yaml"), YAML.stringify({ ...cfg, recipes: { add: ["extra"] } }));
  await fs.rm(path.join(ws, ".claude/rules/style.md"));
  return { ...s, wsDir: ws };
}

describe("the override conflict (spec 56 §4.3)", () => {
  it("plan() stays total and records the pair; apply() writes nothing, dryRun included", async () => {
    const s = await conflicted();
    const ws = await loadWorkspace(s.wsDir);
    const p = await plan(ws);
    expect(p.overrideConflicts).toEqual([{ profile: "acme", override: "rule/y", variant: "rule/y-shared" }]);
    const st = await status(ws, p, await readLock(s.wsDir));
    await expect(apply(ws, p, st, { dryRun: true })).rejects.toThrow(LINE);
    await expect(apply(ws, p, st)).rejects.toThrow(LINE);
    expect(await exists(path.join(s.wsDir, ".claude/rules/style.md"))).toBe(false);
  });

  it.each([
    [["sync"]],
    [["sync", "--check"]],
    [["status"]],
    [["status", "--json"]],
    [["diff", "--exit-code"]],
    [["drift", "show"]],
    [["drift", "show", "--json"]],
    [["settings", "apply", "--yes"]],
  ])("craftar %j exits 1 naming the pair", async (args) => {
    const s = await conflicted();
    const r = runCli([...args, "--workspace", s.wsDir]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain(LINE);
    expect(await exists(path.join(s.wsDir, ".claude/rules/style.md"))).toBe(false);
  });

  it("drift discard refuses before writing, naming the pair", async () => {
    const s = await conflicted();
    await fs.writeFile(path.join(s.wsDir, ".claude/rules/y.md"), "# edited\n");
    const r = runCli(["drift", "discard", ".claude/rules/y.md", "--workspace", s.wsDir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(LINE);
    expect(await fs.readFile(path.join(s.wsDir, ".claude/rules/y.md"), "utf8")).toBe("# edited\n");
  });

  it("doctor reports it as an error of the status check", async () => {
    const s = await conflicted();
    const r = runCli(["doctor", "--json", "--workspace", s.wsDir]);
    expect(r.code).toBe(1);
    const checks = (JSON.parse(r.stdout) as { checks: Array<{ id: string; level: string; message: string }> }).checks;
    expect(checks).toContainEqual(expect.objectContaining({ id: "status", level: "error", message: LINE }));
  });

  it("doctor reports it on a workspace that was never synced too", async () => {
    const s = await build(cleanups, { ...CONFLICT, profiles: [profile("acme", ["base", "extra"]), profile("globex", ["base"])] }, { extra: OVERRIDE_FILES, workspaces: [{ name: "acme", config: { profile: "acme" }, sync: false }] });
    const r = runCli(["doctor", "--json", "--workspace", s.ws.acme]);
    expect(r.code).toBe(1);
    const checks = (JSON.parse(r.stdout) as { checks: Array<{ id: string; level: string; message: string }> }).checks;
    expect(checks).toContainEqual(expect.objectContaining({ id: "status", level: "error", message: LINE }));
  });

  it("workspaces and forge impact show the workspace as error with the one-line summary", async () => {
    const s = await conflicted();
    // The registry is this file's (one per test file): earlier tests' workspaces read `missing` once removed.
    const real = await fs.realpath(s.wsDir);
    const w = JSON.parse(runCli(["workspaces", "--json"]).stdout) as { workspaces: Array<{ path: string; status: string }>; warnings: string[] };
    expect(w.workspaces.find((x) => x.path === real)?.status).toBe("error");
    expect(w.warnings.filter((x) => x.includes(real) && x.endsWith(`: sync refused: ${LINE}`))).toHaveLength(1);
    const i = runCli(["forge", "impact", "--forge", s.forge, "--json"]);
    const irow = (JSON.parse(i.stdout) as { workspaces: Array<{ state: string; error: string | null }> }).workspaces[0];
    expect(irow).toMatchObject({ state: "error", error: `sync refused: ${LINE}` });
  });

  it("add recipe's next sync: reads refused with the pair", async () => {
    const s = await build(cleanups, CONFLICT, { extra: OVERRIDE_FILES, workspaces: [{ name: "acme", config: { profile: "acme" } }] });
    const r = runCli(["add", "recipe", "extra", "--workspace", s.ws.acme]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`next sync: refused — ${LINE}`);
  });

  it("init writes craftar.yaml, then refuses the first sync with the pair (exit 1)", async () => {
    const s = await build(cleanups, { ...CONFLICT, profiles: [profile("acme", ["base", "extra"]), profile("globex", ["base"])] }, { extra: OVERRIDE_FILES });
    const dir = path.join(s.root, "new");
    const r = runCli(["init", "--forge", s.forge, "--profile", "acme", "--workspace", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(LINE);
    expect(r.stderr).toContain("craftar.yaml written, sync not run");
    expect(await exists(path.join(dir, "craftar.yaml"))).toBe(true);
    expect(await exists(path.join(dir, ".claude"))).toBe(false);
  });

  it("the sync tool of craftar mcp throws the refusal", async () => {
    const s = await conflicted();
    const merged = mergeWorkspaceConfig(YAML.parse(await fs.readFile(path.join(s.wsDir, "craftar.yaml"), "utf8")), null);
    await expect(mcpWriters(process.env.CRAFTAR_HOME!, false).sync(s.wsDir, merged, {})).rejects.toThrow(LINE);
  });

  it("craftar ui answers the workspace as refused", async () => {
    const s = await conflicted();
    const id = workspaceId(await fs.realpath(s.wsDir));
    const a = await get(`/api/workspaces/${id}`);
    expect((a.body as { refused: string | null }).refused).toBe(`sync refused: ${LINE}`);
  });

  it("without an override the 'two ingredients write … (last wins)' warning is unchanged and nothing is refused", async () => {
    const s = await build(cleanups, CONFLICT, { workspaces: [{ name: "acme", config: { profile: "acme", recipes: { add: ["extra"] } } }] });
    const p = await plan(await loadWorkspace(s.ws.acme));
    expect(p.overrideConflicts).toEqual([]);
    expect(p.warnings.some((w) => w.startsWith("two ingredients write .claude/rules/y.md"))).toBe(true);
  });
});

describe("the override conflict on the remaining surfaces (spec 56 §4.3)", () => {
  const PROFILES = [profile("acme", ["base", "extra"]), profile("globex", ["base"])];

  it("kiroReport answers not-computed with the one-line summary", async () => {
    const { kiroReport } = await import("../src/importers/kiro-report.js");
    const s = await build(cleanups, { ...CONFLICT, profiles: PROFILES }, { extra: OVERRIDE_FILES, workspaces: [{ name: "acme", config: { profile: "acme" }, sync: false }] });
    await fs.mkdir(path.join(s.ws.acme, ".kiro/steering"), { recursive: true });
    const k = await kiroReport({ workspaceRoot: s.ws.acme, forgeRoot: s.forge, profile: "acme", targets: ["claude-code", "kiro"] });
    expect(k).toEqual({ kind: "not-computed", message: `sync refused: ${LINE}` });
  });

  it("the interactive init's first sync: line reads refused with the pair", async () => {
    const { planInit } = await import("../src/core/init.js");
    const { confirmInit } = await import("../src/core/init-flow.js");
    const s = await build(cleanups, { ...CONFLICT, profiles: PROFILES }, { extra: OVERRIDE_FILES });
    const dir = path.join(s.root, "new");
    await fs.mkdir(dir);
    const init = await planInit(dir, { forge: s.forge, profile: "acme" });
    const said: string[] = [];
    await confirmInit(init, dir, { ask: async () => "", confirm: async () => "yes", say: (l: string) => void said.push(l) }, { sync: true });
    expect(said).toContain(`  first sync: refused — ${LINE}`);
  });

  it("craftar ui's writing sync route answers 409 with the summary, writing nothing", async () => {
    const { post } = await import("./helpers/ui.js");
    const s = await conflicted();
    const id = workspaceId(await fs.realpath(s.wsDir));
    const a = await get(`/api/workspaces/${id}`, { allowWrites: true });
    const digest = (a.body as { digest: string }).digest;
    const r = await post(`/api/workspaces/${id}/sync`, { digest });
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toBe(`sync refused: ${LINE}`);
    expect(await exists(path.join(s.wsDir, ".claude/rules/style.md"))).toBe(false);
  });

  it("sync --check --committed refuses it, naming the pair", async () => {
    const { git } = await import("./helpers/remote.js");
    const s = await conflicted();
    git(s.wsDir, "init", "-q", "-b", "main");
    git(s.wsDir, "add", "-A");
    git(s.wsDir, "commit", "-q", "-m", "ws");
    const r = runCli(["sync", "--check", "--committed", "--workspace", s.wsDir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(LINE);
  });
});
