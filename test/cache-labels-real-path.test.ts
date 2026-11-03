import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isUnderOrEqual, shownByRealPath, UNVOUCHED_HIDDEN } from "../src/core/remote.js";
import { loadForgeSource } from "../src/core/sync.js";
import { loadForge } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, profile, recipe, rule, tmpDir } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";

// A path under craftar's Forge cache is labelled by where it lands, not by how it was typed: a home reached through a link
// (a third spelling), a part that does not resolve, a relative spelling. The entry's name is token-shaped and assembled at
// runtime; directory links are junctions, so these run on Windows too.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const slug = () => "https-user-" + "ghp_" + "Q".repeat(36) + "-host";

async function fixture() {
  const entry = slug();
  const parent = await fs.realpath(await tmpDir("craftar-cache-labels-"));
  cleanups.push(() => removeWithRetry(parent));
  const home = path.join(parent, "home");
  await fs.mkdir(path.join(home, "forges", entry, "trees", "abc"), { recursive: true });
  const link = path.join(parent, "link");
  await fs.symlink(home, link, "junction");
  return { entry, parent, home, link };
}

describe("shownByRealPath", () => {
  it("a path under the cache, typed as the home is given: the entry labelled", async () => {
    const { entry, home } = await fixture();
    const shown = await shownByRealPath(path.join(home, "forges", entry, "trees", "abc", "x"), home);
    expect(shown).toBe(path.join(home, "forges", UNVOUCHED_HIDDEN, "trees", "abc", "x"));
  });

  it("through a third spelling of the home, and past a part that does not exist: the entry labelled", async () => {
    const { entry, home, link } = await fixture();
    const shown = await shownByRealPath(path.join(link, "forges", entry, "trees", "abc", "no", "such"), home);
    expect(shown).toBe(path.join(home, "forges", UNVOUCHED_HIDDEN, "trees", "abc", "no", "such"));
  });

  it("an entry that is itself a dangling link: labelled from the side that does not resolve", async () => {
    const { entry, parent, home, link } = await fixture();
    const other = entry + "-2";
    await fs.symlink(path.join(parent, "nowhere"), path.join(home, "forges", other), "junction");
    const shown = await shownByRealPath(path.join(link, "forges", other, "trees"), home);
    expect(shown).not.toContain(other);
    expect(shown).toBe(path.join(home, "forges", UNVOUCHED_HIDDEN, "trees"));
  });

  it("the cache's forges/ itself is shown as the home's", async () => {
    const { home, link } = await fixture();
    expect(await shownByRealPath(path.join(link, "forges"), home)).toBe(path.join(home, "forges"));
  });

  it("a folder named forges elsewhere, and a path outside the home, are returned as given", async () => {
    const { parent, home } = await fixture();
    const elsewhere = path.join(parent, "work", "forges", "kept", "x");
    expect(await shownByRealPath(elsewhere, home)).toBe(elsewhere);
    expect(await shownByRealPath("relative/forges/kept", home)).toBe("relative/forges/kept");
  });

  it("a home with no forges/ yet: a path under where it would be is labelled", async () => {
    const { entry, parent } = await fixture();
    const bare = path.join(parent, "bare");
    await fs.mkdir(bare);
    expect(await shownByRealPath(path.join(bare, "forges", entry, "x"), bare)).toBe(path.join(bare, "forges", UNVOUCHED_HIDDEN, "x"));
  });
});

describe("isUnderOrEqual folds case only where it is asked to", () => {
  it.skipIf(process.platform === "win32")("off win32 the default compares with case; darwin and win32 fold", () => {
    const parent = path.resolve("/Data/Forge");
    const child = path.resolve("/data/forge/report.md");
    expect(isUnderOrEqual(child, parent)).toBe(false);
    expect(isUnderOrEqual(child, parent, "linux")).toBe(false);
    expect(isUnderOrEqual(child, parent, "darwin")).toBe(true);
    expect(isUnderOrEqual(child, parent, "win32")).toBe(true);
    expect(isUnderOrEqual(path.resolve("/data/forge2/x"), parent, "darwin")).toBe(false);
  });
});

describe("a Forge path under the cache in `not a Forge` and `Forge not found` (E34.1)", () => {
  it("not a Forge: the entry labelled, typed through the link or as the home is given", async () => {
    const { entry, home, link } = await fixture();
    for (const typed of [path.join(link, "forges", entry), path.join(home, "forges", entry)]) {
      const err = await loadForge(typed, { home }).then(() => null, (e: Error) => e);
      expect(err?.message).toMatch(/^not a Forge: .* not found$/);
      expect(err!.message).not.toContain(entry);
      expect(err!.message).toContain(UNVOUCHED_HIDDEN);
    }
  });

  it("Forge not found at: the entry labelled; a folder named forges elsewhere keeps its name", async () => {
    const { entry, parent, home, link } = await fixture();
    const ws = path.join(parent, "ws");
    await fs.mkdir(ws);
    for (const source of [path.join(link, "forges", entry, "trees", "missing"), path.join(home, "forges", entry, "missing")]) {
      const err = await loadForgeSource(ws, source, null, { home, mode: "no-fetch" }).then(() => null, (e: Error) => e);
      expect(err?.message).toMatch(/^Forge not found at /);
      expect(err!.message).not.toContain(entry);
      expect(err!.message).toContain(UNVOUCHED_HIDDEN);
    }
    const elsewhere = path.join(parent, "work", "forges", "kept");
    const err = await loadForgeSource(ws, elsewhere, null, { home, mode: "no-fetch" }).then(() => null, (e: Error) => e);
    expect(err?.message).toBe(`Forge not found at ${elsewhere}`);
  });

  it("a committed craftar.yaml naming the Forge through the link: `craftar status` prints no entry name", async () => {
    const { entry, parent, home, link } = await fixture();
    const ws = path.join(parent, "ws");
    await fs.mkdir(ws);
    const forge = path.join(parent, "forge");
    await makeForge(forge, { ingredients: [rule("hello", "hello\n")], recipes: [recipe("base", ["rule/hello"])], profiles: [profile("acme", ["base"])] });
    for (const named of [path.join(link, "forges", entry, "trees", "missing"), path.join(link, "forges", entry)]) {
      await fs.writeFile(path.join(ws, "craftar.yaml"), `forge: ${named.replace(/\\/g, "/")}\nprofile: acme\n`);
      const r = runCli(["status", "--workspace", ws], { env: { CRAFTAR_HOME: home } });
      expect(r.code).toBe(1);
      expect(r.stdout + r.stderr).not.toContain(entry);
      expect(r.stderr).toContain(UNVOUCHED_HIDDEN);
    }
  });
});
