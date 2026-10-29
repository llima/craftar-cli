import { Command } from "commander";
import pc from "picocolors";
import path from "node:path";
import { promises as fs, statSync } from "node:fs";
import YAML from "yaml";
import { importClaudeCode } from "./importers/claude-code.js";
import { parsePreferKiro } from "./importers/prefer-kiro.js";
import { planPromote, applyPromote, UnheldError } from "./importers/drift-promote.js";
import { providedRefs } from "./importers/provided.js";
import { holdsBaseCitations, rendersServers } from "./core/mcp-server.js";
import { assertNotCacheTree, classifyForge, CREDENTIAL_HIDDEN, refHoldsCredentials, shownRef } from "./core/remote.js";
import { allowWrites, forget, listWorkspaces, prune, readRegistry, revokeWrites, type WorkspaceRow } from "./core/registry.js";
import { forgeWorkspaces, planAll, nextSync, impactOf, concerned, refineRegistryState, countStatesObject, NEXT_SYNC_STATES, type ForgeWorkspace, type RegistryState, type Planned, type ImpactResult } from "./core/impact.js";
import { runDoctor, type DoctorReport } from "./core/doctor.js";
import { launchRefusal, pinOf } from "./core/mcp-protocol.js";
import { serve } from "./mcp.js";
import { mcpWriters } from "./core/write-actions.js";
import { pruneCache, type PruneResult as CachePruneResult } from "./core/cache.js";
import { resolveHome } from "./core/home-lock.js";
import { loadWorkspace, loadForgeSource, readWorkspaceConfig, plan, readLock, status, unsetDeclared, unsetRefusal, agentsMdOverBudget, agentsMdRefusal, kiroResourcesUnplanned, kiroResourcesRefusal, orphanReason, primaryOrphan, resolveForge, resolveForgeSource, WORKSPACE_FILE, LOCAL_FILE, type ApplyResult, type FetchMode, type FileState, type FileStatus, type LoadOptions, type MergedConfig, type Plan, type SectionLayer, type UnsetParam, type Workspace } from "./core/sync.js";
import type { Lock, Registry } from "./schema/index.js";
import { sectionKey, type ParamLayer } from "./core/resolve.js";
import { catalogueContext, listRecipes, listIngredients, checkType, withLoadWarnings, type CatalogueContext, type ContextSource } from "./core/catalogue.js";
import { canonicalValue } from "./core/sections.js";
import { renderDiff, NO_EOF_NEWLINE_MARKER } from "./core/diff.js";
import { preferredLine, renderImportReport } from "./core/import-report.js";
import { driftList, unmanaged, type DriftRow } from "./core/drift.js";
import { EXAMPLE_CONTENT_HIDDEN, diffReport, explainFile, explainSkip, forgeLine, nextSyncLine, notProduced, orphanDriftBody, statusPath, statusReport, targetsReport } from "./core/report.js";
import { diffIngredients, listVariants, profileOf, type Distance, type IngredientDiff } from "./core/variants.js";
import { exists, gitDirty, gitIgnored, gitIsRepo, gitUnheld, loadForge, realpathOfNearest, cannotResolve, type UnheldPath } from "./core/forge.js";
import { applyBasePromotion, planBasePromotion, proveBasePromotion } from "./core/promote.js";
import { fingerprintDir } from "./core/fingerprint.js";
import {
  hunkAt,
  planFrom,
  applyPlan,
  writeUnified,
  checkRecipeCascade,
  rewriteRecipes,
  pruneCandidates,
  pruneRecipes,
  note,
  type RecipeCascadeResult,
  type WriteJournal,
  type PruneCandidate,
  type PruneResult,
} from "./core/unify.js";
import { checkParamWrites, writeParamFile } from "./core/param-writes.js";
import { checkInitFlags, checkLocalKeys, initLine, planInit, forgeSource, type InitInput } from "./core/init.js";
import { profileName } from "./core/new-profile.js";
import { newProfileGate } from "./core/new-profile-gate.js";
import { writeNewProfile, reproveFromDisk, NewProfileRaceLost, NewProfileLateFailure } from "./core/new-profile-write.js";
import { askInit, askClone, confirmInit, againLine, NOT_CLONED_REFUSED, type InitAnswers } from "./core/init-flow.js";
import { findGit, cloneRepos, listRepos, planClone, type CloneResult, type DestinationContext, type RepoState } from "./core/clone.js";
import { byHand, profileRepos, type RepoEntry } from "./core/repos.js";
import { readlineIo } from "./prompt.js";
import { recipeDiffLine, type RecipeOp } from "./core/recipe-edit.js";
import { syncWorkspace, editRecipes, confirmWrites, DISCARDED_ORPHAN } from "./core/write-actions.js";
import { localKeys, readLocalFile } from "./core/workspace-yaml.js";
import { HUNK_CLASSES, INGREDIENT_TYPES, UnifyPlanSchema, type HunkClass, type HunkSuggestion, type IngredientRef, type IngredientType, type Take, type UnifyPlan } from "./schema/index.js";
import { YamlSyntaxError, parseYamlText } from "./core/yaml-read.js";
import { recordedServices, pendingLine, upRefusal, composeArgv, downArgv, readPs, dockerVersion, dockerFault, dockerRunner, projectName, statusReport as servicesStatusReport, type Recorded } from "./core/services.js";
import { errorText } from "./core/schema-fault.js";
import { declaredTemplates, DOTNET_MISSING, DOTNET_MISSING_FIX, dotnetVersion, feedMessage, installReport, installTemplates, profileLabel, templateRows, unpinnedSources, type Declared, type InstallResult } from "./core/templates.js";
import { capture, spawnInherited } from "./core/proc.js";
import { startUi, type UiServer } from "./ui/server.js";

process.stdout.on("error", (e: NodeJS.ErrnoException) => { if (e.code === "EPIPE") process.exit(0); });

/**
 * Q13-1, answered by the user (2026-10-07): with a remote Forge whose fetch fails, `diff --exit-code`
 * fails like `sync --check` — a CI gate does not pass against a stale cached copy. Plain `diff` still
 * reads the cached copy with a warning (spec 13 §4.1).
 */
const DIFF_EXIT_CODE_FETCH_MODE: FetchMode = "sync";

const program = new Command();
program.name("craftar").description("Craft, sync and convert AI-coding workspace harnesses.").version("0.38.0");

/* ---------------------------------------------------------------- import */
/** The words of one output-path gate (`gateOutsideForge`), declared before the commands that run at load: what is written, by which command, and its two refusals' endings. */
interface OutputGate {
  what: "plan" | "report";
  who: "unify" | "import";
  outside: string;
  never: string;
}
const SAVE_PLAN_GATE: OutputGate = { what: "plan", who: "unify", outside: "save plans outside the Forge", never: "unify never overwrites" };
const REPORT_GATE: OutputGate = { what: "report", who: "import", outside: "write the report outside the Forge", never: "import never overwrites" };

program
  .command("import")
  .description("Import an existing workspace harness into a Forge: creates or updates ingredients, recipes and a profile, reusing a templated base when it renders the workspace text or infers it into params or sections; in a Forge at schema 3 or above, what the profile's integrations block provides is left to its recipe and reported")
  .requiredOption("--from <tool>", "source tool: claude-code")
  .requiredOption("--forge <dir>", "Forge directory (created if missing)")
  .requiredOption("--profile <name>", "client profile to create or update")
  .option("--workspace <dir>", "workspace to import", ".")
  .option("--write-config", "write craftar.yaml into the workspace, merging an existing one (forge, profile, targets)", false)
  .option(
    "--report <file.md>",
    "also write a Markdown report of the import — what was created, reused, made a variant or rejected, and the .kiro/ files that differ from what Craftar would generate (paths and line counts, never content); refused when the path is inside the Forge or already exists",
  )
  .option(
    "--prefer-kiro <rule,…>",
    "take the named rules from .kiro/steering/<name>.md instead of .claude/rules/<name>.md — each proved to render back to that steering file's body; refused for a name that is not a rule, has no steering file, or whose steering does not render back",
  )
  .action(async (o) => {
    if (o.from !== "claude-code") fail(`unsupported source "${o.from}" (only claude-code for now)`);
    // import writes a local Forge; a URL would become a directory named after it (spec 13 §4.4).
    if (classifyForge(o.forge) === "url") fail("--forge takes a directory; to read a remote Forge, run inside a workspace that names it");
    // A cache tree is refused first: it reads only the real paths of --forge and of the cache, nothing of the workspace.
    await assertNotCacheTree(path.resolve(o.forge), craftarHome()).catch((e) => fail(e instanceof Error ? e.message : String(e)));
    // Spec 29 §4.2: the report's path is refused before the import reads anything, so a refusal leaves the Forge untouched.
    // Spec 29 §4.3: PK5, before the workspace is read.
    const preferKiro = o.preferKiro === undefined ? undefined : parsePreferKiro(o.preferKiro);
    const reportAbs = o.report === undefined ? null : await gateOutsideForge(o.report, o.forge, REPORT_GATE);
    const r = await importClaudeCode({ workspaceRoot: o.workspace, forgeRoot: o.forge, profileName: o.profile, writeWorkspaceConfig: o.writeConfig, report: reportAbs !== null, preferKiro });
    console.log(pc.bold(`Imported ${path.resolve(o.workspace)} → ${path.resolve(o.forge)} as profile "${r.profile}"`));
    console.log(
      `  ${pc.green(String(r.created.length))} created, ${pc.cyan(String(r.reused.length))} reused, ${pc.yellow(String(r.variants.length))} variants, ${pc.red(String(r.rejected.length))} rejected`,
    );
    for (const v of r.variants) console.log(`  ${pc.yellow("variant")} ${v.name} — ${v.reason}`);
    for (const x of r.rejected) console.log(`  ${pc.red("rejected")} ${x.name} — ${x.reason}`);
    for (const x of r.preferKiro ?? []) console.log(`  ${pc.cyan("prefer-kiro")} ${preferredLine(x)}`);
    // Spec 33 §5.3: what the block provides is left to its recipe.
    for (const x of r.leftToRecipes) console.log(`  left to recipe ${x.recipe} (integrations.${x.slot}): ${x.refs.join(", ")} — not compared; when this workspace resolves that recipe, craftar status shows whether its copies differ`);
    // Spec 10 §4.2: how a templated base was reused, and what the profile gained.
    // Spec 11 §4.3: `; sections …` when a section value filled the render.
    for (const x of r.rendered) {
      const keys = x.keys.length ? x.keys.join(", ") : "";
      const secs = x.sections?.length ? `${keys ? "; " : ""}sections ${x.sections.join(", ")}` : "";
      console.log(`  ${pc.cyan("rendered")} ${x.name} — ${keys}${secs}`);
    }
    for (const x of r.inferred) {
      console.log(`  ${pc.cyan("inferred")} ${x.name} — ${Object.entries(x.values).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ")}`);
    }
    for (const x of r.sectioned) console.log(`  ${pc.cyan("sectioned")} ${x.name} — ${x.sections.join(", ")}`);
    for (const x of r.params) console.log(`  param ${x.key}: ${x.old === null ? "(unset)" : JSON.stringify(x.old)} → ${JSON.stringify(x.value)}`);
    // Line counts, never the content: it is several lines, and it is in profile.yaml (Ruling 18).
    for (const x of r.sections) console.log(`  section ${x.key} ${x.name}: ${x.old === null ? "(default)" : lineCount(x.old)} → ${lineCount(x.value)}`);
    if (r.manifestWrite === "edited") console.log(`  forge craftar.forge.yaml edited (schema: 2)`);
    const w = r.profileWrite;
    console.log(`  profile ${w.path} ${w.action}${w.fields.length ? ` (${w.fields.join(", ")})` : ""}`);
    const split = new Map(r.recipeSplits.map((x) => [x.owned, x.reason]));
    console.log(`  recipes: ${r.recipes.map((n) => (split.has(n) ? `${n} (${split.get(n)})` : n)).join(", ")}`);
    if (r.configWrite === "edited")
      console.log(
        r.configForgeKept
          ? `  workspace craftar.yaml edited (profile, targets) — forge kept (remote ${r.configForgeKept}); push the Forge for sync to see this import`
          : `  workspace craftar.yaml edited (forge, profile, targets)`,
      );
    for (const w of r.warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
    // Spec 29 §4.3: what the workspace sees next for a rule whose text now differs from its .claude file, and how to converge.
    for (const x of r.preferKiro ?? []) {
      if (!x.differs) continue;
      console.log(`  ${pc.yellow("note")} ${x.ref} now comes from Kiro: ${x.rule} differs from it. With no lock entry it will read`);
      console.log(`       "collision" at the next sync — delete it (and ${x.source} if it also collides) and run`);
      console.log(`       craftar sync to regenerate both. Where craftar.lock already records it unedited, sync updates it.`);
    }
    if (reportAbs !== null) {
      const text = renderImportReport({ workspace: path.resolve(o.workspace), forge: path.resolve(o.forge), report: r, now: new Date(), version: program.version()! });
      // After the summary, so a report that cannot be written never costs the summary of an import that succeeded.
      try {
        await fs.mkdir(path.dirname(reportAbs), { recursive: true });
        await fs.writeFile(reportAbs, text, { flag: "wx" });
      } catch (e) {
        fail(
          `The Forge was written in full and the import succeeded; writing the report failed (${e instanceof Error ? e.message : String(e)}) — ` +
            `the summary above stands; re-run with another --report path to get the file`,
        );
      }
      console.log(`  report ${o.report}`);
    }
  });

/* ---------------------------------------------------------------- status */
program
  .command("status")
  .description("Show what sync would do: new, update, drift, orphan, collision; exits 1 when a declared parameter a file cites has no value, or when AGENTS.md is over an explicit budget")
  .option("--workspace <dir>", "workspace root", ".")
  .option("--json", "machine-readable output", false)
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .action(async (o) => {
    const ws = await loadWorkspace(o.workspace, load(o, "read"));
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const st = await status(ws, p, lock);
    const report = statusReport(ws, p, lock, st);
    const unset = report.unsetParams;
    if (o.json) {
      console.log(JSON.stringify(report, null, 2));
      // exitCode, not process.exit: a piped object is not cut (spec 29 §4.1)
      // The object carries both reasons (unsetParams, the budget line in warnings): nothing on stderr
      if (unset.length || agentsMdOverBudget(p) || kiroResourcesUnplanned(p)?.length) process.exitCode = 1;
      return;
    }
    printStatus(st, p.warnings, ws.config.profile, p.resolution.recipes, false, forgeLine(ws, lock));
    if (refusalBlock(unset)) process.exitCode = 1;
    if (budgetRefusalBlock(p)) process.exitCode = 1;
  });

/**
 * The refusal of spec 29 §4.1 for a command that goes on to print or exit by itself: the block on stderr, as
 * `fail()` would print it, without exiting. Says whether there was one.
 */
function refusalBlock(unset: UnsetParam[], opts: { thenSync?: boolean } = {}): boolean {
  if (unset.length) errorLine(unsetRefusal(unset, opts));
  return unset.length > 0;
}

/**
 * The AGENTS.md budget refusal for a command that goes on to print or exit by itself: the block on stderr,
 * without exiting. Says whether there was one.
 */
function budgetRefusalBlock(p: Plan): boolean {
  const over = agentsMdOverBudget(p);
  if (over) errorLine(agentsMdRefusal(over));
  const kiroUnplanned = kiroResourcesUnplanned(p);
  if (kiroUnplanned) errorLine(kiroResourcesRefusal(kiroUnplanned));
  return over !== null || kiroUnplanned !== null;
}

/**
 * A writing sync on a planned workspace, then its report: `apply`, the registration of spec 21 (unless
 * `CRAFTAR_NO_REGISTRY`), and the lines `sync` prints. `sync` and `init` both call it (spec 23 §5.2).
 */
async function applyAndReport(ws: Workspace, p: Plan, st: FileStatus[], lock: Lock | null, opts: { dryRun?: boolean; overwriteDrift?: boolean; overwritePaths?: ReadonlySet<string> } = {}): Promise<ApplyResult> {
  const o = await syncWorkspace(ws, p, st, lock, { ...opts, home: craftarHome(), registryOff: registryOff() });
  const verb = opts.dryRun ? "would write" : "wrote";
  console.log(pc.bold(`craftar sync — profile ${ws.config.profile} · recipes ${p.resolution.recipes.join(" → ")} · targets ${p.resolution.targets.join(", ")}`));
  if (o.forgeLine) console.log(o.forgeLine);
  console.log(`  ${verb} ${pc.green(String(o.result.written.length))}, removed ${pc.magenta(String(o.result.removed.length))} orphan(s), skipped ${pc.yellow(String(o.result.skipped.length))}`);
  for (const f of o.result.written) console.log(`  ${pc.green("+")} ${f}`);
  for (const f of o.result.removed) console.log(`  ${pc.magenta("-")} ${f}  (${opts.overwritePaths?.has(f) ? DISCARDED_ORPHAN : orphanReason(p, st, f)})`);
  for (const s of o.result.skipped) console.log(`  ${pc.yellow("!")} ${s.path}  ${explainSkip(s)}`);
  for (const w of p.warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
  if (o.registry) console.log(`  ${pc.yellow("warn")} registry not updated (${o.registry.file}): ${o.registry.message}`);
  return o.result;
}

/**
 * Shared clone report for `craftar init --clone` and `craftar repos clone`.
 * Prints the header, the present rows first, then the clone rows (cloned/failed), each group
 * in the profile's order. Returns whether any clone failed.
 *
 * @param header The bold header line (without the leading text, which is added here)
 * @param results The clone results (cloned or failed)
 * @param skipped The entries that were skipped (present state)
 * @param root The workspace root, used for the by-hand message
 * @param opts.reposCloneLine Whether to print the "or, from the workspace: craftar repos clone ..." line
 */
function printCloneReport(
  header: string,
  results: CloneResult[],
  skipped: RepoEntry[],
  root: string,
  opts: { reposCloneLine: boolean },
): boolean {
  console.log(pc.bold(header));

  // Build rows: skipped first (as "present"), then results (as "cloned" or "failed")
  // All maintain profile order, which is the order of the input arrays
  type Row = { state: "present" | "cloned" | "failed"; name: string; path: string; reason?: string };
  const rows: Row[] = [];
  for (const e of skipped) {
    rows.push({ state: "present", name: e.name, path: e.path });
  }
  for (const r of results) {
    if (r.outcome === "cloned") {
      rows.push({ state: "cloned", name: r.entry.name, path: r.entry.path });
    } else {
      rows.push({ state: "failed", name: r.entry.name, path: r.entry.path, reason: r.reason });
    }
  }

  // Compute column widths: sw = longest state, nw = longest name
  const sw = Math.max(...rows.map((r) => r.state.length));
  const nw = Math.max(...rows.map((r) => r.name.length));

  // Print rows
  for (const r of rows) {
    let line = `  ${r.state.padEnd(sw)}  ${r.name.padEnd(nw)}  → ${r.path}`;
    if (r.state === "present") {
      line += "  (not cloned)";
    } else if (r.state === "failed" && r.reason) {
      line += `  (${r.reason})`;
    }
    console.log(line);
  }

  // Failure report
  const failed = results.filter((r): r is CloneResult & { outcome: "failed" } => r.outcome === "failed");
  if (failed.length > 0) {
    const ok = results.length - failed.length;
    const n = results.length;
    console.log(`  ${ok} of ${n} cloned — clone the rest by hand, in ${root}:`);
    for (const f of failed) {
      console.log(`    ${byHand(f.entry)}`);
    }
    if (opts.reposCloneLine) {
      const failedNames = failed.map((f) => f.entry.name);
      console.log(`  or, from the workspace: craftar repos clone ${failedNames.join(" ")}`);
    }
  }

  return failed.length > 0;
}

/**
 * The clone step for `craftar init --clone`: clones the entries, prints the report, sets exitCode on failures.
 * Calls `again()` at the end.
 */
async function runCloneStep(root: string, profile: string, entries: RepoEntry[], git: string, again: () => void): Promise<void> {
  const n = entries.length;
  const repoWord = n === 1 ? "repository" : "repositories";
  const results = await cloneRepos(root, entries, { git, env: process.env, stdinIsTty: process.stdin.isTTY === true });
  const header = `craftar init — cloning ${n} ${repoWord} of ${profile}`;
  const anyFailed = printCloneReport(header, results, [], root, { reposCloneLine: true });
  if (anyFailed) process.exitCode = 1;
  again();
}

/* ---------------------------------------------------------------- init */
program
  .command("init")
  .description(
    "Start a workspace from a Forge and a profile: write a craftar.yaml proved to resolve and plan, then run the first sync; with --new-profile, create the profile in the Forge directory first (recipes and targets from --like and the recipe/target flags), then start the workspace on it — nothing is committed; with --clone, clone the profile's repositories into the workspace (after the first sync, or with --no-sync after writing craftar.yaml); in a terminal, asks for the Forge and the profile not given as flags; refused when craftar.yaml already exists",
  )
  .option("--forge <dir|url>", "the Forge: a directory (written relative to the workspace) or a git URL; asked for in a terminal when omitted")
  .option("--profile <name>", "the client profile in the Forge; asked for in a terminal when omitted")
  .option("--new-profile <name>", "create this profile in the Forge directory (recipes and targets from --like and the recipe flags), then start the workspace on it; nothing is committed")
  .option("--like <profile>", "with --new-profile: start the new profile's recipes and targets from this profile's — nothing else of it is copied")
  .option("--ref <ref>", "branch, tag or full SHA of a remote Forge")
  .option("--targets <a,b>", "targets to write in craftar.yaml, or of the new profile with --new-profile (claude-code, kiro, agents-md); omitted, the workspace follows the profile's")
  .option("--add-recipe <name>", "add a recipe to the profile's, or to the new profile's with --new-profile (repeatable)", collect, [])
  .option("--remove-recipe <name>", "remove a recipe from the profile's, or from the new profile's with --new-profile (repeatable)", collect, [])
  .option("--replace", "let --add-recipe take a slot another recipe holds", false)
  .option("--no-sync", "write craftar.yaml only, and say what the first sync would do")
  .option("--clone", "after the first sync, clone the profile's repositories (its repos list) into the workspace")
  .option("--no-clone", "do not clone, and do not ask")
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .option("--workspace <dir>", "workspace root, created when missing", ".")
  .action(
    async (o: {
      forge?: string;
      profile?: string;
      newProfile?: string;
      like?: string;
      ref?: string;
      targets?: string;
      addRecipe: string[];
      removeRecipe: string[];
      replace: boolean;
      sync: boolean;
      clone?: boolean;
      offline: boolean;
      workspace: string;
    }, cmd) => {
      const root = path.resolve(o.workspace);
      // N1: craftar.yaml already exists
      const n1Text = `${WORKSPACE_FILE} already exists in ${root} — change recipes with craftar add recipe / remove recipe, or edit it`;
      const n1 = () => fail(n1Text);
      const file = path.join(root, WORKSPACE_FILE);
      if (await exists(file)) n1();
      // N9: --workspace is a file, or any ancestor up to an existing path is a file
      {
        let p = root;
        for (;;) {
          const st = await fs.stat(p).catch(() => null);
          if (st) {
            if (!st.isDirectory()) fail(`cannot use ${p} as a workspace: it is not a directory`);
            break; // found an existing directory
          }
          const parent = path.dirname(p);
          if (parent === p) break; // reached filesystem root
          p = parent;
        }
      }
      // Check the flags that were given (N3, N7, N11, N6)
      checkInitFlags({
        forge: o.forge,
        ref: o.ref,
        targets: o.targets === undefined ? undefined : o.targets.split(",").map((t) => t.trim()),
        addRecipes: o.addRecipe,
        removeRecipes: o.removeRecipe,
      });
      // C1: --clone and --no-clone cannot be given together
      if (process.argv.includes("--clone") && process.argv.includes("--no-clone")) {
        fail("pass --clone or --no-clone, not both");
      }
      // C2: --clone with --offline
      if (o.clone === true && o.offline) {
        fail("--clone needs the network — drop --offline, or clone later with git");
      }
      // C6: --clone with no git on PATH
      const git = await findGit(process.env);
      if (o.clone === true && git === null) {
        fail("cloning needs git — install it, or leave the clone out");
      }
      // P1–P4: --new-profile checks (before anything is read)
      if (o.newProfile !== undefined && o.profile !== undefined) {
        fail("pass --profile or --new-profile, not both");
      }
      if (o.like !== undefined && o.newProfile === undefined) {
        fail("--like goes with --new-profile");
      }
      if (o.newProfile !== undefined) {
        profileName(o.newProfile);
      }
      if (o.newProfile !== undefined && o.forge !== undefined && classifyForge(o.forge) === "url") {
        fail("a new profile is written into a Forge directory — clone the Forge, pass that directory as --forge, then commit and push the profile");
      }
      // Mode: flags when both given; else interactive when both streams are TTYs; else N2
      // --new-profile counts as --profile for bothGiven and N2
      const bothGiven = o.forge !== undefined && (o.profile !== undefined || o.newProfile !== undefined);
      const isTTY = process.stdin.isTTY && process.stdout.isTTY;
      if (!bothGiven && !isTTY) {
        // N2: refuse with our message
        if (o.forge === undefined && o.profile === undefined && o.newProfile === undefined) {
          fail("--forge and --profile are required when craftar init does not run in a terminal — pass them, or run craftar init in a terminal to be asked");
        } else if (o.profile === undefined && o.newProfile === undefined) {
          fail("--profile is required when craftar init does not run in a terminal — pass it, or run craftar init in a terminal to be asked");
        } else {
          fail("--forge is required when craftar init does not run in a terminal — pass it, or run craftar init in a terminal to be asked");
        }
      }
      // Read the local file once (after N1, N9 and flag checks, before any question or planInit)
      const local = await readLocalFile(root);
      let input: InitInput;
      let answers: InitAnswers | null = null;
      if (!bothGiven) {
        const io = readlineIo(process.stdin, process.stdout, { terminal: true });
        const result = await askInit(
          root,
          {
            forge: o.forge,
            profile: o.profile,
            newProfile: o.newProfile,
            like: o.like,
            ref: o.ref,
            targets: o.targets === undefined ? undefined : o.targets.split(",").map((t) => t.trim()),
            addRecipes: o.addRecipe,
            removeRecipes: o.removeRecipe,
            replace: o.replace,
            clone: o.clone,
          },
          local,
          io,
          { ...load(o, "sync"), registryOff: registryOff() },
        );
        if (result.kind === "cancelled") fail("init cancelled — nothing written");
        input = result.input;
        answers = result.answers;
      } else if (o.newProfile !== undefined) {
        // --forge and --new-profile given (flags mode with new profile)
        // N10 (spec 38 §4.2): the one check, before the load — --new-profile counts as --profile there
        checkLocalKeys(local.keys, {
          ref: o.ref !== undefined,
          recipes: o.addRecipe.length > 0 || o.removeRecipe.length > 0,
          targets: o.targets !== undefined,
        });
        // Load the Forge
        const loaded = await loadForgeSource(root, forgeSource(root, o.forge!), o.ref ?? null, { ...load(o, "sync") });
        // Gate: P5-P8
        await newProfileGate(loaded.forge, resolveHome(process.env.CRAFTAR_HOME || undefined), o.newProfile);
        // Build input
        input = {
          forge: o.forge!,
          profile: o.newProfile,
          newProfile: { name: o.newProfile, like: o.like },
          ref: o.ref,
          targets: o.targets === undefined ? undefined : o.targets.split(",").map((t) => t.trim()),
          addRecipes: o.addRecipe,
          removeRecipes: o.removeRecipe,
          replace: o.replace,
          clone: o.clone === true,
          loaded,
        };
      } else {
        input = {
          forge: o.forge!,
          profile: o.profile!,
          ref: o.ref,
          targets: o.targets === undefined ? undefined : o.targets.split(",").map((t) => t.trim()),
          addRecipes: o.addRecipe,
          removeRecipes: o.removeRecipe,
          replace: o.replace,
          clone: o.clone === true,
        };
      }
      let init = await planInit(root, input, { ...load(o, "sync"), local });
      // Interactive mode: when o.clone is undefined, ask about cloning between planInit and confirmInit
      // --clone typed: planInit has checked C3–C5 and returned the entries, in either mode
      let cloneEntries: RepoEntry[] = o.clone === true ? init.repos : [];
      let cloneRefused = false;
      if (answers !== null) {
        if (o.clone === undefined) {
          const io = readlineIo(process.stdin, process.stdout, { terminal: true });
          const cloneResult = await askClone(io, init, { root, offline: o.offline, git });
          if (cloneResult === "cancelled") fail("init cancelled — nothing written");
          cloneEntries = cloneResult.entries;
          cloneRefused = cloneResult.refused === true;
        }
        const io = readlineIo(process.stdin, process.stdout, { terminal: true });
        const confirm = await confirmInit(init, root, io, {
          sync: o.sync,
          clone: cloneEntries.length || undefined,
          cloneRefused: o.clone === true || cloneRefused,
        });
        if (confirm === "cancelled") fail("init cancelled — nothing written");
      }
      let { ws, plan: p } = init;
      const forgeRoot = ws.forge.root;
      const workspaceGiven = cmd.getOptionValueSource("workspace") === "cli";
      const again = () => {
        if (answers !== null) {
          console.log(againLine(answers, { workspace: workspaceGiven ? o.workspace : undefined, sync: o.sync, offline: o.offline, clone: cloneEntries.length > 0 }));
        }
      };
      // When init.newProfile: write the profile, then reprove from disk
      let journal: WriteJournal = [];
      // Step 1's notes are printed after the initLine line (spec 38), so keep them before reprove
      const step1Notes = init.notes;
      if (init.newProfile) {
        try {
          journal = await writeNewProfile(forgeRoot, init);
        } catch (e) {
          if (e instanceof NewProfileRaceLost) {
            // P7's first message, no recover lines
            fail(e.message);
          }
          if (e instanceof NewProfileLateFailure) {
            fail(lateFailure(e, forgeRoot, e.journal, "init"));
          }
          throw e;
        }
        // Reprove from disk (step 4)
        try {
          init = await reproveFromDisk(root, input.forge, init, { ...load(o, "sync") }, journal, input.ref);
        } catch (e) {
          if (e instanceof NewProfileLateFailure) {
            fail(lateFailure(e, forgeRoot, e.journal, "init"));
          }
          throw e;
        }
        // Update ws and p from the second init
        ws = init.ws;
        p = init.plan;
        // Print the profile creation lines
        console.log(pc.bold(`craftar init — created profile ${ws.config.profile} in ${forgeRoot}`));
        console.log(`  + profiles/${ws.config.profile}/profile.yaml   (not committed — commit it in the Forge, on a branch, before anyone else syncs)`);
      }
      // Every refusal is above: only now does the directory, and craftar.yaml, come to exist
      // When journal is not empty: mkdir inside the try, with late failure handling
      if (journal.length > 0) {
        try {
          await fs.mkdir(root, { recursive: true });
        } catch (e) {
          fail(lateFailure(e, forgeRoot, journal, "init"));
        }
        try {
          await fs.writeFile(file, init.text, { flag: "wx" });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST") {
            // N1's text, then lateFailure
            fail(`${n1Text}\n${lateFailure(e, forgeRoot, journal, "init")}`);
          }
          fail(lateFailure(e, forgeRoot, journal, "init"));
        }
      } else {
        // No journal: existing behaviour unchanged
        await fs.mkdir(root, { recursive: true });
        try {
          await fs.writeFile(file, init.text, { flag: "wx" });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST") n1();
          throw e;
        }
      }
      console.log(pc.bold(`craftar init — wrote ${WORKSPACE_FILE} in ${root}`));
      console.log(`  ${initLine(init)}`);
      for (const n of step1Notes) console.log(`  note ${n}`);
      const unset = unsetDeclared(p);
      const cloning = cloneEntries.length > 0;
      const refused = unset.length > 0;
      if (!o.sync) {
        console.log(nextSyncLine(init.statuses, unset));
        for (const w of p.warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
        if (cloning && refused && answers === null) {
          console.log(NOT_CLONED_REFUSED);
        } else if (cloning && !refused) {
          // Clone even without sync
          await runCloneStep(root, ws.config.profile, cloneEntries, git!, again);
          return;
        }
        again();
        return;
      }
      // Spec 29 §4.1, §6 case 11: craftar.yaml is written — the workspace layer is a place for the value — and the
      // first sync is not run. exitCode, not fail(): the `again` line still follows the block.
      if (unset.length) {
        for (const w of p.warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
        if (cloning && answers === null) {
          console.log(NOT_CLONED_REFUSED);
        }
        refusalBlock(unset, { thenSync: true });
        again();
        process.exitCode = 1;
        return;
      }
      const r = await applyAndReport(ws, p, init.statuses, init.lock);
      const collisions = r.skipped.filter((s) => s.state === "collision").length;
      if (collisions)
        console.log(
          `  ${pc.yellow("warn")} ${collisions} file(s) already in the workspace differ from the Forge and were left as they are — to bring them into the Forge, run craftar import`,
        );
      if (cloning) {
        await runCloneStep(root, ws.config.profile, cloneEntries, git!, again);
        return;
      }
      again();
    },
  );

/* ---------------------------------------------------------------- repos */
// `craftar repos` lists (the command's own action); `craftar repos clone` clones. No `repos list` (spec 37 §13.3 item 29).
const reposCmd = program
  .command("repos")
  .description("List the profile's repositories (its repos list) with their state in this workspace: present, missing or blocked; starts no program but the Forge load, writes nothing")
  .option("--workspace <dir>", "workspace root", ".")
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .option("--json", "machine-readable output", false)
  .action(async (o) => {
    const ws = await loadWorkspace(o.workspace, load(o, "read"));
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const profile = ws.forge.profiles.get(ws.config.profile)!;
    // C4: profileRepos throws for a block that does not read
    const entries = profileRepos(profile);
    // No entry → one line, exit 0
    if (entries.length === 0) {
      if (o.json) {
        const out = {
          workspace: await fs.realpath(ws.root),
          profile: ws.config.profile,
          repos: [],
          warnings: p.warnings,
        };
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(`profile ${ws.config.profile} lists no repositories`);
        for (const w of p.warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
      }
      return;
    }
    // Build the destination context: planned paths and lock paths
    const ctx: DestinationContext = {
      planned: p.files.map((f) => f.path),
      lockPaths: lock?.files.map((f) => f.path) ?? [],
      forgeDir: ws.forge.root,
    };
    const list = await listRepos(ws.root, entries, ctx);
    const missing = list.filter((e) => e.state === "missing").length;
    if (o.json) {
      const repos = list.map((e) => ({
        name: e.name,
        url: e.url,
        path: e.path,
        ref: e.ref,
        state: e.state,
        reason: e.reason,
      }));
      const out = {
        workspace: await fs.realpath(ws.root),
        profile: ws.config.profile,
        repos,
        warnings: p.warnings,
      };
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    // Text output
    console.log(`repositories of ${ws.config.profile} — ${list.length} in the profile, ${missing} missing`);
    const sw = 7; // "present" is longest, always
    const nw = Math.max(...list.map((e) => e.name.length));
    const pw = Math.max(...list.map((e) => e.path.length));
    for (const e of list) {
      let line = `  ${e.state.padEnd(sw)}  ${e.name.padEnd(nw)}  → ${e.path.padEnd(pw)}   ${e.url}`;
      if (e.ref) line += `  @ ${e.ref}`;
      if (e.reason) line += `  (${e.reason})`;
      console.log(line);
    }
    for (const w of p.warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
  });

reposCmd
  .command("clone")
  .description("Clone the profile's repositories that are missing in this workspace (all, or the names given); typing the command is the consent; needs a fresh copy of a remote Forge")
  .argument("[names...]", "repository names to clone (default: all missing)")
  // No default here: `repos` holds `--workspace` too, and commander gives the value to the parent when both declare it.
  .option("--workspace <dir>", 'workspace root (default: ".")')
  .action(async (names: string[], o) => {
    const workspace: string = o.workspace ?? reposCmd.opts().workspace ?? ".";
    // C6: git is needed before any load
    const git = await findGit(process.env);
    if (git === null) {
      fail("cloning needs git — install it, or leave the clone out");
    }
    // R4: fetchHint: "fresh-copy" — repos clone refuses a stale cached copy
    const ws = await loadWorkspace(workspace, { ...load({ offline: false }, "sync"), fetchHint: "fresh-copy" });
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const profile = ws.forge.profiles.get(ws.config.profile)!;
    // Build the destination context
    const ctx: DestinationContext = {
      planned: p.files.map((f) => f.path),
      lockPaths: lock?.files.map((f) => f.path) ?? [],
      forgeDir: ws.forge.root,
    };
    // planClone: C3, C4, C5, R1, R2, R3 come out of it
    const clonePlan = await planClone(ws.root, profile, ctx, {
      present: "skip",
      noEntries: "nothing to clone",
      names: names.length ? names : undefined,
    });
    // Nothing to clone and no names given: all are present
    if (clonePlan.entries.length === 0) {
      const all = profileRepos(profile);
      const n = all.length;
      const repoWord = n === 1 ? "repository" : "repositories";
      console.log(`all ${n} ${repoWord} of ${ws.config.profile} are present — nothing to clone`);
      return;
    }
    // Clone the entries
    const results = await cloneRepos(ws.root, clonePlan.entries, { git, env: process.env, stdinIsTty: process.stdin.isTTY === true });
    // Combine skipped and results in profile order for the report
    // skipped entries come from planClone, results are in the same order as entries
    // To merge them in profile order: iterate through all entries and match
    const allEntries = profileRepos(profile);
    const skippedNames = new Set(clonePlan.skipped.map((e) => e.name.toLowerCase()));
    const resultMap = new Map(results.map((r) => [r.entry.name.toLowerCase(), r]));
    const orderedSkipped: RepoEntry[] = [];
    const orderedResults: CloneResult[] = [];
    for (const e of allEntries) {
      const lower = e.name.toLowerCase();
      if (skippedNames.has(lower)) {
        orderedSkipped.push(clonePlan.skipped.find((s) => s.name.toLowerCase() === lower)!);
      } else if (resultMap.has(lower)) {
        orderedResults.push(resultMap.get(lower)!);
      }
    }
    // Report
    const n = clonePlan.entries.length;
    const repoWord = n === 1 ? "repository" : "repositories";
    const header = `craftar repos clone — cloning ${n} ${repoWord} of ${ws.config.profile}`;
    const anyFailed = printCloneReport(header, orderedResults, orderedSkipped, ws.root, { reposCloneLine: false });
    if (anyFailed) process.exitCode = 1;
  });

/* ---------------------------------------------------------------- sync */
program
  .command("sync")
  .description("Generate the harness for every target from the Forge and update craftar.lock; a writing sync also records the workspace in $CRAFTAR_HOME/registry.json (see craftar workspaces); refuses, writing nothing, when a declared parameter a file cites has no value; with --check, also exits 1 when AGENTS.md is over an explicit budget")
  .option("--workspace <dir>", "workspace root", ".")
  .option("--check", "exit 1 when the workspace is out of date or has drift, or when AGENTS.md is over an explicit budget (CI mode)", false)
  .option("--dry-run", "show the plan, write nothing", false)
  .option("--overwrite-drift", "regenerate files that were hand-edited (their edits are lost)", false)
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .action(async (o) => {
    const ws = await loadWorkspace(o.workspace, load(o, "sync"));
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const st = await status(ws, p, lock);
    if (o.check) {
      const bad = st.filter((s) => !["unchanged", "adopt"].includes(s.state));
      printStatus(st, p.warnings, ws.config.profile, p.resolution.recipes, true, forgeLine(ws, lock));
      const unset = unsetDeclared(p);
      if (bad.length) console.log(pc.red(`\n${bad.length} file(s) out of sync`));
      // A refused sync is not "in sync", whatever the files say: the listing, then the block, and the exit is
      // exitCode's, so nothing queued is cut (spec 29 §4.1)
      // Both blocks are printed; either one, or a file out of sync, fails the check.
      const refused = [refusalBlock(unset), budgetRefusalBlock(p)].some(Boolean);
      if (refused || bad.length) process.exitCode = 1;
      else console.log(pc.green("\nworkspace in sync"));
      return;
    }
    // Asked here, not left to apply()'s gate: the plan's warnings come before the block (spec 29 §4.1)
    const unset = unsetDeclared(p);
    if (unset.length) {
      for (const w of p.warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
      fail(unsetRefusal(unset));
    }
    await applyAndReport(ws, p, st, lock, { dryRun: o.dryRun, overwriteDrift: o.overwriteDrift });
  });

/* ---------------------------------------------------------------- diff */
program
  .command("diff")
  .description("Unified diff between the files on disk and what the Forge would generate, orphans included (files the Forge no longer produces); also says when a declared parameter a file cites has no value, which sync refuses, and when AGENTS.md is over an explicit budget")
  .option("--workspace <dir>", "workspace root", ".")
  .option("--exit-code", "exit 1 when there are differences (exactly when `sync --check` would fail), including when AGENTS.md is over an explicit budget; a [path] that names no file craftar manages becomes an error; with a remote Forge, a failed fetch exits 1 as `sync --check` does (--offline to use the cached copy)", false)
  .argument("[path]", "limit to one file")
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .action(async (only, o) => {
    const ws = await loadWorkspace(o.workspace, load(o, o.exitCode ? DIFF_EXIT_CODE_FETCH_MODE : "read"));
    warnStderr(ws.warnings);
    const p = await plan(ws);
    const st = await status(ws, p, await readLock(ws.root));
    // Spec 19 §3.3: under --exit-code a path nothing matches must not read as "clean" to a script
    if (o.exitCode && only && !st.some((s) => s.path === only)) fail(unmanaged(only));
    let shown = 0;
    for (const s of st) {
      if (only && s.path !== only) continue;
      // Spec 19 §3.2: the six states sync --check refuses are shown; which those are is diffReport's to say
      const isPrimary = primaryOrphan(p, s);
      if (await printFileDiff(ws.root, s, { isPrimary })) shown++;
    }
    if (!shown) console.log(pc.green("no differences"));
    // exitCode, not process.exit: exit drops a piped diff still queued for a slow reader (spec 19 §3.1)
    else if (o.exitCode) process.exitCode = 1;
    // Spec 29 §4.1: with no [path], --exit-code fails exactly when `sync --check` does — a refused sync included
    if (refusalBlock(unsetDeclared(p)) && o.exitCode && !only) process.exitCode = 1;
    // The AGENTS.md budget, as the refusal above: always printed, failing only --exit-code with no [path]
    if (budgetRefusalBlock(p) && o.exitCode && !only) process.exitCode = 1;
  });

const DIFF_PAINT = { paint: { same: pc.dim, del: pc.red, add: pc.green } };

/** What `craftar diff` prints for one file `sync --check` refuses; `drift show <path>` prints the same for a drifted one. */
async function printFileDiff(root: string, s: FileStatus, opts: { isPrimary?: boolean } = {}): Promise<boolean> {
  // What to show is decided in the core (`diffReport`); the headers and the paint are this command's.
  const [row] = await diffReport({ root }, [s], { withholdMcp: false });
  // Nothing to show for `unchanged` and `adopt`: says so, for the caller's count
  if (!row) return false;
  if (s.state === "orphan-drift") {
    // Header and one line, no body: sync keeps this file
    console.log(pc.bold(`--- ${s.path} (disk, orphan-drift)`));
  } else if (s.state === "orphan") {
    // A removal: the file exists on disk but the Forge no longer produces it
    console.log(pc.bold(`--- ${s.path} (disk, orphan)`));
    const orphanReason = opts.isPrimary ? "written to AGENTS.md only — sync removes it" : "no longer produced — sync removes it";
    console.log(pc.bold(`+++ ${s.path} (forge: ${orphanReason})`));
  } else {
    console.log(pc.bold(`--- ${s.path} (disk, ${s.state})`));
    console.log(pc.bold(`+++ ${s.path} (forge)`));
  }
  // Spec 27 §4.2, Ruling 4: a note stands in for the on-disk content of the example file in drift / collision
  if (row.note !== null) console.log(`  ${row.note}`);
  else console.log(renderDiff(row.disk ?? "", row.forge ?? "", DIFF_PAINT));
  return true;
}

/* ---------------------------------------------------------------- drift */
const drift = program.command("drift").description("Hand-edited generated files: show them, discard the edit, or promote it to the Forge");

drift
  .command("show", { isDefault: true })
  .description("List the files hand-edited since the last sync, with the Forge's side and whether the edit can be promoted; with a path, that file's row and its diff. Writes nothing")
  .argument("[path]", "limit to one file, and show its diff")
  .option("--workspace <dir>", "workspace root", ".")
  .option("--json", "machine-readable output", false)
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .action(async (given: string | undefined, o: { workspace: string; json: boolean; offline: boolean }) => {
    const ws = await loadWorkspace(o.workspace, load(o, "read"));
    warnStderr(ws.warnings);
    const p = await plan(ws);
    const st = await status(ws, p, await readLock(ws.root));
    const only = given === undefined ? null : statusPath(given);
    const named = only === null ? null : st.find((s) => s.path === only);
    if (only !== null && !named) fail(unmanaged(only));
    // Spec 33i: compute the provided map; a throw (profile that resolves only because recipes.remove silences something) gives an empty map.
    let provided = new Map<string, { slot: string; recipe: string }>();
    const providedWarnings: string[] = [];
    try {
      provided = providedRefs(ws.forge, ws.config.profile);
    } catch (e) {
      // The profile's effective recipes don't resolve — drift show never fails for this.
      // Below schema 3, providedRefs returns early (line "if (!eff.selected.length) return new Map()") before resolve(), so it cannot throw.
      providedWarnings.push(`profile ${ws.config.profile} does not resolve on its own (${(e as Error).message}) — what its integrations provide was not computed, and craftar drift promote will refuse`);
    }
    const rows = driftList(named ? [named] : st, provided, new Set(p.reworded));
    // Spec 30r5: drift show decides a refused sync as status does — unsetParams in --json, the refusal block on stderr, exit 1.
    const unset = unsetDeclared(p);
    if (o.json) {
      console.log(JSON.stringify({ workspace: await fs.realpath(ws.root), profile: ws.config.profile, files: rows, warnings: [...p.warnings, ...providedWarnings], unsetParams: unset }, null, 2));
      if (unset.length) process.exitCode = 1;
      return;
    }
    warnStderr(providedWarnings);
    if (named && !rows.length) {
      console.log(`${named.path} is not drifted (${named.state})`);
      if (refusalBlock(unset)) process.exitCode = 1;
      return;
    }
    if (!rows.length) {
      console.log("no drift");
      if (refusalBlock(unset)) process.exitCode = 1;
      return;
    }
    // Columns as wide as their longest value, as the spec's example lines them up (§4.2).
    const wide = (pick: (r: DriftRow) => string) => Math.max(...rows.map((r) => pick(r).length));
    const [pathW, ingW, forgeW] = [wide((r) => r.path), wide((r) => r.ingredient), wide((r) => `forge: ${r.forge}`)];
    for (const r of rows)
      console.log(
        `${color(r.state)(r.state.padEnd(13))} ${r.path.padEnd(pathW)}  ${pc.dim(r.ingredient.padEnd(ingW))}  ${`forge: ${r.forge}`.padEnd(forgeW)}  promote: ${r.promotable ? "yes" : `no (${r.reason})`}`,
      );
    if (!named) {
      if (refusalBlock(unset)) process.exitCode = 1;
      return;
    }
    if (named.state === "orphan-drift") {
      // The whole file as a removal: what `drift discard` would do to it.
      console.log(pc.bold(`--- ${named.path} (disk, orphan-drift)`));
      console.log(pc.bold(`+++ ${named.path} (forge: no longer produced — \`craftar drift discard\` removes it)`));
      const { body, note } = await orphanDriftBody(ws.root, named);
      if (note) {
        console.log(`  ${note}`);
      } else {
        console.log(renderDiff(body ?? "", "", DIFF_PAINT));
      }
    } else await printFileDiff(ws.root, named);
    if (refusalBlock(unset)) process.exitCode = 1;
  });

drift
  .command("discard")
  .description("Regenerate the named hand-edited files from the Forge (their edits are lost) and remove a named hand-edited file the Forge no longer produces; otherwise a sync like any other")
  .argument("<path...>", "the hand-edited files, as `craftar status` prints them")
  .option("--workspace <dir>", "workspace root", ".")
  .option("--dry-run", "show the plan, write nothing", false)
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .action(async (given: string[], o: { workspace: string; dryRun: boolean; offline: boolean }) => {
    const ws = await loadWorkspace(o.workspace, load(o, "sync"));
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const st = await status(ws, p, lock);
    const paths = [...new Set(given.map(statusPath))];
    // Every refusal comes before the first write: one path that is not a hand edit stops the whole run.
    const stateOf = new Map(st.map((s) => [s.path, s.state]));
    const not = paths.filter((x) => stateOf.get(x) !== "drift" && stateOf.get(x) !== "orphan-drift");
    if (not.length) fail(`not drifted: ${not.map((x) => `${x} (${stateOf.get(x) ?? "not managed"})`).join(", ")} — nothing was written`);
    // Check for unset params BEFORE any output (spec 29 §4.1, spec 30r1 commit 3 issue 1)
    // Print plan warnings before the refusal, as sync does (spec 30r3 commit 3 issue 6)
    const unset = unsetDeclared(p);
    if (unset.length) {
      for (const w of p.warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
      fail(unsetRefusal(unset));
    }
    const overwritePaths = new Set(paths);
    console.log(`discarding ${paths.length} hand edit(s): ${st.filter((s) => overwritePaths.has(s.path)).map((s) => s.path).join(", ")}`);
    await applyAndReport(ws, p, st, lock, { dryRun: o.dryRun, overwritePaths });
  });

drift
  .command("promote")
  .description("Carry a hand-edited file to the Forge as a profile variant, behind git's gate, proved before any write; never writes the lock, the registry or the cache")
  .argument("<path>", "the hand-edited file, as `craftar status` prints it")
  .option("--workspace <dir>", "workspace root", ".")
  .option("--forge <dir>", "the Forge directory to write (required for a URL Forge)")
  .option("--dry-run", "prove and show the plan, write nothing", false)
  .option("--json", "machine-readable output", false)
  .action(async (givenPath: string, o: { workspace: string; forge?: string; dryRun: boolean; json: boolean }) => {
    const home = craftarHome();
    const normalizedPath = statusPath(givenPath);

    let promotePlan;
    try {
      promotePlan = await planPromote({
        workspaceRoot: o.workspace,
        forgeDir: o.forge ?? null,
        path: normalizedPath,
        home,
        env: process.env,
      });
    } catch (e) {
      // Handle UnheldError
      if (e instanceof UnheldError) {
        fail(unheldMessage("drift promote", e.forgeRoot, e.unheld));
      }
      throw e;
    }

    // --json output
    if (o.json) {
      // Apply first if not dry-run (spec 30r1 §3.2: JSON follows the write)
      if (!o.dryRun) {
        const journal: WriteJournal = [];
        try {
          await applyPromote(promotePlan, journal);
        } catch (e) {
          // Late failure: stdout stays "", stderr is lateFailure
          fail(lateFailure(e, promotePlan.forgeRoot, journal, "drift promote"));
        }
      }
      // Build the JSON object in spec §4.7 order
      const jsonObj = {
        workspace: promotePlan.workspaceRealPath,
        forge: promotePlan.forgeRoot,
        profile: promotePlan.profile,
        dryRun: o.dryRun,
        path: promotePlan.inputPath,
        ingredient: promotePlan.ingredientRef,
        outcome: promotePlan.outcome,
        promoted: promotePlan.promoted,
        written: promotePlan.entries.map((e) => ({
          path: e.rel,
          action: e.created ? "created" : "edited",
        })),
        params: promotePlan.params.map((p) => ({ key: p.key, old: p.old, value: p.value })),
        sections: promotePlan.sections.map((s) => ({ key: s.key, name: s.name })),
        flattened: promotePlan.flattened,
        dependents: promotePlan.dependents,
        nextSync: { counts: countStatesObject(promotePlan.nextSync) },
        impact: {
          registry: promotePlan.impact.registry,
          workspaces: promotePlan.impact.workspaces,
        },
        warnings: promotePlan.warnings,
      };
      console.log(JSON.stringify(jsonObj, null, 2));
      return;
    }

    // Apply first (unless dry-run), print after — spec 30r3 §3.4: on late failure stdout is ""
    const journal: WriteJournal = [];
    if (!o.dryRun) {
      try {
        await applyPromote(promotePlan, journal);
      } catch (e) {
        fail(lateFailure(e, promotePlan.forgeRoot, journal, "drift promote"));
      }
    }

    // Print the report
    const writeVerb = o.dryRun ? "would write" : "wrote ";
    const editVerb = o.dryRun ? "would edit" : "edited";

    // First line depends on outcome
    if (promotePlan.outcome === "params" || promotePlan.outcome === "sections") {
      console.log(`promote ${promotePlan.inputPath} → profile ${promotePlan.profile} (${promotePlan.outcome})`);
    } else {
      console.log(`promote ${promotePlan.inputPath} → ${promotePlan.promoted} (${promotePlan.outcome}, profile ${promotePlan.profile})`);
    }

    // Skip entries that are also in editedKeys (they'll be printed with keys below)
    const editedKeyFiles = new Set(promotePlan.editedKeys.keys());
    for (const e of promotePlan.entries) {
      if (editedKeyFiles.has(e.rel)) continue;
      if (e.created) {
        console.log(`  ${writeVerb} ${e.rel}`);
      } else {
        console.log(`  ${editVerb} ${e.rel}`);
      }
    }
    // Print early warnings (e.g., unmanaged skill files) — pinned by test 10
    const unusedSectionPrefix = "profile ";
    for (const w of promotePlan.warnings) {
      if (!w.startsWith(unusedSectionPrefix) || !w.includes(" still sets section ")) {
        // Skip registry warnings here — they come later
        if (!w.includes(": missing") && !w.includes(": error:")) {
          console.log(`  ${pc.yellow("warn")} ${w}`);
        }
      }
    }
    for (const [file, keys] of promotePlan.editedKeys) {
      console.log(`  ${editVerb} ${file} (${keys.join(", ")})`);
    }
    // Print param changes
    for (const p of promotePlan.params) {
      console.log(`  param ${p.key}: ${p.old === null ? "(unset)" : JSON.stringify(p.old)} → ${JSON.stringify(p.value)}`);
    }
    // Print section changes (line count, never content)
    for (const s of promotePlan.sections) {
      console.log(`  section ${s.key} ${s.name}: ${s.lines} line(s)`);
    }
    // Print flattened (only for variant outcomes)
    const flatParts: string[] = [];
    if (promotePlan.flattened.params.length > 0) {
      flatParts.push(`${promotePlan.flattened.params.length} param(s) (${promotePlan.flattened.params.join(", ")})`);
    }
    if (promotePlan.flattened.sections.length > 0) {
      flatParts.push(`${promotePlan.flattened.sections.length} section(s) (${promotePlan.flattened.sections.join(", ")})`);
    }
    if (flatParts.length > 0) {
      console.log(`  flattened: ${flatParts.join(", ")}`);
    }
    // Print late warnings (unused section value) after flattened — step 30g
    for (const w of promotePlan.warnings) {
      if (w.startsWith(unusedSectionPrefix) && w.includes(" still sets section ")) {
        console.log(`  ${pc.yellow("warn")} ${w}`);
      }
    }
    const otherCount = promotePlan.otherFilesUnchanged;
    console.log(`  proved: this workspace plans the file on disk; ${otherCount} other file(s) unchanged`);
    if (promotePlan.dependents.length > 0) {
      console.log(`  also changes ${promotePlan.dependents.join(", ")}`);
    }
    console.log(`  ${nextSyncLine(promotePlan.nextSync, promotePlan.nextUnset)}`);

    // Impact: print other workspaces or registry warning
    const impact = promotePlan.impact;
    if (impact.registry !== "read") {
      // none, partial, or off — spec 30 §4.6 item 6
      console.log(`  ${pc.yellow("warn")} other workspaces could not be checked (registry: ${impact.registry})`);
    } else if (impact.workspaces.length === 0) {
      console.log("  no other registered workspace reads this Forge");
    } else {
      // Group by profile and print
      const sameProfile = impact.workspaces.filter((ws) => ws.profile === promotePlan.profile && ws.state !== "missing" && ws.state !== "error");
      if (sameProfile.length > 0) {
        const countParts = sameProfile.map((ws) => {
          const c = NEXT_SYNC_STATES.map((k) => (ws.counts[k] ? `${ws.counts[k]} ${k}` : "")).filter(Boolean);
          return `${ws.path} — ${c.length ? c.join(", ") : "unchanged"}`;
        });
        console.log(`  ${sameProfile.length} other workspace(s) of profile ${promotePlan.profile} read this Forge: ${countParts.join("; ")}`);
      } else if (impact.workspaces.filter((ws) => ws.state !== "missing" && ws.state !== "error").length === 0) {
        console.log("  no other registered workspace reads this Forge");
      }
      // Print missing/error as warnings
      for (const ws of impact.workspaces) {
        if (ws.state === "missing") {
          console.log(`  ${pc.yellow("warn")} ${ws.path}: missing`);
        } else if (ws.state === "error") {
          console.log(`  ${pc.yellow("warn")} ${ws.path}: error: ${ws.error}`);
        }
      }
    }

    if (o.dryRun) {
      console.log("  dry run — the Forge was not written");
    } else {
      console.log("  the Forge is not committed — review with git, then commit and push it");
      if (promotePlan.isUrlForge) {
        console.log("  push the Forge for sync to see this");
      }
    }
  });

/* ---------------------------------------------------------------- add / remove recipe */
function recipeCommand(op: RecipeOp) {
  return async (names: string[], o: { workspace: string; replace?: boolean; offline?: boolean }) => {
    const ws = await loadWorkspace(o.workspace, load(o, "read"));
    warnStderr(ws.warnings);
    const outcome = await editRecipes(ws, op, names, { replace: o.replace });

    if (!outcome.changed) {
      console.log(`nothing to change${outcome.reasons.length ? `: ${outcome.reasons.join(", ")}` : ""}`);
      return;
    }

    console.log(`${WORKSPACE_FILE}: ${recipeDiffLine(outcome.before, outcome.after)}`);
    console.log(`recipes: ${outcome.next!.recipes.join(" → ")}`);
    console.log(nextSyncLine(outcome.next!.statuses, outcome.next!.unset));
    // plan() already carries ws.warnings first, and they were printed on load.
    warnStderr(outcome.next!.warnings);
  };
}

program
  .command("add")
  .description("Add to the workspace's choices in craftar.yaml")
  .command("recipe")
  .description(
    "Add recipes to craftar.yaml's recipes.add (or cancel their recipes.remove entry), after proving the workspace still resolves; writes nothing else and does not sync — it says what the next sync would do",
  )
  .argument("<name...>", "the recipes to add, applied in order, all or nothing")
  .option("--replace", "swap out every other recipe that holds the same slot", false)
  .option("--workspace <dir>", "workspace root", ".")
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .action(recipeCommand("add"));

program
  .command("remove")
  .description("Remove from the workspace's choices in craftar.yaml")
  .command("recipe")
  .description(
    "Remove recipes through craftar.yaml's recipes.remove (or cancel their recipes.add entry); refuses one another recipe brings in through extends; writes nothing else and does not sync",
  )
  .argument("<name...>", "the recipes to remove, applied in order, all or nothing")
  .option("--workspace <dir>", "workspace root", ".")
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .action(recipeCommand("remove"));

/* ---------------------------------------------------------------- explain */
program
  .command("explain")
  .description("Why does this file exist? Which ingredient, recipe chain and target produced it, and which layer filled each section and each parameter it cites")
  .argument("<path>", "workspace-relative path of a generated file")
  .option("--workspace <dir>", "workspace root", ".")
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .action(async (file, o) => {
    const ws = await loadWorkspace(o.workspace, load(o, "read"));
    warnStderr(ws.warnings);
    const p = await plan(ws);
    const f = explainFile(ws, p, file.replace(/\\/g, "/"));
    if (!f) fail(notProduced(file, ws.config.profile));
    console.log(pc.bold(f.path));
    console.log(`  target      ${f.target}`);
    console.log(`  ingredient  ${f.ingredient}${f.origin ? pc.dim(`  (imported from ${f.origin.workspace}:${f.origin.path})`) : ""}`);
    if (f.via) console.log(`  via recipes ${f.via.join(" → ")}`);
    // Spec 11 §4.2 (Ruling 15): which layer filled each section. AGENTS.md (rule/*) is not one ingredient.
    if (f.sections.length) {
      const layer = (l: SectionLayer) => (l === "profile" ? `profile ${p.resolution.profile.name}` : l);
      console.log(`  sections    ${f.sections.map((x) => `${x.name} (${layer(x.layer)})`).join(", ")}`);
    }
    // Spec 29 §4.1: which layer filled each parameter the file's ingredient cites — or `unset`.
    if (f.params.length) {
      const layer = (l: ParamLayer) => (typeof l === "string" ? l : "recipe" in l ? `recipe ${l.recipe}` : `profile ${l.profile}`);
      console.log(`  params      ${f.params.map((x) => `${x.key} (${layer(x.layer)})`).join(", ")}`);
    }
    console.log(`  profile     ${f.profile}  (recipes: ${f.recipes.join(", ")})`);
    console.log(`  hash        ${f.hash}`);
  });

/* ---------------------------------------------------------------- forge ls */
program
  .command("ls")
  .description("List recipes and ingredients resolved for this workspace")
  .option("--workspace <dir>", "workspace root", ".")
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .action(async (o) => {
    const ws = await loadWorkspace(o.workspace, load(o, "read"));
    warnStderr(ws.warnings);
    const p = await plan(ws);
    console.log(pc.bold(`Forge ${ws.forge.manifest.name} @ ${ws.forge.commit?.slice(0, 8) ?? "no git"} · profile ${ws.config.profile}`));
    const fl = forgeLine(ws, await readLock(ws.root));
    if (fl) console.log(fl);
    for (const r of p.resolution.recipes) {
      const rec = ws.forge.recipes.get(r)!;
      console.log(`\n${pc.cyan(r)}${rec.slot ? pc.dim(` [slot ${rec.slot}]`) : ""}${rec.description ? pc.dim(" — " + rec.description) : ""}`);
      for (const ref of rec.ingredients) {
        const disabled = p.resolution.disabled.includes(ref as never);
        console.log(`  ${disabled ? pc.strikethrough(ref) : ref}${disabled ? pc.dim(" (disabled by workspace)") : ""}`);
      }
    }
    console.log(`\n${p.files.length} files across targets ${p.resolution.targets.join(", ")}`);
  });

/* ---------------------------------------------------------------- workspaces */
const workspaces = program
  .command("workspaces")
  .description(
    "List every workspace a writing sync registered on this machine ($CRAFTAR_HOME/registry.json), with its status computed now: up to date, outdated, drift, no lock, missing or error — read without the network",
  )
  .option("--fetch", "fetch each remote Forge first instead of reading the cached copy", false)
  .option("--json", "machine-readable output", false)
  .action(async (o) => {
    registryGate();
    const t = await listWorkspaces(craftarHome(), { fetch: o.fetch });
    if (o.json) return console.log(JSON.stringify({ registry: t.registry, fetch: o.fetch, workspaces: t.rows, warnings: t.warnings }, null, 2));
    printWorkspaces(t.rows, t.warnings, o.fetch);
  });

workspaces
  .command("forget")
  .description("Remove a workspace from the registry; the directory itself is not touched")
  .argument("<dir>", "the workspace's directory, as registered")
  .action(async (dir) => {
    registryGate();
    console.log(`forgot ${await forget(craftarHome(), dir)}`);
  });

workspaces
  .command("prune")
  .description("Remove every registered workspace whose directory or craftar.yaml is gone")
  .action(async () => {
    registryGate();
    const gone = await prune(craftarHome());
    if (gone.length === 0) console.log("nothing to prune");
    for (const p of gone) console.log(`pruned ${p}`);
  });

/* ---------------------------------------------------------------- ui */
program
  .command("ui")
  .description(
    "A local dashboard: the table of `craftar workspaces` and, for one workspace, its file states, a file's diff and explanation, and its Forge's recipes and ingredients — in a browser, on 127.0.0.1 only, behind an address that works for this run. Reads only unless --allow-writes — then a sync or the discard of one hand-edited file, confirmed in the page, never --overwrite-drift — and reaches no network; Ctrl-C stops it",
  )
  .option("--port <n>", "the port to listen on, 0 to 65535; 0 takes a free one", "4747")
  .option("--allow-writes", "serve Sync and Discard edit on the page — a sync of one workspace, or the discard of one hand-edited file, each confirmed in the page; workspaces with a path Forge only")
  .action(async (o: { port: string; allowWrites?: boolean }) => {
    // Every refusal comes before the bind (spec 36 §4.2).
    const port = parsePort(o.port);
    if (port === null) fail("--port takes a whole number from 0 to 65535");
    registryGate();
    let reg: Registry;
    try {
      reg = await readRegistry(craftarHome());
    } catch (e) {
      fail(errorText(e));
    }
    const version = program.version() ?? "unknown";
    const allowWrites = o.allowWrites === true;
    let ui: UiServer;
    try {
      // The one line a failing request leaves in the terminal; nothing is printed per request otherwise.
      ui = await startUi({ home: craftarHome(), version, port, allowWrites, onError: (line) => console.error(line) });
    } catch (e) {
      // The code only, never the message.
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") fail(`port ${port} is in use on 127.0.0.1 — pass --port <other>, or --port 0 for a free one`);
      fail(`cannot listen on 127.0.0.1:${port}: ${code ?? "unknown"}`);
    }
    if (allowWrites) {
      console.log(pc.bold(`craftar ui — craftar ${version} · writes allowed · ${reg.workspaces.length} registered`));
      console.log("  writes allowed: sync, discard one hand-edited file");
    } else {
      console.log(pc.bold(`craftar ui — craftar ${version} · read-only · ${reg.workspaces.length} registered`));
    }
    console.log(`  open  ${ui.url}`);
    console.log("  the address works for this run only, on this machine — Ctrl-C stops it");
    // The first signal closes the listener and lets the process end; a second one, while closing, ends it at once.
    let closing = false;
    const stop = (): void => {
      if (closing) process.exit(0);
      closing = true;
      void ui.close().then(() => {
        console.log("stopped");
        process.exitCode = 0;
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

/* ---------------------------------------------------------------- doctor */
program
  .command("doctor")
  .description(
    "Check this machine (Node, git, $CRAFTAR_HOME, the registry, the Forge cache) and, inside one, this workspace (configuration and Forge, plan, declared parameters, MCP environment variables, Windows-only MCP launchers, the profile's templates block and dotnet when it has one, hooks-registered when the plan writes a registration, lock, status, registry entry): one line per finding — ok, warn or error — each with its fix. Reports only; reads without the network unless --fetch",
  )
  // No commander default: an explicit --workspace without craftar.yaml exits 1, the current directory without one runs the machine checks (spec 24 §4.1).
  .option("--workspace <dir>", "the workspace to check (default: the current directory, when it holds craftar.yaml)")
  .option("--fetch", "fetch a remote Forge first instead of reading the cached copy", false)
  .option("--strict", "exit 1 on a warn too, not only on an error", false)
  .option("--json", "machine-readable output", false)
  .action(async (o) => {
    let workspace: string | null = null;
    if (o.workspace !== undefined) {
      if (!(await exists(path.join(o.workspace, WORKSPACE_FILE))))
        fail(`no ${WORKSPACE_FILE} in ${path.resolve(o.workspace)} — run doctor inside a workspace, or without --workspace for the machine checks`);
      workspace = o.workspace;
    } else if (await exists(path.join(process.cwd(), WORKSPACE_FILE))) workspace = process.cwd();
    const report = await runDoctor({
      version: program.version() ?? "unknown",
      home: craftarHome(),
      workspace,
      fetch: o.fetch,
      strict: o.strict,
      registryOff: registryOff(),
    });
    if (o.json) console.log(JSON.stringify(report, null, 2));
    else printDoctor(report);
    // exitCode, not process.exit: a piped --json is never cut (spec 24 §5.1).
    if (report.summary.error > 0 || (o.strict && report.summary.warn > 0)) process.exitCode = 1;
  });

/* ---------------------------------------------------------------- templates */
const templates = program.command("templates").description("Project templates the profile declares (dotnet new): list them, or install them into this user's dotnet template store");

/** The profile's declared templates (spec 32 §5.2); a refused block is the command's error. */
async function declaredFor(ws: Workspace): Promise<{ profile: string; declared: Declared }> {
  const profile = ws.forge.profiles.get(ws.config.profile);
  if (!profile) fail(`profile "${ws.config.profile}" not found in Forge`);
  try {
    return { profile: profile.name, declared: declaredTemplates(profile, await profileLabel(ws.forge.root, profile.name)) };
  } catch (e) {
    fail(errorText(e));
  }
}

templates
  .command("list")
  .description(
    "What the profile's templates block declares: one line per package — kind, package, version or latest, source or default feeds — and one per entry this craftar cannot install. Runs no program and does not know what is installed",
  )
  .option("--json", "machine-readable output", false)
  .option("--workspace <dir>", "workspace root", ".")
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .action(async (o) => {
    const ws = await loadWorkspace(o.workspace, load(o, "read"));
    const { profile, declared } = await declaredFor(ws);
    const rows = templateRows(declared.entries);
    const warnings = [...ws.warnings, ...declared.warnings];

    if (o.json) {
      console.log(JSON.stringify({ profile, templates: rows, warnings }, null, 2));
      return;
    }

    warnStderr(warnings);

    if (!declared.declared || declared.entries.length === 0) {
      console.log(`no templates declared for profile ${profile}`);
      return;
    }

    // Text mode: header and one line per row
    const installableRows = rows.filter((r) => r.installable);
    const kindWidth = Math.max(...rows.map((r) => r.kind.length));
    const packageWidth = installableRows.length ? Math.max(...installableRows.map((r) => (r.package ?? "").length)) : 0;
    const versionWidth = installableRows.length ? Math.max(...installableRows.map((r) => (r.version ?? "latest").length)) : 0;

    console.log(pc.bold(`Templates of profile ${profile}`));
    for (const row of rows) {
      if (row.installable) {
        const pkg = (row.package ?? "").padEnd(packageWidth);
        const ver = (row.version ?? "latest").padEnd(versionWidth);
        const src = row.source ?? "default feeds";
        console.log(`  ${row.kind.padEnd(kindWidth)}  ${pkg}  ${ver}  ${src}`);
      } else {
        console.log(`  ${row.kind.padEnd(kindWidth)}  not installed by this craftar`);
      }
    }
  });

templates
  .command("install")
  .description(
    "Run dotnet new install once per dotnet-new entry, in the profile's order, at the workspace root; the packages land in this user's dotnet template store, shared by every workspace. Nothing else runs it. Exits 1 when an entry failed or was skipped (--dry-run exits 0 over an accepted block)",
  )
  .option("--dry-run", "print each dotnet new install line; run nothing (needs no dotnet)", false)
  .option("--force", "pass --force to dotnet new install", false)
  .option("--interactive", "pass --interactive to dotnet new install and give it the terminal's input", false)
  .option("--workspace <dir>", "workspace root", ".")
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .action(async (o) => {
    const ws = await loadWorkspace(o.workspace, load(o, "read"));
    const { profile, declared } = await declaredFor(ws);
    const warnings = [...ws.warnings, ...declared.warnings];
    warnStderr(warnings);

    if (!declared.declared || declared.entries.length === 0) {
      console.log(`no templates declared for profile ${profile}`);
      return;
    }

    const hasInstallable = declared.entries.some((e) => e.installable);
    if (hasInstallable && !o.dryRun) {
      const version = await dotnetVersion(capture, process.env, ws.root);
      if (version === null) {
        fail(`${DOTNET_MISSING} — ${DOTNET_MISSING_FIX}, then run craftar templates install again (--dry-run shows the lines without it)`);
      }
    }

    const unpinned = await unpinnedSources(declared.entries, ws.root);
    if (unpinned.length > 0) {
      warnStderr([`templates: ${feedMessage(unpinned)}`]);
    }

    const announce = (entry: number, line: string) => console.log(`templates[${entry}]: ${line}`);
    let result: InstallResult;
    try {
      result = await installTemplates(declared.entries, ws.root, { dryRun: o.dryRun, force: o.force, interactive: o.interactive, env: process.env, announce }, spawnInherited);
    } catch (e) {
      fail(errorText(e));
    }

    const report = installReport(result, o.dryRun);
    for (const l of report.err) errorLine(l);
    for (const l of report.out) console.log(l);
    if (report.exitCode) process.exitCode = 1;
  });

/* ---------------------------------------------------------------- mcp */
const mcpCmd = program
  .command("mcp")
  .description(
    "Serve this workspace to an AI coder over the Model Context Protocol, on stdin and stdout: seven reading tools — status, diff, explain, recipes, ingredients, targets, doctor — with the data those commands print. Started by the AI coder, not typed. Reads only unless --allow-writes; reads without the network unless --fetch",
  )
  .option("--workspace <dir>", "the workspace to serve", ".")
  .option("--fetch", "let a tool call fetch a remote Forge instead of reading the cached copy", false)
  .option("--allow-writes", "enable the writing tools (sync, add_recipe, remove_recipe) for a workspace with consent", false)
  .action(async (o: { workspace: string; fetch: boolean; allowWrites: boolean }) => {
    // The bound workspace, resolved once: no tool takes a directory (spec 35 §4.1).
    const root = path.resolve(o.workspace);
    const refusal = launchRefusal(process.stdin.isTTY === true, await exists(path.join(root, WORKSPACE_FILE)), root);
    if (refusal !== null) fail(refusal);
    // The configuration must read at launch — its forge, ref and profile are the pin. The Forge need not load: each call says so.
    let merged: MergedConfig;
    try {
      merged = await readWorkspaceConfig(root);
    } catch (e) {
      fail(errorText(e));
    }
    // From here stdout carries protocol lines only, and stderr nothing (spec 35 §4.1, §7). Stdin ending ends the process, exit 0.
    await serve(process.stdin, process.stdout, {
      root,
      fetch: o.fetch,
      home: craftarHome(),
      version: program.version() ?? "unknown",
      registryOff: registryOff(),
      env: process.env,
      pin: pinOf(merged),
      writers: o.allowWrites ? mcpWriters(craftarHome(), registryOff()) : undefined,
    });
  });

mcpCmd
  .command("allow-writes")
  .description(
    "Let craftar mcp --allow-writes write in this workspace — sync, add_recipe, remove_recipe — for the Forge, ref and profile it names now; asks a person in a terminal and records the consent in this machine's registry",
  )
  // No default here: `mcp` holds `--workspace` too, and commander gives the value to the parent when both declare it.
  .option("--workspace <dir>", 'workspace root (default: ".")')
  .action(async (o: { workspace?: string }) => {
    const workspace: string = o.workspace ?? mcpCmd.opts().workspace ?? ".";
    if (mcpCmd.opts().fetch) fail("craftar mcp allow-writes takes only --workspace");
    if (mcpCmd.opts().allowWrites) fail("craftar mcp allow-writes takes only --workspace");
    const root = path.resolve(workspace);
    if (!(await exists(path.join(root, WORKSPACE_FILE)))) {
      fail(`no craftar.yaml in ${root} — the consent is given for one workspace; type it in one, or pass --workspace`);
    }
    if (registryOff()) fail("the consent is recorded in the registry, and CRAFTAR_NO_REGISTRY is set — unset it to allow writes");
    const home = craftarHome();
    try {
      await readRegistry(home);
    } catch (e) {
      fail(`cannot read the registry: ${errorText(e)}`);
    }
    // a forge: holding credentials is refused here, before anything prints it
    let merged: MergedConfig;
    try {
      merged = await readWorkspaceConfig(root);
    } catch (e) {
      fail(errorText(e));
    }
    // before anything prints or records it (and before the terminal check)
    if (merged.config.ref && refHoldsCredentials(merged.config.ref)) {
      fail(`ref holds ${CREDENTIAL_HIDDEN} — remove the credentials before allowing writes`);
    }
    if (!(process.stdin.isTTY === true && process.stdout.isTTY === true)) {
      fail("craftar mcp allow-writes asks a person in a terminal — type it in one; it cannot be run from a script or an AI coder's shell tool");
    }
    const realRoot = await fs.realpath(root);
    const refLine = merged.config.ref ?? "(the Forge's default)";
    console.log(`craftar mcp allow-writes — ${realRoot}`);
    console.log(`  forge    ${merged.config.forge}`);
    console.log(`  ref      ${refLine}`);
    console.log(`  profile  ${merged.config.profile}`);
    console.log(`  tools    sync, add_recipe, remove_recipe — sync never discards a hand edit`);
    if (!(await confirmWrites(readlineIo(process.stdin, process.stdout, { terminal: true })))) fail("allow-writes cancelled — nothing written");
    try {
      const consent = await allowWrites(home, root, {
        forge: { source: merged.config.forge, ref: merged.config.ref ?? null },
        profile: merged.config.profile,
      });
      console.log(`write consent recorded for ${consent.path} — craftar mcp --allow-writes may sync and edit recipes here; craftar mcp revoke-writes takes it back`);
    } catch (e) {
      fail(`consent not recorded: ${errorText(e)}`);
    }
  });

mcpCmd
  .command("revoke-writes")
  .description("Take back the consent of craftar mcp allow-writes for this workspace; needs no terminal")
  // No default here: `mcp` holds `--workspace` too, and commander gives the value to the parent when both declare it.
  .option("--workspace <dir>", 'workspace root (default: ".")')
  .action(async (o: { workspace?: string }) => {
    const workspace: string = o.workspace ?? mcpCmd.opts().workspace ?? ".";
    if (mcpCmd.opts().fetch) fail("craftar mcp revoke-writes takes only --workspace");
    if (mcpCmd.opts().allowWrites) fail("craftar mcp revoke-writes takes only --workspace");
    const root = path.resolve(workspace);
    if (!(await exists(path.join(root, WORKSPACE_FILE)))) {
      fail(`no craftar.yaml in ${root} — the consent is given for one workspace; type it in one, or pass --workspace`);
    }
    if (registryOff()) fail("the consent is recorded in the registry, and CRAFTAR_NO_REGISTRY is set — nothing to revoke here");
    const home = craftarHome();
    try {
      const result = await revokeWrites(home, root);
      if (result.removed) {
        console.log(`write consent removed for ${result.path}`);
      } else {
        console.log(`no consent recorded for ${result.path}`);
      }
    } catch (e) {
      fail(`consent not removed: ${errorText(e)}`);
    }
  });

/* ---------------------------------------------------------------- recipes */
program
  .command("recipes")
  .description("List every recipe of the Forge — slot, parents, the profiles that use it — marked against this workspace or a profile. Read-only")
  .option("--forge <dir>", "Forge directory (instead of --workspace)")
  .option("--profile <name>", "with --forge: mark what this profile resolves")
  .option("--workspace <dir>", "workspace whose craftar.yaml names the Forge (default: .)")
  .option("--json", "machine-readable output", false)
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .action(async (o) => {
    if (o.profile && !o.forge) fail("--profile goes with --forge — inside a workspace the profile comes from craftar.yaml");

    const { forge: forg, workspace } = await resolveForgeSource({ forge: o.forge, workspace: o.workspace, ...load(o, "read") });
    const source: ContextSource | null = workspace
      ? { kind: "workspace", config: workspace.config }
      : o.profile
        ? { kind: "profile", profile: o.profile }
        : null;

    let context: CatalogueContext | null = null;
    if (source) {
      try {
        context = catalogueContext(forg, source);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    }

    const r = listRecipes(forg, context);
    // Loading the workspace may warn (spec 13 §4.2); those come first, as in `plan()`.
    if (workspace) withLoadWarnings(r, workspace.warnings);

    if (o.json) {
      return console.log(JSON.stringify(r, null, 2));
    }

    // Text mode
    const ctxDesc = source
      ? source.kind === "workspace"
        ? `workspace profile ${source.config.profile}`
        : `profile ${source.profile}`
      : null;
    console.log(pc.bold(`craftar recipes — forge ${forg.manifest.name} @ ${forg.commit?.slice(0, 8) ?? "no git"}${ctxDesc ? ` · ${ctxDesc}` : ""}`));

    const resolves = context !== null && context.resolution !== null;

    // Compute column widths for alignment
    // Column 1: name[ [slot s]]
    // Column 2: <N ingredient(s)>
    // Column 3: ← parents (empty when none)
    // Column 4: reason (empty when none)
    const col1 = r.recipes.map((rec) => `${rec.name}${rec.slot ? ` [slot ${rec.slot}]` : ""}`);
    const col2 = r.recipes.map((rec) => `${rec.ingredients.length} ingredient${rec.ingredients.length === 1 ? "" : "s"}`);
    const col3 = r.recipes.map((rec) => rec.extends.length ? `← ${rec.extends.join(", ")}` : "");
    const col4 = r.recipes.map((rec) => {
      let reason = "";
      if (rec.inUse) {
        const byParts: string[] = [];
        for (const b of rec.inUse.by) {
          if (b === "extends") byParts.push(`extends ${rec.inUse.extendedBy.join(", ")}`);
          else byParts.push(b);
        }
        reason = `in use (${byParts.join(", ")})`;
      }
      const removed = rec.removedByWorkspace ? (reason ? " · " : "") + "removed by this workspace" : "";
      return reason + removed;
    });
    const w1 = Math.max(...col1.map((s) => s.length));
    const w2 = Math.max(...col2.map((s) => s.length));
    const w3 = Math.max(...col3.map((s) => s.length));
    const w4 = Math.max(...col4.map((s) => s.length));

    for (let i = 0; i < r.recipes.length; i++) {
      const rec = r.recipes[i];
      const desc = rec.description ? `— ${rec.description}` : "";
      let line: string;
      if (resolves) {
        const mark = rec.inUse ? pc.green("●") : pc.dim("○");
        line = [
          `  ${mark} `,
          col1[i].padEnd(w1),
          "  ",
          col2[i].padEnd(w2),
          col3[i] ? "  " + col3[i].padEnd(w3) : (w3 > 0 ? "  " + "".padEnd(w3) : ""),
          col4[i] ? "  " + col4[i].padEnd(w4) : (w4 > 0 ? "  " + "".padEnd(w4) : ""),
          desc ? "  " + desc : "",
        ].join("").trimEnd();
      } else {
        // No context: no mark column, rows start with two spaces then the name
        line = [
          "  ",
          col1[i].padEnd(w1),
          "  ",
          col2[i].padEnd(w2),
          col3[i] ? "  " + col3[i].padEnd(w3) : (w3 > 0 ? "  " + "".padEnd(w3) : ""),
          desc ? "  " + desc : "",
        ].join("").trimEnd();
      }
      console.log(line);
    }

    // Count line
    const inUseCount = r.recipes.filter((x) => x.inUse).length;
    const profilesPart = r.recipes.length > 0
      ? ` · used by profiles: ${r.recipes.map((x) => `${x.name} (${x.profiles.length ? x.profiles.join(", ") : "—"})`).join(", ")}`
      : "";
    const countLine = resolves
      ? `${r.recipes.length} recipe${r.recipes.length === 1 ? "" : "s"}, ${inUseCount} in use${profilesPart}`
      : `${r.recipes.length} recipe${r.recipes.length === 1 ? "" : "s"}${profilesPart}`;
    console.log(`\n  ${countLine}`);
    for (const w of r.warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
  });

/* ---------------------------------------------------------------- ingredients */
program
  .command("ingredients")
  .description("List every ingredient of the Forge — its recipes and targets, references to missing ones — or what one recipe brings with its parents. Read-only")
  .option("--recipe <name>", "only what this recipe brings, with the parents it extends, parents first")
  .option("--type <type>", "only this ingredient type")
  .option("--forge <dir>", "Forge directory (instead of --workspace)")
  .option("--profile <name>", "with --forge: mark what this profile resolves")
  .option("--workspace <dir>", "workspace whose craftar.yaml names the Forge (default: .)")
  .option("--json", "machine-readable output", false)
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .action(async (o) => {
    if (o.profile && !o.forge) fail("--profile goes with --forge — inside a workspace the profile comes from craftar.yaml");
    if (o.type) {
      try {
        checkType(o.type);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    }

    const { forge: forg, workspace } = await resolveForgeSource({ forge: o.forge, workspace: o.workspace, ...load(o, "read") });
    const source: ContextSource | null = workspace
      ? { kind: "workspace", config: workspace.config }
      : o.profile
        ? { kind: "profile", profile: o.profile }
        : null;

    let context: CatalogueContext | null = null;
    if (source) {
      try {
        context = catalogueContext(forg, source);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    }

    let result;
    try {
      result = listIngredients(forg, context, { recipe: o.recipe, type: o.type });
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    if (workspace) withLoadWarnings(result, workspace.warnings);

    if (o.json) {
      return console.log(JSON.stringify(result, null, 2));
    }

    // Text mode
    const ctxDesc = source
      ? source.kind === "workspace"
        ? `workspace profile ${source.config.profile}`
        : `profile ${source.profile}`
      : null;
    const recipeOpt = o.recipe ? ` --recipe ${o.recipe}` : "";
    const typeOpt = o.type ? ` --type ${o.type}` : "";
    console.log(pc.bold(`craftar ingredients${recipeOpt}${typeOpt} — forge ${forg.manifest.name} @ ${forg.commit?.slice(0, 8) ?? "no git"}${ctxDesc ? ` · ${ctxDesc}` : ""}`));

    const resolves = context !== null && context.resolution !== null;

    if (result.recipe) {
      // --recipe mode: grouped by chain entry
      // Compute column widths for alignment across the whole listing
      // Column 1: ref[ → outputName]
      const col1Recipe: string[] = [];
      for (const entry of result.recipe.chain) {
        for (const ref of entry.ingredients) {
          const ing = result.ingredients.find((i) => i.ref === ref);
          if (ing) {
            col1Recipe.push(ing.outputName !== ing.name ? `${ref} → ${ing.outputName}` : ref);
          } else {
            col1Recipe.push(ref);
          }
        }
      }
      const w1Recipe = Math.max(...col1Recipe.map((s) => s.length), 0);

      for (const entry of result.recipe.chain) {
        const rec = forg.recipes.get(entry.recipe);
        const ext = rec?.extends.length ? `  ← ${rec.extends.join(", ")}` : "";
        const slot = rec?.slot ? `  [slot ${rec.slot}]` : "";
        console.log(`${entry.recipe}${ext}${slot}`);
        for (const ref of entry.ingredients) {
          const ing = result.ingredients.find((i) => i.ref === ref);
          const miss = result.missing.find((m) => m.ref === ref);
          if (ing) {
            const col1 = ing.outputName !== ing.name ? `${ref} → ${ing.outputName}` : ref;
            const disabled = ing.disabled ? "(disabled by this workspace)" : "";
            let line: string;
            if (resolves) {
              const mark = ing.disabled ? pc.dim("◌") : ing.inUse ? pc.green("●") : pc.dim("○");
              line = `  ${mark} ${col1.padEnd(w1Recipe)}${disabled ? "  " + disabled : ""}`.trimEnd();
            } else {
              line = `  ${col1.padEnd(w1Recipe)}`.trimEnd();
            }
            console.log(line);
          } else if (miss) {
            const line = `  ${pc.red("✗")} ${ref.padEnd(w1Recipe)}  not in this Forge`.trimEnd();
            console.log(line);
          }
        }
      }
      // Count line for --recipe
      const countLine = `${result.recipe.chain.length} recipe${result.recipe.chain.length === 1 ? "" : "s"}, ${result.ingredients.length} ingredient${result.ingredients.length === 1 ? "" : "s"}${result.missing.length ? ` · ${result.missing.length} missing reference${result.missing.length === 1 ? "" : "s"}` : ""}`;
      console.log(`\n  ${countLine}`);
    } else {
      // No --recipe: grouped by type
      // Spec 16 §4.3: rows print the bare `name`, not the `ref`, under their type heading
      // Compute column widths across the whole listing (all types + missing)
      // Column 1: name[ → outputName] (or ref for missing)
      // Column 2: targets <...>
      // Column 3: in <...>
      const allCol1: string[] = [];
      const allCol2: string[] = [];
      const allCol3: string[] = [];
      for (const ing of result.ingredients) {
        const col1 = ing.outputName !== ing.name ? `${ing.name} → ${ing.outputName}` : ing.name;
        allCol1.push(col1);
        allCol2.push(`targets ${ing.targets === "*" ? "*" : ((ing.targets as string[]).join(", ") || "none")}`);
        allCol3.push(`in ${ing.recipes.length ? ing.recipes.join(", ") : "no recipe"}`);
      }
      for (const m of result.missing) {
        allCol1.push(m.ref);
      }
      const w1 = Math.max(...allCol1.map((s) => s.length), 0);
      const w2 = Math.max(...allCol2.map((s) => s.length), 0);
      const w3 = Math.max(...allCol3.map((s) => s.length), 0);

      const byType = new Map<string, typeof result.ingredients>();
      for (const ing of result.ingredients) {
        if (!byType.has(ing.type)) byType.set(ing.type, []);
        byType.get(ing.type)!.push(ing);
      }
      for (const type of INGREDIENT_TYPES) {
        const ings = byType.get(type);
        if (!ings?.length) continue;
        console.log(type);
        for (const ing of ings) {
          const col1 = ing.outputName !== ing.name ? `${ing.name} → ${ing.outputName}` : ing.name;
          const col2 = `targets ${ing.targets === "*" ? "*" : ((ing.targets as string[]).join(", ") || "none")}`;
          const col3 = `in ${ing.recipes.length ? ing.recipes.join(", ") : "no recipe"}`;
          const desc = ing.description ? `— ${ing.description}` : "";
          const disabled = ing.disabled ? "(disabled by this workspace)" : "";
          let line: string;
          if (resolves) {
            const mark = ing.disabled ? pc.dim("◌") : ing.inUse ? pc.green("●") : pc.dim("○");
            line = [
              `  ${mark} `,
              col1.padEnd(w1),
              "  ",
              col2.padEnd(w2),
              "  ",
              col3.padEnd(w3),
              desc ? "  " + desc : "",
              disabled ? "  " + disabled : "",
            ].join("").trimEnd();
          } else {
            // No context: no mark column, rows start with two spaces then the name
            line = [
              "  ",
              col1.padEnd(w1),
              "  ",
              col2.padEnd(w2),
              "  ",
              col3.padEnd(w3),
              desc ? "  " + desc : "",
            ].join("").trimEnd();
          }
          console.log(line);
        }
      }
      if (result.missing.length) {
        console.log("missing");
        for (const m of result.missing) {
          const line = `  ${m.ref.padEnd(w1)}  cited by ${m.recipes.join(", ")}, not in this Forge`.trimEnd();
          console.log(line);
        }
      }
      // Count line
      const inUseCount = result.ingredients.filter((x) => x.inUse).length;
      const disabledCount = result.ingredients.filter((x) => x.disabled).length;
      const noRecipeCount = result.ingredients.filter((x) => x.recipes.length === 0).length;
      const countParts = [`${result.ingredients.length} ingredient${result.ingredients.length === 1 ? "" : "s"}`];
      if (resolves) {
        countParts.push(`${inUseCount} in use`);
        countParts.push(`${disabledCount} disabled`);
      }
      countParts.push(`${noRecipeCount} in no recipe`);
      const missingPart = result.missing.length ? ` · ${result.missing.length} missing reference${result.missing.length === 1 ? "" : "s"}` : "";
      console.log(`\n  ${countParts.join(", ")}${missingPart}`);
    }
    for (const w of result.warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
  });

/* ---------------------------------------------------------------- targets */
program
  .command("targets")
  .description("Print the capability matrix: what each target does with each ingredient type (native, converted, unsupported), marking the targets this workspace uses. Read-only")
  .option("--workspace <dir>", "workspace whose targets to mark (default: . when it holds a craftar.yaml)")
  .option("--json", "machine-readable output", false)
  .action(async (o) => {
    const root = o.workspace ?? ".";
    let input: Parameters<typeof targetsReport>[2] = null;
    if (!(await exists(path.join(root, WORKSPACE_FILE)))) {
      // Explicit --workspace without craftar.yaml: exit 1 with the load's own message. No --workspace: unmarked, no warning.
      if (o.workspace !== undefined) {
        try {
          await readWorkspaceConfig(root);
        } catch (e) {
          fail(e instanceof Error ? e.message : String(e));
        }
      }
    } else {
      // craftar.yaml exists: a configuration that does not read is a warning, as a Forge that does not load is
      try {
        input = { merged: await readWorkspaceConfig(root) };
      } catch (e) {
        input = { reason: e instanceof Error ? e.message : String(e) };
      }
    }

    const result = await targetsReport(root, { home: load({}, "no-fetch").home }, input);
    const warnings = result.warnings;

    if (o.json) {
      return console.log(JSON.stringify(result, null, 2));
    }

    // Text mode
    const targetLine = result.targets
      .map((t) => (t.inUse === true ? `${t.name} (in use)` : t.name))
      .join(" · ");
    console.log(pc.bold(`craftar targets — ${targetLine}`));
    console.log();

    // Matrix table
    const colWidth = 14;
    const typeColWidth = 10;
    const header = "  " + " ".repeat(typeColWidth) + result.targets.map((t) => t.name.padEnd(colWidth)).join("");
    console.log(header.trimEnd());
    for (const type of result.ingredientTypes) {
      const row = "  " + type.padEnd(typeColWidth) + result.targets.map((t) => {
        const cap = t.capabilities[type as IngredientType];
        return cap.state.padEnd(colWidth);
      }).join("");
      console.log(row.trimEnd());
    }
    console.log();

    // Legend
    console.log("  native       written in the tool's own place for that type, as the Forge holds it");
    console.log("  converted    written in another form — see its line below");
    console.log("  unsupported  not written; sync warns and names an ingredient aimed at this target");
    console.log();

    // Paths block — type-major (types outer, targets inner); align labels to widest
    console.log("paths");
    const pathLines: Array<{ label: string; content: string }> = [];
    for (const type of INGREDIENT_TYPES) {
      for (const t of result.targets) {
        const cap = t.capabilities[type as IngredientType];
        if (cap.output.length > 0) {
          const pathStr = cap.output.join(", ");
          const note = cap.note ? ` — ${cap.note}` : "";
          pathLines.push({ label: `${t.name} · ${type}`, content: `${pathStr}${note}` });
        }
      }
    }
    const maxLabelLen = Math.max(...pathLines.map((l) => l.label.length));
    for (const line of pathLines) {
      console.log(`  ${line.label.padEnd(maxLabelLen)}  ${line.content}`);
    }
    console.log();
    // Service line — text mode only (spec 31 §4.7: no JSON key, one line in the paths block)
    console.log("  service: written by sync under .craftar/ for no target; see craftar services");

    for (const w of warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
  });

/* ---------------------------------------------------------------- forge */
const forge = program.command("forge").description("Operate on the Forge itself rather than on a workspace");

forge
  .command("variants")
  .description("List ingredients that have variants, nearest first, with hunks counted by suggested class, and variants whose base is missing. Read-only")
  .option("--forge <dir>", "Forge directory (instead of --workspace)")
  .option("--workspace <dir>", "workspace whose craftar.yaml names the Forge (default: .)")
  .option("--json", "machine-readable output", false)
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .action(async (o) => {
    const f = await forgeFor(o);
    const report = await listVariants(f);
    if (o.json) return console.log(JSON.stringify(report, null, 2));
    console.log(pc.bold(`craftar forge variants — forge ${f.manifest.name} @ ${f.commit?.slice(0, 8) ?? "no git"}`));
    const { groups, orphans } = report;
    if (!groups.length && !orphans.length) return console.log("  no variants");
    for (const g of groups) {
      const count = `${g.variants.length} variant${g.variants.length > 1 ? "s" : ""}`;
      const detail = g.variants.map((v) => `${v.profile} (${describeDistance(v.distance)})${describeClasses(v.classes)}`).join(", ");
      console.log(`  ${g.base.padEnd(24)} ${count.padEnd(11)} ${detail}`);
    }
    for (const orphan of orphans) {
      console.log(`  ${orphan.ref.padEnd(24)} variant of ${orphan.missingBase}, which is not in this Forge`);
    }
    const total = groups.reduce((n, g) => n + g.variants.length, 0);
    const orphanNote = orphans.length ? `, ${orphans.length} orphan${orphans.length === 1 ? "" : "s"}` : "";
    console.log(
      `\n  ${groups.length} base${groups.length === 1 ? "" : "s"} with variants, ${total} variant${total === 1 ? "" : "s"} total${orphanNote}`,
    );
  });

forge
  .command("impact")
  .description(
    "List every workspace registered on this machine that reads this Forge — by its path, by a git remote of this clone, or through another clone of the same remote — with what its next sync would do against the Forge as it is now. Read-only; no fetch",
  )
  .option("--forge <dir>", "Forge directory (instead of --workspace)")
  .option("--workspace <dir>", "workspace whose craftar.yaml names the Forge (default: .)")
  .option("--json", "machine-readable output", false)
  .action(async (o) => {
    const f = await resolveForge({
      forge: o.forge,
      workspace: o.workspace,
      refuseRemote: (url) => `the Forge of this workspace is remote (${url}) — clone it and pass --forge <dir>`,
    });

    let fw;
    try {
      fw = await forgeWorkspaces(craftarHome(), f.root);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    warnStderr(fw.warnings);

    const planned = await planAll(fw.workspaces, f);
    const results = await Promise.all(planned.map((p) => nextSync(p)));

    // Refine the registry state: "partial" when any entry is missing or stage-config error (spec 25 §3)
    const registryState = refineRegistryState(fw.state, planned);

    if (o.json) {
      const workspaces = fw.workspaces.map((ws, i) => {
        const r = results[i];
        return {
          path: ws.entry.path,
          profile: ws.entry.profile,
          match: ws.match,
          via: ws.via,
          ref: ws.ref,
          state: r.state,
          counts: r.counts,
          error: r.error,
        };
      });
      console.log(JSON.stringify({ forge: fw.realForge, registry: registryState, workspaces }, null, 2));
      return;
    }

    // Text output
    const parts: string[] = [];
    const byMatch: Record<string, number> = {};
    for (const ws of fw.workspaces) byMatch[ws.match] = (byMatch[ws.match] ?? 0) + 1;
    if (byMatch.path) parts.push(`${byMatch.path} by path`);
    if (byMatch.remote) parts.push(`${byMatch.remote} by remote`);
    if (byMatch.clone) parts.push(`${byMatch.clone} by clone`);

    if (fw.state === "none") {
      console.log(`craftar forge impact — ${fw.realForge}`);
      console.log(`  no registered workspace reads this Forge on this machine`);
      return;
    }
    if (fw.state === "off") {
      console.log(`craftar forge impact — ${fw.realForge}`);
      console.log(`  the registry is off (CRAFTAR_NO_REGISTRY)`);
      return;
    }

    const n = fw.workspaces.length;
    console.log(
      `craftar forge impact — ${fw.realForge} · ${n} registered workspace${n === 1 ? "" : "s"} (${parts.join(", ")})`,
    );

    const maxPath = Math.max(...fw.workspaces.map((ws) => ws.entry.path.length));
    const maxProfile = Math.max(...fw.workspaces.map((ws) => ws.entry.profile.length));

    for (let i = 0; i < fw.workspaces.length; i++) {
      const ws = fw.workspaces[i];
      const r = results[i];

      let stateStr: string;
      if (r.state === "unchanged") {
        stateStr = "unchanged";
      } else if (r.state === "changed") {
        // Counts in NEXT_SYNC order
        const countParts = NEXT_SYNC_STATES.map((k) => (r.counts[k] ? `${r.counts[k]} ${k}` : "")).filter(Boolean);
        stateStr = countParts.join(", ");
      } else if (r.state === "missing") {
        stateStr = "missing";
      } else {
        stateStr = `error: ${r.error}`;
      }

      const suffix = matchSuffix(ws);
      console.log(`  ${ws.entry.path.padEnd(maxPath)}  ${ws.entry.profile.padEnd(maxProfile)}  ${stateStr}${suffix}`);
    }
  });

forge
  .command("diff")
  .description("Show the distance and the differences between a base ingredient and each of its variants, each hunk with a suggested class (evolution, value, block) that never decides anything. Read-only")
  .argument("<type/name>", "base ingredient (rule/workflow)")
  .option("--against <profile>", "only this profile's variant")
  .option("--forge <dir>", "Forge directory (instead of --workspace)")
  .option("--workspace <dir>", "workspace whose craftar.yaml names the Forge (default: .)")
  .option("--json", "machine-readable output", false)
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .action(async (ref: string, o) => {
    const f = await forgeFor(o);
    const base = f.ingredients.get(ref as IngredientRef);
    if (!base) fail(`${ref} is not an ingredient of this Forge`);
    const variants = [...f.ingredients.values()].filter((i) => {
      const profile = profileOf(i.meta);
      return (
        i.meta.type === base.meta.type &&
        i.meta.as === base.meta.name &&
        profile !== null &&
        (!o.against || profile === o.against)
      );
    }).sort((x, y) => x.ref.localeCompare(y.ref));
    if (!variants.length) fail(o.against ? `${ref} has no variant for profile ${o.against}` : `${ref} has no variants`);

    // The same distances `forge variants` reports, so both commands agree about a variant.
    const distances = new Map((await listVariants(f)).groups.flatMap((g) => g.variants.map((v) => [v.ref, v.distance] as const)));
    const report: Array<{ ref: IngredientRef; profile: string; distance: Distance; diff: IngredientDiff }> = [];
    for (const v of variants) {
      report.push({ ref: v.ref, profile: profileOf(v.meta)!, distance: distances.get(v.ref)!, diff: await diffIngredients(base, v) });
    }
    if (o.json) return console.log(JSON.stringify(report, null, 2));

    for (const r of report) {
      console.log(pc.bold(`${ref}  base ↔ ${r.profile} — ${describeDistance(r.distance)}`));
      for (const file of r.diff.files) {
        console.log(`  ${file.file}`);
        file.hunks.forEach((h, k) => {
          if (h.kind === "binary") {
            console.log(`    hunk ${k + 1}  [binary]  ${file.file} differs (not valid UTF-8 — bytes compared)`);
          } else {
            console.log(`    hunk ${k + 1}  [${h.kind}]  ${hunkAt(h)}  ${describeSuggestion(h.suggestion)}`);
            for (const line of h.a.lines) console.log(pc.red(`      - ${line}`));
            if (h.a.noEofNewline) console.log(pc.red(`      ${NO_EOF_NEWLINE_MARKER}`));
            for (const line of h.b.lines) console.log(pc.green(`      + ${line}`));
            if (h.b.noEofNewline) console.log(pc.green(`      ${NO_EOF_NEWLINE_MARKER}`));
          }
        });
      }
      for (const file of r.diff.onlyInBase) console.log(`  only in the base: ${file}`);
      for (const file of r.diff.onlyInVariant) console.log(`  only in the variant: ${file}`);
    }
  });

forge
  .command("unify")
  .description("Resolve one variant back into its base through a reviewable plan, taking each hunk from a side or turning it into a {{param}} or a section. Writes to the Forge")
  .argument("<type/name>", "base ingredient (rule/workflow)")
  .requiredOption("--profile <p>", "which variant to resolve")
  .option("--take <side>", "resolve every decision to base or variant")
  .option("--plan <file>", "apply the decisions in this plan file (a hunk may be take: param with its params list, or take: section with its section name)")
  .option("--save-plan <file>", "write a plan with every decision deferred, each hunk annotated with its suggested class (which --plan ignores), value hunks pre-filled with params, block hunks pre-filled with a section name, and hunks touching an existing section with its name, to a new file outside the Forge, and stop")
  .option("--no-impact", "skip planning the registered workspaces of this Forge before and after the writes (the warnings then keep their previous text)")
  .option("--prune-recipes", "delete each suffixed recipe the cascade leaves identical to its sibling and repoint the profiles that name it — only when every workspace registered on this machine plans byte for byte the same; needs the impact passes")
  .option("--forge <dir>", "Forge directory (instead of --workspace)")
  .option("--workspace <dir>", "workspace whose craftar.yaml names the Forge (default: .)")
  .option("--json", "machine-readable output", false)
  .action(async (ref: string, o) => {
    // Spec 25 §4.4: --prune-recipes with --no-impact is refused before anything is read
    if (o.pruneRecipes && !o.impact) {
      fail("--prune-recipes needs the impact passes — drop --no-impact");
    }

    const frontEnds = [o.take, o.plan, o.savePlan].filter((v) => v !== undefined);
    if (frontEnds.length !== 1) fail("pass exactly one of --take, --plan or --save-plan");
    if (o.take !== undefined && o.take !== "base" && o.take !== "variant") fail(`--take must be "base" or "variant"`);

    // Never through the cache: the URL form is refused by refuseRemote and the directory form by assertNotCacheTree;
    // a tree there is clean and tracked, so gitUnheld would pass and the edit would be lost at the next cleanup without reaching the remote (spec 13 §4.4).
    const f = await resolveForge({
      forge: o.forge,
      workspace: o.workspace,
      refuseRemote: (url) => `the Forge of this workspace is remote (${url}) — clone it and pass --forge <dir>`,
    });
    const base = f.ingredients.get(ref as IngredientRef);
    if (!base) fail(`${ref} is not an ingredient of this Forge`);
    const variant = [...f.ingredients.values()].find((i) => {
      const p = profileOf(i.meta);
      return i.meta.type === base.meta.type && i.meta.as === base.meta.name && p === o.profile;
    });
    if (!variant) fail(`${ref} has no variant for profile ${o.profile}`);

    // Only when about to write — --save-plan touches nothing inside the Forge, so it is exempt.
    if (!o.savePlan) {
      await assertNotCacheTree(f.root, craftarHome()).catch((e) => fail(e instanceof Error ? e.message : String(e)));
      if (f.commit === null) {
        // `gitHead` (and so `f.commit`) is also `null` for a real git repo with no commits yet —
        // that is not "not a git repository" (Ruling 22), so tell the two apart before wording it.
        if (await gitIsRepo(f.root)) {
          fail(`${f.root} has no commits yet — unify writes to the Forge and needs git as the undo`);
        }
        fail(`${f.root} is not a git repository — unify writes to the Forge and needs git as the undo`);
      }
      if (await gitDirty(f.root)) fail(`${f.root} is not a clean git checkout — commit or stash your changes first`);
    }

    let loadedPlan: UnifyPlan | undefined;
    if (o.plan) {
      let parsed: unknown;
      try {
        parsed = parseYamlText(o.plan, await fs.readFile(o.plan, "utf8"));
      } catch (e) {
        fail(e instanceof YamlSyntaxError ? e.message : `${o.plan}: ${errorText(e)}`);
      }
      try {
        loadedPlan = UnifyPlanSchema.parse(parsed);
      } catch (e) {
        fail(`${o.plan}: ${errorText(e)}`);
      }
      // The plan must be for this exact invocation (Ruling 23) — checked before staleness, so a
      // right-ingredient-wrong-profile plan is named for what it is rather than misdiagnosed as
      // "stale" (its fingerprints may well still match; they were never for this profile).
      if (loadedPlan.base !== base.ref || loadedPlan.variant !== variant.ref || loadedPlan.profile !== o.profile) {
        fail(`the plan is for ${loadedPlan.base} (profile ${loadedPlan.profile}), not ${ref} (profile ${o.profile})`);
      }
      const [baseFp, variantFp] = await Promise.all([fingerprintDir(base.dir), fingerprintDir(variant.dir)]);
      if (loadedPlan.baseFingerprint !== baseFp) fail(`the plan is stale: the base changed since it was saved`);
      if (loadedPlan.variantFingerprint !== variantFp) fail(`the plan is stale: the variant changed since it was saved`);
    }

    const diff = await diffIngredients(base, variant);

    if (o.savePlan) {
      // Ruling 30: --save-plan skips the clean-tree check because the plan lives outside the
      // Forge — so that is enforced, not assumed, and a plan never overwrites anything. Both
      // refusals come before any write; the comparison runs on real paths, so neither a `..`
      // segment nor a symlink can carry the target back into the Forge.
      const savePlanAbs = await gateOutsideForge(o.savePlan, f.root, SAVE_PLAN_GATE);
      const saved = await planFrom(base, variant, diff, o.profile, f.manifest.schema);
      await fs.mkdir(path.dirname(savePlanAbs), { recursive: true });
      await fs.writeFile(savePlanAbs, YAML.stringify(saved), { flag: "wx" });
      const deferred = saved.files.reduce((n: number, pf) => n + (pf.hunks ? pf.hunks.length : 1), 0);
      if (o.json) {
        console.log(JSON.stringify({ base: base.ref, profile: o.profile, plan: o.savePlan, unresolved: deferred }, null, 2));
      } else {
        console.log(pc.bold(`craftar forge unify ${ref} ↔ ${o.profile}`));
        console.log(`  wrote plan ${o.savePlan} — ${deferred} decision(s) deferred`);
      }
      return;
    }

    let toApply: UnifyPlan;
    if (loadedPlan) {
      toApply = loadedPlan;
    } else {
      toApply = await planFrom(base, variant, diff, o.profile, f.manifest.schema);
      const side = o.take as Take;
      for (const pf of toApply.files) {
        if (pf.hunks) for (const h of pf.hunks) h.take = side;
        else pf.take = side;
      }
    }

    // Get the profile's current sections for the base's key (spec 12 §6.5).
    const baseKey = sectionKey(base.meta);
    const profileSections = (() => {
      const p = f.profiles.get(o.profile);
      return p && Object.hasOwn(p.sections, baseKey) ? p.sections[baseKey] : {};
    })();

    const result = await applyPlan(base, variant, diff, toApply, { discardVariantMeta: o.take === "base", profileSections, forgeSchema: f.manifest.schema });
    // Ruling 33, dry pass: every recipe `ingredients` rewrite the cascade will make is checked before
    // the first byte is written, so a refusal (an aliased reference) leaves the Forge untouched.
    const cascadeFiles = result.resolved ? await checkRecipeCascade(f, base.ref, variant.ref) : [];
    // Spec 25 §4.4: prune candidates, computed in the dry pass
    // Spec 33 §4.4: pruneCandidates warns once per profile whose block cannot be read
    const pruneWarnings: string[] = [];
    const candidates: PruneCandidate[] = o.pruneRecipes && result.resolved
      ? await pruneCandidates(f, base.ref, variant.ref, o.profile, (w) => pruneWarnings.push(w))
      : [];
    // Spec 09 & 12: the Forge-level rows and YAML edits for parameter and section extractions, rendered before any write.
    const paramWrites = result.params.length || result.sections.length
      ? await checkParamWrites(f, base, variant, o.profile, result.params, result.sections)
      : null;

    // Ruling 37: "git is the undo" only holds for files git actually has. The whole-repo clean
    // check above cannot see ignored files (a Forge its enclosing repo ignores, an ignored file in
    // a variant) nor untracked ones under `status.showUntrackedFiles=no` — so every path this run
    // will overwrite or delete is checked on its own, before the first write.
    // Spec 25 §4.4: prune candidates' profile files join mustHold
    const candidateProfiles = candidates.flatMap((c) => c.profiles.map((p) => p.abs));
    const mustHold = [base.dir, ...(result.resolved ? [variant.dir, ...cascadeFiles] : []), ...(paramWrites?.mustHold ?? []), ...candidateProfiles];
    const unheld = await gitUnheld(f.root, mustHold);
    if (unheld.length) {
      fail(unheldMessage("unify", f.root, unheld));
    }

    // Spec 25 §4.2: the impact passes around the writes
    type ImpactRegistryState = RegistryState | "skipped" | "unreadable";
    let impactState: ImpactRegistryState = "skipped";
    let impactEntries: ForgeWorkspace[] = [];
    let impactBefore: Planned[] = [];
    let impactWarnings: string[] = [];
    let impactUnreadableReason: string | null = null;

    if (o.impact) {
      try {
        const fw = await forgeWorkspaces(craftarHome(), f.root);
        impactEntries = fw.workspaces;
        impactWarnings = fw.warnings;
        impactBefore = await planAll(fw.workspaces, f);
        // Refine the state: "partial" when any before entry is missing or stage-config error
        impactState = refineRegistryState(fw.state, impactBefore);
      } catch (e) {
        impactState = "unreadable";
        impactUnreadableReason = e instanceof Error ? e.message : String(e);
      }
    }

    // Order: merged files, then the recipe cascade, then removal of the variant directory
    // (Ruling 21) — a late failure leaves the variant in place, never a recipe naming a removed ingredient.
    // Spec 12 §6.7: the manifest is first when it moves to schema: 2; each prefix is emission-neutral.
    const journal: WriteJournal = [];
    let touched: string[] = [];
    let cascade: RecipeCascadeResult = { rewritten: [], identicalToSibling: [] };
    let variantRemoved: string | null = null;
    try {
      // Spec 12 §6.7 step 1: the manifest (schema: 2), FIRST when it needs to move.
      if (paramWrites?.manifest) await writeParamFile(paramWrites.manifest, journal);
      // Spec 09 §6.5 / Spec 12 §6.7 step 2: declarations, then the template, then the profile's values — each prefix emission-neutral.
      if (paramWrites?.ingredientYaml) await writeParamFile(paramWrites.ingredientYaml, journal);
      touched = await writeUnified(base, result, journal);
      if (paramWrites?.ingredientYaml) touched = [...touched, "ingredient.yaml"].sort();
      if (paramWrites?.profile) await writeParamFile(paramWrites.profile, journal);
      if (result.resolved) {
        cascade = await rewriteRecipes(f, base.ref, variant.ref, o.profile, journal);
        journal.push({ abs: variant.dir, created: false });
        await fs.rm(variant.dir, { recursive: true, force: true });
        variantRemoved = variant.ref;
      }
    } catch (e) {
      // What the dry pass cannot foresee (an I/O error, a file locked on Windows) fails here, after
      // writing began: name what was touched and how git undoes it, and still exit 1.
      throw new Error(lateFailure(e, f.root, journal), { cause: e });
    }

    // Spec 25 §4.2: after pass — planAll against the Forge as unify left it, then impactOf per entry
    let impactAfter: Planned[] = [];
    let impactResults: ImpactResult[] = [];
    if (o.impact && impactState !== "skipped" && impactState !== "unreadable" && impactEntries.length > 0) {
      let afterForge = f;
      try {
        afterForge = await loadForge(f.root);
      } catch (e) {
        // If loadForge fails, treat every entry as error with the actual message
        const msg = e instanceof Error ? e.message : String(e);
        for (let i = 0; i < impactEntries.length; i++) {
          impactAfter.push({ kind: "error", stage: "plan", message: msg });
        }
      }
      if (impactAfter.length === 0) {
        impactAfter = await planAll(impactEntries, afterForge);
      }
      for (let i = 0; i < impactEntries.length; i++) {
        impactResults.push(impactOf(impactBefore[i], impactAfter[i]));
      }
    }

    // Spec 25 §4.4: prune step — after unify's writes and the after pass, prove and apply prunes
    let pruneResult: PruneResult = { pruned: [], kept: [] };
    if (o.pruneRecipes && candidates.length > 0) {
      // Map the state: "skipped" cannot happen here (--prune-recipes requires --impact)
      const pruneState = impactState === "unreadable" ? "unreadable" : impactState as "read" | "partial" | "none" | "off";
      try {
        pruneResult = await pruneRecipes(f.root, candidates, {
          state: pruneState,
          entries: impactEntries,
          after: impactAfter,
        });
      } catch (e) {
        // A throw in pruneRecipes (e.g. a profile edit that fails to re-parse) after unify's writes: name what was touched.
        throw new Error(lateFailure(e, f.root, journal), { cause: e });
      }

      // Apply the prune writes
      for (const p of pruneResult.pruned) {
        try {
          // Write profile files first, then delete the recipe file
          for (const w of p.writes) {
            if (w.content !== null) {
              await note(journal, w.abs);
              await fs.writeFile(w.abs, w.content);
            } else {
              journal.push({ abs: w.abs, created: false });
              await fs.rm(w.abs, { force: true });
            }
          }
        } catch (e) {
          throw new Error(lateFailure(e, f.root, journal), { cause: e });
        }
      }
    }

    // Ruling 28: a metadata difference leaves the variant in place; say which fields and why.
    const warnings: string[] = [];

    // Spec 25 §4.2: warning for unreadable registry
    if (impactUnreadableReason !== null) {
      warnings.push(`the registry could not be read (${impactUnreadableReason}) — no workspace was checked`);
    }
    // Spec 25 §4.2: push warnings from forgeWorkspaces (credential lines)
    warnings.push(...impactWarnings);
    // Spec 33 §4.4: push warnings from pruneCandidates (malformed blocks)
    warnings.push(...pruneWarnings);

    if (result.metaDiffers.length) {
      warnings.push(
        `ingredient.yaml differs in ${result.metaDiffers.join(", ")} — unify cannot merge ingredient.yaml, so ${variant.ref} stays; ` +
          `resolve it by hand, or use --take base to discard the variant`,
      );
      // Spec 34 §5.2: the variant kept for its missing `params` holds the braces a workspace wrote.
      if (rendersServers(f.manifest) && holdsBaseCitations(base.meta, variant.meta)) {
        warnings.push(
          `${variant.ref} holds its server as a workspace wrote it; discarding it, or giving it the base's params, can make the next sync render those params into that workspace's MCP files`,
        );
      }
    }
    // Ruling 42: a suffixed recipe left identical to its sibling is reported, never deleted — a
    // workspace's recipes.add or an extends chain may name the sibling, and removing the suffixed
    // one would shift recipe order or param precedence there.
    // Spec 25 §4.4: only printed for candidates NOT pruned; without --prune-recipes, ends with a hint
    const suffix = `--${o.profile}`;
    const prunedRecipes = new Set(pruneResult.pruned.map((p) => p.recipe));
    for (const rn of cascade.identicalToSibling) {
      // Skip if this was pruned
      if (prunedRecipes.has(rn)) continue;
      const sibling = rn.slice(0, -suffix.length);
      const baseText =
        `recipe ${rn} is now identical to ${sibling} — it can be removed by hand after repointing the profiles, extends and ` +
        `workspace recipes lists that name it; unify does not, because a workspace or an extends chain may also name ` +
        `${sibling} and the recipe order or param precedence would change`;
      // Without --prune-recipes: add the hint to rerun with it
      const warning = o.pruneRecipes
        ? baseText
        : `${baseText} — or restore the Forge with git and rerun this unify with --prune-recipes`;
      warnings.push(warning);
    }

    // Spec 25 §4.3: helper to build conditional warnings based on registry state and concerned workspaces
    const unchecked = impactBefore.filter(
      (p) => p.kind === "missing" || (p.kind === "error" && p.stage === "config"),
    ).length;

    const reach = (text: string, test: (doc: unknown) => boolean): string | null => {
      // --no-impact → today's text
      if (!o.impact) return `${text}; unify cannot reach workspaces`;

      const c = concerned(impactBefore, impactEntries, test);

      // concerned non-empty → name them
      if (c.concerned.length > 0) {
        const names = c.concerned.map((w) => `${w.path} (${w.file})`).join(", ");
        const uncheckedNote = c.unchecked > 0 ? ` (the registry could not check ${c.unchecked} workspace${c.unchecked > 1 ? "s" : ""})` : "";
        return `${text} — concerned: ${names}${uncheckedNote}`;
      }

      // none concerned and registry state read → no warning
      if (impactState === "read") return null;

      // otherwise → today's text plus suffix by state
      let stateSuffix: string;
      switch (impactState) {
        case "partial":
          stateSuffix = ` (the registry could not check ${unchecked} workspace${unchecked > 1 ? "s" : ""})`;
          break;
        case "none":
          stateSuffix = " (no workspace of this Forge is registered on this machine)";
          break;
        case "off":
          stateSuffix = " (the registry is off)";
          break;
        case "unreadable":
          stateSuffix = " (the registry could not be read)";
          break;
        default:
          stateSuffix = "";
      }
      return `${text}; unify cannot reach workspaces${stateSuffix}`;
    };

    // Spec 09 W1: a new parameter may override a workspace's overrides.params
    for (const e of result.params.filter((p) => !p.reused)) {
      const text =
        `${e.key} is now a parameter of ${base.ref} — a workspace that sets overrides.params.${e.key} (craftar.yaml or ` +
        `craftar.local.yaml) now overrides ${base.ref} too`;
      const testW1 = (doc: unknown): boolean => {
        if (typeof doc !== "object" || doc === null) return false;
        const d = doc as Record<string, unknown>;
        if (typeof d.overrides !== "object" || d.overrides === null) return false;
        const ov = d.overrides as Record<string, unknown>;
        if (typeof ov.params !== "object" || ov.params === null) return false;
        return Object.hasOwn(ov.params, e.key);
      };
      const warn = reach(text, testW1);
      if (warn !== null) warnings.push(warn);
    }

    // Spec 12 W3: a new section may be filled by a workspace's overrides.sections
    for (const s of result.sections.filter((sec) => !sec.existing)) {
      const text =
        `${s.name} is now a section of ${base.ref} — a workspace that sets overrides.sections.${s.key}.${s.name} (craftar.yaml or ` +
        `craftar.local.yaml) now applies there`;
      const testW3 = (doc: unknown): boolean => {
        if (typeof doc !== "object" || doc === null) return false;
        const d = doc as Record<string, unknown>;
        if (typeof d.overrides !== "object" || d.overrides === null) return false;
        const ov = d.overrides as Record<string, unknown>;
        if (typeof ov.sections !== "object" || ov.sections === null) return false;
        const sec = ov.sections as Record<string, unknown>;
        if (!Object.hasOwn(sec, s.key)) return false;
        const keyObj = sec[s.key];
        if (typeof keyObj !== "object" || keyObj === null) return false;
        return Object.hasOwn(keyObj, s.name);
      };
      const warn = reach(text, testW3);
      if (warn !== null) warnings.push(warn);
    }

    // Ruling 38: a removed variant may be disabled by a workspace's overrides.ingredients.disable
    if (variantRemoved) {
      const text =
        `${variant.ref} was removed — a workspace that disables it in overrides.ingredients.disable (craftar.yaml or craftar.local.yaml) ` +
        `must now name ${base.ref}, or the base comes back enabled`;
      const testDisable = (doc: unknown): boolean => {
        if (typeof doc !== "object" || doc === null) return false;
        const d = doc as Record<string, unknown>;
        if (typeof d.overrides !== "object" || d.overrides === null) return false;
        const ov = d.overrides as Record<string, unknown>;
        if (typeof ov.ingredients !== "object" || ov.ingredients === null) return false;
        const ing = ov.ingredients as Record<string, unknown>;
        if (!Array.isArray(ing.disable)) return false;
        return ing.disable.includes(variant.ref);
      };
      const warn = reach(text, testDisable);
      if (warn !== null) warnings.push(warn);
    }

    // Spec 25 §4.4: when at least one recipe was pruned, add coverage warning
    if (pruneResult.pruned.length > 0) {
      const n = impactEntries.length;
      warnings.push(
        `pruned against the ${n} workspace${n === 1 ? "" : "s"} registered on this machine — a workspace synced elsewhere (CI, another machine, CRAFTAR_NO_REGISTRY) is not covered`,
      );
    }

    if (o.json) {
      // Spec 25 §4.2: impact array in JSON output
      const impact = impactResults.map((r, i) => ({
        path: impactEntries[i].entry.path,
        profile: impactEntries[i].entry.profile,
        match: impactEntries[i].match,
        via: impactEntries[i].via,
        ref: impactEntries[i].ref,
        state: r.state,
        files: r.files,
        error: r.error,
      }));

      return console.log(
        JSON.stringify(
          {
            base: base.ref,
            profile: o.profile,
            resolved: result.resolved,
            written: [...Object.keys(result.write), ...(paramWrites?.ingredientYaml ? ["ingredient.yaml"] : [])].sort(),
            removed: [...result.remove].sort(),
            unresolved: result.unresolved,
            variantRemoved,
            // Ruling 35: every key is always present, `[]` when empty — a stable shape, so no
            // consumer has to test whether a key exists.
            recipes: {
              rewritten: cascade.rewritten,
              identicalToSibling: cascade.identicalToSibling,
              pruned: pruneResult.pruned.map((p) => ({ recipe: p.recipe, sibling: p.sibling, profiles: p.profiles })),
              kept: pruneResult.kept,
            },
            metaDiffers: result.metaDiffers,
            // Spec 09 §4.5: only what this run wrote — [] when every key was already declared and valued.
            params: result.params.filter((e) => paramWrites?.written.includes(e.key)).map((e) => ({ key: e.key, default: e.default, value: e.value })),
            // Spec 12 §4.5: sections with line counts; [] when no section hunk.
            sections: result.sections.map((s) => ({
              key: s.key,
              name: s.name,
              file: s.file,
              existing: s.existing,
              defaultLines: s.default === null ? null : numLines(s.default),
              valueLines: numLines(s.value),
              written: paramWrites?.sectionsWritten.includes(s.name) ?? false,
            })),
            manifestEdited: paramWrites?.manifest !== null && paramWrites?.manifest !== undefined,
            profileEdited: paramWrites?.profile ? path.relative(f.root, paramWrites.profile.abs).split(path.sep).join("/") : null,
            warnings,
            // Spec 25 §4.2: always present, [] when no workspace was checked
            impact,
          },
          null,
          2,
        ),
      );
    }

    console.log(pc.bold(`craftar forge unify ${ref} ↔ ${o.profile}`));
    // Spec 12 §4.4: manifest line first, if edited
    if (paramWrites?.manifest) console.log(`  forge craftar.forge.yaml edited (schema: 2)`);
    for (const p of touched) console.log(`  ${result.write[p] !== undefined || p === "ingredient.yaml" ? pc.green("~") : pc.magenta("-")} ${p}`);
    for (const e of result.params) {
      const line = `param ${e.key} — default ${JSON.stringify(e.default)} (${base.ref}) · ${JSON.stringify(e.value)} (profile ${o.profile})`;
      // Same filter as --json params: a key already declared and valued is named as such, not as written.
      console.log(`  ${line}${paramWrites?.written.includes(e.key) ? "" : " — already in place"}`);
    }
    // Spec 12 §4.4: one line per section, after the params
    for (const s of result.sections) {
      const defCount = s.existing ? "existing" : `default ${lineCount(s.default!)} (${base.ref})`;
      const valCount = `${lineCount(s.value)} (profile ${o.profile})`;
      const inPlace = paramWrites?.sectionsWritten.includes(s.name) ? "" : " — already in place";
      console.log(`  section ${s.key} ${s.name} — ${defCount} · ${valCount}${inPlace}`);
    }
    if (paramWrites?.profile) console.log(`  ${pc.green("~")} ${path.relative(f.root, paramWrites.profile.abs).split(path.sep).join("/")}`);
    console.log(`  resolved ${result.resolved ? pc.green("yes") : pc.yellow("no")} · unresolved ${result.unresolved}`);
    if (variantRemoved) console.log(`  ${pc.magenta("removed variant")} ${variantRemoved}`);
    if (cascade.rewritten.length) console.log(`  recipes rewritten: ${cascade.rewritten.join(", ")}`);
    if (cascade.identicalToSibling.length) {
      console.log(`  recipes now identical to a sibling: ${cascade.identicalToSibling.join(", ")}`);
    }
    // Spec 25 §4.4: pruned and kept recipes, after the identical-to-sibling line
    for (const p of pruneResult.pruned) {
      console.log(`  pruned recipe ${p.recipe} → ${p.sibling} (${p.profiles.join(", ")})`);
    }
    for (const k of pruneResult.kept) {
      console.log(`  kept recipe ${k.recipe} — ${k.reason}`);
    }
    for (const w of warnings) console.log(`  ${pc.yellow("warn")} ${w}`);

    // Spec 25 §4.2: impact lines, one per workspace, with suffix format
    for (let i = 0; i < impactResults.length; i++) {
      console.log(`  ${impactLine(impactEntries[i], impactResults[i])}`);
    }

    // Spec 25 §4.2: the next: hint is printed only when no workspace was checked
    // (every entry missing/stage-config error, or no entries, or --no-impact, or unreadable)
    const someChecked = impactBefore.some(
      (p) => p.kind !== "missing" && !(p.kind === "error" && p.stage === "config"),
    );
    if (!someChecked) {
      console.log(`  next: run \`craftar status --workspace <dir>\` in a workspace on profile ${o.profile} to see what moved`);
    }
  });

forge
  .command("promote")
  .description(
    "Make a profile's variant the base: the base takes the variant's files, every other profile that resolves the old base gets it back as its own variant through a recipe it owns, and every profile is proved to resolve the same ingredients before anything is written. Writes to the Forge",
  )
  .argument("<type/name>", "base ingredient (rule/workflow)")
  .requiredOption("--profile <p>", "the profile whose variant becomes the base")
  .option("--forge <dir>", "Forge directory (instead of --workspace)")
  .option("--workspace <dir>", "workspace whose craftar.yaml names the Forge (default: .)")
  .option("--no-impact", "skip planning the registered workspaces of this Forge before and after the writes")
  .option("--dry-run", "run every check and the first impact pass, print what would be written, and write nothing", false)
  .option("--json", "machine-readable output", false)
  .action(async (ref: string, o) => {
    // Never through the cache, as `forge unify` (spec 13 §4.4): the URL form is refused by refuseRemote and the directory form by assertNotCacheTree.
    const f = await resolveForge({
      forge: o.forge,
      workspace: o.workspace,
      refuseRemote: (url) => `the Forge of this workspace is remote (${url}) — clone it and pass --forge <dir>`,
    });
    await assertNotCacheTree(f.root, craftarHome()).catch((e) => fail(e instanceof Error ? e.message : String(e)));
    // P2 (spec 29 §4.4): git is the undo, so it must be there, hold a commit and be clean — before anything is planned.
    if (f.commit === null) {
      if (await gitIsRepo(f.root)) fail(`${f.root} has no commits yet — forge promote writes to the Forge and needs git as the undo`);
      fail(`${f.root} is not a git repository — forge promote writes to the Forge and needs git as the undo`);
    }
    if (await gitDirty(f.root)) fail(`${f.root} is not a clean git checkout — commit or stash your changes first`);

    const promotion = await planBasePromotion(f, ref, o.profile);
    const forgeRel = (abs: string) => path.relative(f.root, abs).split(path.sep).join("/");
    // Every path overwritten or deleted must be held by git; a path created must not be one git ignores, or `git clean` would not undo it.
    const unheld = await gitUnheld(f.root, promotion.mustHold);
    for (const w of promotion.writes) {
      if (w.created && (await gitIgnored(f.root, forgeRel(w.abs)))) unheld.push({ path: forgeRel(w.abs), reason: "ignored" });
    }
    if (unheld.length) fail(unheldMessage("forge promote", f.root, unheld));
    await proveBasePromotion(f, promotion);

    // Spec 25 §4.2, as `forge unify`: the registered workspaces of this Forge, planned before and after the writes.
    type ImpactRegistryState = RegistryState | "skipped" | "unreadable";
    let impactState: ImpactRegistryState = "skipped";
    let impactEntries: ForgeWorkspace[] = [];
    let impactBefore: Planned[] = [];
    const warnings: string[] = [...promotion.warnings];
    if (o.impact) {
      try {
        const fw = await forgeWorkspaces(craftarHome(), f.root);
        impactEntries = fw.workspaces;
        warnings.push(...fw.warnings);
        impactBefore = await planAll(fw.workspaces, f);
        impactState = refineRegistryState(fw.state, impactBefore);
      } catch (e) {
        impactState = "unreadable";
        warnings.push(`the registry could not be read (${e instanceof Error ? e.message : String(e)}) — no workspace was checked`);
      }
      if (impactState === "off") warnings.push("the registry is off — no workspace was checked");
    }
    // The references the Forge cannot see (spec 29 §4.4): a workspace adding a shared recipe that names the base, removing
    // one this run copies for its profile, or disabling the base or the variant by name, follows the Forge at its next sync, not this promotion.
    const shared = [...f.recipes.values()].filter((r) => r.ingredients.includes(promotion.base) && !promotion.recipes.edited.includes(r.name)).map((r) => r.name);
    const byName = (doc: unknown, merged: unknown): boolean => {
      const d = (typeof doc === "object" && doc !== null ? doc : {}) as { recipes?: { add?: unknown; remove?: unknown }; overrides?: { ingredients?: { disable?: unknown } } };
      const m = (typeof merged === "object" && merged !== null ? merged : {}) as { profile?: string };
      const profile = typeof m.profile === "string" ? m.profile : "";
      const add = Array.isArray(d.recipes?.add) ? d.recipes.add : [];
      const remove = Array.isArray(d.recipes?.remove) ? d.recipes.remove : [];
      const disable = Array.isArray(d.overrides?.ingredients?.disable) ? d.overrides.ingredients.disable : [];
      // A removed recipe concerns this workspace only when the recipe was copied for its profile (removing one this run copies for its profile).
      return add.some((r) => shared.includes(r)) || remove.some((r) => promotion.recipes.created.some((c) => c.from === r && c.name === `${r}--${profile}`)) || disable.some((r) => r === promotion.base || r === promotion.removed);
    };
    for (const c of concerned(impactBefore, impactEntries, byName).concerned) {
      warnings.push(
        `${c.path} (${c.file}) adds or removes a recipe that names ${promotion.base}, or disables ${promotion.base} or ${promotion.removed}, by name — its next sync follows the Forge, not this promotion`,
      );
    }

    const journal: WriteJournal = [];
    if (!o.dryRun) {
      try {
        await applyBasePromotion(promotion, journal);
      } catch (e) {
        // After writing began: name what was touched and how git undoes it, and still exit 1.
        fail(lateFailure(e, f.root, journal, "forge promote"));
      }
    }

    const checked = impactState !== "skipped" && impactState !== "unreadable" && impactState !== "off";
    let impactResults: ImpactResult[] = [];
    if (!o.dryRun && checked && impactEntries.length > 0) {
      let impactAfter: Planned[];
      try {
        impactAfter = await planAll(impactEntries, await loadForge(f.root));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        impactAfter = impactEntries.map(() => ({ kind: "error", stage: "plan", message }));
      }
      impactResults = impactEntries.map((_, i) => impactOf(impactBefore[i], impactAfter[i]));
    }

    if (o.json) {
      return console.log(
        JSON.stringify(
          {
            base: promotion.base,
            profile: promotion.profile,
            dryRun: o.dryRun,
            removed: promotion.removed,
            // Every key is always present, `[]` when empty.
            created: promotion.created,
            recipes: promotion.recipes,
            profiles: promotion.profiles,
            impact: impactResults.map((r, i) => ({
              path: impactEntries[i].entry.path,
              profile: impactEntries[i].entry.profile,
              match: impactEntries[i].match,
              via: impactEntries[i].via,
              ref: impactEntries[i].ref,
              state: r.state,
              files: r.files,
              error: r.error,
            })),
            warnings,
          },
          null,
          2,
        ),
      );
    }

    const n = (count: number) => `${count} workspace(s)`;
    console.log(pc.bold(`craftar forge promote ${promotion.base} ← ${promotion.profile}${o.dryRun ? " (dry run — nothing written)" : ""}`));
    console.log(`  base     ${promotion.base} ${o.dryRun ? "would hold" : "now holds"} ${promotion.profile}'s text (was ${promotion.removed})`);
    for (const c of promotion.created) console.log(`  variant  ${c} ${o.dryRun ? "would be created" : "created"} (the old base)`);
    if (promotion.discarded) console.log(`  the old base is resolved by no profile — discarded (git holds it)`);
    const recipeLines = [...promotion.detail.recipes.filter((r) => r.from === null), ...promotion.detail.recipes.filter((r) => r.from !== null)];
    for (const r of recipeLines) console.log(`  recipe   ${r.name}${r.from === null ? "" : ` ${o.dryRun ? "would be created" : "created"} from ${r.from}`}: ${r.old} → ${r.new}`);
    for (const p of promotion.detail.profiles) console.log(`  profile  ${p.file}: ${p.swaps.map((s) => `${s.old} → ${s.new}`).join(", ")}`);
    for (const w of warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
    if (checked) {
      if (impactEntries.length === 0) console.log(`  impact   no workspace of this Forge is registered on this machine`);
      else if (o.dryRun) console.log(`  impact   ${n(impactEntries.length)} planned: not written, not compared`);
      else if (impactResults.every((r) => r.state === "no-effect")) console.log(`  impact   ${n(impactResults.length)} planned before and after: no effect`);
      else for (let i = 0; i < impactResults.length; i++) console.log(`  ${impactLine(impactEntries[i], impactResults[i])}`);
    }
    if (promotion.created.length) console.log(`  next     craftar forge variants — the old base now shows as ${promotion.created.length} variant(s) to unify`);
  });

/* ---------------------------------------------------------------- services ---------------------------------------------------------------- */
const services = program.command("services").description("Local services of this workspace: run Docker Compose on what craftar.lock records under .craftar/");

/** The workspace's lock, read without the Forge: these commands need no plan and no network (spec 31 §4.2). */
async function servicesContext(dir: string): Promise<{ root: string; real: string; recorded: Recorded }> {
  const { root, real } = await servicesBase(dir);
  return { root, real, recorded: await recordedServices(root, await readLock(root)) };
}

/** The base workspace info without the lock read — `down` catches the lock read separately. */
async function servicesBase(dir: string): Promise<{ root: string; real: string }> {
  const root = path.resolve(dir);
  if (!(await exists(path.join(root, WORKSPACE_FILE)))) fail(`no ${WORKSPACE_FILE} in ${root} — run craftar services inside a workspace, or pass --workspace <dir>`);
  return { root, real: await fs.realpath(root) };
}

/** Helper to get the .env file path if it exists, or null. */
async function envFileOrNull(root: string): Promise<string | null> {
  const env = path.join(root, ".env");
  return (await exists(env)) ? env : null;
}

/** Runs `docker compose` with the terminal's own streams and resolves with its exit code. No shell; `docker` is found as git and dotnet are. */
async function runCompose(argv: string[], real: string): Promise<number> {
  const { code } = await spawnInherited({ file: "docker", args: argv, cwd: process.cwd(), env: { ...process.env, CRAFTAR_WORKSPACE: real }, stdin: "inherit" });
  return code ?? 1;
}

services
  .command("up")
  .description("Start the services (docker compose up -d) — refused when a recorded file is missing or edited")
  .argument("[service...]", "Compose service names to start (default: all)")
  .option("--wait", "wait until the services are running or healthy", false)
  .option("--workspace <dir>", "workspace root", ".")
  .action(async (names: string[], o) => {
    try {
      const { root, real, recorded } = await servicesContext(o.workspace);
      const refusal = upRefusal(recorded, names);
      if (refusal.length) fail(refusal.join("\n"));
      const fault = dockerFault(await dockerVersion(dockerRunner), true);
      if (fault !== null) fail(fault);
      const argv = composeArgv("up", { project: projectName(real), stack: path.join(root, ".craftar", "compose.yaml"), envFile: await envFileOrNull(root), wait: o.wait, services: names });
      process.exitCode = await runCompose(argv, real);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  });

services
  .command("down")
  .description("Stop the services (docker compose down) — never refused on the files")
  .option("--volumes", "also remove the volumes the stack declares", false)
  .option("--workspace <dir>", "workspace root", ".")
  .action(async (o) => {
    try {
      const { root, real } = await servicesBase(o.workspace);
      // Try to read the lock — if it fails, warn and stop by name only
      let recorded: Recorded | null = null;
      try {
        recorded = await recordedServices(root, await readLock(root));
      } catch (e) {
        console.error(`${pc.yellow("warn")} ${errorText(e)}`);
      }
      const docker = await dockerVersion(dockerRunner);
      const fault = dockerFault(docker, false);
      if (fault !== null) fail(fault);
      // Use downArgv for the full decision — `-f` and `--env-file` only when lock was read and stack is usable
      const argv = downArgv(projectName(real), recorded, docker, path.join(root, ".craftar", "compose.yaml"), await envFileOrNull(root), o.volumes);
      process.exitCode = await runCompose(argv, real);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  });

services
  .command("status")
  .description("The declared services and their containers — reports, never refused on the files")
  .option("--json", "machine-readable output", false)
  .option("--workspace <dir>", "workspace root", ".")
  .action(async (o) => {
    try {
      const { real, recorded } = await servicesContext(o.workspace);
      const docker = await dockerVersion(dockerRunner);
      let ps: ReturnType<typeof readPs> | null = null;
      let psFault = dockerFault(docker, false);
      if (psFault === null) {
        const r = await dockerRunner("docker", composeArgv("ps", { project: projectName(real), stack: null, envFile: null }));
        if (r.code === 0) ps = readPs(r.stdout);
        else psFault = `docker compose ps failed — ${r.stderr.trim().split("\n")[0] || `exit ${r.code}`}`;
      }
      const report = servicesStatusReport(real, recorded, docker, ps, psFault);
      if (o.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(pc.bold(`craftar services — project ${report.project}`));
        if (report.services.length === 0) console.log("  no service declared");
        const w = Math.max(0, ...report.services.map((s) => s.name.length));
        for (const s of report.services) {
          const ports = s.ports.map((p) => `${p.host}:${p.container}/${p.protocol}`).join(", ");
          console.log(`  ${s.name.padEnd(w)}  ${s.ingredient ?? "(not declared)"}  ${s.state}${s.health ? ` (${s.health})` : ""}${ports ? `  ${ports}` : ""}`);
        }
        for (const p of report.pending) console.log(`  ${pc.yellow(pendingLine(p))}`);
        for (const x of report.warnings) console.error(`${pc.yellow("warn")} ${x}`);
      }
      if (psFault !== null) process.exitCode = 1;
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  });

/* ---------------------------------------------------------------- cache ---------------------------------------------------------------- */
const cache = program.command("cache").description("The per-machine Forge cache in $CRAFTAR_HOME/forges/");

cache
  .command("prune")
  .description(
    "Remove the Forge cache entries nothing uses — no registered workspace and not this one — the entries whose first fetch never completed, and trees unused for 14 days; --dry-run only shows. Never touches a workspace, a lock or the registry; no network",
  )
  // No commander default: an explicit --workspace without craftar.yaml exits 1, the current directory without one runs (spec 26 §4.1).
  .option("--dry-run", "show what would be removed; remove nothing", false)
  .option("--workspace <dir>", "the workspace whose Forge counts as used besides the registry (default: the current directory, when it holds craftar.yaml)")
  .option("--json", "machine-readable output", false)
  .action(async (o) => {
    let workspace: string | null = null;
    if (o.workspace !== undefined) {
      if (!(await exists(path.join(o.workspace, WORKSPACE_FILE))))
        fail(`no ${WORKSPACE_FILE} in ${path.resolve(o.workspace)} — run cache prune inside a workspace, or without --workspace`);
      workspace = o.workspace;
    } else if (await exists(path.join(process.cwd(), WORKSPACE_FILE))) workspace = process.cwd();

    const result = await pruneCache(craftarHome(), {
      dryRun: o.dryRun,
      workspace,
      registryOff: registryOff(),
    });

    if (o.json) console.log(JSON.stringify(result.report, null, 2));
    else printPrune(result);
  });

program.parseAsync().catch((e) => fail(errorText(e)));

/* ---------------------------------------------------------------- helpers */

/** The network rule of a command, `--offline`, and `$CRAFTAR_HOME` (spec 13 §4.1, §6.3). */
function load(o: { offline?: boolean }, mode: FetchMode): LoadOptions {
  return { mode, offline: o.offline === true, home: process.env.CRAFTAR_HOME || undefined };
}

/** A `forge` command's Forge; the warnings of reading a remote one go to stderr, so `--json` stays its shape. */
async function forgeFor(o: { forge?: string; workspace?: string; offline?: boolean }) {
  const { forge, workspace } = await resolveForgeSource({ forge: o.forge, workspace: o.workspace, ...load(o, "read") });
  warnStderr(workspace?.warnings ?? []);
  return forge;
}

/** A repeatable option's values, in the order given. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** `$CRAFTAR_HOME`, as the cache reads it (spec 13 §6.3). */
function craftarHome(): string {
  return resolveHome(process.env.CRAFTAR_HOME || undefined);
}

/** The text report of `craftar doctor` (spec 24 §4.4) — presentation, not contract. */
function printDoctor(r: DoctorReport): void {
  console.log(pc.bold(`craftar doctor — craftar ${r.version} · ${r.workspace ?? "no workspace (machine checks only)"}`));
  const paint = (l: string) => (l === "error" ? pc.red : l === "warn" ? pc.yellow : pc.dim)(l.padEnd(6));
  // A message that already ends in its fix (a refused schema says "— upgrade craftar") is not suffixed twice.
  const suffix = (c: DoctorReport["checks"][number]) => (c.fix && c.level !== "ok" && !c.message.endsWith(c.fix) ? ` — ${c.fix}` : "");
  for (const c of r.checks) console.log(`  ${paint(c.level)} ${c.id.padEnd(13)} ${c.message}${suffix(c)}`);
  console.log(`summary: ${r.summary.ok} ok, ${r.summary.warn} warn, ${r.summary.error} error`);
}

/** The text report of `craftar cache prune` (spec 26 §4.4) — presentation, not contract. */
function printPrune(result: CachePruneResult): void {
  const mb = (b: number) => `${(b / (1024 * 1024)).toFixed(1)} MB`;

  if (result.header === null) {
    console.log("nothing to prune");
    for (const w of result.report.warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
    return;
  }

  const { forges, entries, bytes } = result.header;
  console.log(pc.bold(`craftar cache prune — ${forges} (${entries} ${entries === 1 ? "entry" : "entries"}, ${mb(bytes)})`));

  // Compute label width: for entries/leftovers, just the key; for trees, `<key>/trees/<first 10 of commit>…`.
  const labelOf = (r: typeof result.report.removed[number] | typeof result.report.kept[number]): string => {
    const p = r.path;
    if ("kind" in r && r.kind === "tree") {
      // forges/<key>/trees/<commit> → <key>/trees/<commit10>…
      const parts = p.split("/");
      return `${parts[1]}/trees/${parts[3].slice(0, 10)}…`;
    }
    // forges/<key> or forges/~removing-<...> → last segment
    return p.split("/").pop()!;
  };

  const whyRemoved = (r: typeof result.report.removed[number]): string => {
    if (r.reason === "orphan") return "orphan: nothing names it";
    if (r.reason === "incomplete") return "incomplete: a fetch never completed";
    if (r.reason === "unused") return "unused for 14 days or more";
    return "leftover of an interrupted prune";
  };

  const whyKept = (k: typeof result.report.kept[number]): string => {
    if (k.reason === "named") return `named by ${k.namedBy.join(", ")}`;
    if (k.reason === "busy") return "in use";
    if (k.reason === "held-open") return "held open";
    return "not checked";
  };

  // Compute column widths W (label) and V (why) across removed and kept rows.
  const allLabels = [...result.report.removed, ...result.report.kept].map(labelOf);
  const removedWhys = result.report.removed.map(whyRemoved);
  const keptWhys = result.report.kept.map(whyKept);
  const W = Math.max(1, ...allLabels.map((l) => l.length));
  const V = Math.max(1, ...removedWhys.map((w) => w.length), ...keptWhys.map((w) => w.length));

  const verb = result.report.dryRun ? "would remove" : "removed";
  for (const r of result.report.removed) {
    console.log(`  ${verb.padEnd(12)} ${labelOf(r).padEnd(W)} ${whyRemoved(r).padEnd(V)} ${mb(r.bytes)}`);
  }

  for (const k of result.report.kept) {
    console.log(`  ${"kept".padEnd(12)} ${labelOf(k).padEnd(W)} ${whyKept(k)}`);
  }

  for (const w of result.report.warnings) {
    console.log(`  ${pc.yellow("warn")} ${w}`);
  }

  const freedVerb = result.report.dryRun ? "would free" : "freed";
  console.log(`${freedVerb} ${mb(result.report.freedBytes)}`);
}

/** `CRAFTAR_NO_REGISTRY` — "no registry", read like NO_COLOR: any non-empty value turns it off (spec 21 §4.1). */
function registryOff(): boolean {
  return Boolean(process.env.CRAFTAR_NO_REGISTRY);
}

/** `--port` as typed: digits only, 0 to 65535 — `0x10`, `1e3`, `+80` and `80.0` are not ports. */
function parsePort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null;
  const n = Number(text);
  return n <= 65535 ? n : null;
}

function registryGate(): void {
  if (registryOff()) fail("the workspace registry is off (CRAFTAR_NO_REGISTRY is set)");
}

const ROW_WORDS: Record<WorkspaceRow["status"], string> = {
  "up-to-date": "up to date",
  outdated: "outdated",
  drift: "drift",
  "no-lock": "no lock",
  missing: "missing",
  error: "error",
};

/** The text table of `craftar workspaces` (spec 21 §4.2) — presentation, not contract. */
function printWorkspaces(rows: WorkspaceRow[], warnings: string[], fetched: boolean): void {
  if (rows.length === 0) {
    console.log(pc.bold("craftar workspaces — no workspace registered (craftar sync registers one)"));
    return;
  }
  const offline = !fetched && rows.some((r) => r.forge.kind === "remote") ? " (status read offline from the Forge cache)" : "";
  console.log(pc.bold(`craftar workspaces — ${rows.length} registered${offline}`));
  const width = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    console.log(`  ${pc.cyan(r.name.padEnd(width))}  ${r.path}`);
    const stack = Object.entries(r.stack).map(([slot, recipe]) => `${slot}=${recipe}`);
    console.log(`      ${[`profile ${r.profile}`, ...(stack.length ? [stack.join(", ")] : []), ...(r.targets.length ? [r.targets.join(", ")] : [])].join(" · ")}`);
    const synced = `synced ${r.lastSync.slice(0, 16).replace("T", " ")} UTC`;
    const word = ROW_WORDS[r.status] + (r.forgeMoved ? ", forge moved" : "");
    const painted = r.status === "drift" || r.status === "error" || r.status === "missing" ? pc.red(word) : r.status === "up-to-date" ? pc.dim(word) : pc.yellow(word);
    if (r.status === "missing" || r.status === "error") {
      console.log(`      ${synced} · ${painted}`);
      continue;
    }
    const f = r.forge;
    const at = f.kind === "remote" ? `${f.ref ?? `${f.defaultBranch} (default branch)`} ${f.commit?.slice(0, 8) ?? "no git"}` : (f.commit?.slice(0, 8) ?? "no git");
    console.log(`      forge ${f.source}${f.fromLocalFile ? " (local override)" : ""} @ ${at} · ${synced} · ${painted}`);
  }
  for (const w of warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
}

/** Warnings of loading the workspace, for commands whose stdout is not a report (a diff, `explain`, `ls`, `--json`). */
function warnStderr(warnings: string[]): void {
  for (const w of warnings) console.error(`${pc.yellow("warn")} ${w}`);
}

/** One workspace's line after a Forge write was planned before and after (spec 25 §4.2) — `forge unify` and `forge promote` print the same. */
function impactLine(ws: ForgeWorkspace, r: ImpactResult): string {
  let state: string;
  if (r.state === "no-effect") state = "no effect";
  else if (r.state === "changed") state = r.files.length === 1 ? `1 file changes — ${r.files[0]}` : `${r.files.length} files change — ${r.files.join(", ")}`;
  else if (r.state === "missing") state = "missing";
  else state = `error: ${r.error}`;
  return `impact: ${ws.entry.path} (${ws.entry.profile}) ${state}${matchSuffix(ws)}`;
}

/**
 * Spec 25 §4.1–§4.2: the suffix format for a workspace that is not a path match.
 * Used by both `forge impact` and `forge unify` so the format is shared.
 */
function matchSuffix(ws: ForgeWorkspace): string {
  let suffix = "";
  if (ws.match === "remote") suffix = ` · after push (${ws.via})`;
  if (ws.match === "clone") suffix = ` · after push and pull (${ws.via})`;
  if (ws.ref) suffix += `, pins ${ws.ref}`;
  return suffix;
}

/** One line on stderr with the `error: ` prefix, without exiting — `fail()` is this, then exit 1. */
function errorLine(msg: string): void {
  console.error(pc.red("error: ") + msg);
}

function fail(msg: string): never {
  errorLine(msg);
  process.exit(1);
}

function printStatus(st: FileStatus[], warnings: string[], profile: string, recipes: string[], compact = false, forge: string | null = null) {
  const counts: Record<string, number> = {};
  for (const s of st) counts[s.state] = (counts[s.state] ?? 0) + 1;
  console.log(pc.bold(`craftar status — profile ${profile} · recipes ${recipes.join(" → ")}`));
  if (forge) console.log(forge);
  console.log(
    "  " +
      Object.entries(counts)
        .map(([k, v]) => `${color(k)(k)} ${v}`)
        .join("  "),
  );
  for (const s of st) {
    if (compact && s.state === "unchanged") continue;
    console.log(`  ${color(s.state)(s.state.padEnd(13))} ${s.path}${s.state === "unchanged" ? "" : "  " + pc.dim(s.ingredient ?? "")}`);
  }
  for (const w of warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
}

function color(state: string) {
  switch (state) {
    case "new":
    case "update":
      return pc.green;
    case "drift":
    case "orphan-drift":
      return pc.red;
    case "collision":
      return pc.yellow;
    case "orphan":
      return pc.magenta;
    case "adopt":
      return pc.cyan;
    default:
      return pc.dim;
  }
}
/**
 * The gate of a user-supplied output path (Ruling 30 of spec 06; spec 29 §4.2): the file a command writes where the
 * user says must lie outside the Forge and must not exist. Both sides are compared as real paths, so neither a `..`
 * segment nor a symlink can carry the target back into the Forge; the Forge side goes through its nearest existing
 * ancestor too, since `import --forge` may name a directory that does not exist yet. Returns the absolute target, or
 * fails before anything is written.
 */
async function gateOutsideForge(target: string, forgeRoot: string, w: OutputGate): Promise<string> {
  const refusing = `refusing to write the ${w.what} to ${target}`;
  const abs = path.resolve(target);
  let targetReal: string;
  let rootReal: string;
  try {
    targetReal = await realpathOfNearest(abs);
    rootReal = await realpathOfNearest(path.resolve(forgeRoot));
  } catch (e) {
    fail(`${refusing}: ${e instanceof Error ? e.message : String(e)} — ${w.who} cannot prove the target lies outside the Forge`);
  }
  const rel = path.relative(rootReal, targetReal);
  if (rel === "" || !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) {
    fail(`${refusing}: it resolves inside the Forge (${forgeRoot}) — ${w.outside}`);
  }
  if (await pathTaken(abs)) fail(`${refusing}: the file already exists — ${w.never}; choose a new path`);
  return abs;
}

/** Whether anything — a file, a directory, even a dangling symlink — already sits at `p`. */
async function pathTaken(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** The refusal message for paths git cannot restore (Ruling 37): the command name and every unheld path. */
function unheldMessage(command: string, root: string, unheld: UnheldPath[]): string {
  const SHOWN = 10;
  const lines = unheld.slice(0, SHOWN).map((u) => `  ${u.path} is not held by git (${u.reason})`);
  if (unheld.length > SHOWN) lines.push(`  … and ${unheld.length - SHOWN} more`);
  return `${command} can only change files git can restore — ${unheld.length} path(s) under ${root} are not:\n${lines.join("\n")}`;
}

/**
 * The message for a `forge unify` failure after writing began (Ruling 33): the original error, the
 * Forge-relative paths already touched, and the git commands that undo them — `checkout` for what
 * git tracks, `clean` for files unify created (checkout refuses a path git does not know).
 * For created paths, directories get `clean -fd`, files (or missing paths) get `clean -f`.
 */
function lateFailure(e: unknown, root: string, journal: WriteJournal, command = "unify"): string {
  const msg = errorText(e);
  if (journal.length === 0) return msg;
  const rel = (abs: string) => path.relative(root, abs).split(path.sep).join("/");
  const quote = (p: string) => (/^[\w./-]+$/.test(p) ? p : `"${p}"`);
  const restore = [...new Set(journal.filter((j) => !j.created).map((j) => rel(j.abs)))];
  const created = [...new Set(journal.filter((j) => j.created).map((j) => j.abs))];
  // For created paths, check if they are directories
  const createdDirs: string[] = [];
  const createdFiles: string[] = [];
  for (const abs of created) {
    try {
      const st = statSync(abs);
      if (st.isDirectory()) {
        createdDirs.push(rel(abs));
      } else {
        createdFiles.push(rel(abs));
      }
    } catch {
      // Path doesn't exist, treat as file
      createdFiles.push(rel(abs));
    }
  }
  const lines = [msg, `${command} had already started changing the Forge (${root}) when this failed:`];
  for (const p of [...restore, ...createdDirs, ...createdFiles]) lines.push(`  ${p}`);
  lines.push("recover with:");
  if (restore.length) lines.push(`  git -C ${quote(root)} checkout -- ${restore.map(quote).join(" ")}`);
  if (createdDirs.length) lines.push(`  git -C ${quote(root)} clean -fd -- ${createdDirs.map(quote).join(" ")}`);
  if (createdFiles.length) lines.push(`  git -C ${quote(root)} clean -f -- ${createdFiles.map(quote).join(" ")}`);
  return lines.join("\n");
}

/** ` [1 evolution · 2 block]` in the fixed class order, zero counts omitted; empty for a variant without hunks (spec 08 §4.2). */
function describeClasses(classes: Record<HunkClass, number>): string {
  const parts = HUNK_CLASSES.filter((c) => classes[c] > 0).map((c) => `${classes[c]} ${c}`);
  return parts.length ? ` [${parts.join(" · ")}]` : "";
}

/** `<class>: <reason>`, and ` → <params>` for a value (spec 08 §4.1). */
function describeSuggestion(s: HunkSuggestion): string {
  const params = s.tokens?.length ? ` → ${s.tokens.map((t) => t.param).join(", ")}` : "";
  return `${s.class}: ${s.reason}${params}`;
}

/** A section value as the import report shows it: `empty`, or its line count once canonical (spec 11 §4.3). */
function lineCount(value: string): string {
  const n = numLines(value);
  return n === 0 ? "empty" : `${n} line${n === 1 ? "" : "s"}`;
}

/** Numeric line count of a canonical section value, for --json output. */
function numLines(value: string): number {
  return canonicalValue(value).split("\n").length - 1;
}

function describeDistance(d: Distance): string {
  if (d.identicalAfterNormalization) return "identical after normalization";
  if (d.sameBodyDifferentMeta) return "meta only";
  return `${d.lines} line${d.lines === 1 ? "" : "s"}, ${d.hunks} hunk${d.hunks === 1 ? "" : "s"}`;
}
