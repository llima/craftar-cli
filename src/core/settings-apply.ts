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
