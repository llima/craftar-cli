/**
 * Spec 38 §5.3 — the profile write (step 3) and the second proof from disk (step 4).
 * No console, no process — these are pure write operations and a second planInit call.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { planInit, type InitOptions, type InitPlan } from "./init.js";
import { errorText } from "./schema-fault.js";
import { note, type WriteJournal } from "./unify.js";

export { type WriteJournal };

/**
 * Thrown when another run (or something else) created the profile's place first.
 * P7's first message, with no recover lines — the directory belongs to the other run.
 */
export class NewProfileRaceLost extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NewProfileRaceLost";
  }
}

/**
 * Thrown when the profile write fails (other than EEXIST) or the second proof does not match.
 * Carries the write journal so the caller can print the late-failure lines.
 */
export class NewProfileLateFailure extends Error {
  journal: WriteJournal;
  constructor(message: string, journal: WriteJournal) {
    super(message);
    this.name = "NewProfileLateFailure";
    this.journal = journal;
  }
}

/** Hooks for testing: injected seams between the steps. */
export interface WriteHooks {
  /** Called after the directory is journalled and before the mkdirs. */
  beforeMkdir?: () => Promise<void>;
  /** Called after the mkdirs and before the writeFile. */
  beforeWrite?: () => Promise<void>;
}

/**
 * Step 3 of §5.3: write the profile file into the Forge.
 *
 * - `profiles/<name>` is the only path journalled (never `profiles`, never the file).
 * - The directory is journalled BEFORE the mkdir (note() decides "created" from whether the path exists when called).
 * - `profiles` is made with `recursive: true` (EEXIST not an error).
 * - `profiles/<name>` is made WITHOUT recursive: EEXIST → throw NewProfileRaceLost.
 * - The file is written with `wx`: EEXIST → throw NewProfileRaceLost.
 * - Any other error → throw NewProfileLateFailure with the journal.
 *
 * @param forgeRoot The Forge's root directory.
 * @param init The plan from planInit with newProfile set.
 * @param hooks Optional hooks for testing.
 * @returns The write journal.
 */
export async function writeNewProfile(
  forgeRoot: string,
  init: InitPlan,
  hooks?: WriteHooks,
): Promise<WriteJournal> {
  if (!init.newProfile) throw new Error("writeNewProfile: init.newProfile is required");

  const name = path.basename(path.dirname(init.newProfile.path));
  const profileDir = path.join(forgeRoot, "profiles", name);
  const profileFile = path.join(profileDir, "profile.yaml");

  const journal: WriteJournal = [];

  // Journal the profile's own directory BEFORE the mkdir
  await note(journal, profileDir);

  try {
    if (hooks?.beforeMkdir) await hooks.beforeMkdir();

    // Make profiles/ with recursive: true (EEXIST not an error)
    await fs.mkdir(path.join(forgeRoot, "profiles"), { recursive: true });

    // Make profiles/<name> WITHOUT recursive: EEXIST means another run won
    try {
      await fs.mkdir(profileDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        throw new NewProfileRaceLost(`profile ${name} already exists in the Forge — use --profile ${name}`);
      }
      throw e;
    }

    if (hooks?.beforeWrite) await hooks.beforeWrite();

    // Write the file with wx: EEXIST is the backstop
    try {
      await fs.writeFile(profileFile, init.newProfile.text, { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        throw new NewProfileRaceLost(`profile ${name} already exists in the Forge — use --profile ${name}`);
      }
      throw e;
    }

    return journal;
  } catch (e) {
    // NewProfileRaceLost passes through
    if (e instanceof NewProfileRaceLost) throw e;
    // Any other error: wrap in NewProfileLateFailure with the journal
    throw new NewProfileLateFailure(errorText(e), journal);
  }
}

/**
 * Step 4 of §5.3: a second planInit from disk, with no newProfile, no loaded, and no recipe or target flag.
 *
 * The plan must hold the same paths and the same bytes as init1's (Buffer.equals per file, same path set).
 * A difference — a file changed between the two steps — stops the run.
 *
 * @param root The workspace root.
 * @param forgeArg The --forge argument (path or URL, relative to root).
 * @param init1 The first plan (with newProfile).
 * @param opts Options for planInit (without local, which is read fresh).
 * @param journal The write journal, for error reporting.
 * @param ref The typed ref from the input (not the merged config's ref).
 * @returns The second plan.
 */
export async function reproveFromDisk(
  root: string,
  forgeArg: string,
  init1: InitPlan,
  opts: InitOptions,
  journal: WriteJournal = [],
  ref?: string,
): Promise<InitPlan> {
  if (!init1.newProfile) throw new Error("reproveFromDisk: init1.newProfile is required");

  const name = path.basename(path.dirname(init1.newProfile.path));

  // Second planInit: profile exists on disk, no newProfile, no loaded, no recipe or target flag
  // Use the typed ref, not init1.ws.config.ref (which is the merged config, including craftar.local.yaml)
  let init2: InitPlan;
  try {
    init2 = await planInit(
      root,
      {
        forge: forgeArg,
        profile: name,
        ref,
        // NO newProfile, NO loaded, NO recipe or target flag
      },
      opts,
    );
  } catch (e) {
    // Wrap EVERY error of the second planInit in NewProfileLateFailure
    throw new NewProfileLateFailure(errorText(e), journal);
  }

  // Compare: same paths and same bytes
  const paths1 = new Set(init1.plan.files.map((f) => f.path));
  const paths2 = new Set(init2.plan.files.map((f) => f.path));

  // Same path set?
  if (paths1.size !== paths2.size) {
    throw new NewProfileLateFailure(
      "the Forge read back from disk does not plan what init proved in memory — a Forge file changed while init ran",
      journal,
    );
  }
  for (const p of paths1) {
    if (!paths2.has(p)) {
      throw new NewProfileLateFailure(
        "the Forge read back from disk does not plan what init proved in memory — a Forge file changed while init ran",
        journal,
      );
    }
  }

  // Same bytes per file?
  const map1 = new Map(init1.plan.files.map((f) => [f.path, f.content]));
  for (const f of init2.plan.files) {
    const content1 = map1.get(f.path)!;
    if (!content1.equals(f.content)) {
      throw new NewProfileLateFailure(
        "the Forge read back from disk does not plan what init proved in memory — a Forge file changed while init ran",
        journal,
      );
    }
  }

  return init2;
}
