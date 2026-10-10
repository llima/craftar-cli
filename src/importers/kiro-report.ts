/** One `.kiro/` file that differs from what sync would generate for the imported profile (spec 29 §3). */
export interface KiroCollision {
  path: string;
  /** The ingredient the plan builds that path from. */
  from: string;
  workspaceLines: number;
  generatedLines: number;
  /** `STEERING_BIGGER`, or empty. */
  note: string;
}

/** The Kiro part of an import report (spec 29 §4.2): line counts and paths, never content. */
export type KiroReport =
  | { kind: "none" } // the workspace has no .kiro/
  | { kind: "not-computed"; message: string } // the plan could not be computed after the flush
  | { kind: "computed"; collisions: KiroCollision[]; unsourced: string[] };

/** The note of a steering mirror that grew past its rule — the hint that `--prefer-kiro` may apply. */
export const STEERING_BIGGER = "steering bigger than the rule";
