import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { runCli } from "./helpers/cli.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { profile, recipe, scenario, writeFiles, type ForgeSpec, type IngredientSpec, type Scenario } from "./helpers/forge.js";
import { atLeastWin32 } from "./helpers/timeouts.js";
import { withoutSlice3Delta } from "./helpers/slice3-delta.js";
import { withoutValidatedDelta } from "./helpers/validated-targets-delta.js";
import { acmeSections } from "./helpers/target-sections.js";
import { acmeIndex } from "./helpers/rules-index.js";
import { skipResidue, withoutCoveredSkip } from "./helpers/covered-skip-delta.js";

/**
 * Spec 61 slice 2 (§7, plan R0): pin what a workspace naming slice-1 targets but neither `antigravity` nor `codex` sees
 * BEFORE any slice-2 source change, so a later change can prove it moves nothing for it. Written on 4b85c05 (1.1.0).
 * The slice-1 pin (`native-targets-off.json`) still covers workspaces naming only `claude-code`, `kiro`, `agents-md`.
 */

const PIN_FILE = path.resolve(__dirname, "pins/native-targets-2-off.json");
const SLICE_1_TARGETS = ["claude-code", "kiro", "agents-md", "cursor", "copilot", "agent-skills"];

// No test here runs Docker: doctor's child gets a PATH that holds only an empty temp dir, so `docker` is never found.
let EMPTY_DIR: string;
let NO_DOCKER: { PATH: string; Path: string };
beforeAll(() => {
  EMPTY_DIR = mkdtempSync(path.join(os.tmpdir(), "craftar-test-no-docker-"));
  NO_DOCKER = { PATH: EMPTY_DIR, Path: EMPTY_DIR };
});
afterAll(() => {
  if (EMPTY_DIR) rmSync(EMPTY_DIR, { recursive: true, force: true });
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

/**
 * Recursively normalize a value, replacing any occurrence of the scenario's temp root
 * (both raw path and realpath, with `/` and `\` separators) with `<root>`, and
 * normalizing time-dependent lock messages.
 */
function normalize(value: unknown, roots: string[]): unknown {
  if (typeof value === "string") {
    let s = value;
    for (const r of roots) {
      s = s.split(r).join("<root>");
      s = s.split(r.replace(/\\/g, "/")).join("<root>");
      s = s.split(r.replace(/\//g, "\\")).join("<root>");
    }
    // Normalize lock check message
    s = s.replace(/^(schema \d+, generated )\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/, "$1<timestamp>");
    // Normalize generatedAt in lock text
    s = s.replace(/"generatedAt":\s*"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/g, '"generatedAt": "<timestamp>"');
    return s;
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalize(v, roots));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalize(v, roots);
    }
    return out;
  }
  return value;
}

interface PlannedEntry {
  path: string;
  target: string;
  ingredient: string;
  sha256: string;
  text: string;
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface DoctorCheck {
  id: string;
  level: string;
  message: string;
  fix: string | null;
}

interface ScenarioRecord {
  plan: {
    files: PlannedEntry[];
    warnings: string[];
  };
  sync: CliResult;
  lock: string;
  syncCheck: CliResult;
  status: CliResult;
  diff: CliResult;
  targets: CliResult;
  doctorWorkspace: DoctorCheck[];
  doctorExit: number | null;
  explain: CliResult;
  explainPrimary?: CliResult;
  explainCarried: Record<string, CliResult>;
}

/**
 * Builds an "all-three" Forge scenario with targets `[claude-code, kiro, agents-md]`, schema 5,
 * with at least one ingredient of each type: rule (always-on, fileMatch scoped, manual), agent,
 * command, skill (directory and file layout), mcp (with env), script, steering, hook (with registration).
 * A rule body cites `.claude/rules/<other>.md`.
 */
async function allThreeScenario(params: Record<string, unknown> | undefined, targets: string[], schema: number): Promise<Scenario> {
  const ingredients: IngredientSpec[] = [
    // rule/style — always on (default inclusion)
    {
      meta: { type: "rule", name: "style", description: "Code style for every file" },
      files: { "rule.md": "# Style\nUse consistent formatting.\nSee .claude/rules/api.md for API rules.\n" },
    },
    // rule/api — fileMatch scoped
    {
      meta: { type: "rule", name: "api", inclusion: "fileMatch", fileMatchPattern: "src/api/**", description: "API conventions" },
      files: { "rule.md": "# API\nEvery endpoint is RESTful.\n" },
    },
    // rule/release — manual
    {
      meta: { type: "rule", name: "release", inclusion: "manual", description: "Release process" },
      files: { "rule.md": "# Release\nTag after review.\n" },
    },
    // agent/helper
    {
      meta: { type: "agent", name: "helper", description: "Helps with tasks" },
      files: { "agent.md": "Help the user with their tasks.\n" },
    },
    // command/review
    {
      meta: { type: "command", name: "review", description: "Run a code review" },
      files: { "command.md": "Run a code review on the current changes.\n" },
    },
    // skill/deploy — directory layout
    {
      meta: { type: "skill", name: "deploy", layout: "dir" },
      files: {
        "SKILL.md": "---\nname: deploy\ndescription: Deploy the app\n---\nRun the deployment.\n",
        "run.sh": "#!/bin/sh\necho deploying\n",
      },
    },
    // skill/docs — file layout
    {
      meta: { type: "skill", name: "docs", layout: "file" },
      files: { "SKILL.md": "---\nname: docs\ndescription: Generate documentation\n---\nGenerate docs.\n" },
    },
    // mcp/tracker — with env
    {
      meta: {
        type: "mcp",
        name: "tracker",
        authEnv: ["ACME_TOKEN"],
        server: { command: "npx", args: ["acme-tracker"], env: { ACME_ORG: "acme" } },
      },
    },
    // script/lint — claude-code only
    {
      meta: { type: "script", name: "lint", targets: ["claude-code"], files: ["lint.sh"] },
      files: { "lint.sh": "#!/bin/sh\necho linting\nexit 0\n" },
    },
    // steering/tone — kiro-only by default
    {
      meta: { type: "steering", name: "tone", file: "steering.md" },
      files: { "steering.md": "# Tone\nBe friendly and clear.\n" },
    },
    // hook/guard-path — with registration
    {
      meta: {
        type: "hook",
        name: "guard-path",
        files: ["guard-path.py"],
        params: { "hooks.python": { default: "python3" } },
        registration: [
          {
            event: "PreToolUse",
            matcher: "Bash|PowerShell",
            command: "{{hooks.python}}",
            args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-path.py"],
            timeout: 10,
          },
        ],
      },
      files: { "guard-path.py": 'print("ok")\n' },
    },
  ];

  const baseIngredients = [
    "rule/style",
    "rule/api",
    "rule/release",
    "agent/helper",
    "command/review",
    "skill/deploy",
    "skill/docs",
    "mcp/tracker",
    "script/lint",
    "steering/tone",
    "hook/guard-path",
  ];

  const recipes = [recipe("base", baseIngredients)];
  const profiles = [profile("acme", ["base"], targets, params ?? {})];

  const s = await scenario({ ingredients, recipes, profiles }, { config: { profile: "acme" } });

  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));

  return s;
}

async function buildScenarioRecord(s: Scenario, includeExplainPrimary = false, carried: string[] = []): Promise<ScenarioRecord> {
  const wsRoot = s.wsRoot;
  const W = ["--workspace", wsRoot];

  // Get both raw and realpath versions of the root for normalization
  const realRoot = await fs.realpath(s.root);
  const roots = [s.root, realRoot];

  // Compute plan
  const ws = await loadWorkspace(wsRoot, { home: process.env.CRAFTAR_HOME });
  const p = await plan(ws);

  // Build planned files array with sha256 hashes
  const plannedFiles: PlannedEntry[] = [];
  const sortedPaths = [...p.files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sortedPaths) {
    const textContent = f.content.toString("utf8");
    const sha256 = createHash("sha256").update(f.content).digest("hex");
    plannedFiles.push({
      path: f.path,
      target: f.target,
      ingredient: f.ingredient,
      sha256: `sha256:${sha256}`,
      text: textContent,
    });
  }

  // Run sync
  const syncResult = runCli(["sync", ...W]);

  // Read lock file
  let lockText = "";
  try {
    lockText = await fs.readFile(path.join(wsRoot, "craftar.lock"), "utf8");
    // Replace generatedAt with timestamp placeholder
    lockText = lockText.replace(/"generatedAt":\s*"[^"]+"/g, '"generatedAt": "<timestamp>"');
  } catch {
    // Lock file may not exist if sync failed
  }

  // Run other commands
  const syncCheckResult = runCli(["sync", "--check", ...W]);
  const statusResult = runCli(["status", "--json", ...W]);
  const diffResult = runCli(["diff", "--exit-code", ...W]);
  const targetsResult = runCli(["targets", "--json", ...W]);
  const doctorResult = runCli(["doctor", "--json", ...W], { env: NO_DOCKER });

  // Parse doctor output and filter to workspace scope only
  let doctorWorkspace: DoctorCheck[] = [];
  try {
    const doctorJson = JSON.parse(doctorResult.stdout);
    if (doctorJson.checks && Array.isArray(doctorJson.checks)) {
      doctorWorkspace = (doctorJson.checks as Array<{ id: string; scope: string; level: string; message: string; fix: string | null }>)
        .filter((c) => c.scope === "workspace")
        .map((c) => ({ id: c.id, level: c.level, message: c.message, fix: c.fix }));
    }
  } catch {
    // Keep empty array if parsing fails
  }

  // Find a rule file to explain
  const ruleFile = plannedFiles.find((f) => f.path.startsWith(".claude/rules/"))?.path ?? ".claude/rules/style.md";
  const explainResult = runCli(["explain", ruleFile, ...W]);

  // Build the record
  const record: ScenarioRecord = {
    plan: {
      files: plannedFiles,
      warnings: p.warnings,
    },
    sync: { code: syncResult.code, stdout: syncResult.stdout, stderr: syncResult.stderr },
    lock: lockText,
    syncCheck: { code: syncCheckResult.code, stdout: syncCheckResult.stdout, stderr: syncCheckResult.stderr },
    status: { code: statusResult.code, stdout: statusResult.stdout, stderr: statusResult.stderr },
    diff: { code: diffResult.code, stdout: diffResult.stdout, stderr: diffResult.stderr },
    targets: { code: targetsResult.code, stdout: filterTargetsOutput(targetsResult.stdout), stderr: targetsResult.stderr },
    doctorWorkspace,
    doctorExit: doctorResult.code,
    explain: { code: explainResult.code, stdout: explainResult.stdout, stderr: explainResult.stderr },
    explainCarried: {},
  };
  // Files a carried skip leaves out (spec 61 §6.1, §9): explain answers with the carrier.
  for (const f of carried) {
    const r = runCli(["explain", f, ...W]);
    record.explainCarried[f] = { code: r.code, stdout: r.stdout, stderr: r.stderr };
  }

  // For primary scenario, also explain the always-on rule in .claude/rules/
  if (includeExplainPrimary) {
    const explainPrimaryResult = runCli(["explain", ".claude/rules/style.md", ...W]);
    record.explainPrimary = { code: explainPrimaryResult.code, stdout: explainPrimaryResult.stdout, stderr: explainPrimaryResult.stderr };
  }

  return normalize(record, roots) as ScenarioRecord;
}

/** Filter out the lock timestamp from doctor workspace checks, as it changes each run. */
function withoutTimestamps(record: ScenarioRecord): ScenarioRecord {
  const doctorWorkspace = record.doctorWorkspace.map((c) => ({
    ...c,
    message: c.message.replace(/schema \d+, generated \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/, "schema N, generated <timestamp>"),
  }));
  return { ...record, doctorWorkspace };
}

/** Keep only the slice-1 target rows of `targets --json`: the slice-2 rows are the one deliberate delta. */
function filterTargetsOutput(output: string): string {
  try {
    const parsed = JSON.parse(output);
    if (parsed.targets && Array.isArray(parsed.targets)) {
      parsed.targets = parsed.targets.filter((t: { name: string }) => SLICE_1_TARGETS.includes(t.name));
    }
    return JSON.stringify(parsed, null, 2) + "\n";
  } catch {
    return output;
  }
}

interface OrphanRecord {
  sync: CliResult;
  diff: CliResult;
}

interface PinFile {
  "slice1-full": ScenarioRecord;
  "slice1-no-agents-md": ScenarioRecord;
  "slice1-kiro-primary": ScenarioRecord;
  "slice1-rules-index": ScenarioRecord;
  "slice1-orphan": OrphanRecord;
}

/** A `[cursor]` workspace synced, then given `agents-md`: the always-on rule's `.mdc` becomes an orphan named for its carrier. */
async function orphanRecord(): Promise<OrphanRecord> {
  const s = kept(await allThreeScenario(undefined, ["cursor"], 15));
  const W = ["--workspace", s.wsRoot];
  runCli(["sync", ...W]);
  const cfgPath = path.join(s.forgeRoot, "profiles", "acme", "profile.yaml");
  const prof = YAML.parse(await fs.readFile(cfgPath, "utf8"));
  prof.targets = ["cursor", "agents-md"];
  await fs.writeFile(cfgPath, YAML.stringify(prof));
  const diff = runCli(["diff", ...W]);
  const sync = runCli(["sync", ...W]);
  const realRoot = await fs.realpath(s.root);
  return normalize({ sync: { code: sync.code, stdout: sync.stdout, stderr: sync.stderr }, diff: { code: diff.code, stdout: diff.stdout, stderr: diff.stderr } }, [s.root, realRoot]) as OrphanRecord;
}

async function buildAllScenarios(): Promise<PinFile> {
  // 1. slice1-full — schema 15, claude-code + agents-md + the three slice-1 targets, full ingredient set
  const full = kept(await allThreeScenario(undefined, ["claude-code", "agents-md", "cursor", "copilot", "agent-skills"], 15));
  const fullRecord = await buildScenarioRecord(full, false, [".cursor/rules/style.mdc", ".github/copilot-instructions.md", ".github/prompts/review.prompt.md"]);

  // 2. slice1-no-agents-md — always-on rules written by cursor and copilot themselves
  const noAgents = kept(await allThreeScenario(undefined, ["cursor", "copilot", "agent-skills"], 15));
  const noAgentsRecord = await buildScenarioRecord(noAgents);

  // 3. slice1-kiro-primary — kiro beside cursor, agents-md.primary on
  const kiro = kept(await allThreeScenario({ params: { "agents-md.primary": true } }, ["claude-code", "kiro", "agents-md", "cursor"], 15));
  const kiroRecord = await buildScenarioRecord(kiro, true, [".cursor/rules/style.mdc"]);

  // 4. slice1-rules-index — the rules index expanded in cursor and copilot bodies
  const idx = kept(await acmeIndex({ schema: 15, literal: true }));
  const idxProfile = path.join(idx.forgeRoot, "profiles", "acme", "profile.yaml");
  const p = YAML.parse(await fs.readFile(idxProfile, "utf8"));
  p.targets = ["claude-code", "agents-md", "cursor", "copilot"];
  await fs.writeFile(idxProfile, YAML.stringify(p));
  const idxRecord = await buildScenarioRecord(idx);

  // 5. slice1-orphan — the carrier's orphan reason
  const orphan = await orphanRecord();

  return {
    "slice1-full": fullRecord,
    "slice1-no-agents-md": noAgentsRecord,
    "slice1-kiro-primary": kiroRecord,
    "slice1-rules-index": idxRecord,
    "slice1-orphan": orphan,
  };
}

describe("native-targets-2-off baseline pin (spec 61 slice 2, R0)", () => {
  it("matches the pinned snapshot", { timeout: atLeastWin32(180_000) }, async () => {
    const observed = await buildAllScenarios();

    if (process.env.CRAFTAR_REGEN_NATIVE2_PIN === "1") {
      // Write mode: generate the pin file
      await fs.mkdir(path.dirname(PIN_FILE), { recursive: true });
      await fs.writeFile(PIN_FILE, JSON.stringify(observed, null, 2) + "\n");
      console.log(`Pin written to ${PIN_FILE}`);
      return;
    }

    // Compare mode: load the pin and compare
    const expected = JSON.parse(await fs.readFile(PIN_FILE, "utf8")) as PinFile;

    // Apply withoutTimestamps filter to both for comparison
    for (const key of Object.keys(observed) as Array<keyof PinFile>) {
      // Spec 61 slice 3's deliberate delta is filtered by name out of both sides (test/helpers/slice3-delta.ts).
      expect(skipResidue(observed[key], expected[key])).toEqual([]);
      if (key === "slice1-orphan") expect(withoutCoveredSkip(withoutValidatedDelta(withoutSlice3Delta(observed[key])))).toEqual(withoutCoveredSkip(withoutValidatedDelta(withoutSlice3Delta(expected[key]))));
      else expect(withoutCoveredSkip(withoutValidatedDelta(withoutSlice3Delta(withoutTimestamps(observed[key] as ScenarioRecord))))).toEqual(withoutCoveredSkip(withoutValidatedDelta(withoutSlice3Delta(withoutTimestamps(expected[key] as ScenarioRecord)))));
    }
  });

  it("the pin is not vacuous", { timeout: atLeastWin32(180_000) }, async () => {
    const pin = JSON.parse(await fs.readFile(PIN_FILE, "utf8")) as PinFile;
    const full = pin["slice1-full"].plan.files.map((f) => f.path);
    expect(full).toContain("AGENTS.md");
    expect(full.some((f) => f.startsWith(".cursor/rules/") && f.endsWith(".mdc"))).toBe(true);
    expect(full.some((f) => f.startsWith(".github/agents/"))).toBe(true);
    expect(full.some((f) => f.startsWith(".agents/skills/"))).toBe(true);
    expect(full).toContain(".cursor/mcp.json");
    expect(full).toContain(".vscode/mcp.json");
    // carried skip: the always-on rule is not written to .cursor/rules/, explain names AGENTS.md and exits 0
    expect(full).not.toContain(".cursor/rules/style.mdc");
    expect(pin["slice1-full"].explainCarried[".cursor/rules/style.mdc"].code).toBe(0);
    expect(pin["slice1-full"].explainCarried[".cursor/rules/style.mdc"].stdout).toContain("AGENTS.md");
    // without agents-md, cursor writes the always-on rule itself
    expect(pin["slice1-no-agents-md"].plan.files.map((f) => f.path)).toContain(".cursor/rules/style.mdc");
    // lock schema 4 when a slice-1 target is named
    expect(JSON.parse(pin["slice1-full"].lock).schema).toBe(4);
    // the orphan reason names its carrier
    expect(pin["slice1-orphan"].sync.stdout).toContain("written to AGENTS.md only");
    // targets --json kept the six slice-1 rows
    expect(JSON.parse(pin["slice1-full"].targets.stdout).targets.length).toBe(6);
  });
});
