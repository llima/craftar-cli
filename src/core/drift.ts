import { promises as fs } from "node:fs";
import path from "node:path";
import { escapeReason } from "./contain.js";
import { templatedMetadataEdit } from "./metadata-params.js";
import type { Owner } from "../schema/index.js";
import type { FileStatus, Plan } from "./sync.js";
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
/** Spec 50 §5.6: a hand edit of a metadata field the Forge renders from a parameter; promoting it would freeze the value. */
export const METADATA_PARAM_REASON = "metadata renders a parameter";
/** Spec 55 §4.8: a file whose ingredient cites a list param — promoting the rendered text would freeze the list (D25). */
export const LIST_PARAM_REASON = "cites a list param";

/** Spec 54 §5.9: the reason a file from a parent's local is not promotable — no command writes a parent (D24). */
export const parentLocalReason = (parent: string): string => `local to ${parent}, which this profile extends`;

/**
 * The static half of promote's refusals: it reads the status, never the Forge's git state.
 * The order is: a path that escapes (spec 48), orphan, then service file (spec 31), then provided (spec 33i), then a
 * parent's local (spec 54), then reworded (spec 41), then indexed (spec 44), then a templated metadata field (spec 50),
 * then kiro, then AGENTS.md, then .mcp.json.
 */

function staticReason(s: FileStatus, provided: Map<string, { slot: string; recipe: string }>, reworded: ReadonlySet<string>, indexed: ReadonlySet<string>, metadata: ReadonlySet<string>, parentLocals: ReadonlyMap<string, string>, listCiting: ReadonlySet<string>): string | null {
  if (s.escapes) return escapeReason(s.escapes);
  if (s.state === "orphan-drift") return "no longer produced";
  if (s.target === "services") return "service file";
  // Provided by integrations block — after "no longer produced" and "service file", before "kiro file"
  const prov = s.ingredient ? provided.get(s.ingredient) : undefined;
  if (prov) return `provided by integrations.${prov.slot}`;
  const parent = s.ingredient ? parentLocals.get(s.ingredient) : undefined;
  if (parent !== undefined) return parentLocalReason(parent);
  if (reworded.has(s.path)) return REWORDED_REASON;
  if (indexed.has(s.path)) return INDEXED_REASON;
  if (metadata.has(s.path)) return METADATA_PARAM_REASON;
  if (s.ingredient && listCiting.has(s.ingredient)) return LIST_PARAM_REASON;
  if (s.target === "kiro") return "kiro file";
  if (s.target === "agents-md") return "AGENTS.md";
  if (mcpTagged(s)) return ".mcp.json";
  return null;
}

/**
 * The hand-edited files among `statuses`, in the order given. Pure.
 * @param provided - Map from Forge ref to { slot, recipe } for ingredients the block provides (spec 33i).
 * @param reworded - The plan's `reworded` paths (spec 41 §4.10); empty with the mode off.
 * @param indexed - The plan's indexed paths (spec 44 §4.5); empty below schema 7, and when no list was expanded.
 * @param metadata - The paths whose hand edit changes a templated metadata field (`metadataEdits`, spec 50 §5.6); empty below the gate.
 * @param parentLocals - The refs the profile resolves from a parent's local (`parentLocalsOf`, spec 54 §5.9), ref → parent.
 */
export function driftList(
  statuses: FileStatus[],
  provided: Map<string, { slot: string; recipe: string }> = new Map(),
  reworded: ReadonlySet<string> = new Set(),
  indexed: ReadonlySet<string> = new Set(),
  metadata: ReadonlySet<string> = new Set(),
  parentLocals: ReadonlyMap<string, string> = new Map(),
  listCiting: ReadonlySet<string> = new Set(),
): DriftRow[] {
  const rows: DriftRow[] = [];
  for (const s of statuses) {
    if (s.state !== "drift" && s.state !== "orphan-drift") continue;
    // `same`: the lock's hash is the plan's, so only the hand edit separates the disk from the Forge.
    const forge: ForgeSide = s.state === "orphan-drift" ? "removed" : s.lock!.hash === hashNormalized(s.planned!.content) ? "same" : "changed";
    const reason = staticReason(s, provided, reworded, indexed, metadata, parentLocals, listCiting);
    rows.push({ path: s.path, state: s.state, target: s.target!, ingredient: s.ingredient ?? "", forge, promotable: reason === null, reason });
  }
  return rows;
}

/**
 * Spec 50 §5.6: the `drift` paths of a `claude-code` file whose hand edit changes a metadata field the resolved
 * ingredient renders from a parameter (`templatedMetadataEdit`); empty below the metadata gate. Reads the disk file of
 * each such row only — never a row whose path escapes (spec 48).
 */
export async function metadataEdits(root: string, p: Plan, statuses: FileStatus[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!p.resolution.metadataParams) return out;
  const byRef = new Map(p.resolution.ingredients.map((i) => [i.ref as string, i]));
  for (const s of statuses) {
    if (s.state !== "drift" || s.escapes || s.target !== "claude-code" || !s.ingredient || !s.planned) continue;
    const ing = byRef.get(s.ingredient);
    if (!ing || (ing.meta.type !== "rule" && ing.meta.type !== "agent" && ing.meta.type !== "command")) continue;
    let disk: string;
    try {
      disk = await fs.readFile(path.join(root, s.path), "utf8");
    } catch {
      continue;
    }
    if (templatedMetadataEdit(ing.meta, s.planned.content.toString("utf8"), disk) !== null) out.add(s.path);
  }
  return out;
}
