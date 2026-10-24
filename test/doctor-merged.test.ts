import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { tmpDir } from "./helpers/forge.js";
import { remoteForge } from "./helpers/remote.js";
import { TRACKER, mcpWorkspace, syncOnce } from "./helpers/states.js";
import { runDoctor, workspaceReport, type DoctorOptions } from "../src/core/doctor.js";
import { defaultGit, type GitRunner } from "../src/core/remote.js";
import { readWorkspaceConfig } from "../src/core/sync.js";

// Spec 35 §5.1 (doctor): a configuration already read, a git seam for the load, and the report of one workspace.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends { cleanup: () => Promise<unknown> }>(s: T): T => (cleanups.push(s.cleanup), s);
const opts = (workspace: string, over: Partial<DoctorOptions> = {}): DoctorOptions => ({
  version: "0.0.0-test",
  home: process.env.CRAFTAR_HOME!,
  workspace,
  fetch: false,
  strict: false,
  registryOff: false,
  env: {},
  nodeVersion: "22.0.0",
  gitVersion: async () => "2.40.0",
  ...over,
});
const ALL = ["node", "git", "home", "registry", "cache", "config", "forge", "forge-inside", "plan", "params", "mcp-env", "mcp-launcher", "lock", "registered"];
const check = (r: { checks: Array<{ id: string; level: string; message: string }> }, id: string) => r.checks.find((c) => c.id === id)!;

describe("runDoctor with a configuration already read", () => {
  it("(control) without the new inputs the report is today's", async () => {
    const s = kept(await mcpWorkspace());
    const r = await runDoctor(opts(s.wsRoot));
    expect(r.checks.map((c) => c.id)).toEqual(ALL);
    expect(r.checks[0]).toEqual({ id: "node", scope: "machine", level: "ok", message: "22.0.0", fix: null });
  });

  it("merged replaces the read: craftar.yaml may be gone and the checks still run", async () => {
    const s = kept(await mcpWorkspace());
    const merged = await readWorkspaceConfig(s.wsRoot);
    await fs.rm(path.join(s.wsRoot, "craftar.yaml"));
    const r = await runDoctor(opts(s.wsRoot, { merged }));
    expect(check(r, "config")).toMatchObject({ level: "ok", message: "craftar.yaml loads (forge ../forge, profile acme)" });
    expect(check(r, "plan")).toMatchObject({ level: "ok", message: "5 files" });
    const without = await runDoctor(opts(s.wsRoot));
    expect(check(without, "config").level).toBe("error");
    expect(check(without, "config").message).toMatch(/^craftar\.yaml not found in /);
  });

  it("merged is the configuration that loads, whatever the file says by then", async () => {
    const s = kept(await mcpWorkspace());
    const other = path.join(s.root, "forge-b");
    await fs.cp(s.forgeRoot, other, { recursive: true });
    await fs.writeFile(path.join(other, "profiles/acme/profile.yaml"), YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code"] }));
    const merged = await readWorkspaceConfig(s.wsRoot);
    await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), YAML.stringify({ forge: "../forge-b", profile: "acme" }));
    expect(check(await runDoctor(opts(s.wsRoot, { merged })), "plan").message).toBe("5 files");
    expect(check(await runDoctor(opts(s.wsRoot)), "plan").message).toBe("3 files");
  });

  it("git reaches the load: no call to the remote without fetch, one with it", async () => {
    const r = kept(await remoteForge({ ingredients: [TRACKER], recipes: [{ name: "base", ingredients: ["mcp/tracker"] }], profiles: [{ name: "acme", recipes: ["base"], targets: ["claude-code"] }] }));
    const ws = await tmpDir();
    cleanups.push(() => fs.rm(ws, { recursive: true, force: true }));
    await fs.writeFile(path.join(ws, "craftar.yaml"), YAML.stringify({ forge: r.url, profile: "acme" }));
    await syncOnce(ws); // fetches: fills the cache
    const calls: string[][] = [];
    const git: GitRunner = (args, o) => (calls.push(args), defaultGit(args, o));
    const remoteCalls = () => calls.filter((a) => a.includes("fetch") || a.includes("ls-remote"));
    const offline = await runDoctor(opts(ws, { git }));
    expect(check(offline, "forge").level).toBe("ok");
    expect(calls.length).toBeGreaterThan(0);
    expect(remoteCalls()).toEqual([]);
    calls.length = 0;
    const fetched = await runDoctor(opts(ws, { git, fetch: true }));
    expect(check(fetched, "forge").message).toMatch(/, fetched now$/);
    expect(remoteCalls().length).toBeGreaterThan(0);
  });
});

describe("workspaceReport", () => {
  it("keeps the checks about the workspace plus node and git, and recounts the summary", async () => {
    const s = kept(await mcpWorkspace());
    const report = await runDoctor(opts(s.wsRoot));
    const n = report.checks.length;
    const w = workspaceReport(report);
    expect(w.checks.map((c) => c.id)).toEqual(ALL.filter((id) => !["home", "registry", "cache"].includes(id)));
    expect(w.summary.ok + w.summary.warn + w.summary.error).toBe(w.checks.length);
    expect(w.summary).toEqual({ ok: 9, warn: 2, error: 0 });
    expect([w.version, w.workspace, w.fetch, w.strict]).toEqual([report.version, report.workspace, report.fetch, report.strict]);
    expect(Object.keys(w)).toEqual(["version", "workspace", "fetch", "strict", "checks", "summary"]);
    expect(report.checks).toHaveLength(n); // the input is not touched
    expect(report.summary.ok + report.summary.warn + report.summary.error).toBe(n);
  });

  it("filters by scope, not by a list of ids", async () => {
    const s = kept(await mcpWorkspace());
    const report = await runDoctor(opts(s.wsRoot));
    const w = workspaceReport({
      ...report,
      checks: [
        ...report.checks,
        { id: "acme-new", scope: "workspace", level: "warn", message: "m", fix: null },
        { id: "acme-machine", scope: "machine", level: "error", message: "m", fix: null },
      ],
    });
    expect(w.checks.map((c) => c.id)).toContain("acme-new");
    expect(w.checks.map((c) => c.id)).not.toContain("acme-machine");
    expect(w.summary).toEqual({ ok: 9, warn: 3, error: 0 });
  });
});
