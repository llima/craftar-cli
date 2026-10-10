import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { listFiles } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { tmpDir } from "./helpers/forge.js";
import { git } from "./helpers/remote.js";

/**
 * `forge promote` writes into and deletes from a Forge, so "no emitter touched" is no argument here. This is the
 * byte net of spec 29, slice D: a committed input Forge (`test/golden/forge-promote/`) — three profiles, a shared
 * recipe with a slot, params and comments, a CRLF file, a file that is not valid UTF-8, a file only each side has —
 * and the committed tree after `forge promote rule/workflow --profile acme` (`test/golden/forge-promote-expected/`,
 * written only by `test/helpers/regen-golden-promote.ts`).
 */
const GOLDEN = path.resolve(__dirname, "golden");
const INPUT = path.join(GOLDEN, "forge-promote");
const EXPECTED = path.join(GOLDEN, "forge-promote-expected");

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** listFiles walks every entry, `.git/` included; a byte comparison never wants that folder. */
async function forgeFiles(dir: string): Promise<string[]> {
  return (await listFiles(dir)).filter((rel) => rel !== ".git" && !rel.startsWith(".git/"));
}

describe("golden: forge promote writes exact bytes into a Forge", () => {
  it("promoting acme's variant of rule/workflow reproduces the expected tree byte for byte", async () => {
    const tmp = await tmpDir("craftar-golden-basepromo-");
    cleanups.push(() => fs.rm(tmp, { recursive: true, force: true }));
    const forge = path.join(tmp, "forge");
    for (const rel of await forgeFiles(INPUT)) {
      await fs.mkdir(path.dirname(path.join(forge, rel)), { recursive: true });
      await fs.copyFile(path.join(INPUT, rel), path.join(forge, rel));
    }
    git(forge, "init", "-q");
    git(forge, "add", "-A");
    git(forge, "commit", "-q", "-m", "init");

    const r = runCli(["forge", "promote", "rule/workflow", "--profile", "acme", "--no-impact", "--forge", forge]);
    expect(r.code, r.stderr).toBe(0);

    const expectedFiles = await forgeFiles(EXPECTED);
    expect(await forgeFiles(forge)).toEqual(expectedFiles);
    for (const rel of expectedFiles) {
      expect((await fs.readFile(path.join(forge, rel))).equals(await fs.readFile(path.join(EXPECTED, rel))), `${rel} differs`).toBe(true);
    }
    // What the tree must show whatever its bytes: the shared recipe untouched, the variant's directory gone.
    expect((await fs.readFile(path.join(forge, "recipes/base.yaml"))).equals(await fs.readFile(path.join(INPUT, "recipes/base.yaml")))).toBe(true);
    expect(expectedFiles.filter((f) => f.startsWith("ingredients/rules/workflow--acme/"))).toEqual([]);
  });
});
