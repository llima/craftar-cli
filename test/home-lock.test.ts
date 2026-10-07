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
});
