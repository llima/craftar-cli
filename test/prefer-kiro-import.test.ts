import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { listFiles } from "../src/core/forge.js";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";

// Spec 29 §4.3 — import --prefer-kiro: the named rules come from .kiro/steering.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const BANNER = (name: string) => `<!-- GENERATED from .claude/rules/${name}.md by craftar -- do not edit. -->`;
/** A steering mirror exactly as the kiro emitter writes it: frontmatter, banner, body, CRLF. */
const mirror = (name: string, body: string) => `---\ninclusion: always\n---\n\n${BANNER(name)}\n\n${body}`.replace(/\n/g, "\r\n");
const KEPT = "# Workflow\n\nSee .kiro/steering/style.md.\nA line kept by hand.\n";
const TOKEN = "ghp_" + "x".repeat(36); // assembled at runtime on purpose

const WORKSPACE: Record<string, string> = {
  ".claude/rules/workflow.md": "# Workflow\n\nSee .claude/rules/style.md.\n",
  ".claude/rules/style.md": "# Style\n",
  ".kiro/steering/workflow.md": mirror("workflow", KEPT),
  ".kiro/steering/style.md": mirror("style", "# Style\n"),
  ".kiro/steering/team.md": "---\ninclusion: always\n---\n\n# Team notes\n",
};

async function setup(files: Record<string, string> = WORKSPACE) {
  const root = await tmpDir("craftar-prefer-kiro-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const ws = path.join(root, "acme-portal");
  await writeFiles(ws, files);
  return { root, ws, forge: path.join(root, "forge") };
}
const run = (s: { ws: string; forge: string }, preferKiro?: string[]) =>
  importClaudeCode({ workspaceRoot: s.ws, forgeRoot: s.forge, profileName: "acme", preferKiro });
const forgeFile = (s: { forge: string }, rel: string) => fs.readFile(path.join(s.forge, rel), "utf8");

describe("import with preferKiro", () => {
  it("1. the rule's text is built from the steering file, its origin says so, and the report records the two files", async () => {
    const s = await setup();
    const r = await run(s, ["workflow"]);
    expect(await forgeFile(s, "ingredients/rules/workflow/rule.md")).toBe("# Workflow\n\nSee .claude/rules/style.md.\nA line kept by hand.\n");
    expect(YAML.parse(await forgeFile(s, "ingredients/rules/workflow/ingredient.yaml")).origin.path).toBe(".kiro/steering/workflow.md");
    // The rule not named keeps its source.
    expect(YAML.parse(await forgeFile(s, "ingredients/rules/style/ingredient.yaml")).origin.path).toBe(".claude/rules/style.md");
    expect(r.preferKiro).toEqual([
      { ref: "rule/workflow", source: ".kiro/steering/workflow.md", steeringLines: 10, rule: ".claude/rules/workflow.md", ruleLines: 3, differs: true },
    ]);
  });

  it("2. the round trip: sync writes back the steering file the rule was read from, byte for byte, and leaves the .claude file as a collision", async () => {
    const s = await setup();
    await run(s, ["workflow"]);
    await fs.writeFile(path.join(s.ws, "craftar.yaml"), YAML.stringify({ forge: s.forge, profile: "acme" }));
    const ws = await loadWorkspace(s.ws);
    const p = await plan(ws);
    const planned = p.files.find((f) => f.path === ".kiro/steering/workflow.md")!;
    expect(planned.content.toString("utf8")).toBe(WORKSPACE[".kiro/steering/workflow.md"]);
    const states = Object.fromEntries((await status(ws, p, null)).map((x) => [x.path, x.state]));
    expect(states[".kiro/steering/workflow.md"]).toBe("adopt");
    expect(states[".claude/rules/workflow.md"]).toBe("collision");
    expect(states[".claude/rules/style.md"]).toBe("adopt");
  });

  it("3. PK1: a name with no rule — the Forge untouched", async () => {
    const s = await setup();
    await expect(run(s, ["team"])).rejects.toThrow(
      "import: --prefer-kiro team: there is no .claude/rules/team.md — --prefer-kiro takes rules; a steering file with no rule is already imported as steering",
    );
    await expect(fs.stat(s.forge)).rejects.toThrow();
    // A name with neither file is PK1: the rule is asked for first.
    await expect(run(s, ["nowhere"])).rejects.toThrow("import: --prefer-kiro nowhere: there is no .claude/rules/nowhere.md");
  });

  it("4. PK2: a rule with no steering file — the Forge untouched", async () => {
    const s = await setup({ ...WORKSPACE, ".claude/rules/lonely.md": "# Lonely\n" });
    await expect(run(s, ["lonely"])).rejects.toThrow("import: --prefer-kiro lonely: there is no .kiro/steering/lonely.md to prefer");
    await expect(fs.stat(s.forge)).rejects.toThrow();
  });

  it("5. PK3 and PK4 reach the caller from the pure module, the Forge untouched — and an existing Forge keeps every byte", async () => {
    const pk3 = await setup({ ...WORKSPACE, ".kiro/steering/workflow.md": mirror("workflow", "# Workflow\n\nSee AGENTS.md (rule: style).\n") });
    await expect(run(pk3, ["workflow"])).rejects.toThrow('.kiro/steering/workflow.md line 9 holds "AGENTS.md (rule: <x>)"');
    await expect(fs.stat(pk3.forge)).rejects.toThrow();

    const pk4 = await setup();
    await run(pk4); // a Forge that exists
    const before = Object.fromEntries(await Promise.all((await listFiles(pk4.forge)).map(async (f) => [f, await forgeFile(pk4, f)] as const)));
    await fs.writeFile(path.join(pk4.ws, ".kiro/steering/workflow.md"), mirror("workflow", "# Workflow\n\nSee .claude/rules/style.md.\n"));
    await expect(run(pk4, ["workflow"])).rejects.toThrow(".kiro/steering/workflow.md line 9 would not come back from the rule built from it");
    const after = Object.fromEntries(await Promise.all((await listFiles(pk4.forge)).map(async (f) => [f, await forgeFile(pk4, f)] as const)));
    expect(after).toEqual(before);
  });

  it("6. a secret-like value in the steering text rejects the rule like any source, and it is not reported as preferred", async () => {
    const s = await setup({ ...WORKSPACE, ".kiro/steering/workflow.md": mirror("workflow", KEPT + `token ${TOKEN}\n`) });
    const r = await run(s, ["workflow"]);
    expect(r.rejected.map((x) => x.name)).toEqual(["rule/workflow"]);
    // The line is the steering file's: six lines of frontmatter and banner above the body's fifth.
    expect(r.rejected[0].reason).toMatch(/^secret-like value \(.+\) in \.kiro\/steering\/workflow\.md line 11$/);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(r.preferKiro).toEqual([]);
    await expect(fs.stat(path.join(s.forge, "ingredients/rules/workflow"))).rejects.toThrow();
  });

  const BUILT = "# Workflow\n\nSee .claude/rules/style.md.\nA line kept by hand.\n";
  const tree = async (s: { forge: string }) =>
    Object.fromEntries(await Promise.all((await listFiles(s.forge)).map(async (f) => [f, await forgeFile(s, f)] as const)));
  const ruleYaml = async (s: { forge: string }, name = "workflow") => YAML.parse(await forgeFile(s, `ingredients/rules/${name}/ingredient.yaml`));

  it("7. (control) without the option, and with an empty list, the report holds no preferKiro key and the Forge is the same", async () => {
    const a = await setup();
    const b = await setup();
    const ra = await run(a);
    const rb = await run(b, []);
    expect(Object.hasOwn(ra, "preferKiro")).toBe(false);
    expect(Object.hasOwn(rb, "preferKiro")).toBe(false);
    expect(await tree(b)).toEqual(await tree(a));
    expect(await forgeFile(a, "ingredients/rules/workflow/rule.md")).toBe(WORKSPACE[".claude/rules/workflow.md"]);
  });

  it("8. a mirror that never diverged gives the rule's own text: differs is false and only origin.path moves", async () => {
    const files = { ...WORKSPACE, ".kiro/steering/workflow.md": mirror("workflow", "# Workflow\n\nSee .kiro/steering/style.md.\n") };
    const plain = await setup(files);
    const preferred = await setup(files);
    await run(plain);
    const r = await run(preferred, ["workflow"]);
    expect(r.preferKiro).toEqual([
      { ref: "rule/workflow", source: ".kiro/steering/workflow.md", steeringLines: 9, rule: ".claude/rules/workflow.md", ruleLines: 3, differs: false },
    ]);
    expect(await forgeFile(preferred, "ingredients/rules/workflow/rule.md")).toBe(files[".claude/rules/workflow.md"]);
    const a = await tree(plain);
    const b = await tree(preferred);
    const moved = "ingredients/rules/workflow/ingredient.yaml";
    expect(Object.keys(b)).toEqual(Object.keys(a));
    for (const f of Object.keys(a)) if (f !== moved) expect(b[f], f).toBe(a[f]);
    expect(YAML.parse(b[moved])).toEqual({ ...YAML.parse(a[moved]), origin: { ...YAML.parse(a[moved]).origin, path: ".kiro/steering/workflow.md" } });
  });

  it("9. the line an existing profile's kiro.banner renders is the banner, not text — and without that param the same line is text", async () => {
    const custom = (body: string) => `---\ninclusion: always\n---\n\n<!-- acme: built from .claude/rules/workflow.md -->\n\n${body}`.replace(/\n/g, "\r\n");
    const prepare = async (withParam: boolean) => {
      const s = await setup();
      await run(s);
      if (withParam) {
        const file = path.join(s.forge, "profiles/acme/profile.yaml");
        const profile = YAML.parse(await fs.readFile(file, "utf8"));
        await fs.writeFile(file, YAML.stringify({ ...profile, params: { ...(profile.params ?? {}), "kiro.banner": "<!-- acme: built from {{source}} -->" } }));
      }
      await fs.writeFile(path.join(s.ws, ".kiro/steering/workflow.md"), custom(KEPT));
      return s;
    };
    const s = await prepare(true);
    const r = await run(s, ["workflow"]);
    expect(r.preferKiro).toHaveLength(1);
    expect(await forgeFile(s, `ingredients/rules/${r.preferKiro![0].ref.split("/")[1]}/rule.md`)).toBe(BUILT);
    // Negative control: with no such param the line is the user's text, and a line naming .claude/rules/ does not come back.
    const bare = await prepare(false);
    await expect(run(bare, ["workflow"])).rejects.toThrow(".kiro/steering/workflow.md line 5 would not come back from the rule built from it");
  });

  it("10. inclusion and fileMatchPattern still come from the steering frontmatter", async () => {
    const scoped = `---\ninclusion: fileMatch\nfileMatchPattern: "src/**"\n---\n\n${BANNER("workflow")}\n\n${KEPT}`.replace(/\n/g, "\r\n");
    const files = { ...WORKSPACE, ".kiro/steering/workflow.md": scoped };
    const plain = await setup(files);
    const preferred = await setup(files);
    await run(plain);
    await run(preferred, ["workflow"]);
    for (const s of [plain, preferred]) expect(await ruleYaml(s)).toMatchObject({ inclusion: "fileMatch", fileMatchPattern: "src/**" });
    expect(await forgeFile(preferred, "ingredients/rules/workflow/rule.md")).toBe(BUILT);
  });

  it("11. a second workspace is decided against the text that was built: the same text is reused, the old one is a variant", async () => {
    const s = await setup();
    await run(s, ["workflow"]);
    const other = async (name: string, text: string) => {
      const ws = path.join(s.root, `${name}-portal`);
      await writeFiles(ws, { ".claude/rules/workflow.md": text, ".claude/rules/style.md": "# Style\n" });
      return importClaudeCode({ workspaceRoot: ws, forgeRoot: s.forge, profileName: name });
    };
    const same = await other("globex", BUILT);
    expect(same.reused).toContain("rule/workflow");
    expect(Object.hasOwn(same, "preferKiro")).toBe(false);
    const old = await other("initech", WORKSPACE[".claude/rules/workflow.md"]);
    expect(old.variants.map((v) => v.name)).toEqual(["rule/workflow--initech"]);
  });

  it("12. with a lock that records the .claude file unedited, the next status is update — and the steering file is adopted", async () => {
    const s = await setup();
    await run(s);
    await fs.writeFile(path.join(s.ws, "craftar.yaml"), YAML.stringify({ forge: s.forge, profile: "acme" }));
    const first = await loadWorkspace(s.ws);
    const p1 = await plan(first);
    const st1 = await status(first, p1, await readLock(first.root));
    expect(st1.find((x) => x.path === ".kiro/steering/workflow.md")!.state).toBe("collision");
    await apply(first, p1, st1);
    const r = await run(s, ["workflow"]);
    // Import never rewrites a base: the text that differs from the profile's own rule lands as its variant.
    expect(r.preferKiro!.map((e) => e.ref)).toEqual(["rule/workflow--acme"]);
    const ws = await loadWorkspace(s.ws);
    const p = await plan(ws);
    const states = Object.fromEntries((await status(ws, p, await readLock(ws.root))).map((x) => [x.path, x.state]));
    expect(states[".claude/rules/workflow.md"]).toBe("update");
    expect(states[".kiro/steering/workflow.md"]).toBe("adopt");
    expect(await fs.readFile(path.join(s.ws, ".kiro/steering/workflow.md"), "utf8")).toBe(WORKSPACE[".kiro/steering/workflow.md"]);
  });

  it("13. what is scanned is the steering file: a token in a UTF-16 rule file that is not taken rejects nothing", async () => {
    const s = await setup();
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`# Workflow\ntoken ${TOKEN}\n`, "utf16le")]);
    await fs.writeFile(path.join(s.ws, ".claude/rules/workflow.md"), utf16);
    // Control: read from .claude, the rule is rejected.
    const plain = await setup();
    await fs.writeFile(path.join(plain.ws, ".claude/rules/workflow.md"), utf16);
    expect((await run(plain)).rejected.map((x) => x.name)).toEqual(["rule/workflow"]);
    const r = await run(s, ["workflow"]);
    expect(r.rejected).toEqual([]);
    expect(r.preferKiro!.map((e) => e.ref)).toEqual(["rule/workflow"]);
    expect(await forgeFile(s, "ingredients/rules/workflow/rule.md")).toBe(BUILT);
  });

  it("14. a reference to a hand-written steering file stays a .kiro/steering/ path in the rule, and the round trip holds", async () => {
    const body = "# Workflow\n\nSee .kiro/steering/style.md and the team notes in .kiro/steering/team.md.\n";
    const s = await setup({ ...WORKSPACE, ".kiro/steering/workflow.md": mirror("workflow", body) });
    await run(s, ["workflow"]);
    expect(await forgeFile(s, "ingredients/rules/workflow/rule.md")).toBe("# Workflow\n\nSee .claude/rules/style.md and the team notes in .kiro/steering/team.md.\n");
    await fs.writeFile(path.join(s.ws, "craftar.yaml"), YAML.stringify({ forge: s.forge, profile: "acme" }));
    const ws = await loadWorkspace(s.ws);
    const p = await plan(ws);
    expect(p.files.find((f) => f.path === ".kiro/steering/workflow.md")!.content.toString("utf8")).toBe(mirror("workflow", body));
    expect(p.files.find((f) => f.path === ".claude/rules/workflow.md")!.content.toString("utf8")).toContain(".kiro/steering/team.md");
  });

  it("15. the banner dropped is the one sync would write: set by the workspace's overrides, or by a recipe default", async () => {
    const line = "<!-- acme: generated, do not edit -->";
    const custom = `---\ninclusion: always\n---\n\n${line}\n\n${KEPT}`.replace(/\n/g, "\r\n");
    // The workspace's own craftar.yaml sets it; the profile is new.
    const over = await setup({ ...WORKSPACE, ".kiro/steering/workflow.md": custom, "craftar.yaml": YAML.stringify({ overrides: { params: { "kiro.banner": line } } }) });
    await run(over, ["workflow"]);
    expect(await forgeFile(over, "ingredients/rules/workflow/rule.md")).toBe(BUILT);
    // A recipe the profile already resolves gives it as a default.
    const byRecipe = await setup();
    await run(byRecipe);
    const recipeFile = path.join(byRecipe.forge, "recipes/base.yaml");
    await fs.writeFile(recipeFile, YAML.stringify({ ...YAML.parse(await fs.readFile(recipeFile, "utf8")), params: { "kiro.banner": { default: line } } }));
    await fs.writeFile(path.join(byRecipe.ws, ".kiro/steering/workflow.md"), custom);
    const r = await run(byRecipe, ["workflow"]);
    expect(await forgeFile(byRecipe, `ingredients/rules/${r.preferKiro![0].ref.split("/")[1]}/rule.md`)).toBe(BUILT);
    // Control: nothing sets it — the line is the user's text, and stays the rule's first line.
    const bare = await setup({ ...WORKSPACE, ".kiro/steering/workflow.md": custom });
    await run(bare, ["workflow"]);
    expect(await forgeFile(bare, "ingredients/rules/workflow/rule.md")).toBe(`${line}\n\n${BUILT}`);
  });

  it("16. a section marker in the steering text is refused by the steering file's own line", async () => {
    const s = await setup({ ...WORKSPACE, ".kiro/steering/workflow.md": mirror("workflow", KEPT + "<!-- craftar:section extra -->\nmore\n<!-- craftar:end -->\n") });
    await expect(run(s, ["workflow"])).rejects.toThrow("import: .kiro/steering/workflow.md holds a section marker on line 11 — sync would not reproduce it");
    await expect(fs.stat(s.forge)).rejects.toThrow();
  });
});
