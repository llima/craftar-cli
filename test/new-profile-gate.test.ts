import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoLinkOnPath, loadForge } from "../src/core/forge.js";
import { newProfileGate } from "../src/core/new-profile-gate.js";
import { makeForge, profile, recipe, rule, tmpDir, type ForgeSpec } from "./helpers/forge.js";
import { git } from "./helpers/remote.js";

// Spec 38 §4.2 P5–P8 and §5.2 — the gate of the one path `init --new-profile` creates. Local git repositories in
// temp dirs; no network. Directory links are junctions on win32 so those cases run on both platforms.

const WIN = process.platform === "win32";
const DIR_LINK = WIN ? "junction" : "dir";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function scratch(prefix = "craftar-np-gate-"): Promise<string> {
  const dir = await fs.realpath(await tmpDir(prefix));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const SPEC: ForgeSpec = {
  ingredients: [rule("a", "# A\n")],
  recipes: [recipe("base", ["rule/a"])],
  profiles: [profile("acme", ["base"])],
};
/** The Forge as the command loaded it — before the obstacle a test puts on the disk (the gate reads the disk itself). */
const loaded = new Map<string, Awaited<ReturnType<typeof loadForge>>>();
const L = (root: string) => loaded.get(root)!;
/** A Forge directory that is a git repository with one commit (or not, or with none). */
async function forgeRepo(opts: { git?: "commit" | "init" | "none"; spec?: ForgeSpec } = {}) {
  const root = path.join(await scratch(), "forge");
  await makeForge(root, opts.spec ?? SPEC);
  const mode = opts.git ?? "commit";
  if (mode !== "none") git(root, "init", "-q", "-b", "main");
  if (mode === "commit") {
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
  }
  loaded.set(root, await loadForge(root));
  return root;
}
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
};
const LINK_FILE = (rel: string) => `${rel} is a symbolic link in the Forge — init does not write through a link; replace it with the file and commit`;
const LINK_DIR = "profiles is a symbolic link in the Forge — init does not read a linked recipes, ingredients or profiles directory; replace it with the directory and commit";

describe("assertNoLinkOnPath takes the writing command's name", () => {
  it("init's words; the default keeps promote's bytes", async () => {
    const root = await forgeRepo();
    const out = await scratch();
    await fs.symlink(out, path.join(root, "profiles", "initech"), DIR_LINK);
    const target = path.join(root, "profiles", "initech");
    expect(await refusal(assertNoLinkOnPath(root, [target], "init"))).toBe(LINK_FILE("profiles/initech"));
    expect(await refusal(assertNoLinkOnPath(root, [target]))).toBe(
      "profiles/initech is a symbolic link in the Forge — promote does not write through a link; replace it with the file and commit",
    );
  });
});

describe("newProfileGate — P5 and P6 (no name: the flow's question)", () => {
  it("a clean repository with a commit passes, with and without a name", async () => {
    const root = await forgeRepo();
    const forge = await loadForge(root);
    const home = await scratch();
    await expect(newProfileGate(forge, home)).resolves.toBeUndefined();
    await expect(newProfileGate(forge, home, "initech")).resolves.toBeUndefined();
  });
  it("a dirty Forge passes (the write overwrites nothing, §6 case 5)", async () => {
    const root = await forgeRepo();
    await fs.writeFile(path.join(root, "recipes", "base.yaml"), "name: base\ningredients: [rule/a]\n# edited\n");
    await expect(newProfileGate(await loadForge(root), await scratch(), "initech")).resolves.toBeUndefined();
  });
  it("P6: not a git repository, and a repository with no commit", async () => {
    for (const mode of ["none", "init"] as const) {
      const root = await forgeRepo({ git: mode });
      expect(await refusal(newProfileGate(await loadForge(root), await scratch()))).toBe(
        `cannot create a profile in ${root}: it is not a git repository with a commit — git is how a Forge write is undone`,
      );
    }
  });
  it("P5: a Forge directory under $CRAFTAR_HOME/forges — refused before git is asked", async () => {
    const home = await scratch();
    const root = path.join(home, "forges", "example-0123456789ab", "trees", "abc");
    await makeForge(root, SPEC);
    expect(await refusal(newProfileGate(await loadForge(root), home, "initech"))).toBe(
      `${root} is a tree of craftar's Forge cache — nothing is written there; clone the Forge and pass that directory`,
    );
    // A home whose forges/ does not exist yet: the check passes on to P6
    const other = await forgeRepo();
    await expect(newProfileGate(L(other), path.join(await scratch(), "nothing-yet"), "initech")).resolves.toBeUndefined();
  });
});

describe("newProfileGate — P7 and P8 (a name)", () => {
  it("P7: a profile of that name exists — by its name, even in another directory", async () => {
    const root = await forgeRepo({ spec: { ...SPEC, profiles: [profile("acme", ["base"])] } });
    const forge = await loadForge(root);
    expect(await refusal(newProfileGate(forge, await scratch(), "acme"))).toBe("profile acme already exists in the Forge — use --profile acme");
    const r2 = await forgeRepo({ spec: { ...SPEC, profiles: [{ name: "initech", recipes: ["base"] }] } });
    await fs.rename(path.join(r2, "profiles", "initech"), path.join(r2, "profiles", "old"));
    expect(await refusal(newProfileGate(L(r2), await scratch(), "initech"))).toBe("profile initech already exists in the Forge — use --profile initech");
  });
  it("P7: profiles/<name> exists and holds no such profile — an empty directory, a regular file, another case", async () => {
    const msg = (found: string) => `profiles/${found} already exists in the Forge and holds no profile named initech — pick another name, or remove it`;
    const r1 = await forgeRepo();
    await fs.mkdir(path.join(r1, "profiles", "initech"));
    expect(await refusal(newProfileGate(L(r1), await scratch(), "initech"))).toBe(msg("initech"));
    const r2 = await forgeRepo();
    await fs.writeFile(path.join(r2, "profiles", "initech"), "a file\n");
    expect(await refusal(newProfileGate(L(r2), await scratch(), "initech"))).toBe(msg("initech"));
    const r3 = await forgeRepo();
    await fs.mkdir(path.join(r3, "profiles", "Initech"));
    expect(await refusal(newProfileGate(L(r3), await scratch(), "initech"))).toBe(msg("Initech"));
  });
  it("P8: git ignores profiles/<name>/profile.yaml", async () => {
    const root = await forgeRepo();
    await fs.writeFile(path.join(root, ".gitignore"), "profiles/initech/\n");
    expect(await refusal(newProfileGate(L(root), await scratch(), "initech"))).toBe("cannot create profiles/initech/profile.yaml: git ignores it");
  });
  it(`P8: profiles/<name> is a link — to a directory, dangling (${DIR_LINK}); links come before P7`, async () => {
    const r1 = await forgeRepo();
    const out = await scratch();
    await fs.symlink(out, path.join(r1, "profiles", "initech"), DIR_LINK);
    expect(await refusal(newProfileGate(L(r1), await scratch(), "initech"))).toBe(LINK_FILE("profiles/initech"));
    const r2 = await forgeRepo();
    await fs.symlink(path.join(r2, "gone"), path.join(r2, "profiles", "initech"), DIR_LINK);
    expect(await refusal(newProfileGate(L(r2), await scratch(), "initech"))).toBe(LINK_FILE("profiles/initech"));
  });
  it.skipIf(WIN)("P8: profiles/<name> is a link to a file — not run on Windows", async () => {
    const root = await forgeRepo();
    const out = await scratch();
    await fs.writeFile(path.join(out, "f"), "x");
    await fs.symlink(path.join(out, "f"), path.join(root, "profiles", "initech"), "file");
    expect(await refusal(newProfileGate(L(root), await scratch(), "initech"))).toBe(LINK_FILE("profiles/initech"));
  });
  it(`P8: profiles itself is a link (${DIR_LINK}) — the directory form, also when its target holds <name>`, async () => {
    for (const holds of [false, true]) {
      const root = await forgeRepo();
      const forge = await loadForge(root);
      const real = path.join(await scratch(), "profiles-real");
      await fs.rename(path.join(root, "profiles"), real);
      if (holds) await fs.mkdir(path.join(real, "initech"));
      await fs.symlink(real, path.join(root, "profiles"), DIR_LINK);
      expect(await refusal(newProfileGate(forge, await scratch(), "initech"))).toBe(LINK_DIR);
    }
  });
  it.skipIf(WIN)("a link named Initech against initech on a case-sensitive disk: P7, the path as found — not run on Windows", async () => {
    const root = await forgeRepo();
    await fs.symlink(await scratch(), path.join(root, "profiles", "Initech"), "dir");
    expect(await refusal(newProfileGate(L(root), await scratch(), "initech"))).toBe(
      "profiles/Initech already exists in the Forge and holds no profile named initech — pick another name, or remove it",
    );
  });
});
