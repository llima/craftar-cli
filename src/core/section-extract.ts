import type { Hunk } from "./diff.js";
import type { PlanHunk } from "../schema/index.js";
import { splitLines } from "./diff.js";
import { canonicalValue, firstMarkerLine, parseSections, type ParsedSections } from "./sections.js";
import { stripBom, toLf } from "./text.js";

/**
 * Section extraction (spec 12): turn a `take: section` run into a section whose markers are added
 * to the base and whose value goes into the profile. Pure — the Forge-level gates and the YAML
 * edits live elsewhere.
 */

/** A section a plan run creates or fills (spec 12 §3). Lines are base line numbers, 1-based. */
export interface SectionRun {
  name: string;
  file: string; // base-relative, as the plan names it
  hunks: number[]; // the run's 1-based hunk numbers, ascending
  existing: boolean;
  /** Inclusive base line range; for an empty span, `from === to + 1` (the markers go between line `to` and line `from`). */
  from: number;
  to: number;
  default: string | null; // null for an existing section; "" or ends with "\n"
  value: string; // "" or ends with "\n"
}

/** Marker lines to insert, by base line index (0-based: "before base line index `at`", `at === A.lines.length` = at the end), in order. */
export interface MarkerInsertion {
  at: number;
  line: string;
}

/** Parse a "from-to" range string into two numbers. */
function parseLines(s: string): [number, number] {
  const [a, b] = s.split("-").map(Number);
  return [a, b];
}

/** The position a no-base-line hunk inserts at: h.a.start - 1 (spec 12 §6.1, step 3). */
function pureAdditionPos(h: Hunk): number {
  return h.a.start - 1;
}

/**
 * Compute the section runs, their spans, defaults and values from a file's diff and plan entries.
 * Throws with spec 12 §4.6 messages (S1–S10, S12) on any contradiction.
 */
export function deriveSections(args: {
  file: string; // base-relative file name, used in messages
  label: string; // Forge-relative path for parseSections messages
  ref: string; // the base ref, for parseSections' duplicate message
  baseText: string;
  variantText: string;
  hunks: Hunk[]; // the file's hunks, from diffIngredients (1-based numbering = index + 1)
  entries: PlanHunk[]; // the plan's hunk entries for this file (any take)
  declaredElsewhere: Map<string, string>; // section names declared in the base's OTHER admitted files → "file:line"
}): { runs: SectionRun[]; markers: MarkerInsertion[] } {
  const { file, label, ref, baseText, variantText, hunks, entries, declaredElsewhere } = args;
  const A = splitLines(baseText);
  const B = splitLines(variantText);

  // Step 1: Variant markers (S12)
  const variantMarkerLine = firstMarkerLine(toLf(stripBom(variantText)));
  if (variantMarkerLine !== null) {
    throw new Error(
      `unify: variant holds a section marker on ${file}:${variantMarkerLine} — remove it by hand and save the plan again, or re-import the workspace`,
    );
  }

  // Step 2: Base sections
  const parsed = parseSections(baseText, label, ref);
  const baseSections = parsed.sections.map((s) => ({
    name: s.name,
    opener: s.line,
    closer: s.line + s.default.split("\n").length, // number of "\n" in default + 1
  }));

  // Step 3: Helper — does a hunk touch a section?
  const hunkTouchesSection = (h: Hunk, sec: { opener: number; closer: number }): boolean => {
    const { opener: o, closer: c } = sec;
    if (h.a.lines.length > 0) {
      // Hunk with base lines: any line j in start..start+length-1 satisfies o <= j <= c
      for (let j = h.a.start; j < h.a.start + h.a.lines.length; j++) {
        if (o <= j && j <= c) return true;
      }
      return false;
    } else {
      // No base lines: position N = h.a.start - 1 satisfies o <= N < c
      const N = pureAdditionPos(h);
      return o <= N && N < c;
    }
  };

  // Step 4: Group section entries
  const sectionEntries = entries.filter((e) => e.take === "section");
  const byName = new Map<string, { hunkNums: number[]; linesRanges: string[] }>();

  for (const e of sectionEntries) {
    if (!e.section) {
      throw new Error(`unify plan: "${file}" hunk ${e.hunk} is take: section but names no section`);
    }
    const name = e.section.name;
    let group = byName.get(name);
    if (!group) {
      group = { hunkNums: [], linesRanges: [] };
      byName.set(name, group);
    }
    group.hunkNums.push(e.hunk);
    if (e.section.lines) group.linesRanges.push(e.section.lines);
  }

  // Validate groups: consecutive hunks, same lines range
  for (const [name, group] of byName) {
    group.hunkNums.sort((a, b) => a - b);
    // Check consecutive
    for (let i = 1; i < group.hunkNums.length; i++) {
      if (group.hunkNums[i] !== group.hunkNums[i - 1] + 1) {
        throw new Error(`unify plan: section ${name} is not one run of consecutive hunks (hunks ${group.hunkNums[i - 1]}, ${group.hunkNums[i]})`);
      }
    }
    // Check same lines range (S4)
    const uniqueRanges = [...new Set(group.linesRanges)];
    if (uniqueRanges.length > 1) {
      throw new Error(`unify plan: section ${name} has two ranges: ${uniqueRanges[0]}, ${uniqueRanges[1]}`);
    }
  }

  // Step 5: Existing or new
  const runs: SectionRun[] = [];
  const runByName = new Map<string, SectionRun>();

  for (const [name, group] of byName) {
    const runHunks = group.hunkNums.map((n) => hunks[n - 1]);
    const linesStr = group.linesRanges[0]; // all same or none

    // Find base sections touched by any hunk of this run
    const touchedSections = new Set<(typeof baseSections)[number]>();
    for (const h of runHunks) {
      for (const sec of baseSections) {
        if (hunkTouchesSection(h, sec)) touchedSections.add(sec);
      }
    }

    // Classify: existing or new
    const touched = [...touchedSections];

    if (touched.length > 1) {
      // More than one section touched
      throw new Error(`unify plan: section ${name} would overlap section ${touched[1].name} (${file}:${touched[1].opener})`);
    }

    if (touched.length === 1) {
      const sec = touched[0];
      if (sec.name !== name) {
        // Touched section has different name
        throw new Error(`unify plan: section ${name} would overlap section ${sec.name} (${file}:${sec.opener})`);
      }

      // Check all run hunks touch this section (S7 for partial touch)
      for (const h of runHunks) {
        const touchesThis = hunkTouchesSection(h, sec);
        if (!touchesThis) {
          throw new Error(`unify plan: section ${name} would overlap section ${sec.name} (${file}:${sec.opener})`);
        }
      }

      // EXISTING section
      // S8: Every hunk with base lines must have them all within [opener, closer]
      for (let i = 0; i < runHunks.length; i++) {
        const h = runHunks[i];
        if (h.a.lines.length > 0) {
          const first = h.a.start;
          const last = h.a.start + h.a.lines.length - 1;
          if (first < sec.opener || last > sec.closer) {
            throw new Error(
              `unify plan: hunk ${group.hunkNums[i]} of "${file}" holds lines inside and outside section ${name} — its variant side cannot be split; resolve it by re-importing the workspace`,
            );
          }
        }
      }

      // S9: If lines given, must be exactly opener-closer
      if (linesStr) {
        const expected = `${sec.opener}-${sec.closer}`;
        if (linesStr !== expected) {
          throw new Error(`unify plan: section ${name} already spans lines ${sec.opener}-${sec.closer}; unify does not move existing markers`);
        }
      }

      const from = sec.opener;
      const to = sec.closer;

      // Compute value from variant segment
      const value = computeValue(A, B, hunks, from, to, name, file);

      runs.push({
        name,
        file,
        hunks: group.hunkNums,
        existing: true,
        from,
        to,
        default: null,
        value,
      });
    } else {
      // NEW section
      // S6: name must not be declared anywhere
      const declaredInThis = baseSections.find((s) => s.name === name);
      if (declaredInThis) {
        throw new Error(`unify plan: section ${name} is already declared in ${ref} (${file}:${declaredInThis.opener})`);
      }
      const declaredOther = declaredElsewhere.get(name);
      if (declaredOther) {
        throw new Error(`unify plan: section ${name} is already declared in ${ref} (${declaredOther})`);
      }

      // Compute span
      let from: number;
      let to: number;

      if (linesStr) {
        // With lines
        const [a, b] = parseLines(linesStr);
        if (a < 1 || b < a || b > A.lines.length) {
          throw new Error(`unify plan: lines ${linesStr} of section ${name} is out of range`);
        }
        // Check all run hunks are within the range
        for (let i = 0; i < runHunks.length; i++) {
          const h = runHunks[i];
          if (h.a.lines.length > 0) {
            const first = h.a.start;
            const last = h.a.start + h.a.lines.length - 1;
            if (first < a || last > b) {
              throw new Error(`unify plan: lines ${linesStr} of section ${name} does not contain hunk ${group.hunkNums[i]}`);
            }
          } else {
            const N = pureAdditionPos(h);
            if (N < a - 1 || N > b) {
              throw new Error(`unify plan: lines ${linesStr} of section ${name} does not contain hunk ${group.hunkNums[i]}`);
            }
          }
        }
        from = a;
        to = b;
      } else {
        // Without lines
        const baseLines: number[] = [];
        const positions: number[] = [];
        for (const h of runHunks) {
          if (h.a.lines.length > 0) {
            for (let j = h.a.start; j < h.a.start + h.a.lines.length; j++) {
              baseLines.push(j);
            }
          } else {
            positions.push(pureAdditionPos(h));
          }
        }

        if (baseLines.length > 0) {
          from = Math.min(...baseLines);
          to = Math.max(...baseLines);
          // Every no-base-line hunk must have from - 1 <= N <= to
          for (let i = 0; i < runHunks.length; i++) {
            const h = runHunks[i];
            if (h.a.lines.length === 0) {
              const N = pureAdditionPos(h);
              if (N < from - 1 || N > to) {
                throw new Error(`unify plan: lines ${from}-${to} of section ${name} does not contain hunk ${group.hunkNums[i]}`);
              }
            }
          }
        } else {
          // All hunks have no base lines
          if (positions.length === 1 || new Set(positions).size === 1) {
            // All at same N: empty span
            const N = positions[0];
            from = N + 1;
            to = N;
          } else {
            from = Math.min(...positions) + 1;
            to = Math.max(...positions);
          }
        }
      }

      // Check span doesn't contain any existing section's opener or closer (S7)
      for (const sec of baseSections) {
        if (from <= sec.opener && sec.opener <= to) {
          throw new Error(`unify plan: section ${name} would overlap section ${sec.name} (${file}:${sec.opener})`);
        }
        if (from <= sec.closer && sec.closer <= to) {
          throw new Error(`unify plan: section ${name} would overlap section ${sec.name} (${file}:${sec.closer})`);
        }
      }

      // Compute default and value
      const defaultText = computeDefault(A, from, to, name, file);
      const value = computeValue(A, B, hunks, from, to, name, file);

      runs.push({
        name,
        file,
        hunks: group.hunkNums,
        existing: false,
        from,
        to,
        default: defaultText,
        value,
      });
    }

    runByName.set(name, runs[runs.length - 1]);
  }

  // Step 6: Coverage — every hunk not in a run must lie outside all spans
  const hunkInRun = new Set<number>();
  for (const run of runs) {
    for (const n of run.hunks) hunkInRun.add(n);
  }

  for (let i = 0; i < hunks.length; i++) {
    const hunkNum = i + 1;
    if (hunkInRun.has(hunkNum)) continue;

    const h = hunks[i];
    const entry = entries.find((e) => e.hunk === hunkNum);
    const take = entry?.take ?? "keep";

    for (const run of runs) {
      const { from, to, name } = run;
      const isEmptySpan = from === to + 1;

      if (h.a.lines.length > 0) {
        // Hunk with base lines: none in [from, to]
        for (let j = h.a.start; j < h.a.start + h.a.lines.length; j++) {
          if (!isEmptySpan && from <= j && j <= to) {
            const linesStr = `${from}-${to}`;
            throw new Error(`unify plan: lines ${linesStr} of section ${name} covers hunk ${hunkNum}, which is take: ${take}`);
          }
        }
      } else {
        // No base lines: N must satisfy N < from - 1 or N > to
        const N = pureAdditionPos(h);
        if (!isEmptySpan && !(N < from - 1 || N > to)) {
          const linesStr = `${from}-${to}`;
          throw new Error(`unify plan: lines ${linesStr} of section ${name} covers hunk ${hunkNum}, which is take: ${take}`);
        } else if (isEmptySpan && N === to) {
          // Empty span: N cannot equal to (the position)
          const linesStr = `${from}-${to}`;
          throw new Error(`unify plan: lines ${linesStr} of section ${name} covers hunk ${hunkNum}, which is take: ${take}`);
        }
      }
    }
  }

  // Check two runs don't overlap (S7)
  const sortedRuns = [...runs].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sortedRuns.length; i++) {
    const prev = sortedRuns[i - 1];
    const curr = sortedRuns[i];
    // prev.to must be < curr.from for no overlap
    if (prev.to >= curr.from) {
      throw new Error(`unify plan: section ${curr.name} would overlap section ${prev.name} (${file}:${prev.from})`);
    }
  }

  // Step 9: Generate markers for new sections
  // Track section name with each marker for proper sorting
  const markersWithMeta: Array<MarkerInsertion & { name: string; isOpener: boolean }> = [];
  for (const run of runs) {
    if (run.existing) continue;

    const opener = `<!-- craftar:section ${run.name} -->`;
    const closer = `<!-- /craftar:section -->`;

    // For an empty span (from === to + 1), both markers go at position `to` (which equals from - 1)
    // opener at from - 1 (0-based: from - 1), closer at to (0-based: to)
    // For non-empty: opener before line `from` (at = from - 1), closer after line `to` (at = to)
    const openerAt = run.from - 1;
    const closerAt = run.to;

    markersWithMeta.push({ at: openerAt, line: opener, name: run.name, isOpener: true });
    markersWithMeta.push({ at: closerAt, line: closer, name: run.name, isOpener: false });
  }

  // Sort markers: by `at`, opener-before-closer at same `at` for same section,
  // closer-before-opener when one section's closer and next one's opener share an `at`
  markersWithMeta.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;

    if (a.name === b.name) {
      // Same section: opener before closer
      return a.isOpener ? -1 : 1;
    } else {
      // Different sections at same position: closer before opener
      return a.isOpener ? 1 : -1;
    }
  });

  const markers: MarkerInsertion[] = markersWithMeta.map(({ at, line }) => ({ at, line }));

  return { runs: sortedRuns, markers };
}

/**
 * Compute the default text for a NEW section (base lines from..to).
 * S10: check for missing final newline.
 */
function computeDefault(A: ReturnType<typeof splitLines>, from: number, to: number, name: string, file: string): string {
  const isEmptySpan = from === to + 1;

  if (isEmptySpan) {
    // Empty span: check S10 for empty span at end of file
    if (to === A.lines.length && !A.eofNewline && A.lines.length > 0) {
      throw new Error(`unify plan: section ${name} would reach a missing final newline in the base, which a section cannot reproduce`);
    }
    return "";
  }

  // Non-empty span
  if (to === A.lines.length && !A.eofNewline) {
    throw new Error(`unify plan: section ${name} would reach a missing final newline in the base, which a section cannot reproduce`);
  }

  const lines = A.lines.slice(from - 1, to);
  const text = lines.map((l) => l + "\n").join("");

  // S12: check for marker in default
  if (firstMarkerLine(text) !== null) {
    throw new Error(`unify plan: section ${name} would hold a section marker`);
  }

  return text;
}

/**
 * Compute the value for a section (variant lines between anchors).
 * S10: check for missing final newline.
 */
function computeValue(
  A: ReturnType<typeof splitLines>,
  B: ReturnType<typeof splitLines>,
  hunks: Hunk[],
  from: number,
  to: number,
  name: string,
  file: string,
): string {
  const isEmptySpan = from === to + 1;

  // Step 7: Anchors and mapping
  // Anchors are base lines from - 1 and to + 1 (absent when < 1 or > A.lines.length)
  const startAnchor = from - 1 >= 1 ? from - 1 : null;
  const endAnchor = to + 1 <= A.lines.length ? to + 1 : null;

  // Map anchor line i to variant: i' = i + Σ(h.b.lines.length - h.a.lines.length) for hunks before i
  const mapToVariant = (i: number): number => {
    let offset = 0;
    for (const h of hunks) {
      // A hunk is "before" line i if its base lines end before i
      // h.a.start + h.a.lines.length <= i covers both cases
      if (h.a.start + h.a.lines.length <= i) {
        offset += h.b.lines.length - h.a.lines.length;
      }
    }
    return i + offset;
  };

  // Variant segment bounds
  let variantStart: number;
  let variantEnd: number;

  if (startAnchor !== null) {
    variantStart = mapToVariant(startAnchor) + 1; // line after the anchor's counterpart
  } else {
    variantStart = 1;
  }

  if (endAnchor !== null) {
    variantEnd = mapToVariant(endAnchor) - 1; // line before the anchor's counterpart
  } else {
    variantEnd = B.lines.length;
  }

  // Empty variant segment
  if (variantStart > variantEnd) {
    return "";
  }

  // S10: check for missing final newline in variant
  if (variantEnd === B.lines.length && !B.eofNewline) {
    throw new Error(`unify plan: section ${name} would reach a missing final newline in the variant, which a section cannot reproduce`);
  }

  const lines = B.lines.slice(variantStart - 1, variantEnd);
  const value = lines.map((l) => l + "\n").join("");

  // S12: check for marker in value
  if (firstMarkerLine(value) !== null) {
    throw new Error(`unify plan: section ${name} would hold a section marker`);
  }

  return value;
}
