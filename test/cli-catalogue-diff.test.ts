import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import YAML from "yaml";
import { makeForge, profile, recipe, rule, scenario, tmpDir, writeFiles, type IngredientSpec } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";
import { runCli } from "./helpers/cli.js";
import { git, remoteForge } from "./helpers/remote.js";
import { TSX_LOADER } from "./helpers/tsx-loader.js";
import { exists, listFiles } from "../src/core/forge.js";
import { UnifyPlanSchema } from "../src/schema/index.js";
import { cacheKey, ensureTree, UNVOUCHED_HIDDEN } from "../src/core/remote.js";
import { atLeastWin32 } from "./helpers/timeouts.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Every file under root with its content, so a before/after comparison catches an in-place edit. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files = (await listFiles(root)).filter((f) => f !== ".git" && !f.startsWith(".git/"));
  return Object.fromEntries(await Promise.all(files.map(async (f) => [f, await fs.readFile(path.join(root, f), "utf8")] as const)));
}

/** A fake but stable identity, so `git commit` never depends on the host's ambient config. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "craftar-test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "craftar-test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "maintenance.auto", "false"]);
  execFileSync("git", ["-C", dir, "config", "gc.auto", "0"]);
}

function gitCommitAll(dir: string, message: string): void {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", message], { env: gitEnv() });
}

/* ------------------------------------------------------------------ */
/* craftar ls pin (spec 16 §10.3): captures the exact output before  */
/* the catalogue commands, so a later change is a test failure.       */
/* ------------------------------------------------------------------ */
describe("craftar ls pin (spec 16 §10.3)", () => {
  it("prints the exact expected output on the golden acme-portal workspace", async () => {
    // Set up the golden scenario: import acme-portal to create a Forge and craftar.yaml
    const root = await tmpDir("craftar-ls-pin-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const portal = path.join(root, "acme-portal");
    const forge = path.join(root, "forge");

    // Copy the golden workspace
    async function cp(src: string, dst: string) {
      for (const rel of await listFiles(src)) {
        await fs.mkdir(path.dirname(path.join(dst, rel)), { recursive: true });
        await fs.copyFile(path.join(src, rel), path.join(dst, rel));
      }
    }
    await cp(path.join(__dirname, "golden", "acme-portal"), portal);

    // Import to create the Forge and craftar.yaml
    const imp = runCli([
      "import",
      "--from", "claude-code",
      "--workspace", portal,
      "--forge", forge,
      "--profile", "acme-portal",
      "--write-config",
    ]);
    expect(imp.code).toBe(0);

    // Run ls and capture output
    const r = runCli(["ls", "--workspace", portal]);
    expect(r.code).toBe(0);

    // The expected output.
    // The Forge name is "forge" (from importClaudeCode default), commit is "no git" (temp dir has no git).
    // The output is pinned so any change to ls is caught.
    const expected = `Forge forge @ no git · profile acme-portal

base — Always-on conventions, commands, agents, scripts and MCP servers.
  rule/commit-conventions
  rule/workflow
  agent/docs-author
  agent/release-helper
  command/commit-push
  skill/spec-driven
  script/check-branch
  mcp/playwright

stack-backend-node — Conventions + reviewer for repos matching projects/acme-api/**
  rule/backend-node
  agent/backend-node-reviewer

acme-portal-steering — Hand-written Kiro steering specific to acme-portal.
  steering/product

20 files across targets claude-code, kiro
`;

    expect(r.stdout).toBe(expected);
  });
});

/* ------------------------------------------------------------------ */
/* spec 16 §10.3: craftar recipes, ingredients, targets               */
/* ------------------------------------------------------------------ */
describe("cli — the read-only catalogue (spec 16 §10.3)", () => {
  const CAT_FORGE = {
    ingredients: [
      rule("angular-standards", "# A\n", { description: "Angular conventions" }),
      rule("commit-style", "# C\n"),
      rule("old-naming", "# O\n", { targets: ["kiro"] }),
      rule("workflow--acme", "# W\n", { as: "workflow" }),
      { meta: { type: "agent", name: "angular-reviewer" } },
    ],
    recipes: [
      recipe("base", ["rule/workflow--acme", "rule/commit-style", "rule/gone"], { description: "Shared conventions" }),
      recipe("stack-angular", ["rule/angular-standards", "agent/angular-reviewer"], { description: "Angular front end", slot: "frontend", extends: ["base"] }),
    ],
    profiles: [profile("acme", ["base"], ["claude-code", "kiro"])],
  };
  const CAT_WS = { profile: "acme", recipes: { add: ["stack-angular"] }, overrides: { ingredients: { disable: ["rule/commit-style"] } } };
  const GONE = 'recipe "base" references missing ingredient rule/gone';

  async function cat(config: Record<string, unknown> = CAT_WS) {
    const s = await scenario(CAT_FORGE, { config });
    cleanups.push(s.cleanup);
    await writeFiles(s.forgeRoot, { "craftar.forge.yaml": "name: acme-forge\nschema: 1\n" });
    return s;
  }
  async function bare() {
    const dir = await tmpDir("craftar-cat-bare-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
  }
  const json = (r: { code: number | null; stdout: string; stderr: string }) => {
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    return JSON.parse(r.stdout);
  };
  const keys = (o: object) => Object.keys(o).sort();

  it("recipes --json: exactly the key set of §4.2 at every level", async () => {
    const s = await cat();
    const j = json(runCli(["recipes", "--json", "--workspace", s.wsRoot]));
    expect(keys(j)).toEqual(["context", "forge", "recipes", "warnings"]);
    expect(keys(j.forge)).toEqual(["commit", "name"]);
    expect(keys(j.context)).toEqual(["kind", "profile", "recipes"]);
    for (const r of j.recipes) expect(keys(r)).toEqual(["description", "extends", "inUse", "ingredients", "name", "profiles", "removedByWorkspace", "slot"]);
    expect(keys(j.recipes[0].inUse)).toEqual(["by", "extendedBy", "order"]);
    expect(j.warnings).toEqual([GONE]);
  });

  it("ingredients --json: exactly the key set of §4.3 at every level", async () => {
    const s = await cat();
    const j = json(runCli(["ingredients", "--json", "--recipe", "stack-angular", "--workspace", s.wsRoot]));
    expect(keys(j)).toEqual(["context", "forge", "ingredients", "missing", "recipe", "warnings"]);
    expect(keys(j.recipe)).toEqual(["chain", "name"]);
    for (const c of j.recipe.chain) expect(keys(c)).toEqual(["ingredients", "recipe"]);
    for (const i of j.ingredients) expect(keys(i)).toEqual(["description", "disabled", "inUse", "name", "outputName", "recipes", "ref", "targets", "type"]);
    expect(j.missing).toEqual([{ ref: "rule/gone", recipes: ["base"] }]);
    expect(j.warnings).toEqual([GONE]);
  });

  it("targets --json: exactly the key set of §4.4 at every level, 54 cells", async () => {
    const dir = await bare();
    const j = json(runCli(["targets", "--json"], { cwd: dir }));
    expect(keys(j)).toEqual(["ingredientTypes", "targets", "warnings"]);
    expect(j.ingredientTypes).toEqual(["rule", "agent", "command", "skill", "mcp", "script", "steering", "hook", "service"]);
    expect(j.targets.map((t: { name: string }) => t.name)).toEqual(["claude-code", "kiro", "agents-md", "cursor", "copilot", "agent-skills"]);
    let cells = 0;
    for (const t of j.targets) {
      expect(keys(t)).toEqual(["capabilities", "inUse", "name"]);
      expect(Object.keys(t.capabilities)).toEqual(j.ingredientTypes);
      for (const c of Object.values(t.capabilities) as object[]) {
        expect(keys(c)).toEqual(["note", "output", "state"]);
        cells++;
      }
    }
    expect(cells).toBe(54);
    expect(j.targets[1].capabilities.rule).toEqual({
      state: "converted",
      output: [".kiro/steering/<name>.md"],
      note: "inclusion frontmatter and a banner are added; a .claude/rules/ reference becomes .kiro/steering/ when kiro writes that file, and otherwise follows the rule it names (kept for claude-code, AGENTS.md (rule: <x>), or <x> (rule not in this workspace) with a warning)",
    });
    expect(j.targets[1].capabilities.script).toEqual({ state: "unsupported", output: [], note: "skipped with a warning when aimed at this target" });
    expect(j.warnings).toEqual([]);
  });

  it("recipes and ingredients: --forge alone, --forge --profile, inside a workspace (cwd), --workspace", async () => {
    const s = await cat();
    for (const cmd of ["recipes", "ingredients"]) {
      expect(json(runCli([cmd, "--json", "--forge", s.forgeRoot])).context, cmd).toBeNull();
      expect(json(runCli([cmd, "--json", "--forge", s.forgeRoot, "--profile", "acme"])).context, cmd).toEqual({ kind: "profile", profile: "acme", recipes: ["base"] });
      const inWs = { kind: "workspace", profile: "acme", recipes: ["base", "stack-angular"] };
      expect(json(runCli([cmd, "--json"], { cwd: s.wsRoot })).context, cmd).toEqual(inWs);
      expect(json(runCli([cmd, "--json", "--workspace", s.wsRoot])).context, cmd).toEqual(inWs);
    }
  });

  it("recipes and ingredients: every refusal of §4.1 exits 1 with its message", async () => {
    const s = await cat();
    const outside = await bare();
    const notForge = await bare();
    const err = (msg: string) => `error: ${msg}\n`;
    for (const cmd of ["recipes", "ingredients"]) {
      const cases: Array<[string[], string | undefined, string]> = [
        [[cmd, "--forge", s.forgeRoot, "--workspace", s.wsRoot], undefined, err("pass either --forge or --workspace, not both — two sources for one Forge")],
        [[cmd], outside, err(`no craftar.yaml in ${outside} — run this inside a workspace, pass --workspace <dir>, or point at the Forge with --forge <dir>`)],
        [[cmd, "--workspace", outside], undefined, err(`no craftar.yaml in ${outside} — run this inside a workspace, pass --workspace <dir>, or point at the Forge with --forge <dir>`)],
        [[cmd, "--forge", notForge], undefined, err(`not a Forge: ${path.join(notForge, "craftar.forge.yaml")} not found`)],
        [[cmd, "--profile", "acme", "--workspace", s.wsRoot], undefined, err("--profile goes with --forge — inside a workspace the profile comes from craftar.yaml")],
        [[cmd, "--profile", "acme"], s.wsRoot, err("--profile goes with --forge — inside a workspace the profile comes from craftar.yaml")],
        [[cmd, "--forge", s.forgeRoot, "--profile", "nobody"], undefined, err('profile "nobody" not found in Forge (acme)')],
      ];
      for (const [args, cwd, stderr] of cases) {
        const r = runCli(args, cwd ? { cwd } : {});
        expect(r.code, args.join(" ")).toBe(1);
        expect(r.stderr, args.join(" ")).toBe(stderr);
        expect(r.stdout, args.join(" ")).toBe("");
      }
    }
  });

  it("recipes and ingredients: a workspace that does not load, or names an unknown profile, exits 1", async () => {
    for (const cmd of ["recipes", "ingredients"]) {
      const invalid = await cat();
      await fs.writeFile(path.join(invalid.wsRoot, "craftar.yaml"), "forge: 42\nprofile: acme\n");
      const r1 = runCli([cmd, "--workspace", invalid.wsRoot]);
      expect(r1.code, cmd).toBe(1);
      expect(r1.stderr.startsWith("error: invalid craftar.yaml: "), cmd).toBe(true);

      const gone = await cat();
      await fs.rm(gone.forgeRoot, { recursive: true, force: true });
      const r2 = runCli([cmd, "--workspace", gone.wsRoot]);
      expect(r2.code, cmd).toBe(1);
      expect(r2.stderr, cmd).toBe(`error: Forge not found at ${gone.forgeRoot}\n`);

      const unknown = await cat({ profile: "nobody" });
      const r3 = runCli([cmd, "--workspace", unknown.wsRoot]);
      expect(r3.code, cmd).toBe(1);
      expect(r3.stderr, cmd).toBe('error: profile "nobody" not found in Forge (acme)\n');
    }
  });

  it("ingredients: an unknown --recipe and an unknown --type exit 1", async () => {
    const s = await cat();
    const r1 = runCli(["ingredients", "--recipe", "nope", "--workspace", s.wsRoot]);
    expect([r1.code, r1.stderr]).toEqual([1, 'error: recipe "nope" not found in this Forge (base, stack-angular)\n']);
    const r2 = runCli(["ingredients", "--type", "widget", "--workspace", s.wsRoot]);
    expect([r2.code, r2.stderr]).toEqual([1, 'error: unknown ingredient type "widget" — one of rule, agent, command, skill, mcp, script, steering, hook, service\n']);
  });

  it("targets: no craftar.yaml (a bare dir, a Forge dir) → every inUse null, exit 0", async () => {
    const s = await cat();
    for (const cwd of [await bare(), s.forgeRoot]) {
      const j = json(runCli(["targets", "--json"], { cwd }));
      expect(j.targets.map((t: { inUse: unknown }) => t.inUse)).toEqual([null, null, null, null, null, null]);
      expect(j.warnings).toEqual([]);
    }
  });

  it("targets: in a workspace the resolved targets are true, the rest false; a profile with no targets is all false", async () => {
    const s = await cat();
    expect(json(runCli(["targets", "--json"], { cwd: s.wsRoot })).targets.map((t: { inUse: unknown }) => t.inUse)).toEqual([true, true, false, false, false, false]);
    expect(json(runCli(["targets", "--json", "--workspace", s.wsRoot])).targets.map((t: { inUse: unknown }) => t.inUse)).toEqual([true, true, false, false, false, false]);
    const none = await cat({ profile: "acme", targets: [] });
    expect(json(runCli(["targets", "--json", "--workspace", none.wsRoot])).targets.map((t: { inUse: unknown }) => t.inUse)).toEqual([false, false, false, false, false, false]);
  });

  it("targets: --workspace on a dir without craftar.yaml exits 1; --forge is an unknown option", async () => {
    const dir = await bare();
    const r = runCli(["targets", "--workspace", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      `error: craftar.yaml not found in ${dir} — run \`craftar init --workspace "${dir}" --forge <dir> --profile <name>\` to start one, or \`craftar import --workspace "${dir}" --from claude-code --forge <dir> --profile <name> --write-config\` to bring in an existing harness\n`,
    );
    const s = await cat();
    const f = runCli(["targets", "--forge", s.forgeRoot]);
    expect(f.code).toBe(1);
    expect(f.stderr).toContain("unknown option '--forge'");
  });

  it("targets: a workspace whose Forge is gone, or that names an unknown profile, prints the matrix with the warning, exit 0", async () => {
    const gone = await cat();
    await fs.rm(gone.forgeRoot, { recursive: true, force: true });
    const j1 = json(runCli(["targets", "--json", "--workspace", gone.wsRoot]));
    expect(j1.targets.map((t: { inUse: unknown }) => t.inUse)).toEqual([null, null, null, null, null, null]);
    expect(j1.warnings).toEqual([
      `targets in use not shown: Forge not found at ${gone.forgeRoot}`,
    ]);
    const unknown = await cat({ profile: "nobody" });
    const j2 = json(runCli(["targets", "--json", "--workspace", unknown.wsRoot]));
    expect(j2.warnings).toEqual(['targets in use not shown: profile "nobody" not found in Forge (acme)']);
    const t2 = runCli(["targets", "--workspace", unknown.wsRoot]);
    expect(t2.code).toBe(0);
    expect(t2.stdout.trimEnd().split("\n").at(-1)).toBe('  warn targets in use not shown: profile "nobody" not found in Forge (acme)');
  });

  it("a rule with a malformed section marker: ls exits 1 (it plans), recipes and ingredients exit 0 (they do not)", async () => {
    const s = await scenario(
      { ingredients: [rule("broken", "# B\n<!--craftar:section x-->\nbody\n")], recipes: [recipe("base", ["rule/broken"])], profiles: [profile("acme", ["base"])] },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    expect(runCli(["ls", "--workspace", s.wsRoot]).code).toBe(1);
    expect(runCli(["recipes", "--workspace", s.wsRoot]).code).toBe(0);
    expect(runCli(["ingredients", "--workspace", s.wsRoot]).code).toBe(0);
  });

  it("--json: stdout is one JSON document and the warnings are only inside it", async () => {
    const s = await cat();
    for (const args of [["recipes"], ["ingredients"], ["ingredients", "--recipe", "stack-angular"]]) {
      const r = runCli([...args, "--json", "--workspace", s.wsRoot]);
      const j = json(r);
      expect(j.warnings, args.join(" ")).toEqual([GONE]);
      expect(r.stdout.match(/references missing ingredient/g), args.join(" ")).toHaveLength(1);
      expect(r.stdout.endsWith("}\n"), args.join(" ")).toBe(true);
    }
  });

  it("text mode: recipes header, count line and warn line", async () => {
    const s = await cat();
    const r = runCli(["recipes", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("craftar recipes — forge acme-forge @ no git · workspace profile acme");
    expect(lines.at(-2)).toBe("  2 recipes, 2 in use · used by profiles: base (acme), stack-angular (—)");
    expect(lines.at(-1)).toBe(`  warn ${GONE}`);
    expect(lines.find((l) => l.includes(" base "))).toMatch(/^  ● base .*in use \(profile, extends stack-angular\)\s+— Shared conventions$/);
    expect(lines.find((l) => l.includes(" stack-angular "))).toMatch(/^  ● stack-angular \[slot frontend\]\s+2 ingredients\s+← base\s+in use \(workspace\)\s+— Angular front end$/);
  });

  it("text mode: ingredients header, count line and warn line; --recipe groups", async () => {
    const s = await cat();
    const r = runCli(["ingredients", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("craftar ingredients — forge acme-forge @ no git · workspace profile acme");
    expect(lines.at(-2)).toBe("  5 ingredients, 3 in use, 1 disabled, 1 in no recipe · 1 missing reference");
    expect(lines.at(-1)).toBe(`  warn ${GONE}`);
    expect(lines.filter((l) => !l.startsWith(" ") && l !== "")).toEqual([lines[0], "rule", "agent", "missing"]);
    expect(lines.find((l) => l.includes("rule/gone"))).toMatch(/^  rule\/gone\s+cited by base, not in this Forge$/);

    const g = runCli(["ingredients", "--recipe", "stack-angular", "--workspace", s.wsRoot]);
    const gl = g.stdout.trimEnd().split("\n");
    expect(gl[0]).toBe("craftar ingredients --recipe stack-angular — forge acme-forge @ no git · workspace profile acme");
    expect(gl.at(-2)).toBe("  2 recipes, 4 ingredients · 1 missing reference");
    expect(gl.filter((l) => !l.startsWith(" ") && l !== "").slice(1).map((l) => l.replace(/\s+/g, " "))).toEqual(["base", "stack-angular ← base [slot frontend]"]);
    expect(gl.find((l) => l.includes("rule/gone"))).toMatch(/^  ✗ rule\/gone\s+not in this Forge$/);
  });

  it("text mode: targets header, matrix, legend and one paths line per writing cell (23) plus services", async () => {
    const s = await cat();
    const r = runCli(["targets"], { cwd: s.wsRoot });
    expect(r.code).toBe(0);
    const norm = r.stdout.trimEnd().split("\n").map((l) => l.trim().replace(/ {2,}/g, " "));
    expect(norm[0]).toBe("craftar targets — claude-code (in use) · kiro (in use) · agents-md · cursor · copilot · agent-skills");
    const at = norm.indexOf("claude-code kiro agents-md cursor copilot agent-skills");
    expect(at).toBeGreaterThan(0);
    expect(norm.slice(at + 1, at + 10)).toEqual([
      "rule native converted converted converted converted unsupported",
      "agent native converted unsupported converted converted unsupported",
      "command native converted unsupported unsupported converted converted",
      "skill native converted unsupported unsupported unsupported converted",
      "mcp native native unsupported converted converted unsupported",
      "script native unsupported unsupported unsupported unsupported unsupported",
      "steering unsupported native unsupported unsupported unsupported unsupported",
      "hook native unsupported unsupported unsupported unsupported unsupported",
      "service unsupported unsupported unsupported unsupported unsupported unsupported",
    ]);
    expect(norm).toContain("native written in the tool's own place for that type, as the Forge holds it");
    expect(norm).toContain("converted written in another form — see its line below");
    expect(norm).toContain("unsupported not written; sync warns and names an ingredient aimed at this target");
    const p = norm.indexOf("paths");
    expect(norm.slice(p + 1, -2)).toEqual([
      "claude-code · rule .claude/rules/<name>.md",
      "kiro · rule .kiro/steering/<name>.md — inclusion frontmatter and a banner are added; a .claude/rules/ reference becomes .kiro/steering/ when kiro writes that file, and otherwise follows the rule it names (kept for claude-code, AGENTS.md (rule: <x>), or <x> (rule not in this workspace) with a warning)",
      "agents-md · rule AGENTS.md — always-on rules are embedded in AGENTS.md; a scoped rule is listed at the file another target writes, or embedded when none does; .claude/rules/ references in the bodies, link text included, point at the file a target writes or the rule's place in AGENTS.md, or read <x> (rule not in this workspace) with a warning",
      "cursor · rule .cursor/rules/<name>.mdc — written as .mdc: alwaysApply: true for an always-on rule, globs from fileMatchPattern for a scoped one, a description alone for an auto or a manual one; the body unchanged",
      "copilot · rule .github/instructions/<name>.instructions.md, .github/copilot-instructions.md — a scoped rule to .github/instructions/ with applyTo from fileMatchPattern; every always-on rule joined into .github/copilot-instructions.md; a manual or an auto rule has no Copilot equivalent and is skipped with a warning; VS Code also reads .claude/rules/, so with claude-code on it loads a scoped rule twice",
      "claude-code · agent .claude/agents/<name>.md",
      "kiro · agent .kiro/agents/<name>.json — written as JSON; tools mapped to Kiro names, one with no equivalent dropped with a warning; permissions.rules derived from the mapped tools; .claude/rules/ references resolved as for a rule; resources taken from the ingredient, else derived from the steering files",
      "cursor · agent .cursor/agents/<name>.md — name, description and model kept; tools have no Cursor field and are dropped with a warning",
      "copilot · agent .github/agents/<name>.agent.md — name, description and model kept; tools mapped to Copilot's aliases (read, edit, search, execute, web, agent, todo), a tool with no alias dropped with a warning",
      "claude-code · command .claude/commands/<name>.md",
      "kiro · command .kiro/steering/commands/<name>.md — written as manual steering; .claude/rules/ references resolved as for a rule, in the body and the description",
      "copilot · command .github/prompts/<name>.prompt.md — written as a VS Code prompt file with description, argument-hint and agent: agent",
      "agent-skills · command .agents/skills/<name>/SKILL.md — written as a skill only a person invokes (disable-model-invocation: true), read by every tool that reads .agents/skills/; a command and a skill with one name fail the plan",
      "claude-code · skill .claude/skills/<name>/<file>, .claude/skills/<name>.md",
      "kiro · skill .kiro/skills/<name>/<file> — in its text files (.md, .txt, .json, .yaml, .yml), .claude/rules/ references resolved as for a rule; other files are copied as they are; a single-file skill becomes <name>/SKILL.md",
      "agent-skills · skill .agents/skills/<name>/<file> — copied into .agents/skills/<name>/; a single-file skill becomes <name>/SKILL.md",
      "claude-code · mcp .mcp.json, .claude/settings.craftar.example.json",
      "kiro · mcp .kiro/settings/mcp.json",
      "cursor · mcp .cursor/mcp.json — the servers under mcpServers; a ${NAME} reference becomes ${env:NAME}",
      "copilot · mcp .vscode/mcp.json — the servers under servers (VS Code's key), each kept whole; a ${NAME} reference becomes ${env:NAME}; the Copilot CLI reads the .mcp.json claude-code writes",
      "claude-code · script .claude/scripts/<file>",
      "kiro · steering .kiro/steering/<name>.md",
      "claude-code · hook .claude/hooks/<file>, .claude/settings.craftar.example.json — the registration is written to .claude/settings.craftar.example.json, to copy",
    ]);
    // Services are not a target; they get their own line after the paths block (spec 31 §4.7)
    expect(norm[norm.length - 1]).toBe("service: written by sync under .craftar/ for no target; see craftar services");
    const bareRun = runCli(["targets"], { cwd: await bare() });
    expect(bareRun.stdout.split("\n")[0]).toBe("craftar targets — claude-code · kiro · agents-md · cursor · copilot · agent-skills");
  });

  it("the header carries the first 8 characters of the Forge commit, --json the full SHA", async () => {
    const s = await cat();
    gitInit(s.forgeRoot);
    gitCommitAll(s.forgeRoot, "init");
    const sha = execFileSync("git", ["-C", s.forgeRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(json(runCli(["recipes", "--json", "--forge", s.forgeRoot])).forge).toEqual({ name: "acme-forge", commit: sha });
    expect(runCli(["recipes", "--forge", s.forgeRoot]).stdout.split("\n")[0]).toBe(`craftar recipes — forge acme-forge @ ${sha.slice(0, 8)}`);
    expect(runCli(["ingredients", "--forge", s.forgeRoot, "--profile", "acme"]).stdout.split("\n")[0]).toBe(
      `craftar ingredients — forge acme-forge @ ${sha.slice(0, 8)} · profile acme`,
    );
  });

  // One test per command: a single test starting all thirteen children passed the 30 s limit on a Windows runner.
  // Each command is run as before — text and --json, by --workspace and from inside the workspace — and the
  // Forge and the workspace are compared with what they held before it.
  const WRITES_NOTHING: Array<[string, string[][]]> = [
    ["recipes", [["recipes"], ["recipes", "--json"]]],
    ["ingredients", [["ingredients"], ["ingredients", "--json", "--recipe", "stack-angular", "--type", "rule"]]],
    ["targets", [["targets"], ["targets", "--json"]]],
  ];
  for (const [command, runs] of WRITES_NOTHING) {
    it(`${command} writes nothing in the workspace or the Forge`, async () => {
      const s = await cat();
      const before = { forge: await snapshot(s.forgeRoot), ws: await snapshot(s.wsRoot) };
      for (const args of runs) {
        expect(runCli([...args, "--workspace", s.wsRoot]).code, args.join(" ")).toBe(0);
        expect(runCli(args, { cwd: s.wsRoot }).code, args.join(" ")).toBe(0);
      }
      if (command === "recipes") expect(json(runCli(["recipes", "--json", "--forge", s.forgeRoot, "--profile", "acme"])).context).not.toBeNull();
      expect({ forge: await snapshot(s.forgeRoot), ws: await snapshot(s.wsRoot) }).toEqual(before);
    });
  }
});


describe("cli — the catalogue's text mode (spec 16 §4.2, §4.3)", () => {
  async function two() {
    const s = await scenario(
      {
        ingredients: [rule("a", "# A\n"), rule("long-rule-name--acme", "# L\n", { as: "long-rule-name", description: "Long one" })],
        recipes: [recipe("base", ["rule/a"]), recipe("stack-angular", ["rule/long-rule-name--acme"], { slot: "frontend", extends: ["base"] })],
        profiles: [profile("acme", ["stack-angular"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    return s;
  }

  it("--forge alone: no mark symbol and no 'in use' count", async () => {
    const s = await two();
    const r = runCli(["recipes", "--forge", s.forgeRoot]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/[●○◌]/);
    expect(r.stdout.trimEnd().split("\n").at(-1)).toBe("  2 recipes · used by profiles: base (acme), stack-angular (acme)");
    const i = runCli(["ingredients", "--forge", s.forgeRoot]);
    expect(i.code).toBe(0);
    expect(i.stdout).not.toMatch(/[●○◌]/);
    expect(i.stdout.trimEnd().split("\n").at(-1)).toBe("  2 ingredients, 0 in no recipe");
  });

  it("recipes rows: the ingredient count starts at one column for every row", async () => {
    const s = await two();
    const rows = runCli(["recipes", "--workspace", s.wsRoot]).stdout.split("\n").filter((l) => /^  [●○ ] /.test(l));
    expect(rows).toHaveLength(2);
    const at = rows.map((l) => l.search(/\d+ ingredients?/));
    expect(at[0]).toBeGreaterThan(0);
    expect(at[1]).toBe(at[0]);
    expect(rows.every((l) => l === l.trimEnd())).toBe(true);
  });

  it("ingredients rows: name → outputName, and targets starts at one column", async () => {
    const s = await two();
    const lines = runCli(["ingredients", "--workspace", s.wsRoot]).stdout.split("\n");
    const rows = lines.filter((l) => l.includes(" targets "));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatch(/^  ● long-rule-name--acme → long-rule-name\s+targets \*\s+in stack-angular\s+— Long one$/);
    expect(rows[0]).toMatch(/^  ● a\s+targets \*\s+in base$/);
    expect(rows[0].indexOf("targets ")).toBe(rows[1].indexOf("targets "));
  });
});


describe("cli — targets reads the workspace once craftar.yaml is there (spec 16 §4.4, §5.2)", () => {
  it("an explicit --workspace whose craftar.yaml is not valid YAML is a warning, exit 0", async () => {
    const s = await scenario({ recipes: [recipe("base", [])], profiles: [profile("acme", ["base"])] }, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), "forge: [unclosed\n");
    const r = runCli(["targets", "--json", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const j = JSON.parse(r.stdout);
    expect(j.targets.map((t: { inUse: unknown }) => t.inUse)).toEqual([null, null, null, null, null, null]);
    expect(j.warnings).toHaveLength(1);
    expect(j.warnings[0].startsWith("targets in use not shown: ")).toBe(true);
  });
});


describe("cli — the targets text has no trailing spaces and the catalogue drops marks without a context", () => {
  it("every line of targets, and of recipes --forge, has no trailing space; recipes --forge rows start with two spaces and the name", async () => {
    const s = await scenario({ recipes: [recipe("base", [])], profiles: [profile("acme", ["base"])] }, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    const t = runCli(["targets"], { cwd: s.wsRoot });
    expect(t.stdout.split("\n").filter((l) => l !== l.trimEnd())).toEqual([]);
    expect(t.stdout.split("\n").find((l) => l.trim().startsWith("steering"))!.startsWith("  steering")).toBe(true);
    const r = runCli(["recipes", "--forge", s.forgeRoot]);
    expect(r.stdout.split("\n").filter((l) => l !== l.trimEnd())).toEqual([]);
    expect(r.stdout.split("\n")[1]).toMatch(/^  base\s+0 ingredients$/);
  });
});


describe("cli — diff, pinned before spec 19", () => {
  // rule/a ("A one\nA two\n") and rule/b ("B one\nB two\n"),
  // recipe base listing both, profile acme using base, target claude-code.
  async function pinnedScenario() {
    const s = await scenario(
      {
        ingredients: [rule("a", "A one\nA two\n"), rule("b", "B one\nB two\n")],
        recipes: [recipe("base", ["rule/a", "rule/b"])],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    return s;
  }

  it("drift only, exit 0", async () => {
    const s = await pinnedScenario();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // Drift on b: append "hand\n"
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/b.md"), "hand\n");

    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "--- .claude/rules/b.md (disk, drift)\n" +
      "+++ .claude/rules/b.md (forge)\n" +
      "  B one\n" +
      "  B two\n" +
      "- hand\n",
    );
  });

  it("drift + update, byte for byte (spec test 9)", async () => {
    const s = await pinnedScenario();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // Update on a: rewrite the Forge ingredient
    await fs.writeFile(path.join(s.forgeRoot, "ingredients/rules/a/rule.md"), "A one\nA changed\n");
    // Drift on b: append "hand\n"
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/b.md"), "hand\n");

    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "--- .claude/rules/a.md (disk, update)\n" +
      "+++ .claude/rules/a.md (forge)\n" +
      "  A one\n" +
      "- A two\n" +
      "+ A changed\n" +
      "--- .claude/rules/b.md (disk, drift)\n" +
      "+++ .claude/rules/b.md (forge)\n" +
      "  B one\n" +
      "  B two\n" +
      "- hand\n",
    );
  });

  it("in sync", async () => {
    const s = await pinnedScenario();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);

    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("no differences\n");
  });

  it("a [path] nothing matches, without the flag", async () => {
    const s = await pinnedScenario();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // Drift on b so the workspace is not in sync — but the paths below should still show no differences
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/b.md"), "hand\n");

    for (const p of [".claude/rules/nope.md", "./.claude/rules/a.md", ".claude\\rules\\a.md"]) {
      const r = runCli(["diff", p, "--workspace", s.wsRoot]);
      expect(r.code, `path: ${p}`).toBe(0);
      expect(r.stdout, `path: ${p}`).toBe("no differences\n");
      expect(r.stderr, `path: ${p}`).toBe("");
    }
  });

  it("a [path] naming an unchanged file while another drifted", async () => {
    const s = await pinnedScenario();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // Drift on b
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/b.md"), "hand\n");

    const r = runCli(["diff", ".claude/rules/a.md", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("no differences\n");
  });
});


/**
 * A scenario for the `diff` tests of spec 19: the given ingredients in one `base` recipe, profile `acme`,
 * cleaned up after the test. Defaults to rule/a ("A one\nA two\n") and rule/b ("B one\nB two\n").
 */
async function diffScenario(
  ingredients = [rule("a", "A one\nA two\n"), rule("b", "B one\nB two\n")],
  recipeIngredients = ["rule/a", "rule/b"],
  local?: Record<string, unknown>,
) {
  const s = await scenario(
    { ingredients, recipes: [recipe("base", recipeIngredients)], profiles: [profile("acme", ["base"])] },
    { config: { profile: "acme" }, local },
  );
  cleanups.push(s.cleanup);
  return s;
}

describe("cli — diff shows orphans (spec 19)", () => {
  it("orphan printed as a removal (spec tests 5, 7)", async () => {
    const s = await diffScenario();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // Orphan on a: rewrite the recipe to list only rule/b
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), "name: base\ningredients:\n  - rule/b\n");

    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "--- .claude/rules/a.md (disk, orphan)\n" +
      "+++ .claude/rules/a.md (forge: no longer produced — sync removes it)\n" +
      "- A one\n" +
      "- A two\n",
    );
    // Confirm the state really is pending
    expect(runCli(["sync", "--check", "--workspace", s.wsRoot]).code).toBe(1);
  });

  it("orphan with no final newline", async () => {
    // A separate scenario: rule/c has no trailing newline
    const s = await diffScenario(
      [rule("c", "C one\nC two"), rule("b", "B one\nB two\n")],
      ["rule/b", "rule/c"],
    );
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // Orphan on c: rewrite the recipe to list only rule/b
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), "name: base\ningredients:\n  - rule/b\n");

    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "--- .claude/rules/c.md (disk, orphan)\n" +
      "+++ .claude/rules/c.md (forge: no longer produced — sync removes it)\n" +
      "- C one\n" +
      "- C two\n" +
      "\\ No newline at end of file\n",
    );
  });

  it("orphan-drift: header and one line (spec test 6)", async () => {
    const s = await diffScenario();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // Orphan on a: rewrite the recipe to list only rule/b
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), "name: base\ningredients:\n  - rule/b\n");
    // Drift on a: append "hand\n"
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/a.md"), "hand\n");

    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "--- .claude/rules/a.md (disk, orphan-drift)\n" +
      "  no longer produced by the Forge but hand-edited — kept; `craftar drift discard <path>` removes it, or delete it yourself\n",
    );
  });

  it("order (spec test 11)", async () => {
    const s = await diffScenario();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // Orphan on a: rewrite the recipe to list only rule/b
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), "name: base\ningredients:\n  - rule/b\n");
    // Drift on b: append "hand\n"
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/b.md"), "hand\n");

    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "--- .claude/rules/a.md (disk, orphan)\n" +
      "+++ .claude/rules/a.md (forge: no longer produced — sync removes it)\n" +
      "- A one\n" +
      "- A two\n" +
      "--- .claude/rules/b.md (disk, drift)\n" +
      "+++ .claude/rules/b.md (forge)\n" +
      "  B one\n" +
      "  B two\n" +
      "- hand\n",
    );
  });

  it("[path] reaches an orphan (spec test 8, first case)", async () => {
    const s = await diffScenario();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // Orphan on a: rewrite the recipe to list only rule/b
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), "name: base\ningredients:\n  - rule/b\n");
    // Drift on b: append "hand\n"
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/b.md"), "hand\n");

    // diff .claude/rules/a.md should show only the orphan
    const r = runCli(["diff", ".claude/rules/a.md", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "--- .claude/rules/a.md (disk, orphan)\n" +
      "+++ .claude/rules/a.md (forge: no longer produced — sync removes it)\n" +
      "- A one\n" +
      "- A two\n",
    );
  });

  it("no targets resolved (spec test 12, no flag)", async () => {
    const s = await diffScenario();
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // No targets: write craftar.local.yaml with targets: []
    await fs.writeFile(path.join(s.wsRoot, "craftar.local.yaml"), "targets: []\n");

    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "--- .claude/rules/a.md (disk, orphan)\n" +
      "+++ .claude/rules/a.md (forge: no longer produced — sync removes it)\n" +
      "- A one\n" +
      "- A two\n" +
      "--- .claude/rules/b.md (disk, orphan)\n" +
      "+++ .claude/rules/b.md (forge: no longer produced — sync removes it)\n" +
      "- B one\n" +
      "- B two\n",
    );
  });

  it("empty orphan (spec test 13, no flag)", async () => {
    // A scenario with an empty rule/e
    const s = await diffScenario(
      [rule("e", ""), rule("b", "B one\nB two\n")],
      ["rule/b", "rule/e"],
    );
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    // Orphan on e: rewrite the recipe to list only rule/b
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), "name: base\ningredients:\n  - rule/b\n");

    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    // Two header lines and ONE empty line (renderDiff("", "") returns "", and console.log("") prints \n)
    expect(r.stdout).toBe(
      "--- .claude/rules/e.md (disk, orphan)\n" +
      "+++ .claude/rules/e.md (forge: no longer produced — sync removes it)\n" +
      "\n",
    );
  });
});

describe("cli — diff --exit-code (spec 19)", () => {
  const D = (ws: string, ...extra: string[]) => runCli(["diff", ...extra, "--workspace", ws]);
  const C = (ws: string) => runCli(["sync", "--check", "--workspace", ws]);
  const ONLY_B = "name: base\ningredients:\n  - rule/b\n";
  const unmatched = (p: string) =>
    `error: ${p} is not a file craftar manages in this workspace — pass the workspace-relative path as \`craftar status\` prints it (forward slashes)\n`;

  async function synced(...args: Parameters<typeof diffScenario>) {
    const s = await diffScenario(...args);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    return s;
  }

  it("in sync: exit 0 and no differences, as sync --check (spec test 2)", async () => {
    const s = await synced();
    const r = D(s.wsRoot, "--exit-code");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("no differences\n");
    expect(r.stderr).toBe("");
    expect(C(s.wsRoot).code).toBe(0);
  });

  /** Each state on a fresh default scenario: the flag prints what the plain command prints, and exits 1 as sync --check does. */
  const states: Array<[string, (s: Awaited<ReturnType<typeof diffScenario>>) => Promise<void>, boolean]> = [
    ["drift", (s) => fs.appendFile(path.join(s.wsRoot, ".claude/rules/b.md"), "hand\n"), true],
    ["update", (s) => fs.writeFile(path.join(s.forgeRoot, "ingredients/rules/a/rule.md"), "A one\nA changed\n"), true],
    ["new", (s) => fs.rm(path.join(s.wsRoot, ".claude/rules/a.md")), true],
    ["collision", (s) => writeFiles(s.wsRoot, { ".claude/rules/a.md": "mine\n" }), false],
    ["orphan", (s) => fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), ONLY_B), true],
    [
      "orphan-drift",
      async (s) => {
        await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), ONLY_B);
        await fs.appendFile(path.join(s.wsRoot, ".claude/rules/a.md"), "hand\n");
      },
      true,
    ],
  ];
  for (const [state, make, sync] of states) {
    it(`${state}: exit 1, the same output as without the flag, and sync --check exits 1 (spec test 3)`, async () => {
      const s = await diffScenario();
      if (sync) expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
      await make(s);
      const { statuses } = JSON.parse(runCli(["status", "--json", "--workspace", s.wsRoot]).stdout) as { statuses: Array<{ path: string; state: string }> };
      const target = state === "drift" ? ".claude/rules/b.md" : ".claude/rules/a.md";
      expect(statuses.find((f) => f.path === target)?.state).toBe(state);
      const flagged = D(s.wsRoot, "--exit-code");
      const plain = D(s.wsRoot);
      expect(flagged.code).toBe(1);
      expect(flagged.stderr).toBe("");
      expect(flagged.stdout).toBe(plain.stdout);
      expect(flagged.stdout).not.toBe("no differences\n");
      expect(plain.code).toBe(0);
      expect(C(s.wsRoot).code).toBe(1);
    });
  }

  it("only adopt files: exit 0, as sync --check (spec test 4)", async () => {
    const s = await synced();
    await fs.rm(path.join(s.wsRoot, "craftar.lock"));
    const r = D(s.wsRoot, "--exit-code");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("no differences\n");
    expect(C(s.wsRoot).code).toBe(0);
  });

  it("no targets resolved: exit 1, as sync --check (spec test 12)", async () => {
    const s = await synced();
    await writeFiles(s.wsRoot, { "craftar.local.yaml": "targets: []\n" });
    expect(D(s.wsRoot, "--exit-code").code).toBe(1);
    expect(C(s.wsRoot).code).toBe(1);
  });

  it("an empty orphan still counts: exit 1 (spec test 13)", async () => {
    const s = await synced([rule("e", ""), rule("b", "B one\nB two\n")], ["rule/b", "rule/e"]);
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), ONLY_B);
    const r = D(s.wsRoot, "--exit-code");
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("--- .claude/rules/e.md (disk, orphan)\n+++ .claude/rules/e.md (forge: no longer produced — sync removes it)\n\n");
  });

  it("[path] considers only the named file (spec test 8)", async () => {
    const s = await synced();
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), ONLY_B);
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/b.md"), "hand\n");
    const orphan = D(s.wsRoot, "--exit-code", ".claude/rules/a.md");
    expect(orphan.code).toBe(1);
    expect(orphan.stdout).toBe(
      "--- .claude/rules/a.md (disk, orphan)\n" +
        "+++ .claude/rules/a.md (forge: no longer produced — sync removes it)\n" +
        "- A one\n" +
        "- A two\n",
    );

    const t = await synced();
    await fs.appendFile(path.join(t.wsRoot, ".claude/rules/b.md"), "hand\n");
    const clean = D(t.wsRoot, "--exit-code", ".claude/rules/a.md");
    expect(clean.code).toBe(0);
    expect(clean.stdout).toBe("no differences\n");
    expect(clean.stderr).toBe("");
  });

  it("a [path] nothing matches is an error, with nothing on stdout (spec test 14)", async () => {
    const s = await synced();
    for (const p of [".claude/rules/nope.md", "./.claude/rules/a.md", ".claude\\rules\\a.md"]) {
      const r = D(s.wsRoot, "--exit-code", p);
      expect(r.code, p).toBe(1);
      expect(r.stdout, p).toBe("");
      expect(r.stderr, p).toBe(unmatched(p));
    }
  });

  it("an empty status(): no differences and exit 0; a [path] is the error", async () => {
    const s = await diffScenario(undefined, undefined, { targets: [] });
    const r = D(s.wsRoot, "--exit-code");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("no differences\n");
    expect(r.stderr).toBe("");
    expect(C(s.wsRoot).code).toBe(0);
    const named = D(s.wsRoot, "--exit-code", ".claude/rules/a.md");
    expect(named.code).toBe(1);
    expect(named.stdout).toBe("");
    expect(named.stderr).toBe(unmatched(".claude/rules/a.md"));
  });

  it("writes nothing in the workspace or the Forge (spec test 10)", async () => {
    const s = await synced();
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), ONLY_B);
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/a.md"), "hand\n");
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/b.md"), "hand\n");
    const ws = await snapshot(s.wsRoot);
    const forge = await snapshot(s.forgeRoot);
    expect(D(s.wsRoot, "--exit-code").code).toBe(1);
    expect(D(s.wsRoot).code).toBe(0);
    expect(D(s.wsRoot, "--exit-code", "nope.md").code).toBe(1);
    expect(await snapshot(s.wsRoot)).toEqual(ws);
    expect(await snapshot(s.forgeRoot)).toEqual(forge);
  });

  it("a diff larger than the pipe buffer arrives whole to a slow reader (spec test 15)", async () => {
    const lines = Array.from({ length: 20000 }, (_, i) => `line ${i} ${"x".repeat(40)}\n`).join("");
    const s = await synced([rule("big", lines), rule("b", "B one\nB two\n")], ["rule/b", "rule/big"]);
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), ONLY_B);
    const repo = path.resolve(__dirname, "..");
    // spawnSync drains the pipe at once (and caps it at 1 MiB): a paused reader is what exposes a process.exit.
    // Under process.exit nothing reaches this reader at all — node drops the unread pipe when the child exits.
    const { code, stdout } = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", TSX_LOADER, path.join(repo, "src/cli.ts"), "diff", "--exit-code", "--workspace", s.wsRoot], {
        cwd: repo,
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.pause();
      setTimeout(() => {
        child.stdout.on("data", (d: string) => (out += d));
        child.stdout.resume();
      }, 1000);
      child.on("error", reject);
      child.on("close", (c) => resolve({ code: c, stdout: out }));
    });
    expect(code).toBe(1);
    const got = stdout.split("\n");
    expect(got.length).toBe(20003);
    expect(got[0]).toBe("--- .claude/rules/big.md (disk, orphan)");
    expect(got[20001]).toBe("- line 19999 " + "x".repeat(40));
    expect(got[20002]).toBe("");
  }, atLeastWin32(30_000));
});

describe("cli — forge values: credentials refused, path-Forge warnings (spec 13 §4.2, §4.3)", () => {
  const ONE = { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] };

  it("a credential in either workspace file is refused, naming the file and never the value", async () => {
    for (const [file, other] of [["craftar.yaml", "craftar.local.yaml"], ["craftar.local.yaml", "craftar.yaml"]] as const) {
      const s = await scenario(ONE, { config: { profile: "acme" } });
      cleanups.push(s.cleanup);
      const secret = "https://alice:s3cr3t@example.com/acme/forge.git";
      if (file === "craftar.yaml") await fs.writeFile(path.join(s.wsRoot, file), `forge: ${secret}\nprofile: acme\n`);
      else await fs.writeFile(path.join(s.wsRoot, file), `forge: ${secret}\n`);
      const r = runCli(["status", "--workspace", s.wsRoot]);
      expect(r.code, file).toBe(1);
      expect(r.stderr, file).toBe(
        `error: ${file} › forge holds credentials in the URL — remove them and let git authenticate (credential helper, SSH agent; see README › Remote Forge)\n`,
      );
      expect(r.stderr + r.stdout, file).not.toContain("s3cr3t");
      expect(r.stderr + r.stdout, file).not.toContain("alice");
    }
  });

  it("a ref next to a path Forge is ignored with a warning; forge: from craftar.local.yaml warns not to commit", async () => {
    const s = await scenario(ONE, { config: { profile: "acme", ref: "v1" } });
    cleanups.push(s.cleanup);
    const j = JSON.parse(runCli(["status", "--json", "--workspace", s.wsRoot]).stdout);
    expect(j.warnings).toContain('ref "v1" is ignored: the Forge is a path (../forge), read as its working tree');
    await fs.writeFile(path.join(s.wsRoot, "craftar.local.yaml"), "forge: ../forge\n");
    const k = JSON.parse(runCli(["status", "--json", "--workspace", s.wsRoot]).stdout);
    expect(k.warnings.slice(0, 2)).toEqual([
      'ref "v1" is ignored: the Forge is a path (../forge), read as its working tree',
      "Forge overridden by craftar.local.yaml (../forge) — do not commit craftar.lock or the generated files",
    ]);
  });
});
