import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { exists, listFiles } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";
import { git, gitEnv } from "./helpers/remote.js";

// Spec 29 §4.4 — `craftar forge promote`: the gates, the output, --dry-run, --json, the impact passes, a late failure.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const THREE: ForgeSpec = {
  ingredients: [rule("workflow", "base text\n"), rule("workflow--acme", "acme text\n", { as: "workflow" }), rule("style", "style\n")],
  recipes: [recipe("base", ["rule/workflow", "rule/style"]), recipe("base--acme", ["rule/workflow--acme", "rule/style"])],
  profiles: [profile("acme", ["base--acme"], ["claude-code", "kiro"]), profile("globex", ["base"]), profile("initech", ["base"], ["claude-code", "kiro"])],
};

/** A committed Forge, a `CRAFTAR_HOME` of this scenario's own, and `run` bound to both. */
async function scenario(opts: { commit?: boolean; init?: boolean; extra?: Record<string, string> } = {}) {
  const root = await tmpDir("craftar-basepromo-cli-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const forge = path.join(root, "forge");
  const home = path.join(root, "home");
  await makeForge(forge, THREE);
  await writeFiles(forge, opts.extra ?? {});
  if (opts.init !== false) git(forge, "init", "-q", "-b", "main");
  if (opts.init !== false && opts.commit !== false) {
    git(forge, "add", "-A");
    git(forge, "commit", "-q", "-m", "forge");
  }
  const env = { CRAFTAR_HOME: home };
  const cli = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => runCli(args, { env: { ...env, ...extraEnv } });
  const promote = (extra: string[] = [], extraEnv: NodeJS.ProcessEnv = {}) => cli(["forge", "promote", "rule/workflow", "--profile", "acme", "--forge", forge, ...extra], extraEnv);
  /** A workspace on `name`'s profile, synced once so the registry holds it. */
  const workspace = async (name: string, config: Record<string, unknown> = {}) => {
    const ws = path.join(root, `${name}-portal`);
    await makeWorkspace(ws, forge, { config: { profile: name, ...config } });
    const r = cli(["sync", "--workspace", ws]);
    expect(r.code, r.stderr).toBe(0);
    return ws;
  };
  return { root, forge, home, cli, promote, workspace };
}
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await listFiles(dir)) if (!f.startsWith(".git/")) out[f] = (await fs.readFile(path.join(dir, f))).toString("hex");
  return out;
}
/** A refusal: exit 1, nothing on stdout, the Forge as it was; returns stderr. */
async function refused(s: { forge: string }, r: { code: number | null; stdout: string; stderr: string }, before: Record<string, string>): Promise<string> {
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(await snapshot(s.forge)).toEqual(before);
  return r.stderr;
}

const LINES = [
  "  base     rule/workflow now holds acme's text (was rule/workflow--acme)",
  "  variant  rule/workflow--globex created (the old base)",
  "  variant  rule/workflow--initech created (the old base)",
  "  recipe   base--acme: rule/workflow--acme → rule/workflow",
  "  recipe   base--globex created from base: rule/workflow → rule/workflow--globex",
  "  recipe   base--initech created from base: rule/workflow → rule/workflow--initech",
  "  profile  profiles/globex/profile.yaml: base → base--globex",
  "  profile  profiles/initech/profile.yaml: base → base--initech",
];
const NEXT = "  next     craftar forge variants — the old base now shows as 2 variant(s) to unify";
const NEXT_DRY = "  next     craftar forge variants — the old base would show as 2 variant(s) to unify";
const JSON_BODY = {
  base: "rule/workflow",
  profile: "acme",
  dryRun: false,
  removed: "rule/workflow--acme",
  created: ["rule/workflow--globex", "rule/workflow--initech"],
  recipes: { edited: ["base--acme"], created: [{ name: "base--globex", from: "base" }, { name: "base--initech", from: "base" }] },
  profiles: ["globex", "initech"],
  impact: [],
  warnings: [],
};

describe("forge promote — the command", () => {
  it("16. the happy path, --no-impact: the whole output, and the Forge changed", async () => {
    const s = await scenario();
    const r = s.promote(["--no-impact"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(["craftar forge promote rule/workflow ← acme", ...LINES, NEXT, ""].join("\n"));
    expect(await fs.readFile(path.join(s.forge, "ingredients/rules/workflow/rule.md"), "utf8")).toBe("acme text\n");
    expect(await exists(path.join(s.forge, "ingredients/rules/workflow--acme"))).toBe(false);
  });

  it("17. --json: the object of the contract, keys in order, every array present", async () => {
    const s = await scenario();
    const r = s.promote(["--no-impact", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toEqual(JSON_BODY);
    expect(Object.keys(out)).toEqual(["base", "profile", "dryRun", "removed", "created", "recipes", "profiles", "impact", "warnings"]);
    expect(Object.keys(out.recipes)).toEqual(["edited", "created"]);
  });

  it("18. --dry-run prints what would be written and writes nothing; --dry-run --json says dryRun", async () => {
    const s = await scenario();
    await s.workspace("globex");
    const before = await snapshot(s.forge);
    const r = s.promote(["--dry-run"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(
      [
        "craftar forge promote rule/workflow ← acme (dry run — nothing written)",
        "  base     rule/workflow would hold acme's text (was rule/workflow--acme)",
        "  variant  rule/workflow--globex would be created (the old base)",
        "  variant  rule/workflow--initech would be created (the old base)",
        LINES[3],
        "  recipe   base--globex would be created from base: rule/workflow → rule/workflow--globex",
        "  recipe   base--initech would be created from base: rule/workflow → rule/workflow--initech",
        ...LINES.slice(6),
        "  impact   1 workspace(s) planned: not written, not compared",
        NEXT_DRY,
        "",
      ].join("\n"),
    );
    expect(await snapshot(s.forge)).toEqual(before);
    expect(git(s.forge, "status", "--porcelain")).toBe("");
    const j = s.promote(["--dry-run", "--json"]);
    expect(j.code, j.stderr).toBe(0);
    expect(JSON.parse(j.stdout)).toEqual({ ...JSON_BODY, dryRun: true });
    expect(await snapshot(s.forge)).toEqual(before);
  });

  it("19. P2: no repository, no commit, a dirty tree, a held path git cannot restore, a created path git ignores", async () => {
    const bare = await scenario({ init: false });
    expect(await refused(bare, bare.promote(), await snapshot(bare.forge))).toBe(`error: ${bare.forge} is not a git repository — forge promote writes to the Forge and needs git as the undo\n`);

    const empty = await scenario({ commit: false });
    expect(await refused(empty, empty.promote(), await snapshot(empty.forge))).toBe(`error: ${empty.forge} has no commits yet — forge promote writes to the Forge and needs git as the undo\n`);

    const dirty = await scenario();
    await fs.writeFile(path.join(dirty.forge, "notes.txt"), "uncommitted\n");
    // Only the dirty message: the tree is checked before anything is planned.
    expect(await refused(dirty, dirty.promote(), await snapshot(dirty.forge))).toBe(`error: ${dirty.forge} is not a clean git checkout — commit or stash your changes first\n`);
    // …so a request the plan would refuse too still gets the tree's message.
    expect(await refused(dirty, dirty.cli(["forge", "promote", "rule/workflow", "--profile", "globex", "--forge", dirty.forge]), await snapshot(dirty.forge))).toBe(
      `error: ${dirty.forge} is not a clean git checkout — commit or stash your changes first\n`,
    );

    const flagged = await scenario();
    git(flagged.forge, "update-index", "--assume-unchanged", "ingredients/rules/workflow/rule.md");
    await fs.appendFile(path.join(flagged.forge, "ingredients/rules/workflow/rule.md"), "edited where git does not look\n");
    expect(await refused(flagged, flagged.promote(), await snapshot(flagged.forge))).toBe(
      `error: forge promote can only change files git can restore — 1 path(s) under ${flagged.forge} are not:\n  ingredients/rules/workflow/rule.md is not held by git (assume-unchanged)\n`,
    );

    const ignored = await scenario({ extra: { ".gitignore": "recipes/base--globex.yaml\n" } });
    expect(await refused(ignored, ignored.promote(), await snapshot(ignored.forge))).toBe(
      `error: forge promote can only change files git can restore — 1 path(s) under ${ignored.forge} are not:\n  recipes/base--globex.yaml is not held by git (ignored)\n`,
    );
  });

  it("20. a remote Forge named by a workspace is refused before anything is fetched", async () => {
    const s = await scenario();
    const ws = path.join(s.root, "remote-portal");
    await writeFiles(ws, { "craftar.yaml": YAML.stringify({ forge: "https://git.example.invalid/acme/forge.git", profile: "acme" }) });
    const r = s.cli(["forge", "promote", "rule/workflow", "--profile", "acme", "--workspace", ws]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("error: the Forge of this workspace is remote (https://git.example.invalid/acme/forge.git) — clone it and pass --forge <dir>\n");
    expect(await exists(path.join(s.home, "forges"))).toBe(false);
  });

  it("21. --forge and --workspace together are refused, as for the other forge commands", async () => {
    const s = await scenario();
    const ws = await s.workspace("globex");
    const before = await snapshot(s.forge);
    const both = s.promote(["--workspace", ws]);
    const unify = s.cli(["forge", "unify", "rule/workflow", "--profile", "acme", "--take", "base", "--forge", s.forge, "--workspace", ws]);
    expect(unify.code).toBe(1);
    expect(await refused(s, both, before)).toBe(unify.stderr);
  });

  it("22. the impact passes: three workspaces read no effect; one that adds the shared recipe by name is warned about and shown", async () => {
    const s = await scenario();
    for (const q of ["acme", "globex", "initech"]) await s.workspace(q);
    const dry = s.promote(["--dry-run"]);
    expect(dry.stdout).toContain("  impact   3 workspace(s) planned: not written, not compared\n");
    const r = s.promote();
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(["craftar forge promote rule/workflow ← acme", ...LINES, "  impact   3 workspace(s) planned before and after: no effect", NEXT, ""].join("\n"));

  });

  // Each case is a scenario of its own — a Forge, two workspaces, three runs of the CLI — so each is its own test:
  // in one test they ran past the 30 s timeout on a Windows runner.
  const BY_NAME: Array<[string, Record<string, unknown>, string[]]> = [
    // adds the shared recipe naming the base: after the promotion that recipe gives it acme's text
    ["adder", { profile: "initech", recipes: { add: ["base"] } }, [".claude/rules/workflow.md", ".kiro/steering/workflow.md"]],
    // removes the shared recipe its profile named: the profile now names the copy, so nothing is removed
    ["remover", { profile: "globex", recipes: { remove: ["base"] } }, [".claude/rules/style.md", ".claude/rules/workflow.md"]],
    // disables the variant that is removed: the base comes back enabled
    ["disabler", { profile: "acme", overrides: { ingredients: { disable: ["rule/workflow--acme"] } } }, [".claude/rules/workflow.md", ".kiro/steering/workflow.md"]],
    // disables the base, which another ingredient now is
    ["baser", { profile: "globex", overrides: { ingredients: { disable: ["rule/workflow"] } } }, [".claude/rules/workflow.md"]],
  ];
  it.each(BY_NAME)("22b. a workspace that adds or removes a recipe, or disables an ingredient, by name is warned about — %s", async (name, config, files) => {
    const t = await scenario();
    await t.workspace("initech");
    const ws = path.join(t.root, `${name}-portal`);
    await makeWorkspace(ws, t.forge, { config });
    expect(t.cli(["sync", "--workspace", ws]).code, name).toBe(0);
    const real = await fs.realpath(ws);
    const r = t.promote();
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines.filter((l) => l.startsWith("  warn ")), name).toEqual([
      `  warn ${real} (craftar.yaml) adds or removes a recipe that names rule/workflow, or disables rule/workflow or rule/workflow--acme, by name — its next sync follows the Forge, not this promotion`,
    ]);
    // One line per workspace, in unify's wording, when any changes.
    expect(lines.filter((l) => l.startsWith("  impact")).sort(), name).toEqual(
      [
        `  impact: ${await fs.realpath(path.join(t.root, "initech-portal"))} (initech) no effect`,
        `  impact: ${real} (${config.profile}) ${files.length === 1 ? `1 file changes — ${files[0]}` : `${files.length} files change — ${files.join(", ")}`}`,
      ].sort(),
    );
  });

  it("22d. a recipes.remove of a recipe this run copied concerns only a workspace whose profile it was copied for (spec 29 §20.6)", async () => {
    const t = await scenario();
    await t.workspace("initech");
    // acme is the promoted profile: it never named base, and nothing was copied for it.
    const ws = path.join(t.root, "acme-remover-portal");
    await makeWorkspace(ws, t.forge, { config: { profile: "acme", recipes: { remove: ["base"] } } });
    expect(t.cli(["sync", "--workspace", ws]).code).toBe(0);
    const r = t.promote();
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.split("\n").filter((l) => l.startsWith("  warn "))).toEqual([]);
  });

  it.each([
    ["the removal in craftar.local.yaml, the profile in craftar.yaml", { profile: "globex" }, { recipes: { remove: ["base"] } }, "craftar.local.yaml"],
    ["the profile in craftar.local.yaml, the removal in craftar.yaml", { recipes: { remove: ["base"] } }, { profile: "globex" }, "craftar.yaml"],
  ] as const)("22e. a recipes.remove split from its profile across the two files is still warned about — %s", async (_name, config, local, file) => {
    const t = await scenario();
    await t.workspace("initech");
    const ws = path.join(t.root, "split-portal");
    await makeWorkspace(ws, t.forge, { config: { ...config }, local: { ...local } });
    expect(t.cli(["sync", "--workspace", ws]).code).toBe(0);
    const real = await fs.realpath(ws);
    const r = t.promote();
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.split("\n").filter((l) => l.startsWith("  warn "))).toEqual([
      `  warn ${real} (${file}) adds or removes a recipe that names rule/workflow, or disables rule/workflow or rule/workflow--acme, by name — its next sync follows the Forge, not this promotion`,
    ]);
  });

  it("22b. --json carries the same: a row's keys in unify's order, the changed files, the warning", async () => {
    const t = await scenario();
    const ws = path.join(t.root, "adder-portal");
    await makeWorkspace(ws, t.forge, { config: { profile: "initech", recipes: { add: ["base"] } } });
    expect(t.cli(["sync", "--workspace", ws]).code).toBe(0);
    const out = JSON.parse(t.promote(["--json"]).stdout);
    expect(Object.keys(out.impact[0])).toEqual(["path", "profile", "match", "via", "ref", "state", "files", "error"]);
    expect(out.impact.map((x: { state: string; files: string[] }) => [x.state, x.files])).toEqual([["changed", [".claude/rules/workflow.md", ".kiro/steering/workflow.md"]]]);
    expect(out.warnings).toHaveLength(1);
  });

  it("22c. no other profile on the base: the discarded line and no next line; an empty registry: its own impact line", async () => {
    const s = await scenario();
    for (const q of ["globex", "initech"]) await fs.rm(path.join(s.forge, "profiles", q), { recursive: true });
    git(s.forge, "add", "-A");
    git(s.forge, "commit", "-q", "-m", "acme alone");
    const r = s.promote();
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(
      [
        "craftar forge promote rule/workflow ← acme",
        LINES[0],
        "  the old base is resolved by no profile — discarded (git holds it)",
        LINES[3],
        "  impact   no workspace of this Forge is registered on this machine",
        "",
      ].join("\n"),
    );
  });

  it("23. the registry off or unreadable: the command runs, and warns that no workspace was checked", async () => {
    const off = await scenario();
    const r = off.promote([], { CRAFTAR_NO_REGISTRY: "1" });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(["craftar forge promote rule/workflow ← acme", ...LINES, "  warn the registry is off — no workspace was checked", NEXT, ""].join("\n"));

    const broken = await scenario();
    await writeFiles(broken.home, { "registry.json": "{" });
    const b = broken.promote(["--json"]);
    expect(b.code, b.stderr).toBe(0);
    const warnings: string[] = JSON.parse(b.stdout).warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^the registry could not be read \(.+\) — no workspace was checked$/);
    expect(JSON.parse(b.stdout).impact).toEqual([]);
  });

  // A directory's mode does not stop a write on Windows, and root ignores it: the scenario cannot fail there.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("24. a write that fails midway names the paths already written and the git recovery", async () => {
    const s = await scenario();
    // A directory nothing can be created in: the proof's scratch copy does not carry the mode, the Forge does.
    const locked = path.join(s.forge, "recipes");
    cleanups.push(() => fs.chmod(locked, 0o755).catch(() => undefined));
    await fs.chmod(locked, 0o555);
    const r = s.promote(["--no-impact"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`forge promote had already started changing the Forge (${s.forge}) when this failed:`);
    expect(r.stderr).toMatch(/git -C \S+ checkout -- ingredients\/rules\/workflow\/rule\.md ingredients\/rules\/workflow\/ingredient\.yaml\n/);
    expect(r.stderr).toMatch(/git -C \S+ clean -f -- ingredients\/rules\/workflow--globex\/rule\.md .*ingredients\/rules\/workflow--initech\/ingredient\.yaml recipes\/base--globex\.yaml\n/);
    // Nothing after the failed write was touched: no recipe, no profile — and the removals come last, so the variant is still there.
    await fs.chmod(locked, 0o755);
    expect(git(s.forge, "status", "--porcelain", "recipes", "profiles", "ingredients/rules/workflow--acme")).toBe("");
    // The recovery, run as printed, gives back a Forge the same command accepts — and then writes.
    for (const line of r.stderr.split("\n").filter((l) => l.startsWith("  git -C "))) execSync(line.trim(), { env: gitEnv() });
    expect(git(s.forge, "status", "--porcelain")).toBe("");
    const again = s.promote(["--no-impact"]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toBe(["craftar forge promote rule/workflow ← acme", ...LINES, NEXT, ""].join("\n"));
  });

  it("25. --help names the argument, every option and that it writes to the Forge", () => {
    const help = runCli(["forge", "promote", "--help"]).stdout.replace(/\s+/g, " ");
    for (const part of [
      "Usage: craftar forge promote [options] <type/name>",
      "Make a profile's variant the base",
      "every profile is proved to resolve the same ingredients before anything is written. Writes to the Forge",
      "--profile <p> the profile whose variant becomes the base",
      "--forge <dir>",
      "--workspace <dir>",
      "--no-impact skip planning the registered workspaces of this Forge before and after the writes",
      "--dry-run run every check and the first impact pass, print what would be written, and write nothing",
      "--json machine-readable output",
    ]) {
      expect(help).toContain(part);
    }
    expect(runCli(["forge", "--help"]).stdout).toContain("promote [options] <type/name>");
  });

  it("26. afterwards every workspace still passes sync --check, and the old base unifies like any variant", async () => {
    const s = await scenario();
    const workspaces = [];
    for (const q of ["acme", "globex", "initech"]) workspaces.push(await s.workspace(q));
    expect(s.promote().code).toBe(0);
    for (const ws of workspaces) {
      const check = s.cli(["sync", "--check", "--workspace", ws]);
      expect(check.code, check.stdout + check.stderr).toBe(0);
    }
    git(s.forge, "add", "-A");
    git(s.forge, "commit", "-q", "-m", "promote");
    const unify = s.cli(["forge", "unify", "rule/workflow", "--profile", "globex", "--take", "variant", "--forge", s.forge]);
    expect(unify.code, unify.stderr).toBe(0);
    expect(await exists(path.join(s.forge, "ingredients/rules/workflow--globex"))).toBe(false);
  });

  it("27. a refusal of the plan or of the proof exits 1 with its message and the Forge untouched", async () => {
    const s = await scenario();
    const before = await snapshot(s.forge);
    expect(await refused(s, s.cli(["forge", "promote", "rule/workflow", "--profile", "globex", "--forge", s.forge]), before)).toBe("error: forge promote: rule/workflow has no variant for profile globex\n");
    // P7 through the command: globex's recipe by name, which initech resolves too.
    const shared = await scenario();
    await fs.rm(path.join(shared.forge, "recipes/base.yaml"));
    await writeFiles(shared.forge, {
      "recipes/base--globex.yaml": YAML.stringify(recipe("base--globex", ["rule/workflow", "rule/style"])),
      "profiles/globex/profile.yaml": YAML.stringify(profile("globex", ["base--globex"])),
      "profiles/initech/profile.yaml": YAML.stringify(profile("initech", ["base--globex"])),
    });
    git(shared.forge, "add", "-A");
    git(shared.forge, "commit", "-q", "-m", "owned by name, shared in fact");
    expect(await refused(shared, shared.promote(), await snapshot(shared.forge))).toBe(
      "error: forge promote: profile initech would not resolve the same after the promotion — its ingredients differ at position 1 (rule/workflow--globex ≠ rule/workflow--initech); nothing written\n",
    );
  });
});
