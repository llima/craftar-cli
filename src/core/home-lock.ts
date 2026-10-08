import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** `$CRAFTAR_HOME` as given (a relative one resolves from the current directory), else `~/.craftar` — the one default. */
export function resolveHome(home?: string): string {
  return path.resolve(home || path.join(os.homedir(), ".craftar"));
}

/** How long a busy lock is waited for (60 s), how often it is polled, when it is stale (10 min). */
export interface LockTiming {
  waitMs?: number;
  pollMs?: number;
  staleMs?: number;
}

/** Lock options, extending timing with behavior for directory creation. */
export interface LockOptions extends LockTiming {
  /**
   * When true, `mkdir -p` is run on the lock file's directory before each exclusive-write attempt,
   * and an ENOENT from that write is retried (the directory was removed between the mkdir and the
   * write) while the wait (`waitMs`) has not run out; once it has, the ENOENT is rethrown.
   * Acquisition only: the body is never retried.
   */
  createDir?: boolean;
  /**
   * Test hook: awaited before each exclusive write (after the mkdir when `createDir`).
   * Exists for tests (spec 26 §9's third ordering).
   */
  beforeAttempt?: () => Promise<void>;
}

/** Thrown when a lock is busy and the wait has run out. */
export class LockBusyError extends Error {
  readonly holder: string;
  constructor(message: string, holder: string) {
    super(message);
    this.name = "LockBusyError";
    this.holder = holder;
  }
}

/**
 * A lock under `$CRAFTAR_HOME` (spec 13 §6.3, spec 21 §6.2): `file` is created exclusively, holding
 * the PID and a timestamp; a busy one is waited for, then refused naming `label` and the holder; a
 * stale one is taken over. The directory holding `file` must exist unless `createDir` is set, which
 * re-creates it on each attempt.
 */
export async function withLock<T>(file: string, label: string, timing: LockOptions, body: () => Promise<T>): Promise<T> {
  const waitMs = timing.waitMs ?? 60_000;
  const pollMs = timing.pollMs ?? 200;
  const staleMs = timing.staleMs ?? 10 * 60 * 1000;
  const start = Date.now();
  for (;;) {
    try {
      if (timing.createDir) await fs.mkdir(path.dirname(file), { recursive: true });
      if (timing.beforeAttempt) await timing.beforeAttempt();
      await fs.writeFile(file, `${process.pid} ${new Date().toISOString()}\n`, { flag: "wx" });
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // ENOENT under createDir: the directory was removed between mkdir and wx; retry within the wait.
      if (code === "ENOENT" && timing.createDir) {
        if (Date.now() - start >= waitMs) throw e;
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      if (code !== "EEXIST") throw e;
      const stat = await fs.stat(file).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        await fs.rm(file, { force: true });
        continue;
      }
      if (Date.now() - start >= waitMs) {
        const held = (await fs.readFile(file, "utf8").catch(() => "")).split(/\s+/)[0] || "unknown";
        throw new LockBusyError(`${label} ${file} is busy (held by PID ${held})`, held);
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
