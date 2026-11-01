import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { runCli } from "./helpers/cli.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";

/** Spec 48 Part C (Ruling 2): what `import` takes from a workspace, and writes into a Forge, stays inside each. */

const SECRET = "OUTSIDE-CONTENT-48";
const MARK = "private-outside";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const posixIt = it.skipIf(process.platform === "win32");

async function setup(files: Record<string, string> = {}) {
  const root = await tmpDir("craftar-import-contain-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const ws = path.join(root, "ws");
  const forge = path.join(root, "forge");
  const out = path.join(root, MARK);
  await fs.mkdir(out);
  await fs.writeFile(path.join(out, "secret.md"), SECRET);
  await writeFiles(ws, { ".claude/rules/plain.md": "# Plain\n", ...files });
  return { root, ws, forge, out, secret: path.join(out, "secret.md") };
}
type T = Awaited<ReturnType<typeof setup>>;
const imp = (t: T, ...extra: string[]) => runCli(["import", "--from", "claude-code", "--workspace", t.ws, "--forge", t.forge, "--profile", "acme", ...extra]);

async function forgeText(dir: string): Promise<string> {
  let all = "";
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) all += await fs.readFile(abs, "utf8");
    }
  };
  await walk(dir);
  return all;
}
const quiet = (r: { stdout: string; stderr: string }) => {
  expect(r.stdout + r.stderr).not.toContain(SECRET);
  expect(r.stdout + r.stderr).not.toContain(MARK);
};

describe("sources", () => {
  posixIt("L: a rule and a skill file that leave are rejected, naming the file and never the target", async () => {
    const t = await setup({ ".claude/skills/k/SKILL.md": "---\nname: k\ndescription: d\n---\nDo.\n" });
    await fs.symlink(t.secret, path.join(t.ws, ".claude/rules/linked.md"));
    await fs.symlink(t.secret, path.join(t.ws, ".claude/skills/k/note.txt"));
    const r = imp(t);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(".claude/rules/linked.md leaves the workspace through a symbolic link");
    expect(r.stdout).toContain(".claude/skills/k/note.txt leaves the workspace through a symbolic link");
    quiet(r);
    expect(await forgeText(t.forge)).not.toContain(SECRET);
    expect(await forgeText(t.forge)).toContain("# Plain");
    await expect(fs.lstat(path.join(t.forge, "ingredients/rules/linked"))).rejects.toThrow();
    await expect(fs.lstat(path.join(t.forge, "ingredients/skills/k"))).rejects.toThrow();
  });

  posixIt("an agent and a command that leave are rejected, and nothing of them reaches the Forge", async () => {
    const t = await setup();
    await fs.mkdir(path.join(t.ws, ".claude/agents"), { recursive: true });
    await fs.mkdir(path.join(t.ws, ".claude/commands"), { recursive: true });
    await fs.symlink(t.secret, path.join(t.ws, ".claude/agents/a.md"));
    await fs.symlink(t.secret, path.join(t.ws, ".claude/commands/c.md"));
    const r = imp(t);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("agent/a — .claude/agents/a.md leaves the workspace");
    expect(r.stdout).toContain("command/c — .claude/commands/c.md leaves the workspace");
    quiet(r);
    expect(await forgeText(t.forge)).not.toContain(SECRET);
  });

  posixIt("R, in bytes: a Forge file of a skill linked out is refused when import compares the directory", async () => {
    const t = await setup({ ".claude/skills/k/SKILL.md": "---\nname: k\ndescription: d\n---\nDo.\n", ".claude/skills/k/data.bin": "bytes" });
    expect(imp(t).code).toBe(0);
    await fs.rm(path.join(t.forge, "ingredients/skills/k/data.bin"));
    await fs.symlink(t.secret, path.join(t.forge, "ingredients/skills/k/data.bin"));
    const r = imp(t);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ingredients/skills/k/data.bin: a symbolic link out of the Forge");
    quiet(r);
  });

  posixIt("one escaping file of a script group rejects the whole group", async () => {
    const t = await setup({ ".claude/scripts/run-x.sh": "#!/bin/sh\n" });
    await fs.symlink(t.secret, path.join(t.ws, ".claude/scripts/run-x.ps1"));
    const r = imp(t);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(".claude/scripts/run-x.ps1 leaves the workspace");
    quiet(r);
    await expect(fs.lstat(path.join(t.forge, "ingredients/scripts/run-x"))).rejects.toThrow();
  });

  posixIt("V: a source linked into the workspace's .git is rejected, and its remote URL is not stored", async () => {
    const t = await setup({ ".git/config": `[remote "origin"]\nurl = ${SECRET}\n` });
    await fs.symlink(path.join(t.ws, ".git/config"), path.join(t.ws, ".claude/rules/r.md"));
    const r = imp(t);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(".claude/rules/r.md is a symbolic link into the workspace's .git");
    expect(await forgeText(t.forge)).not.toContain(SECRET);
  });

  posixIt("an escaping steering mirror rejects its rule, rather than letting its scope fall through", async () => {
    const t = await setup({ ".claude/rules/r.md": "# R\n" });
    await fs.mkdir(path.join(t.ws, ".kiro/steering"), { recursive: true });
    await fs.symlink(t.secret, path.join(t.ws, ".kiro/steering/r.md"));
    const r = imp(t);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(".kiro/steering/r.md leaves the workspace");
    quiet(r);
    await expect(fs.lstat(path.join(t.forge, "ingredients/rules/r"))).rejects.toThrow();
    expect(await forgeText(t.forge)).not.toContain(SECRET);
  });

  posixIt("--prefer-kiro refuses, in the escape's words, on an escaping mirror and on a rule whose own file escapes", async () => {
    const a = await setup({ ".claude/rules/r.md": "# R\n" });
    await fs.mkdir(path.join(a.ws, ".kiro/steering"), { recursive: true });
    await fs.symlink(a.secret, path.join(a.ws, ".kiro/steering/r.md"));
    const ra = imp(a, "--prefer-kiro", "r");
    expect(ra.code).toBe(1);
    expect(ra.stderr).toContain(".kiro/steering/r.md leaves the workspace through a symbolic link");
    quiet(ra);
    await expect(fs.lstat(a.forge)).rejects.toThrow();

    const b = await setup({ ".kiro/steering/r.md": "---\ninclusion: always\n---\n# R\n" });
    await fs.symlink(b.secret, path.join(b.ws, ".claude/rules/r.md"));
    const rb = imp(b, "--prefer-kiro", "r");
    expect(rb.code).toBe(1);
    expect(rb.stderr).toContain(".claude/rules/r.md leaves the workspace through a symbolic link");
    expect(rb.stderr).not.toContain("there is no");
    quiet(rb);
    await expect(fs.lstat(b.forge)).rejects.toThrow();
  });

  it("an escaping source directory refuses the run, with none of its file names in any output", async () => {
    for (const dir of [".claude/agents", ".claude/commands", ".claude/skills", ".claude/scripts", ".claude/hooks", ".kiro/steering"]) {
      const t = await setup();
      await fs.writeFile(path.join(t.out, "name-of-a-private-file.md"), "x");
      await fs.mkdir(path.dirname(path.join(t.ws, dir)), { recursive: true });
      await fs.symlink(t.out, path.join(t.ws, dir), "junction");
      const r = imp(t);
      expect(r.code, dir).toBe(1);
      expect(r.stderr, dir).toContain(`${dir} leaves the workspace through a symbolic link`);
      expect(r.stdout + r.stderr, dir).not.toContain("name-of-a-private-file");
      quiet(r);
      await expect(fs.lstat(t.forge), dir).rejects.toThrow();
    }
  });

  posixIt("an escaping .mcp.json refuses the run, with the Forge untouched", async () => {
    const t = await setup();
    await fs.symlink(t.secret, path.join(t.ws, ".mcp.json"));
    const r = imp(t);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(".mcp.json leaves the workspace through a symbolic link");
    quiet(r);
    await expect(fs.lstat(t.forge)).rejects.toThrow();
  });

  posixIt("a rejected ingredient leaves the profile's recipes on a re-import", async () => {
    const t = await setup({ ".claude/rules/r.md": "# R\n" });
    expect(imp(t).code).toBe(0);
    const before = await forgeText(path.join(t.forge, "recipes"));
    expect(before).toContain("rule/r");
    await fs.rm(path.join(t.ws, ".claude/rules/r.md"));
    await fs.symlink(t.secret, path.join(t.ws, ".claude/rules/r.md"));
    const r = imp(t);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(".claude/rules/r.md leaves the workspace");
    quiet(r);
    const profile = YAML.parse(await fs.readFile(path.join(t.forge, "profiles/acme/profile.yaml"), "utf8")) as { recipes: string[] };
    const recipes = await Promise.all(profile.recipes.map((n) => fs.readFile(path.join(t.forge, `recipes/${n}.yaml`), "utf8")));
    expect(recipes.join("\n")).not.toContain("rule/r\n");
  });

  posixIt("sniffScm and profile.executor are not decided by an outside file", async () => {
    const t = await setup();
    await fs.writeFile(t.secret, "github.com gh pr create");
    await fs.mkdir(path.join(t.ws, ".claude/commands"), { recursive: true });
    await fs.symlink(t.secret, path.join(t.ws, ".claude/commands/c.md"));
    await fs.symlink(t.secret, path.join(t.ws, ".claude/rules/kiro-execution.md"));
    expect(imp(t).code).toBe(0);
    const profile = YAML.parse(await fs.readFile(path.join(t.forge, "profiles/acme/profile.yaml"), "utf8")) as Record<string, unknown>;
    expect(profile.executor ?? {}).toEqual({});
    expect(profile.scm ?? {}).toEqual({});
  });

  posixIt("a dangling source behaves as today: a file refuses with ENOENT, a directory and .mcp.json are skipped", async () => {
    const f = await setup();
    await fs.symlink(path.join(f.root, "gone"), path.join(f.ws, ".claude/rules/d.md"));
    const rf = imp(f);
    expect(rf.code).toBe(1);
    expect(rf.stderr).toContain("ENOENT");
    await expect(fs.lstat(f.forge)).rejects.toThrow();

    const d = await setup();
    await fs.symlink(path.join(d.root, "gone"), path.join(d.ws, ".claude/agents"));
    await fs.symlink(path.join(d.root, "gone2"), path.join(d.ws, ".mcp.json"));
    expect(imp(d).code).toBe(0);
  });

  it("a link inside each tree is imported as today", async () => {
    const t = await setup({ "kept/inner.md": "# Inner\n" });
    await fs.symlink(path.join(t.ws, "kept"), path.join(t.ws, ".claude/agents"), "junction");
    const r = imp(t);
    expect(r.code, r.stderr).toBe(0);
    expect(await forgeText(t.forge)).toContain("# Inner");
  });
});

describe("the destination", () => {
  async function imported() {
    const t = await setup({ ".claude/rules/r.md": "# R\n" });
    expect(imp(t).code).toBe(0);
    await writeFiles(t.ws, { ".claude/rules/fresh.md": "# Fresh\n" });
    return t;
  }

  it("M: an ingredients/rules that leaves the Forge is not written through", async () => {
    const t = await imported();
    await fs.mkdir(path.join(t.out, "rules"));
    await fs.rm(path.join(t.forge, "ingredients/rules"), { recursive: true });
    await fs.symlink(path.join(t.out, "rules"), path.join(t.forge, "ingredients/rules"), "junction");
    const r = imp(t);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("a symbolic link out of the Forge");
    quiet(r);
    expect(await fs.readdir(path.join(t.out, "rules"))).toEqual([]);
  });

  posixIt("M, dangling: a staged path that leads nowhere is not created", async () => {
    const t = await imported();
    const gone = path.join(t.out, "created.md");
    // A directory loadForge skips, with no ingredient.yaml, whose rule.md is the link.
    await fs.mkdir(path.join(t.forge, "ingredients/rules/fresh"), { recursive: true });
    await fs.symlink(gone, path.join(t.forge, "ingredients/rules/fresh/rule.md"));
    const r = imp(t);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ingredients/rules/fresh/rule.md: a symbolic link that leads nowhere");
    quiet(r);
    await expect(fs.lstat(gone)).rejects.toThrow();
  });

  it("M, into .git: .git/hooks stays as it was", async () => {
    const t = await imported();
    await fs.mkdir(path.join(t.forge, ".git/hooks"), { recursive: true });
    await fs.mkdir(path.join(t.forge, "ingredients/rules/fresh"), { recursive: true });
    await fs.rm(path.join(t.forge, "ingredients/rules/fresh"), { recursive: true });
    await fs.symlink(path.join(t.forge, ".git/hooks"), path.join(t.forge, "ingredients/rules/fresh"), "junction");
    const r = imp(t);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("a symbolic link into the Forge's .git");
    expect(await fs.readdir(path.join(t.forge, ".git/hooks"))).toEqual([]);
  });

  it("a link inside the Forge is written through as today", async () => {
    const t = await imported();
    await fs.mkdir(path.join(t.forge, "kept"));
    await fs.symlink(path.join(t.forge, "kept"), path.join(t.forge, "ingredients/rules/fresh"), "junction");
    const r = imp(t);
    expect(r.code, r.stderr).toBe(0);
    await fs.access(path.join(t.forge, "kept/rule.md"));
  });
});

describe("import --report", () => {
  it("answers not computed when a planned path leaves", async () => {
    const t = await setup({ ".claude/skills/k/SKILL.md": "---\nname: k\ndescription: d\n---\nDo.\n", ".kiro/steering/plain.md": "---\ninclusion: always\n---\n# Plain\n" });
    await fs.symlink(t.out, path.join(t.ws, ".kiro/skills"), "junction");
    const report = path.join(t.root, "report.md");
    const r = imp(t, "--report", report);
    expect(r.code, r.stderr).toBe(0);
    const text = await fs.readFile(report, "utf8");
    expect(text).toContain(".kiro/skills/k/SKILL.md leaves the workspace through a symbolic link");
    expect(text).not.toContain(MARK);
  });

  it("lists no linked directory's names", async () => {
    const t = await setup({ ".kiro/steering/plain.md": "---\ninclusion: always\n---\n# Plain\n" });
    await fs.writeFile(path.join(t.out, "name-of-a-private-file.md"), "x");
    const report = path.join(t.root, "report.md");
    await fs.symlink(t.out, path.join(t.ws, ".kiro/agents"), "junction");
    const r = imp(t, "--report", report);
    expect(r.code, r.stderr).toBe(0);
    const text = await fs.readFile(report, "utf8");
    expect(text).not.toContain("name-of-a-private-file");
    expect(text).not.toContain(MARK);
  });
});
