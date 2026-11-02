import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { assertNoLinkIn } from "../src/core/forge.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";

/**
 * Spec 51 §5: `forge localize` and `forge share` refuse ANY symbolic link inside the ingredient they move, before the
 * proof — the scratch copy turns a file link into a plain file, so the proof would pass and the moved link would then
 * fail every plan of that profile. The message names the link's Forge-relative path, never its target.
 */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

const SECRET = "private-target-do-not-print";

async function forge(): Promise<{ root: string; dir: string; outside: string }> {
  const base = await tmpDir("craftar-move-links-");
  roots.push(base);
  const root = path.join(base, "forge");
  const outside = path.join(base, SECRET);
  await writeFiles(root, { "ingredients/rules/x/ingredient.yaml": "type: rule\nname: x\n", "ingredients/rules/x/rule.md": "# X\n", "shared/body.md": "# shared\n" });
  await writeFiles(outside, { "f.md": "secret\n" });
  return { root, dir: path.join(root, "ingredients/rules/x"), outside };
}

describe("assertNoLinkIn (spec 51 §5)", () => {
  it("passes an ingredient that holds no link", async () => {
    const f = await forge();
    await expect(assertNoLinkIn(f.root, f.dir, "forge localize")).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("refuses a file link that stays inside the Forge, naming the link and never its target", async () => {
    const f = await forge();
    await fs.symlink(path.join(f.root, "shared/body.md"), path.join(f.dir, "extra.md"));
    const e = await assertNoLinkIn(f.root, f.dir, "forge localize").catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe("ingredients/rules/x/extra.md is a symbolic link in the Forge — forge localize does not move a link; replace it with the file and commit");
    expect((e as Error).message).not.toContain("shared");
  });

  it.skipIf(process.platform === "win32")("refuses a file link out of the Forge, printing no target", async () => {
    const f = await forge();
    await fs.symlink(path.join(f.outside, "f.md"), path.join(f.dir, "out.md"));
    const e = (await assertNoLinkIn(f.root, f.dir, "forge share").catch((x: Error) => x)) as Error;
    expect(e.message).toContain("ingredients/rules/x/out.md is a symbolic link in the Forge — forge share does not move a link");
    expect(e.message).not.toContain(SECRET);
  });

  it.skipIf(process.platform === "win32")("refuses a dangling link", async () => {
    const f = await forge();
    await fs.symlink(path.join(f.root, "nowhere.md"), path.join(f.dir, "gone.md"));
    await expect(assertNoLinkIn(f.root, f.dir, "forge localize")).rejects.toThrow("ingredients/rules/x/gone.md is a symbolic link in the Forge");
  });

  it("refuses a directory link (a junction on Windows) deeper in the ingredient, printing no target", async () => {
    const f = await forge();
    await fs.mkdir(path.join(f.dir, "sub"));
    await fs.symlink(f.outside, path.join(f.dir, "sub", "linked"), "junction");
    const e = (await assertNoLinkIn(f.root, f.dir, "forge localize").catch((x: Error) => x)) as Error;
    expect(e.message).toContain("ingredients/rules/x/sub/linked is a symbolic link in the Forge — forge localize does not move a link");
    expect(e.message).not.toContain(SECRET);
  });

  it("refuses the ingredient's folder itself when it is a link (a junction on Windows)", async () => {
    const f = await forge();
    const real = path.join(path.dirname(f.root), "real-y");
    await writeFiles(real, { "ingredient.yaml": "type: rule\nname: y\n", "rule.md": "# Y\n" });
    const linked = path.join(f.root, "ingredients/rules/y");
    await fs.symlink(real, linked, "junction");
    const e = (await assertNoLinkIn(f.root, linked, "forge localize").catch((x: Error) => x)) as Error;
    expect(e.message).toContain("ingredients/rules/y is a symbolic link in the Forge — forge localize does not move a link");
    expect(e.message).not.toContain("real-y");
  });

  it("an unreadable folder is said in the command's words", async () => {
    const f = await forge();
    await expect(assertNoLinkIn(f.root, path.join(f.root, "ingredients/rules/missing"), "forge localize")).rejects.toThrow("forge localize: cannot read ingredients/rules/missing (ENOENT)");
  });
});
