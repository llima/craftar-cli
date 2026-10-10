import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exists, listFiles } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, scenario, type ForgeSpec } from "./helpers/forge.js";

// Spec 32 §4 — `craftar templates list | install` as real processes.
// dotnet is installed on some machines that run this suite: EVERY call empties PATH, so no test can start it.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const NO_DOTNET = { PATH: "", Path: "" };
const M = ["ZZ", "MARKER", "ZZ"].join("");
const SOURCE = "https://pkgs.example.com/acme/nuget/v3/index.json";
const API = { kind: "dotnet-new", source: SOURCE, packages: ["Acme.Templates.Api", "Acme.Templates.Front::2.1.0"] };
const NPM = { kind: "npm-create", anything: { a: 1 } };
const TOOLS = { kind: "dotnet-new", packages: ["Acme.Tools"] };
const UNKNOWN_KIND = 'templates: kind "npm-create" is not installed by this craftar — skipped';
const NOTHING = "no templates declared for profile acme\n";
const LABEL = "profiles/acme/profile.yaml";
const HINT = `${LABEL}: templates — must be a list of entries, each with a kind\n  templates:\n    - kind: dotnet-new\n      packages: [Example.Templates.Api]`;
const CREDENTIAL = `${LABEL}: templates[0].source — a source must not carry a user or a password: NuGet's own configuration holds credentials`;
const withCredential = [{ kind: "dotnet-new", source: `https://user:${M}@pkgs.example.com/v3/index.json`, packages: ["A"] }];

const forgeWith = (extra: Record<string, unknown>): ForgeSpec => ({
  ingredients: [rule("style", "# Style\n")],
  recipes: [recipe("base", ["rule/style"])],
  profiles: [profile("acme", ["base"], ["claude-code"], extra)],
});
/** A workspace whose profile holds `templates` (no key when undefined), with `files` at its root. */
async function fresh(templates?: unknown, files: Record<string, string> = {}) {
  const s = await scenario(forgeWith(templates === undefined ? {} : { templates }), { config: { profile: "acme" }, files });
  cleanups.push(s.cleanup);
  return s;
}
const cli = (args: string[], wsRoot: string) => runCli([...args, "--workspace", wsRoot], { env: NO_DOTNET });
/** Every file under `root`, base64, or {} when it does not exist — a before/after comparison catches any write. */
async function tree(root: string): Promise<Record<string, string>> {
  if (!(await exists(root))) return {};
  return Object.fromEntries(await Promise.all((await listFiles(root)).map(async (f) => [f, await fs.readFile(path.join(root, f), "base64")] as const)));
}

describe("templates list", () => {
  it("prints one line per package and one per entry it cannot install, the warning on stderr, exit 0", async () => {
    const s = await fresh([API, NPM, TOOLS]);
    const r = cli(["templates", "list"], s.wsRoot);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      [
        "Templates of profile acme",
        `  dotnet-new  Acme.Templates.Api    latest  ${SOURCE}`,
        `  dotnet-new  Acme.Templates.Front  2.1.0   ${SOURCE}`,
        "  npm-create  not installed by this craftar",
        "  dotnet-new  Acme.Tools            latest  default feeds",
        "",
      ].join("\n"),
    );
    expect(r.stderr).toBe(`warn ${UNKNOWN_KIND}\n`);
  });

  it("--json: profile, templates, warnings — rows keyed entry, kind, package, version, source, installable; nothing on stderr", async () => {
    const s = await fresh([API, NPM, TOOLS]);
    const r = cli(["templates", "list", "--json"], s.wsRoot);
    expect([r.code, r.stderr]).toEqual([0, ""]);
    const json = JSON.parse(r.stdout);
    expect(Object.keys(json)).toEqual(["profile", "templates", "warnings"]);
    expect(json.templates.map((row: object) => Object.keys(row))).toEqual(Array(4).fill(["entry", "kind", "package", "version", "source", "installable"]));
    expect(json).toEqual({
      profile: "acme",
      templates: [
        { entry: 0, kind: "dotnet-new", package: "Acme.Templates.Api", version: null, source: SOURCE, installable: true },
        { entry: 0, kind: "dotnet-new", package: "Acme.Templates.Front", version: "2.1.0", source: SOURCE, installable: true },
        { entry: 1, kind: "npm-create", package: null, version: null, source: null, installable: false },
        { entry: 2, kind: "dotnet-new", package: "Acme.Tools", version: null, source: null, installable: true },
      ],
      warnings: [UNKNOWN_KIND],
    });
  });

  it.each([
    ["no templates key", undefined],
    ["an empty templates: line", null],
    ["an empty list", []],
  ] as Array<[string, unknown]>)("%s: says so and exits 0; --json is the empty object of the contract", async (_name, templates) => {
    const s = await fresh(templates);
    const r = cli(["templates", "list"], s.wsRoot);
    expect([r.code, r.stdout, r.stderr]).toEqual([0, NOTHING, ""]);
    const j = cli(["templates", "list", "--json"], s.wsRoot);
    expect([j.code, j.stderr]).toEqual([0, ""]);
    expect(JSON.parse(j.stdout)).toEqual({ profile: "acme", templates: [], warnings: [] });
  });

  it("the functional spec's mapping: exit 1 with the shape of §5.1, nothing on stdout — text and --json", async () => {
    const s = await fresh({ dotnetNew: [M] });
    for (const args of [["templates", "list"], ["templates", "list", "--json"]]) {
      const r = cli(args, s.wsRoot);
      expect([r.code, r.stdout, r.stderr]).toEqual([1, "", `error: ${HINT}\n`]);
    }
  });

  it("a source with a password: exit 1 naming the position, and the password is nowhere (AC 3)", async () => {
    const s = await fresh(withCredential);
    for (const args of [["templates", "list"], ["templates", "list", "--json"]]) {
      const r = cli(args, s.wsRoot);
      expect([r.code, r.stdout, r.stderr]).toEqual([1, "", `error: ${CREDENTIAL}\n`]);
      expect(r.stdout + r.stderr).not.toContain(M);
    }
  });

  it("writes nothing: the Forge, the workspace and $CRAFTAR_HOME are byte-identical afterwards", async () => {
    const s = await fresh([API, NPM, TOOLS]);
    const home = process.env.CRAFTAR_HOME!;
    const before = [await tree(s.root), await tree(home)];
    expect(cli(["templates", "list"], s.wsRoot).code).toBe(0);
    expect(cli(["templates", "list", "--json"], s.wsRoot).code).toBe(0);
    expect([await tree(s.root), await tree(home)]).toEqual(before);
  });

  it("takes --offline, and fails as every reading command does without a craftar.yaml", async () => {
    const s = await fresh([TOOLS]);
    expect(cli(["templates", "list", "--offline"], s.wsRoot).code).toBe(0);
    const r = cli(["templates", "list"], s.forgeRoot);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("craftar.yaml");
  });
});

describe("templates (the group alone)", () => {
  it("prints the group's help on stderr and exits 1, as `craftar cache` does", () => {
    const r = runCli(["templates"], { env: NO_DOTNET });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Usage: craftar templates");
    expect(r.stderr).toMatch(/\n\s+list\b/);
  });
});
