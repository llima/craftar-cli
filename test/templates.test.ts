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
