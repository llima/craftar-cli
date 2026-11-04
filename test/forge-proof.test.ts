import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoLinkOnPath, copyForgeForProof, listFiles, removeProofCopy, scratchWriteRefusal } from "../src/core/forge.js";
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

describe("copyForgeForProof copies only what loadForge reads (E9.2)", () => {
  it("leaves out every root entry but the manifest and the three trees, and keeps a loose file inside them", async () => {
    const s = await scenario();
    await writeFiles(s.forge, {
      "node_modules/pkg/index.js": "x\n",
      "notes.txt": "loose\n",
      "docs/readme.md": "doc\n",
      "recipes/base.yaml": "name: base\ningredients: []\n",
      "profiles/acme/profile.yaml": "name: acme\nrecipes: [base]\n",
      "ingredients/rules/workflow/.cache": "ignored by git, read by nothing, copied anyway\n",
    });
    const scratch = path.join(s.root, "scratch");
    await copyForgeForProof(s.forge, scratch);
    expect(await listFiles(scratch)).toEqual([
      "craftar.forge.yaml",
      "ingredients/rules/workflow/.cache",
      "ingredients/rules/workflow/ingredient.yaml",
      "ingredients/rules/workflow/rule.md",
      "ingredients/skills/review/docs/deep/notes.md",
      "profiles/acme/profile.yaml",
      "recipes/base.yaml",
    ]);
  });
});

const rootUser = typeof process.getuid === "function" && process.getuid() === 0;
describe.skipIf(process.platform === "win32" || rootUser)("copyForgeForProof keeps directory modes (E10.6b)", () => {
  it("gives a copied directory the source's mode, and removeProofCopy still removes the copy", async () => {
    const s = await scenario();
    const ro = path.join(s.forge, "ingredients/rules/workflow");
    await fs.chmod(ro, 0o555);
    cleanups.push(() => fs.chmod(ro, 0o755));
    const scratch = path.join(s.root, "scratch");
    await copyForgeForProof(s.forge, scratch);
    expect((await fs.stat(path.join(scratch, "ingredients/rules/workflow"))).mode & 0o777).toBe(0o555);
    await expect(fs.writeFile(path.join(scratch, "ingredients/rules/workflow/new.md"), "x")).rejects.toMatchObject({ code: "EACCES" });
    await removeProofCopy(scratch);
    await expect(fs.lstat(scratch)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

const folds = process.platform === "win32" || process.platform === "darwin";
describe("copyForgeForProof reads the root's names as loadForge finds them (E9.2)", () => {
  it("keeps a root tree spelled with capitals where the disk folds case, and leaves it out elsewhere", async () => {
    const s = await scenario();
    await writeFiles(s.forge, { "Recipes/base.yaml": "name: base\ningredients: []\n" });
    const scratch = path.join(s.root, "scratch");
    await copyForgeForProof(s.forge, scratch);
    expect((await listFiles(scratch)).includes("Recipes/base.yaml")).toBe(folds);
  });
  it("refuses a root tree link spelled with capitals where the disk folds case, and skips it elsewhere", async () => {
    const s = await scenario();
    const outside = path.join(s.root, "recipes-elsewhere");
    await fs.mkdir(outside);
    // A junction on Windows needs no privilege; elsewhere the type is ignored.
    await fs.symlink(outside, path.join(s.forge, "Recipes"), "junction");
    const run = copyForgeForProof(s.forge, path.join(s.root, "scratch"));
    if (folds) await expect(run).rejects.toThrow("Recipes is a symbolic link in the Forge — promote does not read a linked recipes, ingredients or profiles directory");
    else await expect(run).resolves.toBeUndefined();
  });
});

describe("scratchWriteRefusal speaks of the Forge only for a mode refusal", () => {
  it("says the Forge cannot be written for EACCES or EPERM, and the temporary directory for anything else", () => {
    const scratch = path.join(path.sep, "tmp", "craftar-x");
    const at = path.join(scratch, "recipes", "base.yaml");
    const err = (code: string) => scratchWriteRefusal("unify", scratch, Object.assign(new Error("x"), { code, path: at })).message;
    expect(err("EACCES")).toBe("unify: recipes/base.yaml could not be written on the scratch copy the edit is proved on (EACCES) — it cannot be written in the Forge either; nothing written");
    expect(err("EPERM")).toContain("it cannot be written in the Forge either");
    for (const code of ["ENOSPC", "EROFS", "EBUSY"]) {
      expect(err(code)).toBe(`unify: the scratch copy in the temporary directory refused a write (${code}) — nothing written; free or fix the temporary directory and run again`);
    }
  });
});

describe.skipIf(process.platform === "win32" || rootUser)("copyForgeForProof gives the copy's root the Forge root's owner permissions", () => {
  it("a Forge root its owner cannot write into gives a copy root that refuses a write too, still private", async () => {
    const s = await scenario();
    await fs.chmod(s.forge, 0o555);
    cleanups.push(() => fs.chmod(s.forge, 0o755));
    const scratch = path.join(s.root, "scratch");
    await copyForgeForProof(s.forge, scratch);
    expect((await fs.stat(scratch)).mode & 0o777).toBe(0o500);
    await removeProofCopy(scratch);
    await expect(fs.lstat(scratch)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
