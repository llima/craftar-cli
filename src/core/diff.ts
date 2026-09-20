import { stripBom, toLf } from "./text.js";

export type DiffOp = { kind: "same" | "del" | "add"; line: string };

/** The git-style marker for a side whose text does not end in a newline. One copy: `cli.ts`
 * prints it under `forge diff`'s hunks and must say exactly what `renderDiff` says. */
export const NO_EOF_NEWLINE_MARKER = "\\ No newline at end of file";

export interface Hunk {
  kind: "block" | "inline";
  a: { start: number; lines: string[]; noEofNewline?: true };
  b: { start: number; lines: string[]; noEofNewline?: true };
}

type Split = { lines: string[]; eofNewline: boolean };

/**
 * Lines of a normalized text, without the empty element `split("\n")` leaves behind for a
 * trailing newline. `eofNewline` keeps the fact that element used to stand for, so a difference
 * that is only a final newline stays visible instead of rendering as an empty line.
 */
export function splitLines(s: string): Split {
  const t = toLf(stripBom(s));
  if (t === "") return { lines: [], eofNewline: false };
  const eofNewline = t.endsWith("\n");
  const lines = t.split("\n");
  if (eofNewline) lines.pop();
  return { lines, eofNewline };
}

/**
 * LCS line diff. Both sides are normalized first (LF, no BOM), so a difference
 * that is only line endings or a BOM produces no ops other than "same".
 */
export function diffOps(a: string, b: string): DiffOp[] {
  const A = splitLines(a).lines;
  const B = splitLines(b).lines;
  const n = A.length;
  const m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ kind: "same", line: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", line: A[i++] });
    } else {
      out.push({ kind: "add", line: B[j++] });
    }
  }
  while (i < n) out.push({ kind: "del", line: A[i++] });
  while (j < m) out.push({ kind: "add", line: B[j++] });
  return out;
}

/** The same traversal, grouped: consecutive non-"same" ops form one hunk. */
export function diffLines(a: string, b: string): Hunk[] {
  const A = splitLines(a);
  const B = splitLines(b);
  const hunks: Hunk[] = [];
  let aLine = 1;
  let bLine = 1;
  let current: Hunk | null = null;
  for (const op of diffOps(a, b)) {
    if (op.kind === "same") {
      current = null;
      aLine++;
      bLine++;
      continue;
    }
    if (!current) {
      current = { kind: "block", a: { start: aLine, lines: [] }, b: { start: bLine, lines: [] } };
      hunks.push(current);
    }
    if (op.kind === "del") {
      current.a.lines.push(op.line);
      aLine++;
    } else {
      current.b.lines.push(op.line);
      bLine++;
    }
    current.kind = current.a.lines.length > 0 && current.b.lines.length > 0 ? "inline" : "block";
  }
  markEofNewline(hunks, A, B);
  return hunks;
}

/** A side is unterminated when it has a last line and that line carries no newline. */
const unterminated = (s: Split) => s.lines.length > 0 && !s.eofNewline;

const covers = (h: Hunk, side: "a" | "b", lastLine: number) =>
  h[side].lines.length > 0 && h[side].start + h[side].lines.length - 1 === lastLine;

/**
 * Bring the unterminated side's last line into a hunk so the difference is visible. Only called
 * when that line is in no hunk — otherwise the marker already has somewhere to land. `side` is
 * the side whose last line is not yet covered by any hunk; the merge branch extends the trailing
 * hunk backwards along that side, whichever side it is.
 */
function forceTrailingHunk(hunks: Hunk[], A: Split, B: Split, side: "a" | "b"): void {
  const aLast = A.lines.length;
  const bLast = B.lines.length;
  if (aLast === 0 || bLast === 0) return;
  const last = side === "a" ? aLast : bLast;
  const tail = hunks[hunks.length - 1];
  if (tail && tail[side].start === last + 1) {
    tail.a.start -= 1;
    tail.a.lines.unshift(A.lines[tail.a.start - 1]);
    tail.b.start -= 1;
    tail.b.lines.unshift(B.lines[tail.b.start - 1]);
    tail.kind = tail.a.lines.length > 0 && tail.b.lines.length > 0 ? "inline" : "block";
    return;
  }
  hunks.push({
    kind: "inline",
    a: { start: aLast, lines: [A.lines[aLast - 1]] },
    b: { start: bLast, lines: [B.lines[bLast - 1]] },
  });
}

function markEofNewline(hunks: Hunk[], A: Split, B: Split): void {
  const aOpen = unterminated(A);
  const bOpen = unterminated(B);
  if (!aOpen && !bOpen) return;
  const aLast = A.lines.length;
  const bLast = B.lines.length;

  if (aOpen !== bOpen) {
    const side = aOpen ? "a" : "b";
    const last = aOpen ? aLast : bLast;
    const other = aOpen ? B : A;
    const otherTerminated = other.lines.length > 0 && other.eofNewline;
    if (otherTerminated && !hunks.some((h) => covers(h, side, last))) forceTrailingHunk(hunks, A, B, side);
  }

  for (const h of hunks) {
    if (aOpen && covers(h, "a", aLast)) h.a.noEofNewline = true;
    if (bOpen && covers(h, "b", bLast)) h.b.noEofNewline = true;
  }
}

export interface RenderOptions {
  /** Wrap each line; the CLI passes picocolors. Identity by default, so the core stays colour-free. */
  paint?: { same: (s: string) => string; del: (s: string) => string; add: (s: string) => string };
}

const plain = (s: string) => s;

/** Line-marked rendering with long unchanged runs collapsed. Used by `craftar diff`. */
export function renderDiff(a: string, b: string, options: RenderOptions = {}): string {
  const paint = options.paint ?? { same: plain, del: plain, add: plain };
  const A = splitLines(a);
  const B = splitLines(b);
  const ops = diffOps(a, b);
  const lastIndexOfKinds = (kinds: Array<DiffOp["kind"]>) => {
    for (let i = ops.length - 1; i >= 0; i--) if (kinds.includes(ops[i].kind)) return i;
    return -1;
  };
  // diffOps has no equivalent of diffLines' forceTrailingHunk: when the op the marker would
  // attach to is a context line, the reader cannot tell which side lacks the final newline.
  // Split that op — not merely the last one — into a del/add pair so the marker has a side to
  // attach to (see Task 2 ruling, generalized). Only when exactly one side is unterminated:
  // with neither side terminated there is no difference in termination to attribute, and
  // diffLines likewise declines to flag a shared context line.
  const aOpen = unterminated(A);
  const bOpen = unterminated(B);
  if (aOpen !== bOpen) {
    const kinds: Array<DiffOp["kind"]> = aOpen ? ["same", "del"] : ["same", "add"];
    const i = lastIndexOfKinds(kinds);
    if (i >= 0 && ops[i].kind === "same") {
      ops.splice(i, 1, { kind: "del", line: ops[i].line }, { kind: "add", line: ops[i].line });
    }
  }
  // Recomputed after the splice, so the indices are the ones the loop below will see.
  const aEnd = aOpen ? lastIndexOfKinds(["same", "del"]) : -1;
  const bEnd = bOpen ? lastIndexOfKinds(["same", "add"]) : -1;
  // The marker attaches only to a "del" or an "add", never to a context line: on a "same" op the
  // reader cannot tell which side lacks the final newline. With exactly one side unterminated the
  // splice above has already manufactured a del/add pair, so the index is never "same" there.
  // With both sides unterminated the shared context line genuinely did not change on either side
  // — splitting it would invent a del/add pair for an unchanged line — so the index is dropped
  // instead, which is also what diffLines does with it.
  // Painted with the side it follows, the way `forge diff` paints its own copy in `cli.ts`.
  const attachable = (i: number) => i >= 0 && ops[i].kind !== "same";
  const markAt = new Map<number, (s: string) => string>();
  if (attachable(aEnd)) markAt.set(aEnd, paint.del);
  if (attachable(bEnd)) markAt.set(bEnd, paint.add);
  const lines: Array<{ context: boolean; text: string }> = [];
  ops.forEach((op, i) => {
    if (op.kind === "same") lines.push({ context: true, text: paint.same("  " + op.line) });
    else if (op.kind === "del") lines.push({ context: false, text: paint.del("- " + op.line) });
    else lines.push({ context: false, text: paint.add("+ " + op.line) });
    // context: false, so the collapsing run below never swallows the marker.
    const mark = markAt.get(i);
    if (mark) lines.push({ context: false, text: mark(NO_EOF_NEWLINE_MARKER) });
  });
  const res: string[] = [];
  let run: Array<{ context: boolean; text: string }> = [];
  const flush = () => {
    if (run.length > 6) {
      res.push(
        ...run.slice(0, 3).map((r) => r.text),
        paint.same(`  … ${run.length - 6} unchanged lines …`),
        ...run.slice(-3).map((r) => r.text),
      );
    } else {
      res.push(...run.map((r) => r.text));
    }
    run = [];
  };
  for (const line of lines) {
    if (line.context) run.push(line);
    else {
      flush();
      res.push(line.text);
    }
  }
  flush();
  return res.join("\n");
}
