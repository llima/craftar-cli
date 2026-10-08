import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LockBusyError, withLock } from "../src/core/home-lock.js";
import { tmpDir } from "./helpers/forge.js";

// Spec 26 §4.3 / §5.1: the entry lock's acquisition re-creates its directory and retries ENOENT, acquisition only.
describe("withLock with createDir", () => {
  it("a lock in a missing directory: the directory is made, the body runs, the lock is gone after", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "entry", "lock");
    expect(await withLock(file, "x", { createDir: true }, async () => (await fs.readFile(file, "utf8")).split(" ")[0])).toBe(String(process.pid));
    expect(await fs.readdir(path.join(dir, "entry"))).toEqual([]);
  });

  it("the directory removed between the mkdir and the write: ENOENT is retried, the body runs once", async () => {
    const dir = await tmpDir();
    const entry = path.join(dir, "entry");
    let attempts = 0;
    let bodies = 0;
    const out = await withLock(
      path.join(entry, "lock"),
      "x",
      {
        createDir: true,
        pollMs: 10,
        beforeAttempt: async () => {
          attempts++;
          if (attempts === 1) await fs.rm(entry, { recursive: true, force: true });
        },
      },
      async () => {
        bodies++;
        return "ran";
      },
    );
    expect([out, attempts, bodies]).toEqual(["ran", 2, 1]);
  });

  it("a body that throws ENOENT is not retried", async () => {
    const dir = await tmpDir();
    let bodies = 0;
    const err = await withLock(path.join(dir, "entry", "lock"), "x", { createDir: true }, async () => {
      bodies++;
      await fs.readFile(path.join(dir, "absent.txt"));
    }).catch((e: NodeJS.ErrnoException) => e);
    expect([(err as NodeJS.ErrnoException).code, bodies]).toEqual(["ENOENT", 1]);
    await expect(fs.stat(path.join(dir, "entry", "lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("the retry is bounded by the wait: a directory removed before every attempt rethrows ENOENT", async () => {
    const dir = await tmpDir();
    const entry = path.join(dir, "entry");
    let attempts = 0;
    const started = Date.now();
    const err = await withLock(
      path.join(entry, "lock"),
      "x",
      {
        createDir: true,
        waitMs: 300,
        pollMs: 10,
        beforeAttempt: async () => {
          attempts++;
          await fs.rm(entry, { recursive: true, force: true });
        },
      },
      async () => "ran",
    ).catch((e: NodeJS.ErrnoException) => e);
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(attempts).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("a busy lock throws a LockBusyError naming the holder, with today's message", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "entry", "lock");
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, "4242 2026-10-08T00:00:00.000Z\n");
    const err = await withLock(file, "the Forge cache entry", { createDir: true, waitMs: 200, pollMs: 20 }, async () => "ran").catch((e) => e);
    expect(err).toBeInstanceOf(LockBusyError);
    expect([(err as LockBusyError).holder, (err as Error).message]).toEqual(["4242", `the Forge cache entry ${file} is busy (held by PID 4242)`]);
  });
});
