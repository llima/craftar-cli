import { promises as fs } from "node:fs";
import path from "node:path";
import { exists, listFiles } from "../core/forge.js";
import { parseFrontmatter } from "../core/frontmatter.js";
import { loadWorkspaceConfig, plan, status } from "../core/sync.js";
import { stripBom, toLf } from "../core/text.js";
import type { Target } from "../schema/index.js";
import { workspaceParams, workspaceSections } from "./decide.js";

/** One `.kiro/` file that differs from what sync would generate for the imported profile (spec 29 §3). */
export interface KiroCollision {
  path: string;
  /** The ingredient the plan builds that path from. */
  from: string;
  workspaceLines: number;
  generatedLines: number;
  /** `STEERING_BIGGER`, or empty. */
  note: string;
}

/** The Kiro part of an import report (spec 29 §4.2): line counts and paths, never content. */
export type KiroReport =
  | { kind: "none" } // the workspace has no .kiro/
  | { kind: "not-computed"; message: string } // the plan could not be computed after the flush
  | { kind: "computed"; collisions: KiroCollision[]; unsourced: string[] };

/** The note of a steering mirror that grew past its rule — the hint that `--prefer-kiro` may apply. */
export const STEERING_BIGGER = "steering bigger than the rule";

/** The banner the kiro emitter puts on a generated steering file. */
export const GENERATED_BANNER = /<!--\s*GENERATED from /;

/** The places under `.kiro/` whose files are reported when nothing sources them — three directories and one file (spec 29 §13 item 18). */
const SOURCED_DIRS = [".kiro/steering", ".kiro/agents", ".kiro/skills"];
const SOURCED_FILE = ".kiro/settings/mcp.json";

/** Lines of a text whatever its line ending or BOM, a final newline not counted as one more. */
export function textLines(text: string): number {
  const lines = toLf(stripBom(text)).split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

/** A steering mirror's own text: frontmatter and generated banner aside, leading blank lines dropped. */
function steeringBody(text: string): string {
  const { body } = parseFrontmatter(toLf(stripBom(text)));
  return body
    .split("\n")
    .filter((l) => !GENERATED_BANNER.test(l))
    .join("\n")
    .replace(/^\n+/, "");
}

/**
 * `STEERING_BIGGER` for a rule's steering mirror that holds more lines than the rule's source in `.claude/rules/` —
 * the documented symptom of a mirror kept by hand. The file's name is the rule's output name.
 */
async function noteFor(workspaceRoot: string, rel: string, from: string, steering: string): Promise<string> {
  const m = /^\.kiro\/steering\/([^/]+)\.md$/.exec(rel);
  if (!m || !from.startsWith("rule/")) return "";
  const rule = path.join(workspaceRoot, ".claude", "rules", `${m[1]}.md`);
  if (!(await exists(rule))) return "";
  return textLines(steeringBody(steering)) > textLines(await fs.readFile(rule, "utf8")) ? STEERING_BIGGER : "";
}

/**
 * The Kiro part of an import report (spec 29 §4.2), from the flushed Forge: the workspace is built in memory — the
 * Forge, the imported profile, the targets import detected, and the workspace's own `overrides.params` and
 * `overrides.sections`, read as import read them to prove a reuse (`workspaceParams`, `workspaceSections`): without
 * them a file import reused through an override would read as a collision `sync` never has. Nothing else of its
 * `craftar.yaml` or `craftar.local.yaml` is read, nor its lock. Then it is planned, and `status()` with no lock says
 * which `.kiro/` files are a `collision`. It is `status()`'s
 * state, not a second comparison: a line-ending or JSON-formatting difference is an `adopt` there. Reads only; never
 * throws — an import that flushed has succeeded whatever the plan says. `deps.plan` is for tests.
 */
export async function kiroReport(
  o: { workspaceRoot: string; forgeRoot: string; profile: string; targets: Target[] },
  deps: { plan: typeof plan } = { plan },
): Promise<KiroReport> {
  const root = path.resolve(o.workspaceRoot);
  if (!(await exists(path.join(root, ".kiro")))) return { kind: "none" };
  try {
    const read = (abs: string) => fs.readFile(abs, "utf8");
    const overrides = { params: await workspaceParams(root, read), sections: await workspaceSections(root, read) };
    const ws = await loadWorkspaceConfig(root, { forge: path.resolve(o.forgeRoot), profile: o.profile, targets: o.targets, overrides }, null);
    const p = await deps.plan(ws);
    const collisions: KiroCollision[] = [];
    for (const s of await status(ws, p, null)) {
      if (s.state !== "collision" || !s.path.startsWith(".kiro/")) continue;
      const disk = await fs.readFile(path.join(root, s.path), "utf8");
      const from = s.ingredient ?? "";
      collisions.push({
        path: s.path,
        from,
        workspaceLines: textLines(disk),
        generatedLines: textLines(s.planned!.content.toString("utf8")),
        note: await noteFor(root, s.path, from, disk),
      });
    }
    const planned = new Set(p.files.map((f) => f.path));
    const found: string[] = [];
    for (const dir of SOURCED_DIRS) {
      const abs = path.join(root, dir);
      // Only a directory is walked: a file sitting where one is expected is not Kiro's, and not this report's.
      if ((await fs.stat(abs).catch(() => null))?.isDirectory()) for (const rel of await listFiles(abs)) found.push(`${dir}/${rel}`);
    }
    if ((await fs.stat(path.join(root, SOURCED_FILE)).catch(() => null))?.isFile()) found.push(SOURCED_FILE);
    return {
      kind: "computed",
      collisions: collisions.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      unsourced: found.filter((f) => !planned.has(f)).sort(),
    };
  } catch (e) {
    return { kind: "not-computed", message: (e instanceof Error ? e.message : String(e)).split("\n")[0] };
  }
}
