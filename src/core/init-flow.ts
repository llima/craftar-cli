import { existsSync } from "node:fs";
import { TARGETS, type Registry, type RegistryEntry, type WorkspaceConfig } from "../schema/index.js";
import { countStates } from "./impact.js";
import { resolveHome } from "./home-lock.js";
import { checkInitFlags, checkLocalKeys, forgeSource, initLine, type InitInput, type InitPlan } from "./init.js";
import { planRecipeEdit, slotHeld } from "./recipe-edit.js";
import { readRegistry } from "./registry.js";
import { classifyForge, credentialFault } from "./remote.js";
import { profileNotFoundMessage, resolve } from "./resolve.js";
import { loadForgeSource, mergeWorkspaceConfig, unsetDeclared, unsetRefused, type LoadedForge, type LoadOptions } from "./sync.js";
import type { LocalKey } from "./workspace-yaml.js";

/**
 * The interactive `init` flow (spec 28 §4.2): prompts injected through `InitIo`,
 * so the flow can be tested with scripted answers. This module never touches `process`,
 * `console` or `readline`, and writes nothing.
 */

export interface InitIo {
  ask(question: string): Promise<string | null>;
  confirm(question: string): Promise<string | null>;
  say(line: string): void;
}

export interface OfferedForge {
  forge: string;
  ref: string | null;
}

/**
 * The Forge last used on this machine: the entry with the most recent `lastSync`
 * whose Forge can be offered — a path entry by its `key` (skipped when `null` or gone),
 * a remote one by its `source` (skipped when `credentialFault`).
 */
export function lastForge(
  registry: Registry,
  exists: (dir: string) => boolean,
): OfferedForge | null {
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
    if (entry.forge.key === null) return null;
    if (!exists(entry.forge.key)) return null;
    return { forge: entry.forge.key, ref: null };
  }
  if (credentialFault(entry.forge.source)) return null;
  return { forge: entry.forge.source, ref: entry.forge.ref };
}

/** y, yes → true; n, no → false; anything else → null. */
export function yesNo(answer: string): boolean | null {
  const a = answer.trim().toLowerCase();
  if (a === "y" || a === "yes") return true;
  if (a === "n" || a === "no") return false;
  return null;
}

/**
 * Says the summary and the `first sync:` line, asks through `io.confirm`,
 * re-asks anything but yes/no, returns confirmed or cancelled. A plan whose sync
 * is refused (spec 29 §4.1) says so before the question, which then offers no sync.
 */
export async function confirmInit(
  init: InitPlan,
  root: string,
  io: InitIo,
  opts: { sync: boolean },
): Promise<"confirmed" | "cancelled"> {
  io.say(`craftar init — about to write craftar.yaml in ${root}`);
  io.say(`  ${initLine(init)}`);

  const unset = unsetDeclared(init.plan);
  const counts = countStates(init.statuses);
  if (unset.length > 0) {
    io.say(`  first sync: ${unsetRefused(unset)}`);
  } else if (counts.length === 0) {
    io.say("  first sync: nothing to write");
  } else {
    const parts = counts.map(([k, n]) => `${n} ${k}`);
    io.say(`  first sync: ${parts.join(", ")}`);
  }

  const question = opts.sync && unset.length === 0
    ? "Write craftar.yaml and sync [yes]: "
    : "Write craftar.yaml [yes]: ";

  for (;;) {
    const answer = await io.confirm(question);
    if (answer === null) return "cancelled";
    if (answer === "") return "confirmed";
    const yn = yesNo(answer);
    if (yn === true) return "confirmed";
    if (yn === false) return "cancelled";
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

const SAFE_CHARS = /^[A-Za-z0-9_./:@=+,-]+$/;

function maybeQuote(value: string): string {
  if (value === "") return '""';
  if (SAFE_CHARS.test(value)) return value;
  return `"${value}"`;
}

/**
 * Returns `  again craftar init` followed by the flags that reproduce the run.
 * Throws if `answers.forge` holds credentials (defense: never print them).
 */
export function againLine(
  answers: InitAnswers,
  given: { workspace?: string; sync: boolean; offline: boolean },
): string {
  if (credentialFault(answers.forge)) {
    throw new Error("againLine: the Forge holds credentials");
  }

  const parts: string[] = ["  again craftar init"];
  parts.push(`--forge ${maybeQuote(answers.forge)}`);
  if (answers.ref !== undefined) parts.push(`--ref ${maybeQuote(answers.ref)}`);
  parts.push(`--profile ${maybeQuote(answers.profile)}`);
  if (answers.targets !== undefined) parts.push(`--targets ${answers.targets.join(",")}`);
  for (const name of answers.removeRecipes) parts.push(`--remove-recipe ${maybeQuote(name)}`);
  for (const name of answers.addRecipes) parts.push(`--add-recipe ${maybeQuote(name)}`);
  if (answers.replace && answers.addRecipes.length > 0) parts.push("--replace");
  if (given.workspace !== undefined) parts.push(`--workspace ${maybeQuote(given.workspace)}`);
  if (!given.sync) parts.push("--no-sync");
  if (given.offline) parts.push("--offline");
  return parts.join(" ");
}

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
 * An item of a numbered list by its answer: the name wins over the number (a profile or a recipe
 * literally named `2` stays reachable), and a number is digits only — `2x` is no item.
 */
function pickItem(names: string[], answer: string): string | null {
  if (names.includes(answer)) return answer;
  if (!/^\d+$/.test(answer)) return null;
  return names[Number(answer) - 1] ?? null;
}

/**
 * Steps 2–7 of the interactive flow: asks for the Forge, ref, profile, recipes and targets
 * a command line does not give. Returns the `InitInput` for `planInit` and the `InitAnswers`
 * for `againLine`, or a `cancelled` result when the user interrupted.
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

  // The flags given, checked here too: nothing below may say a Forge that holds credentials.
  checkInitFlags(given);
  checkLocalKeys(local.keys, {
    ref: given.ref !== undefined,
    recipes: given.addRecipes.length + given.removeRecipes.length > 0,
    targets: given.targets !== undefined,
  });

  let answeredForge: string | undefined;
  let answeredRef: string | undefined;
  let answeredProfile: string | undefined;
  let answeredTargets: string[] | undefined;
  let answeredAddRecipes: string[] = [];
  let answeredRemoveRecipes: string[] = [];
  let answeredReplace = false;

  let forgeDefault: string | null = null;
  let refDefault: string | null = null;
  let forgeWasAsked = false;

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

  let loaded: LoadedForge | undefined;
  let localConfig: WorkspaceConfig | null = null;

  forgeLoop: for (;;) {
    answeredRef = undefined;

    let forgeValue: string;
    if (given.forge !== undefined && !forgeWasAsked) {
      forgeValue = given.forge;
    } else {
      forgeWasAsked = true;
      const q = forgeDefault !== null
        ? `Forge — a directory or a git URL [${forgeDefault}]: `
        : "Forge — a directory or a git URL: ";
      const answer = await io.ask(q);
      if (answer === null) return { kind: "cancelled" };
      const trimmed = answer.trim();
      if (trimmed === "") {
        if (forgeDefault === null) {
          io.say("a Forge is needed — a directory or a git URL");
          continue forgeLoop;
        }
        forgeValue = forgeDefault;
      } else {
        if (credentialFault(trimmed)) {
          io.say("the answer holds credentials in the URL — remove them and let git authenticate");
          continue forgeLoop;
        }
        forgeValue = trimmed;
        if (forgeValue !== forgeDefault) refDefault = null;
      }
      if (given.ref !== undefined && classifyForge(forgeValue) !== "url") {
        try {
          checkInitFlags({ forge: forgeValue, ref: given.ref });
        } catch (e) {
          io.say((e as Error).message);
          continue forgeLoop;
        }
      }
      forgeDefault = forgeValue;
    }

    answeredForge = forgeValue;

    // The placeholder profile "-" is never used: only ref, recipes and targets are read,
    // and none depends on the profile value. A schema error surfaces here.
    localConfig = local.doc !== null
      ? mergeWorkspaceConfig({ forge: forgeSource(root, forgeValue), profile: given.profile ?? "-" }, local.doc).config
      : null;

    let refValue: string | null = null;
    if (classifyForge(forgeValue) === "url") {
      if (given.ref !== undefined) {
        refValue = given.ref;
        answeredRef = given.ref;
      } else if (local.keys.includes("ref")) {
        const localRef = localConfig?.ref ?? null;
        if (localRef !== null) io.say(`Ref: ${localRef} (from craftar.local.yaml)`);
        refValue = localRef;
      } else {
        const refQ = refDefault !== null && refDefault !== "the default branch"
          ? `Ref — a branch, a tag or a full SHA [${refDefault}]: `
          : "Ref — a branch, a tag or a full SHA [the default branch]: ";
        const answer = await io.ask(refQ);
        if (answer === null) return { kind: "cancelled" };
        const trimmed = answer.trim();
        if (trimmed === "") {
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

    try {
      const loadRef = given.ref !== undefined ? given.ref
        : local.keys.includes("ref") ? (localConfig?.ref ?? null)
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

  if (forge.profiles.size === 0 && given.profile === undefined) {
    throw new Error("the Forge has no profile — add one under profiles/, then re-run init");
  }
  if (given.profile !== undefined) {
    if (!forge.profiles.has(given.profile)) {
      throw new Error(profileNotFoundMessage(given.profile, [...forge.profiles.keys()]));
    }
    answeredProfile = given.profile;
  } else {
    const profiles = [...forge.profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
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
      const answer = await io.ask(profileQ);
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
      const picked = pickItem(profiles.map((p) => p.name), trimmed);
      if (picked !== null) {
        answeredProfile = picked;
        break profileLoop;
      }
      io.say(profileNotFoundMessage(trimmed, [...forge.profiles.keys()]));
    }
  }

  const profile = forge.profiles.get(answeredProfile!)!;

  const recipesFlagged = given.addRecipes.length > 0 || given.removeRecipes.length > 0;
  if (recipesFlagged) {
    answeredAddRecipes = given.addRecipes;
    answeredRemoveRecipes = given.removeRecipes;
    answeredReplace = given.replace;
  } else if (local.keys.includes("recipes")) {
    const recipeConfig = { ...localConfig!, profile: answeredProfile! };
    const resolution = resolve(forge, recipeConfig);
    io.say(`Recipes: ${resolution.recipes.join(" → ")} (from craftar.local.yaml)`);
  } else {
    const baseConfig = mergeWorkspaceConfig(
      { forge: forgeSource(root, answeredForge!), profile: answeredProfile! },
      null
    ).config;
    let resolution = resolve(forge, baseConfig);
    io.say(`Recipes of ${answeredProfile}: ${resolution.recipes.join(" → ")}`);

    recipeLoop: for (;;) {
      const adjustQ = "Adjust the recipes [no]: ";
      const adjustAns = await io.ask(adjustQ);
      if (adjustAns === null) return { kind: "cancelled" };
      const yn = yesNo(adjustAns);
      if (adjustAns.trim() !== "" && yn === null) {
        io.say("answer yes or no");
        continue recipeLoop;
      }
      if (yn !== true) break recipeLoop;

      io.say(`Recipes in ${answeredForge}:`);
      const allRecipes = [...forge.recipes.values()].sort((a, b) => a.name.localeCompare(b.name));
      const inUse = resolution.recipes;
      const orderedInUse = inUse.map((name) => allRecipes.find((r) => r.name === name)!);
      const notInUseRecipes = allRecipes.filter((r) => !inUse.includes(r.name));
      const ordered = [...orderedInUse, ...notInUseRecipes];
      for (let i = 0; i < ordered.length; i++) {
        const r = ordered[i];
        const parts = [`  ${i + 1}) ${r.name}`];
        if (inUse.includes(r.name)) parts.push("· in use");
        if (r.slot) parts.push(`· slot ${r.slot}`);
        if (r.description) parts.push(`· ${r.description}`);
        io.say(parts.join(" "));
      }

      // An answer that is no item is kept as typed, so spec 22's R2 names it.
      const names = ordered.map((r) => r.name);
      const parseRecipeAnswer = (answer: string): string[] =>
        answer.split(",").map((s) => s.trim()).filter((s) => s !== "").map((s) => pickItem(names, s) ?? s);

      const removeAns = await io.ask("Remove [none]: ");
      if (removeAns === null) return { kind: "cancelled" };
      const addAns = await io.ask("Add [none]: ");
      if (addAns === null) return { kind: "cancelled" };

      const removeNames = parseRecipeAnswer(removeAns);
      const addNames = parseRecipeAnswer(addAns);

      if (removeNames.length === 0 && addNames.length === 0) break recipeLoop;

      const both = addNames.find((n) => removeNames.includes(n));
      if (both !== undefined) {
        try {
          checkInitFlags({ addRecipes: addNames, removeRecipes: removeNames });
        } catch (e) {
          io.say((e as Error).message);
          continue recipeLoop;
        }
      }

      // Every round starts from the profile's recipes
      let editConfig = mergeWorkspaceConfig(
        { forge: forgeSource(root, answeredForge!), profile: answeredProfile! },
        null
      ).config;

      let replaceUsed = false;

      try {
        if (removeNames.length > 0) {
          const removeEdit = planRecipeEdit(forge, editConfig, "remove", removeNames);
          editConfig = { ...editConfig, recipes: removeEdit.recipes };
          if (removeEdit.reasons.length) io.say(`  note ${removeEdit.reasons.join(", ")}`);
        }
        let doReplace = false;
        if (addNames.length > 0) {
          addLoop: for (;;) {
            try {
              const addEdit = planRecipeEdit(forge, editConfig, "add", addNames, { replace: doReplace });
              editConfig = { ...editConfig, recipes: addEdit.recipes };
              if (addEdit.reasons.length) io.say(`  note ${addEdit.reasons.join(", ")}`);
              break addLoop;
            } catch (e) {
              const held = slotHeld(e);
              if (held !== null && !doReplace) {
                const replaceQ = `${held.recipe} takes the slot "${held.slot}" that ${held.holder} holds — replace ${held.holder} [no]: `;
                let replaceYn: boolean | null;
                for (;;) {
                  const replaceAns = await io.ask(replaceQ);
                  if (replaceAns === null) return { kind: "cancelled" };
                  replaceYn = replaceAns.trim() === "" ? false : yesNo(replaceAns);
                  if (replaceYn !== null) break;
                  io.say("answer yes or no");
                }
                if (replaceYn) {
                  doReplace = true;
                  replaceUsed = true;
                  continue addLoop;
                }
                continue recipeLoop;
              }
              throw e;
            }
          }
        }
        answeredReplace = replaceUsed;
        resolution = resolve(forge, editConfig);
        io.say(`Recipes: ${resolution.recipes.join(" → ")}`);
        // Return the typed names, not the resulting lists
        answeredAddRecipes = addNames;
        answeredRemoveRecipes = removeNames;
        break recipeLoop;
      } catch (e) {
        io.say((e as Error).message);
        continue recipeLoop;
      }
    }
  }

  if (given.targets !== undefined) {
    answeredTargets = given.targets;
  } else if (local.keys.includes("targets")) {
    const localTargets = localConfig?.targets ?? [];
    io.say(`Targets: ${localTargets.join(", ")} (from craftar.local.yaml)`);
  } else {
    const profileTargets = profile.targets;
    const targetsQ = `Targets — ${TARGETS.join(", ")}, separated by commas [${profileTargets.join(", ")}, from the profile]: `;
    targetsLoop: for (;;) {
      const answer = await io.ask(targetsQ);
      if (answer === null) return { kind: "cancelled" };
      const trimmed = answer.trim();
      if (trimmed === "") break targetsLoop;
      const parsed = trimmed.split(",").map((s) => s.trim());
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
