import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exists, listFiles } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";

// Spec 29 §4.2 / §9 slice B — `craftar import --report`: where the report may be written, and what the command prints.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const BANNER = (name: string) => `<!-- GENERATED from .claude/rules/${name}.md by craftar -- do not edit. -->`;
/** A steering mirror as the kiro emitter writes it (frontmatter, banner, body), with the given line ending. */
const mirror = (name: string, bodyText: string, eol = "\r\n") => `---\ninclusion: always\n---\n\n${BANNER(name)}\n\n${bodyText}`.replace(/\n/g, eol);
const MARKER = "MARKER-LINE-9f3";
const TOKEN = "ghp_" + "x".repeat(36); // assembled at runtime on purpose

/** Three rules and a command with their Kiro mirrors: one hand-edited, one LF-only, one exact; plus strays. */
const WORKSPACE: Record<string, string> = {
  ".claude/rules/workflow.md": "# Workflow\n\nOne.\n",
  ".claude/rules/style.md": "# Style\n",
  ".claude/rules/exact.md": "# Exact\n",
  ".claude/commands/open-pr.md": "---\ndescription: Open a PR\n---\n\nDo it.\n",
  ".kiro/steering/workflow.md": mirror("workflow", `# Workflow\n\nOne.\n${MARKER}\ntoken ${TOKEN}\n`),
  ".kiro/steering/style.md": mirror("style", "# Style\n", "\n"),
  ".kiro/steering/exact.md": mirror("exact", "# Exact\n"),
  ".kiro/steering/team.md": "---\ninclusion: always\n---\n\n# Team notes\n",
  ".kiro/steering/commands/open-pr.md": "Do it, differently.\n",
  ".kiro/steering/commands/legacy-deploy.md": "old\n",
  ".kiro/agents/ghost.json": "{}\n",
  ".kiro/hooks/stray.json": "{}\n", // outside the four locations: never listed
};

async function setup(files: Record<string, string> = WORKSPACE) {
  const root = await tmpDir("craftar-import-report-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const ws = path.join(root, "acme-portal");
  await writeFiles(ws, files);
  return { root, ws, forge: path.join(root, "forge"), out: path.join(root, "out", "report.md") };
}
const run = (s: { ws: string; forge: string }, extra: string[] = []) => runCli(["import", "--from", "claude-code", "--forge", s.forge, "--profile", "acme", "--workspace", s.ws, ...extra]);
/** The summary with the scenario's temp root taken out, so two runs compare. */
const plain = (s: { root: string }, text: string) => text.split(s.root).join("<root>");

describe("import --report — the command", () => {
  it("without --report the summary is today's, byte for byte, and nothing but the Forge is written", async () => {
    const s = await setup();
    const r = run(s);
    expect(r.code, r.stderr).toBe(0);
    expect(plain(s, r.stdout)).toBe(
      'Imported <root>/acme-portal → <root>/forge as profile "acme"\n  7 created, 0 reused, 0 variants, 0 rejected\n  profile profiles/acme/profile.yaml created\n  recipes: base, acme-steering\n'.replace(/<root>\//g, `<root>${path.sep}`),
    );
    expect(await exists(path.dirname(s.out))).toBe(false);
  });

  it("with --report: the same summary plus one last line, the file written, exit 0", async () => {
    const s = await setup();
    const r = run(s, ["--report", s.out]);
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines.at(-1)).toBe(`  report ${s.out}`);
    expect(lines.slice(1, -1)).toEqual(["  7 created, 0 reused, 0 variants, 0 rejected", "  profile profiles/acme/profile.yaml created", "  recipes: base, acme-steering"]);
    const text = await fs.readFile(s.out, "utf8");
    expect(text.startsWith("---\nworkspace: ")).toBe(true);
    expect(text).toContain("\n# Import report — acme\n\n## Created (7)\n- craftar.forge.yaml\n- rule/exact\n- rule/style\n- rule/workflow\n- command/open-pr\n- steering/team\n- profiles/acme/profile.yaml\n");
    expect(text).toMatch(/\ncraftar: \d+\.\d+\.\d+\n---\n/);
  });

  it("the report may be inside the workspace", async () => {
    const s = await setup();
    const inside = path.join(s.ws, "docs", "import-report.md");
    expect(run(s, ["--report", inside]).code).toBe(0);
    expect(await exists(inside)).toBe(true);
  });
});

describe("import --report — the path gate, before the import reads anything", () => {
  /** Nothing was imported: the Forge directory does not exist, or holds exactly what it held. */
  const untouched = async (forge: string, before: string[] | null) => expect((await exists(forge)) ? await listFiles(forge) : null).toEqual(before);

  it("inside a Forge that does not exist yet: refused, exit 1, no Forge created", async () => {
    const s = await setup();
    const r = run(s, ["--report", path.join(s.forge, "notes", "report.md")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("refusing to write the report to ");
    expect(r.stderr).toContain("it resolves inside the Forge");
    expect(r.stderr).toContain("write the report outside the Forge");
    expect(r.stdout).toBe("");
    await untouched(s.forge, null);
  });

  it("inside an existing Forge, through `..` segments: refused, the Forge untouched", async () => {
    const s = await setup();
    expect(run(s).code).toBe(0); // the Forge now exists
    const before = await listFiles(s.forge);
    const r = run(s, ["--report", path.join(s.root, "out", "..", "forge", "report.md")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("it resolves inside the Forge");
    await untouched(s.forge, before);
  });

  it("an existing file: refused, the file kept, no Forge created", async () => {
    const s = await setup();
    await writeFiles(s.root, { "out/report.md": "mine\n" });
    const r = run(s, ["--report", s.out]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("the file already exists — import never overwrites; choose a new path");
    expect(await fs.readFile(s.out, "utf8")).toBe("mine\n");
    await untouched(s.forge, null);
  });

  // On Windows a directory junction needs no privilege, so this runs on both platforms.
  it("through a link that points into the Forge: refused as inside it", async () => {
    const s = await setup();
    await fs.mkdir(s.forge, { recursive: true });
    const link = path.join(s.root, "link");
    await fs.symlink(s.forge, link, process.platform === "win32" ? "junction" : "dir");
    const r = run(s, ["--report", path.join(link, "report.md")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("it resolves inside the Forge");
    await untouched(s.forge, []);
  });

  it("a Forge named through a link, the report inside the real directory: refused as inside it", async () => {
    const s = await setup();
    await fs.mkdir(s.forge, { recursive: true });
    const link = path.join(s.root, "forge-link");
    await fs.symlink(s.forge, link, process.platform === "win32" ? "junction" : "dir");
    const r = run({ ws: s.ws, forge: link }, ["--report", path.join(s.forge, "report.md")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("it resolves inside the Forge");
    await untouched(s.forge, []);
  });

  it("through a dangling link: refused as unresolvable, naming import, not unify", async () => {
    const s = await setup();
    const link = path.join(s.root, "dangling");
    await fs.symlink(path.join(s.root, "not-there"), link, process.platform === "win32" ? "junction" : "dir");
    const r = run(s, ["--report", path.join(link, "report.md")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot be resolved");
    expect(r.stderr).toContain("import cannot prove the target lies outside the Forge");
    expect(r.stderr).not.toContain("unify");
    await untouched(s.forge, null);
  });
});

describe("import --report — the Kiro part in the file", () => {
  it("the report lists the collisions and the unsourced files, and holds no line of any mirror", async () => {
    const s = await setup();
    const r = run(s, ["--report", s.out]);
    expect(r.code, r.stderr).toBe(0);
    const text = await fs.readFile(s.out, "utf8");
    expect(text).toContain(
      [
        "## Kiro collisions (2)",
        "",
        "| File | From | Workspace lines | Generated lines | Note |",
        "|---|---|---|---|---|",
        "| .kiro/steering/commands/open-pr.md | command/open-pr | 1 | 9 | |",
        "| .kiro/steering/workflow.md | rule/workflow | 11 | 9 | steering bigger than the rule |",
        "",
        "## Unsourced Kiro files (2)",
        "- .kiro/agents/ghost.json",
        "- .kiro/steering/commands/legacy-deploy.md",
        "",
        "## Warnings (0)",
      ].join("\n"),
    );
    // no content: not the marker line, not the token, not a line of the command mirror — in the file or on screen
    for (const leak of [MARKER, TOKEN, "Do it, differently."]) {
      expect(text).not.toContain(leak);
      expect(r.stdout + r.stderr).not.toContain(leak);
    }
    // the stray mirror was reported, never imported
    expect((await listFiles(s.forge)).some((f) => f.includes("legacy-deploy"))).toBe(false);
  });

  it("a workspace with no .kiro/: the single line", async () => {
    const s = await setup({ ".claude/rules/workflow.md": "# Workflow\n" });
    expect(run(s, ["--report", s.out]).code).toBe(0);
    expect(await fs.readFile(s.out, "utf8")).toContain("\n## Kiro collisions\nno .kiro/ in this workspace\n");
  });
});
