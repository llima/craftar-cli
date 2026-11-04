import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** How long a Windows rename refused by an open handle is retried before its error stands (2 s). */
const RENAME_RETRY_MS = 2_000;
/** The answers a Windows rename gives while another process holds the target open. */
const HELD_OPEN = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Test seams; production passes none. */
export interface ForgeWriteSeams {
  rename?: (from: string, to: string) => Promise<void>;
  platform?: NodeJS.Platform;
  retryMs?: number;
  pollMs?: number;
}

/**
 * Put one file of a Forge on disk (tech-debt L2a, E9.1 + E1.1): the content goes to a temporary sibling, created `wx`,
 * which is then renamed over the target, so the target is never left half-written and a hard link at the target is
 * replaced, never written through. The file keeps the mode of the file it replaces unless `mode` is given (a file a
 * Forge edit moves or copies takes its source's); off `win32` only — Windows has no mode to keep. On `win32` a rename
 * refused while another process holds the target open is retried for a short wait, then its error stands. The
 * temporary file is removed on every failure. Every Forge writer goes through here; a write that only creates
 * (`init --new-profile`'s `wx`) does not.
 */
export async function writeForgeFile(abs: string, content: string | Buffer, opts: { mode?: number } = {}, seams: ForgeWriteSeams = {}): Promise<void> {
  const windows = (seams.platform ?? process.platform) === "win32";
  const rename = seams.rename ?? fs.rename;
  const dir = path.dirname(abs);
  await fs.mkdir(dir, { recursive: true });
  let mode = opts.mode;
  if (mode === undefined && !windows) {
    try {
      mode = (await fs.stat(abs)).mode & 0o7777;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  const tmp = path.join(dir, `.${path.basename(abs)}.craftar-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  try {
    await fs.writeFile(tmp, content, { flag: "wx" });
    if (mode !== undefined && !windows) await fs.chmod(tmp, mode);
    const waitMs = seams.retryMs ?? RENAME_RETRY_MS;
    const pollMs = seams.pollMs ?? 50;
    const start = Date.now();
    for (;;) {
      try {
        await rename(tmp, abs);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? "";
        if (!windows || !HELD_OPEN.has(code) || Date.now() - start >= waitMs) throw e;
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}
