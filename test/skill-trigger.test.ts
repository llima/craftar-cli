import { afterEach, describe, expect, it } from "vitest";
import { runDoctor, SKILL_TRIGGER_PHRASES, type Check } from "../src/core/doctor.js";
import { profile, recipe, scenario, type IngredientSpec } from "./helpers/forge.js";
import { runCli } from "./helpers/cli.js";
import { session } from "./helpers/mcp.js";

/** Spec 55 Part C, tests 25–26: doctor's skill-trigger. */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const skill = (name: string, description: string | null, layout: "dir" | "file" = "dir", targets: unknown = "*"): IngredientSpec => ({
  meta: { type: "skill", name, layout, targets },
  files: { "SKILL.md": description === null ? "Do it.\n" : `---\nname: ${name}\ndescription: ${description}\n---\nDo it.\n` },
});

async function workspaceOf(skills: IngredientSpec[], targets = ["claude-code", "kiro"]) {
  const s = await scenario(
    { ingredients: skills, recipes: [recipe("core", skills.map((k) => `skill/${k.meta.name}`))], profiles: [profile("acme", ["core"], targets)] },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  return s;
}

const doctor = (s: { root: string; wsRoot: string }) =>
  runDoctor({ version: "0.0.0", home: s.root, workspace: s.wsRoot, fetch: false, strict: false, registryOff: true, env: {}, nodeVersion: "22.11.0", gitVersion: async () => "2.53.0" });

async function triggerChecks(skills: IngredientSpec[], targets?: string[]) {
  const s = await workspaceOf(skills, targets);
  return { s, checks: (await doctor(s)).checks.filter((c: Check) => c.id === "skill-trigger") };
}

describe("doctor skill-trigger (spec 55 Part C)", () => {
  it("warns for a description that does not say when, naming the skill and never the description", async () => {
    const { checks } = await triggerChecks([skill("sqlfmt", "Formats SQL.")]);
    expect(checks).toEqual([
      {
        id: "skill-trigger",
        scope: "workspace",
        level: "warn",
        message: "skill sqlfmt: its description does not say when to use it, so the agent does not load it by itself",
        fix: 'add a "Use when …" sentence to its SKILL.md description',
      },
    ]);
  });

  it.each([
    "Formats SQL. Use when the user asks to format a query.",
    "Formata SQL. Use quando o usuário pedir.",
    "Quando usar: consultas.",
    "Triggers on a pasted query.",
  ])("says nothing for %s", async (d) => {
    expect((await triggerChecks([skill("sqlfmt", d)])).checks).toEqual([]);
  });

  it.each([
    ["Triggered by hand.", "a word boundary: triggered is not trigger"],
    [null, "no description"],
  ])("warns for %s (%s)", async (d) => {
    expect((await triggerChecks([skill("sqlfmt", d as string | null)])).checks).toHaveLength(1);
  });

  it("reads a flat skill's .md file; a Kiro-only skill is not checked", async () => {
    const { checks } = await triggerChecks([skill("flat", "Flat.", "file"), skill("kironly", "Kiro.", "dir", ["kiro"])]);
    expect(checks.map((c) => c.message.split(":")[0])).toEqual(["skill flat"]);
  });

  it("comes right after skill-layout, and is absent when every skill passes", async () => {
    const s = await workspaceOf([skill("flat", "Flat.", "file")]);
    const ids = (await doctor(s)).checks.map((c) => c.id);
    expect(ids.indexOf("skill-trigger")).toBe(ids.lastIndexOf("skill-layout") + 1);
    const ok = await workspaceOf([skill("good", "Good. Use when asked.")]);
    expect((await doctor(ok)).checks.map((c) => c.id)).not.toContain("skill-trigger");
  });

  it("doctor --strict exits 1, plain doctor 0; sync's output says nothing of it", async () => {
    const s = await workspaceOf([skill("sqlfmt", "Formats SQL.")]);
    const env = { PATH: "", Path: "" };
    expect(runCli(["doctor", "--workspace", s.wsRoot], { env }).code).toBe(0);
    expect(runCli(["doctor", "--strict", "--workspace", s.wsRoot], { env }).code).toBe(1);
    const sync = runCli(["sync", "--workspace", s.wsRoot]);
    expect(sync.code, sync.stderr).toBe(0);
    expect(sync.stdout + sync.stderr).not.toContain("skill-trigger");
    expect(sync.stdout + sync.stderr).not.toContain("does not say when");
  });

  it("the doctor tool of craftar mcp carries it", async () => {
    const s = await workspaceOf([skill("sqlfmt", "Formats SQL.")]);
    const a = await (await session(s.wsRoot)).tool("doctor");
    expect(a.isError).toBeUndefined();
    const checks = (a.structuredContent as { checks: Array<{ id: string }> }).checks;
    expect(checks.filter((c) => c.id === "skill-trigger")).toHaveLength(1);
  });

  it("the phrase list is the spec's, in order", () => {
    expect(SKILL_TRIGGER_PHRASES).toEqual([
      "use when", "use whenever", "use this when", "use it when", "use for", "use to", "use if", "when to use", "trigger",
      "triggers", "invoke when", "use quando", "quando usar", "use para", "acione quando",
    ]);
  });
});
