import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withLock } from "../src/core/home-lock.js";
import { tmpDir } from "./helpers/forge.js";

// The lock shared by the Forge cache and the workspace registry (spec 21 §5.4, §6.2).
describe("withLock", () => {
  it("a busy lock is waited for, then refused naming the label, the file and the holder", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "registry.lock");
    await fs.writeFile(file, "4242 2026-10-07T00:00:00.000Z\n");
    await expect(withLock(file, "the workspace registry", { waitMs: 300, pollMs: 50 }, async () => "ran")).rejects.toThrow(
      `the workspace registry ${file} is busy (held by PID 4242)`,
    );
  });

  it("a stale lock is taken over, and the lock is gone after the body", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "registry.lock");
    await fs.writeFile(file, "4242 2026-10-07T00:00:00.000Z\n");
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(file, old, old);
    expect(await withLock(file, "the workspace registry", { waitMs: 300, pollMs: 50, staleMs: 1_000 }, async () => "ran")).toBe("ran");
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("the lock is released when the body throws", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "registry.lock");
    await expect(withLock(file, "x", {}, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a lock in a missing directory fails with ENOENT instead of waiting", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "absent", "registry.lock");
    await expect(withLock(file, "x", { waitMs: 60_000 }, async () => "ran")).rejects.toMatchObject({ code: "ENOENT" });
  });

  // windows-latest once answered EPERM at the exclusive create as the holder released the lock (not
  // reproduced since). The hook stands in for that answer, so these cases run on every platform.
  const eperm = () => Object.assign(new Error("EPERM: operation not permitted, open"), { code: "EPERM" });

  it("win32: EPERM from the create is taken for the release still landing — retried, the body runs once", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "registry.lock");
    let attempts = 0;
    let bodies = 0;
    const out = await withLock(file, "x", { platform: "win32", pollMs: 10, beforeAttempt: async () => { if (++attempts <= 2) throw eperm(); } }, async () => {
      bodies++;
      return "ran";
    });
    expect([out, attempts, bodies]).toEqual(["ran", 3, 1]);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("win32: EPERM that lasts is a real refusal — rethrown once its own short wait runs out, whatever waitMs says", async () => {
    const dir = await tmpDir();
    let attempts = 0;
    const start = Date.now();
    const err = await withLock(path.join(dir, "registry.lock"), "x", { platform: "win32", waitMs: 60_000, pollMs: 10, pendingDeleteMs: 150, beforeAttempt: async () => { attempts++; throw eperm(); } }, async () => "ran").catch((e: NodeJS.ErrnoException) => e);
    const took = Date.now() - start;
    expect((err as NodeJS.ErrnoException).code).toBe("EPERM");
    expect(attempts).toBeGreaterThan(1);
    expect(took).toBeGreaterThanOrEqual(150);
    expect(took).toBeLessThan(5_000);
  });

  it("elsewhere EPERM is a refusal at once: one attempt, no wait", async () => {
    const dir = await tmpDir();
    for (const platform of ["linux", "darwin"] as const) {
      let attempts = 0;
      const err = await withLock(path.join(dir, "registry.lock"), "x", { platform, waitMs: 60_000, pollMs: 10, beforeAttempt: async () => { attempts++; throw eperm(); } }, async () => "ran").catch((e: NodeJS.ErrnoException) => e);
      expect([(err as NodeJS.ErrnoException).code, attempts]).toEqual(["EPERM", 1]);
    }
  });

  it("win32: a held lock seen between two EPERMs keeps its own wait and its own message", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "registry.lock");
    await fs.writeFile(file, "4242 2026-10-07T00:00:00.000Z\n");
    const now = new Date();
    await fs.utimes(file, now, now);
    let attempts = 0;
    // Odd attempts answer EPERM, even ones reach the real create and find the lock held.
    // The EPERM wait (100 ms) is shorter than the lock's (400 ms): were it not started over by each
    // EEXIST, the EPERM would be rethrown first.
    await expect(withLock(file, "the workspace registry", { platform: "win32", waitMs: 400, pollMs: 20, pendingDeleteMs: 100, beforeAttempt: async () => { if (++attempts % 2) throw eperm(); } }, async () => "ran")).rejects.toThrow(
      `the workspace registry ${file} is busy (held by PID 4242)`,
    );
  });

  it("win32: a missing directory seen between two EPERMs starts the EPERM wait over", async () => {
    const dir = await tmpDir();
    const entry = path.join(dir, "entry");
    let attempts = 0;
    const out = await withLock(path.join(entry, "lock"), "x", {
      platform: "win32",
      createDir: true,
      pollMs: 60,
      pendingDeleteMs: 50,
      // EPERM, then the directory gone at the write (ENOENT, retried), then EPERM again 120 ms after
      // the first — past the wait of the first, inside its own — then the lock.
      beforeAttempt: async () => {
        attempts++;
        if (attempts === 1 || attempts === 3) throw eperm();
        if (attempts === 2) await fs.rm(entry, { recursive: true, force: true });
      },
    }, async () => "ran");
    expect([out, attempts]).toEqual(["ran", 4]);
  });
});
