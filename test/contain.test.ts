import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  containRoot,
  escapeLine,
  escapeOf,
  escapeRefusal,
  escapeSummary,
  escapingPaths,
  forgeReader,
  readForgeFile,
  readForgeText,
} from "../src/core/contain.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});
async function scratch() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "craftar-contain-")));
  dirs.push(base);
  const tree = path.join(base, "tree");
  const outside = path.join(base, "private-outside");
  await fs.mkdir(tree);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "OUTSIDE-CONTENT");
  return { base, tree, outside, secret: path.join(outside, "secret.txt") };
}
const posixOnly = it.skipIf(process.platform === "win32");

describe("escapeOf", () => {
  it("is null for a tree with no link and for a new file", async () => {
    const { tree } = await scratch();
    await fs.mkdir(path.join(tree, "a"));
    await fs.writeFile(path.join(tree, "a/f"), "x");
    const root = await containRoot(tree);
    expect(await escapeOf(root, path.join(tree, "a/f"))).toBeNull();
    expect(await escapeOf(root, path.join(tree, "a/new"))).toBeNull();
    expect(await escapeOf(root, path.join(tree, "no/such/dir/new"))).toBeNull();
  });

  it("is null for a directory link inside, a new file under it included", async () => {
    const { tree } = await scratch();
    await fs.mkdir(path.join(tree, "real"));
    await fs.symlink(path.join(tree, "real"), path.join(tree, "link"), "junction");
    const root = await containRoot(tree);
    expect(await escapeOf(root, path.join(tree, "link/new"))).toBeNull();
  });

  it("is leaves for a directory link out, and for a new file under it", async () => {
    const { tree, outside } = await scratch();
    await fs.symlink(outside, path.join(tree, "link"), "junction");
    const root = await containRoot(tree);
    expect(await escapeOf(root, path.join(tree, "link"))).toBe("leaves");
    expect(await escapeOf(root, path.join(tree, "link/new"))).toBe("leaves");
  });

  posixOnly("is leaves for a file link out, and for two steps, one inside and one leading out", async () => {
    const { tree, secret } = await scratch();
    await fs.symlink(secret, path.join(tree, "one"));
    await fs.symlink(path.join(tree, "one"), path.join(tree, "two"));
    const root = await containRoot(tree);
    expect(await escapeOf(root, path.join(tree, "one"))).toBe("leaves");
    expect(await escapeOf(root, path.join(tree, "two"))).toBe("leaves");
  });

  posixOnly("is unresolved for a dangling link, wherever it points, and for a loop", async () => {
    const { tree, outside } = await scratch();
    await fs.symlink(path.join(tree, "gone"), path.join(tree, "in"));
    await fs.symlink(path.join(outside, "gone"), path.join(tree, "out"));
    await fs.symlink(path.join(tree, "b"), path.join(tree, "a"));
    await fs.symlink(path.join(tree, "a"), path.join(tree, "b"));
    const root = await containRoot(tree);
    expect(await escapeOf(root, path.join(tree, "in"))).toBe("unresolved");
    expect(await escapeOf(root, path.join(tree, "out"))).toBe("unresolved");
    expect(await escapeOf(root, path.join(tree, "a"))).toBe("unresolved");
    expect(await escapeOf(root, path.join(tree, "a/under"))).toBe("unresolved");
  });

  it("is git for a link into the top-level .git, and not for another .git", async () => {
    const { tree } = await scratch();
    await fs.mkdir(path.join(tree, ".git/hooks"), { recursive: true });
    await fs.mkdir(path.join(tree, "sub/.git"), { recursive: true });
    await fs.symlink(path.join(tree, ".git/hooks"), path.join(tree, "hooks"), "junction");
    await fs.symlink(path.join(tree, "sub/.git"), path.join(tree, "other"), "junction");
    const root = await containRoot(tree);
    expect(await escapeOf(root, path.join(tree, "hooks/x"))).toBe("git");
    expect(await escapeOf(root, path.join(tree, "other/x"))).toBeNull();
    // A name that starts like it is no such path.
    await fs.mkdir(path.join(tree, ".gitx"));
    await fs.symlink(path.join(tree, ".gitx"), path.join(tree, "gitx"), "junction");
    expect(await escapeOf(root, path.join(tree, "gitx/y"))).toBeNull();
  });

  it("keeps a name that starts with two dots inside", async () => {
    const { tree } = await scratch();
    await fs.mkdir(path.join(tree, "..notes"));
    await fs.symlink(path.join(tree, "..notes"), path.join(tree, "n"), "junction");
    expect(await escapeOf(await containRoot(tree), path.join(tree, "n/f"))).toBeNull();
  });

  it("takes a root reached through a link by its real path", async () => {
    const { base, tree, outside } = await scratch();
    const viaLink = path.join(base, "via");
    await fs.symlink(tree, viaLink, "junction");
    await fs.mkdir(path.join(tree, "real"));
    await fs.symlink(path.join(tree, "real"), path.join(tree, "in"), "junction");
    await fs.symlink(outside, path.join(tree, "out"), "junction");
    const root = await containRoot(viaLink);
    expect(await escapeOf(root, path.join(viaLink, "in/f"))).toBeNull();
    expect(await escapeOf(root, path.join(viaLink, "out/f"))).toBe("leaves");
    expect(await escapeOf(root, path.join(viaLink, "plain"))).toBeNull();
  });

  it("says leaves for a path that climbs out with no link", async () => {
    const { tree, secret } = await scratch();
    expect(await escapeOf(await containRoot(tree), secret)).toBe("leaves");
  });

  it.skipIf(process.platform !== "win32")("compares without case on win32", async () => {
    const { tree } = await scratch();
    await fs.mkdir(path.join(tree, "real"));
    await fs.symlink(path.join(tree, "real"), path.join(tree, "link"), "junction");
    expect(await escapeOf(await containRoot(tree.toUpperCase()), path.join(tree, "link/f"))).toBeNull();
  });
});

describe("escapingPaths", () => {
  it("answers each escaping path once, in order, and costs one lstat per component shared", async () => {
    const { tree, outside } = await scratch();
    await fs.symlink(outside, path.join(tree, "out"), "junction");
    await fs.mkdir(path.join(tree, "fine"));
    const root = await containRoot(tree);
    expect(await escapingPaths(root, ["fine/a", "out/b", "fine/c", "out/d"])).toEqual([
      { path: "out/b", escapes: "leaves" },
      { path: "out/d", escapes: "leaves" },
    ]);
  });
});

describe("the one wording", () => {
  it("has a form for each answer", () => {
    expect(escapeLine(".claude/rules/r.md", "leaves")).toBe(
      ".claude/rules/r.md leaves the workspace through a symbolic link — craftar does not write there; replace the link with a directory or a file inside the workspace",
    );
    expect(escapeLine(".claude/rules/r.md", "unresolved")).toBe(".claude/rules/r.md is a symbolic link that leads nowhere — fix or remove it");
    expect(escapeLine(".claude/rules/r.md", "git")).toBe(".claude/rules/r.md is a symbolic link into the workspace's .git — craftar does not follow it; replace it");
  });
  it("makes one line of a summary, and one line per path of a refusal", () => {
    const rows = [{ path: "a", escapes: "leaves" as const }, { path: "b", escapes: "git" as const }];
    expect(escapeSummary(rows)).toBe(`${escapeLine("a", "leaves")} (and 1 more)`);
    expect(escapeSummary(rows.slice(0, 1))).toBe(escapeLine("a", "leaves"));
    expect(escapeRefusal(rows)).toEqual([escapeLine("a", "leaves"), escapeLine("b", "git")]);
  });
});

describe("readForgeFile", () => {
  const noTarget = (msg: string, secret: string) => {
    expect(msg).not.toContain(secret);
    expect(msg).not.toContain("private-outside");
    expect(msg).not.toContain("OUTSIDE-CONTENT");
  };
  const failure = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a refusal"); }, (e: Error) => e.message);

  it("reads a plain file and a file behind a directory link inside", async () => {
    const { tree } = await scratch();
    await fs.mkdir(path.join(tree, "real"));
    await fs.writeFile(path.join(tree, "real/f"), "body");
    await fs.symlink(path.join(tree, "real"), path.join(tree, "link"), "junction");
    const root = await containRoot(tree);
    expect((await readForgeFile(root, path.join(tree, "real/f"))).toString()).toBe("body");
    expect(await readForgeText(root, path.join(tree, "link/f"))).toBe("body");
  });

  posixOnly("reads a file link inside", async () => {
    const { tree } = await scratch();
    await fs.writeFile(path.join(tree, "f"), "body");
    await fs.symlink(path.join(tree, "f"), path.join(tree, "l"));
    expect(await readForgeText(await containRoot(tree), path.join(tree, "l"))).toBe("body");
  });

  it("keeps a missing file the ENOENT it is", async () => {
    const { tree } = await scratch();
    await expect(readForgeFile(await containRoot(tree), path.join(tree, "nope"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  posixOnly("refuses a link out, naming the path and never the target", async () => {
    const { tree, secret } = await scratch();
    await fs.symlink(secret, path.join(tree, "l.md"));
    const msg = await failure(readForgeFile(await containRoot(tree), path.join(tree, "l.md")));
    expect(msg).toBe("l.md: a symbolic link out of the Forge — craftar does not read it; replace it with a file inside the Forge");
    noTarget(msg, secret);
  });

  it("refuses a file behind a directory link out", async () => {
    const { tree, outside, secret } = await scratch();
    await fs.symlink(outside, path.join(tree, "d"), "junction");
    const msg = await failure(readForgeText(await containRoot(tree), path.join(tree, "d/secret.txt")));
    expect(msg).toBe("d/secret.txt: a symbolic link out of the Forge — craftar does not read it; replace it with a file inside the Forge");
    noTarget(msg, secret);
  });

  it("says outside the Forge for a path that climbs out with no link", async () => {
    const { tree, secret } = await scratch();
    const msg = await failure(readForgeFile(await containRoot(tree), secret));
    expect(msg).toContain(": outside the Forge — craftar does not read it");
    expect(msg).not.toContain("OUTSIDE-CONTENT");
  });

  it("refuses a link into .git", async () => {
    const { tree } = await scratch();
    await fs.mkdir(path.join(tree, ".git"));
    await fs.writeFile(path.join(tree, ".git/config"), "[remote]");
    await fs.symlink(path.join(tree, ".git"), path.join(tree, "g"), "junction");
    expect(await failure(readForgeFile(await containRoot(tree), path.join(tree, "g/config")))).toBe(
      "g/config: a symbolic link into the Forge's .git — craftar does not read it; replace it with a file",
    );
  });

  posixOnly("refuses a dangling link and a loop", async () => {
    const { tree, outside } = await scratch();
    await fs.symlink(path.join(outside, "gone"), path.join(tree, "d"));
    await fs.symlink(path.join(tree, "l2"), path.join(tree, "l1"));
    await fs.symlink(path.join(tree, "l1"), path.join(tree, "l2"));
    const root = await containRoot(tree);
    expect(await failure(readForgeFile(root, path.join(tree, "d")))).toBe("d: a symbolic link that leads nowhere — fix or remove it");
    expect(await failure(readForgeFile(root, path.join(tree, "l1")))).toBe("l1: a symbolic link that leads nowhere — fix or remove it");
  });

  it("refuses a link to a directory, even inside", async () => {
    const { tree } = await scratch();
    await fs.mkdir(path.join(tree, "real"));
    await fs.symlink(path.join(tree, "real"), path.join(tree, "d"), "junction");
    expect(await failure(readForgeFile(await containRoot(tree), path.join(tree, "d")))).toBe(
      "d: a link to a directory — craftar does not follow it inside an ingredient; replace it with the files",
    );
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO before the open that would block", { timeout: 5000 }, async () => {
    const { tree } = await scratch();
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [path.join(tree, "p")]);
    expect(await failure(readForgeFile(await containRoot(tree), path.join(tree, "p")))).toBe("p: not a regular file — craftar does not read it; remove it");
  });

  it("forgeReader reads through the same check and lists as listFiles does", async () => {
    const { tree, outside } = await scratch();
    await fs.mkdir(path.join(tree, "ing"));
    await fs.writeFile(path.join(tree, "ing/a"), "A");
    await fs.symlink(outside, path.join(tree, "d"), "junction");
    const io = forgeReader(await containRoot(tree));
    expect(await io.readText(path.join(tree, "ing/a"))).toBe("A");
    expect((await io.readBytes(path.join(tree, "ing/a"))).toString()).toBe("A");
    expect(await io.list(path.join(tree, "ing"))).toEqual(["a"]);
    await expect(io.readBytes(path.join(tree, "d/secret.txt"))).rejects.toThrow("a symbolic link out of the Forge");
  });
});
