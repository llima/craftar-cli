import type { Target } from "../schema/index.js";
import type { FileStatus } from "./sync.js";
import { hashNormalized } from "./text.js";

/** Where the Forge stands for a hand-edited file: as the last sync left it, moved since, or no longer producing it. */
export type ForgeSide = "same" | "changed" | "removed";

/** One hand-edited file as `craftar drift show` lists it (spec 30 §4.2). */
export interface DriftRow {
  path: string;
  state: "drift" | "orphan-drift";
  target: Target;
  ingredient: string;
  forge: ForgeSide;
  promotable: boolean;
  /** Why `drift promote` would refuse it, from the state, the target and the type alone; null when it would not. */
  reason: string | null;
}

/** D4: the path is not a file craftar manages. Shared by cli.ts and drift-promote.ts. */
export const unmanaged = (p: string) =>
  `${p} is not a file craftar manages in this workspace — pass the workspace-relative path as \`craftar status\` prints it (forward slashes)`;

/** The static half of promote's refusals: it reads the status, never the Forge's git state. */
function staticReason(s: FileStatus): string | null {
  if (s.state === "orphan-drift") return "no longer produced";
  if (s.target === "kiro") return "kiro file";
  if (s.target === "agents-md") return "AGENTS.md";
  if (s.ingredient?.startsWith("mcp/")) return ".mcp.json";
  return null;
}

/** The hand-edited files among `statuses`, in the order given. Pure. */
export function driftList(statuses: FileStatus[]): DriftRow[] {
  const rows: DriftRow[] = [];
  for (const s of statuses) {
    if (s.state !== "drift" && s.state !== "orphan-drift") continue;
    // `same`: the lock's hash is the plan's, so only the hand edit separates the disk from the Forge.
    const forge: ForgeSide = s.state === "orphan-drift" ? "removed" : s.lock!.hash === hashNormalized(s.planned!.content) ? "same" : "changed";
    const reason = staticReason(s);
    rows.push({ path: s.path, state: s.state, target: s.target!, ingredient: s.ingredient ?? "", forge, promotable: reason === null, reason });
  }
  return rows;
}
