import { existsSync } from "node:fs";
import { forgeFor } from "./profile-local.js";
import { escapeSummary, escapingRows } from "./contain.js";
import { ProfileSchema, TARGETS, type Registry, type RegistryEntry, type WorkspaceConfig } from "../schema/index.js";
import { planClone } from "./clone.js";
import { countStates } from "./impact.js";
import { resolveHome } from "./home-lock.js";
import { checkInitFlags, checkLocalKeys, forgeSource, initLine, type InitInput, type InitPlan } from "./init.js";
import { newProfile, ownedBy, ownedRecipeRefusal, profileName, withProfile } from "./new-profile.js";
import { newProfileGate } from "./new-profile-gate.js";
import { planRecipeEdit, slotHeld } from "./recipe-edit.js";
import { readRegistry } from "./registry.js";
import { classifyForge, credentialFault, CREDENTIAL_HIDDEN, refHoldsCredentials } from "./remote.js";
import { profileNotFoundMessage, resolve } from "./resolve.js";
import { profileRepos, type RepoEntry } from "./repos.js";
import { loadForgeSource, mergeWorkspaceConfig, unsetDeclared, unsetRefused, type LoadedForge, type LoadOptions } from "./sync.js";
import type { LocalKey } from "./workspace-yaml.js";

/**
 * The interactive `init` flow (spec 28 §4.2): prompts injected through `InitIo`,
 * so the flow can be tested with scripted answers. This module never touches `process`,
 * `console` or `readline`, and writes nothing.
 */

/** The message printed when cloning is skipped because the first sync is refused. */
export const NOT_CLONED_REFUSED = "  repositories: not cloned — the first sync is refused";

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
    // Spec 39 §7, §14 item 8: a gap-2 spelling that once loaded as a path is recorded with a real
    // path that holds the credential.
    if (credentialFault(entry.forge.source)) return null;
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
 * The clone question of the interactive flow (spec 37 §4.3): lists the profile's repositories,
 * asks whether to clone them, re-asks on errors. Returns the decision and the entries to clone.
 *
 * @param io The prompt interface.
 * @param init The init plan.
 * @param opts.root Absolute path of the workspace.
 * @param opts.offline Whether --offline was given (no list, no question).
 * @param opts.git The git binary path, or null if not found.
 * @returns `{clone: false, entries: []}` when nothing to clone or the user said no;
 *          `{clone: true, entries}` when the user said yes and planClone succeeded;
 *          `{clone: false, entries: [], refused: true}` when the first sync is refused (unset params);
 *          `"cancelled"` when the user cancelled.
 */
export async function askClone(
  io: InitIo,
  init: InitPlan,
  opts: { root: string; offline: boolean; git: string | null },
): Promise<{ clone: boolean; entries: RepoEntry[]; refused?: true } | "cancelled"> {
  // --offline → no list, no question
  if (opts.offline) {
    return { clone: false, entries: [] };
  }

  // profileRepos throws → say one line, no question
  const profile = init.ws.forge.profiles.get(init.ws.config.profile)!;
  let allEntries: RepoEntry[];
  try {
    allEntries = profileRepos(profile);
  } catch (e) {
    io.say(`repositories: not offered — ${(e as Error).message}`);
    return { clone: false, entries: [] };
  }

  // no entry → no list, no question
  if (allEntries.length === 0) {
    return { clone: false, entries: [] };
  }

  // a plan whose first sync would be refused → no list, no question, refused flag
  const unset = unsetDeclared(init.plan);
  if (unset.length > 0 || escapingRows(init.statuses).length > 0) {
    return { clone: false, entries: [], refused: true };
  }

  // say the list
  const maxName = Math.max(...allEntries.map((e) => e.name.length));
  const maxUrl = Math.max(...allEntries.map((e) => e.url.length));
  io.say(`Repositories of ${profile.name}:`);
  for (let i = 0; i < allEntries.length; i++) {
    const e = allEntries[i];
    const ref = e.ref !== null ? `  @ ${e.ref}` : "";
    io.say(`  ${i + 1}) ${e.name.padEnd(maxName)}   ${e.url.padEnd(maxUrl)}   → ${e.path}${ref}`);
  }

  // loop on confirm
  for (;;) {
    const answer = await io.confirm("Clone them into the workspace [no]: ");
    if (answer === null) return "cancelled";
    if (answer === "") return { clone: false, entries: [] };
    const yn = yesNo(answer);
    if (yn === false) return { clone: false, entries: [] };
    if (yn === null) {
      io.say("answer yes or no");
      continue;
    }

    // yes → check git
    if (opts.git === null) {
      io.say("cloning needs git — install it, or leave the clone out");
      continue;
    }

    // yes → planClone
    try {
      const ctx = { planned: init.plan.files.map((f) => f.path), lockPaths: init.lock?.files.map((f) => f.path) ?? [], forgeDir: init.ws.forge.root };
      const clonePlan = await planClone(opts.root, profile, ctx, { present: "refuse", noEntries: "nothing to clone" });
      return { clone: true, entries: clonePlan.entries };
    } catch (e) {
      io.say((e as Error).message);
      continue;
    }
  }
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
  opts: { sync: boolean; clone?: number; cloneRefused?: boolean },
): Promise<"confirmed" | "cancelled"> {
  // Spec 38 §4.3: blockNote first when there is one
  if (init.newProfile?.blockNote) {
    io.say(`  note ${init.newProfile.blockNote}`);
  }

  // Spec 38 §4.3: the first line changes with newProfile
  if (init.newProfile) {
    io.say(`craftar init — about to create profile ${init.ws.config.profile} in ${init.ws.forge.root} and write craftar.yaml in ${root}`);
  } else {
    io.say(`craftar init — about to write craftar.yaml in ${root}`);
  }
  io.say(`  ${initLine(init)}`);

  const unset = unsetDeclared(init.plan);
  const counts = countStates(init.statuses);
  if (unset.length > 0) {
    io.say(`  first sync: ${unsetRefused(unset)}`);
  } else if (escapingRows(init.statuses).length > 0) {
    io.say(`  first sync: refused — ${escapeSummary(escapingRows(init.statuses))}`);
  } else if (counts.length === 0) {
    io.say("  first sync: nothing to write");
  } else {
    const parts = counts.map(([k, n]) => `${n} ${k}`);
    io.say(`  first sync: ${parts.join(", ")}`);
  }

  // When the sync is refused and cloneRefused, say the not-cloned line
  if (unset.length > 0 && opts.cloneRefused) {
    io.say(NOT_CLONED_REFUSED);
  }

  // Build the question: spec 38 §4.3 — with newProfile, the question names both writes
  let question: string;
  const clone = opts.clone ?? 0;
  const profileName = init.newProfile ? init.ws.config.profile : null;

  if (init.newProfile) {
    // New profile: different question forms
    if (unset.length > 0 || !opts.sync) {
      question = `Create profiles/${profileName}/profile.yaml (not committed) and write craftar.yaml [yes]: `;
    } else {
      question = `Create profiles/${profileName}/profile.yaml (not committed), write craftar.yaml and sync [yes]: `;
    }
  } else if (unset.length > 0) {
    // Sync refused → offer only craftar.yaml
    question = "Write craftar.yaml [yes]: ";
  } else if (clone > 0) {
    const repoWord = clone === 1 ? "repository" : "repositories";
    if (opts.sync) {
      question = `Write craftar.yaml, sync and clone ${clone} ${repoWord} [yes]: `;
    } else {
      question = `Write craftar.yaml and clone ${clone} ${repoWord} [yes]: `;
    }
  } else if (opts.sync) {
    question = "Write craftar.yaml and sync [yes]: ";
  } else {
    question = "Write craftar.yaml [yes]: ";
  }

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
  given: { workspace?: string; sync: boolean; offline: boolean; clone?: boolean },
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
  if (given.clone === true) parts.push("--clone");
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
  clone?: boolean;
  /** The new profile's name (spec 38 §4.3). */
  newProfile?: string;
  /** The template profile (spec 38 §4.3). */
  like?: string;
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

      // P4 check: with --new-profile typed and Forge asked, a URL answer is refused — say P4 and ask again
      if (given.newProfile !== undefined && classifyForge(forgeValue) === "url") {
        io.say("a new profile is written into a Forge directory — clone the Forge, pass that directory as --forge, then commit and push the profile");
        continue forgeLoop;
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
        // A URL with credentials typed into `ref:` is never said back.
        if (localRef !== null) io.say(`Ref: ${refHoldsCredentials(localRef) ? CREDENTIAL_HIDDEN : localRef} (from craftar.local.yaml)`);
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
          // Refused on entry, as the Forge answer is: kept, it would come back in the next question's default.
          if (refHoldsCredentials(trimmed)) {
            io.say("the answer holds credentials in a URL — a ref is a branch, a tag or a full SHA");
            continue forgeLoop;
          }
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

    // P5/P6 check: with --new-profile typed and Forge asked, check if the Forge can take a new profile
    if (given.newProfile !== undefined && forgeWasAsked) {
      try {
        await newProfileGate(loaded.forge, home);
      } catch (e) {
        io.say((e as Error).message);
        forgeDefault = forgeValue;
        refDefault = answeredRef ?? refDefault;
        continue forgeLoop;
      }
    }

    // P5/P6 check: with no profile given and no profiles in the Forge, we'll be forced to create a new profile
    // If the Forge was asked and it can't take a new profile, say the error and ask again
    if (given.profile === undefined && given.newProfile === undefined && loaded.forge.profiles.size === 0 && forgeWasAsked) {
      if (classifyForge(forgeValue) !== "url") {
        try {
          await newProfileGate(loaded.forge, home);
        } catch (e) {
          io.say((e as Error).message);
          forgeDefault = forgeValue;
          refDefault = answeredRef ?? refDefault;
          continue forgeLoop;
        }
      }
    }

    break forgeLoop;
  }

  const forge = loaded!.forge;

  // Track whether we're in the new-profile flow
  let isNewProfile = false;
  let newProfileName: string | undefined;
  let newProfileLike: string | undefined;
  let profileListShown = false;

  // Helper to show the profile list
  const showProfileList = () => {
    if (profileListShown) return;
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
    profileListShown = true;
  };

  // Check if the new profile entry should be shown: Forge is a directory that passes P5/P6
  let canOfferNewProfile = false;
  let newProfileGateError: string | null = null;
  if (classifyForge(answeredForge!) !== "url") {
    try {
      await newProfileGate(forge, home);
      canOfferNewProfile = true;
    } catch (e) {
      newProfileGateError = (e as Error).message;
    }
  }

  // Handle given.newProfile: validate with P3 and P7/P8 (typed value is not re-asked)
  if (given.newProfile !== undefined) {
    profileName(given.newProfile); // P3: throws on failure
    // P9 up front: a typed --like the Forge does not have is refused before any question
    if (given.like !== undefined && !forge.profiles.has(given.like)) {
      throw new Error("--like: " + profileNotFoundMessage(given.like, [...forge.profiles.keys()]));
    }
    await newProfileGate(forge, home, given.newProfile); // P7/P8: throws on failure
    isNewProfile = true;
    newProfileName = given.newProfile;
    newProfileLike = given.like;
    answeredProfile = given.newProfile;
  } else if (given.profile !== undefined) {
    if (!forge.profiles.has(given.profile)) {
      throw new Error(profileNotFoundMessage(given.profile, [...forge.profiles.keys()]));
    }
    answeredProfile = given.profile;
  } else if (forge.profiles.size === 0) {
    // Spec 38 §4.3: A Forge directory with no profile goes straight to the new-profile questions
    // (A URL Forge with no profile keeps today's error)
    if (classifyForge(answeredForge!) === "url") {
      throw new Error("the Forge has no profile — add one under profiles/, then re-run init");
    }
    // For directory Forge with no profile: check if it can take a new profile
    if (!canOfferNewProfile) {
      throw new Error(newProfileGateError!);
    }
    io.say("the Forge has no profile yet — creating the first one");
    isNewProfile = true;
  } else {
    // Show the profile list with the new profile entry if applicable
    const profiles = [...forge.profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
    showProfileList();
    
    // Show the 0) a new profile entry ONLY when the Forge can take a new profile
    // Per spec 38 §4.3: show lines explaining why the entry isn't available
    if (canOfferNewProfile) {
      io.say("  0) a new profile");
    } else if (classifyForge(answeredForge!) === "url") {
      io.say("a new profile needs a Forge directory");
    } else if (newProfileGateError) {
      // Forge directory that fails P5/P6: show the error as the line under the list
      io.say(newProfileGateError);
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
      // pickItem: names first, then (only when the entry is shown) "0" for new profile, then numbers
      const picked = pickItem(profiles.map((p) => p.name), trimmed);
      if (picked !== null) {
        answeredProfile = picked;
        break profileLoop;
      }
      // Check for "0" to start new-profile questions (only when the entry is shown)
      if (canOfferNewProfile && trimmed === "0") {
        isNewProfile = true;
        break profileLoop;
      }
      io.say(profileNotFoundMessage(trimmed, [...forge.profiles.keys()]));
    }
  }

  // New-profile questions (§4.3)
  if (isNewProfile) {
    // Name question (skipped when given.newProfile was typed)
    if (newProfileName === undefined) {
      nameLoop: for (;;) {
        const answer = await io.ask("New profile's name: ");
        if (answer === null) return { kind: "cancelled" };
        const trimmed = answer.trim();
        if (trimmed === "") {
          io.say('a name is needed — lowercase letters and digits, in groups joined by one "-"');
          continue nameLoop;
        }
        try {
          profileName(trimmed); // P3
          await newProfileGate(forge, home, trimmed); // P7, P8
          newProfileName = trimmed;
          break nameLoop;
        } catch (e) {
          io.say((e as Error).message);
          continue nameLoop;
        }
      }
    }
    answeredProfile = newProfileName;

    // Template question: "Start from an existing profile [none]:" — only when the Forge has profiles
    // and when given.like was not provided
    if (newProfileLike === undefined && forge.profiles.size > 0) {
      // Print the profile list if it wasn't printed yet (e.g. --new-profile was typed, --forge asked)
      if (!profileListShown) {
        showProfileList();
      }
      
      templateLoop: for (;;) {
        const answer = await io.ask("Start from an existing profile [none]: ");
        if (answer === null) return { kind: "cancelled" };
        const trimmed = answer.trim();
        if (trimmed === "" || trimmed === "0") {
          // Enter or 0 → none
          break templateLoop;
        }
        const profiles = [...forge.profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
        const picked = pickItem(profiles.map((p) => p.name), trimmed);
        if (picked !== null) {
          newProfileLike = picked;
          break templateLoop;
        }
        // Unknown → say "--like: " + profileNotFoundMessage
        io.say("--like: " + profileNotFoundMessage(trimmed, [...forge.profiles.keys()]));
        continue templateLoop;
      }
    }

    // Recipes question for new profile
    // With a template: show "Recipes of <name> (from <like>): <chain>" then Adjust flow
    // Without a template: show recipes list and ask "Add [none]:" directly
    let finalAddRecipes: string[] = [];
    let finalRemoveRecipes: string[] = [];
    let finalReplace = false;

    // Typed flags answer their questions (spec 38 §4.2, §4.3)
    const recipesFlagged = given.addRecipes.length > 0 || given.removeRecipes.length > 0;
    if (recipesFlagged) {
      // Use the flags directly, skip all recipe questions
      finalAddRecipes = given.addRecipes;
      finalRemoveRecipes = given.removeRecipes;
      finalReplace = given.replace;
    } else if (local.keys.includes("recipes")) {
      // local.keys includes recipes and no recipe flag typed: no recipes question; say the chain from the draft resolved with local recipes
      const templateRecipes = newProfileLike ? forge.profiles.get(newProfileLike)!.recipes : [];
      const draftProfile = ProfileSchema.parse({ name: newProfileName!, recipes: templateRecipes, targets: [] });
      const draftCopy = withProfile(forge, draftProfile);
      const recipeConfig = { ...localConfig!, profile: newProfileName! };
      const resolution = resolve(draftCopy, recipeConfig);
      io.say(`Recipes: ${resolution.recipes.join(" → ")} (from craftar.local.yaml)`);
    } else {
      // Track whether we should start with Remove (after a P10 error)
      let startWithRemove = false;

      recipeLoop: for (;;) {
        // Compute the draft profile in a copy of the Forge for the recipes line
        const template = newProfileLike ? forge.profiles.get(newProfileLike) : undefined;
        const draftRecipes = template?.recipes ?? [];
        
        if (template && !startWithRemove) {
          // With a template: show the chain resolved from the draft profile
          const draft = ProfileSchema.parse({ name: newProfileName!, recipes: draftRecipes, targets: template.targets });
          const copy = withProfile(forge, draft);
          // Use mergeWorkspaceConfig to get a valid config with overrides
          const config = mergeWorkspaceConfig(
            { forge: forgeSource(root, answeredForge!), profile: newProfileName! },
            null
          ).config;
          const resolution = resolve(copy, config);
          io.say(`Recipes of ${newProfileName} (from ${newProfileLike}): ${resolution.recipes.join(" → ")}`);
          
          // Adjust the recipes [no]:
          const adjustAns = await io.ask("Adjust the recipes [no]: ");
          if (adjustAns === null) return { kind: "cancelled" };
          const yn = yesNo(adjustAns);
          if (adjustAns.trim() !== "" && yn === null) {
            io.say("answer yes or no");
            continue recipeLoop;
          }
          if (yn !== true) {
            // No adjustment: check P10 on the template's recipes before accepting, using ownedBy
            const templateRecipes = template.recipes;
            for (const r of templateRecipes) {
              const owner = ownedBy(forge, r);
              if (owner !== null) {
                io.say(ownedRecipeRefusal(r, owner));
                startWithRemove = true;
                continue recipeLoop;
              }
            }
            // Success: use template's recipes as-is
            break recipeLoop;
          }
        }

        // Show the Forge's recipes list
        io.say(`Recipes in ${answeredForge}:`);
        // A new profile has no locals: the root's recipes (spec 51 §4.3).
        const allRecipes = [...forge.recipes.values()].sort((a, b) => a.name.localeCompare(b.name));
        for (let i = 0; i < allRecipes.length; i++) {
          const r = allRecipes[i];
          const parts = [`  ${i + 1}) ${r.name}`];
          if (draftRecipes.includes(r.name)) parts.push("· in use");
          if (r.slot) parts.push(`· slot ${r.slot}`);
          if (r.description) parts.push(`· ${r.description}`);
          io.say(parts.join(" "));
        }

        const names = allRecipes.map((r) => r.name);
        const parseRecipeAnswer = (answer: string): string[] =>
          answer.split(",").map((s) => s.trim()).filter((s) => s !== "").map((s) => pickItem(names, s) ?? s);

        // Remove question (only with a template, or after P10 error)
        let removeNames: string[] = [];
        if (template || startWithRemove) {
          const removeAns = await io.ask("Remove [none]: ");
          if (removeAns === null) return { kind: "cancelled" };
          removeNames = parseRecipeAnswer(removeAns);
        }

        // Add question
        const addAns = await io.ask("Add [none]: ");
        if (addAns === null) return { kind: "cancelled" };
        let addNames = parseRecipeAnswer(addAns);

        // Reset startWithRemove for the next iteration
        startWithRemove = false;

        if (removeNames.length === 0 && addNames.length === 0) {
          // No changes entered: check P10 on the final list (same as template's recipes)
          if (template) {
            for (const r of template.recipes) {
              const owner = ownedBy(forge, r);
              if (owner !== null) {
                io.say(ownedRecipeRefusal(r, owner));
                startWithRemove = true;
                continue recipeLoop;
              }
            }
          }
          // P10 passed or no template
          break recipeLoop;
        }

        // N6 check: a name both added and removed — say and re-ask
        const both = addNames.find((n) => removeNames.includes(n));
        if (both !== undefined) {
          try {
            checkInitFlags({ addRecipes: addNames, removeRecipes: removeNames });
          } catch (e) {
            io.say((e as Error).message);
            continue recipeLoop;
          }
        }

        // Compute the recipe edit for notes and P10 check (mirroring existing flow)
        // We do removes first, then adds — as init.ts and the existing flow do
        const editConfig = mergeWorkspaceConfig(
          { forge: forgeSource(root, answeredForge!), profile: newProfileName! },
          null
        ).config;
        let tempConfig = { ...editConfig, recipes: { add: [] as string[], remove: [] as string[] } };

        // Simulate the edits on the template to get notes
        const templateRecipes = newProfileLike ? forge.profiles.get(newProfileLike)!.recipes : [];
        const draftProfile = ProfileSchema.parse({ name: newProfileName!, recipes: templateRecipes, targets: [] });
        const draftCopy = withProfile(forge, draftProfile);

        // The remove edit and add loop inside one outer try: any refusal → say the message and continue recipeLoop
        try {
          // Process removes, say notes
          if (removeNames.length > 0) {
            const removeEdit = planRecipeEdit(draftCopy, tempConfig, "remove", removeNames);
            tempConfig = { ...tempConfig, recipes: removeEdit.recipes };
            if (removeEdit.reasons.length > 0) {
              io.say(`  note ${removeEdit.reasons.join(", ")}`);
            }
          }

          // Process adds, say notes, handle slot held
          let doReplace = false;
          addSlotLoop: for (;;) {
            try {
              const addEdit = planRecipeEdit(draftCopy, tempConfig, "add", addNames, { replace: doReplace });
              tempConfig = { ...tempConfig, recipes: addEdit.recipes };
              if (addEdit.reasons.length > 0) {
                io.say(`  note ${addEdit.reasons.join(", ")}`);
              }
              break addSlotLoop;
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
                  continue addSlotLoop;
                }
                // User said no to replace, re-ask recipes
                continue recipeLoop;
              }
              // Other errors (unknown recipe, etc.): re-throw to outer try
              throw e;
            }
          }

          // Compute the final list: template's recipes minus removes, plus adds
          const finalList = [
            ...templateRecipes.filter((r) => !tempConfig.recipes.remove.includes(r)),
            ...tempConfig.recipes.add,
          ];

          // P10 check on the final list
          for (const r of finalList) {
            const owner = ownedBy(forge, r);
            if (owner !== null) {
              io.say(ownedRecipeRefusal(r, owner));
              startWithRemove = true;
              continue recipeLoop;
            }
          }

          // Success
          finalAddRecipes = addNames;
          finalRemoveRecipes = removeNames;
          finalReplace = doReplace;
          break recipeLoop;
        } catch (e) {
          io.say((e as Error).message);
          continue recipeLoop;
        }
      }
    }

    answeredAddRecipes = finalAddRecipes;
    answeredRemoveRecipes = finalRemoveRecipes;
    answeredReplace = finalReplace;

    // Targets question for new profile
    // Typed flags answer their questions (spec 38 §4.2, §4.3)
    if (given.targets !== undefined) {
      answeredTargets = given.targets;
    } else if (local.keys.includes("targets")) {
      // local.keys includes targets and no --targets typed: no targets question; say the local value
      const localTargets = localConfig?.targets ?? [];
      io.say(`Targets: ${localTargets.join(", ")} (from craftar.local.yaml)`);
    } else {
      // Default: [<template's targets>, from <like>] or [claude-code, default]
      const template = newProfileLike ? forge.profiles.get(newProfileLike) : undefined;
      const defaultTargets = template?.targets ?? ["claude-code"];
      const fromText = template ? `from ${newProfileLike}` : "default";
      const targetsQ = `Targets — ${TARGETS.join(", ")}, separated by commas [${defaultTargets.join(", ")}, ${fromText}]: `;
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

    // Build the result for new profile
    const input: InitInput = {
      forge: answeredForge!,
      profile: newProfileName!,
      loaded: loaded,
      newProfile: newProfileLike ? { name: newProfileName!, like: newProfileLike } : { name: newProfileName! },
    };
    if (answeredRef !== undefined) input.ref = answeredRef;
    if (answeredTargets !== undefined) input.targets = answeredTargets;
    if (answeredAddRecipes.length > 0) input.addRecipes = answeredAddRecipes;
    if (answeredRemoveRecipes.length > 0) input.removeRecipes = answeredRemoveRecipes;
    if (answeredReplace) input.replace = true;
    if (given.clone === true) input.clone = true;

    // For new profile: answers has --profile name (for the again line), no recipe/target flags
    const answers: InitAnswers = {
      forge: answeredForge!,
      profile: newProfileName!,
      addRecipes: [],
      removeRecipes: [],
      replace: false,
    };
    if (answeredRef !== undefined) answers.ref = answeredRef;

    return { kind: "answered", input, answers };
  }

  // Existing profile flow (unchanged)
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
      // The profile's view (spec 51 §4.3): its local recipes are listed, and found when in use.
      const allRecipes = [...forgeFor(forge, answeredProfile!).recipes.values()].sort((a, b) => a.name.localeCompare(b.name));
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
  if (given.clone === true) input.clone = true;

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
