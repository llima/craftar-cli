/**
 * Containment on real paths (spec 48): a symbolic link must not carry craftar out of the tree it works on. `climbsOut`
 * answers what a path says, before anything exists on disk; this answers where it leads. One predicate (`escapeOf`), one
 * way to read Forge content (`readForgeFile`, `readForgeText`, `forgeReader`) and one wording. No message here names a
 * link's target, whose path is someone else's text and may be private to the machine: `readlink` is never called.
 *
 * `realpathOfNearest` lives in `forge.ts`, which reads its YAML through this module: the two import each other for
 * functions called at run time only.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DirReader } from "./fingerprint.js";
import { listFiles, realpathOfNearest } from "./forge.js";

/** A tree's root: as given, because paths are built on it, and real, because that is what an escape is measured against. */
export interface ContainRoot {
  given: string;
  real: string;
  /** For a tree inside a Forge (a profile's folder, spec 51 §4.2): its Forge-relative POSIX path, which prefixes every path a message names, and what the tree is called there. */
  label?: { rel: string; tree: string };
}

/** `leaves`: outside the root. `git`: under the root's top-level `.git`. `unresolved`: a dangling link, or a loop. */
export type Escape = "leaves" | "unresolved" | "git";

export async function containRoot(given: string): Promise<ContainRoot> {
  const abs = path.resolve(given);
  return { given: abs, real: await realpathOfNearest(abs) };
}

/** A tree inside a Forge, measured on its own (spec 51 §4.2): `rel` is Forge-relative and POSIX, `tree` names it in a refusal. */
export async function containSubRoot(forge: ContainRoot, rel: string, tree: string): Promise<ContainRoot> {
  return { ...(await containRoot(path.join(forge.given, rel))), label: { rel, tree } };
}

const posix = (p: string) => p.split(path.sep).join("/");
const relOf = (root: ContainRoot, abs: string) => posix(path.relative(root.given, abs));
const climbs = (rel: string) => rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../") || path.isAbsolute(rel);

/** What a real path means against the root's real path. `path.relative` compares without case on win32. */
function placed(root: ContainRoot, real: string): Escape | null {
  const rel = path.relative(root.real, real);
  if (climbs(rel)) return "leaves";
  const first = rel.split(path.sep)[0];
  if ((process.platform === "win32" ? first.toLowerCase() : first) === ".git") return "git";
  return null;
}

type Kind = "link" | "other" | "missing" | "unreadable";
export type KindCache = Map<string, Promise<Kind>>;

function kindOf(abs: string, cache: KindCache): Promise<Kind> {
  let known = cache.get(abs);
  if (!known) {
    known = fs.lstat(abs).then(
      (st): Kind => (st.isSymbolicLink() ? "link" : "other"),
      (e: NodeJS.ErrnoException): Kind => (e.code === "ENOENT" || e.code === "ENOTDIR" ? "missing" : "unreadable"),
    );
    cache.set(abs, known);
  }
  return known;
}

interface Probe {
  escape: Escape | null;
  /** Whether a link lies on the path below the root. */
  viaLink: boolean;
}

async function probe(root: ContainRoot, abs: string, cache: KindCache): Promise<Probe> {
  const rel = path.relative(root.given, abs);
  if (climbs(rel)) {
    // A path not built on the root as given: a spelling of it, or a path that climbs out.
    try {
      return { escape: placed(root, await realpathOfNearest(abs)), viaLink: false };
    } catch {
      return { escape: "unresolved", viaLink: false };
    }
  }
  let head = root.given;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    head = path.join(head, part);
    const kind = await kindOf(head, cache);
    if (kind === "missing") break;
    if (kind === "unreadable") return { escape: "unresolved", viaLink: false };
    if (kind === "link") {
      try {
        return { escape: placed(root, await realpathOfNearest(abs)), viaLink: true };
      } catch {
        return { escape: "unresolved", viaLink: true };
      }
    }
  }
  return { escape: placed(root, path.join(root.real, rel)), viaLink: false };
}

/** Whether `abs` escapes `root`; `null` when it stays inside, a new file under a linked directory inside included. */
export async function escapeOf(root: ContainRoot, abs: string, cache: KindCache = new Map()): Promise<Escape | null> {
  return (await probe(root, abs, cache)).escape;
}

export interface EscapingPath {
  path: string;
  escapes: Escape;
}

/** The workspace side (§4.3): which of these root-relative POSIX paths escape. Parents shared by them are asked once. */
export async function escapingPaths(root: ContainRoot, paths: readonly string[]): Promise<EscapingPath[]> {
  const cache: KindCache = new Map();
  const out: EscapingPath[] = [];
  for (const rel of paths) {
    const escapes = await escapeOf(root, path.join(root.given, rel), cache);
    if (escapes) out.push({ path: rel, escapes });
  }
  return out;
}

/** The sentence for one escaping workspace path, in the form its answer takes. */
export function escapeLine(rel: string, escapes: Escape): string {
  switch (escapes) {
    case "leaves":
      return `${rel} leaves the workspace through a symbolic link — craftar does not write there; replace the link with a directory or a file inside the workspace`;
    case "unresolved":
      return `${rel} is a symbolic link that leads nowhere — fix or remove it`;
    case "git":
      return `${rel} is a symbolic link into the workspace's .git — craftar does not follow it; replace it`;
  }
}

/** The words for a workspace file craftar reads or writes by name (`craftar.lock`, `craftar.yaml`). */
export function escapeFileLine(rel: string, escapes: Escape): string {
  switch (escapes) {
    case "leaves":
      return `${rel} leaves the workspace through a symbolic link — replace it with a file`;
    case "unresolved":
      return `${rel} is a symbolic link that leads nowhere — fix or remove it`;
    case "git":
      return `${rel} is a symbolic link into the workspace's .git — replace it with a file`;
  }
}

/** The short reason a row or a source carries (`drift show`, `import`), in the form its answer takes. */
export function escapeReason(escapes: Escape): string {
  switch (escapes) {
    case "leaves":
      return "leaves the workspace through a symbolic link";
    case "unresolved":
      return "a symbolic link that leads nowhere";
    case "git":
      return "a symbolic link into the workspace's .git";
  }
}

/** The words for what `import` takes from a workspace (spec 48 §4.4): a source that leaves or leads into `.git`. */
export function escapeSourceLine(rel: string, escapes: Escape): string {
  return escapes === "git" ? `${rel} is a symbolic link into the workspace's .git` : `${rel} ${escapeReason(escapes)}`;
}

/** The words for a staged path `import` will not write through (spec 48 §4.4), relative to the Forge. */
export function escapeDestinationLine(rel: string, escapes: Escape): string {
  switch (escapes) {
    case "leaves":
      return `${rel}: a symbolic link out of the Forge — import does not write through it; replace it with a directory or a file inside the Forge`;
    case "unresolved":
      return `${rel}: a symbolic link that leads nowhere — fix or remove it`;
    case "git":
      return `${rel}: a symbolic link into the Forge's .git — import does not write through it; replace it`;
  }
}

/**
 * The refusal block, without the `error: ` prefix: one line per escaping path. `thenSync` is `init`'s form, as in
 * `unsetRefusal`: it has just written `craftar.yaml`, so that is what it says, and it ends with the sync to run.
 */
export function escapeRefusal(rows: readonly EscapingPath[], opts: { thenSync?: boolean } = {}): string {
  return [
    `${rows.length} path(s) craftar does not follow — ${opts.thenSync ? "craftar.yaml written, sync not run" : "nothing written"}`,
    ...rows.map((r) => `  ${escapeLine(r.path, r.escapes)}`),
    ...(opts.thenSync ? ["  fix each, then run craftar sync"] : []),
  ].join("\n");
}

/** The one-line reason, for a surface that shows a workspace as refused. */
export function escapeSummary(rows: readonly EscapingPath[]): string {
  const more = rows.length - 1;
  return `${escapeLine(rows[0].path, rows[0].escapes)}${more > 0 ? ` (and ${more} more)` : ""}`;
}

/** The rows of a status that escape, in the shape the wording takes. */
export function escapingRows(rows: ReadonlyArray<{ path: string; escapes?: Escape }>): EscapingPath[] {
  return rows.flatMap((r) => (r.escapes ? [{ path: r.path, escapes: r.escapes }] : []));
}

/** Refuse anything but a regular file inside the root, before a byte is read and before an `open` that could block. */
async function assertReadable(root: ContainRoot, abs: string): Promise<void> {
  const rel = root.label ? `${root.label.rel}/${relOf(root, abs)}` : relOf(root, abs);
  const tree = root.label?.tree ?? "the Forge";
  const { escape, viaLink } = await probe(root, abs, new Map());
  if (escape === "unresolved") throw new Error(`${rel}: a symbolic link that leads nowhere — fix or remove it`);
  if (escape === "git") throw new Error(`${rel}: a symbolic link into the Forge's .git — craftar does not read it; replace it with a file`);
  if (escape === "leaves") {
    if (viaLink) throw new Error(`${rel}: a symbolic link out of ${tree} — craftar does not read it; replace it with a file inside ${tree}`);
    throw new Error(`${rel}: outside ${tree} — craftar does not read it`);
  }
  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    return; // Plainly missing, or unreadable: the read that follows says so, in the words it always did.
  }
  if (st.isFile()) return;
  if (st.isDirectory() && viaLink) throw new Error(`${rel}: a link to a directory — craftar does not follow it inside an ingredient; replace it with the files`);
  throw new Error(`${rel}: not a regular file — craftar does not read it; remove it`);
}

export async function readForgeFile(root: ContainRoot, abs: string): Promise<Buffer> {
  await assertReadable(root, abs);
  return fs.readFile(abs);
}

export async function readForgeText(root: ContainRoot, abs: string): Promise<string> {
  await assertReadable(root, abs);
  return fs.readFile(abs, "utf8");
}

/** A `DirReader` bound to a Forge's root. */
export function forgeReader(root: ContainRoot): DirReader {
  return {
    readText: (abs) => readForgeText(root, abs),
    readBytes: (abs) => readForgeFile(root, abs),
    list: (dir) => listFiles(dir),
  };
}
