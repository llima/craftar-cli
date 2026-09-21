import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { listFiles } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";

/**
 * `unify` writes into and deletes from a Forge — the structural argument that carried the
 * previous slice ("no emitter touched, so no emitted byte can change") does not hold here. This
 * is the byte net that replaces the oracle for this slice: a committed input Forge
 * (`test/golden/forge-unify/`), a committed plan (`test/golden/forge-unify-plan.yaml`, beside the
 * Forge — never inside it, or the command's own clean-tree refusal would trip on it) and a
 * committed expected tree (`test/golden/forge-unify-expected/`) after the run below.
 *
 * The run resolves three variants of the same recipe (`recipes/base--acme.yaml`), in this order:
 *   1. rule/eof   --take variant   (a final-newline-only difference)
 *   2. rule/meta  --take base      (a meta-only variant; its body merge writes nothing)
 *   3. rule/workflow --plan <committed plan>  (a hunk merge, a one-sided copy, a one-sided no-op)
 * Steps 1 and 2 use the trivial `--take` front end and need no plan file of their own. Step 3 is
 * last on purpose: only once every variant of `base--acme` is resolved does its `ingredients`
 * list become identical to `recipes/base.yaml`'s, which is what triggers the recipe-cascade
 * dedup (spec forge-unify-spine.md §7.2 step 3) — `recipes/base--acme.yaml` deleted and
 * `profiles/acme/profile.yaml` repointed at `base`. `test/helpers/regen-golden-unify.ts` runs the
 * same three steps to produce the committed plan and expected tree, so a change to either the
 * input Forge or the engine surfaces here as a diff to review, not a hand-edit to match.
 */
const GOLDEN = path.resolve(__dirname, "golden");
const INPUT = path.join(GOLDEN, "forge-unify");
const EXPECTED = path.join(GOLDEN, "forge-unify-expected");
const PLAN = path.join(GOLDEN, "forge-unify-plan.yaml");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** listFiles walks every entry, `.git/` included; a byte comparison never wants that folder. */
async function forgeFiles(dir: string): Promise<string[]> {
  return (await listFiles(dir)).filter((rel) => rel !== ".git" && !rel.startsWith(".git/"));
}

async function copyTree(src: string, dst: string): Promise<void> {
  for (const rel of await forgeFiles(src)) {
    await fs.mkdir(path.dirname(path.join(dst, rel)), { recursive: true });
    await fs.copyFile(path.join(src, rel), path.join(dst, rel));
  }
}

/** A fake but stable identity, so `git commit` never depends on the host's ambient config. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "craftar-test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "craftar-test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
}

function gitCommitAll(dir: string, message: string): void {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", message], { env: gitEnv() });
}

describe("golden: forge unify writes exact bytes into a Forge", () => {
  it("resolving eof, then meta, then workflow (via a committed plan) reproduces the expected tree byte for byte", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-golden-unify-"));
    cleanups.push(() => fs.rm(tmp, { recursive: true, force: true }));
    const forge = path.join(tmp, "forge");
    await copyTree(INPUT, forge);
    gitInit(forge); // the refusals need a real git repository
    gitCommitAll(forge, "init");

    const eof = runCli(["forge", "unify", "rule/eof", "--profile", "acme", "--take", "variant", "--forge", forge]);
    expect(eof.code, eof.stderr).toBe(0);
    gitCommitAll(forge, "resolve eof");

    const meta = runCli(["forge", "unify", "rule/meta", "--profile", "acme", "--take", "base", "--forge", forge]);
    expect(meta.code, meta.stderr).toBe(0);
    gitCommitAll(forge, "resolve meta");

    // The committed plan's fingerprints are for rule/workflow and rule/workflow--acme, untouched
    // by the two runs above, so the plan is still fresh here.
    const workflow = runCli(["forge", "unify", "rule/workflow", "--profile", "acme", "--plan", PLAN, "--forge", forge]);
    expect(workflow.code, workflow.stderr).toBe(0);
    expect(workflow.stdout).toContain("recipes deleted: base--acme");
    expect(workflow.stdout).toContain("profiles repointed: base--acme -> base");

    const expectedFiles = await forgeFiles(EXPECTED);
    const actualFiles = await forgeFiles(forge);
    expect(actualFiles).toEqual(expectedFiles);

    for (const rel of expectedFiles) {
      const want = await fs.readFile(path.join(EXPECTED, rel));
      const got = await fs.readFile(path.join(forge, rel));
      expect(got.equals(want), `${rel} differs`).toBe(true);
    }
  });
});
