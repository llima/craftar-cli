import { Command } from "commander";
import pc from "picocolors";
import path from "node:path";
import { promises as fs } from "node:fs";
import YAML from "yaml";
import { importClaudeCode } from "./importers/claude-code.js";
import { classifyForge } from "./core/remote.js";
import { forget, listWorkspaces, prune, register, registryFile, resolveHome, type WorkspaceRow } from "./core/registry.js";
import { loadWorkspace, plan, readLock, status, apply, resolveForge, resolveForgeSource, WORKSPACE_FILE, type FetchMode, type FileStatus, type LoadOptions, type SectionLayer, type Workspace } from "./core/sync.js";
import type { Lock } from "./schema/index.js";
import { resolve, sectionKey } from "./core/resolve.js";
import { catalogueContext, listRecipes, listIngredients, checkType, type CatalogueContext, type ContextSource } from "./core/catalogue.js";
import { listTargets } from "./core/capabilities.js";
import { canonicalValue } from "./core/sections.js";
import { renderDiff, NO_EOF_NEWLINE_MARKER } from "./core/diff.js";
import { diffIngredients, listVariants, profileOf, type Distance, type IngredientDiff } from "./core/variants.js";
import { hashNormalized, toLf, stripBom } from "./core/text.js";
import { exists, gitDirty, gitIsRepo, gitUnheld } from "./core/forge.js";
import { fingerprintDir } from "./core/fingerprint.js";
import {
  hunkAt,
  planFrom,
  applyPlan,
  writeUnified,
  checkRecipeCascade,
  rewriteRecipes,
  type RecipeCascadeResult,
  type WriteJournal,
} from "./core/unify.js";
import { checkParamWrites, writeParamFile } from "./core/param-writes.js";
import { HUNK_CLASSES, INGREDIENT_TYPES, UnifyPlanSchema, type HunkClass, type HunkSuggestion, type IngredientRef, type IngredientType, type Take, type Target, type UnifyPlan } from "./schema/index.js";

process.stdout.on("error", (e: NodeJS.ErrnoException) => { if (e.code === "EPIPE") process.exit(0); });

/**
 * Q13-1, answered by the user (2026-10-07): with a remote Forge whose fetch fails, `diff --exit-code`
 * fails like `sync --check` — a CI gate does not pass against a stale cached copy. Plain `diff` still
 * reads the cached copy with a warning (spec 13 §4.1).
 */
const DIFF_EXIT_CODE_FETCH_MODE: FetchMode = "sync";

const program = new Command();
program.name("craftar").description("Craft, sync and convert AI-coding workspace harnesses.").version("0.12.0");

/* ---------------------------------------------------------------- import */
program
  .command("import")
  .description("Import an existing workspace harness into a Forge: creates or updates ingredients, recipes and a profile, reusing a templated base when it renders the workspace text or infers it into params or sections")
  .requiredOption("--from <tool>", "source tool: claude-code")
  .requiredOption("--forge <dir>", "Forge directory (created if missing)")
  .requiredOption("--profile <name>", "client profile to create or update")
  .option("--workspace <dir>", "workspace to import", ".")
  .option("--write-config", "write craftar.yaml into the workspace, merging an existing one (forge, profile, targets)", false)
  .action(async (o) => {
    if (o.from !== "claude-code") fail(`unsupported source "${o.from}" (only claude-code for now)`);
    // import writes a local Forge; a URL would become a directory named after it (spec 13 §4.4).
    if (classifyForge(o.forge) === "url") fail("--forge takes a directory; to read a remote Forge, run inside a workspace that names it");
    const r = await importClaudeCode({ workspaceRoot: o.workspace, forgeRoot: o.forge, profileName: o.profile, writeWorkspaceConfig: o.writeConfig });
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
  });

/* ---------------------------------------------------------------- status */
program
  .command("status")
  .description("Show what sync would do: new, update, drift, orphan, collision")
  .option("--workspace <dir>", "workspace root", ".")
  .option("--json", "machine-readable output", false)
  .option("--offline", "use the cached copy of a remote Forge, without fetching", false)
  .action(async (o) => {
    const ws = await loadWorkspace(o.workspace, load(o, "read"));
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const st = await status(ws, p, lock);
    if (o.json) return console.log(JSON.stringify({ forge: forgeJson(ws, lock), statuses: st.map(({ planned, ...s }) => s), warnings: p.warnings }, null, 2));
    printStatus(st, p.warnings, ws.config.profile, p.resolution.recipes, false, forgeLine(ws, lock));
  });

/* ---------------------------------------------------------------- sync */
program
  .command("sync")
  .description("Generate the harness for every target from the Forge and update craftar.lock; a writing sync also records the workspace in $CRAFTAR_HOME/registry.json (see craftar workspaces)")
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
      if (bad.length) {
        console.log(pc.red(`\n${bad.length} file(s) out of sync`));
        process.exit(1);
      }
      console.log(pc.green("\nworkspace in sync"));
      return;
    }
    const r = await apply(ws, p, st, { dryRun: o.dryRun, overwriteDrift: o.overwriteDrift });
    // A writing sync records the workspace (spec 21 §4.1); the registry is an index, so a failure is a warning.
    let registryWarning: string | null = null;
    if (!o.dryRun && !registryOff()) {
      const home = craftarHome();
      try {
        await register(home, ws, p);
      } catch (e) {
        registryWarning = `registry not updated (${registryFile(home)}): ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    const verb = o.dryRun ? "would write" : "wrote";
    console.log(pc.bold(`craftar sync — profile ${ws.config.profile} · recipes ${p.resolution.recipes.join(" → ")} · targets ${p.resolution.targets.join(", ")}`));
    const fl = forgeLine(ws, lock);
    if (fl) console.log(fl);
    console.log(`  ${verb} ${pc.green(String(r.written.length))}, removed ${pc.magenta(String(r.removed.length))} orphan(s), skipped ${pc.yellow(String(r.skipped.length))}`);
    for (const f of r.written) console.log(`  ${pc.green("+")} ${f}`);
    for (const f of r.removed) console.log(`  ${pc.magenta("-")} ${f}  (orphan: no longer produced by the Forge)`);
    for (const s of r.skipped) console.log(`  ${pc.yellow("!")} ${s.path}  ${explainSkip(s)}`);
    for (const w of p.warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
    if (registryWarning) console.log(`  ${pc.yellow("warn")} ${registryWarning}`);
  });

/* ---------------------------------------------------------------- diff */
program
  .command("diff")
  .description("Unified diff between the files on disk and what the Forge would generate, orphans included (files the Forge no longer produces)")
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
        console.log(renderDiff(disk ?? "", next, render));
      }
    }
    if (!shown) console.log(pc.green("no differences"));
    // exitCode, not process.exit: exit drops a piped diff still queued for a slow reader (spec 19 §3.1)
    else if (o.exitCode) process.exitCode = 1;
  });

/* ---------------------------------------------------------------- explain */
program
  .command("explain")
  .description("Why does this file exist? Which ingredient, recipe chain and target produced it, and which layer filled each section")
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
          console.log(`    hunk ${k + 1}  [${h.kind}]  ${hunkAt(h)}  ${describeSuggestion(h.suggestion)}`);
          for (const line of h.a.lines) console.log(pc.red(`      - ${line}`));
          if (h.a.noEofNewline) console.log(pc.red(`      ${NO_EOF_NEWLINE_MARKER}`));
          for (const line of h.b.lines) console.log(pc.green(`      + ${line}`));
          if (h.b.noEofNewline) console.log(pc.green(`      ${NO_EOF_NEWLINE_MARKER}`));
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
  .option("--forge <dir>", "Forge directory (instead of --workspace)")
  .option("--workspace <dir>", "workspace whose craftar.yaml names the Forge (default: .)")
  .option("--json", "machine-readable output", false)
  .action(async (ref: string, o) => {
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
      try {
        loadedPlan = UnifyPlanSchema.parse(YAML.parse(await fs.readFile(o.plan, "utf8")));
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
      const savePlanAbs = path.resolve(o.savePlan);
      let targetReal: string;
      try {
        targetReal = await realpathOfNearest(savePlanAbs);
      } catch (e) {
        fail(`refusing to write the plan to ${o.savePlan}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const rootReal = await fs.realpath(path.resolve(f.root));
      const rel = path.relative(rootReal, targetReal);
      if (rel === "" || !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) {
        fail(`refusing to write the plan to ${o.savePlan}: it resolves inside the Forge (${f.root}) — save plans outside the Forge`);
      }
      if (await pathTaken(savePlanAbs)) {
        fail(`refusing to write the plan to ${o.savePlan}: the file already exists — unify never overwrites; choose a new path`);
      }
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
    // Spec 09 & 12: the Forge-level rows and YAML edits for parameter and section extractions, rendered before any write.
    const paramWrites = result.params.length || result.sections.length
      ? await checkParamWrites(f, base, variant, o.profile, result.params, result.sections)
      : null;

    // Ruling 37: "git is the undo" only holds for files git actually has. The whole-repo clean
    // check above cannot see ignored files (a Forge its enclosing repo ignores, an ignored file in
    // a variant) nor untracked ones under `status.showUntrackedFiles=no` — so every path this run
    // will overwrite or delete is checked on its own, before the first write.
    const mustHold = [base.dir, ...(result.resolved ? [variant.dir, ...cascadeFiles] : []), ...(paramWrites?.mustHold ?? [])];
    const unheld = await gitUnheld(f.root, mustHold);
    if (unheld.length) {
      // Name every such path (the first few, then a count), so one run shows the whole problem.
      const SHOWN = 10;
      const lines = unheld.slice(0, SHOWN).map((u) => `  ${u.path} is not held by git (${u.reason})`);
      if (unheld.length > SHOWN) lines.push(`  … and ${unheld.length - SHOWN} more`);
      fail(`unify can only change files git can restore — ${unheld.length} path(s) under ${f.root} are not:\n${lines.join("\n")}`);
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

    // Ruling 28: a metadata difference leaves the variant in place; say which fields and why.
    const warnings: string[] = [];
    if (result.metaDiffers.length) {
      warnings.push(
        `ingredient.yaml differs in ${result.metaDiffers.join(", ")} — unify cannot merge ingredient.yaml, so ${variant.ref} stays; ` +
          `resolve it by hand, or use --take base to discard the variant`,
      );
    }
    // Ruling 42: a suffixed recipe left identical to its sibling is reported, never deleted — a
    // workspace's recipes.add or an extends chain may name the sibling, and removing the suffixed
    // one would shift recipe order or param precedence there.
    const suffix = `--${o.profile}`;
    for (const rn of cascade.identicalToSibling) {
      const sibling = rn.slice(0, -suffix.length);
      warnings.push(
        `recipe ${rn} is now identical to ${sibling} — it can be removed by hand after repointing the profiles, extends and ` +
          `workspace recipes lists that name it; unify does not, because a workspace or an extends chain may also name ` +
          `${sibling} and the recipe order or param precedence would change`,
      );
    }
    // Ruling 38: `resolve()` matches overrides.ingredients.disable by ref, so once the variant ref
    // is gone a workspace that disabled it gets the base back, enabled, with no error.
    // Spec 09 W1: what a parameter extraction cannot check from inside the Forge (W2 went with spec 10).
    for (const e of result.params.filter((p) => !p.reused)) {
      warnings.push(
        `${e.key} is now a parameter of ${base.ref} — a workspace that sets overrides.params.${e.key} (craftar.yaml or ` +
          `craftar.local.yaml) now overrides ${base.ref} too; unify cannot reach workspaces`,
      );
    }
    // Spec 12 W3: a new section's name may be cited by a workspace's overrides.sections that was inert until now.
    for (const s of result.sections.filter((sec) => !sec.existing)) {
      warnings.push(
        `${s.name} is now a section of ${base.ref} — a workspace that sets overrides.sections.${s.key}.${s.name} (craftar.yaml or ` +
          `craftar.local.yaml) now applies there; unify cannot reach workspaces`,
      );
    }
    if (variantRemoved) {
      warnings.push(
        `${variant.ref} was removed — a workspace that disables it in overrides.ingredients.disable (craftar.yaml or craftar.local.yaml) ` +
          `must now name ${base.ref}, or the base comes back enabled; unify cannot reach workspaces`,
      );
    }

    if (o.json) {
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
    for (const w of warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
    console.log(`  next: run \`craftar status --workspace <dir>\` in a workspace on profile ${o.profile} to see what moved`);
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

/** `$CRAFTAR_HOME`, as the cache reads it (spec 13 §6.3). */
function craftarHome(): string {
  return resolveHome(process.env.CRAFTAR_HOME || undefined);
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
    const synced = `synced ${r.lastSync.slice(0, 16).replace("T", " ")}`;
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
 * rest lexically would let a link that points into the Forge pass the containment check, so unify
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
 * The refusal for a `--save-plan` target that cannot be resolved. `what` is "cannot be inspected"
 * when `lstat` itself failed, so the path is not known to exist, and "exists but cannot be
 * resolved" when `lstat` succeeded and `realpath` did not.
 */
function cannotResolve(p: string, e: unknown, what: "cannot be inspected" | "exists but cannot be resolved"): Error {
  const code = (e as NodeJS.ErrnoException | null)?.code ?? (e instanceof Error ? e.message : String(e));
  return new Error(`${p} ${what} (${code}) — unify cannot prove the target lies outside the Forge`);
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
