import type { Owner } from "../schema/index.js";
import type { FileStatus } from "./sync.js";
import { hashNormalized } from "./text.js";

/** Where the Forge stands for a hand-edited file: as the last sync left it, moved since, or no longer producing it. */
export type ForgeSide = "same" | "changed" | "removed";

/** One hand-edited file as `craftar drift show` lists it (spec 30 §4.2). */
export interface DriftRow {
  path: string;
  state: "drift" | "orphan-drift";
  target: Owner;
  ingredient: string;
  forge: ForgeSide;
  promotable: boolean;
  /** Why `drift promote` would refuse it, from the state, the target and the type alone; null when it would not. */
  reason: string | null;
}

/** D4: the path is not a file craftar manages. Shared by cli.ts and drift-promote.ts. */
export const unmanaged = (p: string) =>
  `${p} is not a file craftar manages in this workspace — pass the workspace-relative path as \`craftar status\` prints it (forward slashes)`;

/** The file is one of the MCP configuration files (`.mcp.json`, `.kiro/settings/mcp.json`, the example file): all are tagged `mcp/*`. */
export const mcpTagged = (s: Pick<FileStatus, "ingredient">): boolean => s.ingredient?.startsWith("mcp/") === true;

/** The reason of a file agents-md.primary reworded (spec 41 §4.10): promoting it would carry the rewording into the Forge. */
export const REWORDED_REASON = "reworded by agents-md.primary";

/** The reason of a file that holds the generated rules index (spec 44 §4.5): promoting it would carry sync-generated content into the Forge. */
export const INDEXED_REASON = "holds the rules index";

/**
 * The static half of promote's refusals: it reads the status, never the Forge's git state.
 * The order is: orphan, then service file (spec 31), then provided (spec 33i), then reworded (spec 41), then indexed (spec 44), then kiro, then
 * AGENTS.md, then .mcp.json.
 */
function staticReason(s: FileStatus, provided: Map<string, { slot: string; recipe: string }>, reworded: ReadonlySet<string>, indexed: ReadonlySet<string>): string | null {
  if (s.state === "orphan-drift") return "no longer produced";
  if (s.target === "services") return "service file";
  // Provided by integrations block — after "no longer produced" and "service file", before "kiro file"
  const prov = s.ingredient ? provided.get(s.ingredient) : undefined;
  if (prov) return `provided by integrations.${prov.slot}`;
  if (reworded.has(s.path)) return REWORDED_REASON;
  if (indexed.has(s.path)) return INDEXED_REASON;
  if (s.target === "kiro") return "kiro file";
  if (s.target === "agents-md") return "AGENTS.md";
  if (mcpTagged(s)) return ".mcp.json";
  return null;
}

/**
 * The hand-edited files among `statuses`, in the order given. Pure.
 * @param provided - Map from Forge ref to { slot, recipe } for ingredients the block provides (spec 33i).
 * @param reworded - The plan's `reworded` paths (spec 41 §4.10); empty with the mode off.
 * @param indexed - The plan's indexed paths (spec 44 §4.5); empty at schema 6.
 */
export function driftList(
  statuses: FileStatus[],
  provided: Map<string, { slot: string; recipe: string }> = new Map(),
  reworded: ReadonlySet<string> = new Set(),
  indexed: ReadonlySet<string> = new Set(),
): DriftRow[] {
  const rows: DriftRow[] = [];
  for (const s of statuses) {
    if (s.state !== "drift" && s.state !== "orphan-drift") continue;
    // `same`: the lock's hash is the plan's, so only the hand edit separates the disk from the Forge.
    const forge: ForgeSide = s.state === "orphan-drift" ? "removed" : s.lock!.hash === hashNormalized(s.planned!.content) ? "same" : "changed";
    const reason = staticReason(s, provided, reworded, indexed);
    rows.push({ path: s.path, state: s.state, target: s.target!, ingredient: s.ingredient ?? "", forge, promotable: reason === null, reason });
  }
  return rows;
}
