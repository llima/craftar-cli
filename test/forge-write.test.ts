import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeForgeFile } from "../src/core/forge-write.js";

const win = process.platform === "win32";
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-forge-write-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const leftovers = async (dir: string) => (await fs.readdir(dir)).filter((n) => n.includes(".craftar-") && n.endsWith(".tmp"));

describe("writeForgeFile (tech-debt L2a: E9.1, E1.1)", () => {
  it("creates a missing file and its parent directories, leaving no temporary file", async () => {
    const abs = path.join(tmp, "a", "b", "f.md");
    await writeForgeFile(abs, "hello\n");
    expect(await fs.readFile(abs, "utf8")).toBe("hello\n");
    expect(await leftovers(path.dirname(abs))).toEqual([]);
  });

  it("writes a Buffer byte for byte", async () => {
    const abs = path.join(tmp, "bin");
    const bytes = Buffer.from([0, 0xff, 0x0d, 0x0a, 0xc3]);
    await writeForgeFile(abs, bytes);
    expect((await fs.readFile(abs)).equals(bytes)).toBe(true);
  });

  it("does not write through a hard link: the other name keeps its bytes", async () => {
    const outside = path.join(tmp, "outside.txt");
    await fs.writeFile(outside, "private\n");
    const abs = path.join(tmp, "forge", "rule.md");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.link(outside, abs);
    await writeForgeFile(abs, "new\n");
    expect(await fs.readFile(abs, "utf8")).toBe("new\n");
    expect(await fs.readFile(outside, "utf8")).toBe("private\n");
  });

  it.skipIf(win)("keeps the mode of the file it replaces", async () => {
    const abs = path.join(tmp, "run.sh");
    await fs.writeFile(abs, "old\n");
    await fs.chmod(abs, 0o755);
    await writeForgeFile(abs, "new\n");
    expect((await fs.stat(abs)).mode & 0o777).toBe(0o755);
  });

  it.skipIf(win)("applies an explicit mode, on a new file and over an existing one", async () => {
    const created = path.join(tmp, "new.sh");
    await writeForgeFile(created, "x\n", { mode: 0o755 });
    expect((await fs.stat(created)).mode & 0o777).toBe(0o755);
    const existing = path.join(tmp, "old.sh");
    await fs.writeFile(existing, "y\n");
    await fs.chmod(existing, 0o600);
    await writeForgeFile(existing, "z\n", { mode: 0o750 });
    expect((await fs.stat(existing)).mode & 0o777).toBe(0o750);
  });

  it("a failed rename leaves the target as it was and removes the temporary file", async () => {
    const abs = path.join(tmp, "f.md");
    await fs.writeFile(abs, "before\n");
    const failing = async () => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    };
    await expect(writeForgeFile(abs, "after\n", {}, { rename: failing })).rejects.toThrow("disk full");
    expect(await fs.readFile(abs, "utf8")).toBe("before\n");
    expect(await leftovers(tmp)).toEqual([]);
  });

  it.skipIf(win || asRoot)("a temporary file that cannot be written leaves the target as it was", async () => {
    const dir = path.join(tmp, "ro");
    await fs.mkdir(dir);
    const abs = path.join(dir, "f.md");
    await fs.writeFile(abs, "before\n");
    await fs.chmod(dir, 0o555);
    try {
      await expect(writeForgeFile(abs, "after\n")).rejects.toThrow();
      expect(await fs.readFile(abs, "utf8")).toBe("before\n");
    } finally {
      await fs.chmod(dir, 0o755);
    }
    expect(await leftovers(dir)).toEqual([]);
  });

  it("on win32 a rename refused with EPERM, EACCES or EBUSY is retried until it lands", async () => {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      const abs = path.join(tmp, `f-${code}.md`);
      await fs.writeFile(abs, "before\n");
      let calls = 0;
      const flaky = async (from: string, to: string) => {
        calls++;
        if (calls < 3) throw Object.assign(new Error(code), { code });
        await fs.rename(from, to);
      };
      await writeForgeFile(abs, "after\n", {}, { rename: flaky, platform: "win32", retryMs: 1_000, pollMs: 1 });
      expect(calls).toBe(3);
      expect(await fs.readFile(abs, "utf8")).toBe("after\n");
    }
    expect(await leftovers(tmp)).toEqual([]);
  });

  it("on win32 the retry gives up after its wait and rethrows, the target intact", async () => {
    const abs = path.join(tmp, "f.md");
    await fs.writeFile(abs, "before\n");
    const busy = async () => {
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    };
    await expect(writeForgeFile(abs, "after\n", {}, { rename: busy, platform: "win32", retryMs: 20, pollMs: 5 })).rejects.toThrow("busy");
    expect(await fs.readFile(abs, "utf8")).toBe("before\n");
    expect(await leftovers(tmp)).toEqual([]);
  });

  it("off win32 an EPERM from the rename is not retried", async () => {
    const abs = path.join(tmp, "f.md");
    await fs.writeFile(abs, "before\n");
    let calls = 0;
    const eperm = async () => {
      calls++;
      throw Object.assign(new Error("eperm"), { code: "EPERM" });
    };
    await expect(writeForgeFile(abs, "after\n", {}, { rename: eperm, platform: "linux", retryMs: 1_000, pollMs: 1 })).rejects.toThrow("eperm");
    expect(calls).toBe(1);
  });
});
