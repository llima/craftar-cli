import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { FORGE_SCHEMA_SECTION_FILES, ProfileWrittenSchema, windowsShaped, type ProfileWritten } from "../schema/index.js";
import { assertNoLinkOnPath, copyForgeForProof, proofPathsBack, removeProofCopy, loadForge, parseYaml, type Forge } from "./forge.js";
import { writeForgeFile } from "./forge-write.js";
import { impactOf, planAll, type ForgeWorkspace, type Planned } from "./impact.js";
import { readsSectionFiles } from "./section-files.js";
import { canonicalValue } from "./sections.js";
import type { WriteJournal } from "./unify.js";
import { editYamlText } from "./yaml-edit.js";

/**
 * Spec 55 §5.6: `craftar forge sections extract --profile <p>` moves a profile's long string section values into
 * `profiles/<folder>/sections/<type>/<name>/<section>.md` and writes `{ file: … }` in their place. `planExtract` reads only and
 * returns the whole edit; `proveExtract` applies it to a scratch copy and proves it; `applyExtract` writes. The command (in
 * `src/cli.ts`) gates on git between the plan and the proof, as `forge localize` does.
 */

export const EXTRACT_COMMAND = "forge sections extract";
export const DEFAULT_MIN_BYTES = 500;

export interface ExtractMove {
  key: string;
  section: string;
  /** UTF-8 length of the value. */
  bytes: number;
  /** As written in profile.yaml: relative to the profile's folder, POSIX. */
  file: string;
  abs: string;
  /** The string, as profile.yaml held it. */
  value: string;
}

export interface ExtractPlan {
  root: string;
  profile: string;
  minBytes: number;
  /** `profiles/<folder>/profile.yaml`'s absolute path. */
  profileAbs: string;
  /** Its new text, and its size before and after, in bytes. */
  profileText: string;
  profileBytes: { before: number; after: number };
  moved: ExtractMove[];
  /** Every path the run creates, a directory as its topmost new component, sorted. */
  creates: string[];
  warnings: string[];
}

const BOM = "\uFEFF";

const posix = (p: string) => p.split(path.sep).join("/");

/** Read only. Every refusal is thrown here with the Forge untouched; the git gate and the proof are the caller's. */
export async function planExtract(forge: Forge, profile: string, minBytes: number): Promise<ExtractPlan> {
  if (!readsSectionFiles(forge.manifest)) {
    throw new Error(
      `${EXTRACT_COMMAND} needs a Forge at schema: ${FORGE_SCHEMA_SECTION_FILES} — set it in craftar.forge.yaml (every workspace of this Forge then needs a craftar that reads it), commit, and re-run`,
    );
  }
  const declaring = forge.profileFiles.get(profile);
  if (!forge.profiles.has(profile) || declaring === undefined) throw new Error(`${EXTRACT_COMMAND}: no profile named ${profile} in this Forge`);
  const profileAbs = path.join(forge.root, ...declaring.split("/"));
  const folderAbs = path.dirname(profileAbs);
  const folderRel = path.posix.dirname(declaring);
  const raw = await fs.readFile(profileAbs, "utf8");
  const written: ProfileWritten = parseYaml(profileAbs, raw, ProfileWrittenSchema, declaring);

  const warnings: string[] = [];
  const moved: ExtractMove[] = [];
  const seen = new Map<string, string>(); // lower-cased created file → `<key>.<section>`
  for (const [key, values] of Object.entries(written.sections)) {
    for (const [section, value] of Object.entries(values)) {
      if (typeof value !== "string" || value === "") continue;
      const bytes = Buffer.byteLength(value, "utf8");
      if (bytes < minBytes) continue;
      if (value.startsWith(BOM)) {
        warnings.push(
          `${key}.${section} starts with a byte-order mark, which a section file's read drops — left in profile.yaml; move it by hand without the mark`,
        );
        continue;
      }
      const file = `sections/${key}/${section}.md`;
      const segments = file.split("/");
      if (segments.some(windowsShaped)) {
        throw new Error(
          `${EXTRACT_COMMAND}: ${key}.${section} would be written as ${folderRel}/${file}, a name Windows cannot hold — nothing written; move that value by hand under another file name: write it to ${folderRel}/sections/<a name>.md and set ${key}.${section} to { file: sections/<a name>.md }`,
        );
      }
      const prior = seen.get(file.toLowerCase());
      if (prior !== undefined) {
        throw new Error(`${EXTRACT_COMMAND}: ${prior} and ${key}.${section} would be written to files whose names differ only in case — nothing written; move one by hand under another file name`);
      }
      seen.set(file.toLowerCase(), `${key}.${section}`);
      moved.push({ key, section, bytes, file, abs: path.join(folderAbs, ...segments), value });
    }
  }

  // Each created path: absent; a directory is noted as its topmost new component.
  const creates = new Set<string>();
  for (const m of moved) {
    if (await fs.lstat(m.abs).then(() => true, () => false)) {
      throw new Error(`${EXTRACT_COMMAND}: ${posix(path.relative(forge.root, m.abs))} already exists — nothing written; remove it or move ${m.key}.${m.section} by hand`);
    }
    let top = m.abs;
    for (let dir = path.dirname(m.abs); dir !== folderAbs && !(await fs.lstat(dir).then(() => true, () => false)); dir = path.dirname(dir)) top = dir;
    creates.add(top);
  }

  let profileText = raw;
  if (moved.length) {
    profileText = editYamlText(raw, { command: EXTRACT_COMMAND, label: declaring, keys: ["sections"] }, (doc) => {
      for (const m of moved) doc.setIn(["sections", m.key, m.section], doc.createNode({ file: m.file }));
    });
    const expected = structuredClone(written);
    for (const m of moved) expected.sections[m.key][m.section] = { file: m.file };
    const after = parseYaml(profileAbs, profileText, ProfileWrittenSchema, declaring);
    if (!isDeepStrictEqual(after, expected)) {
      throw new Error(`${EXTRACT_COMMAND}: cannot edit ${declaring} in place (the edit does not read back as exactly the moved values) — reformat it by hand, commit, and re-run`);
    }
  }
  return {
    root: forge.root,
    profile,
    minBytes,
    profileAbs,
    profileText,
    profileBytes: { before: Buffer.byteLength(raw, "utf8"), after: Buffer.byteLength(profileText, "utf8") },
    moved,
    creates: [...creates].sort(),
    warnings,
  };
}

/** Write the edit under `root` (the Forge, or a scratch copy of it): the files first, `wx`, then profile.yaml. */
async function writeExtract(plan: ExtractPlan, root: string, journal?: WriteJournal): Promise<void> {
  const at = (abs: string) => path.join(root, path.relative(plan.root, abs));
  const files = new Set(plan.moved.map((m) => m.abs));
  for (const top of plan.creates) {
    if (files.has(top)) continue;
    journal?.push({ abs: at(top), created: true });
    await fs.mkdir(at(top), { recursive: true });
  }
  for (const m of plan.moved) {
    const abs = at(m.abs);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    if (plan.creates.includes(m.abs)) journal?.push({ abs, created: true });
    await fs.writeFile(abs, m.value, { flag: "wx" });
  }
  const profileAbs = at(plan.profileAbs);
  journal?.push({ abs: profileAbs, created: false });
  await writeForgeFile(profileAbs, plan.profileText);
}

/**
 * The proof (spec 55 §5.6 step 7): on a scratch copy, `os.tmpdir()/craftar-sections-extract-*`, the edit applied, the copy
 * loads, every moved value reads back under `canonicalValue`, and every registered workspace plans the same paths and bytes.
 * Returns what it could not prove; the copy is removed in a `finally`.
 */
export async function proveExtract(forge: Forge, plan: ExtractPlan, registered: ForgeWorkspace[]): Promise<{ warnings: string[]; before: Planned[] }> {
  const warnings: string[] = [];
  let scratch: string;
  try {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-sections-extract-"));
  } catch (e) {
    throw new Error(`${EXTRACT_COMMAND}: cannot make the scratch copy in the temporary directory (${(e as NodeJS.ErrnoException).code ?? "it failed"}) — nothing was written`);
  }
  try {
    const copy = path.join(scratch, "forge");
    await copyForgeForProof(forge.root, copy, EXTRACT_COMMAND);
    // A message from the copy names the Forge, whichever spelling of the scratch path it holds.
    const unscratch = await proofPathsBack(copy, forge.root);
    try {
      await writeExtract(plan, copy);
    } catch (e) {
      const at = (e as NodeJS.ErrnoException).path;
      const shown = at ? posix(path.relative(copy, at)) : "a file";
      throw new Error(`${EXTRACT_COMMAND}: ${shown} could not be written on the scratch copy the move is proved on (${(e as NodeJS.ErrnoException).code ?? "the write failed"}) — it cannot be written in the Forge either; nothing written`);
    }
    let edited: Forge;
    try {
      edited = await loadForge(copy);
    } catch (e) {
      throw new Error(`${EXTRACT_COMMAND}: the Forge would not load after the move:\n${unscratch(e instanceof Error ? e.message : String(e))}\nnothing written`);
    }
    const now = edited.profiles.get(plan.profile)!.sections;
    for (const m of plan.moved) {
      const got = now[m.key]?.[m.section];
      if (got === undefined || canonicalValue(got) !== canonicalValue(m.value)) {
        throw new Error(`${EXTRACT_COMMAND}: ${m.key}.${m.section} would not read back the same from its file; nothing written`);
      }
    }
    const before = await planAll(registered, forge);
    const after = await planAll(registered, edited);
    for (let i = 0; i < registered.length; i++) {
      const where = `workspace ${registered[i].entry.path}`;
      if (before[i].kind !== "planned") {
        warnings.push(`${where} does not plan today — not proved`);
        continue;
      }
      const r = impactOf(before[i], after[i]);
      if (r.state === "error") throw new Error(`${EXTRACT_COMMAND}: ${where} would not plan after the move — ${unscratch((r.error ?? "it fails").split("\n")[0])}; nothing written`);
      if (r.state !== "no-effect") throw new Error(`${EXTRACT_COMMAND}: ${where} would not plan the same after the move — ${r.files.join(", ")}; nothing written`);
    }
    return { warnings, before };
  } finally {
    await removeProofCopy(scratch);
  }
}

/** Write the edit into the Forge, each created path and profile.yaml noted in `journal` before it is touched. */
export async function applyExtract(plan: ExtractPlan, journal: WriteJournal): Promise<void> {
  await assertNoLinkOnPath(plan.root, [...plan.moved.map((m) => m.abs), plan.profileAbs], EXTRACT_COMMAND);
  await writeExtract(plan, plan.root, journal);
}
