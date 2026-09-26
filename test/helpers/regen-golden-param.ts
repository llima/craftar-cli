/**
 * Regenerates test/golden/forge-param-expected/ and the two committed plans
 * (test/golden/forge-param-plan-deploy.yaml, forge-param-plan-ports.yaml) from the committed input
 * Forge at test/golden/forge-param/, by running the real `craftar forge unify` the way
 * `test/golden-param.test.ts` does (spec 09 §11.3).
 *
 * Run it only after an intended change to the input Forge or to parameter extraction, and review
 * the resulting diff like code — never hand-edit an output to make the test pass.
 *
 * Usage: npx tsx test/helpers/regen-golden-param.ts
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { listFiles } from "../../src/core/forge.js";
import { asParamPlan } from "./golden-param-edits.js";
import { TSX_LOADER } from "./tsx-loader.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const GOLDEN_ROOT = path.resolve(HERE, "../golden");
const INPUT = path.join(GOLDEN_ROOT, "forge-param");
const EXPECTED = path.join(GOLDEN_ROOT, "forge-param-expected");
const PLANS = { deploy: path.join(GOLDEN_ROOT, "forge-param-plan-deploy.yaml"), ports: path.join(GOLDEN_ROOT, "forge-param-plan-ports.yaml") };

// A local runCli, as in regen-golden-unify.ts: test/helpers/cli.ts reads __dirname, which a
// top-level-await ESM script cannot use.
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

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "craftar-test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "craftar-test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
});
const gitCommitAll = (dir: string, message: string) => {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", message], { env: gitEnv() });
};
const forgeFiles = async (dir: string) => (await listFiles(dir)).filter((rel) => rel !== ".git" && !rel.startsWith(".git/"));
async function copyTree(src: string, dst: string): Promise<void> {
  for (const rel of await forgeFiles(src)) {
    await fs.mkdir(path.dirname(path.join(dst, rel)), { recursive: true });
    await fs.copyFile(path.join(src, rel), path.join(dst, rel));
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-regen-param-"));
const forge = path.join(tmp, "forge");
try {
  await copyTree(INPUT, forge);
  execFileSync("git", ["init", "-q", forge]);
  gitCommitAll(forge, "init");

  for (const [name, planPath] of Object.entries(PLANS)) {
    const tmpPlan = path.join(tmp, `${name}.yaml`);
    const save = runCli(["forge", "unify", `rule/${name}`, "--profile", "acme", "--save-plan", tmpPlan, "--forge", forge]);
    if (save.code !== 0) throw new Error(`--save-plan rule/${name} failed: ${save.stderr}`);
    const yaml = YAML.stringify(asParamPlan(YAML.parse(await fs.readFile(tmpPlan, "utf8"))));
    await fs.writeFile(tmpPlan, yaml);
    await fs.writeFile(planPath, yaml);
  }
  for (const name of Object.keys(PLANS)) {
    const r = runCli(["forge", "unify", `rule/${name}`, "--profile", "acme", "--plan", path.join(tmp, `${name}.yaml`), "--forge", forge]);
    if (r.code !== 0) throw new Error(`rule/${name} unify (--plan) failed: ${r.stderr}`);
    gitCommitAll(forge, `unify ${name}`);
  }

  await fs.rm(EXPECTED, { recursive: true, force: true });
  await copyTree(forge, EXPECTED);
  console.log(`regenerated test/golden/forge-param-expected (${(await forgeFiles(EXPECTED)).length} files) and both plans`);
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
