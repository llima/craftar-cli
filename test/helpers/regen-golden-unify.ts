/**
 * Regenerates test/golden/forge-unify-expected/ AND test/golden/forge-unify-plan.yaml from the
 * committed input Forge at test/golden/forge-unify/, by running the real `craftar forge unify`
 * command through the CLI the way `test/golden-unify.test.ts` does.
 *
 * Run this only after an intended change to the input Forge or to `unify` itself, and review the
 * resulting diff like code — never hand-edit either output to make the test pass.
 *
 * The plan file carries `baseFingerprint` / `variantFingerprint` (`fingerprintDir` of
 * `rule/workflow` and `rule/workflow--acme` at the moment it is saved). Regenerating only the
 * expected tree and leaving the committed plan alone would make a stale plan look like a bug in
 * `unify` ("the plan is stale: …") instead of what it is — a golden that needs regeneration too.
 * That is why this script rewrites both outputs from the same run, never one without the other.
 *
 * Usage: npx tsx test/helpers/regen-golden-unify.ts
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { listFiles } from "../../src/core/forge.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const GOLDEN_ROOT = path.resolve(HERE, "../golden");
const INPUT = path.join(GOLDEN_ROOT, "forge-unify");
const EXPECTED = path.join(GOLDEN_ROOT, "forge-unify-expected");
const PLAN = path.join(GOLDEN_ROOT, "forge-unify-plan.yaml");

// A local copy of test/helpers/cli.ts' `runCli`, not imported from it: that module reads
// `__dirname`, which Node refuses to resolve once a top-level `await` (this script has one)
// makes it ambiguous whether the entry module is CJS or ESM. `import.meta.url` is ESM-native and
// carries no such ambiguity. Same behaviour — real process, colours off, `src/cli.ts` from source.
const TSX = pathToFileURL(path.join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href;
function runCli(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", TSX, path.join(REPO, "src/cli.ts"), ...args], {
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

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
}

function gitCommitAll(dir: string, message: string): void {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", message], { env: gitEnv() });
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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-regen-unify-"));
const forge = path.join(tmp, "forge");
try {
  await copyTree(INPUT, forge);
  gitInit(forge);
  gitCommitAll(forge, "init");

  // The plan file, generated against the freshly committed Forge so its fingerprints are real —
  // rule/workflow and rule/workflow--acme are untouched by the eof/meta runs below, so saving it
  // here (before them) and applying it after is exactly what the test does, and produces the same
  // fingerprints either way.
  const planTmp = path.join(tmp, "plan.yaml"); // outside the Forge (Ruling: never inside it)
  const save = runCli(["forge", "unify", "rule/workflow", "--profile", "acme", "--save-plan", planTmp, "--forge", forge]);
  if (save.code !== 0) throw new Error(`--save-plan failed: ${save.stderr}`);

  const plan = YAML.parse(await fs.readFile(planTmp, "utf8"));
  // The three decisions the golden exercises together: a hunk taken from the variant (merge), a
  // one-sided file taken from the variant (copy), a one-sided file left at the base (no-op).
  plan.files.find((f: { file: string }) => f.file === "rule.md").hunks[0].take = "variant";
  plan.files.find((f: { file: string }) => f.file === "extra.md").take = "variant";
  plan.files.find((f: { file: string }) => f.file === "notes.md").take = "base";
  const planYaml = YAML.stringify(plan);
  await fs.writeFile(planTmp, planYaml);
  await fs.writeFile(PLAN, planYaml);

  // Resolve eof and meta directly (--take), so the workflow run below is the one that completes
  // every variant of recipe base--acme and triggers its dedup against recipes/base.yaml (spec
  // §7.2 step 3). Each run needs a clean git tree, so commit in between.
  const eof = runCli(["forge", "unify", "rule/eof", "--profile", "acme", "--take", "variant", "--forge", forge]);
  if (eof.code !== 0) throw new Error(`rule/eof unify failed: ${eof.stderr}`);
  gitCommitAll(forge, "resolve eof");

  const meta = runCli(["forge", "unify", "rule/meta", "--profile", "acme", "--take", "base", "--forge", forge]);
  if (meta.code !== 0) throw new Error(`rule/meta unify failed: ${meta.stderr}`);
  gitCommitAll(forge, "resolve meta");

  const workflow = runCli(["forge", "unify", "rule/workflow", "--profile", "acme", "--plan", planTmp, "--forge", forge]);
  if (workflow.code !== 0) throw new Error(`rule/workflow unify (--plan) failed: ${workflow.stderr}`);

  await fs.rm(EXPECTED, { recursive: true, force: true });
  await copyTree(forge, EXPECTED);

  console.log(`regenerated test/golden/forge-unify-expected (${(await forgeFiles(EXPECTED)).length} files)`);
  console.log(`regenerated test/golden/forge-unify-plan.yaml`);
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
