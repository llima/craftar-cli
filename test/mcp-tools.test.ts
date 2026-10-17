import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { makeForge, makeWorkspace, profile, recipe, rule, scenario, tmpDir, writeFiles } from "./helpers/forge.js";
import { DOTNET_MISSING } from "../src/core/templates.js";
import { session } from "./helpers/mcp.js";
import { remoteForge } from "./helpers/remote.js";
import { MCP_FILES, eightStates, explained, mcpWorkspace, moveTracker, syncOnce, type Scenario } from "./helpers/states.js";
import { catalogueContext, listIngredients, listRecipes } from "../src/core/catalogue.js";
import { renderDiff } from "../src/core/diff.js";
import { PIN_CHANGED } from "../src/core/mcp-protocol.js";
import { statusReport } from "../src/core/report.js";
import { defaultGit, type GitRunner } from "../src/core/remote.js";
import { loadWorkspace, plan, readLock, readWorkspaceConfig, status } from "../src/core/sync.js";

// Spec 35 §4.4–§4.6, §6, §7, §10.2 — the seven tools, the pin, what a result never holds.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends { cleanup: () => Promise<unknown> }>(s: T): T => (cleanups.push(s.cleanup), s);
const R = ".claude/rules";
const BASE = { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"]), profile("globex", ["base"])] };
const one = async (name: string, s: Awaited<ReturnType<typeof session>>, args?: Record<string, unknown>) => {
  const a = await s.tool(name, args);
  expect(a.rpcError).toBeUndefined();
  return a;
};
/** A tool's answer is its object twice: as structuredContent and as one compact text block. */
const data = (a: Awaited<ReturnType<typeof one>>) => {
  expect(a.isError).toBeUndefined();
  expect(a.content).toEqual([{ type: "text", text: JSON.stringify(a.structuredContent) }]);
  return a.structuredContent;
};
const failed = (a: Awaited<ReturnType<typeof one>>) => {
  expect(a.isError).toBe(true);
  expect(a.structuredContent).toBeUndefined();
  expect(a.content).toHaveLength(1);
  return a.content[0].text;
};

describe("the tools answer with the commands' data (a path Forge)", () => {
  it("status: the object statusReport builds, key for key", async () => {
    const s = kept(await eightStates());
    const m = await session(s.wsRoot);
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const want = JSON.parse(JSON.stringify(statusReport(ws, p, lock, await status(ws, p, lock))));
    const got = data(await one("status", m));
    expect(got).toEqual(want);
    expect(Object.keys(got)).toEqual(["forge", "statuses", "warnings", "unsetParams"]);
    expect(got.statuses.map((x: any) => x.state)).toEqual(["adopt", "collision", "drift", "new", "orphan-drift", "orphan", "unchanged", "update"]);
    expect(JSON.stringify(got)).not.toContain('"planned"');
  });

  it("recipes and ingredients: the listing of the workspace's context; recipe, type and both narrow ingredients", async () => {
    const s = kept(await eightStates());
    const m = await session(s.wsRoot);
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const ctx = () => catalogueContext(ws.forge, { kind: "workspace", config: ws.config });
    expect(data(await one("recipes", m))).toEqual(listRecipes(ws.forge, ctx()));
    expect(data(await one("ingredients", m))).toEqual(listIngredients(ws.forge, ctx()));
    expect(data(await one("ingredients", m, { recipe: "base" }))).toEqual(listIngredients(ws.forge, ctx(), { recipe: "base" }));
    expect(data(await one("ingredients", m, { type: "rule" })).ingredients).toHaveLength(8);
    expect(data(await one("ingredients", m, { type: "mcp" })).ingredients).toEqual([]);
    expect(data(await one("ingredients", m, { recipe: "base", type: "rule" })).ingredients.map((i: any) => i.name)).toEqual(["adopted", "clash", "edited", "fresh", "keep", "moved"]);
  });

  it("an unknown type or recipe is a tool error with the core's message", async () => {
    const s = kept(await eightStates());
    const m = await session(s.wsRoot);
    expect(failed(await one("ingredients", m, { type: "widget" }))).toBe('unknown ingredient type "widget" — one of rule, agent, command, skill, mcp, script, steering, hook, service');
    expect(failed(await one("ingredients", m, { recipe: "nope" }))).toBe('recipe "nope" not found in this Forge (base)');
  });

  it("targets: the matrix with the targets in use marked, and no load warning", async () => {
    const s = kept(await eightStates());
    await fs.appendFile(path.join(s.wsRoot, "craftar.yaml"), "ref: v1\n");
    const got = data(await one("targets", await session(s.wsRoot)));
    expect(Object.keys(got)).toEqual(["ingredientTypes", "targets", "warnings"]);
    expect(got.targets.map((t: any) => [t.name, t.inUse])).toEqual([["claude-code", true], ["kiro", false], ["agents-md", false]]);
    expect(got.warnings).toEqual([]);
  });

  it("status and diff on a workspace whose sync is refused: not an error, the key in unsetParams", async () => {
    const s = kept(await scenario({ ingredients: [rule("api", "port {{api.port}}\n", { params: { "api.port": {} } })], recipes: [recipe("base", ["rule/api"])], profiles: [profile("acme", ["base"])] }, { config: { profile: "acme" } }));
    const m = await session(s.wsRoot);
    const unset = [{ key: "api.port", declaredBy: ["rule/api"], citedBy: ["rule/api"] }];
    expect(data(await one("status", m)).unsetParams).toEqual(unset);
    expect(data(await one("diff", m)).unsetParams).toEqual(unset);
  });
});

describe("diff", () => {
  it("without path: the six pending files with counts and no body", async () => {
    const s = kept(await eightStates());
    const got = data(await one("diff", await session(s.wsRoot)));
    expect(got).toEqual({
      files: [
        { path: `${R}/clash.md`, state: "collision", added: 1, removed: 1, diff: null, note: null },
        { path: `${R}/edited.md`, state: "drift", added: 1, removed: 1, diff: null, note: null },
        { path: `${R}/fresh.md`, state: "new", added: 1, removed: 0, diff: null, note: null },
        { path: `${R}/gone-edited.md`, state: "orphan-drift", added: null, removed: null, diff: null, note: "no longer produced by the Forge but hand-edited — kept; `craftar drift discard <path>` removes it, or delete it yourself" },
        { path: `${R}/gone.md`, state: "orphan", added: 0, removed: 1, diff: null, note: null },
        { path: `${R}/moved.md`, state: "update", added: 1, removed: 1, diff: null, note: null },
      ],
      warnings: [],
      unsetParams: [],
    });
  });

  it("with path: the body renderDiff gives, no header line, no colour; ./ and backslashes select the same row", async () => {
    const s = kept(await eightStates());
    const m = await session(s.wsRoot);
    const want = { files: [{ path: `${R}/edited.md`, state: "drift", added: 1, removed: 1, diff: "  # Edited\n- by hand\n+ by the forge", note: null }], warnings: [], unsetParams: [] };
    expect(renderDiff("# Edited\nby hand\n", "# Edited\nby the forge\n")).toBe("  # Edited\n- by hand\n+ by the forge");
    expect(data(await one("diff", m, { path: `${R}/edited.md` }))).toEqual(want);
    expect(data(await one("diff", m, { path: `./${R}/edited.md` }))).toEqual(want);
    expect(data(await one("diff", m, { path: ".\\.claude\\rules\\edited.md" }))).toEqual(want);
    expect(data(await one("diff", m, { path: `${R}/gone.md` })).files[0].diff).toBe("- # Gone");
    expect(data(await one("diff", m, { path: `${R}/fresh.md` })).files[0].diff).toBe("+ # Fresh");
    expect(data(await one("diff", m, { path: `${R}/keep.md` })).files).toEqual([]);
    expect(data(await one("diff", m, { path: `${R}/adopted.md` })).files).toEqual([]);
  });

  it.each(["drift", "collision"] as const)("the three MCP files in %s: a note, no body, and nothing of the disk in the result", async (state) => {
    const s = kept(await mcpWorkspace());
    if (state === "drift") {
      await syncOnce(s.wsRoot);
      for (const f of MCP_FILES) await fs.appendFile(path.join(s.wsRoot, f), "MARKER-7f3a\n");
    } else for (const f of MCP_FILES) await fs.mkdir(path.dirname(path.join(s.wsRoot, f)), { recursive: true }).then(() => fs.writeFile(path.join(s.wsRoot, f), '{ "token": "MARKER-7f3a" }\n'));
    const m = await session(s.wsRoot);
    const note = "content not shown: an MCP configuration file may hold a value typed by hand";
    for (const f of MCP_FILES) {
      const a = await one("diff", m, { path: f });
      expect(data(a).files).toEqual([{ path: f, state, added: null, removed: null, diff: null, note }]);
      expect(JSON.stringify(a)).not.toContain("MARKER-7f3a");
    }
    const all = await one("diff", m);
    expect(data(all).files.filter((x: any) => x.note === note).map((x: any) => x.path).sort()).toEqual([...MCP_FILES].sort());
    expect(JSON.stringify(all)).not.toContain("MARKER-7f3a");
  });

  it("the three MCP files in update: the body is returned (the disk side is what craftar wrote)", async () => {
    const s = kept(await mcpWorkspace());
    await syncOnce(s.wsRoot);
    await moveTracker(s.forgeRoot);
    const m = await session(s.wsRoot);
    for (const f of [".mcp.json", ".kiro/settings/mcp.json"]) {
      const file = data(await one("diff", m, { path: f })).files[0];
      expect([file.state, file.added, file.removed, file.note]).toEqual(["update", 1, 1, null]);
      expect(file.diff).toContain('-         "acme-mcp"\n+         "acme-mcp@2"');
    }
    expect(data(await one("diff", m, { path: MCP_FILES[2] })).files).toEqual([]);
  });
});

describe("explain", () => {
  it("a templated rule, an imported one, AGENTS.md and .mcp.json", async () => {
    const s = kept(await explained());
    const m = await session(s.wsRoot);
    expect(data(await one("explain", m, { path: `${R}/api.md` }))).toEqual({
      path: `${R}/api.md`,
      target: "claude-code",
      ingredient: "rule/api",
      origin: null,
      via: ["stack-node"],
      sections: [{ name: "review", layer: "profile" }],
      params: [
        { key: "api.port", layer: "default" },
        { key: "region", layer: "workspace" },
        { key: "team", layer: { profile: "acme" } },
      ],
      profile: "acme",
      recipes: ["base", "stack-node"],
      hash: "sha256:e850fe1c8108a9d898a4557335d8b92b3fb82f57e775cc5695707e53503c891b",
      warnings: [],
    });
    const legacy = data(await one("explain", m, { path: `./${R}/legacy.md` }));
    expect([legacy.path, legacy.origin, legacy.via]).toEqual([`${R}/legacy.md`, { workspace: "acme-portal", path: ".claude/rules/legacy.md" }, ["base"]]);
    const agents = data(await one("explain", m, { path: "AGENTS.md" }));
    expect(agents).toMatchObject({ target: "agents-md", ingredient: "rule/*", origin: null, via: null, sections: [], params: [] });
    const t = kept(await mcpWorkspace());
    expect(data(await one("explain", await session(t.wsRoot), { path: ".mcp.json" }))).toMatchObject({ target: "claude-code", ingredient: "mcp/*", origin: null, via: null, sections: [], params: [] });
  });

  it("a path the Forge does not produce is a tool error, the path as it was given", async () => {
    const s = kept(await explained());
    expect(failed(await one("explain", await session(s.wsRoot), { path: `./${R}/nope.md` }))).toBe(`./${R}/nope.md is not produced by the Forge for profile acme`);
  });
});

describe("an argument is never a path", () => {
  it("../outside, an absolute path and an unmanaged file are tool errors, and none is read", async () => {
    const s = kept(await eightStates());
    const outside = path.join(s.root, "outside.txt");
    await fs.writeFile(outside, "SENTINEL-OUTSIDE\n");
    await fs.writeFile(path.join(s.wsRoot, "notes.md"), "SENTINEL-NOTES\n");
    const m = await session(s.wsRoot);
    const read = vi.spyOn(fs, "readFile");
    const unmanaged = (p: string) => `${p} is not a file craftar manages in this workspace — pass the workspace-relative path as \`craftar status\` prints it (forward slashes)`;
    for (const p of ["../outside.txt", outside, "notes.md"]) {
      const d = await one("diff", m, { path: p });
      expect(failed(d)).toBe(unmanaged(p));
      const e = await one("explain", m, { path: p });
      expect(failed(e)).toBe(`${p} is not produced by the Forge for profile acme`);
      expect(JSON.stringify([d, e])).not.toContain("SENTINEL");
    }
    const seen = read.mock.calls.map((c) => String(c[0]));
    expect(seen.filter((f) => f === outside || f.endsWith("notes.md"))).toEqual([]);
    expect(seen.some((f) => f.endsWith("craftar.yaml"))).toBe(true);
  });
});

describe("warnings", () => {
  it("a ref beside a path Forge and a local forge: override: once each, in the five tools; never in targets", async () => {
    const s = kept(await eightStates());
    await fs.appendFile(path.join(s.wsRoot, "craftar.yaml"), "ref: v1\n");
    await fs.writeFile(path.join(s.wsRoot, "craftar.local.yaml"), "forge: ../forge\n");
    const m = await session(s.wsRoot);
    const want = ['ref "v1" is ignored: the Forge is a path (../forge), read as its working tree', "Forge overridden by craftar.local.yaml (../forge) — do not commit craftar.lock or the generated files"];
    for (const [name, args] of [["status"], ["diff"], ["explain", { path: `${R}/keep.md` }], ["recipes"], ["ingredients"]] as const)
      expect(data(await one(name, m, args as any)).warnings, name).toEqual(want);
    expect(data(await one("targets", m)).warnings).toEqual([]);
  });

  async function remote(ref?: string) {
    const r = kept(await remoteForge(BASE));
    const ws = await tmpDir();
    cleanups.push(() => fs.rm(ws, { recursive: true, force: true }));
    await fs.writeFile(path.join(ws, "craftar.yaml"), YAML.stringify({ forge: r.url, profile: "acme", ...(ref ? { ref } : {}) }));
    await syncOnce(ws); // fetches: fills the cache
    return { r, ws };
  }

  it("a remote Forge without --fetch: the cached-copy line first, with the commit and the fetch time; no git call reaches the remote", async () => {
    const { r, ws } = await remote();
    const calls: string[][] = [];
    const git: GitRunner = (args, o) => (calls.push(args), defaultGit(args, o));
    const m = await session(ws, { git });
    const nf = await loadWorkspace(ws, { mode: "no-fetch", home: process.env.CRAFTAR_HOME });
    expect(nf.origin.fetchedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const line = `Forge ${r.url} read from the copy cached ${nf.origin.fetchedAt} (commit ${nf.forge.commit!.slice(0, 8)}) — craftar mcp was started without --fetch`;
    await r.commit({ "ingredients/rules/keep/rule.md": "# Keep\nmoved on the remote\n" });
    for (const [name, args] of [["status"], ["diff"], ["explain", { path: `${R}/keep.md` }], ["recipes"], ["ingredients"]] as const)
      expect(data(await one(name, m, args as any)).warnings, name).toEqual([line]);
    const st = data(await one("status", m));
    expect([st.forge.fetched, st.forge.commit, st.statuses[0].state]).toEqual([false, nf.forge.commit, "unchanged"]);
    expect(data(await one("targets", m)).warnings).toEqual([]);
    const forge = data(await one("doctor", m)).checks.find((c: any) => c.id === "forge");
    expect(forge.message).toBe(`${r.url} @ main (default branch) ${nf.forge.commit!.slice(0, 8)}, cached ${nf.origin.fetchedAt}`);
    // (control) the seam is the one the loads use: it saw their local git calls — and none that reaches the remote
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((a) => a.includes("fetch") || a.includes("ls-remote"))).toEqual([]);
  });

  it("the stamp does not read as a time: (time unknown)", async () => {
    const { r, ws } = await remote();
    const forges = path.join(process.env.CRAFTAR_HOME!, "forges");
    for (const e of await fs.readdir(forges)) if (await fs.stat(path.join(forges, e, "fetched")).catch(() => null)) await fs.writeFile(path.join(forges, e, "fetched"), "not a time\n");
    const nf = await loadWorkspace(ws, { mode: "no-fetch", home: process.env.CRAFTAR_HOME });
    expect(data(await one("status", await session(ws))).warnings).toEqual([`Forge ${r.url} read from the copy cached (time unknown) (commit ${nf.forge.commit!.slice(0, 8)}) — craftar mcp was started without --fetch`]);
  });

  it("no cached-copy line under --fetch, nor for a full-SHA ref", async () => {
    const { r, ws } = await remote();
    expect(data(await one("status", await session(ws, { fetch: true }))).warnings).toEqual([]);
    const sha = (await loadWorkspace(ws, { mode: "no-fetch", home: process.env.CRAFTAR_HOME })).forge.commit!;
    await fs.writeFile(path.join(ws, "craftar.yaml"), YAML.stringify({ forge: r.url, profile: "acme", ref: sha }));
    expect(data(await one("status", await session(ws))).warnings).toEqual([]);
  });

  it("--fetch and the remote gone: the fallback warning, not the cached-copy line", async () => {
    const { r, ws } = await remote();
    await fs.rm(r.bare, { recursive: true, force: true });
    const w = data(await one("status", await session(ws, { fetch: true }))).warnings;
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(new RegExp(`^Forge ${r.url.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} not fetched \\(.*\\) — using the cached copy at [0-9a-f]{8}, fetched `));
  });
});

describe("doctor", () => {
  it("only the checks about this workspace, plus node and git; the summary counts what is returned", async () => {
    const s = kept(await mcpWorkspace());
    const gone = kept(await scenario(BASE, { config: { profile: "acme" } }));
    const { runCli } = await import("./helpers/cli.js");
    expect(runCli(["sync", "--workspace", gone.wsRoot]).code).toBe(0); // registers it
    const sentinel = `${gone.wsRoot}-SENTINEL-GONE`;
    await fs.rename(gone.wsRoot, sentinel);
    cleanups.push(() => fs.rm(sentinel, { recursive: true, force: true }));
    const secret = "ghp_" + "x".repeat(36);
    const a = await one("doctor", await session(s.wsRoot, { env: { OTHER: secret } }));
    const got = data(a);
    expect(Object.keys(got)).toEqual(["version", "workspace", "fetch", "strict", "checks", "summary"]);
    expect([got.version, got.fetch, got.strict]).toEqual(["0.0.0-test", false, false]);
    const ids = got.checks.map((c: any) => c.id);
    expect(ids.slice(0, 2)).toEqual(["node", "git"]);
    expect(ids.filter((i: string) => ["home", "registry", "cache"].includes(i))).toEqual([]);
    expect(got.checks.every((c: any) => c.scope === "workspace" || c.id === "node" || c.id === "git")).toBe(true);
    const count = (l: string) => got.checks.filter((c: any) => c.level === l).length;
    expect(got.summary).toEqual({ ok: count("ok"), warn: count("warn"), error: count("error") });
    expect(got.checks.find((c: any) => c.id === "mcp-env")).toMatchObject({ level: "warn", message: 'server "tracker" expects ACME_TOKEN, not set', fix: "export ACME_TOKEN" });
    const text = JSON.stringify(a);
    expect(text).not.toContain("SENTINEL-GONE");
    expect(text).not.toContain(secret);
    expect(text).not.toContain(process.env.CRAFTAR_HOME!);
  });

  it("CRAFTAR_NO_REGISTRY at launch: registered says registry off", async () => {
    const s = kept(await mcpWorkspace());
    const got = data(await one("doctor", await session(s.wsRoot, { registryOff: true })));
    expect(got.checks.find((c: any) => c.id === "registered")).toMatchObject({ level: "ok", message: "registry off" });
  });
});

describe("a workspace that does not load", () => {
  it("the Forge is gone: five tool errors, targets unmarked with a warning, doctor's config an error; repaired, status answers", async () => {
    const s = kept(await eightStates());
    const m = await session(s.wsRoot);
    await fs.rename(s.forgeRoot, `${s.forgeRoot}-away`);
    const msg = `Forge not found at ${s.forgeRoot}`;
    for (const [name, args] of [["status"], ["diff"], ["explain", { path: `${R}/keep.md` }], ["recipes"], ["ingredients"]] as const) expect(failed(await one(name, m, args as any)), name).toBe(msg);
    const t = data(await one("targets", m));
    expect(t.targets.map((x: any) => x.inUse)).toEqual([null, null, null]);
    expect(t.warnings).toEqual([`targets in use not shown: ${msg}`]);
    expect(data(await one("doctor", m)).checks.find((c: any) => c.id === "config")).toMatchObject({ level: "error", message: msg });
    await fs.rename(`${s.forgeRoot}-away`, s.forgeRoot);
    expect(data(await one("status", m)).statuses).toHaveLength(8);
  });

  it("a profile the Forge does not have: tool errors; one that does not resolve: context null and the warning", async () => {
    const s = kept(await scenario(BASE, { config: { profile: "acme" } }));
    const m = await session(s.wsRoot);
    await fs.rm(path.join(s.forgeRoot, "profiles/acme"), { recursive: true });
    for (const name of ["status", "diff", "recipes", "ingredients"]) expect(failed(await one(name, m)), name).toBe('profile "acme" not found in Forge (globex)');
    const t = kept(await scenario({ ...BASE, profiles: [profile("acme", ["base", "missing"])] }, { config: { profile: "acme" } }));
    const n = await session(t.wsRoot);
    const why = 'cannot resolve this workspace (profile acme): recipe "missing" not found (referenced by profile acme) — nothing is marked as in use';
    for (const name of ["recipes", "ingredients"]) {
      const got = data(await one(name, n));
      expect([got.context, got.warnings], name).toEqual([null, [why]]);
    }
    expect(failed(await one("status", n))).toBe('recipe "missing" not found (referenced by profile acme)');
  });

  it("craftar.yaml deleted mid-session: a tool error for every tool but targets, doctor included; restored, the tools answer", async () => {
    const s = kept(await eightStates());
    const m = await session(s.wsRoot);
    const file = path.join(s.wsRoot, "craftar.yaml");
    const text = await fs.readFile(file, "utf8");
    await fs.rm(file);
    for (const [name, args] of [["status"], ["diff"], ["explain", { path: `${R}/keep.md` }], ["recipes"], ["ingredients"], ["doctor"]] as const)
      expect(failed(await one(name, m, args as any)), name).toMatch(/^craftar\.yaml not found in /);
    const t = data(await one("targets", m));
    expect(t.targets.map((x: any) => x.inUse)).toEqual([null, null, null]);
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0]).toMatch(/^targets in use not shown: craftar\.yaml not found in /);
    await fs.writeFile(file, text);
    expect(data(await one("status", m)).statuses).toHaveLength(8);
  });
});

describe("the pin", () => {
  const TOOLS = [["status"], ["diff"], ["explain", { path: `${R}/keep.md` }], ["recipes"], ["ingredients"], ["doctor"]] as const;
  async function pinned() {
    const s = kept(await scenario(BASE, { config: { profile: "acme" } }));
    const other = path.join(s.root, "forge-SENTINEL-OTHER");
    await fs.cp(s.forgeRoot, other, { recursive: true });
    const calls: string[][] = [];
    const git: GitRunner = (args, o) => (calls.push(args), defaultGit(args, o));
    return { s, calls, m: await session(s.wsRoot, { git }), yaml: path.join(s.wsRoot, "craftar.yaml"), local: path.join(s.wsRoot, "craftar.local.yaml") };
  }
  const refused = async (m: Awaited<ReturnType<typeof session>>) => {
    for (const [name, args] of TOOLS) {
      const a = await one(name, m, args as any);
      expect(failed(a), name).toBe(PIN_CHANGED);
      expect(JSON.stringify(a)).not.toMatch(/SENTINEL|globex|v9/);
    }
    const t = data(await one("targets", m));
    expect(t.targets.map((x: any) => x.inUse)).toEqual([null, null, null]);
    expect(t.warnings).toEqual([`targets in use not shown: ${PIN_CHANGED}`]);
  };

  it("the message is the spec's, and holds no value", () => {
    expect(PIN_CHANGED).toBe("the Forge or the profile of this workspace changed since craftar mcp started (forge, ref or profile in craftar.yaml / craftar.local.yaml) — restart the server to read the new one");
  });

  it.each([
    ["forge: in craftar.yaml points at a second Forge", (x: any) => fs.writeFile(x.yaml, YAML.stringify({ forge: "../forge-SENTINEL-OTHER", profile: "acme" }))],
    ["a craftar.local.yaml appears with another forge:", (x: any) => fs.writeFile(x.local, YAML.stringify({ forge: "../forge-SENTINEL-OTHER" }))],
    ["a URL forge: (nothing is fetched)", (x: any) => fs.writeFile(x.yaml, YAML.stringify({ forge: "https://example.com/SENTINEL.git", profile: "acme" }))],
    ["ref changes", (x: any) => fs.appendFile(x.yaml, "ref: v9\n")],
    ["profile names another profile of the same Forge", (x: any) => fs.writeFile(x.yaml, YAML.stringify({ forge: "../forge", profile: "globex" }))],
  ])("%s: every tool but targets stops, no git call, and restoring the value brings them back", async (_n, edit) => {
    const x = await pinned();
    const before = await fs.readFile(x.yaml, "utf8");
    await edit(x);
    await refused(x.m);
    expect(x.calls).toEqual([]);
    await fs.writeFile(x.yaml, before);
    await fs.rm(x.local, { force: true });
    expect(data(await one("status", x.m)).statuses).toHaveLength(1);
  });

  it("an edit of recipes in craftar.yaml is not pinned: the next call reads it", async () => {
    const x = await pinned();
    await fs.appendFile(x.yaml, "recipes:\n  remove: [base]\n");
    expect(data(await one("status", x.m)).statuses).toEqual([]);
  });

  it("one read per call, and the call loads the configuration it checked", async () => {
    const x = await pinned();
    let n = 0;
    const m = await session(x.s.wsRoot, { readConfig: async (root) => (n++, readWorkspaceConfig(root)) });
    for (const [name, args] of [...TOOLS, ["targets"]] as const) {
      n = 0;
      const read = vi.spyOn(fs, "readFile");
      await one(name, m, args as any);
      expect(n, name).toBe(1);
      expect(read.mock.calls.filter((c) => String(c[0]).endsWith("craftar.yaml")), name).toHaveLength(1);
      read.mockRestore();
    }
    // Swapped right after the read: the wrapper returns what it read, then rewrites the file. The call must not load the second Forge.
    await fs.writeFile(path.join(x.s.root, "forge-SENTINEL-OTHER/ingredients/rules/keep/rule.md"), "# SENTINEL-SWAPPED\n");
    const before = await fs.readFile(x.yaml, "utf8");
    const swap = await session(x.s.wsRoot, {
      readConfig: async (root) => {
        const merged = await readWorkspaceConfig(root);
        await fs.writeFile(x.yaml, YAML.stringify({ forge: "../forge-SENTINEL-OTHER", profile: "acme" }));
        return merged;
      },
    });
    const a = await one("diff", swap, { path: `${R}/keep.md` });
    expect(data(a).files).toEqual([{ path: `${R}/keep.md`, state: "new", added: 1, removed: 0, diff: "+ # Keep", note: null }]);
    expect(JSON.stringify(a)).not.toContain("SENTINEL");
    await fs.writeFile(x.yaml, before);
  });
});

describe("doctor — the checks 0.25–0.27 added, through injected runners", () => {
  // Fixture: one Forge and workspace with a rule, one service ingredient, and a templates block with an installable dotnet-new entry
  const serviceCompose = `services:
  echo:
    image: alpine
    environment:
      TOKEN: \${ACME_TOKEN}
`;
  const service = (name: string) => ({
    meta: { type: "service", name },
    files: { "compose.yaml": serviceCompose },
  });
  const API = { kind: "dotnet-new", source: "https://pkgs.example.com/acme/nuget/v3/index.json", packages: ["Acme.Templates.Api"] };
  async function fixtureWithServiceAndTemplates() {
    const root = await tmpDir("craftar-mcp-doctor-seams-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeRoot = path.join(root, "forge");
    const ws = path.join(root, "ws");
    await makeForge(forgeRoot, {
      ingredients: [
        rule("style", "# Style\n"),
        service("echo"),
      ],
      recipes: [recipe("base", ["rule/style", "service/echo"])],
      profiles: [profile("acme", ["base"], ["claude-code"], { templates: [API] })],
    });
    await makeWorkspace(ws, forgeRoot, { config: { profile: "acme" } });
    // sync once so there is a lock
    await syncOnce(ws);
    return { root, forgeRoot, ws };
  }

  it("the tool returns the docker, services-env, templates and dotnet checks, from the injected runners", async () => {
    const f = await fixtureWithServiceAndTemplates();
    const calls: string[] = [];
    const s = await session(f.ws, {
      nodeVersion: "22.11.0",
      gitVersion: async () => (calls.push("git --version"), "2.53.0"),
      dotnetVersion: async () => (calls.push("dotnet --version"), "10.0.401"),
      dockerRunner: async (file, args) => (calls.push([file, ...args].join(" ")), { code: 0, stdout: "v2.30.0\n", stderr: "" }),
    });
    const report = data(await one("doctor", s));
    const of = (id: string) => report.checks.filter((c: { id: string }) => c.id === id);

    // Each runner called exactly once
    expect([...calls].sort()).toEqual(["docker compose version --short", "dotnet --version", "git --version"]);

    // All four checks present
    expect(of("docker").length).toBeGreaterThanOrEqual(1);
    expect(of("dotnet").length).toBeGreaterThanOrEqual(1);
    expect(of("templates").length).toBeGreaterThanOrEqual(1);
    expect(of("services-env").length).toBeGreaterThanOrEqual(1);

    // Messages contain the injected versions
    expect(of("docker")[0].message).toContain("2.30.0");
    expect(of("dotnet")[0].message).toContain("10.0.401");
    expect(of("git")[0].message).toContain("2.53.0");
    expect(report.checks.find((c: { id: string }) => c.id === "node").message).toContain("22.11.0");

    // workspaceReport keeps scope=workspace plus node and git (the real rule from doctor.ts)
    for (const c of report.checks) {
      expect(c.scope === "workspace" || c.id === "node" || c.id === "git").toBe(true);
    }
  });

  it("a runner that finds nothing is reported, not thrown", async () => {
    const f = await fixtureWithServiceAndTemplates();
    const s = await session(f.ws, {
      nodeVersion: "22.11.0",
      gitVersion: async () => "2.53.0",
      dotnetVersion: async () => null,
      dockerRunner: async () => ({ code: 127, stdout: "", stderr: "" }),
    });
    const report = data(await one("doctor", s)); // data() asserts the answer is not an error
    const of = (id: string) => report.checks.filter((c: { id: string }) => c.id === id);

    // dotnet missing: the message is DOTNET_MISSING from templates.ts
    expect(of("dotnet")[0].message).toBe(DOTNET_MISSING);

    // docker: the level is warn when compose is not found (code 127)
    expect(of("docker")[0].level).toBe("warn");
    expect(of("docker")[0].message).toBe("the docker compose plugin is missing");
  });

  it("without a service or a templates block the runners are not called", async () => {
    // Use BASE shape: rule only, no service, no templates
    const s = kept(await scenario(BASE, { config: { profile: "acme" } }));
    await syncOnce(s.wsRoot);
    const calls: string[] = [];
    const m = await session(s.wsRoot, {
      nodeVersion: "22.11.0",
      gitVersion: async () => (calls.push("git --version"), "2.53.0"),
      dotnetVersion: async () => (calls.push("dotnet --version"), "10.0.401"),
      dockerRunner: async (file, args) => (calls.push([file, ...args].join(" ")), { code: 0, stdout: "v2.30.0\n", stderr: "" }),
    });
    const report = data(await one("doctor", m));
    const of = (id: string) => report.checks.filter((c: { id: string }) => c.id === id);

    // Only git runner called (git is always probed)
    expect(calls).toEqual(["git --version"]);

    // None of the service/templates checks present
    expect(of("docker")).toEqual([]);
    expect(of("dotnet")).toEqual([]);
    expect(of("templates")).toEqual([]);
    expect(of("services-env")).toEqual([]);
  });
});
