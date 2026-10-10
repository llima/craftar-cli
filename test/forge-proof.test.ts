import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoLinkOnPath, copyForgeForProof, listFiles } from "../src/core/forge.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";

// The scratch copy a Forge proof runs on, and the link check its writes share — `drift promote` (spec 30) and
// `forge promote` (spec 29, slice D) both go through these two. The copy's link cases are in drift-promote.test.ts.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function scenario() {
  const root = await tmpDir("craftar-forge-proof-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const forge = path.join(root, "forge");
  await writeFiles(forge, {
    "craftar.forge.yaml": "name: acme\nschema: 1\n",
    ".git/HEAD": "ref: refs/heads/main\n",
    "ingredients/rules/workflow/ingredient.yaml": "type: rule\nname: workflow\nfile: rule.md\n",
    "ingredients/rules/workflow/rule.md": Buffer.from([0x23, 0x20, 0xff, 0x0d, 0x0a]),
    "ingredients/skills/review/docs/deep/notes.md": "notes\n",
  });
  return { root, forge };
}

describe("copyForgeForProof", () => {
  it("copies every file byte for byte, nested directories included, and leaves .git out", async () => {
    const s = await scenario();
    const scratch = path.join(s.root, "scratch");
    await copyForgeForProof(s.forge, scratch);
    const files = (await listFiles(s.forge)).filter((f) => !f.startsWith(".git/"));
    expect(await listFiles(scratch)).toEqual(files);
    for (const f of files) expect((await fs.readFile(path.join(scratch, f))).equals(await fs.readFile(path.join(s.forge, f))), f).toBe(true);
  });
});

describe("assertNoLinkOnPath", () => {
  it("accepts existing files and paths still to be created", async () => {
    const s = await scenario();
    await expect(
      assertNoLinkOnPath(s.forge, [path.join(s.forge, "ingredients/rules/workflow/rule.md"), path.join(s.forge, "ingredients/rules/workflow--globex/rule.md")]),
    ).resolves.toBeUndefined();
  });
  it("refuses a path under a linked directory, and names the link", async () => {
    const s = await scenario();
    const outside = path.join(s.root, "elsewhere");
    await fs.mkdir(outside);
    // A junction on Windows needs no privilege; elsewhere the type is ignored.
    await fs.symlink(outside, path.join(s.forge, "ingredients/rules/linked"), "junction");
    await expect(assertNoLinkOnPath(s.forge, [path.join(s.forge, "ingredients/rules/linked/rule.md")])).rejects.toThrow(
      "ingredients/rules/linked is a symbolic link in the Forge — promote does not write through a link; replace it with the file and commit",
    );
  });
  it("names a linked root directory by its own message", async () => {
    const s = await scenario();
    const outside = path.join(s.root, "recipes-elsewhere");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(s.forge, "recipes"), "junction");
    await expect(assertNoLinkOnPath(s.forge, [path.join(s.forge, "recipes/base.yaml")])).rejects.toThrow(
      "recipes is a symbolic link in the Forge — promote does not read a linked recipes, ingredients or profiles directory",
    );
  });
});
