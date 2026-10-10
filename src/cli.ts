import { Command } from "commander";
import pc from "picocolors";
import path from "node:path";
import { promises as fs } from "node:fs";
import YAML from "yaml";
import { importClaudeCode } from "./importers/claude-code.js";
import { classifyForge } from "./core/remote.js";
import { forget, listWorkspaces, prune, register, registryFile, type WorkspaceRow } from "./core/registry.js";
import { forgeWorkspaces, planAll, nextSync, impactOf, concerned, refineRegistryState, countStates, NEXT_SYNC_STATES, type ForgeWorkspace, type RegistryState, type Planned, type ImpactResult } from "./core/impact.js";
import { runDoctor, type DoctorReport } from "./core/doctor.js";
import { pruneCache, type PruneResult as CachePruneResult } from "./core/cache.js";
import { resolveHome } from "./core/home-lock.js";
import { loadWorkspace, plan, readLock, status, apply, unsetDeclared, unsetRefusal, unsetRefused, resolveForge, resolveForgeSource, WORKSPACE_FILE, LOCAL_FILE, type ApplyResult, type FetchMode, type FileState, type FileStatus, type LoadOptions, type Plan, type SectionLayer, type UnsetParam, type Workspace } from "./core/sync.js";
import type { Lock } from "./schema/index.js";
import { resolve, sectionKey, type ParamLayer } from "./core/resolve.js";
import { catalogueContext, listRecipes, listIngredients, checkType, type CatalogueContext, type ContextSource } from "./core/catalogue.js";
import { listTargets } from "./core/capabilities.js";
import { canonicalValue } from "./core/sections.js";
import { renderDiff, NO_EOF_NEWLINE_MARKER } from "./core/diff.js";
import { renderImportReport } from "./core/import-report.js";
import { diffIngredients, listVariants, profileOf, type Distance, type IngredientDiff } from "./core/variants.js";
import { hashNormalized, toLf, stripBom } from "./core/text.js";
import { exists, gitDirty, gitIsRepo, gitUnheld, loadForge } from "./core/forge.js";
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
import { checkInitFlags, initLine, planInit, type InitInput } from "./core/init.js";
import { askInit, confirmInit, againLine, type InitAnswers } from "./core/init-flow.js";
import { readlineIo } from "./prompt.js";
import { editRecipesText, planRecipeEdit, recipeDiffLine, type RecipeOp } from "./core/recipe-edit.js";
import { localKeys, readLocalFile } from "./core/workspace-yaml.js";
import { HUNK_CLASSES, INGREDIENT_TYPES, UnifyPlanSchema, type HunkClass, type HunkSuggestion, type IngredientRef, type IngredientType, type Take, type Target, type UnifyPlan } from "./schema/index.js";
import { EXAMPLE_SETTINGS } from "./emitters/shared.js";
import { YamlSyntaxError, parseYamlText } from "./core/yaml-read.js";

process.stdout.on("error", (e: NodeJS.ErrnoException) => { if (e.code === "EPIPE") process.exit(0); });

/**
 * Q13-1, answered by the user (2026-10-07): with a remote Forge whose fetch fails, `diff --exit-code`
 * fails like `sync --check` — a CI gate does not pass against a stale cached copy. Plain `diff` still
 * reads the cached copy with a warning (spec 13 §4.1).
 */
const DIFF_EXIT_CODE_FETCH_MODE: FetchMode = "sync";

const program = new Command();
program.name("craftar").description("Craft, sync and convert AI-coding workspace harnesses.").version("0.21.0");

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
  .description("Import an existing workspace harness into a Forge: creates or updates ingredients, recipes and a profile, reusing a templated base when it renders the workspace text or infers it into params or sections")
  .requiredOption("--from <tool>", "source tool: claude-code")
  .requiredOption("--forge <dir>", "Forge directory (created if missing)")
  .requiredOption("--profile <name>", "client profile to create or update")
  .option("--workspace <dir>", "workspace to import", ".")
  .option("--write-config", "write craftar.yaml into the workspace, merging an existing one (forge, profile, targets)", false)
  .option(
    "--report <file.md>",
    "also write a Markdown report of the import — what was created, reused, made a variant or rejected, and the .kiro/ files that differ from what Craftar would generate (paths and line counts, never content); refused when the path is inside the Forge or already exists",
  )
  .action(async (o) => {
    if (o.from !== "claude-code") fail(`unsupported source "${o.from}" (only claude-code for now)`);
    // import writes a local Forge; a URL would become a directory named after it (spec 13 §4.4).
    if (classifyForge(o.forge) === "url") fail("--forge takes a directory; to read a remote Forge, run inside a workspace that names it");
    // Spec 29 §4.2: the report's path is refused before the import reads anything, so a refusal leaves the Forge untouched.
    const reportAbs = o.report === undefined ? null : await gateOutsideForge(o.report, o.forge, REPORT_GATE);
    const r = await importClaudeCode({ workspaceRoot: o.workspace, forgeRoot: o.forge, profileName: o.profile, writeWorkspaceConfig: o.writeConfig, report: reportAbs !== null });
    console.log(pc.bold(`Imported ${path.resolve(o.workspace)} → ${path.resolve(o.forge)} as profile "${r.profile}"`));
    console.log(
      `  ${pc.green(String(r.created.length))} created, ${pc.cyan(String(r.reused.length))} reused, ${pc.yellow(String(r.variants.length))} variants, ${pc.red(String(r.rejected.length))} rejected`,
    );
    for (const v of r.variants) console.log(`  ${pc.yellow("variant")} ${v.name} — ${v.reason}`);
    for (const x of r.rejected) console.log(`  ${pc.red("rejected")} ${x.name} — ${x.reason}`);
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
  .description("Show what sync would do: new, update, drift, orphan, collision; exits 1 when a declared parameter a file cites has no value")
  .option("--workspace <dir>", "workspace root", ".")
  .option("--json", "machine-readable output", false)
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .action(async (o) => {
    const ws = await loadWorkspace(o.workspace, load(o, "read"));
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const st = await status(ws, p, lock);
    const unset = unsetDeclared(p);
    if (o.json) {
      console.log(JSON.stringify({ forge: forgeJson(ws, lock), statuses: st.map(({ planned, ...s }) => s), warnings: p.warnings, unsetParams: unset }, null, 2));
      // exitCode, not process.exit: a piped object is not cut (spec 29 §4.1)
      if (unset.length) process.exitCode = 1;
      return;
    }
    printStatus(st, p.warnings, ws.config.profile, p.resolution.recipes, false, forgeLine(ws, lock));
    if (refusalBlock(unset)) process.exitCode = 1;
  });

/**
 * The refusal of spec 29 §4.1 for a command that goes on to print or exit by itself: the block on stderr, as
 * `fail()` would print it, without exiting. Says whether there was one.
 */
function refusalBlock(unset: UnsetParam[], opts: { thenSync?: boolean } = {}): boolean {
  if (unset.length) console.error(pc.red("error: ") + unsetRefusal(unset, opts));
  return unset.length > 0;
}

/**
 * A writing sync on a planned workspace, then its report: `apply`, the registration of spec 21 (unless
 * `CRAFTAR_NO_REGISTRY`), and the lines `sync` prints. `sync` and `init` both call it (spec 23 §5.2).
 */
async function applyAndReport(ws: Workspace, p: Plan, st: FileStatus[], lock: Lock | null, opts: { dryRun?: boolean; overwriteDrift?: boolean } = {}): Promise<ApplyResult> {
  const r = await apply(ws, p, st, opts);
  // A writing sync records the workspace (spec 21 §4.1); the registry is an index, so a failure is a warning.
  let registryWarning: string | null = null;
  if (!opts.dryRun && !registryOff()) {
    const home = craftarHome();
    try {
      await register(home, ws, p);
    } catch (e) {
      registryWarning = `registry not updated (${registryFile(home)}): ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const verb = opts.dryRun ? "would write" : "wrote";
  console.log(pc.bold(`craftar sync — profile ${ws.config.profile} · recipes ${p.resolution.recipes.join(" → ")} · targets ${p.resolution.targets.join(", ")}`));
  const fl = forgeLine(ws, lock);
  if (fl) console.log(fl);
  console.log(`  ${verb} ${pc.green(String(r.written.length))}, removed ${pc.magenta(String(r.removed.length))} orphan(s), skipped ${pc.yellow(String(r.skipped.length))}`);
  for (const f of r.written) console.log(`  ${pc.green("+")} ${f}`);
  for (const f of r.removed) console.log(`  ${pc.magenta("-")} ${f}  (orphan: no longer produced by the Forge)`);
  for (const s of r.skipped) console.log(`  ${pc.yellow("!")} ${s.path}  ${explainSkip(s)}`);
  for (const w of p.warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
  if (registryWarning) console.log(`  ${pc.yellow("warn")} ${registryWarning}`);
  return r;
}

/* ---------------------------------------------------------------- init */
program
  .command("init")
  .description(
    "Start a workspace from a Forge and a profile: write a craftar.yaml proved to resolve and plan, then run the first sync; in a terminal, asks for the Forge and the profile not given as flags; refused when craftar.yaml already exists",
  )
  .option("--forge <dir|url>", "the Forge: a directory (written relative to the workspace) or a git URL; asked for in a terminal when omitted")
  .option("--profile <name>", "the client profile in the Forge; asked for in a terminal when omitted")
  .option("--ref <ref>", "branch, tag or full SHA of a remote Forge")
  .option("--targets <a,b>", "targets to write in craftar.yaml (claude-code, kiro, agents-md); omitted, the workspace follows the profile's")
  .option("--add-recipe <name>", "add a recipe to the profile's (repeatable)", collect, [])
  .option("--remove-recipe <name>", "remove a recipe of the profile's (repeatable)", collect, [])
  .option("--replace", "let --add-recipe take a slot another recipe holds", false)
  .option("--no-sync", "write craftar.yaml only, and say what the first sync would do")
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .option("--workspace <dir>", "workspace root, created when missing", ".")
  .action(
    async (o: {
      forge?: string;
      profile?: string;
      ref?: string;
      targets?: string;
      addRecipe: string[];
      removeRecipe: string[];
      replace: boolean;
      sync: boolean;
      offline: boolean;
      workspace: string;
    }, cmd) => {
      const root = path.resolve(o.workspace);
      // N1: craftar.yaml already exists
      const n1 = () => fail(`${WORKSPACE_FILE} already exists in ${root} — change recipes with craftar add recipe / remove recipe, or edit it`);
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
      // Mode: flags when both given; else interactive when both streams are TTYs; else N2
      const bothGiven = o.forge !== undefined && o.profile !== undefined;
      const isTTY = process.stdin.isTTY && process.stdout.isTTY;
      if (!bothGiven && !isTTY) {
        // N2: refuse with our message
        if (o.forge === undefined && o.profile === undefined) {
          fail("--forge and --profile are required when craftar init does not run in a terminal — pass them, or run craftar init in a terminal to be asked");
        } else if (o.profile === undefined) {
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
            ref: o.ref,
            targets: o.targets === undefined ? undefined : o.targets.split(",").map((t) => t.trim()),
            addRecipes: o.addRecipe,
            removeRecipes: o.removeRecipe,
            replace: o.replace,
          },
          local,
          io,
          { ...load(o, "sync"), registryOff: registryOff() },
        );
        if (result.kind === "cancelled") fail("init cancelled — nothing written");
        input = result.input;
        answers = result.answers;
      } else {
        input = {
          forge: o.forge!,
          profile: o.profile!,
          ref: o.ref,
          targets: o.targets === undefined ? undefined : o.targets.split(",").map((t) => t.trim()),
          addRecipes: o.addRecipe,
          removeRecipes: o.removeRecipe,
          replace: o.replace,
        };
      }
      const init = await planInit(root, input, { ...load(o, "sync"), local });
      if (answers !== null) {
        const io = readlineIo(process.stdin, process.stdout, { terminal: true });
        const confirm = await confirmInit(init, root, io, { sync: o.sync });
        if (confirm === "cancelled") fail("init cancelled — nothing written");
      }
      const { ws, plan: p } = init;
      const workspaceGiven = cmd.getOptionValueSource("workspace") === "cli";
      const again = () => {
        if (answers !== null) {
          console.log(againLine(answers, { workspace: workspaceGiven ? o.workspace : undefined, sync: o.sync, offline: o.offline }));
        }
      };
      // Every refusal is above: only now does the directory, and craftar.yaml, come to exist
      await fs.mkdir(root, { recursive: true });
      try {
        await fs.writeFile(file, init.text, { flag: "wx" });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") n1();
        throw e;
      }
      console.log(pc.bold(`craftar init — wrote ${WORKSPACE_FILE} in ${root}`));
      console.log(`  ${initLine(init)}`);
      for (const n of init.notes) console.log(`  note ${n}`);
      const unset = unsetDeclared(p);
      if (!o.sync) {
        console.log(nextSyncLine(init.statuses, unset));
        for (const w of p.warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
        again();
        return;
      }
      // Spec 29 §4.1, §6 case 11: craftar.yaml is written — the workspace layer is a place for the value — and the
      // first sync is not run. exitCode, not fail(): the `again` line still follows the block.
      if (unset.length) {
        for (const w of p.warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
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
      again();
    },
  );

/* ---------------------------------------------------------------- sync */
program
  .command("sync")
  .description("Generate the harness for every target from the Forge and update craftar.lock; a writing sync also records the workspace in $CRAFTAR_HOME/registry.json (see craftar workspaces); refuses, writing nothing, when a declared parameter a file cites has no value")
  .option("--workspace <dir>", "workspace root", ".")
  .option("--check", "exit 1 when the workspace is out of date or has drift (CI mode)", false)
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
      if (refusalBlock(unset)) process.exitCode = 1;
      else if (bad.length) process.exit(1);
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
  .description("Unified diff between the files on disk and what the Forge would generate, orphans included (files the Forge no longer produces); also says when a declared parameter a file cites has no value, which sync refuses")
  .option("--workspace <dir>", "workspace root", ".")
  .option("--exit-code", "exit 1 when there are differences (exactly when `sync --check` would fail); a [path] that names no file craftar manages becomes an error; with a remote Forge, a failed fetch exits 1 as `sync --check` does (--offline to use the cached copy)", false)
  .argument("[path]", "limit to one file")
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .action(async (only, o) => {
    const ws = await loadWorkspace(o.workspace, load(o, o.exitCode ? DIFF_EXIT_CODE_FETCH_MODE : "read"));
    warnStderr(ws.warnings);
    const p = await plan(ws);
    const st = await status(ws, p, await readLock(ws.root));
    // Spec 19 §3.3: under --exit-code a path nothing matches must not read as "clean" to a script
    if (o.exitCode && only && !st.some((s) => s.path === only))
      fail(`${only} is not a file craftar manages in this workspace — pass the workspace-relative path as \`craftar status\` prints it (forward slashes)`);
    let shown = 0;
    const render = { paint: { same: pc.dim, del: pc.red, add: pc.green } };
    for (const s of st) {
      if (only && s.path !== only) continue;
      // Spec 19 §3.2: show the six states sync --check refuses (skip unchanged and adopt)
      if (["unchanged", "adopt"].includes(s.state)) continue;
      shown++;
      if (s.state === "orphan-drift") {
        // Header and one line, no body: sync keeps this file
        console.log(pc.bold(`--- ${s.path} (disk, orphan-drift)`));
        console.log(`  ${explainSkip(s)}`);
        continue;
      }
      const disk = await readText(path.join(ws.root, s.path));
      if (s.state === "orphan") {
        // A removal: the file exists on disk but the Forge no longer produces it
        console.log(pc.bold(`--- ${s.path} (disk, orphan)`));
        console.log(pc.bold(`+++ ${s.path} (forge: no longer produced — sync removes it)`));
        console.log(renderDiff(disk ?? "", "", render));
      } else {
        const next = s.planned ? toLf(stripBom(s.planned.content.toString("utf8"))) : "";
        console.log(pc.bold(`--- ${s.path} (disk, ${s.state})`));
        console.log(pc.bold(`+++ ${s.path} (forge)`));
        // Spec 27 §4.2, Ruling 4: do not print on-disk content of the example file for drift/collision
        if (s.path === EXAMPLE_SETTINGS && (s.state === "drift" || s.state === "collision")) {
          console.log("  content not shown: an example file may hold a value typed by hand");
        } else {
          console.log(renderDiff(disk ?? "", next, render));
        }
      }
    }
    if (!shown) console.log(pc.green("no differences"));
    // exitCode, not process.exit: exit drops a piped diff still queued for a slow reader (spec 19 §3.1)
    else if (o.exitCode) process.exitCode = 1;
    // Spec 29 §4.1: with no [path], --exit-code fails exactly when `sync --check` does — a refused sync included
    if (refusalBlock(unsetDeclared(p)) && o.exitCode && !only) process.exitCode = 1;
  });

/* ---------------------------------------------------------------- add / remove recipe */
/**
 * Spec 22's line: what the next sync would do (also `init --no-sync`, spec 23 §4.4).
 * Uses `countStates` from `src/core/impact.ts`; a new `FileState` does not compile until it is
 * placed in `FILE_STATE_ORDER_MAP` there. A plan with unset declared parameters has no next sync
 * to count: the line says it is refused (spec 29 §4.1).
 */
function nextSyncLine(st: FileStatus[], unset: UnsetParam[]): string {
  if (unset.length) return `next sync: ${unsetRefused(unset)}`;
  const counts = countStates(st).map(([k, n]) => `${n} ${k}`);
  return `next sync: ${counts.length ? `${counts.join(", ")} — run \`craftar sync\`` : "nothing to sync"}`;
}

function recipeCommand(op: RecipeOp) {
  return async (names: string[], o: { workspace: string; replace?: boolean; offline?: boolean }) => {
    const ws = await loadWorkspace(o.workspace, load(o, "read"));
    warnStderr(ws.warnings);
    // R1: arrays replace across layers, so an edit of craftar.yaml would not take effect (spec 22 Ruling 1).
    if ((await localKeys(ws.root)).includes("recipes"))
      fail(`${LOCAL_FILE} sets recipes, which replaces ${WORKSPACE_FILE}'s lists — edit it by hand, or remove its recipes key and re-run`);
    const edit = planRecipeEdit(ws.forge, ws.config, op, names, { replace: o.replace === true });
    if (!edit.changed) {
      console.log(`nothing to change${edit.reasons.length ? `: ${edit.reasons.join(", ")}` : ""}`);
      return;
    }
    const file = path.join(ws.root, WORKSPACE_FILE);
    const content = editRecipesText(await fs.readFile(file, "utf8"), edit.recipes, `${op} recipe`);
    // The report is computed before the write, so a plan that fails leaves craftar.yaml untouched (§5.2 step 4).
    const next: Workspace = { ...ws, config: { ...ws.config, recipes: edit.recipes } };
    const p = await plan(next);
    const st = await status(next, p, await readLock(ws.root));
    const nextLine = nextSyncLine(st, unsetDeclared(p));
    await fs.writeFile(file, content);
    console.log(`${WORKSPACE_FILE}: ${recipeDiffLine(ws.config.recipes, edit.recipes)}`);
    console.log(`recipes: ${p.resolution.recipes.join(" → ")}`);
    console.log(nextLine);
    // plan() already carries ws.warnings first, and they were printed on load.
    warnStderr(p.warnings.slice(ws.warnings.length));
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
    const f = p.files.find((x) => x.path === file.replace(/\\/g, "/"));
    if (!f) fail(`${file} is not produced by the Forge for profile ${ws.config.profile}`);
    const ing = p.resolution.ingredients.find((i) => i.ref === f.ingredient);
    console.log(pc.bold(f.path));
    console.log(`  target      ${f.target}`);
    console.log(`  ingredient  ${f.ingredient}${ing?.meta.origin ? pc.dim(`  (imported from ${ing.meta.origin.workspace}:${ing.meta.origin.path})`) : ""}`);
    if (ing) console.log(`  via recipes ${ing.via.join(" → ")}`);
    // Spec 11 §4.2 (Ruling 15): which layer filled each section. AGENTS.md (rule/*) is not one ingredient.
    const sections = p.sections.get(f.ingredient);
    if (sections?.length) {
      const layer = (l: SectionLayer) => (l === "profile" ? `profile ${p.resolution.profile.name}` : l);
      console.log(`  sections    ${sections.map((x) => `${x.name} (${layer(x.layer)})`).join(", ")}`);
    }
    // Spec 29 §4.1: which layer filled each parameter the file's ingredient cites — or `unset`.
    const params = p.params.get(f.ingredient);
    if (params?.length) {
      const layer = (l: ParamLayer) => (typeof l === "string" ? l : "recipe" in l ? `recipe ${l.recipe}` : `profile ${l.profile}`);
      console.log(`  params      ${params.map((x) => `${x.key} (${layer(x.layer)})`).join(", ")}`);
    }
    console.log(`  profile     ${ws.config.profile}  (recipes: ${p.resolution.recipes.join(", ")})`);
    console.log(`  hash        ${hashNormalized(f.content)}`);
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

/* ---------------------------------------------------------------- doctor */
program
  .command("doctor")
  .description(
    "Check this machine (Node, git, $CRAFTAR_HOME, the registry, the Forge cache) and, inside one, this workspace (configuration and Forge, plan, declared parameters, MCP environment variables, lock, status, registration): one line per finding — ok, warn or error — each with its fix. Reports only; reads without the network unless --fetch",
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
    if (workspace) r.warnings.unshift(...workspace.warnings);

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
    if (workspace) result.warnings.unshift(...workspace.warnings);

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
        allCol2.push(`targets ${ing.targets === "*" ? "*" : (ing.targets as string[]).join(", ")}`);
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
          const col2 = `targets ${ing.targets === "*" ? "*" : (ing.targets as string[]).join(", ")}`;
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
    let inUse: Target[] | null = null;
    const warnings: string[] = [];

    const root = o.workspace ?? ".";
    if (!(await exists(path.join(root, WORKSPACE_FILE)))) {
      // craftar.yaml does not exist
      if (o.workspace !== undefined) {
        // Explicit --workspace: exit 1 with loadWorkspace's message
        try {
          await loadWorkspace(root, load({}, "no-fetch"));
        } catch (e) {
          fail(e instanceof Error ? e.message : String(e));
        }
      }
      // No --workspace: just show unmarked, no warning
    } else {
      // craftar.yaml exists, try to load
      try {
        const ws = await loadWorkspace(root, load({}, "no-fetch"));
        inUse = resolve(ws.forge, ws.config).targets;
      } catch (e) {
        // Load or resolve failed — warning, not error
        warnings.push(`targets in use not shown: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const result = listTargets(inUse);

    if (o.json) {
      return console.log(JSON.stringify({ ...result, warnings }, null, 2));
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

    // Never through the cache: a tree there is clean and tracked, so gitUnheld would pass and the edit
    // would be lost at the next cleanup without reaching the remote (spec 13 §4.4).
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
        fail(e instanceof YamlSyntaxError ? e.message : `${o.plan}: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        loadedPlan = UnifyPlanSchema.parse(parsed);
      } catch (e) {
        fail(`${o.plan}: ${e instanceof Error ? e.message : String(e)}`);
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
      const saved = await planFrom(base, variant, diff, o.profile);
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
      toApply = await planFrom(base, variant, diff, o.profile);
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

    const result = await applyPlan(base, variant, diff, toApply, { discardVariantMeta: o.take === "base", profileSections });
    // Ruling 33, dry pass: every recipe `ingredients` rewrite the cascade will make is checked before
    // the first byte is written, so a refusal (an aliased reference) leaves the Forge untouched.
    const cascadeFiles = result.resolved ? await checkRecipeCascade(f, base.ref, variant.ref) : [];
    // Spec 25 §4.4: prune candidates, computed in the dry pass
    const candidates: PruneCandidate[] = o.pruneRecipes && result.resolved
      ? await pruneCandidates(f, base.ref, variant.ref, o.profile)
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
      // Name every such path (the first few, then a count), so one run shows the whole problem.
      const SHOWN = 10;
      const lines = unheld.slice(0, SHOWN).map((u) => `  ${u.path} is not held by git (${u.reason})`);
      if (unheld.length > SHOWN) lines.push(`  … and ${unheld.length - SHOWN} more`);
      fail(`unify can only change files git can restore — ${unheld.length} path(s) under ${f.root} are not:\n${lines.join("\n")}`);
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

    if (result.metaDiffers.length) {
      warnings.push(
        `ingredient.yaml differs in ${result.metaDiffers.join(", ")} — unify cannot merge ingredient.yaml, so ${variant.ref} stays; ` +
          `resolve it by hand, or use --take base to discard the variant`,
      );
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
      const ws = impactEntries[i];
      const r = impactResults[i];
      let stateStr: string;
      if (r.state === "no-effect") {
        stateStr = "no effect";
      } else if (r.state === "changed") {
        const n = r.files.length;
        stateStr = n === 1 ? `1 file changes — ${r.files[0]}` : `${n} files change — ${r.files.join(", ")}`;
      } else if (r.state === "missing") {
        stateStr = "missing";
      } else {
        stateStr = `error: ${r.error}`;
      }
      const impactSuffix = matchSuffix(ws);
      console.log(`  impact: ${ws.entry.path} (${ws.entry.profile}) ${stateStr}${impactSuffix}`);
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

program.parseAsync().catch((e) => fail(e instanceof Error ? e.message : String(e)));

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

/** The header line naming a remote Forge (spec 13 §4.1); null for a path Forge, whose headers keep their shape. */
function forgeLine(ws: Workspace, lock: Lock | null): string | null {
  const o = ws.origin;
  if (o.kind !== "remote") return null;
  const commit = ws.forge.commit;
  const at = o.ref ?? `${o.defaultBranch} (default branch)`;
  const moved = lock?.forge.commit && commit && lock.forge.commit !== commit ? ` · lock ${lock.forge.commit.slice(0, 8)}` : "";
  return `  forge ${o.source} @ ${at} ${commit?.slice(0, 8) ?? "no git"}${moved}`;
}

/** `status --json`'s `forge` key, for every Forge (spec 13 §4.1). */
function forgeJson(ws: Workspace, lock: Lock | null) {
  const o = ws.origin;
  return {
    kind: o.kind,
    source: o.source,
    ref: o.ref,
    defaultBranch: o.defaultBranch,
    commit: ws.forge.commit,
    lockCommit: lock?.forge.commit ?? null,
    fetched: o.fetched,
  };
}

function fail(msg: string): never {
  console.error(pc.red("error: ") + msg);
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

function explainSkip(s: FileStatus): string {
  switch (s.state) {
    case "drift":
      return "hand-edited since last sync — run `craftar diff` and either `--overwrite-drift` or promote the change to the Forge";
    case "collision":
      return "exists but was never generated by craftar and differs from the Forge — rename it or import it";
    case "orphan-drift":
      return "no longer produced by the Forge but hand-edited — kept; delete it yourself if unwanted";
    default:
      return "";
  }
}

async function readText(p: string): Promise<string | null> {
  try {
    return toLf(stripBom(await fs.readFile(p, "utf8")));
  } catch {
    return null;
  }
}

/**
 * The real path of `abs`, resolved through its nearest existing ancestor: `fs.realpath` needs the
 * path to exist, and a plan target usually does not yet — so the part that exists is resolved
 * (symlinks and all) and the part that does not is appended as written.
 *
 * It walks up only past a component that truly does not exist (`lstat` says ENOENT/ENOTDIR). Any
 * other outcome throws instead. A component `lstat` cannot inspect (a symlink loop or a permission
 * error on Linux) "cannot be inspected"; one it can inspect but `realpath` cannot follow (a
 * dangling symlink or junction, a loop on Windows) "exists but cannot be resolved". Resolving the
 * rest lexically would let a link that points into the Forge pass the containment check, so the gate
 * fails closed rather than guess where the target lands.
 */
async function realpathOfNearest(abs: string): Promise<string> {
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(head), ...tail);
    } catch (realpathError) {
      try {
        await fs.lstat(head);
      } catch (lstatError) {
        const code = (lstatError as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          const parent = path.dirname(head);
          if (parent === head) return abs;
          tail.unshift(path.basename(head));
          head = parent;
          continue;
        }
        throw cannotResolve(head, lstatError, "cannot be inspected");
      }
      throw cannotResolve(head, realpathError, "exists but cannot be resolved");
    }
  }
}

/**
 * The refusal for a target that cannot be resolved; the caller adds which command cannot prove it. `what` is
 * "cannot be inspected" when `lstat` itself failed, so the path is not known to exist, and "exists but cannot be
 * resolved" when `lstat` succeeded and `realpath` did not.
 */
function cannotResolve(p: string, e: unknown, what: "cannot be inspected" | "exists but cannot be resolved"): Error {
  const code = (e as NodeJS.ErrnoException | null)?.code ?? (e instanceof Error ? e.message : String(e));
  return new Error(`${p} ${what} (${code})`);
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

/**
 * The message for a `forge unify` failure after writing began (Ruling 33): the original error, the
 * Forge-relative paths already touched, and the git commands that undo them — `checkout` for what
 * git tracks, `clean` for files unify created (checkout refuses a path git does not know).
 */
function lateFailure(e: unknown, root: string, journal: WriteJournal): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (journal.length === 0) return msg;
  const rel = (abs: string) => path.relative(root, abs).split(path.sep).join("/");
  const quote = (p: string) => (/^[\w./-]+$/.test(p) ? p : `"${p}"`);
  const restore = [...new Set(journal.filter((j) => !j.created).map((j) => rel(j.abs)))];
  const created = [...new Set(journal.filter((j) => j.created).map((j) => rel(j.abs)))];
  const lines = [msg, `unify had already started changing the Forge (${root}) when this failed:`];
  for (const p of [...restore, ...created]) lines.push(`  ${p}`);
  lines.push("recover with:");
  if (restore.length) lines.push(`  git -C ${quote(root)} checkout -- ${restore.map(quote).join(" ")}`);
  if (created.length) lines.push(`  git -C ${quote(root)} clean -f -- ${created.map(quote).join(" ")}`);
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
