import { Command } from "commander";
import pc from "picocolors";
import path from "node:path";
import { promises as fs } from "node:fs";
import YAML from "yaml";
import { importClaudeCode } from "./importers/claude-code.js";
import { loadWorkspace, plan, readLock, status, apply, resolveForge, type FileStatus } from "./core/sync.js";
import { renderDiff, NO_EOF_NEWLINE_MARKER } from "./core/diff.js";
import { diffIngredients, listVariants, profileOf, type Distance, type IngredientDiff } from "./core/variants.js";
import { hashNormalized, toLf, stripBom } from "./core/text.js";
import { gitDirty, gitIsRepo, gitUnheld } from "./core/forge.js";
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
import { HUNK_CLASSES, UnifyPlanSchema, type HunkClass, type HunkSuggestion, type IngredientRef, type Take, type UnifyPlan } from "./schema/index.js";

process.stdout.on("error", (e: NodeJS.ErrnoException) => { if (e.code === "EPIPE") process.exit(0); });

const program = new Command();
program.name("craftar").description("Craft, sync and convert AI-coding workspace harnesses.").version("0.4.0");

/* ---------------------------------------------------------------- import */
program
  .command("import")
  .description("Import an existing workspace harness into a Forge (creates ingredients, recipes and a profile)")
  .requiredOption("--from <tool>", "source tool: claude-code")
  .requiredOption("--forge <dir>", "Forge directory (created if missing)")
  .requiredOption("--profile <name>", "client profile name to create")
  .option("--workspace <dir>", "workspace to import", ".")
  .option("--write-config", "write craftar.yaml into the workspace", false)
  .action(async (o) => {
    if (o.from !== "claude-code") fail(`unsupported source "${o.from}" (only claude-code for now)`);
    const r = await importClaudeCode({ workspaceRoot: o.workspace, forgeRoot: o.forge, profileName: o.profile, writeWorkspaceConfig: o.writeConfig });
    console.log(pc.bold(`Imported ${path.resolve(o.workspace)} → ${path.resolve(o.forge)} as profile "${r.profile}"`));
    console.log(
      `  ${pc.green(String(r.created.length))} created, ${pc.cyan(String(r.reused.length))} reused, ${pc.yellow(String(r.variants.length))} variants, ${pc.red(String(r.rejected.length))} rejected`,
    );
    for (const v of r.variants) console.log(`  ${pc.yellow("variant")} ${v.name} — ${v.reason}`);
    for (const x of r.rejected) console.log(`  ${pc.red("rejected")} ${x.name} — ${x.reason}`);
    console.log(`  recipes: ${r.recipes.join(", ")}`);
    for (const w of r.warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
  });

/* ---------------------------------------------------------------- status */
program
  .command("status")
  .description("Show what sync would do: new, update, drift, orphan, collision")
  .option("--workspace <dir>", "workspace root", ".")
  .option("--json", "machine-readable output", false)
  .action(async (o) => {
    const ws = await loadWorkspace(o.workspace);
    const p = await plan(ws);
    const st = await status(ws, p, await readLock(ws.root));
    if (o.json) return console.log(JSON.stringify({ statuses: st.map(({ planned, ...s }) => s), warnings: p.warnings }, null, 2));
    printStatus(st, p.warnings, ws.config.profile, p.resolution.recipes);
  });

/* ---------------------------------------------------------------- sync */
program
  .command("sync")
  .description("Generate the harness for every target from the Forge and update craftar.lock")
  .option("--workspace <dir>", "workspace root", ".")
  .option("--check", "exit 1 when the workspace is out of date or has drift (CI mode)", false)
  .option("--dry-run", "show the plan, write nothing", false)
  .option("--overwrite-drift", "regenerate files that were hand-edited (their edits are lost)", false)
  .action(async (o) => {
    const ws = await loadWorkspace(o.workspace);
    const p = await plan(ws);
    const st = await status(ws, p, await readLock(ws.root));
    if (o.check) {
      const bad = st.filter((s) => !["unchanged", "adopt"].includes(s.state));
      printStatus(st, p.warnings, ws.config.profile, p.resolution.recipes, true);
      if (bad.length) {
        console.log(pc.red(`\n${bad.length} file(s) out of sync`));
        process.exit(1);
      }
      console.log(pc.green("\nworkspace in sync"));
      return;
    }
    const r = await apply(ws, p, st, { dryRun: o.dryRun, overwriteDrift: o.overwriteDrift });
    const verb = o.dryRun ? "would write" : "wrote";
    console.log(pc.bold(`craftar sync — profile ${ws.config.profile} · recipes ${p.resolution.recipes.join(" → ")} · targets ${p.resolution.targets.join(", ")}`));
    console.log(`  ${verb} ${pc.green(String(r.written.length))}, removed ${pc.magenta(String(r.removed.length))} orphan(s), skipped ${pc.yellow(String(r.skipped.length))}`);
    for (const f of r.written) console.log(`  ${pc.green("+")} ${f}`);
    for (const f of r.removed) console.log(`  ${pc.magenta("-")} ${f}  (orphan: no longer produced by the Forge)`);
    for (const s of r.skipped) console.log(`  ${pc.yellow("!")} ${s.path}  ${explainSkip(s)}`);
    for (const w of p.warnings) console.log(`  ${pc.yellow("warn")} ${w}`);
  });

/* ---------------------------------------------------------------- diff */
program
  .command("diff")
  .description("Unified diff between the files on disk and what the Forge would generate")
  .option("--workspace <dir>", "workspace root", ".")
  .argument("[path]", "limit to one file")
  .action(async (only, o) => {
    const ws = await loadWorkspace(o.workspace);
    const p = await plan(ws);
    const st = await status(ws, p, await readLock(ws.root));
    let shown = 0;
    for (const s of st) {
      if (only && s.path !== only) continue;
      if (!["update", "drift", "collision", "new"].includes(s.state)) continue;
      shown++;
      const disk = await readText(path.join(ws.root, s.path));
      const next = s.planned ? toLf(stripBom(s.planned.content.toString("utf8"))) : "";
      console.log(pc.bold(`--- ${s.path} (disk, ${s.state})`));
      console.log(pc.bold(`+++ ${s.path} (forge)`));
      console.log(renderDiff(disk ?? "", next, { paint: { same: pc.dim, del: pc.red, add: pc.green } }));
    }
    if (!shown) console.log(pc.green("no differences"));
  });

/* ---------------------------------------------------------------- explain */
program
  .command("explain")
  .description("Why does this file exist? Which ingredient, recipe chain and target produced it")
  .argument("<path>", "workspace-relative path of a generated file")
  .option("--workspace <dir>", "workspace root", ".")
  .action(async (file, o) => {
    const ws = await loadWorkspace(o.workspace);
    const p = await plan(ws);
    const f = p.files.find((x) => x.path === file.replace(/\\/g, "/"));
    if (!f) fail(`${file} is not produced by the Forge for profile ${ws.config.profile}`);
    const ing = p.resolution.ingredients.find((i) => i.ref === f.ingredient);
    console.log(pc.bold(f.path));
    console.log(`  target      ${f.target}`);
    console.log(`  ingredient  ${f.ingredient}${ing?.meta.origin ? pc.dim(`  (imported from ${ing.meta.origin.workspace}:${ing.meta.origin.path})`) : ""}`);
    if (ing) console.log(`  via recipes ${ing.via.join(" → ")}`);
    console.log(`  profile     ${ws.config.profile}  (recipes: ${p.resolution.recipes.join(", ")})`);
    console.log(`  hash        ${hashNormalized(f.content)}`);
  });

/* ---------------------------------------------------------------- forge ls */
program
  .command("ls")
  .description("List recipes and ingredients resolved for this workspace")
  .option("--workspace <dir>", "workspace root", ".")
  .action(async (o) => {
    const ws = await loadWorkspace(o.workspace);
    const p = await plan(ws);
    console.log(pc.bold(`Forge ${ws.forge.manifest.name} @ ${ws.forge.commit?.slice(0, 8) ?? "no git"} · profile ${ws.config.profile}`));
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

/* ---------------------------------------------------------------- forge */
const forge = program.command("forge").description("Operate on the Forge itself rather than on a workspace");

forge
  .command("variants")
  .description("List ingredients that have variants, nearest first, with hunks counted by suggested class, and variants whose base is missing. Read-only")
  .option("--forge <dir>", "Forge directory (instead of --workspace)")
  .option("--workspace <dir>", "workspace whose craftar.yaml names the Forge (default: .)")
  .option("--json", "machine-readable output", false)
  .action(async (o) => {
    const f = await resolveForge({ forge: o.forge, workspace: o.workspace });
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
  .action(async (ref: string, o) => {
    const f = await resolveForge({ forge: o.forge, workspace: o.workspace });
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
  .description("Resolve one variant back into its base through a reviewable plan. Writes to the Forge")
  .argument("<type/name>", "base ingredient (rule/workflow)")
  .requiredOption("--profile <p>", "which variant to resolve")
  .option("--take <side>", "resolve every decision to base or variant")
  .option("--plan <file>", "apply the decisions in this plan file")
  .option("--save-plan <file>", "write a plan with every decision deferred, each hunk annotated with its suggested class (which --plan ignores), to a new file outside the Forge, and stop")
  .option("--forge <dir>", "Forge directory (instead of --workspace)")
  .option("--workspace <dir>", "workspace whose craftar.yaml names the Forge (default: .)")
  .option("--json", "machine-readable output", false)
  .action(async (ref: string, o) => {
    const frontEnds = [o.take, o.plan, o.savePlan].filter((v) => v !== undefined);
    if (frontEnds.length !== 1) fail("pass exactly one of --take, --plan or --save-plan");
    if (o.take !== undefined && o.take !== "base" && o.take !== "variant") fail(`--take must be "base" or "variant"`);

    const f = await resolveForge({ forge: o.forge, workspace: o.workspace });
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

    const result = await applyPlan(base, variant, diff, toApply, { discardVariantMeta: o.take === "base" });
    // Ruling 33, dry pass: every recipe `ingredients` rewrite the cascade will make is checked before
    // the first byte is written, so a refusal (an aliased reference) leaves the Forge untouched.
    const cascadeFiles = result.resolved ? await checkRecipeCascade(f, base.ref, variant.ref) : [];

    // Ruling 37: "git is the undo" only holds for files git actually has. The whole-repo clean
    // check above cannot see ignored files (a Forge its enclosing repo ignores, an ignored file in
    // a variant) nor untracked ones under `status.showUntrackedFiles=no` — so every path this run
    // will overwrite or delete is checked on its own, before the first write.
    const mustHold = [base.dir, ...(result.resolved ? [variant.dir, ...cascadeFiles] : [])];
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
    const journal: WriteJournal = [];
    let touched: string[] = [];
    let cascade: RecipeCascadeResult = { rewritten: [], identicalToSibling: [] };
    let variantRemoved: string | null = null;
    try {
      touched = await writeUnified(base, result, journal);
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
            written: Object.keys(result.write).sort(),
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
            warnings,
          },
          null,
          2,
        ),
      );
    }

    console.log(pc.bold(`craftar forge unify ${ref} ↔ ${o.profile}`));
    for (const p of touched) console.log(`  ${result.write[p] !== undefined ? pc.green("~") : pc.magenta("-")} ${p}`);
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

function fail(msg: string): never {
  console.error(pc.red("error: ") + msg);
  process.exit(1);
}

function printStatus(st: FileStatus[], warnings: string[], profile: string, recipes: string[], compact = false) {
  const counts: Record<string, number> = {};
  for (const s of st) counts[s.state] = (counts[s.state] ?? 0) + 1;
  console.log(pc.bold(`craftar status — profile ${profile} · recipes ${recipes.join(" → ")}`));
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

function describeDistance(d: Distance): string {
  if (d.identicalAfterNormalization) return "identical after normalization";
  if (d.sameBodyDifferentMeta) return "meta only";
  return `${d.lines} line${d.lines === 1 ? "" : "s"}, ${d.hunks} hunk${d.hunks === 1 ? "" : "s"}`;
}
