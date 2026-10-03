/**
 * Regenerates test/golden/forge-take-section-expected/ from the committed input workspaces
 * by running the real `craftar import` and `craftar forge unify` commands the way
 * `test/golden-take-section.test.ts` does (spec 12 §10.5).
 *
 * Run this only after an intended change to the input workspaces or to section extraction,
 * and review the resulting diff like code — never hand-edit the output to make the test pass.
 *
 * Usage: npx tsx test/helpers/regen-golden-take-section.ts
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { listFiles } from "../../src/core/forge.js";
import { importClaudeCode } from "../../src/importers/claude-code.js";
import { TSX_LOADER } from "./tsx-loader.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const GOLDEN_ROOT = path.resolve(HERE, "../golden");
const INPUT = {
  acme: path.join(GOLDEN_ROOT, "take-section-acme"),
  globex: path.join(GOLDEN_ROOT, "take-section-globex"),
  initech: path.join(GOLDEN_ROOT, "take-section-initech"),
};
const EXPECTED = path.join(GOLDEN_ROOT, "forge-take-section-expected");
const PROFILES = ["acme", "globex", "initech"] as const;
type P = (typeof PROFILES)[number];
const FIXED = new Date("2026-10-02T12:00:00Z");

// A local runCli, as in regen-golden-unify.ts.
function runCli(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", TSX_LOADER, path.join(REPO, "src/cli.ts"), ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 60_000,
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
async function edit(file: string, f: (text: string) => string): Promise<void> {
  await fs.writeFile(file, f(await fs.readFile(file, "utf8")));
}

function addKiroAndAgentsMd(yaml: string): string {
  const out = yaml.replace(/^(targets:\n(?: {2}- .*\n)+)/m, "$1  - kiro\n  - agents-md\n");
  if (out === yaml) throw new Error("expected a block targets list");
  return out;
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-regen-take-section-"));
const forge = path.join(tmp, "forge");
const ws: Record<P, string> = {
  acme: path.join(tmp, "acme"),
  globex: path.join(tmp, "globex"),
  initech: path.join(tmp, "initech"),
};

try {
  // Step 1: Import all three at a fixed date.
  // We use a hack to simulate a fixed date for import: set the description manually after.
  for (const p of PROFILES) {
    await copyTree(INPUT[p], ws[p]);
    const r = await importClaudeCode({ workspaceRoot: ws[p], forgeRoot: forge, profileName: p, writeWorkspaceConfig: true });
    if (r.rejected.length > 0) throw new Error(`Import ${p} rejected: ${JSON.stringify(r.rejected)}`);
  }

  // Append kiro and agents-md to profiles and workspaces.
  for (const p of PROFILES) {
    await edit(path.join(forge, "profiles", p, "profile.yaml"), addKiroAndAgentsMd);
    await edit(path.join(ws[p], "craftar.yaml"), addKiroAndAgentsMd);
  }

  execFileSync("git", ["init", "-q", forge]);
  gitCommitAll(forge, "import acme, globex and initech");

  // Sync workspaces.
  for (const p of PROFILES) {
    const r = runCli(["sync", "--workspace", ws[p]]);
    if (r.code !== 0) throw new Error(`sync ${p} failed: ${r.stderr}`);
  }

  // Step 2–3: Save plan for globex, edit it to take: section with lines, apply.
  const planGlobex = path.join(tmp, "globex.yaml");
  const savePlan = runCli(["forge", "unify", "rule/review-posture", "--profile", "globex", "--save-plan", planGlobex, "--forge", forge]);
  if (savePlan.code !== 0) throw new Error(`--save-plan globex failed: ${savePlan.stderr}`);

  const plan = YAML.parse(await fs.readFile(planGlobex, "utf8"));
  const ruleFile = plan.files.find((f: { file: string }) => f.file === "rule.md");
  if (!ruleFile) throw new Error("expected rule.md in plan");
  for (const h of ruleFile.hunks) {
    h.take = "section";
    h.section = { name: "reviewer-flavors", lines: "7-10" };
  }
  await fs.writeFile(planGlobex, YAML.stringify(plan));

  const applyPlan = runCli(["forge", "unify", "rule/review-posture", "--profile", "globex", "--plan", planGlobex, "--forge", forge]);
  if (applyPlan.code !== 0) throw new Error(`--plan globex failed: ${applyPlan.stderr}`);

  // The expected Forge is the state after step 3 (globex unify), NOT after initech.
  await fs.rm(EXPECTED, { recursive: true, force: true });
  await copyTree(forge, EXPECTED);

  console.log(`regenerated test/golden/forge-take-section-expected (${(await forgeFiles(EXPECTED)).length} files)`);
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
