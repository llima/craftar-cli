/**
 * Settings apply core logic (spec 52): the merge computation, the handler hash, and the
 * record. This module is pure — it reads no file system and holds no state.
 */
import { written } from "./capabilities.js";
import { paramsFor, type Resolution } from "./resolve.js";
import {
  authEnvNames,
  EXAMPLE_SETTINGS,
  hookRegistrations,
  renderRegistration,
  settingsExample,
  type HooksObject,
  type RenderedRegistration,
} from "../emitters/shared.js";
import type { Plan } from "./sync.js";
import type { ResolvedIngredient } from "./resolve.js";
import type { Ingredient } from "../schema/index.js";
import type { PlannedFile } from "../emitters/types.js";

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
/* wantedBlocks (spec 52 §4.1 step 3)                                  */
/* ------------------------------------------------------------------ */

/**
 * The wanted env and hooks blocks from the plan (spec 52 §4.1 step 3):
 * - null when the plan writes no EXAMPLE_SETTINGS file (claude-code not among targets,
 *   or no registration and no authEnv).
 * - Otherwise { env, hooks } where each is null or the object.
 *
 * env is a record of names → "" (the names from wantedEnvNames).
 * hooks is built exactly as hookRegistrations builds it.
 */
export function wantedBlocks(p: Plan): { env: Record<string, string> | null; hooks: HooksObject | null } | null {
  // Check if the plan writes the EXAMPLE_SETTINGS file
  const hasExampleFile = p.files.some((f) => f.path === EXAMPLE_SETTINGS);
  if (!hasExampleFile) return null;

  // Build env: names → ""
  const names = wantedEnvNames(p);
  const env: Record<string, string> | null = names.length > 0 ? Object.create(null) : null;
  if (env) {
    for (const name of names) env[name] = "";
  }

  // Build hooks: collect hook ingredients from the claude-code walk
  const hooks: ResolvedIngredient[] = [];
  const walk = written(p.resolution, "claude-code", () => {});
  for (const ing of walk) {
    if (ing.meta.type === "hook") hooks.push(ing);
  }

  // Build hooks object exactly as claude-code.ts does, using the shared hookRegistrations
  // We need to build a minimal EmitBase context for hookRegistrations
  const hooksObj = buildHooksObject(hooks, p.resolution);

  return { env, hooks: hooksObj };
}

/**
 * Build the hooks object as hookRegistrations does, but without the EmitBase context.
 * This reproduces the logic of hookRegistrations for pure use.
 */
function buildHooksObject(hooks: readonly ResolvedIngredient[], resolution: Resolution): HooksObject | null {
  // Filter to hooks with registration
  const withReg = hooks.filter(
    (ing): ing is ResolvedIngredient & { meta: Extract<Ingredient, { type: "hook" }> } =>
      ing.meta.type === "hook" && (ing.meta as Extract<Ingredient, { type: "hook" }>).registration !== undefined
  );

  if (withReg.length === 0) return null;

  // A null prototype map so __proto__ is a key, not the prototype
  const result: HooksObject = Object.create(null);

  for (const ing of withReg) {
    const meta = ing.meta;
    const declared = meta.params ?? {};
    const params = paramsFor(ing, resolution);

    for (let i = 0; i < meta.registration!.length; i++) {
      const entry = meta.registration![i];

      // Render the entry using the shared builder (spec 43 §7.2)
      const { event, matcher, handler } = renderRegistration(entry, declared, params, ing.ref);

      // Build the group with keys in order: matcher (optional), hooks
      const group: { matcher?: string; hooks: unknown[] } = Object.create(null);
      if (matcher !== undefined) group.matcher = matcher;
      group.hooks = [handler];

      // Add to the event's list (create if first)
      if (!result[event]) {
        result[event] = [];
      }
      (result[event] as unknown[]).push(group);
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

/* ------------------------------------------------------------------ */
/* handlerHash (spec 52 §5.3)                                          */
/* ------------------------------------------------------------------ */

import { createHash } from "node:crypto";
import { nameShaped } from "./integrations.js";

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
  constructor(message: string) {
    super(message);
    this.name = "SettingsShapeError";
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
 * @param wanted - The wanted env and hooks from the plan (from wantedBlocks).
 * @param recorded - The set of handler hashes from the last apply on this machine.
 * @returns The merge result with changed flag, merged value, and diff.
 *
 * Throws SettingsShapeError when hooks or env have an invalid shape.
 */
export function mergeSettings(
  current: Record<string, unknown> | null,
  wanted: { env: Record<string, string> | null; hooks: HooksObject | null },
  recorded: Set<string>,
): MergeResult {
  // Build the wanted handlers list with hashes
  const wantedHandlers: WantedHandlerInfo[] = [];
  if (wanted.hooks) {
    for (const event of Object.keys(wanted.hooks)) {
      const groups = wanted.hooks[event];
      for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi];
        const matcher = group.matcher;
        for (const handler of group.hooks) {
          const hash = handlerHash(event, matcher, handler);
          // Find ref/index from the wanted structure - we use gi as index since each group has one handler
          wantedHandlers.push({ event, matcher, handler, ref: "", index: gi, hash });
        }
      }
    }
  }
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

  // Start with an empty value or a copy of current
  const value: Record<string, unknown> = Object.create(null);
  if (current !== null) {
    for (const key of Object.keys(current)) {
      value[key] = current[key];
    }
  }

  // ---- Process env (spec 52 §5.4) ----
  const wantedEnv = wanted.env;
  if (wantedEnv && Object.keys(wantedEnv).length > 0) {
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

    for (const name of Object.keys(wantedEnv)) {
      if (Object.hasOwn(newEnv, name)) {
        diff.envPresent++;
      } else {
        newEnv[name] = "";
        diff.envAdded.push(name);
      }
    }

    value.env = newEnv;
  }

  // ---- Process hooks (spec 52 §5.1–§5.2) ----
  const wantedHooksObj = wanted.hooks;

  if (wantedHooksObj && Object.keys(wantedHooksObj).length > 0) {
    let existingHooks = value.hooks;

    // Validate hooks shape
    if (existingHooks !== undefined) {
      if (existingHooks === null || typeof existingHooks !== "object" || Array.isArray(existingHooks)) {
        throw new SettingsShapeError(".claude/settings.json: hooks is not an object — fix it by hand");
      }
    }

    // Work with the hooks object
    const hooksObj = (existingHooks ?? Object.create(null)) as Record<string, unknown>;

    // Track which wanted handlers are already present
    const presentWantedHashes = new Set<string>();
    // Track handlers to remove and where they are
    const toRemove: Array<{ event: string; groupIndex: number; handlerIndex: number; hash: string }> = [];

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
            toRemove.push({ event, groupIndex: gi, handlerIndex: hi, hash });
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

    if (allWantedPresent && !recordedNotWantedPresent) {
      // Unchanged: return current as-is
      // Handle key placement for env if needed
      const result = ensureKeyPlacement(value, wantedEnv !== null && Object.keys(wantedEnv).length > 0, true);
      if (diff.envAdded.length === 0) {
        return { changed: false, value: current ?? result, diff };
      }
    }

    // Remove Forge handlers
    const removedCounts = new Map<string, number>(); // hash -> count removed
    for (const r of toRemove) {
      removedCounts.set(r.hash, (removedCounts.get(r.hash) ?? 0) + 1);
    }

    // Actually perform the removal, processing from end to preserve indices
    const sortedToRemove = [...toRemove].sort((a, b) => {
      if (a.event !== b.event) return 0;
      if (a.groupIndex !== b.groupIndex) return b.groupIndex - a.groupIndex;
      return b.handlerIndex - a.handlerIndex;
    });

    for (const r of sortedToRemove) {
      const eventList = hooksObj[r.event] as unknown[];
      const group = eventList[r.groupIndex] as Record<string, unknown>;
      const groupHooks = group.hooks as unknown[];

      // Remove the handler
      groupHooks.splice(r.handlerIndex, 1);

      // Track if this was a removal of an old Forge handler
      if (recorded.has(r.hash) && !wantedHashes.has(r.hash)) {
        const matcher = group.matcher as string | undefined;
        diff.removed.push({ event: r.event, matcher, handler: groupHooks[r.handlerIndex] });
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

    // Count duplicates removed
    for (const [hash, count] of removedCounts) {
      if (wantedHashes.has(hash) && count > 1) {
        diff.duplicatesRemoved += count - 1;
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

  // Ensure key placement (spec 52 §5.5)
  const result = ensureKeyPlacement(
    value,
    wantedEnv !== null && Object.keys(wantedEnv).length > 0,
    wantedHooksObj !== null && Object.keys(wantedHooksObj).length > 0,
  );

  return { changed: true, value: result, diff };
}

/**
 * Ensure env and hooks keys are placed correctly (spec 52 §5.5):
 * - In a file with neither: env first, then hooks at the TOP
 * - In a file with one: the other goes right after it
 */
function ensureKeyPlacement(
  obj: Record<string, unknown>,
  hasEnv: boolean,
  hasHooks: boolean,
): Record<string, unknown> {
  const keys = Object.keys(obj);
  const hasExistingEnv = keys.includes("env");
  const hasExistingHooks = keys.includes("hooks");

  // If both already exist, or neither wanted, return as-is
  if ((hasExistingEnv && hasExistingHooks) || (!hasEnv && !hasHooks)) {
    return obj;
  }

  const result: Record<string, unknown> = Object.create(null);

  if (!hasExistingEnv && !hasExistingHooks) {
    // Neither exists: add env first, then hooks, then rest
    if (hasEnv && obj.env !== undefined) result.env = obj.env;
    if (hasHooks && obj.hooks !== undefined) result.hooks = obj.hooks;
    for (const key of keys) {
      if (key !== "env" && key !== "hooks") result[key] = obj[key];
    }
  } else if (hasExistingEnv && !hasExistingHooks && hasHooks) {
    // env exists, hooks doesn't: add hooks right after env
    for (const key of keys) {
      result[key] = obj[key];
      if (key === "env" && obj.hooks !== undefined) {
        result.hooks = obj.hooks;
      }
    }
  } else if (!hasExistingEnv && hasExistingHooks && hasEnv) {
    // hooks exists, env doesn't: add env right after hooks
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
