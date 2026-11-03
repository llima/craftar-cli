import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { applyPromote, planPromote } from "../src/importers/drift-promote.js";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { FORGE_SCHEMA_SECTION_FILES } from "../src/schema/index.js";
import { acmeSections, type Scenario } from "./helpers/section-files.js";
import { git } from "./helpers/remote.js";

/** Spec 55 §5.5, test 23: a writer overwrites a file-held section value in its file and leaves profile.yaml's bytes. */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const SECTION_FILE = "profiles/acme/sections/rule/review/checklist.md";
const PROFILE = "profiles/acme/profile.yaml";

async function setup(opts: { ruleDescription?: null } = {}): Promise<Scenario> {
  const s = await acmeSections({
    schema: FORGE_SCHEMA_SECTION_FILES,
    ...opts,
    sections: { "rule/review": { checklist: { file: "sections/rule/review/checklist.md" }, tone: "Short paragraphs.\n" } },
    files: { [SECTION_FILE]: "- one\n- two\n" },
  });
  cleanups.push(s.cleanup);
  git(s.forgeRoot, "init", "-q", "-b", "main");
  git(s.forgeRoot, "config", "gc.auto", "0");
  git(s.forgeRoot, "add", "-A");
  git(s.forgeRoot, "commit", "-q", "-m", "forge");
  const ws = await loadWorkspace(s.wsRoot);
  const p = await plan(ws);
  await apply(ws, p, await status(ws, p, await readLock(ws.root)), {});
  return s;
}

async function handEdit(s: Scenario, from: string, to: string): Promise<void> {
  const file = path.join(s.wsRoot, ".claude/rules/review.md");
  const text = await fs.readFile(file, "utf8");
  expect(text).toContain(from);
  await fs.writeFile(file, text.replace(from, to));
}

const promote = (s: Scenario) =>
  planPromote({ workspaceRoot: s.wsRoot, forgeDir: null, path: ".claude/rules/review.md", home: path.join(s.root, ".craftar"), env: { ...process.env, CRAFTAR_NO_REGISTRY: "1" } });

const porcelain = (s: Scenario) =>
  [...git(s.forgeRoot, "diff", "--name-only", "HEAD").split("\n"), ...git(s.forgeRoot, "ls-files", "--others", "--exclude-standard").split("\n")].filter(Boolean).sort();

describe("the writers and a file-held section value (spec 55 §5.5)", () => {
  it("drift promote writes the new value to the section file, LF with no BOM, and leaves profile.yaml's bytes", async () => {
    const s = await setup();
    const before = await fs.readFile(path.join(s.forgeRoot, PROFILE));
    await handEdit(s, "- one\n- two\n", "- uno\n- dos\n");
    const r = await promote(s);
    expect(r.outcome).toBe("sections");
    const real = await fs.realpath(s.forgeRoot);
    const held = await Promise.all(r.mustHold.map(async (p) => path.relative(real, await fs.realpath(p)).split(path.sep).join("/")));
    expect(held.sort()).toEqual([PROFILE, SECTION_FILE].sort());
    await applyPromote(r);
    expect(await fs.readFile(path.join(s.forgeRoot, SECTION_FILE), "utf8")).toBe("- uno\n- dos\n");
    expect((await fs.readFile(path.join(s.forgeRoot, PROFILE))).equals(before)).toBe(true);
    expect(porcelain(s)).toEqual([SECTION_FILE]);
  });

  it("drift promote of a string value edits profile.yaml and leaves the section file", async () => {
    const s = await setup();
    const fileBefore = await fs.readFile(path.join(s.forgeRoot, SECTION_FILE));
    await handEdit(s, "Short paragraphs.\n", "Long paragraphs.\n");
    const r = await promote(s);
    expect(r.outcome).toBe("sections");
    await applyPromote(r);
    expect(porcelain(s)).toEqual([PROFILE]);
    expect((await fs.readFile(path.join(s.forgeRoot, SECTION_FILE))).equals(fileBefore)).toBe(true);
    expect(await fs.readFile(path.join(s.forgeRoot, PROFILE), "utf8")).toContain("checklist:\n      file: sections/rule/review/checklist.md");
  });

  it("drift promote refuses a section file git does not hold, with the Forge untouched", async () => {
    const s = await setup();
    await fs.appendFile(path.join(s.forgeRoot, SECTION_FILE), "- three\n");
    git(s.forgeRoot, "add", "-A");
    git(s.forgeRoot, "commit", "-q", "-m", "three");
    await fs.writeFile(path.join(s.forgeRoot, SECTION_FILE), "- one\n- two\n- three\n- four\n");
    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);
    await apply(ws, p, await status(ws, p, await readLock(ws.root)), {});
    await handEdit(s, "- four\n", "- cuatro\n");
    await expect(promote(s)).rejects.toThrow();
    expect(await fs.readFile(path.join(s.forgeRoot, SECTION_FILE), "utf8")).toBe("- one\n- two\n- three\n- four\n");
  });

  it("a re-import writes a changed file-held value to its file and never replaces the { file: } in profile.yaml", async () => {
    // No description: a rule's .claude/ file does not carry one, so a re-import compares the base and infers the section.
    const s = await setup({ ruleDescription: null });
    await handEdit(s, "- one\n- two\n", "- uno\n- dos\n");
    const r = await importClaudeCode({ workspaceRoot: s.wsRoot, forgeRoot: s.forgeRoot, profileName: "acme" });
    expect(r.sections.map((x) => `${x.key}.${x.name}`)).toEqual(["rule/review.checklist"]);
    expect(await fs.readFile(path.join(s.forgeRoot, SECTION_FILE), "utf8")).toBe("- uno\n- dos\n");
    const profileText = await fs.readFile(path.join(s.forgeRoot, PROFILE), "utf8");
    expect(profileText).toContain("file: sections/rule/review/checklist.md");
    expect(profileText).not.toContain("uno");
  });

  it("forge promote edits a profile.yaml holding { file: } in place and reads it back as written", async () => {
    const { makeForge, profile, recipe, rule, tmpDir, writeFiles } = await import("./helpers/forge.js");
    const { runCli } = await import("./helpers/cli.js");
    const YAML = (await import("yaml")).default;
    const root = await tmpDir("craftar-section-files-promote-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const style = "style\n<!-- craftar:section s -->\nd\n<!-- /craftar:section -->\n";
    await makeForge(forge, {
      ingredients: [rule("workflow", "base text\n"), rule("workflow--acme", "acme text\n", { as: "workflow" }), rule("style", style)],
      recipes: [recipe("base", ["rule/workflow", "rule/style"]), recipe("base--acme", ["rule/workflow--acme", "rule/style"])],
      profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"], ["claude-code"], { sections: { "rule/style": { s: { file: "sections/s.md" } } } })],
    });
    await writeFiles(forge, {
      "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: FORGE_SCHEMA_SECTION_FILES }),
      "profiles/globex/sections/s.md": "globex value\n",
    });
    git(forge, "init", "-q", "-b", "main");
    git(forge, "add", "-A");
    git(forge, "commit", "-q", "-m", "forge");
    const r = runCli(["forge", "promote", "rule/workflow", "--profile", "acme", "--forge", forge, "--no-impact"], { env: { CRAFTAR_HOME: path.join(root, "home") } });
    expect(r.code, r.stderr).toBe(0);
    const globex = await fs.readFile(path.join(forge, "profiles/globex/profile.yaml"), "utf8");
    expect(globex).toContain("base--globex");
    expect(globex).toContain("file: sections/s.md");
    expect(await fs.readFile(path.join(forge, "profiles/globex/sections/s.md"), "utf8")).toBe("globex value\n");
  });

  it("forge unify take: section writes a new value into a profile.yaml holding { file: }, which reads back as written", async () => {
    const { makeForge, profile, recipe, rule, tmpDir, writeFiles } = await import("./helpers/forge.js");
    const { loadForge } = await import("../src/core/forge.js");
    const { checkParamWrites } = await import("../src/core/param-writes.js");
    const YAML = (await import("yaml")).default;
    const root = await tmpDir("craftar-section-files-unify-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await makeForge(root, {
      ingredients: [rule("deploy", "base\n"), rule("deploy--acme", "acme\n", { as: "deploy" }), rule("other", "<!-- craftar:section a -->\nd\n<!-- /craftar:section -->\n")],
      recipes: [recipe("base", ["rule/deploy", "rule/other"]), recipe("base--acme", ["rule/deploy--acme", "rule/other"])],
      profiles: [profile("acme", ["base--acme"], ["claude-code"], { sections: { "rule/other": { a: { file: "sections/a.md" } } } })],
    });
    await writeFiles(root, { "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: FORGE_SCHEMA_SECTION_FILES }), "profiles/acme/sections/a.md": "held\n" });
    const forge = await loadForge(root);
    const w = await checkParamWrites(forge, forge.ingredients.get("rule/deploy")!, forge.ingredients.get("rule/deploy--acme")!, "acme", [], [
      { key: "rule/deploy", name: "z", file: "rule.md", default: "base\n", value: "acme\n", existing: false } as never,
    ]);
    expect(w.profile!.content).toContain("file: sections/a.md");
    expect(YAML.parse(w.profile!.content).sections["rule/deploy"]).toEqual({ z: "acme\n" });
    expect(w.mustHold).toEqual([w.profile!.abs]);
  });
});
