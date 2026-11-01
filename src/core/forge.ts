import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ForgeManifestSchema,
  IngredientSchema,
  ProfileSchema,
  RecipeSchema,
  type ForgeManifest,
  type Ingredient,
  type IngredientRef,
  type Profile,
  type Recipe,
} from "../schema/index.js";
import { parseYamlText } from "./yaml-read.js";
import { SchemaError, schemaIssues } from "./schema-fault.js";
import { execProgram, streamProgram } from "./proc.js";
import { findSecrets } from "./secrets.js";
import { climbsOut } from "./text.js";
import { containRoot, readForgeText, type ContainRoot } from "./contain.js";

export interface LoadedIngredient {
  ref: IngredientRef;
  dir: string;
  meta: Ingredient;
  /** The Forge it was loaded from: every read of its files is measured against this root (spec 48). */
  forgeRoot: ContainRoot;
}

export interface Forge {
  root: string;
  manifest: ForgeManifest;
  ingredients: Map<IngredientRef, LoadedIngredient>;
  recipes: Map<string, Recipe>;
  profiles: Map<string, Profile>;
  /** HEAD commit when the Forge is a git checkout, else null. */
  commit: string | null;
}

export const FORGE_MANIFEST = "craftar.forge.yaml";

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Parse YAML `text` read from `file` through `schema`; a syntax or schema error names the file. */
export function parseYaml<T>(file: string, text: string, schema: { parse: (v: unknown) => T }): T {
  const rel = path.relative(process.cwd(), file);
  const parsed = parseYamlText(rel, text) ?? {};
  try {
    return schema.parse(parsed);
  } catch (e) {
    if (schemaIssues(e).length) throw new SchemaError(`invalid ${rel}`, e);
    throw e;
  }
}

async function readYaml<T>(root: ContainRoot, file: string, schema: { parse: (v: unknown) => T }): Promise<T> {
  return parseYaml(file, await readForgeText(root, file), schema);
}

/** Anything at the path, a dangling link included: `exists` would read that as absent and skip the file (spec 48 §15 item 27). */
const present = (p: string) => fs.lstat(p).then(() => true, () => false);

export async function loadForge(root: string): Promise<Forge> {
  root = path.resolve(root);
  const manifestPath = path.join(root, FORGE_MANIFEST);
  if (!(await exists(manifestPath))) throw new Error(`not a Forge: ${manifestPath} not found`);
  const contain = await containRoot(root);
  const manifest = await readYaml(contain, manifestPath, ForgeManifestSchema);

  const ingredients = new Map<IngredientRef, LoadedIngredient>();
  const ingRoot = path.join(root, "ingredients");
  if (await exists(ingRoot)) {
    for (const typeDir of await fs.readdir(ingRoot, { withFileTypes: true })) {
      if (!typeDir.isDirectory()) continue;
      const typeName = typeDir.name; // plural folder: rules, agents, …
      for (const ingDir of await fs.readdir(path.join(ingRoot, typeName), { withFileTypes: true })) {
        if (!ingDir.isDirectory()) continue;
        const dir = path.join(ingRoot, typeName, ingDir.name);
        const metaFile = path.join(dir, "ingredient.yaml");
        if (!(await present(metaFile))) continue;
        const meta = await readYaml(contain, metaFile, IngredientSchema);
        const ref = `${meta.type}/${meta.name}` as IngredientRef;
        if (ingredients.has(ref)) throw new Error(`duplicate ingredient ${ref} (${dir})`);
        ingredients.set(ref, { ref, dir, meta, forgeRoot: contain });
      }
    }
  }

  const recipes = new Map<string, Recipe>();
  const recRoot = path.join(root, "recipes");
  if (await exists(recRoot)) {
    for (const f of await fs.readdir(recRoot)) {
      if (!/\.ya?ml$/.test(f)) continue;
      const r = await readYaml(contain, path.join(recRoot, f), RecipeSchema);
      recipes.set(r.name, r);
    }
  }

  const profiles = new Map<string, Profile>();
  const profRoot = path.join(root, "profiles");
  if (await exists(profRoot)) {
    for (const d of await fs.readdir(profRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const f = path.join(profRoot, d.name, "profile.yaml");
      if (!(await present(f))) continue;
      const p = await readYaml(contain, f, ProfileSchema);
      profiles.set(p.name, p);
    }
  }

  return { root, manifest, ingredients, recipes, profiles, commit: await gitHead(root) };
}

async function gitHead(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execProgram("git", ["-C", dir, "rev-parse", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Whether `dir` sits inside a git working tree at all — true even for a freshly `git init`-ed
 * repository with no commits yet, unlike `gitHead`/`Forge.commit`, which is `null` in both that
 * case and the no-`.git`-at-all case. A caller that needs to tell the two apart (a refusal whose
 * wording depends on which is true) calls this in addition to checking `commit === null`.
 */
export async function gitIsRepo(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execProgram("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Whether `dir` is a git repository with at least one commit — `gitIsRepo(dir)` can be true even
 * for a freshly `git init`-ed repository, but this needs HEAD to resolve.
 */
export async function gitHasCommit(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execProgram("git", ["-C", dir, "rev-parse", "HEAD"]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Whether `rel` (a Forge-relative POSIX path) is ignored by git. Fails closed: when git cannot
 * answer, the path counts as ignored.
 */
export async function gitIgnored(dir: string, rel: string): Promise<boolean> {
  try {
    await execProgram("git", [...gitRead(dir), "check-ignore", "-q", "--", rel]);
    return true; // exit 0 means ignored
  } catch (e) {
    // exit 1 means not ignored; any other error fails closed
    if ((e as { code?: number }).code === 1) return false;
    return true; // fail closed
  }
}

/**
 * The git arguments for a read-only command that must not run hooks or take locks.
 * These keep `git` from running a `core.fsmonitor` command and a `post-index-change` hook
 * of the Forge's own `.git`; a `filter.<x>.clean` still runs.
 */
export function gitRead(dir: string): string[] {
  return ["--no-optional-locks", "-C", dir, "-c", "core.fsmonitor=false"];
}

/**
 * True when the Forge has uncommitted changes — and also when `git status` cannot be run at all.
 * By the time this is called the directory is known to be a git repository (`forge.commit !== null`
 * is checked first), so a failure here is anomalous, and an anomaly is not evidence of a clean
 * tree. Failing closed costs a confusing refusal; failing open costs a deletion from a Forge with
 * no lock.
 */
export async function gitDirty(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execProgram("git", [...gitRead(dir), "status", "--porcelain"]);
    return stdout.trim().length > 0;
  } catch {
    return true;
  }
}

/** How one ignore rule is named in a message (spec 49 §4.2, Ruling 3): no path outside the tree, no control character. */
export function shownRule(source: string, line: string, pattern: string, commonDir: string | null): string {
  const clean = (t: string) => t.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
  const slashed = (t: string) => {
    const p = t.replace(/\\/g, "/");
    return process.platform === "win32" ? p.toLowerCase() : p;
  };
  const absolute = path.isAbsolute(source) || /^[A-Za-z]:[\\/]/.test(source);
  let where: string;
  if (absolute) where = commonDir !== null && slashed(source) === `${slashed(commonDir)}/info/exclude` ? ".git/info/exclude" : "core.excludesFile";
  // In the tree a source is a .gitignore or the exclude file, reported from the top; a core.excludesFile can be spelled relative.
  else where = !climbsOut(source) && (source === ".git/info/exclude" || path.posix.basename(source) === ".gitignore") ? clean(source) : "core.excludesFile";
  const at = `${where}:${/^\d+$/.test(line) ? line : "?"}`;
  const shown = clean(pattern);
  return findSecrets(shown).length > 0 ? at : `${at} ${shown}`;
}

export interface IgnoredPath {
  /** The path as the caller spelled it. */
  path: string;
  /** `shownRule`'s words. */
  rule: string;
}

/**
 * The paths under `paths` git ignores at `root` (spec 49 §4.1). Fails open, unlike `gitIgnored`: that one protects a Forge
 * write, this one only informs. `-v` lists a negated rule too and exits 0 for it, so a path is ignored when its pattern is
 * not empty and does not start with `!`; the exit code decides nothing. A tracked file is never listed.
 */
export async function ignoredPaths(root: string, paths: string[], env?: NodeJS.ProcessEnv): Promise<{ ignored: IgnoredPath[]; unchecked: boolean }> {
  // First: a directory that is no repository and a path beyond a symbolic link both exit 128.
  if (!(await gitIsRepo(root))) return { ignored: [], unchecked: false };
  // Git refuses `/x` and answers for the spelling it is given: one query per normalized path, each named as the caller spells it.
  const spelled = new Map<string, string[]>();
  for (const p of paths) {
    const query = path.posix.normalize(p).replace(/^\/+/, "");
    spelled.set(query, [...(spelled.get(query) ?? []), p]);
  }
  let run: { code: number | null; stdout: string };
  try {
    run = await streamProgram("git", [...gitRead(root), "check-ignore", "--stdin", "-z", "-v", "-n"], {
      input: [...spelled.keys()].map((q) => `${q}\0`).join(""),
      env,
    });
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") return { ignored: [], unchecked: false };
    return { ignored: [], unchecked: true };
  }
  const fields = run.stdout.split("\0");
  const records: Array<{ source: string; line: string; pattern: string; query: string }> = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [source, line, pattern, query] = fields.slice(i, i + 4);
    if (pattern !== "" && !pattern.startsWith("!")) records.push({ source, line, pattern, query });
  }
  // Only a source spelled absolute needs it: in a linked worktree that is the common directory's exclude file.
  let commonDir: string | null = null;
  if (records.some((r) => path.isAbsolute(r.source) || /^[A-Za-z]:[\\/]/.test(r.source))) {
    try {
      const { stdout } = await execProgram("git", [...gitRead(root), "rev-parse", "--path-format=absolute", "--git-common-dir"], env ? { env } : {});
      commonDir = stdout.trim() || null;
    } catch {
      commonDir = null;
    }
  }
  const ignored: IgnoredPath[] = [];
  for (const r of records) {
    for (const p of spelled.get(r.query) ?? []) ignored.push({ path: p, rule: shownRule(r.source, r.line, r.pattern, commonDir) });
  }
  return { ignored, unchecked: run.code !== 0 && run.code !== 1 };
}

export interface UnheldPath {
  /** Forge-relative POSIX path (the path asked about, when git itself failed). */
  path: string;
  reason: "ignored" | "untracked" | "modified" | "skip-worktree" | "assume-unchanged" | "git failed";
}

/**
 * Ruling 37: the entries under `paths` (absolute, all inside the Forge `root`) that git does not
 * fully hold — ignored, untracked, modified, or index-flagged — where an overwrite or a deletion could not be
 * undone. `gitDirty` alone is not enough: plain `git status --porcelain` omits ignored files and
 * obeys `status.showUntrackedFiles=no`, so a Forge ignored by its enclosing repo, or an ignored
 * file inside a variant, passes it. `--ignored --untracked-files=all` surfaces both. Fails closed
 * like `gitDirty`: when git cannot answer, every path counts as not held.
 */
export async function gitUnheld(root: string, paths: string[]): Promise<UnheldPath[]> {
  if (paths.length === 0) return [];
  const rel = paths.map((p) => path.relative(root, p).split(path.sep).join("/") || ".");
  try {
    const { stdout } = await execProgram(
      "git",
      [...gitRead(root), "status", "--porcelain", "-z", "--ignored", "--untracked-files=all", "--", ...rel],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    // `status --porcelain` names paths from the repository root, which is not the Forge root when
    // the Forge sits inside a larger repo; strip the Forge's prefix so every path unify prints —
    // here and in the late-failure message — is Forge-relative. `ls-files` below already is.
    const { stdout: prefixOut } = await execProgram("git", [...gitRead(root), "rev-parse", "--show-prefix"]);
    const prefix = prefixOut.trim();
    const forgeRel = (p: string) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p) || ".";
    const out: UnheldPath[] = [];
    const entries = stdout.split("\0");
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.length < 4) continue;
      const xy = e.slice(0, 2);
      out.push({ path: forgeRel(e.slice(3)), reason: xy === "!!" ? "ignored" : xy === "??" ? "untracked" : "modified" });
      // A rename or copy carries its original path as the next NUL-separated field.
      if (xy[0] === "R" || xy[0] === "C") i++;
    }
    // Ruling 39: `git status` trusts the index flags, so an entry marked skip-worktree or
    // assume-unchanged reports clean however much its file was edited — and that edit exists
    // nowhere git can restore it from. `ls-files -v` shows the flag: `S` for skip-worktree, a
    // lowercase tag for assume-unchanged.
    const { stdout: listed } = await execProgram("git", [...gitRead(root), "ls-files", "-v", "-z", "--", ...rel], {
      maxBuffer: 64 * 1024 * 1024,
    });
    for (const e of listed.split("\0")) {
      if (e.length < 3) continue;
      const tag = e[0];
      if (tag === "S" || tag === "s") out.push({ path: e.slice(2), reason: "skip-worktree" });
      else if (tag !== tag.toUpperCase()) out.push({ path: e.slice(2), reason: "assume-unchanged" });
    }
    return out;
  } catch {
    return rel.map((p) => ({ path: p, reason: "git failed" as const }));
  }
}

/** Plural folder name for an ingredient type (rules/, agents/, …). */
export function typeFolder(type: Ingredient["type"]): string {
  return type === "mcp" ? "mcp" : `${type}s`;
}

export async function readIngredientText(ing: LoadedIngredient, file: string): Promise<string> {
  return readForgeText(ing.forgeRoot, path.join(ing.dir, file));
}

/** Recursively list files under a directory, relative to it, sorted. */
export async function listFiles(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, r)));
    else out.push(r);
  }
  return out.sort();
}

/* ---- the scratch copy a Forge proof runs on, and the link check its writes share (spec 30 `drift promote`, spec 29 `forge promote`) ---- */

const SYMLINK_REFUSAL = (rel: string, command: string) =>
  `${rel} is a symbolic link in the Forge — ${command} does not write through a link; replace it with the file and commit`;
const SYMLINK_DIR_REFUSAL = (rel: string, command: string) =>
  `${rel} is a symbolic link in the Forge — ${command} does not read a linked recipes, ingredients or profiles directory; replace it with the directory and commit`;
const NON_REGULAR_FILE_REFUSAL = (rel: string) =>
  `${rel} is not a regular file — promote cannot copy the Forge to prove its edit; remove it`;

/** The root directories loadForge reads; a link there causes the scratch to differ from the real Forge. */
const ROOT_DIRS = new Set(["ingredients", "recipes", "profiles"]);

/**
 * Copy the Forge to a scratch directory without `.git`, for the proof.
 * - A regular file: copied.
 * - A directory: recursed.
 * - A symbolic link to a FILE whose real path is inside the Forge: copied as a regular file (dereferenced).
 * - A symbolic link to a DIRECTORY (inside or outside): skipped — except a root directory link
 *   (ingredients, recipes, profiles), which is refused because loadForge follows it and the scratch would not.
 * - A symbolic link that is dangling, or whose target is a file OUTSIDE the Forge: left out; nothing can read it (spec 48 §4.2).
 * - A non-regular file (FIFO, socket, device): refused.
 * Exported so tests can verify the copy behaviour directly.
 */
export async function copyForgeForProof(forgeDir: string, scratchDir: string): Promise<void> {
  const forgeReal = await fs.realpath(forgeDir);

  async function walk(rel: string): Promise<void> {
    const src = path.join(forgeDir, rel);
    const dest = path.join(scratchDir, rel);

    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const ent of entries) {
      const entRel = rel ? `${rel}/${ent.name}` : ent.name;
      const entSrc = path.join(src, ent.name);
      const entDest = path.join(dest, ent.name);

      // Skip .git at the top level
      if (rel === "" && ent.name === ".git") continue;

      if (ent.isSymbolicLink()) {
        // First, check if we can resolve the symlink at all
        let targetReal: string;
        let targetStat;
        try {
          targetReal = await fs.realpath(entSrc);
          targetStat = await fs.stat(targetReal);
        } catch (e) {
          // Dangling or unresolvable: nothing can read it, since the real Forge's readers refuse it first (spec 48 §4.2).
          continue;
        }

        // If it's a directory (inside or outside Forge)
        if (targetStat.isDirectory()) {
          // A root directory link (ingredients, recipes, profiles) is refused: loadForge follows it
          // but the scratch would skip it, so the scratch would not load the same as the real Forge.
          if (rel === "" && ROOT_DIRS.has(ent.name)) {
            throw new Error(SYMLINK_DIR_REFUSAL(ent.name, "promote"));
          }
          // Other directory links are skipped entirely — loadForge doesn't traverse them
          continue;
        }

        // Target is neither a directory nor a regular file (FIFO, socket, etc.) — refuse
        // Check this BEFORE the "inside Forge" check so the message is clear
        if (!targetStat.isFile()) {
          throw new Error(NON_REGULAR_FILE_REFUSAL(entRel));
        }

        // It's a file link — check if target is inside the Forge
        const relToForge = path.relative(forgeReal, targetReal);
        // A name starting with ".." but not a ".." segment is valid (e.g. "..notes")
        const isOutside = relToForge === ".." || relToForge.startsWith(".." + path.sep) || path.isAbsolute(relToForge);
        if (isOutside) {
          // Left out, for the same reason as a dangling link.
          continue;
        }

        // File link to inside the Forge — copy the target's bytes as a regular file (dereferenced)
        await fs.copyFile(targetReal, entDest);
      } else if (ent.isDirectory()) {
        await fs.mkdir(entDest, { recursive: true });
        await walk(entRel);
      } else if (ent.isFile()) {
        // Regular file
        await fs.copyFile(entSrc, entDest);
      } else {
        // Non-regular file (FIFO, socket, device, etc.) — refuse
        throw new Error(NON_REGULAR_FILE_REFUSAL(entRel));
      }
    }
  }

  // Create the scratch root
  await fs.mkdir(scratchDir, { recursive: true });
  await walk("");
}

/**
 * Refuse a write through a symbolic link: every path, and every ancestor between it and `forgeDir`, that exists must
 * not be one. A path that does not exist yet is fine — it will be created.
 */
export async function assertNoLinkOnPath(forgeDir: string, paths: string[], command = "promote"): Promise<void> {
  const checked = new Set<string>();
  for (const abs of paths) {
    // The path and every ancestor up to but not including forgeDir
    let current = abs;
    while (path.relative(forgeDir, current) !== "") {
      if (checked.has(current)) break;
      checked.add(current);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) {
          const rel = path.relative(forgeDir, current).split(path.sep).join("/");
          // The directory-specific message for a root directory (ingredients, recipes, profiles)
          if (ROOT_DIRS.has(rel)) {
            throw new Error(SYMLINK_DIR_REFUSAL(rel, command));
          }
          throw new Error(SYMLINK_REFUSAL(rel, command));
        }
      } catch (e) {
        // ENOENT means the path doesn't exist yet (it will be created) — that's fine
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          throw e;
        }
      }
      current = path.dirname(current);
    }
  }
}

/** Refuse a symbolic link to a directory anywhere inside `dir`: `listFiles` lists it as a file, and reading it fails with a raw `EISDIR`. Links to files and dangling links are left to the other checks. */
export async function assertNoDirLinkIn(forgeDir: string, dir: string, command: string): Promise<void> {
  let files: string[];
  try {
    files = await listFiles(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "unreadable";
    throw new Error(`${command}: cannot read ${path.relative(forgeDir, dir).split(path.sep).join("/")} (${code})`);
  }
  for (const rel of files) {
    const abs = path.join(dir, rel);
    if (!(await fs.lstat(abs)).isSymbolicLink()) continue;
    const target = await fs.stat(abs).catch(() => null);
    if (target?.isDirectory()) {
      throw new Error(`${path.relative(forgeDir, abs).split(path.sep).join("/")} is a symbolic link to a directory in the Forge — ${command} does not read through it; replace it with the files and commit`);
    }
  }
}

/**
 * The real path of `abs`, resolved through its nearest existing ancestor: `fs.realpath` needs the
 * path to exist, and a plan target usually does not yet — so the part that exists is resolved
 * (symlinks and all) and the part that does not is appended as written.
 *
 * It walks up only past a component that truly does not exist (`lstat` says ENOENT/ENOTDIR). Any
 * other outcome throws instead. A component `lstat` cannot inspect (a symlink loop or a permission
 * error on Linux) "cannot be inspected"; one it can inspect but `realpath` cannot follow (a
 * dangling symlink or junction, a loop on Windows) "exists but cannot be resolved". Resolving the
 * rest lexically would let a link that points into the Forge pass the containment check, so the gate
 * fails closed rather than guess where the target lands.
 */
export async function realpathOfNearest(abs: string): Promise<string> {
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(head), ...tail);
    } catch (realpathError) {
      try {
        await fs.lstat(head);
      } catch (lstatError) {
        const code = (lstatError as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          const parent = path.dirname(head);
          if (parent === head) return abs;
          tail.unshift(path.basename(head));
          head = parent;
          continue;
        }
        throw cannotResolve(head, lstatError, "cannot be inspected");
      }
      throw cannotResolve(head, realpathError, "exists but cannot be resolved");
    }
  }
}

/**
 * The refusal for a target that cannot be resolved; the caller adds which command cannot prove it. `what` is
 * "cannot be inspected" when `lstat` itself failed, so the path is not known to exist, and "exists but cannot be
 * resolved" when `lstat` succeeded and `realpath` did not.
 */
export function cannotResolve(p: string, e: unknown, what: "cannot be inspected" | "exists but cannot be resolved"): Error {
  const code = (e as NodeJS.ErrnoException | null)?.code ?? (e instanceof Error ? e.message : String(e));
  return new Error(`${p} ${what} (${code})`);
}
