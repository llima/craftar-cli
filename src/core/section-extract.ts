import type { Hunk } from "./diff.js";
import { SECTION_NAME, type PlanHunk } from "../schema/index.js";
import { splitLines } from "./diff.js";
import { expandSections, firstMarkerLine, parseSections, SectionMarkerError, type ParsedSections } from "./sections.js";
import { stripBom, toLf } from "./text.js";
import type { Extraction } from "./extract.js";
import { placeholders, substituteKeys } from "./extract.js";

/**
 * Section extraction (spec 12): turn a `take: section` run into a section whose markers are added
 * to the base and whose value goes into the profile. Pure — the Forge-level gates and the YAML
 * edits live elsewhere.
 */

/** A section's span: opener and closer line numbers (1-based, both inclusive). */
interface SectionSpan {
  name: string;
  opener: number;
  closer: number;
}

/**
 * Compute the opener/closer span for each section of a parsed file (spec 12 §4.2).
 * `closer = opener + s.default.split("\n").length` — the opener line, plus one line per `\n` in the default.
 */
function sectionSpans(parsed: ParsedSections): SectionSpan[] {
  return parsed.sections.map((s) => ({
    name: s.name,
    opener: s.line,
    closer: s.line + s.default.split("\n").length,
  }));
}

/**
 * Does a hunk "touch" a section span? (spec 12 §4.2's definition)
 * - With base lines: at least one line j in [start, start + length - 1] satisfies opener <= j <= closer.
 * - Without base lines: position N = h.a.start - 1 satisfies opener <= N < closer.
 */
function touches(h: { a: { start: number; lines: string[] } }, span: SectionSpan): boolean {
  const { opener: o, closer: c } = span;
  if (h.a.lines.length > 0) {
    for (let j = h.a.start; j < h.a.start + h.a.lines.length; j++) {
      if (o <= j && j <= c) return true;
    }
    return false;
  } else {
    const N = h.a.start - 1;
    return o <= N && N < c;
  }
}

/** A section a plan run creates or fills (spec 12 §3). Lines are base line numbers, 1-based. */
export interface SectionRun {
  name: string;
  file: string; // base-relative, as the plan names it
  hunks: number[]; // the run's 1-based hunk numbers, ascending
  existing: boolean;
  /** True when the plan gave explicit `lines`, false when the span was computed from hunks. */
  linesSpecified: boolean;
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
  const baseSections = sectionSpans(parsed);

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
        if (touches(h, sec)) touchedSections.add(sec);
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
        const touchesThis = touches(h, sec);
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
      const value = computeValue(A, B, hunks, from, to, name, file, !!linesStr);

      runs.push({
        name,
        file,
        hunks: group.hunkNums,
        existing: true,
        linesSpecified: !!linesStr,
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
        // Without lines: spec 12 §6.2 — a pure insertion at position N contributes N+1 for 'from'
        // and N for 'to'; Ruling 1 includes equal lines between hunks.
        const fromCandidates: number[] = [];
        const toCandidates: number[] = [];
        for (const h of runHunks) {
          if (h.a.lines.length > 0) {
            fromCandidates.push(h.a.start);
            toCandidates.push(h.a.start + h.a.lines.length - 1);
          } else {
            const N = pureAdditionPos(h);
            fromCandidates.push(N + 1);
            toCandidates.push(N);
          }
        }

        // All pure insertions at one position → empty span (from > to)
        const uniqueFrom = new Set(fromCandidates);
        const uniqueTo = new Set(toCandidates);
        if (uniqueFrom.size === 1 && uniqueTo.size === 1 && Math.min(...fromCandidates) > Math.max(...toCandidates)) {
          // Empty span: all hunks are pure insertions at the same position
          from = fromCandidates[0];
          to = toCandidates[0];
        } else {
          from = Math.min(...fromCandidates);
          to = Math.max(...toCandidates);
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
      const value = computeValue(A, B, hunks, from, to, name, file, !!linesStr);

      runs.push({
        name,
        file,
        hunks: group.hunkNums,
        existing: false,
        linesSpecified: !!linesStr,
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
      const { from, to, name, linesSpecified } = run;
      const isEmptySpan = from === to + 1;
      const rangeStr = `${from}-${to}`;

      if (h.a.lines.length > 0) {
        // Hunk with base lines: none in [from, to]
        for (let j = h.a.start; j < h.a.start + h.a.lines.length; j++) {
          if (!isEmptySpan && from <= j && j <= to) {
            // S5: wording differs based on whether the plan gave explicit `lines`
            if (linesSpecified) {
              throw new Error(`unify plan: lines ${rangeStr} of section ${name} covers hunk ${hunkNum}, which is take: ${take}`);
            } else {
              throw new Error(`unify plan: section ${name} (lines ${rangeStr}) covers hunk ${hunkNum}, which is take: ${take}`);
            }
          }
        }
      } else {
        // No base lines: N must satisfy N < from - 1 or N > to
        const N = pureAdditionPos(h);
        if (!isEmptySpan && !(N < from - 1 || N > to)) {
          // S5: wording differs based on whether the plan gave explicit `lines`
          if (linesSpecified) {
            throw new Error(`unify plan: lines ${rangeStr} of section ${name} covers hunk ${hunkNum}, which is take: ${take}`);
          } else {
            throw new Error(`unify plan: section ${name} (lines ${rangeStr}) covers hunk ${hunkNum}, which is take: ${take}`);
          }
        } else if (isEmptySpan && N === to) {
          // Empty span: N cannot equal to (the position)
          // S5: wording differs based on whether the plan gave explicit `lines`
          if (linesSpecified) {
            throw new Error(`unify plan: lines ${rangeStr} of section ${name} covers hunk ${hunkNum}, which is take: ${take}`);
          } else {
            throw new Error(`unify plan: section ${name} (lines ${rangeStr}) covers hunk ${hunkNum}, which is take: ${take}`);
          }
        }
      }
    }
  }

  // Check two runs don't overlap (S7)
  // Sort deterministically: by from, then by to, then by name
  const sortedRuns = [...runs].sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    if (a.to !== b.to) return a.to - b.to;
    return a.name.localeCompare(b.name);
  });
  for (let i = 1; i < sortedRuns.length; i++) {
    const prev = sortedRuns[i - 1];
    const curr = sortedRuns[i];
    const prevEmpty = prev.from === prev.to + 1;
    const currEmpty = curr.from === curr.to + 1;

    // Non-empty vs non-empty: prev.to must be < curr.from
    // Empty span [N+1, N] overlaps a neighbor whose to === N or whose from === N + 1
    let overlaps = false;
    if (!prevEmpty && !currEmpty) {
      // Both non-empty: standard check
      overlaps = prev.to >= curr.from;
    } else if (prevEmpty && !currEmpty) {
      // Empty prev: [from=N+1, to=N] touches curr if curr.from === N + 1
      // prev.from is the "after line N" position = N + 1
      overlaps = curr.from === prev.from;
    } else if (!prevEmpty && currEmpty) {
      // Empty curr: [from=N+1, to=N] touches prev if prev.to === N
      // curr.to is N
      overlaps = prev.to === curr.to;
    } else {
      // Both empty: [prevFrom=M+1, prevTo=M] and [currFrom=N+1, currTo=N]
      // They touch if M === N (same position) or M+1 === N (adjacent positions)
      overlaps = prev.to === curr.to || prev.from === curr.to;
    }

    if (overlaps) {
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

  // Sort markers: by `at`, then by type (closer before opener for different sections,
  // opener before closer for same section), then by name for stability.
  // This is a total order: at → isOpener → name covers all cases.
  markersWithMeta.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;

    if (a.name === b.name) {
      // Same section: opener before closer
      return a.isOpener ? -1 : 1;
    }

    // Different sections at same position: closer before opener
    if (a.isOpener !== b.isOpener) {
      return a.isOpener ? 1 : -1;
    }

    // Both same type (both openers or both closers), different names: sort by name
    return a.name.localeCompare(b.name);
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
 * S5: anchors must be equal lines (not inside any hunk).
 * @param linesSpecified true when the plan gave explicit `lines`, false when span was computed from hunks
 */
function computeValue(
  A: ReturnType<typeof splitLines>,
  B: ReturnType<typeof splitLines>,
  hunks: Hunk[],
  from: number,
  to: number,
  name: string,
  file: string,
  linesSpecified: boolean,
): string {
  const isEmptySpan = from === to + 1;

  // Step 7: Anchors and mapping
  // Anchors are base lines from - 1 and to + 1 (absent when < 1 or > A.lines.length)
  const startAnchor = from - 1 >= 1 ? from - 1 : null;
  const endAnchor = to + 1 <= A.lines.length ? to + 1 : null;

  // Step 7 assert: anchors must lie in no hunk (they must be equal lines)
  // If an anchor is inside a hunk's base lines, the value would be read from wrong variant lines
  const lineInHunk = (line: number): number | null => {
    for (let i = 0; i < hunks.length; i++) {
      const h = hunks[i];
      if (h.a.lines.length > 0) {
        const first = h.a.start;
        const last = h.a.start + h.a.lines.length - 1;
        if (first <= line && line <= last) {
          return i + 1; // 1-based hunk number
        }
      }
    }
    return null;
  };

  if (startAnchor !== null) {
    const hunkNum = lineInHunk(startAnchor);
    if (hunkNum !== null) {
      // S5: wording differs based on whether the plan gave explicit `lines`
      if (linesSpecified) {
        throw new Error(`unify plan: lines ${from}-${to} of section ${name} cuts hunk ${hunkNum}`);
      } else {
        throw new Error(`unify plan: section ${name} (lines ${from}-${to}) cuts hunk ${hunkNum}`);
      }
    }
  }

  if (endAnchor !== null) {
    const hunkNum = lineInHunk(endAnchor);
    if (hunkNum !== null) {
      // S5: wording differs based on whether the plan gave explicit `lines`
      if (linesSpecified) {
        throw new Error(`unify plan: lines ${from}-${to} of section ${name} cuts hunk ${hunkNum}`);
      } else {
        throw new Error(`unify plan: section ${name} (lines ${from}-${to}) cuts hunk ${hunkNum}`);
      }
    }
  }

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

/**
 * The section half of the equivalence proof (spec 12 §6.5), for one file that has at least one
 * section run. It also carries the plan's param keys K (spec 09 §6.2), because a file can hold both:
 * for such a file this replaces `prove`. Throws S17 naming the file.
 */
export function proveSections(args: {
  file: string; // base-relative, for messages
  label: string; // Forge-relative, for parseSections
  ref: string;
  template: string; // T: section hunks as base lines, param hunks as templates, new markers inserted
  mBase: string; // every param and section hunk taken base, others as the plan says
  mVar: string; // every param and section hunk taken variant, others as the plan says
  newNames: string[]; // the names of the NEW runs in this file
  values: Record<string, string>; // σ: run name → value, for every run (new and existing) in this file
  profileValues: Record<string, string>; // S_p: profile <p>'s current sections for the base's key ({} when none)
  extractions: Extraction[]; // the plan's param keys (may be empty)
}): void {
  const { file, label, ref, template, mBase, mVar, newNames, values, profileValues, extractions } = args;
  const n = (x: string) => toLf(stripBom(x));

  // Build D and V from extractions
  const D = new Map(extractions.map((e) => [e.key, e.default]));
  const V = new Map(extractions.map((e) => [e.key, e.value]));
  const K = new Set(extractions.map((e) => e.key));

  const names = (p: ParsedSections) => p.sections.map((s) => s.name);

  // Step 1: Parse all three
  let pT: ParsedSections;
  let pB: ParsedSections;
  let pV: ParsedSections;

  const runNames = Object.keys(values).join(", ") || newNames.join(", ");

  try {
    pT = parseSections(template, label, ref);
  } catch (e) {
    if (e instanceof SectionMarkerError) {
      throw new Error(`unify: section ${runNames} would not reproduce the base side of "${file}" (${e.problem})`);
    }
    throw e;
  }

  try {
    pB = parseSections(mBase, label, ref);
  } catch (e) {
    if (e instanceof SectionMarkerError) {
      throw new Error(`unify: section ${runNames} would not reproduce the base side of "${file}" (${e.problem})`);
    }
    throw e;
  }

  try {
    pV = parseSections(mVar, label, ref);
  } catch (e) {
    if (e instanceof SectionMarkerError) {
      throw new Error(`unify: section ${runNames} would not reproduce the variant side of "${file}" (${e.problem})`);
    }
    throw e;
  }

  // Step 2: Structure check
  // names(pT) with every name of newNames removed must equal names(pB)
  const tNames = names(pT);
  const bNames = names(pB);
  const newNamesSet = new Set(newNames);

  // Check every newNames entry appears exactly once in tNames
  for (const name of newNames) {
    const count = tNames.filter((n) => n === name).length;
    if (count !== 1) {
      throw new Error(`unify: section ${runNames} would not reproduce the base side of "${file}"`);
    }
  }

  // names(pT) - newNames must equal names(pB)
  const tNamesFiltered = tNames.filter((name) => !newNamesSet.has(name));
  if (tNamesFiltered.length !== bNames.length || !tNamesFiltered.every((name, i) => name === bNames[i])) {
    throw new Error(`unify: section ${runNames} would not reproduce the base side of "${file}"`);
  }

  // Step 3: Base side proof
  const tB = expandSections(pT, {});
  const mB = expandSections(pB, {});
  if (n(substituteKeys(tB, D)) !== n(substituteKeys(mB, D))) {
    throw new Error(`unify: section ${runNames} would not reproduce the base side of "${file}"`);
  }

  // Step 4: Variant side proof
  const combinedValues = { ...profileValues, ...values };
  const tV = expandSections(pT, combinedValues);
  const mV = expandSections(pV, profileValues);
  if (n(substituteKeys(tV, V)) !== n(substituteKeys(mV, V))) {
    throw new Error(`unify: section ${runNames} would not reproduce the variant side of "${file}"`);
  }

  // Step 5: Placeholders check (spec 09 §6.2 (b))
  const others = (t: string) => placeholders(n(t)).filter((k) => !K.has(k));

  const othersTB = others(tB);
  const othersMB = others(mB);
  if (JSON.stringify(othersTB) !== JSON.stringify(othersMB)) {
    throw new Error(`unify: extracting into "${file}" would change which {{…}} placeholders the text holds`);
  }

  const othersTV = others(tV);
  const othersMV = others(mV);
  if (JSON.stringify(othersTV) !== JSON.stringify(othersMV)) {
    throw new Error(`unify: extracting into "${file}" would change which {{…}} placeholders the text holds`);
  }
}


/**
 * A Markdown heading line: `/^#{1,6}[ \t]+(.+?)[ \t#]*$/` at column 0.
 * The capture group is the heading text, trimmed of trailing spaces and `#`.
 */
const HEADING_RE = /^#{1,6}[ \t]+(.+?)[ \t#]*$/;

/**
 * Turn a heading text into a slug for a section name (spec 12 §4.2):
 * NFD, strip combining marks (`\p{M}`), lower-case, non-`[a-z0-9]` → `-`, trim `-`, cut at 40 chars, trim `-` again.
 */
function headingSlug(text: string): string {
  // NFD decomposition, strip combining marks
  const decomposed = text.normalize("NFD").replace(/\p{M}/gu, "");
  // Lower-case
  const lower = decomposed.toLowerCase();
  // Non-[a-z0-9] → -
  const dashed = lower.replace(/[^a-z0-9]+/g, "-");
  // Trim leading/trailing -
  const trimmed = dashed.replace(/^-+|-+$/g, "");
  // Cut at 40 chars
  const cut = trimmed.slice(0, 40);
  // Trim trailing - again (in case cut ended mid-run)
  return cut.replace(/-+$/, "");
}

export interface HunkWithSuggestion {
  a: { start: number; lines: string[] };
  suggestion: { class: string };
}

/**
 * The section name `--save-plan` pre-fills for each hunk of one file, or undefined (spec 12 §4.2).
 * Index = hunk index (0-based).
 *
 * Rules (in this order, per hunk):
 * 1. Touches an existing section → that section's exact name.
 * 2. Suggestion class `block` → a slug from the nearest heading above, or `section-<n>`.
 * 3. Otherwise → undefined.
 *
 * Uniqueness (rule 2 names only): a candidate name that is in `declared`, or that an earlier
 * non-consecutive hunk of this file got, gets `-2`, `-3`, … appended until it is free.
 * Consecutive block hunks keep the same name (they form one run if the human sets them all to `take: section`).
 *
 * A parse error in the base → return all undefined (pre-fill never blocks `--save-plan`).
 */
export function prefillSections(args: {
  baseText: string;
  label: string;
  ref: string;
  hunks: HunkWithSuggestion[];
  /** Every section name the ingredient already declares, in any admitted file. */
  declared: Set<string>;
}): Array<string | undefined> {
  const { baseText, label, ref, hunks, declared } = args;
  const result: Array<string | undefined> = new Array(hunks.length).fill(undefined);

  // Parse base sections; on error, return all undefined
  let parsed: ParsedSections;
  try {
    parsed = parseSections(baseText, label, ref);
  } catch (e) {
    if (e instanceof SectionMarkerError) return result;
    throw e;
  }

  // Build base section spans using the shared helper
  const baseSections = sectionSpans(parsed);

  // Split base into lines for heading search
  const baseLines = splitLines(baseText).lines;

  // Find the nearest heading above a given position (line number, 1-based)
  const nearestHeadingAbove = (pos: number): string | null => {
    for (let i = pos - 1; i >= 0; i--) {
      const line = baseLines[i];
      const match = HEADING_RE.exec(line);
      if (match) return match[1];
    }
    return null;
  };

  // Track used names for uniqueness
  const usedNames = new Map<string, number>(); // name → last hunk index that used it
  // Also track what was declared
  const declaredSet = new Set(declared);

  // Process each hunk
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];

    // Rule 1: Touches existing section → that section's exact name
    let touchedSection: string | null = null;
    for (const sec of baseSections) {
      if (touches(h, sec)) {
        touchedSection = sec.name;
        break;
      }
    }

    if (touchedSection !== null) {
      result[i] = touchedSection;
      continue;
    }

    // Rule 2: Block suggestion → slug from heading or section-<n>
    if (h.suggestion.class === "block") {
      // Find position for heading search
      let searchPos: number;
      if (h.a.lines.length > 0) {
        // Above a.start means < a.start, so search starting from a.start - 1 (0-indexed: a.start - 2)
        searchPos = h.a.start - 1; // This will search lines [0, a.start-2] in 0-indexed terms
      } else {
        // At or above N where N = a.start - 1, means lines <= N, so search from N (0-indexed: N-1)
        const N = h.a.start - 1;
        searchPos = N; // This will search lines [0, N-1] in 0-indexed, i.e., lines 1..N in 1-indexed
      }

      const heading = nearestHeadingAbove(searchPos);
      let candidate: string;

      if (heading !== null) {
        const slug = headingSlug(heading);
        // Check if slug is valid (matches SECTION_NAME) and non-empty
        if (slug.length > 0 && SECTION_NAME.test(slug)) {
          candidate = slug;
        } else {
          // Fallback: section-<n> with n = 1-based hunk number
          candidate = `section-${i + 1}`;
        }
      } else {
        // Fallback: section-<n>
        candidate = `section-${i + 1}`;
      }

      // Uniqueness check: consecutive block hunks with the same name keep it
      const prevIndex = usedNames.get(candidate);
      const isConsecutive = prevIndex !== undefined && prevIndex === i - 1;

      if (isConsecutive) {
        // Same name as directly preceding hunk, keep it
        result[i] = candidate;
        usedNames.set(candidate, i);
      } else if (declaredSet.has(candidate) || (prevIndex !== undefined && !isConsecutive)) {
        // Need to find a unique suffix
        let suffix = 2;
        let uniqueName = `${candidate}-${suffix}`;
        while (declaredSet.has(uniqueName) || usedNames.has(uniqueName)) {
          suffix++;
          uniqueName = `${candidate}-${suffix}`;
        }
        result[i] = uniqueName;
        usedNames.set(uniqueName, i);
      } else {
        // Name is free
        result[i] = candidate;
        usedNames.set(candidate, i);
      }
    }
    // Rule 3: Otherwise → undefined (already the default)
  }

  return result;
}
