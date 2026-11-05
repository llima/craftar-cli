import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateDocs, type DocsCheck, type DocsReport } from "../src/core/docs-validate.js";
import { profile, recipe, rule, scenario } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";
import { hermeticGit } from "./helpers/hermetic-git.js";

// Spec 58 — closed values, the root index, related: from the root, path keys and cited paths, through validateDocs.

hermeticGit();

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const M = ["ZZ", "MARKER", "ZZ"].join("");

async function ws(files: Record<string, string | Buffer>, docs: unknown, o: { repo?: boolean } = {}) {
  const s = await scenario(
    { ingredients: [rule("style", "# Style\n")], recipes: [recipe("base", ["rule/style"])], profiles: [profile("acme", ["base"], ["claude-code"], { docs })] },
    { config: { profile: "acme" }, files },
  );
  cleanups.push(() => removeWithRetry(s.root));
  if (o.repo !== false) execFileSync("git", ["-C", s.wsRoot, "init", "-q"], { stdio: "ignore" });
  return s;
}
const run = (root: string): Promise<DocsReport> =>
  validateDocs({ root, version: "test", fetch: false, strict: false, limit: null, configured: true, typedWorkspace: null, home: process.env.CRAFTAR_HOME });
const findings = (r: DocsReport, id?: string) => r.checks.filter((c) => c.level !== "ok" && (id === undefined || c.id === id));
const brief = (c: DocsCheck) => `${c.level} ${c.id} ${c.path}${c.line === null ? "" : `:${c.line}:${c.column}`} ${c.message}`;
const withFix = (c: DocsCheck) => `${brief(c)} | ${c.fix}`;
/** Every string leaf of the report, for the "no value printed" checks (§7). */
const leaves = (r: DocsReport): string[] => {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(r.checks);
  return out;
};

const STATUS = ["draft", "in-progress", "shipped", "deprecated"];

describe("spec 58 §5.1 — closed values (frontmatter)", () => {
  const BLOCK = { categories: [{ path: "specs", frontmatter: ["title", { status: STATUS }] }] };
  const fm = (status: string) => `---\ntitle: T\n${status}\n---\n`;

  it("in, out, case, number, boolean, list, missing, empty, CRLF, BOM and README", async () => {
    const s = await ws(
      {
        "docs/specs/in.md": fm("status: shipped"),
        "docs/specs/out.md": fm(`status: ${M}`),
        "docs/specs/case.md": fm("status: Shipped"),
        "docs/specs/yes.md": fm("status: yes"),
        "docs/specs/num.md": fm("status: 2026"),
        "docs/specs/bool.md": fm("status: true"),
        "docs/specs/list.md": fm("status: [draft]"),
        "docs/specs/missing.md": "---\ntitle: T\n---\n",
        "docs/specs/empty.md": fm('status: ""'),
        "docs/specs/crlf.md": `---\r\ntitle: T\r\nstatus: ${M}\r\n---\r\n`,
        "docs/specs/bom-ok.md": "\uFEFF---\r\ntitle: T\r\nstatus: draft\r\n---\r\n",
        "docs/specs/bom-bad.md": `\uFEFF---\ntitle: T\nstatus: ${M}\n---\n`,
        "docs/specs/README.md": fm(`status: ${M}`),
      },
      BLOCK,
    );
    const r = await run(s.wsRoot);
    const NOT_ONE = "frontmatter key status: value is not one of the declared values | use one of: draft, in-progress, shipped, deprecated";
    const NOT_STRING = "frontmatter key status: value is not a string | give status one of the declared values";
    const MISSING = "required frontmatter key status is missing or empty | give status a value";
    expect(findings(r).map(withFix)).toEqual([
      `error frontmatter docs/specs/bom-bad.md ${NOT_ONE}`,
      `error frontmatter docs/specs/bool.md ${NOT_STRING}`,
      `error frontmatter docs/specs/case.md ${NOT_ONE}`,
      `error frontmatter docs/specs/crlf.md ${NOT_ONE}`,
      `error frontmatter docs/specs/empty.md ${MISSING}`,
      `error frontmatter docs/specs/list.md ${NOT_STRING}`,
      `error frontmatter docs/specs/missing.md ${MISSING}`,
      `error frontmatter docs/specs/num.md ${NOT_STRING}`,
      `error frontmatter docs/specs/out.md ${NOT_ONE}`,
      `error frontmatter docs/specs/yes.md ${NOT_ONE}`,
    ]);
    expect(leaves(r).join("\n")).not.toContain(M);
    expect(leaves(r).join("\n")).not.toContain("Shipped");
  });

  it("a category with only a value list turns the frontmatter ok line on", async () => {
    const s = await ws({ "docs/specs/a.md": "---\nstatus: draft\n---\n" }, { categories: [{ path: "specs", frontmatter: [{ status: STATUS }] }] });
    const r = await run(s.wsRoot);
    expect(r.checks.map((c) => `${c.level} ${c.id}`)).toEqual(["ok links", "ok leaked-tags", "ok policy", "ok categories", "ok frontmatter"]);
  });
});

describe("spec 58 §5.2 — the root index (categories)", () => {
  const BLOCK = { categories: [{ path: "specs" }], uncovered: "error" };

  it("docs/README.md is no finding; docs/x/README.md in no category still is", async () => {
    const s = await ws({ "docs/README.md": "x\n", "docs/x/README.md": "x\n", "docs/specs/a.md": "x\n" }, BLOCK);
    expect(findings(await run(s.wsRoot)).map(brief)).toEqual(["error categories docs/x/README.md file is in no declared category"]);
  });

  it("docs/Readme.md, another case, is still a finding (its own workspace, for case-folding disks)", async () => {
    const s = await ws({ "docs/Readme.md": "x\n", "docs/specs/a.md": "x\n" }, BLOCK);
    expect(findings(await run(s.wsRoot)).map(brief)).toEqual(["error categories docs/Readme.md file is in no declared category"]);
  });
});

describe("spec 58 §5.3 — related: from the workspace root", () => {
  const cats = [{ path: "specs" }, { path: "plans" }, { path: "architecture" }];

  it("a tree whose entries are written from the root passes, symmetric, from several directories", async () => {
    const s = await ws(
      {
        "docs/plans/p.md": "---\nrelated: [docs/specs/s.md, docs/architecture/a.md]\n---\n",
        "docs/specs/s.md": "---\nrelated: [docs/plans/p.md, /docs/architecture/a.md]\n---\n",
        "docs/architecture/a.md": "---\nrelated: [docs/plans/p.md, docs/specs/s.md]\n---\n",
      },
      { categories: cats, related: "symmetric", relatedBase: "workspace" },
    );
    const r = await run(s.wsRoot);
    expect(findings(r)).toEqual([]);
    expect(r.checks.some((c) => c.id === "related" && c.level === "ok")).toBe(true);
  });

  it("under workspace: ../ leaves, a file-relative entry is missing, /x still the root, symmetry and the Windows-path fix", async () => {
    const s = await ws(
      {
        "docs/specs/x.md": "---\nrelated: [../out.md, nope.md, specs/s.md, /docs/specs/s.md, C:/x.md, docs/specs/y.md]\n---\n",
        "docs/specs/s.md": "---\nrelated: [docs/specs/x.md]\n---\n",
        "docs/specs/y.md": "---\nrelated: []\n---\n",
      },
      { categories: cats, related: "symmetric", relatedBase: "workspace" },
    );
    expect(findings(await run(s.wsRoot)).map(withFix)).toEqual([
      "error related docs/specs/x.md related[0]: the entry leaves the workspace | name a file inside the workspace",
      "error related docs/specs/x.md related[1]: the entry does not exist | correct the entry or restore the file",
      "error related docs/specs/x.md related[2]: the entry does not exist | correct the entry or restore the file",
      "error related docs/specs/x.md related[4]: an absolute Windows path | use a path relative to the workspace root",
      "error related docs/specs/x.md related[5]: the target does not list this file back | add this file to the target's related:",
    ]);
  });

  it("under file (the default): /x is the root too, and the Windows-path fix names the file", async () => {
    const s = await ws(
      { "docs/specs/x.md": "---\nrelated: [/docs/specs/s.md, s.md, C:/x.md]\n---\n", "docs/specs/s.md": "x\n" },
      { categories: cats, related: "resolve" },
    );
    expect(findings(await run(s.wsRoot)).map(withFix)).toEqual(["error related docs/specs/x.md related[2]: an absolute Windows path | use a path relative to the file"]);
  });
});

describe("spec 58 §5.4 — path keys (frontmatter)", () => {
  const BLOCK = {
    categories: [
      { path: "plans", frontmatter: ["title"], paths: { spec: { base: "workspace", sentinel: "none" } } },
      { path: "notes", paths: { ref: { base: "file" } } },
      { path: "specs" },
    ],
  };
  const plan = (spec: string) => `---\ntitle: T\n${spec}\n---\n`;

  it("each row, in relatedOf's order, the value never printed", async () => {
    const s = await ws(
      {
        "docs/plans/sentinel.md": plan("spec: none"),
        "docs/plans/exists.md": plan("spec: docs/specs/s.md"),
        "docs/plans/dir.md": plan("spec: docs/specs"),
        "docs/plans/anchored.md": plan("spec: /docs/specs/s.md"),
        "docs/plans/missing.md": plan(`spec: docs/specs/${M}.md`),
        "docs/plans/case.md": plan("spec: docs/specs/S.md"),
        "docs/plans/notstr.md": plan("spec: 5"),
        "docs/plans/null.md": plan("spec:"),
        "docs/plans/emptystr.md": plan('spec: ""'),
        "docs/plans/absent.md": plan(""),
        "docs/plans/leaves.md": plan(`spec: ../${M}.md`),
        "docs/plans/windows.md": plan(`spec: C:/${M}.md`),
        "docs/plans/scheme.md": plan(`spec: https://h/${M}`),
        "docs/plans/slashes.md": plan(`spec: //h/${M}`),
        "docs/plans/backslash.md": plan(`spec: 'docs\\${M}.md'`),
        "docs/plans/nul.md": plan(`spec: "docs/a\\0${M}.md"`),
        "docs/plans/link.md": plan("spec: docs/lnk/z.md"),
        "docs/plans/fragment.md": plan("spec: docs/specs/s.md#top"),
        "docs/specs/s.md": "x\n",
        "docs/notes/rel.md": "---\nref: ../specs/s.md\n---\n",
        "docs/notes/abs.md": "---\nref: docs/specs/s.md\n---\n",
        "docs/notes/win.md": "---\nref: C:/x.md\n---\n",
        "docs/notes/nofm.md": "no block\n",
        "docs/notes/bad.md": "---\nref: [unclosed\n---\n",
        "real/z.md": "x\n",
      },
      BLOCK,
    );
    await fs.symlink(path.join(s.wsRoot, "real"), path.join(s.wsRoot, "docs", "lnk"), "junction");
    const r = await run(s.wsRoot);
    const lines = findings(r, "frontmatter").map(withFix);
    expect(lines.filter((l) => !l.includes("docs/notes/bad.md"))).toEqual([
      "error frontmatter docs/notes/abs.md frontmatter key ref: the path does not exist | correct the path or restore the file",
      "error frontmatter docs/notes/win.md frontmatter key ref: the path is an absolute Windows path | use a path relative to the file",
      "error frontmatter docs/plans/backslash.md frontmatter key spec: the path holds a backslash | use / as the separator",
      "error frontmatter docs/plans/case.md frontmatter key spec: the path's case differs from the file on disk | match the file name's case exactly",
      "error frontmatter docs/plans/fragment.md frontmatter key spec: the path does not exist | correct the path or restore the file",
      "error frontmatter docs/plans/leaves.md frontmatter key spec: the path leaves the workspace | name a file inside the workspace",
      "warn frontmatter docs/plans/link.md frontmatter key spec: the path is reached through a symbolic link, not followed | name the file itself, not through a link",
      "error frontmatter docs/plans/missing.md frontmatter key spec: the path does not exist | correct the path or restore the file",
      "error frontmatter docs/plans/notstr.md frontmatter key spec: value is not a string | write spec as a path",
      "error frontmatter docs/plans/nul.md frontmatter key spec: the path holds a NUL character | remove it from the path",
      "error frontmatter docs/plans/scheme.md frontmatter key spec: the path has a scheme | name a file of the workspace",
      "error frontmatter docs/plans/slashes.md frontmatter key spec: the path has a scheme | name a file of the workspace",
      "error frontmatter docs/plans/windows.md frontmatter key spec: the path is an absolute Windows path | use a path relative to the workspace root",
    ]);
    // A block YAML refuses, in a category with paths and no frontmatter list: one finding.
    const bad = lines.filter((l) => l.includes("docs/notes/bad.md"));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatch(/^error frontmatter docs\/notes\/bad\.md:2:\d+ frontmatter is not valid YAML \([A-Z_]+\) \| correct the frontmatter block$/);
    expect(leaves(r).join("\n")).not.toContain(M);
    expect(leaves(r).join("\n")).not.toContain("none");
  });

  it("a category with only paths turns the frontmatter ok line on", async () => {
    const s = await ws({ "docs/notes/a.md": "---\nref: ../notes/a.md\n---\n" }, { categories: [{ path: "notes", paths: { ref: { base: "file" } } }] });
    const r = await run(s.wsRoot);
    expect(r.checks.map((c) => `${c.level} ${c.id}`)).toEqual(["ok links", "ok leaked-tags", "ok policy", "ok categories", "ok frontmatter"]);
  });
});

describe("spec 58 §5.5 — cited paths in .claude/ (cited)", () => {
  const ROOTS = ["docs", ".claude", "local-stack", "projects"];
  const BLOCK = { cited: { roots: ROOTS, exempt: [".claude/settings.craftar.example.json"] } };

  const BODY = [
    "# A", // 1
    "", // 2
    "Prose docs/nope.md, `docs/span.md` and <code>docs/code.md</code>.", // 3
    "", // 4
    "**docs/bold.md** _docs/under.md_ __docs/dunder.md__ docs/real.md docs/Real.md `.claude/rules/real.md`", // 5
    "", // 6
    "```", // 7
    "docs/fence.md", // 8
    "```", // 9
    "", // 10
    "x <pre>docs/pre.md</pre> <!-- docs/comment.md --> [docs/linktext.md](docs/linkdest.md) y", // 11
    "", // 12
    "docs/specs/<repo>/x.md docs/*.md https://h/docs/url.md ./docs/dot.md src/docs/src.md docs\\back.md {docs/b.md} $docs/d.md docs/e.md… docs/f...md", // 13
    "", // 14
    ".claude/settings.json .claude/settings.craftar.example.json projects/acme/README.md docs/lnk/z.md local-stack/gone.yaml", // 15
    "", // 16
    "    docs/indented.md", // 17
    "", // 18
    "<!--", // 19
    "docs/block-comment.md", // 20
    "-->", // 21
    "", // 22
    "Ends a sentence: docs/period.md. And docs/notasuffix.png and docs/dir and docs/x.md;", // 23
    "",
  ].join("\n");
  const col = (line: string, token: string) => BODY.split("\n")[Number(line) - 1].indexOf(token) + 1;

  const tree = (extra: Record<string, string> = {}) => ({
    ".claude/rules/a.md": `---\nrelated: docs/frontmatter.md\n---\n${BODY}`,
    ".claude/rules/real.md": "x\n",
    "docs/real.md": "x\n",
    "docs/other.md": "docs/not-in-claude.md\n",
    "CLAUDE.md": "docs/root-claude.md\n",
    "local-stack/x.yaml": "x\n",
    "projects/.keep": "",
    "real/z.md": "x\n",
    ".gitignore": "projects/\n.claude/settings.json\n",
    ...extra,
  });

  it("prose, code spans and <code> read; fences, <pre>, comments, frontmatter, links, placeholders and ignored paths not", async () => {
    const s = await ws(tree(), BLOCK);
    await fs.symlink(path.join(s.wsRoot, "real"), path.join(s.wsRoot, "docs", "lnk"), "junction");
    const r = await run(s.wsRoot);
    // The frontmatter shifts every body line by 3.
    const L = (n: number) => n + 3;
    const MISSING = "cited path does not exist | correct the path, restore the file, or exempt it in the docs block";
    expect(findings(r, "cited").map(withFix)).toEqual([
      `error cited .claude/rules/a.md:${L(3)}:${col("3", "docs/nope.md")} ${MISSING}`,
      `error cited .claude/rules/a.md:${L(3)}:${col("3", "docs/span.md")} ${MISSING}`,
      `error cited .claude/rules/a.md:${L(3)}:${col("3", "docs/code.md")} ${MISSING}`,
      `error cited .claude/rules/a.md:${L(5)}:${col("5", "**docs/bold.md")} ${MISSING}`,
      `error cited .claude/rules/a.md:${L(5)}:${col("5", "_docs/under.md")} ${MISSING}`,
      `error cited .claude/rules/a.md:${L(5)}:${col("5", "__docs/dunder.md")} ${MISSING}`,
      `error cited .claude/rules/a.md:${L(5)}:${col("5", "docs/Real.md")} cited path's case differs from the file on disk | match the file name's case exactly`,
      `warn cited .claude/rules/a.md:${L(15)}:${col("15", "docs/lnk/z.md")} cited path is reached through a symbolic link, not followed | cite the file itself, not through a link`,
      `error cited .claude/rules/a.md:${L(15)}:${col("15", "local-stack/gone.yaml")} ${MISSING}`,
      `error cited .claude/rules/a.md:${L(23)}:${col("23", "docs/period.md")} ${MISSING}`,
      `error cited .claude/rules/a.md:${L(23)}:${col("23", "docs/x.md;")} ${MISSING}`,
    ]);
    // No cited path is printed, in any string of the report.
    const all = leaves(r).join("\n");
    for (const p of ["docs/nope.md", "docs/span.md", "docs/code.md", "docs/bold.md", "docs/Real.md", "local-stack/gone.yaml", "docs/lnk/z.md", ".claude/settings.craftar.example.json", "projects"]) expect(all).not.toContain(p);
  });

  it("the ok line counts the candidates resolved and the files read; exempt and placeholders are not counted", async () => {
    const s = await ws(
      {
        ".claude/rules/a.md": "docs/real.md and `.claude/rules/real.md`, docs/<x>.md and .claude/settings.craftar.example.json\n",
        ".claude/rules/real.md": "nothing cited\n",
        "docs/real.md": "x\n",
      },
      BLOCK,
    );
    const r = await run(s.wsRoot);
    expect(findings(r)).toEqual([]);
    expect(r.checks.find((c) => c.id === "cited")).toMatchObject({ level: "ok", path: null, message: "2 cited paths in 2 files" });
  });

  it("a root that starts with _ keeps _drafts/x.md whole", async () => {
    const s = await ws({ ".claude/rules/a.md": "see _drafts/x.md and _drafts/y.md\n", "_drafts/y.md": "x\n" }, { cited: { roots: ["_drafts"] } });
    expect(findings(await run(s.wsRoot)).map(brief)).toEqual(["error cited .claude/rules/a.md:1:5 cited path does not exist"]);
  });

  it("git could not say: no missing or case error, one warn, and a link still a warn", async () => {
    const s = await ws({ ".claude/rules/a.md": "docs/nope.md docs/Real.md docs/lnk/z.md\n", "docs/real.md": "x\n", "real/z.md": "x\n" }, BLOCK, { repo: false });
    await fs.symlink(path.join(s.wsRoot, "real"), path.join(s.wsRoot, "docs", "lnk"), "junction");
    const lines = findings(await run(s.wsRoot), "cited").map(withFix);
    expect(lines).toEqual([
      "warn cited .claude/rules/a.md:1:27 cited path is reached through a symbolic link, not followed | cite the file itself, not through a link",
      "warn cited null git could not say which cited paths it ignores: missing cited paths not checked | run in a git repository with git on PATH",
    ]);
  });

  it("without cited, nothing is read and no cited line appears", async () => {
    const s = await ws({ ".claude/rules/a.md": "docs/nope.md\n" }, { categories: [] });
    const r = await run(s.wsRoot);
    expect(r.checks.filter((c) => c.id === "cited")).toEqual([]);
  });

  it("1 MiB of path characters, of _ and of * in one paragraph stays within the suite's limit", async () => {
    const s = await ws(
      {
        ".claude/rules/a.md": "docs/" + "a/".repeat(1 << 19) + "x.md\n\n" + "_".repeat(1 << 20) + "\n\n" + "*".repeat(1 << 20) + "\n\n" + "_docs/x.md".repeat(1 << 16) + "\n",
      },
      BLOCK,
    );
    const t0 = Date.now();
    await run(s.wsRoot);
    expect(Date.now() - t0).toBeLessThan(20_000);
  });
});

describe("spec 58 §6 — the cited id's place", () => {
  it("a path: null cited line comes after related's and before nothing else", async () => {
    const s = await ws({ ".claude/rules/a.md": "docs/nope.md\n", "docs/specs/a.md": "x\n" }, { categories: [{ path: "specs" }], related: "resolve", cited: { roots: ["docs"] } }, { repo: false });
    const ids = (await run(s.wsRoot)).checks.filter((c) => c.path === null).map((c) => c.id);
    expect(ids.indexOf("cited")).toBeGreaterThan(ids.indexOf("related"));
    expect(ids[ids.length - 1]).toBe("cited");
  });
});

describe("spec 58 §8 — writes nothing", () => {
  it("a run with every new key leaves the tree byte-identical", async () => {
    const s = await ws(
      { ".claude/rules/a.md": "docs/nope.md\n", "docs/plans/p.md": "---\nstatus: x\nspec: docs/nope.md\nrelated: [docs/nope.md]\n---\n" },
      { categories: [{ path: "plans", frontmatter: [{ status: ["a"] }], paths: { spec: { base: "workspace" } } }], related: "symmetric", relatedBase: "workspace", cited: { roots: ["docs"] } },
    );
    const snapshot = async (d: string) => {
      const out: Record<string, string> = {};
      const walk = async (rel: string) => {
        for (const e of await fs.readdir(path.join(d, rel), { withFileTypes: true })) {
          const r = path.join(rel, e.name);
          if (e.isDirectory()) await walk(r);
          else out[r] = (await fs.readFile(path.join(d, r))).toString("base64");
        }
      };
      await walk("");
      return out;
    };
    const before = await snapshot(s.root);
    await run(s.wsRoot);
    expect(await snapshot(s.root)).toEqual(before);
  });
});
