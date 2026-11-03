import { promises as fs } from "node:fs";
import path from "node:path";
import { FORGE_SCHEMA_SECTION_FILES, type ForgeManifest, type ProfileSections, type Sections } from "../schema/index.js";
import { readForgeFile, type ContainRoot } from "./contain.js";
import { isUtf8 } from "./text.js";
import { TERMINAL_UNSAFE } from "./forge.js";

/**
 * Spec 55 Part B: a section value held in a file, `{ file: sections/….md }`, in a `profile.yaml` (and, once spec 54 builds them,
 * a parent profile and a recipe). `loadForge` resolves every such value here, once, so a loaded profile holds strings and no
 * other reader of `.sections` sees a file.
 */

/** The one comparison with `FORGE_SCHEMA_SECTION_FILES` (spec 55 §5.1). */
export function readsSectionFiles(manifest: Pick<ForgeManifest, "schema">): boolean {
  return manifest.schema >= FORGE_SCHEMA_SECTION_FILES;
}

/** Which file each file-held value came from, by key then section: the path as written, relative to the declaring folder. */
export type SectionFileMap = Map<string, Map<string, string>>;

export interface ResolvedSections {
  /** Every value a string: a file's text with a leading BOM dropped, nothing else changed. */
  sections: Sections;
  files: SectionFileMap;
  /** One line each, naming the declaring file, the key and the section — never a value or a file's content. */
  findings: string[];
}

const BOM = "\uFEFF";

/**
 * Resolve the `{ file: }` values of one declaring file.
 *
 * @param folder the folder that holds the declaring YAML, measured on its own (`containSubRoot`), so a link out of it is refused
 * @param declaring the declaring file, Forge-relative and POSIX, as findings name it
 * @param gate whether the Forge reads section files: below it each file value is a near miss and nothing is read
 */
export async function resolveSectionFiles(folder: ContainRoot, declaring: string, written: ProfileSections, gate: boolean): Promise<ResolvedSections> {
  const sections: Sections = {};
  const files: SectionFileMap = new Map();
  const findings: string[] = [];
  const named = new Map<string, string>(); // lower-cased path → `sections.<key>.<section>`
  const where = (key: string, section: string) => `sections.${key}.${section}`;
  for (const [key, values] of Object.entries(written)) {
    const out: Record<string, string> = {};
    for (const [section, value] of Object.entries(values)) {
      if (typeof value === "string") {
        out[section] = value;
        continue;
      }
      if (!gate) {
        findings.push(`${declaring}: ${where(key, section)}: a section value held in a file needs schema: ${FORGE_SCHEMA_SECTION_FILES} in craftar.forge.yaml`);
        continue;
      }
      const prior = named.get(value.file.toLowerCase());
      if (prior !== undefined) {
        findings.push(`${declaring}: ${prior} and ${where(key, section)} name one file, ${value.file} — give each its own file`);
        continue;
      }
      named.set(value.file.toLowerCase(), where(key, section));
      const text = await readSectionFile(folder, value.file).catch((e: Error) => {
        findings.push(`${declaring}: ${where(key, section)}: ${e.message}`);
        return null;
      });
      if (text === null) continue;
      out[section] = text;
      let m = files.get(key);
      if (!m) files.set(key, (m = new Map()));
      m.set(section, value.file);
    }
    sections[key] = out;
  }
  return { sections, files, findings };
}

/** The text of one section file: refused when missing, not a regular file inside the folder (spec 48), or not valid UTF-8. */
async function readSectionFile(folder: ContainRoot, rel: string): Promise<string> {
  const shown = folder.label ? `${folder.label.rel}/${rel}` : rel;
  const abs = path.join(folder.given, ...rel.split("/"));
  const bytes = await readForgeFile(folder, abs).catch((e: NodeJS.ErrnoException) => Promise.reject(notFoundOr(e, shown)));
  if (!isUtf8(bytes)) throw new Error(`${shown} is not valid UTF-8 — save it as UTF-8`);
  const text = bytes.toString("utf8");
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/** A read error in craftar's words: containment refusals keep theirs (they name no target); a raw `ENOENT` names no absolute path. */
function notFoundOr(e: NodeJS.ErrnoException, shown: string): Error {
  return e.code === "ENOENT" || e.code === "ENOTDIR" ? new Error(`${shown} not found`) : e;
}

/**
 * The file a profile's section value came from (spec 55 §5.4), as written relative to the profile's folder — `undefined` for a
 * string value, or a Forge loaded without provenance.
 */
export function profileSectionFile(
  forge: { sectionFiles?: Map<string, SectionFileMap>; profileFiles?: Map<string, string> },
  profile: string,
  key: string,
  section: string,
): string | undefined {
  const declaring = forge.profileFiles?.get(profile);
  return declaring === undefined ? undefined : forge.sectionFiles?.get(declaring)?.get(key)?.get(section);
}

/**
 * The file a recipe's section value came from (spec 54 §4.4), as written relative to the recipe file's folder: the recipe the
 * profile's view sees — its own local recipe of that name first, else the root's — or `undefined` for a string value.
 */
export function recipeSectionFile(
  forge: {
    sectionFiles?: Map<string, SectionFileMap>;
    recipeFiles?: Map<string, string>;
    locals?: Map<string, { recipes: Map<string, { file: string }> }>;
  },
  profile: string,
  recipe: string,
  key: string,
  section: string,
): string | undefined {
  const declaring = forge.locals?.get(profile)?.recipes.get(recipe)?.file ?? forge.recipeFiles?.get(recipe);
  return declaring === undefined ? undefined : forge.sectionFiles?.get(declaring)?.get(key)?.get(section);
}

/**
 * Loaded section values put back as written (spec 54 §4.4): each value `files` names becomes its `{ file: }`, every other one
 * stays its string. For a writer that copies a recipe's sections into another recipe of the same folder.
 */
export function writtenSections(sections: Sections, files: SectionFileMap | undefined): ProfileSections {
  const out: ProfileSections = {};
  for (const [key, values] of Object.entries(sections)) {
    out[key] = {};
    for (const [name, value] of Object.entries(values)) {
      const file = files?.get(key)?.get(name);
      out[key][name] = file === undefined ? value : { file };
    }
  }
  return out;
}

/** Spec 55 §5.3: the warning for a file under the folder's `sections/` that no value names. */
export function unnamedSectionFileWarning(rel: string): string {
  return `${rel}: no section value names this file`;
}

/** A name a terminal prints as it is: no control or bidirectional character (`TERMINAL_UNSAFE`'s class, spelled once there). */
const printable = (name: string) => !TERMINAL_UNSAFE.test(name);

/**
 * The files under `<folder>/sections/` that no value of the declaring file names, Forge-relative, sorted; compared without
 * case. Listed with `lstat`, so a link is reported by its own name and never followed.
 */
export async function unnamedSectionFiles(folderAbs: string, folderRel: string, files: SectionFileMap): Promise<string[]> {
  const named = new Set<string>();
  for (const m of files.values()) for (const p of m.values()) named.add(p.toLowerCase());
  const out: string[] = [];
  async function walk(dirAbs: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    // The position is among this folder's files, sorted by name, so it reads the same on every machine.
    const files = entries.filter((x) => !x.isDirectory()).map((x) => x.name).sort();
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(path.join(dirAbs, e.name), r);
      // A name a terminal would not print as it is reads by position in its folder.
      else if (!named.has(r.toLowerCase())) out.push(printable(e.name) ? `${folderRel}/${r}` : `${folderRel}/${rel}/#${files.indexOf(e.name) + 1} (a name not shown)`);
    }
  }
  await walk(path.join(folderAbs, "sections"), "sections");
  return out.sort();
}
