import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";
import { tmpDir, writeFiles } from "./forge.js";
import { removeWithRetry } from "./fs.js";

// The setup test/generated-ignored.test.ts spells inline, for a file whose git must not read the developer's configuration:
// the global and system files, the XDG ignore file (`~/.config/git/ignore`), and a run from inside a git hook.
const CLEARED = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_PREFIX",
  "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE",
  "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
];

/** Register beforeAll / afterAll hooks that make every git this test file starts, in process and in a child, hermetic. */
export function hermeticGit(): void {
  const saved = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "XDG_CONFIG_HOME", "GIT_CEILING_DIRECTORIES", ...CLEARED].map((k) => [k, process.env[k]] as const);
  let dir = "";
  beforeAll(async () => {
    dir = await tmpDir("craftar-hermetic-git-");
    await writeFiles(dir, { gitconfig: "" });
    process.env.GIT_CONFIG_GLOBAL = path.join(dir, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.XDG_CONFIG_HOME = dir;
    // A TMPDIR inside a repository must not make "not in a repository" false.
    process.env.GIT_CEILING_DIRECTORIES = await fs.realpath(os.tmpdir());
    for (const k of CLEARED) delete process.env[k];
  });
  afterAll(async () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await removeWithRetry(dir);
  });
}
