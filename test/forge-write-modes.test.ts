import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { loadForge } from "../src/core/forge.js";
import { applyMove, planLocalize, planShare } from "../src/core/localize.js";
import { applyBasePromotion, planBasePromotion } from "../src/core/promote.js";
import { makeForge, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";

// Tech-debt L2a (E10.3): a file a Forge edit moves or copies keeps its source's mode. Modes do not exist on Windows.
const win = process.platform === "win32";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
const modeOf = async (abs: string) => (await fs.stat(abs)).mode & 0o777;

async function forge(spec: ForgeSpec, extra: Record<string, string>, executables: string[], schema?: number): Promise<string> {
  const root = await tmpDir("craftar-forge-modes-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "forge");
  await makeForge(dir, spec);
  if (schema !== undefined) await fs.writeFile(path.join(dir, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
  await writeFiles(dir, extra);
  for (const rel of executables) await fs.chmod(path.join(dir, rel), 0o755);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "forge");
  return dir;
}

describe.skipIf(win)("a moved or promoted file keeps its source's mode (E10.3)", () => {
  it("forge promote: the base takes the variant's 0755 file, and the old base's 0755 file is kept 0755 in X--q", async () => {
    const dir = await forge(
      {
        ingredients: [rule("workflow", "base\n"), rule("workflow--acme", "acme\n", { as: "workflow" })],
        recipes: [recipe("base", ["rule/workflow"]), recipe("base--acme", ["rule/workflow--acme"])],
        profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"])],
      },
      { "ingredients/rules/workflow/run.sh": "echo base\n", "ingredients/rules/workflow--acme/run.sh": "echo acme\n" },
      ["ingredients/rules/workflow/run.sh", "ingredients/rules/workflow--acme/run.sh"],
    );
    const p = await planBasePromotion(await loadForge(dir), "rule/workflow", "acme");
    await applyBasePromotion(p, []);
    expect(await fs.readFile(path.join(dir, "ingredients/rules/workflow/run.sh"), "utf8")).toBe("echo acme\n");
    expect(await modeOf(path.join(dir, "ingredients/rules/workflow/run.sh"))).toBe(0o755);
    expect(await fs.readFile(path.join(dir, "ingredients/rules/workflow--globex/run.sh"), "utf8")).toBe("echo base\n");
    expect(await modeOf(path.join(dir, "ingredients/rules/workflow--globex/run.sh"))).toBe(0o755);
    expect(git(dir, "diff", "--summary")).not.toContain("mode change");
  });

  it("forge promote: a variant's file with no exec bit makes the base's 0755 file lose it", async () => {
    const dir = await forge(
      {
        ingredients: [rule("workflow", "base\n"), rule("workflow--acme", "acme\n", { as: "workflow" })],
        recipes: [recipe("base", ["rule/workflow"]), recipe("base--acme", ["rule/workflow--acme"])],
        profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"])],
      },
      { "ingredients/rules/workflow/run.sh": "echo base\n", "ingredients/rules/workflow--acme/run.sh": "echo acme\n" },
      ["ingredients/rules/workflow/run.sh"],
    );
    const plain = await modeOf(path.join(dir, "ingredients/rules/workflow--acme/run.sh"));
    expect(plain & 0o111).toBe(0);
    const p = await planBasePromotion(await loadForge(dir), "rule/workflow", "acme");
    await applyBasePromotion(p, []);
    expect(await modeOf(path.join(dir, "ingredients/rules/workflow/run.sh"))).toBe(plain);
  });

  it("forge localize, then forge share: a 0755 file keeps 0755 both ways", async () => {
    const dir = await forge(
      {
        ingredients: [rule("style", "# Style\n"), rule("x", "# X\n")],
        recipes: [recipe("base", ["rule/style"]), recipe("stack-x", ["rule/x"])],
        profiles: [profile("acme", ["base", "stack-x"]), profile("globex", ["base"])],
      },
      { "ingredients/rules/x/run.sh": "echo x\n" },
      ["ingredients/rules/x/run.sh"],
      8,
    );
    await applyMove(await planLocalize(await loadForge(dir), "rule/x", "acme"), []);
    const local = path.join(dir, "profiles/acme/ingredients/rules/x/run.sh");
    expect(await fs.readFile(local, "utf8")).toBe("echo x\n");
    expect(await modeOf(local)).toBe(0o755);
    await applyMove(await planShare(await loadForge(dir), "rule/x", "acme"), []);
    expect(await modeOf(path.join(dir, "ingredients/rules/x/run.sh"))).toBe(0o755);
  });
});
