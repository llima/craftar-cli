import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadForge } from "../src/core/forge.js";
import { applyPlan, planFrom } from "../src/core/unify.js";
import { diffIngredients } from "../src/core/variants.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, scenario, writeFiles } from "./helpers/forge.js";

/** Spec 51 §4.6, acceptance 5: a section in a directory skill's shell file, at schema 8 and above. */

type Scenario = Awaited<ReturnType<typeof scenario>>;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const RUN_SH = "#!/bin/sh\n<!-- craftar:section greeting -->\necho hello\n<!-- /craftar:section -->\nV={{tags}}\n";

async function at(schema: number, files: Record<string, string> = {}, sections: Record<string, unknown> = {}): Promise<Scenario> {
  const s = await scenario(
    {
      ingredients: [{ meta: { type: "skill", name: "sk", layout: "dir" }, files: { "SKILL.md": "---\nname: sk\ndescription: A skill\n---\nRun it.\n", "run.sh": RUN_SH, ...files } }],
      recipes: [recipe("core", ["skill/sk"])],
      profiles: [profile("acme", ["core"], ["claude-code", "kiro"], { params: { tags: "a b" }, sections })],
    },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
  return s;
}

const read = (s: Scenario, rel: string) => fs.readFile(path.join(s.wsRoot, rel), "utf8");

describe("a section in a skill's shell file (spec 51 §4.6)", () => {
  it("acceptance 5: at schema 8 claude-code expands it, Kiro keeps the bytes and says so", async () => {
    const s = await at(8, {}, { "skill/sk": { greeting: "echo hi from acme\n" } });
    const r = runCli(["sync", "--workspace", s.wsRoot]);
    expect(r.code, r.stderr).toBe(0);
    expect(await read(s, ".claude/skills/sk/run.sh")).toBe("#!/bin/sh\necho hi from acme\nV=a b\n");
    expect(await read(s, ".kiro/skills/sk/run.sh")).toBe(RUN_SH);
    expect(r.stdout).toContain("skill/sk run.sh: kiro copies run.sh as bytes: its sections and params are not rendered");
    expect(r.stdout).not.toContain("section markers are read only in files every target renders as text");
  });

  it("explain lists the section for the claude-code file and none for Kiro's bytes", async () => {
    const s = await at(8);
    expect(runCli(["explain", ".claude/skills/sk/run.sh", "--workspace", s.wsRoot]).stdout).toContain("sections    greeting (default)");
    expect(runCli(["explain", ".kiro/skills/sk/run.sh", "--workspace", s.wsRoot]).stdout).not.toContain("sections");
  });

  it("at schema 7 the file is copied with its markers, and warned as before", async () => {
    const s = await at(7);
    const r = runCli(["sync", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(await read(s, ".claude/skills/sk/run.sh")).toBe("#!/bin/sh\n<!-- craftar:section greeting -->\necho hello\n<!-- /craftar:section -->\nV=a b\n");
    expect(r.stdout).toContain("section markers are read only in files every target renders as text — copied with them");
    expect(r.stdout).not.toContain("kiro copies");
  });

  it("no warning for a shell file with neither a marker nor a param any layer sets", async () => {
    const s = await at(8, { "plain.sh": "#!/bin/sh\necho {{ .Go }}\n" });
    expect(runCli(["sync", "--workspace", s.wsRoot]).stdout).not.toContain("plain.sh: kiro copies");
  });

  it("a section declared in both SKILL.md and the shell file fails the plan at schema 8", async () => {
    const s = await at(8, { "SKILL.md": "---\nname: sk\ndescription: A skill\n---\n<!-- craftar:section greeting -->\nx\n<!-- /craftar:section -->\n" });
    const r = runCli(["sync", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("greeting");
  });

  it("acceptance 5: a re-import of the synced workspace reuses the base", async () => {
    const s = await at(8);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    const r = runCli(["import", "--from", "claude-code", "--workspace", s.wsRoot, "--forge", s.forgeRoot, "--profile", "acme"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("0 variants");
  });
});

describe("forge unify and a skill's shell file at schema 8 (spec 51 §4.6)", () => {
  async function pair(variantSh: string) {
    const s = await at(8);
    await writeFiles(s.forgeRoot, {
      "ingredients/skills/sk--acme/ingredient.yaml": YAML.stringify({ type: "skill", name: "sk--acme", as: "sk", layout: "dir" }),
      "ingredients/skills/sk--acme/SKILL.md": "---\nname: sk\ndescription: A skill\n---\nRun it.\n",
      "ingredients/skills/sk--acme/run.sh": variantSh,
    });
    const forge = await loadForge(s.forgeRoot);
    const base = forge.ingredients.get("skill/sk" as never)!;
    const variant = forge.ingredients.get("skill/sk--acme" as never)!;
    const diff = await diffIngredients(base, variant);
    const plan = await planFrom(base, variant, diff, "acme", 8);
    return { base, variant, diff, plan };
  }

  it("take: section of a section the base declares passes, with Kiro's note", async () => {
    const { base, variant, diff, plan } = await pair("#!/bin/sh\necho hi from acme\nV={{tags}}\n");
    const f = plan.files.find((x) => x.file === "run.sh")!;
    for (const h of f.hunks!) Object.assign(h, { take: "section", section: { name: "greeting" } });
    const r = await applyPlan(base, variant, diff, plan, { forgeSchema: 8 });
    expect(r.sections.map((x) => x.name)).toEqual(["greeting"]);
    expect(r.notes).toEqual(["unify: run.sh: kiro keeps the base's text; the value of section greeting reaches only claude-code"]);
  });

  it("take: section of a new section there is refused as S2", async () => {
    const { base, variant, diff, plan } = await pair("#!/bin/sh\necho hello\nV={{tags}}\necho extra\n");
    const f = plan.files.find((x) => x.file === "run.sh")!;
    for (const h of f.hunks!) Object.assign(h, { take: "base" });
    Object.assign(f.hunks!.at(-1)!, { take: "section", section: { name: "fresh" } });
    await expect(applyPlan(base, variant, diff, plan, { forgeSchema: 8 })).rejects.toThrow('"run.sh" is copied without expansion by a target that emits it');
  });
});
