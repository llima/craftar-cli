/**
 * Regenerates test/golden/forge-promote-expected/ from the committed input Forge at
 * test/golden/forge-promote/, by running the real `craftar forge promote` command through the CLI
 * the way `test/golden-promote.test.ts` does.
 *
 * Run this only after an intended change to the input Forge or to `forge promote` itself, and
 * review the resulting diff like code — never hand-edit the expected tree to make the test pass.
 *
 * Usage: npx tsx test/helpers/regen-golden-promote.ts
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listFiles } from "../../src/core/forge.js";
import { TSX_LOADER } from "./tsx-loader.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const GOLDEN_ROOT = path.resolve(HERE, "../golden");
const INPUT = path.join(GOLDEN_ROOT, "forge-promote");
const EXPECTED = path.join(GOLDEN_ROOT, "forge-promote-expected");

// A local copy of test/helpers/cli.ts' `runCli`, for the reason regen-golden-unify.ts gives: that
// module reads `__dirname`, which a script with a top-level `await` cannot rely on.
function runCli(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", TSX_LOADER, path.join(REPO, "src/cli.ts"), ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 25_000,
  });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "craftar-test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "craftar-test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
}

/** listFiles walks every entry, `.git/` included; the Forge's own tree never wants that folder. */
async function forgeFiles(dir: string): Promise<string[]> {
  return (await listFiles(dir)).filter((rel) => rel !== ".git" && !rel.startsWith(".git/"));
}

async function copyTree(src: string, dst: string): Promise<void> {
  for (const rel of await forgeFiles(src)) {
    await fs.mkdir(path.dirname(path.join(dst, rel)), { recursive: true });
    await fs.copyFile(path.join(src, rel), path.join(dst, rel));
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-regen-basepromo-"));
const forge = path.join(tmp, "forge");
try {
  await copyTree(INPUT, forge);
  execFileSync("git", ["init", "-q", forge]);
  execFileSync("git", ["-C", forge, "add", "-A"]);
  execFileSync("git", ["-C", forge, "commit", "-q", "-m", "init"], { env: gitEnv() });

  // --no-impact: the golden is the Forge's bytes; no registry is read.
  const r = runCli(["forge", "promote", "rule/workflow", "--profile", "acme", "--no-impact", "--forge", forge]);
  if (r.code !== 0) throw new Error(`forge promote failed (${r.code}): ${r.stderr}`);

  await fs.rm(EXPECTED, { recursive: true, force: true });
  await copyTree(forge, EXPECTED);
  console.log(`regenerated ${path.relative(REPO, EXPECTED)} (${(await forgeFiles(EXPECTED)).length} files)`);
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
