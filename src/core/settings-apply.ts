/**
 * Settings apply core logic (spec 52): the merge computation, the handler hash, the
 * file I/O (read, write, round-trip gate), and the diff. The merge is pure; the I/O
 * functions take an fsOps seam for testing.
 */
import { createHash } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { written } from "./capabilities.js";
import { TERMINAL_UNSAFE } from "./forge.js";
import { nameShaped } from "./integrations.js";
import { urlCredentialIn } from "./remote.js";
import { paramsFor, type Resolution } from "./resolve.js";
import { findSecrets } from "./secrets.js";
import { detectEol, hasBom, withEol, isUtf8, type Eol } from "./text.js";
import {
  authEnvNames,
  EXAMPLE_SETTINGS,
  HOOK_PATH_PATTERN,
  renderRegistration,
  settingsExample,
  type HooksObject,
} from "../emitters/shared.js";
import type { Plan, FileState } from "./sync.js";
import type { ResolvedIngredient } from "./resolve.js";
import type { Ingredient } from "../schema/index.js";

/* ------------------------------------------------------------------ */
/* cloneJson: deep copy into null-prototype objects (D1)               */
/* ------------------------------------------------------------------ */

/**
 * Deep clone a JSON value, rebuilding objects with null prototypes.
 * structuredClone does not preserve null prototypes; this does.
 */
function cloneJson(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(cloneJson);
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(obj)) {
    out[key] = cloneJson((obj as Record<string, unknown>)[key]);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* sameHandler (spec 52 §5.1): key-order-insensitive deep equality     */
/* ------------------------------------------------------------------ */

/**
 * Deep equality check for JSON values, ignoring key order in objects.
 * Uses JSON.stringify with sorted keys for comparison. Arrays are compared in order.
 * Moved from doctor.ts (was sameJsonValue); now shared with settings apply.
 */
export function sameHandler(a: unknown, b: unknown): boolean {
  const sortKeys = (obj: unknown): unknown => {
    if (obj === null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(sortKeys);
    // Null-prototype object: a __proto__ key is an own key, not the prototype.
    const sorted: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  };
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

/* ------------------------------------------------------------------ */
/* PlannedRegistration (spec 52 §3.1)                                  */
/* ------------------------------------------------------------------ */

/** A planned hook registration entry after rendering (spec 52 §3.1). */
export interface PlannedRegistration {
  ref: string;
  index: number;
  event: string;
  matcher: string | undefined;
  handler: unknown;
  hasMissing: boolean;
}

/**
 * The planned registrations from a plan's resolution: walk the hooks written by claude-code,
 * render each registration entry through renderRegistration. Returns entries in plan order.
 * Returns [] when claude-code is not among the targets.
 *
 * Moved from the top of doctor.ts's hooksRegistered; now shared with settings apply.
 */
export function plannedRegistrations(p: Plan): PlannedRegistration[] {
  if (!p.resolution.targets.includes("claude-code")) return [];

  const entries: PlannedRegistration[] = [];

  // The walk yields hooks written by claude-code
  const walk = written(p.resolution, "claude-code", () => {});
  for (const ing of walk) {
    if (ing.meta.type !== "hook") continue;
    const hookMeta = ing.meta;
    if (!hookMeta.registration) continue;

    const declared = hookMeta.params ?? {};
    const params = paramsFor(ing, p.resolution);

    for (let i = 0; i < hookMeta.registration.length; i++) {
      const entry = hookMeta.registration[i];

      // Render the entry using the shared builder (spec 43 §7.2)
      const { event, matcher, handler, rendered } = renderRegistration(entry, declared, params, ing.ref);

      // Check if this entry's render left a declared key with no value (spec 43 §6)
      const hasMissing = rendered.missing.length > 0;

      entries.push({
        ref: ing.ref,
        index: i,
        event,
        matcher,
        handler,
        hasMissing,
      });
    }
  }

  return entries;
}

/* ------------------------------------------------------------------ */
/* wantedEnvNames (spec 52 §4.1 step 3)                                */
/* ------------------------------------------------------------------ */

/**
 * The env names the plan's claude-code walk yields (spec 52 §4.1 step 3): the union of
 * authEnvNames from MCP servers claude-code writes. Returns [] when claude-code is not
 * among the targets.
 */
export function wantedEnvNames(p: Plan): string[] {
  if (!p.resolution.targets.includes("claude-code")) return [];

  // Collect MCP ingredients from the claude-code walk, exactly as claude-code.ts does
  const mcp: ResolvedIngredient[] = [];
  const walk = written(p.resolution, "claude-code", () => {});
  for (const ing of walk) {
    if (ing.meta.type === "mcp") mcp.push(ing);
  }

  return authEnvNames(mcp);
}

/* ------------------------------------------------------------------ */
/* wantedHooksObject (spec 52 D6)                                      */
/* ------------------------------------------------------------------ */

/**
 * Build the hooks object from planned registrations (spec 52 D6):
 * one group per entry, matcher key only when defined, event keys in first-seen order.
 */
export function wantedHooksObject(registrations: readonly PlannedRegistration[]): HooksObject | null {
  if (registrations.length === 0) return null;

  const result: HooksObject = Object.create(null);

  for (const r of registrations) {
    // Build the group with keys in order: matcher (optional), hooks
    const group: { matcher?: string; hooks: unknown[] } = Object.create(null);
    if (r.matcher !== undefined) group.matcher = r.matcher;
    group.hooks = [r.handler];

    // Add to the event's list (create if first)
    if (!result[r.event]) {
      result[r.event] = [];
    }
    (result[r.event] as unknown[]).push(group);
  }

  return Object.keys(result).length > 0 ? result : null;
}

/* ------------------------------------------------------------------ */
/* wantedBlocks (spec 52 §4.1 step 3, D6 refactor)                     */
/* ------------------------------------------------------------------ */

/** The wanted structure returned by wantedBlocks (spec 52 D6). */
export interface WantedBlocks {
  envNames: string[];
  registrations: PlannedRegistration[];
}

/**
 * The wanted env names and registrations from the plan (spec 52 §4.1 step 3, D6):
 * - null when the plan writes no EXAMPLE_SETTINGS file (claude-code not among targets,
 *   or no registration and no authEnv).
 * - Otherwise { envNames, registrations }.
 */
export function wantedBlocks(p: Plan): WantedBlocks | null {
  // Check if the plan writes the EXAMPLE_SETTINGS file
  const hasExampleFile = p.files.some((f) => f.path === EXAMPLE_SETTINGS);
  if (!hasExampleFile) return null;

  return {
    envNames: wantedEnvNames(p),
    registrations: plannedRegistrations(p),
  };
}

/* ------------------------------------------------------------------ */
/* handlerHash (spec 52 §5.3)                                          */
/* ------------------------------------------------------------------ */

/**
 * The canonical form of a handler: keys sorted recursively (spec 52 §5.3).
 * A third createHash that hashes no file bytes — beside projectName and statusDigest.
 */
function canonical(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(canonical);
  // Null-prototype object: a __proto__ key is an own key
  const sorted: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonical((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * The hash of a handler for the registry record (spec 52 §5.3):
 * sha256 hex of JSON.stringify([event, matcher ?? null, canonical(handler)]).
 * A literal matcher "-" and an absent one never collide.
 */
export function handlerHash(event: string, matcher: string | undefined, handler: unknown): string {
  const data = JSON.stringify([event, matcher ?? null, canonical(handler)]);
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/* ------------------------------------------------------------------ */
/* SettingsShapeError (spec 52 §5.2)                                   */
/* ------------------------------------------------------------------ */

/** Thrown when the settings file has a shape craftar refuses (spec 52 §5.2). */
export class SettingsShapeError extends Error {
  /** The kind of error (for special handling of absent/empty). */
  readonly kind: "absent" | "empty" | "shape";
  /** The file stats, if available (for empty files to preserve mode). */
  readonly stats?: Stats;

  constructor(message: string, kind: "absent" | "empty" | "shape" = "shape", stats?: Stats) {
    super(message);
    this.name = "SettingsShapeError";
    this.kind = kind;
    this.stats = stats;
  }
}

/* ------------------------------------------------------------------ */
/* MergeResult and the diff types (spec 52 §7)                         */
/* ------------------------------------------------------------------ */

/** One added handler in the diff (spec 52 §7). */
export interface AddedHandler {
  event: string;
  matcher: string | undefined;
  handler: unknown;
  ref: string;
  index: number;
}

/** One removed handler in the diff (spec 52 §7). */
export interface RemovedHandler {
  event: string;
  matcher: string | undefined;
  handler: unknown;
}

/** The diff of a merge (spec 52 §7). */
export interface MergeDiff {
  envAdded: string[];
  envPresent: number;
  added: AddedHandler[];
  removed: RemovedHandler[];
  moved: number;
  duplicatesRemoved: number;
  localKept: number;
  sameCommandLocal: number;
  emptiedKept: number;
  otherKeys: string[];
}

/** The result of mergeSettings (spec 52 §5). */
export interface MergeResult {
  changed: boolean;
  value: Record<string, unknown>;
  diff: MergeDiff;
}

/* ------------------------------------------------------------------ */
/* WantedHandlerInfo for the merge                                     */
/* ------------------------------------------------------------------ */

/** A wanted handler with its location info (spec 52 §3.1). */
interface WantedHandlerInfo {
  event: string;
  matcher: string | undefined;
  handler: unknown;
  ref: string;
  index: number;
  hash: string;
}

/* ------------------------------------------------------------------ */
/* mergeSettings (spec 52 §5)                                          */
/* ------------------------------------------------------------------ */

/**
 * Merge the wanted hooks and env names into a settings object (spec 52 §5).
 *
 * @param current - The parsed settings file (null-prototype objects), or null if absent.
 * @param wanted - The wanted env names and registrations from the plan (from wantedBlocks).
 * @param recorded - The set of handler hashes from the last apply on this machine.
 * @returns The merge result with changed flag, merged value, and diff.
 *
 * Throws SettingsShapeError when hooks or env have an invalid shape.
 */
export function mergeSettings(
  current: Record<string, unknown> | null,
  wanted: WantedBlocks | { env: Record<string, string> | null; hooks: HooksObject | null },
  recorded: Set<string>,
): MergeResult {
  // Normalize wanted to the new shape (support both old and new API)
  let wantedEnvNames: string[];
  let wantedRegistrations: PlannedRegistration[];

  if ("envNames" in wanted) {
    // New API
    wantedEnvNames = wanted.envNames;
    wantedRegistrations = wanted.registrations;
  } else {
    // Old API (for backward compatibility during transition)
    wantedEnvNames = wanted.env ? Object.keys(wanted.env) : [];
    wantedRegistrations = [];
    if (wanted.hooks) {
      for (const event of Object.keys(wanted.hooks)) {
        const groups = wanted.hooks[event];
        for (let gi = 0; gi < groups.length; gi++) {
          const group = groups[gi];
          for (const handler of group.hooks) {
            wantedRegistrations.push({
              ref: "",
              index: gi,
              event,
              matcher: group.matcher,
              handler,
              hasMissing: false,
            });
          }
        }
      }
    }
  }

  // Build the wanted handlers list with hashes
  const wantedHandlers: WantedHandlerInfo[] = wantedRegistrations.map((r) => ({
    event: r.event,
    matcher: r.matcher,
    handler: r.handler,
    ref: r.ref,
    index: r.index,
    hash: handlerHash(r.event, r.matcher, r.handler),
  }));
  const wantedHashes = new Set(wantedHandlers.map((w) => w.hash));

  // Diff tracking
  const diff: MergeDiff = {
    envAdded: [],
    envPresent: 0,
    added: [],
    removed: [],
    moved: 0,
    duplicatesRemoved: 0,
    localKept: 0,
    sameCommandLocal: 0,
    emptiedKept: 0,
    otherKeys: [],
  };

  // D2: Decide key existence on current, not on value after edits
  const currentHasEnv = current !== null && Object.hasOwn(current, "env");
  const currentHasHooks = current !== null && Object.hasOwn(current, "hooks");

  // D4: Process env and hooks independently, track changes separately
  let envChanged = false;
  let hooksChanged = false;

  // D1: Deep clone current to avoid mutation
  const value: Record<string, unknown> = current !== null
    ? cloneJson(current) as Record<string, unknown>
    : Object.create(null);

  // ---- Process env (spec 52 §5.4) ----
  if (wantedEnvNames.length > 0) {
    let existingEnv = value.env;

    // Validate env shape
    if (existingEnv !== undefined) {
      if (existingEnv === null || typeof existingEnv !== "object" || Array.isArray(existingEnv)) {
        throw new SettingsShapeError(".claude/settings.json: env is not an object — fix it by hand");
      }
    }

    // Build new env: keep existing values, add missing names with ""
    const newEnv: Record<string, unknown> = Object.create(null);
    if (existingEnv) {
      for (const key of Object.keys(existingEnv)) {
        newEnv[key] = (existingEnv as Record<string, unknown>)[key];
      }
    }

    for (const name of wantedEnvNames) {
      if (Object.hasOwn(newEnv, name)) {
        diff.envPresent++;
      } else {
        newEnv[name] = "";
        diff.envAdded.push(name);
        envChanged = true;
      }
    }

    value.env = newEnv;
  }

  // ---- Process hooks (spec 52 §5.1–§5.2) ----
  // D5: Process hooks even when wanted is empty (to remove recorded handlers)
  const existingHooks = value.hooks;

  // Validate hooks shape if it exists
  if (existingHooks !== undefined) {
    if (existingHooks === null || typeof existingHooks !== "object" || Array.isArray(existingHooks)) {
      throw new SettingsShapeError(".claude/settings.json: hooks is not an object — fix it by hand");
    }
  }

  // Work with the hooks object (clone it to avoid mutation)
  const hooksObj = existingHooks
    ? cloneJson(existingHooks) as Record<string, unknown>
    : Object.create(null);

  // Track which wanted handlers are already present
  const presentWantedHashes = new Set<string>();
  // Track handlers to remove: { event, groupIndex, handlerIndex, hash, handler }
  const toRemove: Array<{
    event: string;
    groupIndex: number;
    handlerIndex: number;
    hash: string;
    handler: unknown;
    matcher: string | undefined;
  }> = [];

  // First pass: find all Forge handlers and wanted handlers
  for (const event of Object.keys(hooksObj)) {
    const eventList = hooksObj[event];

    // Validate event is a list
    if (!Array.isArray(eventList)) {
      const eventLabel = nameShaped(event) ? event : `#${Object.keys(hooksObj).indexOf(event) + 1}`;
      throw new SettingsShapeError(`.claude/settings.json: hooks.${eventLabel} is not a list — fix it by hand`);
    }

    for (let gi = 0; gi < eventList.length; gi++) {
      const group = eventList[gi];

      // Validate group is an object with a hooks list
      if (group === null || typeof group !== "object" || Array.isArray(group)) {
        const eventLabel = nameShaped(event) ? event : `#${Object.keys(hooksObj).indexOf(event) + 1}`;
        throw new SettingsShapeError(`.claude/settings.json: hooks.${eventLabel} holds a group that is not an object with a hooks list — fix it by hand`);
      }

      const groupObj = group as Record<string, unknown>;
      const groupHooks = groupObj.hooks;

      if (!Array.isArray(groupHooks)) {
        const eventLabel = nameShaped(event) ? event : `#${Object.keys(hooksObj).indexOf(event) + 1}`;
        throw new SettingsShapeError(`.claude/settings.json: hooks.${eventLabel} holds a group that is not an object with a hooks list — fix it by hand`);
      }

      const groupMatcher = groupObj.matcher as string | undefined;

      for (let hi = 0; hi < groupHooks.length; hi++) {
        const handler = groupHooks[hi];
        const hash = handlerHash(event, groupMatcher, handler);

        // Is this a Forge handler? (equal to wanted, or in recorded)
        const isForge = wantedHashes.has(hash) || recorded.has(hash);
        const isWanted = wantedHashes.has(hash);

        if (isForge) {
          // D3: Record handler BEFORE removal
          toRemove.push({ event, groupIndex: gi, handlerIndex: hi, hash, handler, matcher: groupMatcher });
          if (isWanted) {
            presentWantedHashes.add(hash);
          }
        } else {
          // Local handler
          diff.localKept++;

          // Check if it has the same command/args as a wanted handler
          if (typeof handler === "object" && handler !== null) {
            const handlerObj = handler as Record<string, unknown>;
            for (const w of wantedHandlers) {
              if (
                typeof w.handler === "object" &&
                w.handler !== null &&
                w.event === event &&
                w.matcher === groupMatcher
              ) {
                const wObj = w.handler as Record<string, unknown>;
                if (handlerObj.command === wObj.command && sameHandler(handlerObj.args, wObj.args)) {
                  diff.sameCommandLocal++;
                }
              }
            }
          }
        }
      }
    }
  }

  // Check for idempotence: every wanted present, no recorded-not-wanted present
  const recordedNotWantedPresent = toRemove.some((r) => recorded.has(r.hash) && !wantedHashes.has(r.hash));
  const allWantedPresent = wantedHandlers.every((w) => presentWantedHashes.has(w.hash));

  // D4: Hooks unchanged when all wanted present and no stale recorded
  if (allWantedPresent && !recordedNotWantedPresent) {
    // Hooks are unchanged
    // Keep original hooks from current (not the cloned one)
    if (currentHasHooks) {
      value.hooks = cloneJson(current!.hooks);
    }
  } else {
    // Hooks need to change
    hooksChanged = true;

    // D3: Group removals by event and group, sort by descending handler index within each group
    const removalsByGroup = new Map<string, typeof toRemove>();
    for (const r of toRemove) {
      const key = `${r.event}:${r.groupIndex}`;
      if (!removalsByGroup.has(key)) removalsByGroup.set(key, []);
      removalsByGroup.get(key)!.push(r);
    }

    // D3: Process removals per group, descending handler index
    for (const removals of removalsByGroup.values()) {
      removals.sort((a, b) => b.handlerIndex - a.handlerIndex);
      for (const r of removals) {
        const eventList = hooksObj[r.event] as unknown[];
        const group = eventList[r.groupIndex] as Record<string, unknown>;
        const groupHooks = group.hooks as unknown[];

        // D3: Record removed handler BEFORE splice (already captured in toRemove)
        if (recorded.has(r.hash) && !wantedHashes.has(r.hash)) {
          diff.removed.push({ event: r.event, matcher: r.matcher, handler: r.handler });
        }

        // Remove the handler
        groupHooks.splice(r.handlerIndex, 1);
      }
    }

    // Count duplicates removed
    const removedCounts = new Map<string, number>();
    for (const r of toRemove) {
      removedCounts.set(r.hash, (removedCounts.get(r.hash) ?? 0) + 1);
    }
    for (const [hash, count] of removedCounts) {
      if (wantedHashes.has(hash) && count > 1) {
        diff.duplicatesRemoved += count - 1;
      }
    }

    // Clean up empty groups
    for (const event of Object.keys(hooksObj)) {
      const eventList = hooksObj[event] as unknown[];
      const keptGroups: unknown[] = [];

      for (const group of eventList) {
        const groupObj = group as Record<string, unknown>;
        const groupHooks = groupObj.hooks as unknown[];

        if (groupHooks.length === 0) {
          // Check if group has other keys besides matcher and hooks
          const otherKeys = Object.keys(groupObj).filter((k) => k !== "matcher" && k !== "hooks");
          if (otherKeys.length > 0) {
            // Keep with empty hooks
            keptGroups.push(group);
            diff.emptiedKept++;
          }
          // else: remove the group
        } else {
          keptGroups.push(group);
        }
      }

      if (keptGroups.length === 0) {
        // Remove the event if all groups were removed by this process
        // BUT if the event was already [] before, keep it
        const wasOriginallyEmpty = current !== null &&
          typeof current.hooks === "object" &&
          current.hooks !== null &&
          Array.isArray((current.hooks as Record<string, unknown>)[event]) &&
          ((current.hooks as Record<string, unknown>)[event] as unknown[]).length === 0;

        if (wasOriginallyEmpty) {
          hooksObj[event] = [];
        } else {
          delete hooksObj[event];
        }
      } else {
        hooksObj[event] = keptGroups;
      }
    }

    // Append wanted handlers at the end of their events
    const existingEvents = new Set(Object.keys(hooksObj));
    for (const w of wantedHandlers) {
      // Build the group
      const group: Record<string, unknown> = Object.create(null);
      if (w.matcher !== undefined) group.matcher = w.matcher;
      group.hooks = [w.handler];

      if (!existingEvents.has(w.event)) {
        hooksObj[w.event] = [];
        existingEvents.add(w.event);
      }

      (hooksObj[w.event] as unknown[]).push(group);

      // Track as added (unless it was already present and just moved)
      if (presentWantedHashes.has(w.hash)) {
        diff.moved++;
      } else {
        diff.added.push({ event: w.event, matcher: w.matcher, handler: w.handler, ref: w.ref, index: w.index });
      }
    }

    value.hooks = hooksObj;
  }

  // Track other top-level keys
  for (const key of Object.keys(value)) {
    if (key !== "env" && key !== "hooks") {
      if (nameShaped(key)) {
        diff.otherKeys.push(key);
      }
    }
  }

  // D4: Determine overall changed status
  const changed = envChanged || hooksChanged;

  // If unchanged, return current as-is (same object reference)
  if (!changed) {
    return { changed: false, value: current!, diff };
  }

  // D2: Ensure key placement based on CURRENT's keys, not value's
  const result = ensureKeyPlacement(
    value,
    currentHasEnv,
    currentHasHooks,
    wantedEnvNames.length > 0,
    wantedHandlers.length > 0,
  );

  return { changed: true, value: result, diff };
}

/**
 * Ensure env and hooks keys are placed correctly (spec 52 §5.5, D2):
 * - In a file with neither: env first, then hooks at the TOP
 * - In a file with one: the other goes right after it
 *
 * D2: Decision is based on what CURRENT had, not what value has after edits.
 */
function ensureKeyPlacement(
  obj: Record<string, unknown>,
  currentHadEnv: boolean,
  currentHadHooks: boolean,
  wantsEnv: boolean,
  wantsHooks: boolean,
): Record<string, unknown> {
  const keys = Object.keys(obj);

  // If current had both, or neither is wanted, return as-is
  if ((currentHadEnv && currentHadHooks) || (!wantsEnv && !wantsHooks)) {
    return obj;
  }

  const result: Record<string, unknown> = Object.create(null);

  if (!currentHadEnv && !currentHadHooks) {
    // Current had neither: add env first, then hooks, then rest
    if (wantsEnv && obj.env !== undefined) result.env = obj.env;
    if (wantsHooks && obj.hooks !== undefined) result.hooks = obj.hooks;
    for (const key of keys) {
      if (key !== "env" && key !== "hooks") result[key] = obj[key];
    }
  } else if (currentHadEnv && !currentHadHooks && wantsHooks) {
    // Current had env only, now adding hooks: hooks right after env
    for (const key of keys) {
      result[key] = obj[key];
      if (key === "env" && obj.hooks !== undefined) {
        result.hooks = obj.hooks;
      }
    }
  } else if (!currentHadEnv && currentHadHooks && wantsEnv) {
    // Current had hooks only, now adding env: env right after hooks
    for (const key of keys) {
      result[key] = obj[key];
      if (key === "hooks" && obj.env !== undefined) {
        result.env = obj.env;
      }
    }
  } else {
    return obj;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* File I/O: readSettingsFile, roundTrips, serialize, writeSettingsFile */
/* (spec 52 §6)                                                         */
/* ------------------------------------------------------------------ */

/** BOM as a Buffer. */
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Result of reading the settings file (spec 52 §6.2). */
export interface ReadSettingsResult {
  /** The parsed value (null-prototype object). */
  value: Record<string, unknown>;
  /** The raw bytes read. */
  bytes: Buffer;
  /** The detected indent (2 spaces, 4 spaces, tab, or null for one-line). */
  indent: string | null;
  /** The detected line ending. */
  eol: Eol;
  /** Whether the file had a UTF-8 BOM. */
  bom: boolean;
  /** Whether the file had a final newline. */
  finalNewline: boolean;
  /** The file stats. */
  stats: Stats;
}

/**
 * Detect the indent of a JSON file from its first indented line.
 * Returns "  " (2 spaces), "    " (4 spaces), "\t" (tab), or null (one-line).
 */
function detectIndent(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^(\s+)/);
    if (match) {
      const ws = match[1];
      if (ws.startsWith("\t")) return "\t";
      if (ws.startsWith("    ")) return "    ";
      if (ws.startsWith("  ")) return "  ";
      // Any other whitespace (e.g. 3 spaces) — return as-is for round-trip check
      return ws;
    }
  }
  return null; // one-line file
}

/**
 * Read and validate the settings file (spec 52 §6.2).
 *
 * Returns a SettingsShapeError for:
 * - Not UTF-8
 * - Not valid JSON
 * - Not a JSON object
 * - Does not round-trip (spec 52 §6.2)
 */
export async function readSettingsFile(
  filePath: string,
): Promise<{ ok: true; result: ReadSettingsResult } | { ok: false; error: SettingsShapeError }> {
  let bytes: Buffer;
  let stats: Stats;
  try {
    [bytes, stats] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      // File does not exist — return a special marker so caller knows to create
      return { ok: false, error: new SettingsShapeError("absent", "absent") };
    }
    throw e;
  }

  // Empty file (0 bytes or only whitespace/BOM) → treated as absent (spec 52 §6.2)
  const hasBomFlag = hasBom(bytes);
  const textRaw = bytes.toString("utf8");
  const textNoBom = hasBomFlag ? textRaw.slice(1) : textRaw;
  if (textNoBom.trim() === "") {
    // Return as absent with the stats (for mode preservation)
    return { ok: false, error: new SettingsShapeError("empty", "empty", stats) };
  }

  // Check UTF-8
  if (!isUtf8(bytes)) {
    return { ok: false, error: new SettingsShapeError(".claude/settings.json is not UTF-8") };
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(textNoBom);
  } catch {
    // Never print parser message (it quotes the text)
    return { ok: false, error: new SettingsShapeError(".claude/settings.json is not valid JSON — fix it by hand") };
  }

  // Must be an object
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: new SettingsShapeError(".claude/settings.json is not a JSON object — fix it by hand") };
  }

  // Clone into null-prototype object (D1)
  const value = cloneJson(parsed) as Record<string, unknown>;

  // Detect formatting
  const eol = detectEol(textRaw);
  const bom = hasBomFlag;
  const indent = detectIndent(textNoBom);
  const finalNewline = textRaw.endsWith("\n") || textRaw.endsWith("\r");

  // Round-trip check (spec 52 §6.2)
  const roundTripResult = roundTrips(value, bytes, indent, eol, bom, finalNewline);
  if (!roundTripResult.ok) {
    return {
      ok: false,
      error: new SettingsShapeError(
        ".claude/settings.json is not formatted as JSON.stringify writes it — reformat it once (2-space JSON) and run again",
      ),
    };
  }

  return { ok: true, result: { value, bytes, indent, eol, bom, finalNewline, stats } };
}

/**
 * Check if the value round-trips through serialize to the original bytes.
 * The indent must be 2 spaces, 4 spaces, or tab; any other indent fails the gate.
 */
export function roundTrips(
  value: Record<string, unknown>,
  originalBytes: Buffer,
  indent: string | null,
  eol: Eol,
  bom: boolean,
  finalNewline: boolean,
): { ok: true } | { ok: false; reason: string } {
  // Only allow standard indents (spec 52 §6.2)
  if (indent !== null && indent !== "  " && indent !== "    " && indent !== "\t") {
    return { ok: false, reason: "non-standard indent" };
  }

  const serialized = serialize(value, indent ?? "  ", eol, bom, finalNewline);
  if (serialized.equals(originalBytes)) {
    return { ok: true };
  }
  return { ok: false, reason: "bytes differ" };
}

/**
 * Serialize a value with the given formatting options.
 * Uses two spaces when indent is null (one-line → two-space, spec 52 §6.2).
 */
export function serialize(
  value: Record<string, unknown>,
  indent: string,
  eol: Eol,
  bom: boolean,
  finalNewline: boolean,
): Buffer {
  // JSON.stringify with the indent
  let text = JSON.stringify(value, null, indent);
  // Add final newline if needed
  if (finalNewline) text += "\n";
  // Apply EOL
  text = withEol(text, eol);
  // Apply BOM
  if (bom) {
    return Buffer.concat([UTF8_BOM, Buffer.from(text, "utf8")]);
  }
  return Buffer.from(text, "utf8");
}

/* ------------------------------------------------------------------ */
/* settingsDiffLines — the diff output (spec 52 §7)                    */
/* ------------------------------------------------------------------ */

/** The diff information for display. */
export interface SettingsDiffDisplay {
  envAdded: { name: string; shown: boolean }[];
  envPresent: number;
  envNotShaped: number;
  hooksAdded: { event: string; matcher: string | undefined; handler: unknown; ref: string; index: number }[];
  hooksRemoved: { event: string; matcher: string | undefined; handler: unknown; notShown: boolean }[];
  hooksLocalKept: number;
  hooksMoved: number;
  hooksDuplicatesRemoved: number;
  hooksEmptiedKept: number;
  hooksSameCommand: number;
  otherKeys: string[];
  otherKeysNotShaped: number;
  reformatted: boolean;
}

/**
 * Generate diff display info from the merge diff (spec 52 §7).
 * Handlers are filtered for terminal safety and secrets before display.
 */
export function settingsDiffLines(diff: MergeDiff, reformatted: boolean): SettingsDiffDisplay {
  const envAdded: { name: string; shown: boolean }[] = [];
  let envNotShaped = 0;

  for (const name of diff.envAdded) {
    if (nameShaped(name)) {
      envAdded.push({ name, shown: true });
    } else {
      envNotShaped++;
    }
  }

  const hooksAdded: SettingsDiffDisplay["hooksAdded"] = [];
  for (const h of diff.added) {
    hooksAdded.push({
      event: h.event,
      matcher: h.matcher,
      handler: h.handler,
      ref: h.ref,
      index: h.index,
    });
  }

  const hooksRemoved: SettingsDiffDisplay["hooksRemoved"] = [];
  for (const h of diff.removed) {
    const notShown = shouldHideHandler(h.matcher, h.handler);
    hooksRemoved.push({
      event: h.event,
      matcher: h.matcher,
      handler: h.handler,
      notShown,
    });
  }

  // Count other keys not shaped
  let otherKeysNotShaped = 0;
  const otherKeysShaped: string[] = [];
  for (const key of diff.otherKeys) {
    if (nameShaped(key)) {
      otherKeysShaped.push(key);
    } else {
      otherKeysNotShaped++;
    }
  }

  return {
    envAdded,
    envPresent: diff.envPresent,
    envNotShaped,
    hooksAdded,
    hooksRemoved,
    hooksLocalKept: diff.localKept,
    hooksMoved: diff.moved,
    hooksDuplicatesRemoved: diff.duplicatesRemoved,
    hooksEmptiedKept: diff.emptiedKept,
    hooksSameCommand: diff.sameCommandLocal,
    otherKeys: otherKeysShaped,
    otherKeysNotShaped,
    reformatted,
  };
}

/**
 * Whether a handler should be hidden in the diff (contains secrets or terminal-unsafe chars).
 */
function shouldHideHandler(matcher: string | undefined, handler: unknown): boolean {
  // Check matcher
  if (matcher !== undefined) {
    if (TERMINAL_UNSAFE.test(matcher)) return true;
    if (findSecrets(matcher).length > 0) return true;
    if (urlCredentialIn(matcher)) return true;
  }

  // Check handler as JSON string
  const handlerStr = JSON.stringify(handler);
  if (TERMINAL_UNSAFE.test(handlerStr)) return true;
  if (findSecrets(handlerStr).length > 0) return true;
  if (urlCredentialIn(handlerStr)) return true;

  return false;
}

/**
 * Make a string safe for terminal display (remove C0, C1, bidirectional chars).
 */
export function terminalSafe(s: string): string {
  return s.replace(new RegExp(TERMINAL_UNSAFE.source, "g"), "");
}

/**
 * Format a handler for display: compact JSON with terminal safety.
 */
export function formatHandler(handler: unknown): string {
  return terminalSafe(JSON.stringify(handler));
}

/**
 * Format matcher for display: quoted or "no matcher".
 */
export function formatMatcher(matcher: string | undefined): string {
  if (matcher === undefined) return "no matcher";
  return `matcher ${JSON.stringify(terminalSafe(matcher))}`;
}

/* ------------------------------------------------------------------ */
/* missingHookWarnings — warn about missing .claude/hooks/<x> (§4.1 step 4) */
/* ------------------------------------------------------------------ */

/**
 * Check for missing or non-unchanged .claude/hooks/<x> files cited in registrations.
 * Returns warning messages (spec 52 §4.1 step 4).
 */
export function missingHookWarnings(
  registrations: readonly PlannedRegistration[],
  status: Map<string, FileState>,
): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const r of registrations) {
    const handler = r.handler as Record<string, unknown>;

    // Check command and args for hook paths
    const toCheck: string[] = [];
    if (typeof handler.command === "string") toCheck.push(handler.command);
    if (Array.isArray(handler.args)) {
      for (const arg of handler.args) {
        if (typeof arg === "string") toCheck.push(arg);
      }
    }

    for (const value of toCheck) {
      // Reset lastIndex since HOOK_PATH_PATTERN is /g
      HOOK_PATH_PATTERN.lastIndex = 0;
      let match;
      while ((match = HOOK_PATH_PATTERN.exec(value)) !== null) {
        const hookPath = `.claude/hooks/${match[1]}`;
        if (seen.has(hookPath)) continue;
        seen.add(hookPath);

        const state = status.get(hookPath);
        if (state && state !== "unchanged") {
          warnings.push(`.claude/hooks/${match[1]} is ${state} — run craftar sync first`);
        }
      }
    }
  }

  return warnings;
}

/* ------------------------------------------------------------------ */
/* writeSettingsFile — atomic write with temp file (spec 52 §6.4)      */
/* ------------------------------------------------------------------ */

/** Options for writeSettingsFile, allowing injection of fs operations for testing. */
export interface FsOps {
  writeFile: typeof fs.writeFile;
  readFile: typeof fs.readFile;
  rename: typeof fs.rename;
  unlink: typeof fs.unlink;
  chmod: typeof fs.chmod;
  stat: typeof fs.stat;
}

const defaultFsOps: FsOps = {
  writeFile: fs.writeFile,
  readFile: fs.readFile,
  rename: fs.rename,
  unlink: fs.unlink,
  chmod: fs.chmod,
  stat: fs.stat,
};

/**
 * Write settings.json atomically (spec 52 §6.4).
 *
 * - Creates a sibling temp file `.claude/settings.json.craftar-<pid>.tmp`
 * - Compares original bytes before rename
 * - Preserves mode on existing files, uses 0600 for new files (non-win32)
 * - Returns { written: true } on success, { written: false, error: string } on failure
 */
export async function writeSettingsFile(
  wsRoot: string,
  content: Buffer,
  originalBytes: Buffer | null,
  originalStats: Stats | null,
  fsOps: FsOps = defaultFsOps,
): Promise<{ written: true; created: boolean } | { written: false; error: string }> {
  const settingsPath = path.join(wsRoot, ".claude", "settings.json");
  const tempPath = path.join(wsRoot, ".claude", `settings.json.craftar-${process.pid}.tmp`);
  const created = originalBytes === null;

  // Ensure .claude directory exists (spec 52 §6.1: non-recursively, only that directory)
  try {
    await fs.mkdir(path.join(wsRoot, ".claude"));
  } catch (e) {
    // Ignore EEXIST — the directory already exists
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }

  // Write temp file with wx flag (fails if exists)
  try {
    await fsOps.writeFile(tempPath, content, { flag: "wx", mode: 0o600 });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EEXIST") {
      return {
        written: false,
        error: `.claude/settings.json.craftar-${process.pid}.tmp exists — remove it and run again`,
      };
    }
    throw e;
  }

  try {
    // Re-read original to check for changes (spec 52 §6.4 step 1)
    if (originalBytes !== null) {
      let currentBytes: Buffer;
      try {
        currentBytes = await fsOps.readFile(settingsPath);
      } catch (e) {
        // File was deleted between read and write
        await fsOps.unlink(tempPath).catch(() => {});
        return {
          written: false,
          error: ".claude/settings.json changed while craftar was reading it — run again",
        };
      }

      if (!currentBytes.equals(originalBytes)) {
        await fsOps.unlink(tempPath).catch(() => {});
        return {
          written: false,
          error: ".claude/settings.json changed while craftar was reading it — run again",
        };
      }
    } else {
      // Check file wasn't created while we were working
      try {
        await fsOps.stat(settingsPath);
        // File was created
        await fsOps.unlink(tempPath).catch(() => {});
        return {
          written: false,
          error: ".claude/settings.json changed while craftar was reading it — run again",
        };
      } catch (e) {
        // Expected: file still doesn't exist
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }

    // Preserve mode on existing file (non-win32)
    if (originalStats !== null && process.platform !== "win32") {
      await fsOps.chmod(tempPath, originalStats.mode & 0o777);
    }

    // Rename over the target
    try {
      await fsOps.rename(tempPath, settingsPath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      await fsOps.unlink(tempPath).catch(() => {});
      return {
        written: false,
        error: `could not replace .claude/settings.json (${err.code ?? "unknown"}) — close what holds it and run again`,
      };
    }

    return { written: true, created };
  } catch (e) {
    // Cleanup temp file on any error
    await fsOps.unlink(tempPath).catch(() => {});
    throw e;
  }
}
