import YAML from "yaml";
import type { ImportReport } from "../importers/claude-code.js";

export interface ImportReportInput {
  /** The imported workspace and the Forge, as native absolute paths. */
  workspace: string;
  forge: string;
  report: ImportReport;
  now: Date;
  /** The craftar that wrote the report. */
  version: string;
}

/** One line of a list or a table cell: a report entry never spans lines. */
const oneLine = (text: string) => text.replace(/\r?\n|\r/g, " ");
const cell = (text: string) => oneLine(text).replace(/\|/g, "\\|");

/** How a reused ingredient was reused, as the summary says it — an inferred value is workspace text, so only its key is named. */
function reusedLine(name: string, report: ImportReport): string {
  const rendered = report.rendered.find((x) => x.name === name);
  if (rendered) {
    const keys = rendered.keys.join(", ");
    const sections = rendered.sections?.length ? `${keys ? "; " : ""}sections ${rendered.sections.join(", ")}` : "";
    return `- ${name} — rendered${keys || sections ? `: ${keys}${sections}` : ""}`;
  }
  const inferred = report.inferred.find((x) => x.name === name);
  if (inferred) return `- ${name} — inferred: ${Object.keys(inferred.values).join(", ")}`;
  const sectioned = report.sectioned.find((x) => x.name === name);
  if (sectioned) return `- ${name} — sections: ${sectioned.sections.join(", ")}`;
  return `- ${name}`;
}

/**
 * A variant by what its name says — `<type>/<as>--<profile>` differs from `<type>/<as>`. Its `reason` is never copied:
 * it can quote the two lines that disagree, which are workspace text.
 */
function variantLine(name: string, profile: string): string {
  const suffix = `--${profile}`;
  return name.endsWith(suffix) ? `- ${name} — differs from ${name.slice(0, -suffix.length)}` : `- ${name}`;
}

/**
 * Takes out of a line of import's own wording every value this run read from the workspace — a parameter or section
 * value it accepted or replaced, an inferred value — in the quoted form import prints them (`JSON.stringify`).
 */
function withoutValues(report: ImportReport): (text: string) => string {
  const values = new Set<string>();
  for (const x of report.params) for (const v of [x.value, x.old]) if (v !== null) values.add(v);
  for (const x of report.sections) for (const v of [x.value, x.old]) if (v !== null) values.add(v);
  for (const x of report.inferred) for (const v of Object.values(x.values)) values.add(v);
  // Longest first, so a value that contains another is replaced whole.
  const quoted = [...values].sort((a, b) => b.length - a.length).map((v) => JSON.stringify(v));
  return (text) => quoted.reduce((t, q) => t.split(q).join('"…"'), text);
}

/** The Kiro sections (spec 29 §4.2): `status()`'s collisions and the files nothing sources, or why there are none. */
function kiroSections(report: ImportReport): string[][] {
  const kiro = report.kiro ?? { kind: "none" };
  if (kiro.kind === "none") return [["## Kiro collisions", "no .kiro/ in this workspace"]];
  if (kiro.kind === "not-computed") {
    const line = `not computed: ${oneLine(kiro.message)}`;
    return [
      ["## Kiro collisions", line],
      ["## Unsourced Kiro files", line],
    ];
  }
  const collisions = [`## Kiro collisions (${kiro.collisions.length})`];
  if (kiro.collisions.length) {
    collisions.push("", "| File | From | Workspace lines | Generated lines | Note |", "|---|---|---|---|---|");
    for (const c of kiro.collisions) {
      collisions.push(`| ${cell(c.path)} | ${cell(c.from)} | ${c.workspaceLines} | ${c.generatedLines} |${c.note ? ` ${cell(c.note)}` : ""} |`);
    }
  }
  return [collisions, [`## Unsourced Kiro files (${kiro.unsourced.length})`, ...kiro.unsourced.map((f) => `- ${oneLine(f)}`)]];
}

/**
 * The Markdown report of `craftar import --report` (spec 29 §4.2): import's own lists and the Kiro part, as paths,
 * refs and counts — never a line of a workspace file (§6 case 5). LF, no BOM, one trailing newline.
 */
export function renderImportReport(i: ImportReportInput): string {
  const { report } = i;
  const said = withoutValues(report);
  // Through the YAML writer: a path may hold `: ` or `#`; never folded, so each key stays one line.
  const frontmatter = YAML.stringify(
    { workspace: i.workspace, forge: i.forge, profile: report.profile, date: i.now.toISOString().replace(/\.\d+Z$/, "Z"), craftar: i.version },
    { lineWidth: 0 },
  );
  const sections: string[][] = [
    [`# Import report — ${report.profile}`],
    [`## Created (${report.created.length})`, ...report.created.map((x) => `- ${oneLine(x)}`)],
    [`## Reused (${report.reused.length})`, ...report.reused.map((x) => oneLine(reusedLine(x, report)))],
    [`## Variants (${report.variants.length})`, ...report.variants.map((x) => oneLine(variantLine(x.name, report.profile)))],
    [`## Rejected (${report.rejected.length})`, ...report.rejected.map((x) => `- ${oneLine(said(`${x.name} — ${x.reason}`))}`)],
    ...kiroSections(report),
    [`## Warnings (${report.warnings.length})`, ...report.warnings.map((x) => `- ${oneLine(said(x))}`)],
  ];
  return `---\n${frontmatter}---\n\n${sections.map((s) => s.join("\n")).join("\n\n")}\n`;
}
