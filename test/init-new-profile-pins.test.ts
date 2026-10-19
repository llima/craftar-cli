import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { askInit, type InitIo } from "../src/core/init-flow.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, profile, recipe, rule, tmpDir } from "./helpers/forge.js";

// Spec 38 §10: outputs pinned BEFORE the build touches the code behind them — `init` with both flags (it must keep
// every byte once --new-profile exists), and the profile question's answer `0`, which matches nothing today and
// re-asks (spec 38 tests the new `0)` entry between the names and the numbers). The link refusals of
// assertNoLinkOnPath are already pinned byte for byte by test/drift-promote.test.ts and test/promote.test.ts, and
// forge promote's writes by its golden; measured at 3faa0b4: every Forge writer journals files only, so a
// lateFailure that tells a created directory by `stat` changes none of their lines.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function scratch(): Promise<string> {
  const dir = await fs.realpath(await tmpDir("craftar-np-pin-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const SPEC = {
  ingredients: [rule("a", "# A\n"), rule("b", "# B\n")],
  recipes: [recipe("base", ["rule/a"]), recipe("extra", ["rule/b"])],
  profiles: [profile("acme", ["base"], ["claude-code", "kiro"]), profile("globex", ["base"], ["kiro"])],
};

describe("pin — init with --forge and --profile (before --new-profile exists)", () => {
  it("stdout byte for byte, a recipe flag included", async () => {
    const p = await scratch();
    await makeForge(path.join(p, "forge"), SPEC);
    const ws = path.join(p, "ws");
    const r = runCli(["init", "--forge", path.join(p, "forge"), "--profile", "acme", "--add-recipe", "extra", "--workspace", ws]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      [
        `craftar init — wrote craftar.yaml in ${ws}`,
        "  forge ../forge · profile acme · recipes base → extra · targets claude-code, kiro (from the profile)",
        "craftar sync — profile acme · recipes base → extra · targets claude-code, kiro",
        "  wrote 4, removed 0 orphan(s), skipped 0",
        "  + .claude/rules/a.md",
        "  + .claude/rules/b.md",
        "  + .kiro/steering/a.md",
        "  + .kiro/steering/b.md",
        "",
      ].join("\n"),
    );
    expect(await fs.readFile(path.join(ws, "craftar.yaml"), "utf8")).toBe("forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - extra\n");
  });
});

describe("pin — the profile question's answer `0` matches nothing today and re-asks", () => {
  it("0, then a name", async () => {
    const p = await scratch();
    const forge = path.join(p, "forge");
    await makeForge(forge, SPEC);
    const ws = path.join(p, "ws");
    await fs.mkdir(ws);
    const answers = ["0", "acme"];
    const asked: string[] = [];
    const said: string[] = [];
    const next = async (q: string) => (asked.push(q), answers.length ? answers.shift()! : "");
    const io: InitIo = { ask: next, confirm: next, say: (l) => void said.push(l) };
    const r = await askInit(ws, { forge, addRecipes: [], removeRecipes: [], replace: false }, { doc: null, keys: [] }, io, { registryOff: true, exists: existsSync });
    if (r.kind !== "answered") throw new Error("expected answers");
    expect(r.input.profile).toBe("acme");
    const profileQuestions = asked.filter((q) => q.startsWith("Profile"));
    expect(profileQuestions.length).toBe(2);
    expect(said.some((l) => l.includes("0) a new profile"))).toBe(false);
  });
});
