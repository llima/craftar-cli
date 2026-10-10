import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor, type Check, type DoctorOptions } from "../src/core/doctor.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, type ForgeSpec } from "./helpers/forge.js";

// Spec 32 §4.3 — the two doctor checks a profile's `templates` key adds. The dotnet probe is injected; the one CLI
// test empties PATH so the real dotnet cannot start.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const M = ["ZZ", "MARKER", "ZZ"].join("");
const SOURCE = "https://pkgs.example.com/acme/nuget/v3/index.json";
const API = { kind: "dotnet-new", source: SOURCE, packages: ["Acme.Templates.Api", "Acme.Templates.Front::2.1.0"] };
const TOOLS = { kind: "dotnet-new", packages: ["Acme.Tools"] };
const NPM = { kind: "npm-create" };
const NUGET = { "NuGet.Config": "<configuration />\n" };
const FEED = (positions: string) =>
  `a source is declared (${positions}) and the workspace root has no NuGet.Config — dotnet adds a declared source to the feeds it already uses, it does not replace them (craftar looks at the workspace root only; NuGet also reads parent directories and the user's configuration)`;
const FIX_FEED = "add a NuGet.Config at the workspace root that pins the feed, or ignore this when NuGet is configured above the workspace or for the user";
const FIX_REFUSED = "fix the templates block: only craftar templates reads it";

const forgeWith = (extra: Record<string, unknown>): ForgeSpec => ({
  ingredients: [rule("style", "# Style\n")],
  recipes: [recipe("base", ["rule/style"])],
  profiles: [profile("acme", ["base"], ["claude-code"], extra)],
});
async function fixture(templates?: unknown, files: Record<string, string> = {}) {
  const root = await tmpDir("craftar-doctor-templates-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const forgeRoot = path.join(root, "forge");
  const ws = path.join(root, "ws");
  await makeForge(forgeRoot, forgeWith(templates === undefined ? {} : { templates }));
  await makeWorkspace(ws, forgeRoot, { config: { profile: "acme" }, files });
  return { home: path.join(root, "home"), ws };
}
/** Runs doctor with a probe that answers `version` and counts its calls. */
async function doctor(f: { home: string; ws: string }, version: string | null = "10.0.401", extra: Partial<DoctorOptions> = {}) {
  let probes = 0;
  const report = await runDoctor({
    version: "0.0.0",
    home: f.home,
    workspace: f.ws,
    fetch: false,
    strict: false,
    registryOff: false,
    env: {},
    nodeVersion: "22.11.0",
    gitVersion: async () => "2.53.0",
    dotnetVersion: async () => {
      probes++;
      return version;
    },
    ...extra,
  });
  return { report, probes: () => probes, of: (id: string) => report.checks.filter((c: Check) => c.id === id) };
}
const WORKSPACE_IDS = ["config", "forge", "forge-inside", "plan", "params", "mcp-env", "lock", "registered"];

describe("doctor without a templates key", () => {
  it.each([
    ["no key", undefined],
    ["an empty templates: line", null],
  ] as Array<[string, unknown]>)("%s: neither check is there, and dotnet is not probed", async (_name, templates) => {
    const d = await doctor(await fixture(templates));
    expect(d.of("templates")).toEqual([]);
    expect(d.of("dotnet")).toEqual([]);
    expect(d.probes()).toBe(0);
    expect(d.report.checks.filter((c) => c.scope === "workspace").map((c) => c.id)).toEqual(WORKSPACE_IDS);
  });
});

describe("doctor with a templates key", () => {
  it("an accepted block with a NuGet.Config: templates ok, dotnet ok with the version — the last two workspace checks", async () => {
    const d = await doctor(await fixture([API, TOOLS], NUGET));
    expect(d.of("templates")).toEqual([{ id: "templates", scope: "workspace", level: "ok", message: "block accepted: 2 entries", fix: null }]);
    expect(d.of("dotnet")).toEqual([{ id: "dotnet", scope: "workspace", level: "ok", message: "10.0.401", fix: null }]);
    expect(d.report.checks.filter((c) => c.scope === "workspace").map((c) => c.id)).toEqual([...WORKSPACE_IDS, "templates", "dotnet"]);
    expect(d.probes()).toBe(1);
  });

  it("one entry reads 'entry'; an empty list is accepted and asks nothing of dotnet", async () => {
    expect((await doctor(await fixture([TOOLS]))).of("templates")[0].message).toBe("block accepted: 1 entry");
    const empty = await doctor(await fixture([]));
    expect(empty.of("templates")).toEqual([{ id: "templates", scope: "workspace", level: "ok", message: "block accepted: 0 entries", fix: null }]);
    expect(empty.of("dotnet")).toEqual([]);
    expect(empty.probes()).toBe(0);
  });

  it("the functional spec's mapping: one warn in one line, never an error, and no dotnet check", async () => {
    const d = await doctor(await fixture({ dotnetNew: [M] }));
    expect(d.of("templates")).toEqual([
      { id: "templates", scope: "workspace", level: "warn", message: "profiles/acme/profile.yaml: templates — must be a list of entries, each with a kind", fix: FIX_REFUSED },
    ]);
    expect(d.of("dotnet")).toEqual([]);
    expect(d.probes()).toBe(0);
    expect(d.report.summary.error).toBe(0);
    expect(JSON.stringify(d.report)).not.toContain(M);
  });

  it("a source with a password: a warn naming the position; the password is nowhere in the report (AC 3)", async () => {
    const d = await doctor(await fixture([{ kind: "dotnet-new", source: `https://user:${M}@pkgs.example.com/v3/index.json`, packages: ["A"] }]));
    expect(d.of("templates")).toEqual([
      {
        id: "templates",
        scope: "workspace",
        level: "warn",
        message: "profiles/acme/profile.yaml: templates[0].source — a source must not carry a user or a password: NuGet's own configuration holds credentials",
        fix: FIX_REFUSED,
      },
    ]);
    expect(d.of("dotnet")).toEqual([]);
    expect(JSON.stringify(d.report)).not.toContain(M);
  });

  it("only an unknown kind: a warn, and no dotnet check", async () => {
    const d = await doctor(await fixture([NPM]));
    expect(d.of("templates")).toEqual([
      { id: "templates", scope: "workspace", level: "warn", message: 'templates[0]: kind "npm-create" is not installed by this craftar', fix: "upgrade craftar, or remove the entry" },
    ]);
    expect(d.of("dotnet")).toEqual([]);
    expect(d.probes()).toBe(0);
  });

  it("a source and no NuGet.Config at the workspace root: a warn that points at it; with the file, none", async () => {
    const d = await doctor(await fixture([TOOLS, API]));
    expect(d.of("templates")).toEqual([{ id: "templates", scope: "workspace", level: "warn", message: FEED("templates[1]"), fix: FIX_FEED }]);
    expect(d.of("dotnet").map((c) => c.level)).toEqual(["ok"]);
    expect((await doctor(await fixture([TOOLS, API], { "nuget.config": "<configuration />\n" }))).of("templates").map((c) => c.level)).toEqual(["ok"]);
  });

  it("an unknown kind and an unpinned source: one line each, the kind first, and no ok line", async () => {
    const d = await doctor(await fixture([API, NPM]));
    expect(d.of("templates").map((c) => [c.level, c.message])).toEqual([
      ["warn", 'templates[1]: kind "npm-create" is not installed by this craftar'],
      ["warn", FEED("templates[0]")],
    ]);
  });

  it("dotnet not found: a warn with its fix, never an error", async () => {
    const d = await doctor(await fixture([TOOLS]), null);
    expect(d.of("dotnet")).toEqual([{ id: "dotnet", scope: "workspace", level: "warn", message: "the .NET SDK is not available: dotnet --version gave no version", fix: "install the .NET SDK and check PATH" }]);
    expect(d.report.summary.error).toBe(0);
  });
});

describe("craftar doctor --json with a templates key", () => {
  it("keeps the report's keys, carries the two ids, and never the password of a refused source (AC 3)", async () => {
    const f = await fixture([{ kind: "dotnet-new", source: `https://user:${M}@pkgs.example.com/v3/index.json`, packages: ["A"] }]);
    const r = runCli(["doctor", "--json", "--workspace", f.ws], { env: { PATH: "", Path: "", CRAFTAR_HOME: f.home } });
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(M);
    const json = JSON.parse(r.stdout);
    expect(Object.keys(json)).toEqual(["version", "workspace", "fetch", "strict", "checks", "summary"]);
    expect(json.checks.filter((c: Check) => c.id === "templates").map((c: Check) => c.level)).toEqual(["warn"]);
    expect(json.summary.error).toBe(0);

    const ok = await fixture([TOOLS]);
    const r2 = runCli(["doctor", "--json", "--workspace", ok.ws], { env: { PATH: "", Path: "", CRAFTAR_HOME: ok.home } });
    const dotnet = JSON.parse(r2.stdout).checks.filter((c: Check) => c.id === "dotnet");
    expect(dotnet).toEqual([{ id: "dotnet", scope: "workspace", level: "warn", message: "the .NET SDK is not available: dotnet --version gave no version", fix: "install the .NET SDK and check PATH" }]);
  });
});
