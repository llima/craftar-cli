import { Command } from "commander";
import pc from "picocolors";
import path from "node:path";
import { promises as fs } from "node:fs";
import { importClaudeCode } from "./importers/claude-code.js";
import { loadWorkspace, plan, readLock, status, apply, resolveForge, type FileStatus } from "./core/sync.js";
import { renderDiff } from "./core/diff.js";
import { diffIngredients, listVariants, profileOf, type Distance, type IngredientDiff } from "./core/variants.js";
import { hashNormalized, toLf, stripBom } from "./core/text.js";
import type { IngredientRef } from "./schema/index.js";

process.stdout.on("error", (e: NodeJS.ErrnoException) => { if (e.code === "EPIPE") process.exit(0); });

const program = new Command();
program.name("craftar").description("Craft, sync and convert AI-coding workspace harnesses.").version("0.0.6");

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
  .description("List ingredients that have variants, nearest first, and variants whose base is missing. Read-only")
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
      const detail = g.variants.map((v) => `${v.profile} (${describeDistance(v.distance)})`).join(", ");
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
  .description("Show the distance and the differences between a base ingredient and each of its variants. Read-only")
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
          const where = h.a.lines.length ? `lines ${h.a.start}–${h.a.start + h.a.lines.length - 1}` : `after line ${h.a.start - 1}`;
          console.log(`    hunk ${k + 1}  [${h.kind}]  ${where}`);
          for (const line of h.a.lines) console.log(pc.red(`      - ${line}`));
          if (h.a.noEofNewline) console.log("      \\ No newline at end of file");
          for (const line of h.b.lines) console.log(pc.green(`      + ${line}`));
          if (h.b.noEofNewline) console.log("      \\ No newline at end of file");
        });
      }
      for (const file of r.diff.onlyInBase) console.log(`  only in the base: ${file}`);
      for (const file of r.diff.onlyInVariant) console.log(`  only in the variant: ${file}`);
    }
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

function describeDistance(d: Distance): string {
  if (d.identicalAfterNormalization) return "identical after normalization";
  if (d.sameBodyDifferentMeta) return "meta only";
  return `${d.lines} line${d.lines === 1 ? "" : "s"}, ${d.hunks} hunk${d.hunks === 1 ? "" : "s"}`;
}
