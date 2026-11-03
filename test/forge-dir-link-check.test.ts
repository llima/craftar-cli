import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { assertNoDirLinkIn } from "../src/core/forge.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";

// E34.2d: a file listed, then gone before its lstat (a narrow race), is not a raw ENOENT.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});

describe("assertNoDirLinkIn", () => {
  it("skips a file that vanished between the listing and its lstat", async () => {
    const root = await tmpDir("craftar-dirlink-");
    cleanups.push(() => removeWithRetry(root));
    const dir = path.join(root, "ingredients/rules/x");
    await writeFiles(dir, { "ingredient.yaml": "type: rule\nname: x\n", "gone.md": "x\n" });
    const real = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(((p: Parameters<typeof fs.lstat>[0], o?: Parameters<typeof fs.lstat>[1]) => {
      if (String(p).endsWith("gone.md")) return Promise.reject(Object.assign(new Error("ENOENT: gone"), { code: "ENOENT" }));
      return real(p, o as never);
    }) as typeof fs.lstat);
    await expect(assertNoDirLinkIn(root, dir, "forge promote")).resolves.toBeUndefined();
  });

  it("still refuses a link to a directory, naming it", async () => {
    const root = await tmpDir("craftar-dirlink-");
    cleanups.push(() => removeWithRetry(root));
    const dir = path.join(root, "ingredients/rules/x");
    await writeFiles(dir, { "ingredient.yaml": "type: rule\nname: x\n" });
    await fs.mkdir(path.join(root, "elsewhere"));
    await fs.symlink(path.join(root, "elsewhere"), path.join(dir, "sub"), "junction");
    await expect(assertNoDirLinkIn(root, dir, "forge promote")).rejects.toThrow("ingredients/rules/x/sub is a symbolic link to a directory in the Forge");
  });
});
