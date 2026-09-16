import { stripBom, toLf } from "./text.js";

export type DiffOp = { kind: "same" | "del" | "add"; line: string };

export interface Hunk {
  kind: "block" | "inline";
  a: { start: number; lines: string[] };
  b: { start: number; lines: string[] };
}

/**
 * LCS line diff. Both sides are normalized first (LF, no BOM), so a difference
 * that is only line endings or a BOM produces no ops other than "same".
 */
export function diffOps(a: string, b: string): DiffOp[] {
  const A = toLf(stripBom(a)).split("\n");
  const B = toLf(stripBom(b)).split("\n");
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
  return hunks;
}
