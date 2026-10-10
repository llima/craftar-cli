import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exists } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";

// Spec 29 §4.3 — `craftar import --prefer-kiro`: the flag, the summary's lines and the report's section.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const BANNER = (name: string) => `<!-- GENERATED from .claude/rules/${name}.md by craftar -- do not edit. -->`;
/** A steering mirror exactly as the kiro emitter writes it: frontmatter, banner, body, CRLF. */
const mirror = (name: string, body: string) => `---\ninclusion: always\n---\n\n${BANNER(name)}\n\n${body}`.replace(/\n/g, "\r\n");

const WORKSPACE: Record<string, string> = {
  ".claude/rules/workflow.md": "# Workflow\n\nSee .claude/rules/style.md.\n",
  ".claude/rules/style.md": "# Style\n",
  ".kiro/steering/workflow.md": mirror("workflow", "# Workflow\n\nSee .kiro/steering/style.md.\nA line kept by hand.\n"),
  ".kiro/steering/style.md": mirror("style", "# Style\n"),
  ".kiro/steering/team.md": "---\ninclusion: always\n---\n\n# Team notes\n",
};

async function setup(files: Record<string, string> = WORKSPACE) {
  const root = await tmpDir("craftar-prefer-kiro-cli-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const ws = path.join(root, "acme-portal");
  await writeFiles(ws, files);
  return { root, ws, forge: path.join(root, "forge"), out: path.join(root, "out", "report.md") };
}
const run = (s: { ws: string; forge: string }, extra: string[] = []) => runCli(["import", "--from", "claude-code", "--forge", s.forge, "--profile", "acme", "--workspace", s.ws, ...extra]);
/** The summary with the scenario's temp root taken out. */
const plain = (s: { root: string }, text: string) => text.split(s.root + path.sep).join("<root>/");

const HEAD = 'Imported <root>/acme-portal → <root>/forge as profile "acme"\n  5 created, 0 reused, 0 variants, 0 rejected\n';
const TAIL = "  profile profiles/acme/profile.yaml created\n  recipes: base, acme-steering\n";
const PREFERRED = "  prefer-kiro rule/workflow — source .kiro/steering/workflow.md (10 lines; .claude/rules/workflow.md has 3)\n";
const NOTE =
  "  note rule/workflow now comes from Kiro: .claude/rules/workflow.md differs from it. With no lock entry it will read\n" +
  '       "collision" at the next sync — delete it (and .kiro/steering/workflow.md if it also collides) and run\n' +
  "       craftar sync to regenerate both. Where craftar.lock already records it unedited, sync updates it.\n";

describe("import --prefer-kiro — the command", () => {
  it("1. the prefer-kiro line follows the counts and the note closes the summary; no report line", async () => {
    const s = await setup();
    const r = run(s, ["--prefer-kiro", "workflow"]);
    expect(r.code, r.stderr).toBe(0);
    expect(plain(s, r.stdout)).toBe(HEAD + PREFERRED + TAIL + NOTE);
  });

  it("2. with --report the file holds the section, and the report line comes last, after the note", async () => {
    const s = await setup();
    const r = run(s, ["--prefer-kiro", "workflow", "--report", s.out]);
    expect(r.code, r.stderr).toBe(0);
    expect(plain(s, r.stdout)).toBe(HEAD + PREFERRED + TAIL + NOTE + `  report <root>/out${path.sep}report.md\n`);
    const report = await fs.readFile(s.out, "utf8");
    expect(report).toContain("\n## Rejected (0)\n\n## Preferred from Kiro (1)\n- " + PREFERRED.slice("  prefer-kiro ".length) + "\n## Kiro collisions");
    expect(report).not.toContain("A line kept by hand");
  });

  it("3. a mirror that never diverged: the line is printed, the note is not", async () => {
    const s = await setup({ ...WORKSPACE, ".kiro/steering/workflow.md": mirror("workflow", "# Workflow\n\nSee .kiro/steering/style.md.\n") });
    const r = run(s, ["--prefer-kiro", "workflow"]);
    expect(r.code, r.stderr).toBe(0);
    expect(plain(s, r.stdout)).toBe(HEAD + PREFERRED.replace("(10 lines", "(9 lines") + TAIL);
  });

  it.each([
    ["workflow,,style", "error: --prefer-kiro: an empty rule name\n"],
    ["workflow,workflow", "error: --prefer-kiro: workflow is named twice\n"],
  ])("4. PK5: --prefer-kiro %s is refused before anything is read", async (value, message) => {
    const s = await setup();
    const r = run(s, ["--prefer-kiro", value, "--report", s.out]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(message);
    expect(r.stdout).toBe("");
    expect(await exists(s.forge)).toBe(false);
    expect(await exists(path.dirname(s.out))).toBe(false);
  });

  it("5. PK1 through the command: the message, exit 1, the Forge absent", async () => {
    const s = await setup();
    const r = run(s, ["--prefer-kiro", "team"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      "error: import: --prefer-kiro team: there is no .claude/rules/team.md — --prefer-kiro takes rules; a steering file with no rule is already imported as steering\nThe Forge was left untouched.\n",
    );
    expect(r.stdout).toBe("");
    expect(await exists(s.forge)).toBe(false);
  });

  it("6. (control) without the flag the summary has neither line", async () => {
    const s = await setup();
    const r = run(s);
    expect(r.code, r.stderr).toBe(0);
    expect(plain(s, r.stdout)).toBe(HEAD + TAIL);
  });

  it("7. --help names the flag and its refusals", () => {
    const help = runCli(["import", "--help"]).stdout.replace(/\s+/g, " ");
    expect(help).toContain("--prefer-kiro <rule,…>");
    expect(help).toContain("each proved to render back to that steering file");
  });
});
