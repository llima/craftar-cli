import { promises as fs } from "node:fs";

/** How long a busy lock is waited for (60 s), how often it is polled, when it is stale (10 min). */
export interface LockTiming {
  waitMs?: number;
  pollMs?: number;
  staleMs?: number;
}

/**
 * A lock under `$CRAFTAR_HOME` (spec 13 §6.3, spec 21 §6.2): `file` is created exclusively, holding
 * the PID and a timestamp; a busy one is waited for, then refused naming `label` and the holder; a
 * stale one is taken over. The directory holding `file` must exist — a `wx` write into a missing
 * directory throws ENOENT, which is rethrown.
 */
export async function withLock<T>(file: string, label: string, timing: LockTiming, body: () => Promise<T>): Promise<T> {
  const waitMs = timing.waitMs ?? 60_000;
  const pollMs = timing.pollMs ?? 200;
  const staleMs = timing.staleMs ?? 10 * 60 * 1000;
  const start = Date.now();
  for (;;) {
    try {
      await fs.writeFile(file, `${process.pid} ${new Date().toISOString()}\n`, { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const stat = await fs.stat(file).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        await fs.rm(file, { force: true });
        continue;
      }
      if (Date.now() - start >= waitMs) {
        const held = (await fs.readFile(file, "utf8").catch(() => "")).split(/\s+/)[0] || "unknown";
        throw new Error(`${label} ${file} is busy (held by PID ${held})`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  try {
    return await body();
  } finally {
    await fs.rm(file, { force: true });
  }
}
