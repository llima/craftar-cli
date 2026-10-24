import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { runCli } from "./helpers/cli.js";
import { acmePrimary } from "./helpers/agents-md-primary.js";
import type { Scenario } from "./helpers/forge.js";

// Spec 41 §4.10: import reads back what the mode laid out.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

/** Every file of a directory, by relative POSIX path, as bytes. */
async function snapshot(root: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const walk = async (dir: string) => {
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) await walk(abs);
      else out.set(path.relative(root, abs).split(path.sep).join("/"), await fs.readFile(abs));
    }
  };
  await walk(root);
  return out;
}

function sameTree(a: Map<string, Buffer>, b: Map<string, Buffer>): void {
  expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
  for (const [k, v] of a) expect(b.get(k)!.equals(v), k).toBe(true);
}

async function importReport(s: Scenario, extra: string[] = []): Promise<{ code: number | null; stderr: string; report: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-report-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const out = path.join(dir, "report.md");
  const r = runCli(["import", "--from", "claude-code", "--forge", s.forgeRoot, "--profile", "acme", "--workspace", s.wsRoot, "--report", out, ...extra]);
  const report = await fs.readFile(out, "utf8").catch(() => "");
  return { code: r.code, stderr: r.stderr, report };
}

/**
 * The real flow: the acme workspace synced with the mode off, imported into a new Forge (so every base has the shape
 * import writes), the workspace pointed at that Forge with all three targets; then, when `primary`, that Forge moved to
 * schema 5 with the mode on in the profile, and the workspace synced again.
 */
async function importedThenSynced(primary: boolean): Promise<Scenario & { forge2: string }> {
  const s = kept(await acmePrimary({ schema: 5 }));
  expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
  const forge2 = path.join(s.root, "forge2");
  expect(runCli(["import", "--from", "claude-code", "--forge", forge2, "--profile", "acme", "--workspace", s.wsRoot, "--write-config"]).code).toBe(0);
  await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), YAML.stringify({ forge: "../forge2", profile: "acme", targets: ["claude-code", "kiro", "agents-md"] }));
  if (primary) {
    const manifest = path.join(forge2, "craftar.forge.yaml");
    await fs.writeFile(manifest, YAML.stringify({ ...YAML.parse(await fs.readFile(manifest, "utf8")), schema: 5 }));
    const prof = path.join(forge2, "profiles/acme/profile.yaml");
    const doc = YAML.parse(await fs.readFile(prof, "utf8"));
    await fs.writeFile(prof, YAML.stringify({ ...doc, params: { ...doc.params, "agents-md.primary": true } }));
  }
  const r = runCli(["sync", "--workspace", s.wsRoot]);
  expect(r.code, r.stderr).toBe(0);
  return { ...s, forgeRoot: forge2, forge2 };
}

describe("import of a workspace agents-md.primary laid out (spec 41 §4.10)", () => {
  it("into its own Forge: every base is reused, no variant, the Forge's files unchanged", async () => {
    const s = await importedThenSynced(true);
    // The mode reworded the agent's frontmatter on disk: the comparison has something to prove
    expect(await fs.readFile(path.join(s.wsRoot, ".claude/agents/api-reviewer.md"), "utf8")).toContain("AGENTS.md (rule: style)");
    const before = await snapshot(s.forgeRoot);
    const r = await importReport(s);
    expect(r.code).toBe(0);
    expect(r.report).toContain("## Variants (0)");
    expect(r.report).toContain("## Created (0)");
    sameTree(before, await snapshot(s.forgeRoot));
  });

  it("(control) mode off: a re-import reuses every base", async () => {
    const s = await importedThenSynced(false);
    const before = await snapshot(s.forgeRoot);
    const r = await importReport(s);
    expect(r.code).toBe(0);
    expect(r.report).toContain("## Variants (0)");
    sameTree(before, await snapshot(s.forgeRoot));
  });

  it("the key set and a profile that does not resolve: refused, the Forge untouched", async () => {
    const s = await importedThenSynced(true);
    const file = path.join(s.forgeRoot, "profiles/acme/profile.yaml");
    const prof = YAML.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, YAML.stringify({ ...prof, recipes: [...prof.recipes, "missing"] }));
    const before = await snapshot(s.forgeRoot);
    const r = await importReport(s);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("does not resolve on its own");
    expect(r.stderr).toContain("agents-md.primary");
    sameTree(before, await snapshot(s.forgeRoot));
  });

  it("--prefer-kiro on a steering body holding a K3 form is refused (PK3), the Forge untouched", async () => {
    const s = await importedThenSynced(true);
    const steering = path.join(s.wsRoot, ".kiro/steering/api.md");
    expect(await fs.readFile(steering, "utf8")).toContain("AGENTS.md (rule: style)");
    const before = await snapshot(s.forgeRoot);
    const r = runCli(["import", "--from", "claude-code", "--forge", s.forgeRoot, "--profile", "acme", "--workspace", s.wsRoot, "--prefer-kiro", "api"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("import: --prefer-kiro api: .kiro/steering/api.md line");
    expect(r.stderr).toContain("which Kiro writes for a rule it does not have");
    sameTree(before, await snapshot(s.forgeRoot));
  });
});

describe("import with agents-md.primary unset keeps its behaviour (spec 41 §1)", () => {
  it("a variant in the base recipe never reads the shared recipes/base.yaml: a file there that declares another name is no refusal", async () => {
    const { scenario, rule, profile } = await import("./helpers/forge.js");
    const s = kept(
      await scenario(
        { ingredients: [rule("style", "# Style\nForge text.\n")], recipes: [], profiles: [profile("acme", ["core"])] },
        { config: { profile: "acme" }, files: { ".claude/rules/style.md": "# Style\nWorkspace text.\n" } },
      ),
    );
    // recipes/base.yaml holds recipe `core`: the file name and the name differ (what I10 refuses when import writes `base`).
    await fs.mkdir(path.join(s.forgeRoot, "recipes"), { recursive: true });
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), YAML.stringify({ name: "core", ingredients: ["rule/style"] }));
    const r = runCli(["import", "--from", "claude-code", "--forge", s.forgeRoot, "--profile", "acme", "--workspace", s.wsRoot]);
    expect(r.code, r.stderr).toBe(0);
    expect(await fs.readFile(path.join(s.forgeRoot, "recipes/base--acme.yaml"), "utf8")).toContain("rule/style--acme");
  });
});
