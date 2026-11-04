import { randomBytes } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
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
 * temporary file is removed on every failure, and a file that cannot be written in place is refused, not replaced. A symbolic link is written through, as
 * `writeFile` wrote through it. Every Forge writer goes through here; a write that only creates
 * (`init --new-profile`'s `wx`) does not.
 */
export async function writeForgeFile(target: string, content: string | Buffer, opts: { mode?: number } = {}, seams: ForgeWriteSeams = {}): Promise<void> {
  const windows = (seams.platform ?? process.platform) === "win32";
  const rename = seams.rename ?? fs.rename;
  // A symbolic link the caller let through (spec 48: one inside the Forge) is written through, as before: the file
  // replaced is the one it leads to, and the link stays a link.
  const abs = await throughLink(target);
  const dir = path.dirname(abs);
  await fs.mkdir(dir, { recursive: true });
  let mode = opts.mode;
  let present = true;
  try {
    const st = await fs.stat(abs);
    if (mode === undefined && !windows) mode = st.mode & 0o7777;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    present = false;
  }
  // A file that could not be written in place is not replaced either: the rename needs only the directory, and would
  // turn a read-only file into a written one. The error is `access`'s, naming the target, as `writeFile`'s was.
  if (present) await fs.access(abs, fsConstants.W_OK);
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

async function throughLink(abs: string): Promise<string> {
  try {
    if (!(await fs.lstat(abs)).isSymbolicLink()) return abs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return abs;
    throw e;
  }
  return fs.realpath(abs);
}
