import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exists, listFiles } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, scenario, writeFiles, type ForgeSpec } from "./helpers/forge.js";

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

  it("names a profile whose directory is not its name without a path (design D9)", async () => {
    const s = await fresh([TOOLS]);
    await writeFiles(s.forgeRoot, { "profiles/other-dir/profile.yaml": `name: globex\nrecipes: [base]\ntemplates:\n  dotnetNew: [${M}]\n` });
    await writeFiles(s.wsRoot, { "craftar.yaml": "forge: ../forge\nprofile: globex\n" });
    const r = cli(["templates", "list"], s.wsRoot);
    expect([r.code, r.stdout]).toEqual([1, ""]);
    expect(r.stderr).toBe(
      "error: the profile.yaml of profile globex: templates — must be a list of entries, each with a kind\n  templates:\n    - kind: dotnet-new\n      packages: [Example.Templates.Api]\n",
    );
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

const LINE_API = `dotnet new install Acme.Templates.Api Acme.Templates.Front::2.1.0 --add-source ${SOURCE}`;
const FEED = (positions: string) =>
  `warn templates: a source is declared (${positions}) and the workspace root has no NuGet.Config — dotnet adds a declared source to the feeds it already uses, it does not replace them (craftar looks at the workspace root only; NuGet also reads parent directories and the user's configuration)\n`;
const COLLISION = (ids: string) =>
  `error: a file or folder named like a declared package exists at the workspace root (${ids}) — dotnet would install it instead of the feed's package; nothing installed\n`;
const DOTNET_MISSING =
  "error: the .NET SDK is not available: dotnet --version gave no version — install the .NET SDK (the version a global.json at the workspace root pins, if there is one) and check PATH, then run craftar templates install again (--dry-run shows the lines without it)\n";
const STORE = "into the dotnet template store of this user (remove a package with: dotnet new uninstall <package>)";
const NUGET = { "nuget.config": "<configuration />\n" };

describe("templates install --dry-run", () => {
  it("prints the exact line of the entry and the additive-feed line, needs no dotnet, exits 0 (AC 1)", async () => {
    const s = await fresh([API]);
    const r = cli(["templates", "install", "--dry-run"], s.wsRoot);
    expect([r.code, r.stdout, r.stderr]).toEqual([0, `${LINE_API}\ndry run: 1 would run, 0 skipped — nothing installed\n`, FEED("templates[0]")]);
  });

  it("with a NuGet.Config at the workspace root, whatever its case, the additive-feed line is absent", async () => {
    const s = await fresh([API], NUGET);
    const r = cli(["templates", "install", "--dry-run"], s.wsRoot);
    expect([r.code, r.stderr]).toEqual([0, ""]);
  });

  it("an unknown kind is warned and skipped, and the exit is still 0 (choice 30)", async () => {
    const s = await fresh([API, NPM, TOOLS], NUGET);
    const r = cli(["templates", "install", "--dry-run"], s.wsRoot);
    expect([r.code, r.stdout, r.stderr]).toEqual([
      0,
      `${LINE_API}\ndotnet new install Acme.Tools\ndry run: 2 would run, 1 skipped — nothing installed\n`,
      `warn ${UNKNOWN_KIND}\n`,
    ]);
  });

  it("--force and --interactive are passed through, in that order, and only when typed", async () => {
    const s = await fresh([TOOLS]);
    expect(cli(["templates", "install", "--dry-run", "--interactive", "--force"], s.wsRoot).stdout.split("\n")[0]).toBe("dotnet new install Acme.Tools --force --interactive");
    expect(cli(["templates", "install", "--dry-run", "--force"], s.wsRoot).stdout.split("\n")[0]).toBe("dotnet new install Acme.Tools --force");
    expect(cli(["templates", "install", "--dry-run"], s.wsRoot).stdout.split("\n")[0]).toBe("dotnet new install Acme.Tools");
  });

  it.each([
    ["a folder", { "Acme.Templates.Api/keep.txt": "" }],
    ["a file", { "Acme.Templates.Api": "" }],
  ] as Array<[string, Record<string, string>]>)("%s named like a declared ID at the workspace root: exit 1, no line printed", async (_name, files) => {
    const s = await fresh([API], { ...NUGET, ...files });
    const r = cli(["templates", "install", "--dry-run"], s.wsRoot);
    expect([r.code, r.stdout, r.stderr]).toEqual([1, "", COLLISION("Acme.Templates.Api")]);
  });
});

describe("templates install", () => {
  it("without dotnet on PATH: exit 1 with the fix, before anything else is said", async () => {
    const s = await fresh([API]);
    const r = cli(["templates", "install"], s.wsRoot);
    expect([r.code, r.stdout, r.stderr]).toEqual([1, "", DOTNET_MISSING]);
  });

  it("nothing declared: exit 0 and no dotnet needed", async () => {
    for (const templates of [undefined, []]) {
      const s = await fresh(templates);
      const r = cli(["templates", "install"], s.wsRoot);
      expect([r.code, r.stdout, r.stderr]).toEqual([0, NOTHING, ""]);
    }
  });

  it("only an unknown kind: nothing to run, the entry is skipped, exit 1", async () => {
    const s = await fresh([NPM]);
    const r = cli(["templates", "install"], s.wsRoot);
    expect([r.code, r.stdout, r.stderr]).toEqual([1, `templates: 0 installed, 0 failed, 1 skipped — ${STORE}\n`, `warn ${UNKNOWN_KIND}\n`]);
  });

  it("a refused block installs nothing: the mapping, and a source with a password that is never printed (AC 3)", async () => {
    for (const [templates, message] of [
      [{ dotnetNew: [M] }, HINT],
      [withCredential, CREDENTIAL],
    ] as Array<[unknown, string]>) {
      const s = await fresh(templates);
      for (const args of [["templates", "install"], ["templates", "install", "--dry-run"]]) {
        const r = cli(args, s.wsRoot);
        expect([r.code, r.stdout, r.stderr]).toEqual([1, "", `error: ${message}\n`]);
        expect(r.stdout + r.stderr).not.toContain(M);
      }
    }
  });

  it("writes nothing — dry run, refusal or failure: the Forge, the workspace and $CRAFTAR_HOME stay byte-identical", async () => {
    const s = await fresh([API, NPM, TOOLS], { "Acme.Tools": "" });
    const home = process.env.CRAFTAR_HOME!;
    const before = [await tree(s.root), await tree(home)];
    expect(cli(["templates", "install", "--dry-run"], s.wsRoot).code).toBe(1);
    expect(cli(["templates", "install"], s.wsRoot).code).toBe(1);
    expect([await tree(s.root), await tree(home)]).toEqual(before);
  });

  it("nothing declared: a load warning is still printed (the same one list prints)", async () => {
    const s = await fresh();
    await writeFiles(s.wsRoot, { "craftar.yaml": "forge: ../forge\nref: v1\nprofile: acme\n" });
    const WARNING = 'warn ref "v1" is ignored: the Forge is a path (../forge), read as its working tree\n';
    const list = cli(["templates", "list"], s.wsRoot);
    expect([list.code, list.stdout, list.stderr]).toEqual([0, NOTHING, WARNING]);
    const install = cli(["templates", "install"], s.wsRoot);
    expect([install.code, install.stdout, install.stderr]).toEqual([0, NOTHING, WARNING]);
  });
});

describe("templates --help", () => {
  const flat = (s: string) => s.replace(/\s+/g, " ");
  it("the group, list and install describe themselves", () => {
    const group = runCli(["templates", "--help"], { env: NO_DOTNET });
    expect(group.code).toBe(0);
    expect(flat(group.stdout)).toContain("Project templates the profile declares (dotnet new): list them, or install them into this user's dotnet template store");
    const list = runCli(["templates", "list", "--help"], { env: NO_DOTNET });
    expect(flat(list.stdout)).toContain("Runs no program and does not know what is installed");
    for (const flag of ["--json", "--workspace <dir>", "--offline"]) expect(list.stdout).toContain(flag);
    const install = runCli(["templates", "install", "--help"], { env: NO_DOTNET });
    expect(flat(install.stdout)).toContain("the packages land in this user's dotnet template store, shared by every workspace. Nothing else runs it. Exits 1 when an entry failed or was skipped");
    expect(flat(install.stdout)).toContain("print each dotnet new install line; run nothing (needs no dotnet)");
    for (const flag of ["--dry-run", "--force", "--interactive", "--workspace <dir>", "--offline"]) expect(install.stdout).toContain(flag);
  });
  it("craftar --help lists the group, and the README names both commands", async () => {
    expect(runCli(["--help"], { env: NO_DOTNET }).stdout).toMatch(/\n\s+templates\b/);
    const readme = await fs.readFile(path.resolve(__dirname, "..", "README.md"), "utf8");
    expect(readme).toContain("`craftar templates list [--json] [--workspace <dir>] [--offline]`");
    expect(readme).toContain("`craftar templates install [--dry-run] [--force] [--interactive] [--workspace <dir>] [--offline]`");
    expect(readme).toContain("## Project templates");
    expect(readme).toContain("dotnet new uninstall <package>");
  });
});
