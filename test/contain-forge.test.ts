import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, scenario, tmpDir, writeFiles } from "./helpers/forge.js";
import { remoteForge, git } from "./helpers/remote.js";
import { removeWithRetry } from "./helpers/fs.js";

/** Spec 48 Part A: what craftar reads as Forge content has a real path inside the Forge. Every "private" file is synthetic. */

const SECRET = "OUTSIDE-CONTENT-48";
const MARK = "private-outside";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function outsideFile(): Promise<{ dir: string; file: string }> {
  const base = await tmpDir("craftar-outside-");
  cleanups.push(() => fs.rm(base, { recursive: true, force: true }));
  const dir = path.join(base, MARK);
  await fs.mkdir(dir);
  const file = path.join(dir, "secret.txt");
  await fs.writeFile(file, SECRET);
  return { dir, file };
}

const posixIt = it.skipIf(process.platform === "win32");

async function base() {
  const s = await scenario(
    {
      ingredients: [
        rule("r", "# R\nBody.\n"),
        { meta: { type: "rule", name: "r--acme", as: "r" }, files: { "rule.md": "# R\nAcme.\n" } },
        { meta: { type: "skill", name: "k", layout: "dir" }, files: { "SKILL.md": "---\nname: k\ndescription: d\n---\nDo.\n" } },
      ],
      recipes: [recipe("base", ["rule/r", "skill/k"]), recipe("acme", ["rule/r--acme", "skill/k"])],
      profiles: [profile("acme", ["acme"]), profile("globex", ["base"])],
    },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  return s;
}

/** Whatever a command printed or wrote, the outside file's content and its path are in none of it. */
async function nothingOut(s: { wsRoot: string }, r: { stdout: string; stderr: string }) {
  for (const t of [r.stdout, r.stderr]) {
    expect(t).not.toContain(SECRET);
    expect(t).not.toContain(MARK);
  }
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) expect((await fs.readFile(abs)).toString("utf8")).not.toContain(SECRET);
    }
  };
  await walk(s.wsRoot);
}

const replaceWithLink = async (target: string, link: string) => {
  await fs.rm(link, { force: true });
  await fs.symlink(target, link);
};

describe("the plan path", () => {
  posixIt("A: a file link out in a directory skill fails the plan", async () => {
    const s = await base();
    const { file } = await outsideFile();
    await fs.symlink(file, path.join(s.forgeRoot, "ingredients/skills/k/link.txt"));
    const r = runCli(["sync", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ingredients/skills/k/link.txt: a symbolic link out of the Forge — craftar does not read it");
    await nothingOut(s, r);
  });

  posixIt("B: a declared body linked out fails the plan, on every surface that plans", async () => {
    const s = await base();
    const { file } = await outsideFile();
    await replaceWithLink(file, path.join(s.forgeRoot, "ingredients/rules/r--acme/rule.md"));
    for (const args of [["sync"], ["sync", "--check"], ["status"], ["diff"], ["explain", ".claude/rules/r.md"]]) {
      const r = runCli([...args, "--workspace", s.wsRoot]);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toContain("ingredients/rules/r--acme/rule.md: a symbolic link out of the Forge");
      await nothingOut(s, r);
    }
    const d = runCli(["doctor", "--json", "--workspace", s.wsRoot], { env: { PATH: "", Path: "" } });
    expect(d.code).toBe(1);
    expect(d.stdout).toContain("a symbolic link out of the Forge");
    await nothingOut(s, d);
  });

  it("C: a link to a directory in a skill fails in words, even inside the Forge", async () => {
    const s = await base();
    await fs.mkdir(path.join(s.forgeRoot, "shared"));
    await fs.symlink(path.join(s.forgeRoot, "shared"), path.join(s.forgeRoot, "ingredients/skills/k/d"), "junction");
    const r = runCli(["sync", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ingredients/skills/k/d: a link to a directory — craftar does not follow it inside an ingredient; replace it with the files");
    expect(r.stderr).not.toContain("EISDIR");
  });

  posixIt("E: a remote Forge whose commit holds a relative link climbing out reads nothing", async () => {
    const f = await remoteForge({
      ingredients: [{ meta: { type: "skill", name: "k", layout: "dir" }, files: { "SKILL.md": "---\nname: k\ndescription: d\n---\nDo.\n" } }],
      recipes: [recipe("acme", ["skill/k"])],
      profiles: [profile("acme", ["acme"])],
    });
    cleanups.push(() => f.cleanup());
    await fs.symlink("../".repeat(8) + "secret.txt", path.join(f.src, "ingredients/skills/k/link.txt"));
    git(f.src, "add", "-A");
    git(f.src, "commit", "-q", "-m", "link");
    git(f.src, "push", "-q", "origin", "main");
    const root = await tmpDir("craftar-remote-ws-");
    cleanups.push(() => removeWithRetry(root));
    const home = path.join(root, "home");
    await fs.mkdir(home);
    const ws = path.join(root, "ws");
    await writeFiles(ws, { "craftar.yaml": `forge: ${f.url}\nprofile: acme\n` });
    // Eight levels up from the skill in the cache's tree (k, skills, ingredients, <commit>, trees, <key>, forges, home) is `root`.
    await fs.writeFile(path.join(root, "secret.txt"), SECRET);
    const r = runCli(["sync", "--workspace", ws], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ingredients/skills/k/link.txt: a symbolic link out of the Forge");
    expect(r.stderr).not.toContain(SECRET);
    await expect(fs.lstat(path.join(ws, ".claude/skills/k/link.txt"))).rejects.toThrow();
  });

  posixIt("O: a file link to the Forge's own .git/config is refused, though it stays inside", async () => {
    const s = await base();
    await fs.mkdir(path.join(s.forgeRoot, ".git"));
    await fs.writeFile(path.join(s.forgeRoot, ".git/config"), `[remote "origin"]\nurl = ${SECRET}\n`);
    await fs.symlink(path.join(s.forgeRoot, ".git/config"), path.join(s.forgeRoot, "ingredients/skills/k/c.txt"));
    const r = runCli(["sync", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ingredients/skills/k/c.txt: a symbolic link into the Forge's .git");
    await nothingOut(s, r);
  });

  posixIt("P: a FIFO in a directory skill fails in words and returns", { timeout: 20000 }, async () => {
    const s = await base();
    execFileSync("mkfifo", [path.join(s.forgeRoot, "ingredients/skills/k/p")]);
    const r = runCli(["sync", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ingredients/skills/k/p: not a regular file — craftar does not read it; remove it");
  });

  posixIt("D: a file link inside the Forge is read as before", async () => {
    const s = await base();
    await writeFiles(s.forgeRoot, { "shared/n.txt": "A note.\n" });
    await fs.symlink(path.join(s.forgeRoot, "shared/n.txt"), path.join(s.forgeRoot, "ingredients/skills/k/n.txt"));
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    expect(await fs.readFile(path.join(s.wsRoot, ".claude/skills/k/n.txt"), "utf8")).toBe("A note.\n");
  });

  posixIt("a link nothing reads is not refused by sync, and is by forge variants", async () => {
    const s = await base();
    const { file } = await outsideFile();
    // A rule's only emitted file is its body: this one no target emits.
    await fs.symlink(file, path.join(s.forgeRoot, "ingredients/rules/r--acme/unread.txt"));
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    const v = runCli(["forge", "variants", "--forge", s.forgeRoot]);
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("ingredients/rules/r--acme/unread.txt: a symbolic link out of the Forge");
    await nothingOut(s, v);
  });

  it("T: a declared file that climbs out, with no link, keeps its message", async () => {
    const s = await scenario(
      {
        ingredients: [{ meta: { type: "rule", name: "r", file: "../../../secret.md" }, files: {} }],
        recipes: [recipe("acme", ["rule/r"])],
        profiles: [profile("acme", ["acme"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    await fs.writeFile(path.join(s.forgeRoot, "secret.md"), SECRET);
    const r = runCli(["sync", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("declares a file outside its directory");
    await nothingOut(s, r);
  });
});

describe("loadForge", () => {
  posixIt("J: a profile.yaml linked out fails the load, for every profile", async () => {
    const s = await base();
    const { file } = await outsideFile();
    await replaceWithLink(file, path.join(s.forgeRoot, "profiles/globex/profile.yaml"));
    const r = runCli(["sync", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("profiles/globex/profile.yaml: a symbolic link out of the Forge");
    await nothingOut(s, r);
  });

  posixIt("an ingredient.yaml and a recipe linked out fail the load", async () => {
    for (const rel of ["ingredients/rules/r/ingredient.yaml", "recipes/base.yaml"]) {
      const s = await base();
      const { file } = await outsideFile();
      await replaceWithLink(file, path.join(s.forgeRoot, rel));
      const r = runCli(["sync", "--workspace", s.wsRoot]);
      expect(r.code, rel).toBe(1);
      expect(r.stderr, rel).toContain(`${rel}: a symbolic link out of the Forge`);
      await nothingOut(s, r);
    }
  });

  posixIt("a dangling ingredient.yaml or profile.yaml fails the load where it was skipped", async () => {
    for (const rel of ["ingredients/rules/r/ingredient.yaml", "profiles/globex/profile.yaml"]) {
      const s = await base();
      await replaceWithLink(path.join(s.forgeRoot, "gone.yaml"), path.join(s.forgeRoot, rel));
      const r = runCli(["sync", "--workspace", s.wsRoot]);
      expect(r.code, rel).toBe(1);
      expect(r.stderr, rel).toContain(`${rel}: a symbolic link that leads nowhere — fix or remove it`);
    }
  });

  it("a root ingredients directory linked out with files in it fails the load", async () => {
    const s = await base();
    const moved = await tmpDir("craftar-moved-");
    cleanups.push(() => fs.rm(moved, { recursive: true, force: true }));
    await fs.rename(path.join(s.forgeRoot, "ingredients"), path.join(moved, "ingredients"));
    await fs.symlink(path.join(moved, "ingredients"), path.join(s.forgeRoot, "ingredients"), "junction");
    const r = runCli(["sync", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("a symbolic link out of the Forge");
    expect(r.stderr).not.toContain(moved);
  });
});

describe("the tools that read whole directories", () => {
  posixIt("Q: forge diff, forge variants, forge unify and forge promote refuse a variant's body linked out", async () => {
    const s = await base();
    const { file } = await outsideFile();
    await replaceWithLink(file, path.join(s.forgeRoot, "ingredients/rules/r--acme/rule.md"));
    git0(s.forgeRoot);
    for (const args of [
      ["forge", "diff", "rule/r", "--forge", s.forgeRoot],
      ["forge", "variants", "--forge", s.forgeRoot],
      ["forge", "unify", "rule/r", "--profile", "acme", "--take", "base", "--forge", s.forgeRoot, "--no-impact"],
      ["forge", "promote", "rule/r", "--profile", "acme", "--forge", s.forgeRoot, "--no-impact"],
    ]) {
      const r = runCli(args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toContain("ingredients/rules/r--acme/rule.md: a symbolic link out of the Forge");
      await nothingOut(s, r);
    }
    expect(await fs.readFile(file, "utf8")).toBe(SECRET);
  });

  posixIt("R: import with a Forge body linked out and a workspace rule of the same text is refused, not reused", async () => {
    const s = await base();
    const { file } = await outsideFile();
    await replaceWithLink(file, path.join(s.forgeRoot, "ingredients/rules/r/rule.md"));
    await writeFiles(s.wsRoot, { ".claude/rules/r.md": SECRET });
    const r = runCli(["import", "--from", "claude-code", "--workspace", s.wsRoot, "--forge", s.forgeRoot, "--profile", "globex"]);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("reused");
    expect(r.stderr).toContain("a symbolic link out of the Forge");
    expect(r.stderr + r.stdout).not.toContain(MARK);
  });
});

function git0(dir: string) {
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "forge");
}
