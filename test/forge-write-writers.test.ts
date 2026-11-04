import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadForge } from "../src/core/forge.js";
import { writeEdits } from "../src/core/forge-edits.js";
import { writeParamFile } from "../src/core/param-writes.js";
import { rewriteRecipes, writeUnified } from "../src/core/unify.js";
import { ForgeStage } from "../src/importers/claude-code.js";
import { fsRoot, makeForge, profile, recipe, rule, tmpDir, writeFiles } from "./helpers/forge.js";

// Tech-debt L2a (E9.1): every Forge writer replaces a file; none writes through a hard link to a file outside the Forge.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function scratch(): Promise<string> {
  const d = await tmpDir();
  cleanups.push(() => fs.rm(d, { recursive: true, force: true }));
  return d;
}

/** Hard-link `abs` (which must not exist) to a new private file outside the Forge; returns the private file's path. */
async function linkOut(abs: string): Promise<string> {
  const outside = path.join(await scratch(), "private.txt");
  await fs.writeFile(outside, "private\n");
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.link(outside, abs);
  return outside;
}

describe("no Forge writer writes through a hard link (E9.1)", () => {
  it("ForgeStage.flush (import)", async () => {
    const root = await scratch();
    const abs = path.join(root, "ingredients/rules/r/rule.md");
    const outside = await linkOut(abs);
    const stage = new ForgeStage(root);
    stage.write(abs, "new\n");
    await stage.flush();
    expect(await fs.readFile(abs, "utf8")).toBe("new\n");
    expect(await fs.readFile(outside, "utf8")).toBe("private\n");
  });

  it("ForgeStage.flushTo (drift promote, import's proof)", async () => {
    const root = await scratch();
    const other = await scratch();
    const outside = await linkOut(path.join(other, "a.txt"));
    const stage = new ForgeStage(root);
    stage.write(path.join(root, "a.txt"), "new\n");
    const journal: Array<{ abs: string; created: boolean }> = [];
    await stage.flushTo(other, { journal });
    expect(await fs.readFile(path.join(other, "a.txt"), "utf8")).toBe("new\n");
    expect(await fs.readFile(outside, "utf8")).toBe("private\n");
    expect(journal).toEqual([{ abs: path.join(other, "a.txt"), created: false }]);
  });

  it("writeUnified (forge unify)", async () => {
    const dir = await scratch();
    await writeFiles(dir, { "ingredient.yaml": "type: rule\nname: workflow\n" });
    const outside = await linkOut(path.join(dir, "rule.md"));
    const base = { ref: "rule/workflow", dir, forgeRoot: fsRoot(dir), meta: { type: "rule", name: "workflow" } } as never;
    await writeUnified(base, { write: { "rule.md": "y\n" }, remove: [], resolved: true, unresolved: 0 } as never);
    expect(await fs.readFile(path.join(dir, "rule.md"), "utf8")).toBe("y\n");
    expect(await fs.readFile(outside, "utf8")).toBe("private\n");
  });

  it("rewriteRecipes (forge unify's cascade)", async () => {
    const root = await scratch();
    await makeForge(root, {
      ingredients: [rule("workflow", "a\n"), rule("workflow--acme", "b\n", { as: "workflow" })],
      recipes: [recipe("base--acme", ["rule/workflow--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });
    const forge = await loadForge(root);
    const file = (await fs.readdir(path.join(root, "recipes"))).find((n) => n.startsWith("base--acme"))!;
    const abs = path.join(root, "recipes", file);
    const text = await fs.readFile(abs, "utf8");
    await fs.rm(abs);
    const outside = await linkOut(abs);
    await fs.writeFile(outside, text);
    await rewriteRecipes(forge, "rule/workflow", "rule/workflow--acme", "acme");
    expect(await fs.readFile(abs, "utf8")).toContain("rule/workflow\n");
    expect(await fs.readFile(outside, "utf8")).toBe(text);
  });

  it("writeParamFile (forge unify's param and section writes)", async () => {
    const root = await scratch();
    const abs = path.join(root, "profiles/acme/profile.yaml");
    const outside = await linkOut(abs);
    await writeParamFile({ abs, content: "name: acme\n" });
    expect(await fs.readFile(abs, "utf8")).toBe("name: acme\n");
    expect(await fs.readFile(outside, "utf8")).toBe("private\n");
  });

  it("writeEdits (forge promote, forge localize, forge share)", async () => {
    const root = await scratch();
    const abs = path.join(root, "ingredients/rules/r/rule.md");
    const outside = await linkOut(abs);
    await writeEdits(root, root, { writes: [{ abs, content: "new\n", created: false }], removes: [] });
    expect(await fs.readFile(abs, "utf8")).toBe("new\n");
    expect(await fs.readFile(outside, "utf8")).toBe("private\n");
  });
});
