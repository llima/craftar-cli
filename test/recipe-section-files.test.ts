import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadForge } from "../src/core/forge.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { FORGE_SCHEMA_RECIPE_SECTIONS, FORGE_SCHEMA_SECTION_FILES } from "../src/schema/index.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles } from "./helpers/forge.js";
import { git } from "./helpers/remote.js";

/** Spec 54 §4.4 with spec 55 §5.3: a recipe's section value held in a file, relative to the recipe file's folder. */

const GATE = FORGE_SCHEMA_SECTION_FILES;
const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

const BODY = "# Review\n<!-- craftar:section checklist -->\ndefault\n<!-- /craftar:section -->\n";
const held = { "rule/review": { checklist: { file: "sections/rule/review/checklist.md" } } };

async function forgeAt(schema: number, opts: { rootSections?: unknown; localSections?: unknown; files?: Record<string, string> } = {}) {
  const root = await tmpDir("craftar-recipe-section-files-");
  roots.push(root);
  const forge = path.join(root, "forge");
  await makeForge(forge, {
    ingredients: [rule("review", BODY), rule("style", "# Style\n")],
    recipes: [recipe("core", ["rule/review"], opts.rootSections ? { sections: opts.rootSections } : {})],
    profiles: [profile("acme", opts.localSections ? ["core", "acme-extra"] : ["core"]), profile("globex", ["core"])],
  });
  await writeFiles(forge, {
    "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema }),
    ...(opts.localSections ? { "profiles/acme/recipes/acme-extra.yaml": YAML.stringify({ name: "acme-extra", ingredients: ["rule/style"], sections: opts.localSections }) } : {}),
    ...(opts.files ?? {}),
  });
  const ws = path.join(root, "ws");
  await makeWorkspace(ws, forge, { config: { profile: "acme" } });
  return { root, forge, ws };
}

async function loadError(forge: string): Promise<string> {
  try {
    await loadForge(forge);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected the load to fail");
}

const rendered = async (ws: string) => (await plan(await loadWorkspace(ws))).files.find((f) => f.path === ".claude/rules/review.md")!.content.toString("utf8");

describe("a recipe's section value held in a file (spec 54 §4.4)", () => {
  it("a root recipe's value is the file under recipes/sections/, a leading BOM dropped", async () => {
    const s = await forgeAt(GATE, { rootSections: held, files: { "recipes/sections/rule/review/checklist.md": "﻿- from the recipe file\n" } });
    expect(await rendered(s.ws)).toContain("- from the recipe file\n");
    expect(await rendered(s.ws)).not.toContain("﻿");
    const f = await loadForge(s.forge);
    expect(f.recipes.get("core")!.sections).toEqual({ "rule/review": { checklist: "- from the recipe file\n" } });
    expect(f.sectionFiles.get("recipes/core.yaml")!.get("rule/review")!.get("checklist")).toBe("sections/rule/review/checklist.md");
  });

  it("renders the bytes the same string renders", async () => {
    const asFile = await forgeAt(GATE, { rootSections: held, files: { "recipes/sections/rule/review/checklist.md": "- a\r\n- b" } });
    const asString = await forgeAt(GATE, { rootSections: { "rule/review": { checklist: "- a\r\n- b" } } });
    expect(await rendered(asFile.ws)).toBe(await rendered(asString.ws));
  });

  it("a profile-local recipe's value resolves against profiles/<p>/recipes/", async () => {
    const s = await forgeAt(GATE, {
      localSections: held,
      files: { "profiles/acme/recipes/sections/rule/review/checklist.md": "- local\n", "recipes/sections/rule/review/checklist.md": "- root\n" },
    });
    expect(await rendered(s.ws)).toContain("- local\n");
  });

  it("at the recipe-sections gate but below the section-files gate, a { file: } value is a near miss naming the schema", async () => {
    const s = await forgeAt(FORGE_SCHEMA_RECIPE_SECTIONS, { rootSections: held, files: { "recipes/sections/rule/review/checklist.md": "SECRET-CONTENT\n" } });
    const msg = await loadError(s.forge);
    expect(msg).toContain(`recipes/core.yaml: sections.rule/review.checklist: a section value held in a file needs schema: ${GATE} in craftar.forge.yaml`);
    expect(msg).not.toContain("SECRET-CONTENT");
  });

  it("refuses a missing file, naming the recipe file and the key", async () => {
    const s = await forgeAt(GATE, { rootSections: held });
    const msg = await loadError(s.forge);
    expect(msg).toContain("recipes/core.yaml: sections.rule/review.checklist: recipes/sections/rule/review/checklist.md not found");
  });

  it("refuses a link out of the recipe's folder (a junction on Windows), naming no target", async () => {
    const s = await forgeAt(GATE, { rootSections: held, files: { "elsewhere/checklist.md": "SECRET-CONTENT\n" } });
    await fs.mkdir(path.join(s.forge, "recipes/sections/rule"), { recursive: true });
    await fs.symlink(path.join(s.forge, "elsewhere"), path.join(s.forge, "recipes/sections/rule/review"), "junction");
    const msg = await loadError(s.forge);
    expect(msg).toContain("recipes/core.yaml: sections.rule/review.checklist: recipes/sections/rule/review/checklist.md: a symbolic link out of");
    expect(msg).not.toContain("elsewhere");
    expect(msg).not.toContain("SECRET-CONTENT");
  });

  it("refuses a Windows-shaped path", async () => {
    const s = await forgeAt(GATE, { rootSections: { "rule/review": { checklist: { file: "sections/con.md" } } } });
    expect(await loadError(s.forge)).toContain("Windows cannot hold");
  });

  it("explain names the file inside the recipe layer's parenthesis", async () => {
    const s = await forgeAt(GATE, { rootSections: held, files: { "recipes/sections/rule/review/checklist.md": "- x\n" } });
    const r = runCli(["explain", ".claude/rules/review.md", "--workspace", s.ws]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("  sections    checklist (recipe core, sections/rule/review/checklist.md)\n");
  });

  it("forge promote edits a recipe holding { file: } in place and reads it back as written", async () => {
    const root = await tmpDir("craftar-recipe-section-files-promote-");
    roots.push(root);
    const forge = path.join(root, "forge");
    const style = "style\n<!-- craftar:section s -->\nd\n<!-- /craftar:section -->\n";
    await makeForge(forge, {
      ingredients: [rule("workflow", "base text\n"), rule("workflow--acme", "acme text\n", { as: "workflow" }), rule("style", style)],
      recipes: [
        recipe("base", ["rule/workflow", "rule/style"], { sections: { "rule/style": { s: { file: "sections/s.md" } } } }),
        recipe("base--acme", ["rule/workflow--acme", "rule/style"]),
      ],
      profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"])],
    });
    await writeFiles(forge, { "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: GATE }), "recipes/sections/s.md": "held\n" });
    git(forge, "init", "-q", "-b", "main");
    git(forge, "add", "-A");
    git(forge, "commit", "-q", "-m", "forge");
    const r = runCli(["forge", "promote", "rule/workflow", "--profile", "acme", "--forge", forge, "--no-impact"], { env: { CRAFTAR_HOME: path.join(root, "home") } });
    expect(r.code, r.stderr).toBe(0);
    // promote copies the base's recipe for globex: the copy carries the { file: }, beside the original, in the same folder.
    expect(await fs.readFile(path.join(forge, "recipes/base--globex.yaml"), "utf8")).toContain("file: sections/s.md");
    const f = await loadForge(forge);
    expect(f.recipes.get("base--globex")!.sections).toEqual({ "rule/style": { s: "held\n" } });
  });

  it("forge localize refuses to move a recipe holding { file: }, with the Forge untouched", async () => {
    const root = await tmpDir("craftar-recipe-section-files-localize-");
    roots.push(root);
    const forge = path.join(root, "forge");
    await makeForge(forge, {
      ingredients: [rule("style", "# Style\n"), rule("x", "<!-- craftar:section s -->\nd\n<!-- /craftar:section -->\n")],
      recipes: [recipe("base", ["rule/style"]), recipe("stack-x", ["rule/x"], { sections: { "rule/x": { s: { file: "sections/s.md" } } } })],
      profiles: [profile("acme", ["base", "stack-x"]), profile("globex", ["base"])],
    });
    await writeFiles(forge, { "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: GATE }), "recipes/sections/s.md": "held\n" });
    git(forge, "init", "-q", "-b", "main");
    git(forge, "add", "-A");
    git(forge, "commit", "-q", "-m", "forge");
    const ws = path.join(root, "ws");
    await makeWorkspace(ws, forge, { config: { profile: "acme" } });
    expect(runCli(["sync", "--workspace", ws]).code).toBe(0);
    const r = runCli(["forge", "localize", "rule/x", "--profile", "acme", "--forge", forge]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("stack-x");
    expect(r.stderr).toContain("sections/s.md");
    expect(git(forge, "status", "--porcelain")).toBe("");
  });

  it("import's split of a shared recipe carries a file-held value as its { file: }, never as text", async () => {
    const { acmeRecipeSections } = await import("./helpers/recipe-sections.js");
    const { importClaudeCode } = await import("../src/importers/claude-code.js");
    const { apply, readLock, status } = await import("../src/core/sync.js");
    const KIRO = "Run it through Kiro.\n";
    const s = await acmeRecipeSections({
      schema: GATE,
      baseSections: { "command/open-pr": { execution: { file: "sections/command/open-pr/execution.md" } } } as never,
      importShaped: true,
    });
    roots.push(s.root);
    await writeFiles(s.forgeRoot, { "recipes/sections/command/open-pr/execution.md": KIRO });
    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);
    await apply(ws, p, await status(ws, p, await readLock(ws.root)), {});
    await fs.writeFile(path.join(s.wsRoot, ".claude/commands/extra.md"), "---\ndescription: Extra\n---\nDo the extra thing.\n");
    const r = await importClaudeCode({ workspaceRoot: s.wsRoot, forgeRoot: s.forgeRoot, profileName: "acme-portal" });
    expect(r.recipeSplits.map((x) => x.owned)).toEqual(["base--acme-portal"]);
    const owned = YAML.parse(await fs.readFile(path.join(s.forgeRoot, "recipes/base--acme-portal.yaml"), "utf8"));
    expect(owned.sections).toEqual({ "command/open-pr": { execution: { file: "sections/command/open-pr/execution.md" } } });
    expect((await plan(await loadWorkspace(s.wsRoot))).files.find((f) => f.path === ".claude/commands/open-pr.md")!.content.toString("utf8")).toContain(KIRO);
  });

  it("below the recipe-sections gate, a recipe's { file: } value is that gate's near miss, not the section-files one", async () => {
    const root = await forgeAt(FORGE_SCHEMA_RECIPE_SECTIONS - 1, { rootSections: held, files: { "recipes/sections/rule/review/checklist.md": "x\n" } });
    const msg = await loadError(root.forge);
    expect(msg).toContain(`recipes/core.yaml: sections in a recipe needs schema: ${FORGE_SCHEMA_RECIPE_SECTIONS} in craftar.forge.yaml`);
    expect(msg).not.toContain(`schema: ${GATE}`);
  });

  it("a profile-local recipe's { file: } at the recipe-sections gate names the section-files schema and the local file", async () => {
    const s = await forgeAt(FORGE_SCHEMA_RECIPE_SECTIONS, { localSections: held, files: { "profiles/acme/recipes/sections/rule/review/checklist.md": "x\n" } });
    const msg = await loadError(s.forge);
    expect(msg).toContain(`profiles/acme/recipes/acme-extra.yaml: sections.rule/review.checklist: a section value held in a file needs schema: ${GATE}`);
  });

  it("import's split of a shared recipe for a profile that holds a variant carries a file-held value as its { file: }", async () => {
    const { acmeRecipeSections } = await import("./helpers/recipe-sections.js");
    const { importClaudeCode } = await import("../src/importers/claude-code.js");
    const { apply, readLock, status } = await import("../src/core/sync.js");
    const KIRO = "Run it through Kiro.\n";
    const s = await acmeRecipeSections({
      schema: GATE,
      baseSections: { "command/open-pr": { execution: { file: "sections/command/open-pr/execution.md" } } } as never,
      importShaped: true,
    });
    roots.push(s.root);
    await writeFiles(s.forgeRoot, { "recipes/sections/command/open-pr/execution.md": KIRO });
    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);
    await apply(ws, p, await status(ws, p, await readLock(ws.root)), {});
    const cmd = path.join(s.wsRoot, ".claude/commands/open-pr.md");
    const text = await fs.readFile(cmd, "utf8");
    expect(text).toContain("Then:\n");
    await fs.writeFile(cmd, text.replace("Then:\n", "Then, for acme only:\n"));
    const r = await importClaudeCode({ workspaceRoot: s.wsRoot, forgeRoot: s.forgeRoot, profileName: "acme-portal" });
    expect(r.variants.map((v) => v.name)).toContain("command/open-pr--acme-portal");
    // The variant path writes the owned recipe without reporting a split.
    expect(r.recipes).toEqual(["base--acme-portal"]);
    const owned = YAML.parse(await fs.readFile(path.join(s.forgeRoot, "recipes/base--acme-portal.yaml"), "utf8"));
    expect(owned.sections).toEqual({ "command/open-pr": { execution: { file: "sections/command/open-pr/execution.md" } } });
  });

  it("import --local=always reads a root recipe holding { file: } as written when it wires a new local", async () => {
    const { importClaudeCode } = await import("../src/importers/claude-code.js");
    const { apply, readLock, status } = await import("../src/core/sync.js");
    const s = await forgeAt(GATE, { rootSections: held, files: { "recipes/sections/rule/review/checklist.md": "From the file.\n" } });
    const ws = await loadWorkspace(s.ws);
    const p = await plan(ws);
    await apply(ws, p, await status(ws, p, await readLock(ws.root)), {});
    await fs.mkdir(path.join(s.ws, ".claude/commands"), { recursive: true });
    await fs.writeFile(path.join(s.ws, ".claude/commands/extra.md"), "---\ndescription: Extra\n---\nDo the extra thing.\n");
    const r = await importClaudeCode({ workspaceRoot: s.ws, forgeRoot: s.forge, profileName: "acme", local: "always" });
    expect(r.rejected).toEqual([]);
    expect(YAML.parse(await fs.readFile(path.join(s.forge, "recipes/core.yaml"), "utf8")).sections).toEqual(held);
    expect(await rendered(s.ws)).toContain("From the file.");
    expect(await fs.readFile(path.join(s.forge, "profiles/acme/recipes/acme-local.yaml"), "utf8")).toContain("command/extra");
  });

  it("forge localize of an override rewires a root recipe holding { file: } in place, compared as written", async () => {
    const { build } = await import("./helpers/local-override.js");
    const Y = "# Y for acme\n<!-- craftar:section s -->\ndefault\n<!-- /craftar:section -->\n";
    const yHeld = { "rule/y": { s: { file: "sections/rule/y/s.md" } } };
    const spec = {
      ingredients: [rule("style", "# Style\n"), rule("y", "# Y shared\n"), rule("y--acme", Y, { as: "y" })],
      recipes: [recipe("base", ["rule/style", "rule/y"]), recipe("base--acme", ["rule/style", "rule/y--acme"], { sections: yHeld })],
      profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"])],
    };
    const s = await build(roots, spec, {
      extra: { "recipes/sections/rule/y/s.md": "From the file.\n" },
      workspaces: [{ name: "wa", config: { profile: "acme" } }, { name: "wg", config: { profile: "globex" } }],
    });
    const r = runCli(["forge", "localize", "rule/y--acme", "--profile", "acme", "--forge", s.forge]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const base = YAML.parse(await fs.readFile(path.join(s.forge, "recipes/base--acme.yaml"), "utf8"));
    expect(base.ingredients).toEqual(["rule/style", "rule/y"]);
    expect(base.sections).toEqual(yHeld);
    expect((await plan(await loadWorkspace(s.ws.wa))).files.find((f) => f.path === ".claude/rules/y.md")!.content.toString("utf8")).toContain("From the file.");
  });

  it("explain names the file of a parent's local recipe a child reaches (spec 54 Part B)", async () => {
    const { FORGE_SCHEMA_PROFILE_EXTENDS } = await import("../src/schema/index.js");
    const root = await tmpDir("craftar-recipe-section-files-");
    roots.push(root);
    const forge = path.join(root, "forge");
    await makeForge(forge, {
      ingredients: [rule("review", BODY), rule("style", "# Style\n")],
      recipes: [recipe("core", ["rule/style"])],
      profiles: [profile("acme-base", ["core", "kit"], ["claude-code"], { abstract: true }), profile("acme-web", [], ["claude-code"], { extends: "acme-base" })],
    });
    await writeFiles(forge, {
      "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: FORGE_SCHEMA_PROFILE_EXTENDS }),
      "profiles/acme-base/recipes/kit.yaml": YAML.stringify({ name: "kit", ingredients: ["rule/review"], sections: held }),
      "profiles/acme-base/recipes/sections/rule/review/checklist.md": "- from the parent\n",
    });
    const ws = path.join(root, "ws");
    await makeWorkspace(ws, forge, { config: { profile: "acme-web" } });
    expect(await rendered(ws)).toContain("- from the parent\n");
    const r = runCli(["explain", ".claude/rules/review.md", "--workspace", ws]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("  sections    checklist (recipe kit, sections/rule/review/checklist.md)\n");
  });
});
