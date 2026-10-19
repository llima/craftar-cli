/**
 * Spec 38 §4.2/§5.2 — the gate of the one path `init --new-profile` creates, as `drift promote`
 * holds it for a path it creates. Called by the command after the load and before `planInit`, and
 * by the flow (P5/P6 when the profile list is built; P7/P8 when the name is answered).
 *
 * Reads the disk and runs git ONLY through `gitIsRepo`, `gitHasCommit`, `gitIgnored` and
 * `assertNoLinkOnPath` — no other git call, no second copy of those checks.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { assertNoLinkOnPath, gitHasCommit, gitIgnored, gitIsRepo, type Forge } from "./forge.js";
import { assertNotCacheTree } from "./remote.js";

/**
 * The gate of the one path `init --new-profile` creates.
 * @param forge The loaded Forge.
 * @param home The `$CRAFTAR_HOME` directory.
 * @param name The profile name, if known (P7 and P8 are skipped without it).
 */
export async function newProfileGate(forge: Forge, home: string, name?: string): Promise<void> {
  const root = forge.root;

  // P5: the check is assertNotCacheTree
  await assertNotCacheTree(root, home);

  // P6: not a git repository, or has no commit
  const isRepo = await gitIsRepo(root);
  const hasCommit = isRepo && (await gitHasCommit(root));
  if (!isRepo || !hasCommit) {
    throw new Error(
      `cannot create a profile in ${root}: it is not a git repository with a commit — git is how a Forge write is undone`,
    );
  }

  // Without name: return here (P5/P6 only for the flow's profile list question)
  if (!name) return;

  // P8 links: assertNoLinkOnPath on the DIRECTORY path, not the file's
  const profileDir = path.join(root, "profiles", name);
  await assertNoLinkOnPath(root, [profileDir], "init");

  // P7 by name: forge.profiles.has(name)
  if (forge.profiles.has(name)) {
    throw new Error(`profile ${name} already exists in the Forge — use --profile ${name}`);
  }

  // P7 by directory: list profiles/ (ENOENT → nothing there); an entry whose name lower-cased
  // equals name lower-cased → message with the spelling found
  const profilesDir = path.join(root, "profiles");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(profilesDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
    // ENOENT: no profiles directory yet, nothing there
  }
  const nameLower = name.toLowerCase();
  for (const entry of entries) {
    if (entry.toLowerCase() === nameLower) {
      throw new Error(
        `profiles/${entry} already exists in the Forge and holds no profile named ${name} — pick another name, or remove it`,
      );
    }
  }

  // P8 ignored: gitIgnored(root, `profiles/${name}/profile.yaml`)
  // gitIgnored fails closed — keep it so
  const rel = `profiles/${name}/profile.yaml`;
  if (await gitIgnored(root, rel)) {
    throw new Error(`cannot create profiles/${name}/profile.yaml: git ignores it`);
  }
}
