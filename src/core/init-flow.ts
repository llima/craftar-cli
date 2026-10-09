import type { Registry, RegistryEntry } from "../schema/index.js";
import { countStates } from "./impact.js";
import { initLine, type InitPlan } from "./init.js";
import { credentialFault } from "./remote.js";

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
