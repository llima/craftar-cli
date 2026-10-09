import { existsSync } from "node:fs";
import { TARGETS, type Registry, type RegistryEntry } from "../schema/index.js";
import { countStates } from "./impact.js";
import { resolveHome } from "./home-lock.js";
import { checkInitFlags, checkLocalKeys, forgeSource, initLine, type InitInput, type InitPlan } from "./init.js";
import { planRecipeEdit, slotHeld } from "./recipe-edit.js";
import { readRegistry } from "./registry.js";
import { classifyForge, credentialFault } from "./remote.js";
import { resolve } from "./resolve.js";
import { loadForgeSource, type LoadedForge, type LoadOptions } from "./sync.js";
import type { LocalKey } from "./workspace-yaml.js";

/**
 * The interactive `init` flow (spec 28 §4.2): prompts injected through `InitIo`,
 * so the flow can be tested with scripted answers. This module never touches `process`,
 * `console` or `readline`, and writes nothing.
 */

export interface InitIo {
  /** One question; resolves to the line typed, or null when the input ended or was interrupted. */
  ask(question: string): Promise<string | null>;
  /** The confirmation: as `ask`, but only a line typed after the question is shown counts. */
  confirm(question: string): Promise<string | null>;
  say(line: string): void;
}

/** The Forge `init` offers (§4.3): the value to show and, for a remote one, the ref the registry recorded. */
export interface OfferedForge {
  forge: string;
  ref: string | null;
}

/**
 * The Forge last used on this machine (spec 28 §4.3): the entry with the most recent `lastSync`
 * whose Forge can be offered — a path entry by its `key` (skipped when `null` or the directory
 * is gone), a remote one by its `source` (skipped when `credentialFault`).
 */
export function lastForge(
  registry: Registry,
  exists: (dir: string) => boolean,
): OfferedForge | null {
  // Sort by lastSync descending (most recent first); ISO strings compare as text
  const sorted = [...registry.workspaces].sort((a, b) =>
    b.lastSync.localeCompare(a.lastSync),
  );

  for (const entry of sorted) {
    const offer = offerableForge(entry, exists);
    if (offer !== null) return offer;
  }
  return null;
}

function offerableForge(
  entry: RegistryEntry,
  exists: (dir: string) => boolean,
): OfferedForge | null {
  if (entry.forge.kind === "path") {
    // Skipped when key is null or the directory is gone
    if (entry.forge.key === null) return null;
    if (!exists(entry.forge.key)) return null;
    return { forge: entry.forge.key, ref: null };
  }
  // Remote entry
  if (credentialFault(entry.forge.source)) return null;
  return { forge: entry.forge.source, ref: entry.forge.ref };
}

/**
 * y, yes → true; n, no → false; anything else → null. Case-insensitive, trimmed.
 */
export function yesNo(answer: string): boolean | null {
  const a = answer.trim().toLowerCase();
  if (a === "y" || a === "yes") return true;
  if (a === "n" || a === "no") return false;
  return null;
}

/**
 * Step 9 of the interactive flow: says the summary (`initLine`) and the `first sync:` line,
 * asks through `io.confirm`, re-asks anything but yes/no, returns confirmed or cancelled.
 */
export async function confirmInit(
  init: InitPlan,
  root: string,
  io: InitIo,
  opts: { sync: boolean },
): Promise<"confirmed" | "cancelled"> {
  // Say the summary lines
  io.say(`craftar init — about to write craftar.yaml in ${root}`);
  io.say(`  ${initLine(init)}`);

  // first sync: counts or "nothing to write"
  const counts = countStates(init.statuses);
  if (counts.length === 0) {
    io.say("  first sync: nothing to write");
  } else {
    const parts = counts.map(([k, n]) => `${n} ${k}`);
    io.say(`  first sync: ${parts.join(", ")}`);
  }

  // The question wording depends on opts.sync
  const question = opts.sync
    ? "Write craftar.yaml and sync [yes]: "
    : "Write craftar.yaml [yes]: ";

  // Ask and re-ask until yes/no/null
  for (;;) {
    const answer = await io.confirm(question);
    if (answer === null) return "cancelled";
    if (answer === "") return "confirmed"; // Enter = yes
    const yn = yesNo(answer);
    if (yn === true) return "confirmed";
    if (yn === false) return "cancelled";
    // Not a yes/no answer: re-ask (without repeating the summary)
    io.say("answer yes or no");
  }
}

export interface InitAnswers {
  forge: string;
  ref?: string;
  profile: string;
  targets?: string[];
  addRecipes: string[];
  removeRecipes: string[];
  replace: boolean;
}

/** Characters that do not require quoting in a command-line value. */
const SAFE_CHARS = /^[A-Za-z0-9_./:@=+,-]+$/;

/**
 * Quote a value for the `again` line if needed. A value holding a character outside
 * `[A-Za-z0-9_./:@=+,-]` is wrapped in double quotes. `"` and `\` inside it are not escaped:
 * the line is for reading, not for shell execution.
 */
function maybeQuote(value: string): string {
  if (value === "") return '""';
  if (SAFE_CHARS.test(value)) return value;
  return `"${value}"`;
}

/**
 * Step 11 of the interactive flow: returns exactly `  again craftar init` followed by the flags
 * that reproduce the run.
 *
 * The caller guarantees `answers.forge` passed `credentialFault`; this function still refuses to
 * print one: when `credentialFault(answers.forge)` it throws.
 *
 * A value holding a character outside `[A-Za-z0-9_./:@=+,-]` is wrapped in double quotes.
 * `"` and `\` inside it are not escaped: the line is for reading, not promised to survive every
 * shell's quoting.
 */
export function againLine(
  answers: InitAnswers,
  given: { workspace?: string; sync: boolean; offline: boolean },
): string {
  // Defense: never print credentials
  if (credentialFault(answers.forge)) {
    throw new Error("againLine: the Forge holds credentials");
  }

  const parts: string[] = ["  again craftar init"];

  // --forge <v>
  parts.push(`--forge ${maybeQuote(answers.forge)}`);

  // --ref <v> (only when defined)
  if (answers.ref !== undefined) {
    parts.push(`--ref ${maybeQuote(answers.ref)}`);
  }

  // --profile <v>
  parts.push(`--profile ${maybeQuote(answers.profile)}`);

  // --targets <a,b> (only when defined)
  if (answers.targets !== undefined) {
    parts.push(`--targets ${answers.targets.join(",")}`);
  }

  // --remove-recipe <v> per name
  for (const name of answers.removeRecipes) {
    parts.push(`--remove-recipe ${maybeQuote(name)}`);
  }

  // --add-recipe <v> per name
  for (const name of answers.addRecipes) {
    parts.push(`--add-recipe ${maybeQuote(name)}`);
  }

  // --replace (when replace and there is at least one add)
  if (answers.replace && answers.addRecipes.length > 0) {
    parts.push("--replace");
  }

  // --workspace <v> (when given.workspace is defined)
  if (given.workspace !== undefined) {
    parts.push(`--workspace ${maybeQuote(given.workspace)}`);
  }

  // --no-sync (when given.sync is false)
  if (!given.sync) {
    parts.push("--no-sync");
  }

  // --offline (when given.offline)
  if (given.offline) {
    parts.push("--offline");
  }

  return parts.join(" ");
}

/* ------------------------------------------------------------------ */
/* askInit — steps 2–7 of the interactive flow (spec 28 §4.2)          */
/* ------------------------------------------------------------------ */

export interface InitGiven {
  forge?: string;
  profile?: string;
  ref?: string;
  targets?: string[];
  addRecipes: string[];
  removeRecipes: string[];
  replace: boolean;
}

export type AskResult =
  | { kind: "cancelled" }
  | { kind: "answered"; input: InitInput; answers: InitAnswers };

/**
 * Steps 2–7 of the interactive flow: asks for the Forge, ref, profile, recipes and targets
 * a command line does not give. Returns the `InitInput` for `planInit` and the `InitAnswers`
 * for `againLine`, or a `cancelled` result when the user interrupted.
 *
 * @param root     The workspace directory (need not exist)
 * @param given    Flags given on the command line
 * @param local    The local file (`craftar.local.yaml`) read once by the caller
 * @param io       The I/O adapter
 * @param opts     Options: `home` is `$CRAFTAR_HOME`, `registryOff` skips the registry,
 *                 `exists` tests if a directory exists (default `fs.existsSync`)
 */
export async function askInit(
  root: string,
  given: InitGiven,
  local: { doc: unknown | null; keys: LocalKey[] },
  io: InitIo,
  opts: LoadOptions & { registryOff: boolean; exists?: (dir: string) => boolean },
): Promise<AskResult> {
  const exists = opts.exists ?? existsSync;
  const home = resolveHome(opts.home);

  // Step 0: checkLocalKeys before any io.ask (N10)
  checkLocalKeys(local.keys, {
    ref: given.ref !== undefined,
    recipes: given.addRecipes.length + given.removeRecipes.length > 0,
    targets: given.targets !== undefined,
  });

  // Ask helper: returns null on cancel
  const ask = async (q: string): Promise<string | null> => io.ask(q);

  // Answers to build
  let answeredForge: string | undefined;
  let answeredRef: string | undefined;
  let answeredProfile: string | undefined;
  let answeredTargets: string[] | undefined;
  let answeredAddRecipes: string[] = [];
  let answeredRemoveRecipes: string[] = [];
  let answeredReplace = false;

  // State for Forge/Ref retry
  let forgeDefault: string | null = null;
  let refDefault: string | null = null;
  let forgeWasAsked = false;

  // Step 1: Forge default from registry
  if (given.forge === undefined && !opts.registryOff) {
    try {
      const registry = await readRegistry(home);
      const offered = lastForge(registry, exists);
      if (offered !== null) {
        forgeDefault = offered.forge;
        refDefault = offered.ref;
      }
    } catch (e) {
      io.say(`  warn cannot read the registry (${(e as Error).message}) — no Forge is offered`);
    }
  }

  // State for loaded Forge
  let loaded: LoadedForge | undefined;

  // Forge/Ref/Load loop
  forgeLoop: for (;;) {
    // Step 2: Forge
    let forgeValue: string;
    if (given.forge !== undefined && !forgeWasAsked) {
      forgeValue = given.forge;
    } else {
      forgeWasAsked = true;
      const q = forgeDefault !== null
        ? `Forge — a directory or a git URL [${forgeDefault}]: `
        : "Forge — a directory or a git URL: ";
      const answer = await ask(q);
      if (answer === null) return { kind: "cancelled" };
      const trimmed = answer.trim();
      if (trimmed === "") {
        if (forgeDefault === null) {
          io.say("a Forge is needed — a directory or a git URL");
          continue forgeLoop;
        }
        forgeValue = forgeDefault;
        // When the default is taken as offered and it has a ref, that's the ref default
        // (refDefault is already set from the registry)
      } else {
        // Check credentials
        if (credentialFault(trimmed)) {
          io.say("the answer holds credentials in the URL — remove them and let git authenticate");
          continue forgeLoop;
        }
        forgeValue = trimmed;
        // A typed answer clears the registry ref default (unless it's a re-ask with the same URL)
        if (forgeValue !== forgeDefault) {
          refDefault = null;
        }
      }
      // Check --ref beside a directory
      if (given.ref !== undefined && classifyForge(forgeValue) !== "url") {
        try {
          checkInitFlags({ forge: forgeValue, ref: given.ref });
        } catch (e) {
          io.say((e as Error).message);
          // Do not set forgeDefault — re-ask without offering the refused value
          continue forgeLoop;
        }
      }
      forgeDefault = forgeValue;
    }

    answeredForge = forgeValue;

    // Step 3: Ref (only for URL, unless --ref or local has ref)
    let refValue: string | null = null;
    if (classifyForge(forgeValue) === "url") {
      if (given.ref !== undefined) {
        refValue = given.ref;
      } else if (local.keys.includes("ref")) {
        // Show the ref from local.yaml but don't ask
        const localRef = (local.doc as { ref?: string })?.ref ?? "";
        io.say(`Ref: ${localRef} (from craftar.local.yaml)`);
        refValue = localRef;
        answeredRef = undefined; // The ref is not written to input.ref
      } else {
        const refQ = refDefault !== null && refDefault !== "the default branch"
          ? `Ref — a branch, a tag or a full SHA [${refDefault}]: `
          : "Ref — a branch, a tag or a full SHA [the default branch]: ";
        const answer = await ask(refQ);
        if (answer === null) return { kind: "cancelled" };
        const trimmed = answer.trim();
        if (trimmed === "") {
          // Enter = default; "the default branch" means no ref
          if (refDefault !== null && refDefault !== "the default branch") {
            refValue = refDefault;
            answeredRef = refValue;
          } else {
            refValue = null;
            answeredRef = undefined;
          }
        } else {
          refValue = trimmed;
          answeredRef = refValue;
        }
        refDefault = trimmed || refDefault;
      }
    }

    // Step 4: Load the Forge
    try {
      const loadRef = given.ref !== undefined ? given.ref
        : local.keys.includes("ref") ? ((local.doc as { ref?: string })?.ref ?? null)
        : (answeredRef ?? null);
      const source = forgeSource(root, forgeValue);
      loaded = await loadForgeSource(root, source, loadRef, { ...opts, mode: "sync" });
    } catch (e) {
      if (forgeWasAsked) {
        io.say((e as Error).message);
        forgeDefault = forgeValue;
        refDefault = answeredRef ?? refDefault;
        continue forgeLoop;
      } else {
        throw e;
      }
    }
    break forgeLoop;
  }

  const forge = loaded!.forge;

  // Step 5: Profile
  if (forge.profiles.size === 0 && given.profile === undefined) {
    throw new Error("the Forge has no profile — add one under profiles/, then re-run init");
  }
  if (given.profile !== undefined) {
    if (!forge.profiles.has(given.profile)) {
      const names = [...forge.profiles.keys()].sort().join(", ");
      throw new Error(`profile "${given.profile}" not found in Forge (${names})`);
    }
    answeredProfile = given.profile;
  } else {
    const profiles = [...forge.profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
    // Say the list
    io.say(`Profiles in ${answeredForge}:`);
    const maxLen = Math.max(...profiles.map((p) => p.name.length));
    for (let i = 0; i < profiles.length; i++) {
      const p = profiles[i];
      const desc = p.description;
      if (desc) {
        io.say(`  ${i + 1}) ${p.name.padEnd(maxLen)}  ${desc}`);
      } else {
        io.say(`  ${i + 1}) ${p.name}`);
      }
    }
    const defProfile = profiles.length === 1 ? profiles[0].name : null;
    const profileQ = defProfile !== null ? `Profile [${defProfile}]: ` : "Profile: ";
    profileLoop: for (;;) {
      const answer = await ask(profileQ);
      if (answer === null) return { kind: "cancelled" };
      const trimmed = answer.trim();
      if (trimmed === "") {
        if (defProfile === null) {
          io.say("a profile is needed — a name or a number from the list");
          continue profileLoop;
        }
        answeredProfile = defProfile;
        break profileLoop;
      }
      // Name first, then number (spec §13 item 32)
      const byName = profiles.find((p) => p.name === trimmed);
      if (byName) {
        answeredProfile = byName.name;
        break profileLoop;
      }
      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num >= 1 && num <= profiles.length) {
        answeredProfile = profiles[num - 1].name;
        break profileLoop;
      }
      // Unknown
      const names = profiles.map((p) => p.name).join(", ");
      io.say(`profile "${trimmed}" not found in Forge (${names})`);
    }
  }

  const profile = forge.profiles.get(answeredProfile!)!;

  // Step 6: Recipes
  const recipesFlagged = given.addRecipes.length > 0 || given.removeRecipes.length > 0;
  if (recipesFlagged) {
    // Skipped: use the flag values
    answeredAddRecipes = given.addRecipes;
    answeredRemoveRecipes = given.removeRecipes;
    answeredReplace = given.replace;
  } else if (local.keys.includes("recipes")) {
    // Show from local.yaml
    const localRecipes = (local.doc as { recipes?: { add?: string[]; remove?: string[] } })?.recipes ?? {};
    const baseConfig = {
      forge: forgeSource(root, answeredForge!),
      profile: answeredProfile!,
      recipes: { add: localRecipes.add ?? [], remove: localRecipes.remove ?? [] },
      targets: profile.targets,
      overrides: { params: {}, sections: {}, ingredients: { disable: [] } },
    };
    const resolution = resolve(forge, baseConfig);
    io.say(`Recipes: ${resolution.recipes.join(" → ")} (from craftar.local.yaml)`);
    // Use the local values directly
    answeredAddRecipes = localRecipes.add ?? [];
    answeredRemoveRecipes = localRecipes.remove ?? [];
  } else {
    // Resolve the profile on its own first (R5)
    const baseConfig = {
      forge: forgeSource(root, answeredForge!),
      profile: answeredProfile!,
      recipes: { add: [], remove: [] },
      targets: profile.targets,
      overrides: { params: {}, sections: {}, ingredients: { disable: [] } },
    };
    let resolution = resolve(forge, baseConfig);
    io.say(`Recipes of ${answeredProfile}: ${resolution.recipes.join(" → ")}`);

    recipeLoop: for (;;) {
      const adjustQ = "Adjust the recipes [no]: ";
      const adjustAns = await ask(adjustQ);
      if (adjustAns === null) return { kind: "cancelled" };
      const yn = yesNo(adjustAns);
      if (adjustAns.trim() !== "" && yn === null) {
        io.say("answer yes or no");
        continue recipeLoop;
      }
      if (yn !== true) {
        // No adjustment
        break recipeLoop;
      }
      // Yes: show recipes list and ask Remove/Add
      io.say(`Recipes in ${answeredForge}:`);
      const allRecipes = [...forge.recipes.values()].sort((a, b) => a.name.localeCompare(b.name));
      const inUse = resolution.recipes;
      const inUseRecipes = allRecipes.filter((r) => inUse.includes(r.name));
      const notInUseRecipes = allRecipes.filter((r) => !inUse.includes(r.name));
      // In use first in resolved order, then others by name
      const orderedInUse = inUse.map((name) => allRecipes.find((r) => r.name === name)!);
      const ordered = [...orderedInUse, ...notInUseRecipes];
      for (let i = 0; i < ordered.length; i++) {
        const r = ordered[i];
        const parts = [`  ${i + 1}) ${r.name}`];
        if (inUse.includes(r.name)) parts.push("· in use");
        if (r.slot) parts.push(`· slot ${r.slot}`);
        if (r.description) parts.push(`· ${r.description}`);
        io.say(parts.join(" "));
      }

      // Helper to parse a recipe answer into names
      const parseRecipeAnswer = (answer: string): string[] => {
        return answer
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
          .map((s) => {
            // Name first, then number
            const byName = ordered.find((r) => r.name === s);
            if (byName) return byName.name;
            const num = parseInt(s, 10);
            if (!isNaN(num) && num >= 1 && num <= ordered.length) return ordered[num - 1].name;
            return s; // Keep as-is for error handling
          });
      };

      // Ask Remove and Add
      const removeAns = await ask("Remove [none]: ");
      if (removeAns === null) return { kind: "cancelled" };
      const addAns = await ask("Add [none]: ");
      if (addAns === null) return { kind: "cancelled" };

      const removeNames = parseRecipeAnswer(removeAns);
      const addNames = parseRecipeAnswer(addAns);

      if (removeNames.length === 0 && addNames.length === 0) {
        // As "no"
        break recipeLoop;
      }

      // Check N6: recipe both added and removed
      const both = addNames.find((n) => removeNames.includes(n));
      if (both !== undefined) {
        try {
          checkInitFlags({ addRecipes: addNames, removeRecipes: removeNames });
        } catch (e) {
          io.say((e as Error).message);
          continue recipeLoop;
        }
      }

      // Apply removes, then adds, starting from the profile's recipes
      let editConfig = {
        forge: forgeSource(root, answeredForge!),
        profile: answeredProfile!,
        recipes: { add: [] as string[], remove: [] as string[] },
        targets: profile.targets,
        overrides: { params: {}, sections: {}, ingredients: { disable: [] } },
      };

      let finalRemoves: string[] = [];
      let finalAdds: string[] = [];
      let replaceUsed = false;

      try {
        // Removes first
        if (removeNames.length > 0) {
          const removeEdit = planRecipeEdit(forge, editConfig, "remove", removeNames);
          editConfig = { ...editConfig, recipes: removeEdit.recipes };
          if (removeEdit.reasons.length) {
            for (const reason of removeEdit.reasons) {
              io.say(`  note ${reason}`);
            }
          }
        }
        // Adds with potential replace
        let doReplace = false;
        if (addNames.length > 0) {
          addLoop: for (;;) {
            try {
              const addEdit = planRecipeEdit(forge, editConfig, "add", addNames, { replace: doReplace });
              editConfig = { ...editConfig, recipes: addEdit.recipes };
              if (addEdit.reasons.length) {
                for (const reason of addEdit.reasons) {
                  io.say(`  note ${reason}`);
                }
              }
              break addLoop;
            } catch (e) {
              const held = slotHeld(e);
              if (held !== null && !doReplace) {
                // Ask the replace question
                const replaceQ = `${held.recipe} takes the slot "${held.slot}" that ${held.holder} holds — replace ${held.holder} [no]: `;
                const replaceAns = await ask(replaceQ);
                if (replaceAns === null) return { kind: "cancelled" };
                const replaceYn = yesNo(replaceAns);
                if (replaceYn === true) {
                  doReplace = true;
                  replaceUsed = true;
                  continue addLoop;
                }
                // No or Enter: go back to Adjust the recipes
                continue recipeLoop;
              }
              throw e;
            }
          }
        }
        // Success: compute the final lists
        finalRemoves = editConfig.recipes.remove;
        finalAdds = editConfig.recipes.add;
        answeredReplace = replaceUsed;

        // Resolve with the new config to show the chain
        resolution = resolve(forge, editConfig);
        io.say(`Recipes: ${resolution.recipes.join(" → ")}`);
        answeredAddRecipes = finalAdds;
        answeredRemoveRecipes = finalRemoves;
        break recipeLoop;
      } catch (e) {
        io.say((e as Error).message);
        continue recipeLoop;
      }
    }
  }

  // Step 7: Targets
  if (given.targets !== undefined) {
    answeredTargets = given.targets;
  } else if (local.keys.includes("targets")) {
    const localTargets = (local.doc as { targets?: string[] })?.targets ?? [];
    io.say(`Targets: ${localTargets.join(", ")} (from craftar.local.yaml)`);
    // Don't set answeredTargets — the local file provides it
  } else {
    const profileTargets = profile.targets;
    const targetsQ = `Targets — ${TARGETS.join(", ")}, separated by commas [${profileTargets.join(", ")}, from the profile]: `;
    targetsLoop: for (;;) {
      const answer = await ask(targetsQ);
      if (answer === null) return { kind: "cancelled" };
      const trimmed = answer.trim();
      if (trimmed === "") {
        // Enter = follow the profile (no targets key)
        break targetsLoop;
      }
      // Parse the answer
      const parsed = trimmed.split(",").map((s) => s.trim());
      // Check for unknown or empty
      try {
        checkInitFlags({ targets: parsed });
      } catch (e) {
        io.say((e as Error).message);
        continue targetsLoop;
      }
      answeredTargets = parsed;
      break targetsLoop;
    }
  }

  // Build the input and answers
  const input: InitInput = {
    forge: answeredForge!,
    profile: answeredProfile!,
    loaded: loaded,
  };
  if (answeredRef !== undefined) input.ref = answeredRef;
  if (answeredTargets !== undefined) input.targets = answeredTargets;
  if (answeredAddRecipes.length > 0) input.addRecipes = answeredAddRecipes;
  if (answeredRemoveRecipes.length > 0) input.removeRecipes = answeredRemoveRecipes;
  if (answeredReplace) input.replace = true;

  const answers: InitAnswers = {
    forge: answeredForge!,
    profile: answeredProfile!,
    addRecipes: answeredAddRecipes,
    removeRecipes: answeredRemoveRecipes,
    replace: answeredReplace,
  };
  if (answeredRef !== undefined) answers.ref = answeredRef;
  if (answeredTargets !== undefined) answers.targets = answeredTargets;

  return { kind: "answered", input, answers };
}
