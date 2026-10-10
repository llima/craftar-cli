import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listFiles, loadForge } from "../src/core/forge.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { declaredTemplates, profileLabel, templateRows } from "../src/core/templates.js";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { profile, recipe, rule, scenario, writeFiles, type ForgeSpec } from "./helpers/forge.js";

// Spec 32 §5 and §10 tests 1, 2 and 11 — the profile's `templates` key: kept at load, read by one function.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const LABEL = "profiles/acme/profile.yaml";
// Assembled at runtime; it must never come back in a message.
const M = ["ZZ", "MARKER", "ZZ"].join("");
const SOURCE = "https://pkgs.example.com/acme/nuget/v3/index.json";
const BLOCK = [{ kind: "dotnet-new", source: SOURCE, packages: ["Acme.Templates.Api", "Acme.Templates.Front::2.1.0"] }];

const forgeWith = (extra: Record<string, unknown>): ForgeSpec => ({
  ingredients: [rule("style", "# Style\n")],
  recipes: [recipe("base", ["rule/style"])],
  profiles: [profile("acme", ["base"], ["claude-code"], extra)],
});
async function planned(extra: Record<string, unknown>) {
  const s = await scenario(forgeWith(extra), { config: { profile: "acme" } });
  cleanups.push(s.cleanup);
  const ws = await loadWorkspace(s.wsRoot);
  const p = await plan(ws);
  return { s, ws, files: p.files.map((f) => [f.path, f.content.toString("base64")]), warnings: p.warnings };
}

describe("a profile's templates key at load (spec 32 §5.1)", () => {
  it.each([
    ["the list of §5.1", BLOCK],
    ["the functional spec's mapping", { dotnetNew: [] }],
    ["a scalar", "x"],
    ["a list the commands would refuse", [{ kind: "dotnet-new", packages: [] }]],
  ] as Array<[string, unknown]>)("%s loads, is kept as written, and plans the same bytes as no key", async (_name, value) => {
    const without = await planned({});
    const withKey = await planned({ templates: value });
    expect(withKey.files).toEqual(without.files);
    expect(withKey.files).toHaveLength(1);
    expect(withKey.warnings).toEqual(without.warnings);
    expect(withKey.ws.forge.profiles.get("acme")!.templates).toEqual(value);
  });

  it("on test/golden/acme-portal the plan is byte-identical once the key is added to the imported profile", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-templates-golden-"));
    cleanups.push(() => fs.rm(tmp, { recursive: true, force: true }));
    const golden = path.resolve(__dirname, "golden", "acme-portal");
    const portal = path.join(tmp, "acme-portal");
    for (const rel of await listFiles(golden)) {
      await fs.mkdir(path.dirname(path.join(portal, rel)), { recursive: true });
      await fs.copyFile(path.join(golden, rel), path.join(portal, rel));
    }
    const forge = path.join(tmp, "forge");
    const r = await importClaudeCode({ workspaceRoot: portal, forgeRoot: forge, profileName: "acme-portal", writeWorkspaceConfig: true });
    expect(r.rejected).toEqual([]);
    const bytes = async () => {
      const p = await plan(await loadWorkspace(portal));
      return { files: p.files.map((f) => [f.path, f.content.toString("base64")]), warnings: p.warnings };
    };
    const before = await bytes();
    expect(before.files.length).toBeGreaterThan(10);
    const file = path.join(forge, "profiles", "acme-portal", "profile.yaml");
    expect((await fs.readFile(file, "utf8")).endsWith("\n")).toBe(true);
    await fs.appendFile(file, `templates:\n  - kind: dotnet-new\n    source: ${SOURCE}\n    packages:\n      - Acme.Templates.Api\n      - Acme.Templates.Front::2.1.0\n`);
    expect(await bytes()).toEqual(before);
    expect((await loadForge(forge)).profiles.get("acme-portal")!.templates).toEqual(BLOCK);
  });
});

describe("declaredTemplates — what the commands accept (spec 32 §5.2)", () => {
  it("the block of §5.1: one entry, two packages, rows in the --json key order", () => {
    const d = declaredTemplates({ name: "acme", templates: BLOCK }, LABEL);
    expect(d).toEqual({
      declared: true,
      warnings: [],
      entries: [
        {
          entry: 0,
          kind: "dotnet-new",
          installable: true,
          source: SOURCE,
          packages: [
            { id: "Acme.Templates.Api", version: null },
            { id: "Acme.Templates.Front", version: "2.1.0" },
          ],
        },
      ],
    });
    const rows = templateRows(d.entries);
    expect(rows).toEqual([
      { entry: 0, kind: "dotnet-new", package: "Acme.Templates.Api", version: null, source: SOURCE, installable: true },
      { entry: 0, kind: "dotnet-new", package: "Acme.Templates.Front", version: "2.1.0", source: SOURCE, installable: true },
    ]);
    expect(Object.keys(rows[0])).toEqual(["entry", "kind", "package", "version", "source", "installable"]);
  });

  it("an ID that looks like a file name, a leading underscore, a pre-release version, no source", () => {
    const d = declaredTemplates({ name: "acme", templates: [{ kind: "dotnet-new", packages: ["tpl.nupkg", "_x", "A::1.0.0-rc.1+build.5"] }] }, LABEL);
    expect(d.entries).toEqual([
      {
        entry: 0,
        kind: "dotnet-new",
        installable: true,
        source: null,
        packages: [
          { id: "tpl.nupkg", version: null },
          { id: "_x", version: null },
          { id: "A", version: "1.0.0-rc.1+build.5" },
        ],
      },
    ]);
  });

  it("an unknown kind is accepted whatever its other keys: one non-installable entry, one warning, nothing of it kept", () => {
    const d = declaredTemplates({ name: "acme", templates: [{ kind: "npm-create", anything: { a: 1 }, packages: 7, source: `http://${M}` }] }, LABEL);
    expect(d).toEqual({
      declared: true,
      entries: [{ entry: 0, kind: "npm-create", installable: false }],
      warnings: ['templates: kind "npm-create" is not installed by this craftar — skipped'],
    });
    expect(templateRows(d.entries)).toEqual([{ entry: 0, kind: "npm-create", package: null, version: null, source: null, installable: false }]);
    expect(JSON.stringify(d)).not.toContain(M);
  });

  it("entries keep their position in the profile's list", () => {
    const d = declaredTemplates({ name: "acme", templates: [{ kind: "npm-create" }, BLOCK[0], { kind: "nx" }] }, LABEL);
    expect(d.entries.map((e) => [e.entry, e.kind, e.installable])).toEqual([
      [0, "npm-create", false],
      [1, "dotnet-new", true],
      [2, "nx", false],
    ]);
    expect(d.warnings).toEqual([
      'templates: kind "npm-create" is not installed by this craftar — skipped',
      'templates: kind "nx" is not installed by this craftar — skipped',
    ]);
  });

  it("no key and null are 'not declared'; an empty list is declared and empty", () => {
    expect(declaredTemplates({ name: "acme" }, LABEL)).toEqual({ declared: false, entries: [], warnings: [] });
    expect(declaredTemplates({ name: "acme", templates: null }, LABEL)).toEqual({ declared: false, entries: [], warnings: [] });
    expect(declaredTemplates({ name: "acme", templates: [] }, LABEL)).toEqual({ declared: true, entries: [], warnings: [] });
  });

  it("a source with a port, a path and a query is accepted as written", () => {
    const source = "https://pkgs.example.com:8443/acme/nuget/v3/index.json?api-version=7.1&x=%20y";
    expect(declaredTemplates({ name: "acme", templates: [{ kind: "dotnet-new", source, packages: ["A"] }] }, LABEL).entries[0]).toMatchObject({ source });
  });
});

const LIST = "must be a list of entries, each with a kind";
const HINT = `${LABEL}: templates — ${LIST}\n  templates:\n    - kind: dotnet-new\n      packages: [Example.Templates.Api]`;
const ENTRY = "an entry is a mapping with a kind";
const KIND = 'a kind is a lowercase name: a-z, 0-9 and "-", starting with a letter';
const PACKAGES = "a dotnet-new entry lists at least one package";
const PACKAGE = 'a package is a NuGet ID, optionally <id>::<version>: no path, no space, no leading "-" or "."';
const SRC = "a source is an https:// URL";
const CREDENTIAL = "a source must not carry a user or a password: NuGet's own configuration holds credentials";
const UNKNOWN_KEY = "a dotnet-new entry has no such key (it has kind, packages and source)";
const at = (position: string, rule: string) => `${LABEL}: ${position} — ${rule}`;
const dn = (extra: Record<string, unknown> = {}) => ({ kind: "dotnet-new", packages: ["A"], ...extra });

describe("declaredTemplates — refusals name the position and the rule, never a value (spec 32 §5.2, §10 test 11)", () => {
  it.each([
    ["a mapping, the functional spec's shape", { dotnetNew: [M] }, HINT],
    ["a scalar", M, HINT],
    ["an entry that is a number", [42], at("templates[0]", ENTRY)],
    ["an entry that is a string", [M], at("templates[0]", ENTRY)],
    ["an entry that is a list", [[M]], at("templates[0]", ENTRY)],
    ["an entry with no kind", [{ packages: [M] }], at("templates[0].kind", KIND)],
    ["a kind that is a URL", [{ kind: `https://${M}.example.com` }], at("templates[0].kind", KIND)],
    ["a kind with an uppercase letter", [{ kind: "Dotnet-New", packages: ["A"] }], at("templates[0].kind", KIND)],
    ["a kind that is a number", [{ kind: 7 }], at("templates[0].kind", KIND)],
    ["a dotnet-new entry with no packages", [{ kind: "dotnet-new" }], at("templates[0].packages", PACKAGES)],
    ["an empty packages", [dn({ packages: [] })], at("templates[0].packages", PACKAGES)],
    ["packages that is a scalar", [dn({ packages: M })], at("templates[0].packages", PACKAGES)],
    ["a package spelled ./path", [dn({ packages: [`./${M}`] })], at("templates[0].packages[0]", PACKAGE)],
    ["a package spelled as a Windows path", [dn({ packages: [`C:\\${M}`] })], at("templates[0].packages[0]", PACKAGE)],
    ["a package with a slash", [dn({ packages: [`a/${M}`] })], at("templates[0].packages[0]", PACKAGE)],
    ["a package starting with -", [dn({ packages: [`-${M}`] })], at("templates[0].packages[0]", PACKAGE)],
    ["a package starting with .", [dn({ packages: [`.${M}`] })], at("templates[0].packages[0]", PACKAGE)],
    ["a package with a space", [dn({ packages: [`${M} x`] })], at("templates[0].packages[0]", PACKAGE)],
    ["a package with an empty version", [dn({ packages: [`${M}::`] })], at("templates[0].packages[0]", PACKAGE)],
    ["a package whose version starts with -", [dn({ packages: [`${M}::-1`] })], at("templates[0].packages[0]", PACKAGE)],
    ["a package that is a number", [dn({ packages: [7] })], at("templates[0].packages[0]", PACKAGE)],
    ["the second package", [dn({ packages: ["A", `../${M}`] })], at("templates[0].packages[1]", PACKAGE)],
    ["an http:// source", [dn({ source: `http://${M}.example.com/v3/index.json` })], at("templates[0].source", SRC)],
    ["a source starting with -", [dn({ source: `-${M}` })], at("templates[0].source", SRC)],
    ["a source with a space", [dn({ source: `https://${M}.example.com/a b` })], at("templates[0].source", SRC)],
    ["a source that is a number", [dn({ source: 7 })], at("templates[0].source", SRC)],
    ["a source with no host", [dn({ source: `https:///user:${M}@pkgs.example.com/x` })], at("templates[0].source", SRC)],
    ["a source with a control character", [dn({ source: `https://pkgs.example.com/\u001b[31m${M}` })], at("templates[0].source", SRC)],
    ["an unknown key that is not a name", [dn({ [`https://u:${M}@h/x\nmore`]: 1 })], at("templates[0]", UNKNOWN_KEY)],
    ["a source with a user and a password", [dn({ source: `https://user:${M}@pkgs.example.com/v3/index.json` })], at("templates[0].source", CREDENTIAL)],
    ["a source with a user", [dn({ source: `https://${M}@pkgs.example.com/v3/index.json` })], at("templates[0].source", CREDENTIAL)],
    ["an unknown key on a dotnet-new entry", [dn({ feed: M })], at("templates[0].feed", UNKNOWN_KEY)],
    ["a __proto__ key", JSON.parse(`[{"kind":"npm-create","__proto__":"${M}"}]`), at("templates[0].__proto__", "a __proto__ key is not allowed")],
    ["the second entry", [dn(), { kind: `${M} ` }], at("templates[1].kind", KIND)],
    ["two faults in one entry: the first, and the count", [dn({ packages: [], source: `http://${M}` })], `${at("templates[0].packages", PACKAGES)} (and 1 more)`],
    ["a schema fault and a credential: the schema's", [dn({ packages: [], source: `https://user:${M}@pkgs.example.com/x` })], at("templates[0].packages", PACKAGES)],
  ] as Array<[string, unknown, string]>)("%s", (_name, templates, message) => {
    let thrown: unknown = null;
    try {
      declaredTemplates({ name: "acme", templates }, LABEL);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(message);
    expect((thrown as Error).message).not.toContain(M);
  });
});

describe("profileLabel (design D9)", () => {
  it("is the Forge-relative file when the directory carries the profile's name, and never an absolute path", async () => {
    const s = await scenario(forgeWith({}), { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    expect(await profileLabel(s.forgeRoot, "acme")).toBe(LABEL);
    await writeFiles(s.forgeRoot, { "profiles/other-dir/profile.yaml": "name: globex\nrecipes: [base]\n" });
    expect(await profileLabel(s.forgeRoot, "globex")).toBe("the profile.yaml of profile globex");
  });
});

describe("one reader (spec 32 §8)", () => {
  it("profile.templates and the templates schemas are used by src/core/templates.ts only (control)", async () => {
    const src = path.resolve(__dirname, "..", "src");
    const offenders: string[] = [];
    for (const f of await listFiles(src)) {
      if (!f.endsWith(".ts") || f === "core/templates.ts") continue;
      const text = await fs.readFile(path.join(src, f), "utf8");
      if (/\.templates\b|\[["']templates["']\]/.test(text)) offenders.push(`${f}: reads .templates`);
      if (f !== "schema/index.ts" && /\b(TemplatesSchema|DotnetNewTemplateSchema)\b/.test(text)) offenders.push(`${f}: uses a templates schema`);
    }
    expect(offenders).toEqual([]);
  });
});

import { dotnetVersion, feedMessage, installArgv, installLine, installReport, installTemplates, rootCollisions, unpinnedSources, type DeclaredEntry, type DotnetNewEntry } from "../src/core/templates.js";
import type { RunRequest } from "../src/core/proc.js";
import { tmpDir } from "./helpers/forge.js";

// Spec 32 §4.2 and §10 tests 3, 4, 5, 9, 10 — the install loop, over a recording runner. No test runs dotnet.

const API: DotnetNewEntry = {
  entry: 0,
  kind: "dotnet-new",
  installable: true,
  source: SOURCE,
  packages: [
    { id: "Acme.Templates.Api", version: null },
    { id: "Acme.Templates.Front", version: "2.1.0" },
  ],
};
const NPM: DeclaredEntry = { entry: 1, kind: "npm-create", installable: false };
const TOOLS: DotnetNewEntry = { entry: 2, kind: "dotnet-new", installable: true, source: null, packages: [{ id: "Acme.Tools", version: null }] };
const ARGV_API = ["new", "install", "Acme.Templates.Api", "Acme.Templates.Front::2.1.0", "--add-source", SOURCE];
const LINE_API = `dotnet new install Acme.Templates.Api Acme.Templates.Front::2.1.0 --add-source ${SOURCE}`;
const LINE_TOOLS = "dotnet new install Acme.Tools";
const COLLISION = (ids: string) =>
  `a file or folder named like a declared package exists at the workspace root (${ids}) — dotnet would install it instead of the feed's package; nothing installed`;
const FEED = (positions: string) =>
  `a source is declared (${positions}) and the workspace root has no NuGet.Config — dotnet adds a declared source to the feeds it already uses, it does not replace them (craftar looks at the workspace root only; NuGet also reads parent directories and the user's configuration)`;

/** A runner that records every request and answers the given exit codes in order (0 once they run out). */
function recorder(codes: Array<number | null> = []) {
  const calls: RunRequest[] = [];
  const log: string[] = [];
  const run = async (req: RunRequest) => {
    calls.push(req);
    log.push(`run ${req.args.join(" ")}`);
    return { code: calls.length <= codes.length ? codes[calls.length - 1] : 0 };
  };
  const announce = (entry: number, line: string) => void log.push(`announce ${entry} ${line}`);
  return { calls, log, run, announce };
}
async function emptyRoot(files: Record<string, string> = {}) {
  const root = await tmpDir("craftar-templates-root-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  await writeFiles(root, files);
  return root;
}
const tree = async (root: string) => Object.fromEntries(await Promise.all((await listFiles(root)).map(async (f) => [f, await fs.readFile(path.join(root, f), "base64")] as const)));

describe("installArgv (spec 32 §10 test 3)", () => {
  it("packages, versions, the source; --force and --interactive only when asked, in that order", () => {
    expect(installArgv(API)).toEqual(ARGV_API);
    expect(installArgv(API, { force: false, interactive: false })).toEqual(ARGV_API);
    expect(installArgv(TOOLS)).toEqual(["new", "install", "Acme.Tools"]);
    expect(installArgv(API, { force: true })).toEqual([...ARGV_API, "--force"]);
    expect(installArgv(API, { interactive: true })).toEqual([...ARGV_API, "--interactive"]);
    expect(installArgv(TOOLS, { force: true, interactive: true })).toEqual(["new", "install", "Acme.Tools", "--force", "--interactive"]);
    expect(installLine(installArgv(API))).toBe(LINE_API);
  });
});

describe("installTemplates (spec 32 §10 tests 4, 5, 9)", () => {
  it("runs every dotnet-new entry in order at the root, announces each first, skips an unknown kind", async () => {
    const root = await emptyRoot();
    const r = recorder();
    const result = await installTemplates([API, NPM, TOOLS], root, { env: { KEEP: "x" }, announce: r.announce }, r.run);
    expect(result).toEqual({
      lines: [
        { entry: 0, line: LINE_API },
        { entry: 2, line: LINE_TOOLS },
      ],
      installed: [0, 2],
      failed: [],
      skipped: [1],
    });
    expect(r.calls).toEqual([
      { file: "dotnet", args: ARGV_API, cwd: root, env: { KEEP: "x", DOTNET_NOLOGO: "1" }, stdin: "ignore" },
      { file: "dotnet", args: ["new", "install", "Acme.Tools"], cwd: root, env: { KEEP: "x", DOTNET_NOLOGO: "1" }, stdin: "ignore" },
    ]);
    expect(r.log).toEqual([`announce 0 ${LINE_API}`, `run ${ARGV_API.join(" ")}`, `announce 2 ${LINE_TOOLS}`, "run new install Acme.Tools"]);
  });

  it("--interactive gives the child the terminal's input; --force is passed", async () => {
    const r = recorder();
    await installTemplates([TOOLS], await emptyRoot(), { env: {}, force: true, interactive: true }, r.run);
    expect(r.calls.map((c) => [c.args, c.stdin])).toEqual([[["new", "install", "Acme.Tools", "--force", "--interactive"], "inherit"]]);
  });

  it("an entry that fails does not stop the next; a child that did not exit is a failure too", async () => {
    const r = recorder([103, null, 0]);
    const third: DotnetNewEntry = { ...TOOLS, entry: 3, packages: [{ id: "Acme.More", version: null }] };
    const result = await installTemplates([API, TOOLS, third], await emptyRoot(), { env: {} }, r.run);
    expect(r.calls).toHaveLength(3);
    expect(result.installed).toEqual([3]);
    expect(result.failed).toEqual([
      { entry: 0, code: 103 },
      { entry: 2, code: null },
    ]);
  });

  it("a runner that rejects is a failed entry, and the next entry still runs", async () => {
    const calls: string[] = [];
    const run = async (req: RunRequest) => {
      calls.push(req.args.join(" "));
      if (calls.length === 1) throw Object.assign(new Error("spawn dotnet ENOENT"), { code: "ENOENT" });
      return { code: 0 };
    };
    const result = await installTemplates([API, TOOLS], await emptyRoot(), { env: {} }, run);
    expect(calls).toHaveLength(2);
    expect(result.failed).toEqual([{ entry: 0, code: null }]);
    expect(result.installed).toEqual([2]);
  });

  it.each([
    ["a folder", { "Acme.Templates.Api/keep.txt": "" }, "Acme.Templates.Api"],
    ["a file", { "Acme.Templates.Api": "" }, "Acme.Templates.Api"],
    ["a file named like the ID of a versioned package", { "Acme.Templates.Front": "" }, "Acme.Templates.Front"],
    ["two of them, in declaration order", { "Acme.Tools": "", "Acme.Templates.Api": "" }, "Acme.Templates.Api, Acme.Tools"],
  ] as Array<[string, Record<string, string>, string]>)("refuses %s named like a declared ID at the root, before any run — --dry-run too", async (_name, files, ids) => {
    const root = await emptyRoot(files);
    expect(await rootCollisions([API, NPM, TOOLS], root)).toEqual(ids.split(", "));
    for (const dryRun of [false, true]) {
      const r = recorder();
      await expect(installTemplates([API, NPM, TOOLS], root, { env: {}, dryRun, announce: r.announce }, r.run)).rejects.toThrow(new Error(COLLISION(ids)));
      expect(r.log).toEqual([]);
    }
  });

  it("a file elsewhere, or named like nothing declared, is no collision", async () => {
    const root = await emptyRoot({ "src/Acme.Templates.Api": "", "Acme.Templates.Other": "" });
    expect(await rootCollisions([API, NPM, TOOLS], root)).toEqual([]);
  });

  it("--dry-run calls the runner zero times, announces nothing, and returns the lines", async () => {
    const r = recorder();
    const result = await installTemplates([API, NPM, TOOLS], await emptyRoot(), { env: {}, dryRun: true, announce: r.announce }, r.run);
    expect(r.log).toEqual([]);
    expect(result).toEqual({
      lines: [
        { entry: 0, line: LINE_API },
        { entry: 2, line: LINE_TOOLS },
      ],
      installed: [],
      failed: [],
      skipped: [1],
    });
  });

  it("writes nothing at the root, run or dry run (spec 32 §10 test 5)", async () => {
    const root = await emptyRoot({ "craftar.yaml": "forge: ../forge\nprofile: acme\n", "nuget.config": "<configuration />\n" });
    const before = await tree(root);
    await installTemplates([API, NPM, TOOLS], root, { env: {} }, recorder([1]).run);
    await installTemplates([API, NPM, TOOLS], root, { env: {}, dryRun: true }, recorder().run);
    expect(await tree(root)).toEqual(before);
  });
});

describe("unpinnedSources and feedMessage (spec 32 §10 test 10)", () => {
  it("names the entries with a source when the root has no NuGet.Config, whatever the file's case", async () => {
    const withSource: DotnetNewEntry = { ...TOOLS, entry: 3, source: "https://pkgs.example.com/other/index.json" };
    expect(await unpinnedSources([API, NPM, TOOLS, withSource], await emptyRoot())).toEqual([0, 3]);
    expect(await unpinnedSources([API], await emptyRoot({ "NuGet.Config": "<configuration />\n" }))).toEqual([]);
    expect(await unpinnedSources([API], await emptyRoot({ "nuget.config": "<configuration />\n" }))).toEqual([]);
    expect(await unpinnedSources([API], await emptyRoot({ "NUGET.CONFIG": "<configuration />\n" }))).toEqual([]);
    expect(await unpinnedSources([API], await emptyRoot({ "sub/NuGet.Config": "<configuration />\n" }))).toEqual([0]);
    expect(await unpinnedSources([NPM, TOOLS], await emptyRoot())).toEqual([]);
  });

  it("the text names the positions", () => {
    expect(feedMessage([0])).toBe(FEED("templates[0]"));
    expect(feedMessage([0, 3])).toBe(FEED("templates[0], templates[3]"));
  });
});

describe("dotnetVersion (spec 32 §4.2 step 2, design D5)", () => {
  const probe = (answer: string | Error) => {
    const calls: Array<[string, string[], NodeJS.ProcessEnv]> = [];
    return {
      calls,
      run: async (file: string, args: string[], env: NodeJS.ProcessEnv) => {
        calls.push([file, args, env]);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
  };

  it("asks `dotnet --version` with DOTNET_NOLOGO=1 and reads the first line that is a version", async () => {
    const p = probe("Welcome to .NET!\n\n10.0.401\n8.0.100\n");
    expect(await dotnetVersion(p.run, { KEEP: "x" })).toBe("10.0.401");
    expect(p.calls).toEqual([["dotnet", ["--version"], { KEEP: "x", DOTNET_NOLOGO: "1" }]]);
    expect(await dotnetVersion(probe("9.0.100-rc.1.24452.12\r\n").run, {})).toBe("9.0.100-rc.1.24452.12");
  });

  it("is null when dotnet cannot start, exits non-zero, or prints no version", async () => {
    expect(await dotnetVersion(probe(Object.assign(new Error("spawn dotnet ENOENT"), { code: "ENOENT" })).run, {})).toBeNull();
    expect(await dotnetVersion(probe(Object.assign(new Error("Command failed"), { code: 145 })).run, {})).toBeNull();
    expect(await dotnetVersion(probe("No .NET SDKs were found.\n").run, {})).toBeNull();
    expect(await dotnetVersion(probe("").run, {})).toBeNull();
  });

  it("probes in the directory it is given", async () => {
    const seen: Array<string | undefined> = [];
    const run = async (_file: string, _args: string[], _env: NodeJS.ProcessEnv, cwd?: string) => {
      seen.push(cwd);
      return "10.0.401\n";
    };
    expect(await dotnetVersion(run, {}, "/some/root")).toBe("10.0.401");
    expect(await dotnetVersion(run, {})).toBe("10.0.401");
    expect(seen).toEqual(["/some/root", undefined]);
  });
});

describe("installReport — what install prints and how it exits (spec 32 §4.2 step 5)", () => {
  const STORE = "into the dotnet template store of this user (remove a package with: dotnet new uninstall <package>)";
  const lines = [
    { entry: 0, line: LINE_API },
    { entry: 2, line: LINE_TOOLS },
  ];
  it("a real run: one line per failed entry, the summary, exit 1 when anything failed or was skipped", () => {
    expect(installReport({ lines, installed: [3], failed: [{ entry: 0, code: 103 }, { entry: 2, code: null }], skipped: [1] }, false)).toEqual({
      err: ["templates[0] failed — dotnet exited 103", "templates[2] failed — dotnet did not exit"],
      out: [`templates: 1 installed, 2 failed, 1 skipped — ${STORE}`],
      exitCode: 1,
    });
    expect(installReport({ lines, installed: [0, 2], failed: [], skipped: [] }, false)).toEqual({ err: [], out: [`templates: 2 installed, 0 failed, 0 skipped — ${STORE}`], exitCode: 0 });
    expect(installReport({ lines: [], installed: [], failed: [], skipped: [1] }, false).exitCode).toBe(1);
    expect(installReport({ lines, installed: [0], failed: [{ entry: 2, code: 1 }], skipped: [] }, false).exitCode).toBe(1);
  });
  it("a dry run: the bare lines, the count, exit 0 even with a skipped entry", () => {
    expect(installReport({ lines, installed: [], failed: [], skipped: [1] }, true)).toEqual({
      err: [],
      out: [LINE_API, LINE_TOOLS, "dry run: 2 would run, 1 skipped — nothing installed"],
      exitCode: 0,
    });
  });
});
