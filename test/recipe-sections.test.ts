/**
 * Spec 54 Part A — sections at the recipe layer (§4). Every case here failed before the change (recorded in the build
 * report): the gate did not exist, so a schema 10 Forge did not load, and a recipe's `sections` was dropped.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { execFileSync } from "node:child_process";
import { runCli } from "./helpers/cli.js";
import { acmeRecipeSections, DEFAULT_CHECKLIST, DEFAULT_EXECUTION } from "./helpers/recipe-sections.js";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { loadForge } from "../src/core/forge.js";
import { explainFile } from "../src/core/report.js";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { applyPromote, planPromote } from "../src/importers/drift-promote.js";

type Scenario = Awaited<ReturnType<typeof acmeRecipeSections>>;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = (s: Scenario): Scenario => (cleanups.push(s.cleanup), s);

const OPEN_PR = ".claude/commands/open-pr.md";
const KIRO = "Run it through Kiro.\n";
const ON = (execution: string) => ({ "command/open-pr": { execution } });

async function planned(s: Scenario) {
  const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
  const p = await plan(ws);
  return { ws, p, text: p.files.find((f) => f.path === OPEN_PR)!.content.toString("utf8") };
}

async function sync(wsRoot: string): Promise<void> {
  const ws = await loadWorkspace(wsRoot, { home: process.env.CRAFTAR_HOME });
  const p = await plan(ws);
  await apply(ws, p, await status(ws, p, await readLock(ws.root)), {});
}

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "craftar-test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "craftar-test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
});
function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "maintenance.auto", "false"]);
  execFileSync("git", ["-C", dir, "config", "gc.auto", "0"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"], { env: gitEnv() });
}

const yamlOf = async (file: string) => YAML.parse(await fs.readFile(file, "utf8"));

describe("spec 54 Part A — a recipe layer of sections", () => {
  it("a recipe section reaches only the profiles that resolve the recipe", async () => {
    const portal = kept(await acmeRecipeSections({ schema: 10, kiroSections: ON(KIRO) }));
    expect((await planned(portal)).text).toContain(KIRO);
    const globex = kept(await acmeRecipeSections({ schema: 10, kiroSections: ON(KIRO), workspaceProfile: "globex" }));
    const g = (await planned(globex)).text;
    expect(g).toContain(DEFAULT_EXECUTION);
    expect(g).not.toContain(KIRO);
  });

  it("the later recipe beats the earlier; the profile beats the recipes; craftar.yaml beats the profile", async () => {
    // base comes first in application order, executor-kiro (selected by integrations) after it.
    const later = kept(await acmeRecipeSections({ schema: 10, baseSections: ON("A\n"), kiroSections: ON("B\n") }));
    expect((await planned(later)).text).toContain("\nB\n");
    const prof = kept(await acmeRecipeSections({ schema: 10, baseSections: ON("A\n"), kiroSections: ON("B\n"), portalSections: ON("C\n") }));
    expect((await planned(prof)).text).toContain("\nC\n");
    const ws = kept(
      await acmeRecipeSections({ schema: 10, baseSections: ON("A\n"), kiroSections: ON("B\n"), portalSections: ON("C\n"), overrides: ON("D\n") }),
    );
    expect((await planned(ws)).text).toContain("\nD\n");
  });

  it("a recipe sets one section of a key and the profile another: both apply", async () => {
    const s = kept(
      await acmeRecipeSections({ schema: 10, kiroSections: ON(KIRO), portalSections: { "command/open-pr": { checklist: "- [ ] lint\n" } } }),
    );
    const t = (await planned(s)).text;
    expect(t).toContain(KIRO);
    expect(t).toContain("- [ ] lint\n");
    expect(t).not.toContain(DEFAULT_CHECKLIST);
  });

  it("below the gate a recipe holding sections fails the load, naming the file and schema 10", async () => {
    const s = kept(await acmeRecipeSections({ schema: 9, kiroSections: ON(KIRO) }));
    await expect(loadForge(s.forgeRoot)).rejects.toThrow(
      "recipes/executor-kiro.yaml: sections in a recipe needs schema: 10 in craftar.forge.yaml",
    );
  });

  it("explain names the recipe; the explain tool's builder answers { recipe }", async () => {
    const s = kept(await acmeRecipeSections({ schema: 10, kiroSections: ON(KIRO) }));
    const out = runCli(["explain", OPEN_PR, "--workspace", s.wsRoot]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("execution (recipe executor-kiro), checklist (default)");
    const { ws, p } = await planned(s);
    expect(explainFile(ws, p, OPEN_PR)!.sections).toEqual([
      { name: "execution", layer: { recipe: "executor-kiro" } },
      { name: "checklist", layer: "default" },
    ]);
  });

  it("at the gate a profile value answers { profile } and the text is unchanged", async () => {
    const s = kept(await acmeRecipeSections({ schema: 10, portalSections: ON("C\n") }));
    const { ws, p } = await planned(s);
    expect(explainFile(ws, p, OPEN_PR)!.sections[0]).toEqual({ name: "execution", layer: { profile: "acme-portal" } });
    expect(runCli(["explain", OPEN_PR, "--workspace", s.wsRoot]).stdout).toContain("execution (profile acme-portal)");
  });

  it("a recipe section key naming no ingredient warns, naming the recipe", async () => {
    const s = kept(await acmeRecipeSections({ schema: 10, kiroSections: { ...ON(KIRO), "command/nope": { x: "y\n" } } }));
    expect((await planned(s)).p.warnings).toContain("section key command/nope in recipe executor-kiro names no ingredient in the Forge");
  });

  it("a re-import of a workspace holding the recipe's value reuses the base and writes no profile section", async () => {
    const s = kept(await acmeRecipeSections({ schema: 10, kiroSections: ON(KIRO) }));
    await sync(s.wsRoot);
    const before = await fs.readFile(path.join(s.forgeRoot, "profiles/acme-portal/profile.yaml"), "utf8");
    const r = await importClaudeCode({ workspaceRoot: s.wsRoot, forgeRoot: s.forgeRoot, profileName: "acme-portal" });
    expect(r.variants).toEqual([]);
    expect(r.sections).toEqual([]);
    expect(await fs.readFile(path.join(s.forgeRoot, "profiles/acme-portal/profile.yaml"), "utf8")).toBe(before);
  });

  it("drift promote writes a different value into the profile, never into the recipe", async () => {
    const s = kept(await acmeRecipeSections({ schema: 10, kiroSections: ON(KIRO) }));
    gitInit(s.forgeRoot);
    await sync(s.wsRoot);
    const file = path.join(s.wsRoot, OPEN_PR);
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(KIRO, "Run it by hand.\n"));
    const recipeBefore = await fs.readFile(path.join(s.forgeRoot, "recipes/executor-kiro.yaml"), "utf8");
    const result = await planPromote({
      workspaceRoot: s.wsRoot,
      forgeDir: null,
      path: OPEN_PR,
      home: path.join(s.root, ".craftar"),
      env: { ...process.env, CRAFTAR_NO_REGISTRY: "1" },
    });
    expect(result.outcome).toBe("sections");
    await applyPromote(result, []);
    expect((await yamlOf(path.join(s.forgeRoot, "profiles/acme-portal/profile.yaml"))).sections).toEqual(ON("Run it by hand.\n"));
    expect(await fs.readFile(path.join(s.forgeRoot, "recipes/executor-kiro.yaml"), "utf8")).toBe(recipeBefore);
  });
});
