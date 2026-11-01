import { afterEach, describe, expect, it } from "vitest";
import { lstatSync, promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { profile, recipe, rule, scenario, tmpDir, writeFiles } from "./helpers/forge.js";
import { runCli } from "./helpers/cli.js";
import { claudeMdBlocks, claudeMdBlockedMessage, loadWorkspace, plan } from "../src/core/sync.js";
import { claudeMdAncestors, runDoctor, type DoctorOptions } from "../src/core/doctor.js";

/**
 * Spec 50 Part A: `doctor`'s `agents-md-primary` covers `CLAUDE.md`, `CLAUDE.local.md` and `.claude/CLAUDE.md`, at the root
 * and in every directory above it (by `lstat` only), and `CLAUDE.local.md` holding the import counts as one (§4.1–§4.3).
 */

type Scenario = Awaited<ReturnType<typeof scenario>>;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

// Assembled at run time, so no literal in the source looks like the file's content.
const TOKEN = ["private", "note", "x".repeat(12)].join("-");

const ANCESTOR_FIX = "add a line @AGENTS.md to the workspace's CLAUDE.md, delete that file, or set Project instructions to claude-md-and-agents-md";
const ancestorMessage = (file: string) =>
  `agents-md.primary: ${file} may keep Claude Code from reading AGENTS.md — Claude Code 2.1.277+ reads this file instead, and the always-on rules do not arrive`;

/** One rule, `claude-code` and `agents-md`, `agents-md.primary` on at Forge `schema: 5`: nothing else for `doctor` to warn about. */
async function primaryWorkspace(wsFiles: Record<string, string> = {}): Promise<Scenario> {
  const s = await scenario(
    {
      ingredients: [rule("style", "# Style\nWrite plain English.\n")],
      recipes: [recipe("base", ["rule/style"])],
      profiles: [profile("acme", ["base"], ["claude-code", "agents-md"], { params: { "agents-md.primary": true } })],
    },
    { config: { profile: "acme" }, files: wsFiles },
  );
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "acme-forge", schema: 5 }));
  kept(s);
  // doctor walks from the workspace's real path; os.tmpdir() can be a link or an 8.3 short name (windows-latest).
  const root = await fs.realpath(s.root);
  return { ...s, root, forgeRoot: path.join(root, "forge"), wsRoot: path.join(root, "ws") };
}

/** `doctor` with the ancestor walk confined to the scenario's own directories (§11: never the real ancestors). */
async function doctorOf(s: Scenario, extra: Partial<DoctorOptions> = {}) {
  const home = await tmpDir("craftar-doctor-home-");
  cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
  const inside = s.root + path.sep;
  return runDoctor({
    version: "0.0.0",
    home,
    workspace: s.wsRoot,
    fetch: false,
    strict: false,
    registryOff: true,
    env: {},
    nodeVersion: "22.11.0",
    gitVersion: async () => "2.53.0",
    claudeUserDir: path.join(s.root, "user-claude"),
    claudeMdExists: (f) => (f.startsWith(inside) ? fs.lstat(f).then(() => true, () => false) : Promise.resolve(false)),
    ...extra,
  });
}

const primaryLines = (r: Awaited<ReturnType<typeof runDoctor>>) => r.checks.filter((c) => c.id === "agents-md-primary");

const readOf = (files: Record<string, string>) => async (rel: string): Promise<Buffer | null> =>
  Object.hasOwn(files, rel) ? Buffer.from(files[rel], "utf8") : null;

describe("claudeMdBlocks: CLAUDE.local.md imports, and the file that imports is named (spec 50 §4.1)", () => {
  it("CLAUDE.local.md holding only @AGENTS.md imports", async () => {
    expect(await claudeMdBlocks(readOf({ "CLAUDE.local.md": "@AGENTS.md\n" }))).toEqual({ imports: true, importedBy: "CLAUDE.local.md", blocking: [] });
  });

  it("CLAUDE.local.md with @./AGENTS.md, a BOM and CRLF imports", async () => {
    expect(await claudeMdBlocks(readOf({ "CLAUDE.local.md": "\uFEFF# mine\r\n@./AGENTS.md  \r\n" }))).toEqual({
      imports: true,
      importedBy: "CLAUDE.local.md",
      blocking: [],
    });
  });

  it("CLAUDE.local.md with text and no import line blocks", async () => {
    expect(await claudeMdBlocks(readOf({ "CLAUDE.local.md": `# mine\n${TOKEN}\n` }))).toEqual({ imports: false, importedBy: null, blocking: ["CLAUDE.local.md"] });
  });

  it("CLAUDE.local.md with @../AGENTS.md does not import", async () => {
    expect(await claudeMdBlocks(readOf({ "CLAUDE.local.md": "@../AGENTS.md\n" }))).toEqual({ imports: false, importedBy: null, blocking: ["CLAUDE.local.md"] });
  });

  it("text and the import line in one file import (§2.1)", async () => {
    expect(await claudeMdBlocks(readOf({ "CLAUDE.md": `# notes\n${TOKEN}\n@AGENTS.md\nmore\n` }))).toEqual({ imports: true, importedBy: "CLAUDE.md", blocking: [] });
  });

  it(".claude/CLAUDE.md with @../AGENTS.md is the file named", async () => {
    expect(await claudeMdBlocks(readOf({ ".claude/CLAUDE.md": "@../AGENTS.md\n" }))).toEqual({ imports: true, importedBy: ".claude/CLAUDE.md", blocking: [] });
  });

  it("CLAUDE.md with text and CLAUDE.local.md importing: the local file is named", async () => {
    expect(await claudeMdBlocks(readOf({ "CLAUDE.md": "# notes\n", "CLAUDE.local.md": "@AGENTS.md\n" }))).toEqual({
      imports: true,
      importedBy: "CLAUDE.local.md",
      blocking: [],
    });
  });
});

describe("claudeMdAncestors: the three files of every directory above, by lstat (spec 50 §4.2)", () => {
  it("asks, in each directory going up, for CLAUDE.md, CLAUDE.local.md and .claude/CLAUDE.md", async () => {
    const root = path.parse(process.cwd()).root;
    const ws = path.join(root, "a", "ws");
    const seen: string[] = [];
    const found = await claudeMdAncestors(ws, async (f) => (seen.push(f), true));
    const three = (d: string) => [path.join(d, "CLAUDE.md"), path.join(d, "CLAUDE.local.md"), path.join(d, ".claude", "CLAUDE.md")];
    expect(seen).toEqual([...three(path.join(root, "a")), ...three(root)]);
    expect(found).toEqual(seen);
  });

  it("a workspace at the file-system root has no ancestor, and its own files are not asked (edge 4)", async () => {
    const root = path.parse(process.cwd()).root;
    const seen: string[] = [];
    expect(await claudeMdAncestors(root, async (f) => (seen.push(f), true))).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("leaves the user's own CLAUDE.md out", async () => {
    const root = path.parse(process.cwd()).root;
    const home = path.join(root, "home", "u");
    const ws = path.join(home, "work", "ws");
    const user = path.join(home, ".claude", "CLAUDE.md");
    const found = await claudeMdAncestors(ws, async () => true, user);
    expect(found).not.toContain(user);
    expect(found).toContain(path.join(home, "CLAUDE.md"));
    expect(found).toContain(path.join(home, "work", ".claude", "CLAUDE.md"));
  });

  it.runIf(process.platform === "win32")("on Windows: a drive root and a UNC share end the walk, and the user's file matches without case", async () => {
    const seen: string[] = [];
    await claudeMdAncestors("C:\\w", async (f) => (seen.push(f), false));
    expect(seen).toEqual(["C:\\CLAUDE.md", "C:\\CLAUDE.local.md", "C:\\.claude\\CLAUDE.md"]);
    const unc: string[] = [];
    await claudeMdAncestors("\\\\host\\share\\w", async (f) => (unc.push(f), false));
    expect(unc).toEqual(["\\\\host\\share\\CLAUDE.md", "\\\\host\\share\\CLAUDE.local.md", "\\\\host\\share\\.claude\\CLAUDE.md"]);
    const folded = await claudeMdAncestors("C:\\Users\\u\\w", async () => true, "c:\\users\\U\\.CLAUDE\\claude.md");
    expect(folded).not.toContain("C:\\Users\\u\\.claude\\CLAUDE.md");
    expect(folded).toContain("C:\\Users\\u\\CLAUDE.md");
  });
});

describe("doctor's agents-md-primary at the root (spec 50 §4.1, §11 items 7–8, 12)", () => {
  it("CLAUDE.local.md with text → warn, case blocking, the file's bytes in no output", async () => {
    const s = await primaryWorkspace({ "CLAUDE.local.md": `# mine\n${TOKEN}\n` });
    const r = await doctorOf(s);
    expect(primaryLines(r)).toEqual([
      { id: "agents-md-primary", scope: "workspace", level: "warn", message: claudeMdBlockedMessage("CLAUDE.local.md"), fix: "add a line @AGENTS.md to CLAUDE.md", case: "blocking" },
    ]);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("CLAUDE.local.md holding only @AGENTS.md → ok naming it, case imports, and no plan warning", async () => {
    const s = await primaryWorkspace({ "CLAUDE.local.md": "@AGENTS.md\n" });
    const r = await doctorOf(s);
    expect(primaryLines(r)).toEqual([
      { id: "agents-md-primary", scope: "workspace", level: "ok", message: "AGENTS.md arrives through the import in CLAUDE.local.md", fix: null, case: "imports" },
    ]);
    const p = await plan(await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME }));
    expect(p.warnings.filter((x) => x.includes("keeps Claude Code"))).toEqual([]);
  });

  it(".claude/CLAUDE.md with @../AGENTS.md → ok naming .claude/CLAUDE.md", async () => {
    const s = await primaryWorkspace({ ".claude/CLAUDE.md": "@../AGENTS.md\n" });
    expect(primaryLines(await doctorOf(s))).toEqual([
      expect.objectContaining({ level: "ok", message: "AGENTS.md arrives through the import in .claude/CLAUDE.md", case: "imports" }),
    ]);
  });

  it(".claude/CLAUDE.md with text → warn", async () => {
    const s = await primaryWorkspace({ ".claude/CLAUDE.md": `${TOKEN}\n` });
    const r = await doctorOf(s);
    expect(primaryLines(r)).toEqual([expect.objectContaining({ level: "warn", message: claudeMdBlockedMessage(".claude/CLAUDE.md"), case: "blocking" })]);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("CLAUDE.md with text and the import line → ok", async () => {
    const s = await primaryWorkspace({ "CLAUDE.md": `# notes\n${TOKEN}\n@AGENTS.md\n` });
    const r = await doctorOf(s);
    expect(primaryLines(r)).toEqual([expect.objectContaining({ level: "ok", message: "AGENTS.md arrives through the import in CLAUDE.md", case: "imports" })]);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("nothing anywhere → one ok with no case key", async () => {
    const s = await primaryWorkspace();
    const lines = primaryLines(await doctorOf(s));
    expect(lines).toEqual([{ id: "agents-md-primary", scope: "workspace", level: "ok", message: "nothing keeps Claude Code from reading AGENTS.md", fix: null }]);
    expect(Object.hasOwn(lines[0], "case")).toBe(false);
  });

  it("the mode off shows no agents-md-primary line", async () => {
    const s = await primaryWorkspace({ "CLAUDE.local.md": "# mine\n" });
    await writeFiles(s.forgeRoot, { "profiles/acme/profile.yaml": YAML.stringify(profile("acme", ["base"], ["claude-code", "agents-md"])) });
    expect(primaryLines(await doctorOf(s))).toEqual([]);
  });
});

describe("doctor's agents-md-primary above the root (spec 50 §4.2, §11 items 9–10, 23)", () => {
  for (const rel of ["CLAUDE.md", "CLAUDE.local.md", path.join(".claude", "CLAUDE.md")]) {
    it(`${rel} above, holding @AGENTS.md → warn naming the path, case blocking, the bytes in no output`, async () => {
      const s = await primaryWorkspace();
      await writeFiles(s.root, { [rel]: `@AGENTS.md\n${TOKEN}\n` });
      const r = await doctorOf(s);
      const file = path.join(s.root, rel);
      expect(primaryLines(r)).toEqual([
        { id: "agents-md-primary", scope: "workspace", level: "warn", message: ancestorMessage(file), fix: ANCESTOR_FIX, case: "blocking" },
      ]);
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });
  }

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable file above warns the same", async () => {
    const s = await primaryWorkspace();
    const file = path.join(s.root, "CLAUDE.local.md");
    await fs.writeFile(file, `${TOKEN}\n`);
    await fs.chmod(file, 0o000);
    cleanups.push(() => fs.chmod(file, 0o600));
    expect(primaryLines(await doctorOf(s))).toEqual([expect.objectContaining({ level: "warn", message: ancestorMessage(file) })]);
  });

  it("the three above at once: three warns, then a root CLAUDE.local.md import silences them all", async () => {
    const s = await primaryWorkspace();
    await writeFiles(s.root, { "CLAUDE.md": "x\n", "CLAUDE.local.md": "x\n", ".claude/CLAUDE.md": "x\n" });
    expect(primaryLines(await doctorOf(s)).filter((c) => c.level === "warn")).toHaveLength(3);
    await fs.writeFile(path.join(s.wsRoot, "CLAUDE.local.md"), "@AGENTS.md\n");
    expect(primaryLines(await doctorOf(s))).toEqual([expect.objectContaining({ level: "ok", message: "AGENTS.md arrives through the import in CLAUDE.local.md" })]);
  });

  it("the user's own .claude/CLAUDE.md is not warned — CLAUDE_CONFIG_DIR set", async () => {
    const s = await primaryWorkspace();
    await writeFiles(s.root, { ".claude/CLAUDE.md": "x\n", "CLAUDE.md": "x\n" });
    const r = await doctorOf(s, { claudeUserDir: undefined, env: { CLAUDE_CONFIG_DIR: path.join(s.root, ".claude") } });
    // The walk reached that directory (its CLAUDE.md warns); only the user's file is left out.
    expect(primaryLines(r)).toEqual([expect.objectContaining({ level: "warn", message: ancestorMessage(path.join(s.root, "CLAUDE.md")) })]);
  });

  it("the user's own CLAUDE.md is left out when the .claude directory itself is a link (a dotfiles setup)", async () => {
    const s = await primaryWorkspace();
    await writeFiles(s.root, { "dotfiles/claude/CLAUDE.md": "x\n", "CLAUDE.md": "x\n" });
    await fs.symlink(path.join(s.root, "dotfiles", "claude"), path.join(s.root, ".claude"), "junction");
    const r = await doctorOf(s, { claudeUserDir: undefined, env: { CLAUDE_CONFIG_DIR: path.join(s.root, ".claude") } });
    expect(primaryLines(r)).toEqual([expect.objectContaining({ level: "warn", message: ancestorMessage(path.join(s.root, "CLAUDE.md")) })]);
  });

  it("a directory named CLAUDE.md above is warned by lstat (edge 3)", async () => {
    const s = await primaryWorkspace();
    await fs.mkdir(path.join(s.root, "CLAUDE.md"));
    expect(primaryLines(await doctorOf(s))).toEqual([expect.objectContaining({ level: "warn", message: ancestorMessage(path.join(s.root, "CLAUDE.md")) })]);
  });

  // A file link (spec 48's rule for links in tests): run on Linux, not on Windows.
  it.skipIf(process.platform === "win32")("a dangling link named CLAUDE.local.md above is warned by lstat, never followed (edge 1)", async () => {
    const s = await primaryWorkspace();
    await fs.symlink(path.join(s.root, "nowhere"), path.join(s.root, "CLAUDE.local.md"));
    expect(primaryLines(await doctorOf(s))).toEqual([expect.objectContaining({ level: "warn", message: ancestorMessage(path.join(s.root, "CLAUDE.local.md")) })]);
  });

  it("the user's own .claude/CLAUDE.md is left out with a trailing separator on CLAUDE_CONFIG_DIR", async () => {
    const s = await primaryWorkspace();
    await writeFiles(s.root, { ".claude/CLAUDE.md": "x\n", "CLAUDE.md": "x\n" });
    const r = await doctorOf(s, { claudeUserDir: undefined, env: { CLAUDE_CONFIG_DIR: path.join(s.root, ".claude") + path.sep } });
    expect(primaryLines(r)).toEqual([expect.objectContaining({ level: "warn", message: ancestorMessage(path.join(s.root, "CLAUDE.md")) })]);
  });

  it("the user's own .claude/CLAUDE.md is left out when CLAUDE_CONFIG_DIR is spelled through a link", async () => {
    const s = await primaryWorkspace();
    await writeFiles(s.root, { ".claude/CLAUDE.md": "x\n", "CLAUDE.md": "x\n" });
    const other = await tmpDir("craftar-claude-link-");
    cleanups.push(() => fs.rm(other, { recursive: true, force: true }));
    const alias = path.join(other, "home");
    await fs.symlink(s.root, alias, "junction");
    const r = await doctorOf(s, { claudeUserDir: undefined, env: { CLAUDE_CONFIG_DIR: path.join(alias, ".claude") } });
    expect(primaryLines(r)).toEqual([expect.objectContaining({ level: "warn", message: ancestorMessage(path.join(s.root, "CLAUDE.md")) })]);
  });

  it("the user's own .claude/CLAUDE.md is not warned — CLAUDE_CONFIG_DIR unset, the home directory's", async () => {
    const s = await primaryWorkspace();
    await writeFiles(s.root, { ".claude/CLAUDE.md": "x\n", "CLAUDE.md": "x\n" });
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = s.root;
    process.env.USERPROFILE = s.root;
    try {
      expect(os.homedir()).toBe(s.root);
      const r = await doctorOf(s, { claudeUserDir: undefined, env: {} });
      // The home directory's own CLAUDE.md is an ancestor like any other (edge 2); only .claude/CLAUDE.md is the user's.
      expect(primaryLines(r)).toEqual([expect.objectContaining({ level: "warn", message: ancestorMessage(path.join(s.root, "CLAUDE.md")) })]);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// The CLI child has no seam: like any typed `doctor`, it lstats the three files in each real directory above the
// temporary directory, never reading one (on macOS and Windows that walk crosses the home directory, so a developer's
// own ~/.claude/CLAUDE.md is lstat'd there, unless CLAUDE_CONFIG_DIR — set by the test setup — names it). Any file found
// there would add a line, so the test is skipped, by the same lstat predicate doctor uses; Linux CI has none above /tmp.
const realAncestorFile = (() => {
  const present = (f: string) => {
    try {
      lstatSync(f);
      return true;
    } catch {
      return false;
    }
  };
  for (let d = realpathSync(os.tmpdir()); ; d = path.dirname(d)) {
    if (["CLAUDE.md", "CLAUDE.local.md", path.join(".claude", "CLAUDE.md")].some((f) => present(path.join(d, f)))) return true;
    if (d === path.dirname(d)) return false;
  }
})();

describe.skipIf(realAncestorFile)("exits (spec 50 §4.3, §11 item 11)", () => {
  it("a .claude/CLAUDE.md above: sync --check exits 0, doctor --strict exits 1; a root CLAUDE.local.md import: doctor --strict exits 0", async () => {
    const s = await primaryWorkspace();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    const clean = runCli(["doctor", "--strict", "--workspace", s.wsRoot]);
    expect(clean.code, clean.stdout + clean.stderr).toBe(0);

    await writeFiles(s.root, { ".claude/CLAUDE.md": `${TOKEN}\n` });
    expect(runCli(["sync", "--check", "--workspace", s.wsRoot]).code).toBe(0);
    const above = runCli(["doctor", "--strict", "--json", "--workspace", s.wsRoot]);
    expect(above.code).toBe(1);
    const line = JSON.parse(above.stdout).checks.find((c: { id: string; level: string }) => c.id === "agents-md-primary" && c.level === "warn");
    expect(line).toMatchObject({ case: "blocking" });
    expect(Object.keys(line)).toEqual(["id", "scope", "level", "message", "fix", "case"]);
    expect(above.stdout + above.stderr).not.toContain(TOKEN);

    await fs.writeFile(path.join(s.wsRoot, "CLAUDE.local.md"), "@AGENTS.md\n");
    expect(runCli(["sync", "--check", "--workspace", s.wsRoot]).code).toBe(0);
    const imported = runCli(["doctor", "--strict", "--workspace", s.wsRoot]);
    expect(imported.code, imported.stdout + imported.stderr).toBe(0);
    expect(imported.stdout).toContain("AGENTS.md arrives through the import in CLAUDE.local.md");
  });
});
