import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, scenario, tmpDir, writeFiles } from "./helpers/forge.js";

/** Spec 48 Part B: what craftar writes, removes or shows from a workspace has a real path inside it. The "private" file is synthetic. */

const SECRET = "OUTSIDE-CONTENT-48";
const MARK = "private-outside";
const RULE = ".claude/rules/r.md";
const LEAVES = `${RULE} leaves the workspace through a symbolic link`;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const posixIt = it.skipIf(process.platform === "win32");

async function outside(): Promise<{ dir: string; file: string }> {
  const base = await tmpDir("craftar-outside-");
  cleanups.push(() => fs.rm(base, { recursive: true, force: true }));
  const dir = path.join(base, MARK);
  await fs.mkdir(dir);
  const file = path.join(dir, "secret.txt");
  await fs.writeFile(file, SECRET);
  return { dir, file };
}

async function base(extra: { files?: Record<string, string> } = {}) {
  const s = await scenario(
    {
      ingredients: [rule("r", "# R\nBody.\n"), rule("other", "# Other\n")],
      recipes: [recipe("base", ["rule/r"]), recipe("more", ["rule/other"])],
      profiles: [profile("acme", ["base"])],
    },
    { config: { profile: "acme" }, files: extra.files },
  );
  cleanups.push(s.cleanup);
  return s;
}
type S = Awaited<ReturnType<typeof base>>;
const W = (s: S) => ["--workspace", s.wsRoot];
const NO_PROGRAMS = async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-no-programs-"));
  cleanups.push(() => fs.rm(d, { recursive: true, force: true }));
  return { PATH: d, Path: d };
};

/** `.claude/rules/r.md`, a file link to the private file. */
async function linkedRule(s: S, target: string) {
  await fs.mkdir(path.join(s.wsRoot, ".claude/rules"), { recursive: true });
  await fs.rm(path.join(s.wsRoot, RULE), { force: true });
  await fs.symlink(target, path.join(s.wsRoot, RULE));
}

const quiet = (r: { stdout: string; stderr: string }) => {
  expect(r.stdout + r.stderr).not.toContain(SECRET);
  expect(r.stdout + r.stderr).not.toContain(MARK);
};

describe("sync writes and removes nothing through a link that leaves", () => {
  posixIt("F: a dangling link to outside is not created", async () => {
    const s = await base();
    const { dir } = await outside();
    const target = path.join(dir, "created-by-sync.md");
    await linkedRule(s, target);
    const r = runCli(["sync", ...W(s)]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${RULE} is a symbolic link that leads nowhere — fix or remove it`);
    expect(r.stderr).toContain("nothing written");
    quiet(r);
    await expect(fs.lstat(target)).rejects.toThrow();
    await expect(fs.lstat(path.join(s.wsRoot, "craftar.lock"))).rejects.toThrow();
  });

  posixIt("a dangling link pointing inside is refused too", async () => {
    const s = await base();
    await linkedRule(s, path.join(s.wsRoot, "nowhere.md"));
    const r = runCli(["sync", ...W(s)]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("leads nowhere");
    await expect(fs.lstat(path.join(s.wsRoot, "nowhere.md"))).rejects.toThrow();
  });

  it("G: a generated folder linked out is not written", async () => {
    const s = await base();
    const { dir } = await outside();
    await fs.mkdir(path.join(s.wsRoot, ".claude"));
    await fs.symlink(dir, path.join(s.wsRoot, ".claude/rules"), "junction");
    const r = runCli(["sync", ...W(s)]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(LEAVES);
    quiet(r);
    expect(await fs.readdir(dir)).toEqual(["secret.txt"]);
  });

  it("G's orphan pass: files behind a parent that now leaves are not removed", async () => {
    const s = await base();
    expect(runCli(["sync", ...W(s)]).code).toBe(0);
    const { dir } = await outside();
    await fs.copyFile(path.join(s.wsRoot, RULE), path.join(dir, "r.md"));
    await fs.rm(path.join(s.wsRoot, ".claude/rules"), { recursive: true });
    await fs.symlink(dir, path.join(s.wsRoot, ".claude/rules"), "junction");
    // The Forge stops producing the rule, so its lock entry is an orphan behind the link.
    await writeFiles(s.forgeRoot, { "recipes/base.yaml": "name: base\ningredients: [rule/other]\n" });
    await fs.mkdir(path.join(s.wsRoot, ".claude/keep"), { recursive: true });
    const r = runCli(["sync", ...W(s)]);
    expect(r.code).toBe(1);
    quiet(r);
    expect((await fs.readdir(dir)).sort()).toEqual(["r.md", "secret.txt"]);
  });

  it("an orphan with nothing behind it does not refuse the run", async () => {
    const s = await base();
    expect(runCli(["sync", ...W(s)]).code).toBe(0);
    const { dir } = await outside();
    await fs.rm(path.join(s.wsRoot, ".claude/rules"), { recursive: true });
    // Nothing named r.md behind the link, and the Forge produces other files only, written elsewhere.
    await writeFiles(s.forgeRoot, {
      "recipes/base.yaml": "name: base\ningredients: [skill/k]\n",
      "ingredients/skills/k/ingredient.yaml": "type: skill\nname: k\nlayout: dir\n",
      "ingredients/skills/k/SKILL.md": "---\nname: k\ndescription: d\n---\nDo.\n",
    });
    await fs.symlink(dir, path.join(s.wsRoot, ".claude/rules"), "junction");
    const r = runCli(["sync", ...W(s)]);
    expect(r.code, r.stderr).toBe(0);
    expect(await fs.readdir(dir)).toEqual(["secret.txt"]);
  });

  posixIt("H: a file link out with a lock entry and a Forge that moved is not rewritten", async () => {
    const s = await base();
    expect(runCli(["sync", ...W(s)]).code).toBe(0);
    const { file } = await outside();
    const rendered = await fs.readFile(path.join(s.wsRoot, RULE));
    await fs.writeFile(file, rendered);
    await linkedRule(s, file);
    await writeFiles(s.forgeRoot, { "ingredients/rules/r/rule.md": "# R\nMoved.\n" });
    const r = runCli(["sync", "--overwrite-drift", ...W(s)]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(LEAVES);
    expect((await fs.readFile(file)).equals(rendered)).toBe(true);
    expect(r.stdout + r.stderr).not.toContain(MARK);
  });

  posixIt("drift discard goes through the same gate", async () => {
    const s = await base();
    expect(runCli(["sync", ...W(s)]).code).toBe(0);
    const { file } = await outside();
    await linkedRule(s, file);
    const r = runCli(["drift", "discard", RULE, ...W(s)]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(LEAVES);
    expect(await fs.readFile(file, "utf8")).toBe(SECRET);
    quiet(r);
  });

  it("--dry-run is refused too", async () => {
    const s = await base();
    const { dir } = await outside();
    await fs.mkdir(path.join(s.wsRoot, ".claude"));
    await fs.symlink(dir, path.join(s.wsRoot, ".claude/rules"), "junction");
    expect(runCli(["sync", "--dry-run", ...W(s)]).code).toBe(1);
  });

  it("V: a link into the workspace's .git is refused, and .git/hooks stays as it was", async () => {
    const s = await base();
    await fs.mkdir(path.join(s.wsRoot, ".git/hooks"), { recursive: true });
    await fs.mkdir(path.join(s.wsRoot, ".claude"));
    await fs.symlink(path.join(s.wsRoot, ".git/hooks"), path.join(s.wsRoot, ".claude/rules"), "junction");
    const r = runCli(["sync", ...W(s)]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${RULE} is a symbolic link into the workspace's .git — craftar does not follow it; replace it`);
    expect(await fs.readdir(path.join(s.wsRoot, ".git/hooks"))).toEqual([]);
  });

  posixIt("V: diff shows nothing of a .git/config a rule links to", async () => {
    const s = await base();
    await writeFiles(s.wsRoot, { ".git/config": `[remote "origin"]\nurl = ${SECRET}\n` });
    await linkedRule(s, path.join(s.wsRoot, ".git/config"));
    const r = runCli(["diff", ...W(s)]);
    quiet(r);
    expect(r.stdout).toContain("content not shown");
  });

  it("K: a generated folder linked inside works as before", async () => {
    const s = await base();
    await fs.mkdir(path.join(s.wsRoot, "kept"));
    await fs.mkdir(path.join(s.wsRoot, ".claude"));
    await fs.symlink(path.join(s.wsRoot, "kept"), path.join(s.wsRoot, ".claude/rules"), "junction");
    expect(runCli(["sync", ...W(s)]).code).toBe(0);
    expect(await fs.readFile(path.join(s.wsRoot, "kept/r.md"), "utf8")).toContain("Body.");
  });

  it("a workspace named through a link is its real path: nothing escapes", async () => {
    const s = await base();
    const via = path.join(s.root, "via");
    await fs.symlink(s.wsRoot, via, "junction");
    const r = runCli(["sync", "--workspace", via]);
    expect(r.code, r.stderr).toBe(0);
  });
});

describe("craftar.lock", () => {
  posixIt("I: a lock linked out is neither read nor written through", async () => {
    const s = await base();
    expect(runCli(["sync", ...W(s)]).code).toBe(0);
    const { file } = await outside();
    await fs.rm(path.join(s.wsRoot, "craftar.lock"));
    await fs.symlink(file, path.join(s.wsRoot, "craftar.lock"));
    await writeFiles(s.forgeRoot, { "ingredients/rules/r/rule.md": "# R\nMoved.\n" });
    for (const args of [["sync"], ["status"], ["diff"], ["sync", "--check"]]) {
      const r = runCli([...args, ...W(s)]);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toContain("craftar.lock leaves the workspace through a symbolic link — replace it with a file");
      quiet(r);
    }
    expect(await fs.readFile(file, "utf8")).toBe(SECRET);
  });

  posixIt("a dangling lock is not read as no lock", async () => {
    const s = await base();
    await fs.symlink(path.join(s.wsRoot, "gone"), path.join(s.wsRoot, "craftar.lock"));
    const r = runCli(["sync", ...W(s)]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("craftar.lock is a symbolic link that leads nowhere — fix or remove it");
    await expect(fs.lstat(path.join(s.wsRoot, "gone"))).rejects.toThrow();
  });

  posixIt("a lock linked into .git is neither read nor written through", async () => {
    const s = await base();
    await writeFiles(s.wsRoot, { ".git/lock-here": "{}" });
    await fs.symlink(path.join(s.wsRoot, ".git/lock-here"), path.join(s.wsRoot, "craftar.lock"));
    const r = runCli(["sync", ...W(s)]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("craftar.lock is a symbolic link into the workspace's .git — replace it with a file");
    expect(await fs.readFile(path.join(s.wsRoot, ".git/lock-here"), "utf8")).toBe("{}");
  });

  posixIt("doctor reports it in the lock check", async () => {
    const s = await base();
    const { file } = await outside();
    await fs.symlink(file, path.join(s.wsRoot, "craftar.lock"));
    const r = runCli(["doctor", "--json", ...W(s)], { env: await NO_PROGRAMS() });
    const lock = JSON.parse(r.stdout).checks.find((c: { id: string }) => c.id === "lock");
    expect(lock.level).toBe("error");
    expect(lock.message).toContain("leaves the workspace");
    quiet(r);
  });
});

describe("craftar.yaml", () => {
  posixIt("S: add recipe does not write through a link out, and reads through it", async () => {
    const s = await base();
    const { dir } = await outside();
    const cfg = path.join(dir, "craftar.yaml");
    const text = (await fs.readFile(path.join(s.wsRoot, "craftar.yaml"), "utf8")).replace(/forge: .*/, `forge: ${s.forgeRoot.replace(/\\/g, "/")}`);
    await fs.writeFile(cfg, text);
    await fs.rm(path.join(s.wsRoot, "craftar.yaml"));
    await fs.symlink(cfg, path.join(s.wsRoot, "craftar.yaml"));
    // A link is fine to be read.
    expect(runCli(["status", ...W(s)]).code).toBe(0);
    for (const args of [["add", "recipe", "more"], ["remove", "recipe", "base"]]) {
      const r = runCli([...args, ...W(s)]);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toContain("craftar.yaml leaves the workspace through a symbolic link — replace it with a file");
      expect(r.stderr).not.toContain(MARK);
    }
    expect(await fs.readFile(cfg, "utf8")).toBe(text);
  });
});

describe("every surface that answers would sync fail", () => {
  async function escaping() {
    const s = await base();
    const { dir, file } = await outside();
    await fs.mkdir(path.join(s.wsRoot, ".claude"));
    await fs.symlink(dir, path.join(s.wsRoot, ".claude/rules"), "junction");
    return { s, dir, file };
  }

  it("sync --check, status and diff --exit-code: the block on stderr, exit 1", async () => {
    const { s } = await escaping();
    for (const args of [["sync", "--check"], ["status"], ["diff", "--exit-code"]]) {
      const r = runCli([...args, ...W(s)]);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toContain(LEAVES);
      quiet(r);
    }
  });

  it("status --json keeps its keys: the reason is a warning, and escapes is no key", async () => {
    const { s } = await escaping();
    const r = runCli(["status", "--json", ...W(s)]);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(Object.keys(j)).toEqual(["forge", "statuses", "warnings", "unsetParams"]);
    expect(j.warnings.join("\n")).toContain(LEAVES);
    const row = j.statuses.find((x: { path: string }) => x.path === RULE);
    expect(row.state).toBe("collision");
    expect(Object.keys(row)).not.toContain("escapes");
  });

  posixIt("N: diff prints nothing of the private file, and exit-code with a path keeps its rule", async () => {
    const s = await base();
    const { file } = await outside();
    await linkedRule(s, file);
    const r = runCli(["diff", ...W(s)]);
    quiet(r);
    expect(r.stdout).toContain("content not shown");
    expect(r.code).toBe(0);
    const st = runCli(["status", ...W(s)]);
    quiet(st);
  });

  it("drift show: its listing, then the block; not promotable, and under --json the line in warnings", async () => {
    const s = await base();
    expect(runCli(["sync", ...W(s)]).code).toBe(0);
    const { dir } = await outside();
    await fs.writeFile(path.join(dir, "r.md"), SECRET);
    await fs.rm(path.join(s.wsRoot, ".claude/rules"), { recursive: true });
    await fs.symlink(dir, path.join(s.wsRoot, ".claude/rules"), "junction");
    const t = runCli(["drift", "show", ...W(s)]);
    expect(t.code).toBe(1);
    expect(t.stdout).toContain("promote: no (leaves the workspace through a symbolic link)");
    expect(t.stderr).toContain(LEAVES);
    quiet(t);
    const named = runCli(["drift", "show", RULE, ...W(s)]);
    quiet(named);
    const j = runCli(["drift", "show", "--json", ...W(s)]);
    expect(j.code).toBe(1);
    const o = JSON.parse(j.stdout);
    expect(o.files[0]).toMatchObject({ path: RULE, promotable: false, reason: "leaves the workspace through a symbolic link" });
    expect(o.warnings.join("\n")).toContain(LEAVES);
    quiet(j);
  });

  it("an orphan-drift behind a link: drift show shows no body", async () => {
    const s = await base();
    expect(runCli(["sync", ...W(s)]).code).toBe(0);
    const { dir } = await outside();
    await fs.writeFile(path.join(dir, "r.md"), SECRET);
    await fs.rm(path.join(s.wsRoot, ".claude/rules"), { recursive: true });
    await fs.symlink(dir, path.join(s.wsRoot, ".claude/rules"), "junction");
    await writeFiles(s.forgeRoot, { "recipes/base.yaml": "name: base\ningredients: [rule/other]\n" });
    const r = runCli(["drift", "show", RULE, ...W(s)]);
    quiet(r);
    expect(r.stdout).toContain("content not shown");
    quiet(runCli(["diff", ...W(s)]));
  });

  it("add recipe and init --no-sync: next sync reads refused", async () => {
    const { s } = await escaping();
    const r = runCli(["add", "recipe", "more", ...W(s)]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("next sync: refused — ");
    expect(r.stdout).toContain("leaves the workspace");
    quiet(r);
  });

  it("init: craftar.yaml written, no sync, exit 1, and its block says so", async () => {
    const s = await base();
    const { dir } = await outside();
    const ws = path.join(s.root, "fresh");
    await fs.mkdir(path.join(ws, ".claude"), { recursive: true });
    await fs.symlink(dir, path.join(ws, ".claude/rules"), "junction");
    const r = runCli(["init", "--forge", s.forgeRoot, "--profile", "acme", "--workspace", ws]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("craftar.yaml written, sync not run");
    expect(r.stderr).toContain("then run craftar sync");
    expect(await fs.readdir(dir)).toEqual(["secret.txt"]);
    await fs.access(path.join(ws, "craftar.yaml"));
    const n = path.join(s.root, "fresh2");
    await fs.mkdir(path.join(n, ".claude"), { recursive: true });
    await fs.symlink(dir, path.join(n, ".claude/rules"), "junction");
    const no = runCli(["init", "--forge", s.forgeRoot, "--profile", "acme", "--workspace", n, "--no-sync"]);
    expect(no.code).toBe(0);
    expect(no.stdout).toContain("next sync: refused — ");
  });

  it("doctor: workspace-links at error, one per path, and status leaves those rows out", async () => {
    const { s } = await escaping();
    const r = runCli(["sync", ...W(s)]);
    expect(r.code).toBe(1);
    const d = runCli(["doctor", "--json", ...W(s)], { env: await NO_PROGRAMS() });
    expect(d.code).toBe(1);
    const checks = JSON.parse(d.stdout).checks as Array<{ id: string; level: string; message: string }>;
    const links = checks.filter((c) => c.id === "workspace-links");
    expect(links).toHaveLength(1);
    expect(links[0].level).toBe("error");
    expect(links[0].message).toContain(LEAVES);
    quiet(d);
  });

  it("doctor: with a lock, the status check counts only the other rows, and no escape means no check", async () => {
    const s = await base();
    const clean = runCli(["doctor", "--json", ...W(s)], { env: await NO_PROGRAMS() });
    expect(JSON.parse(clean.stdout).checks.map((c: { id: string }) => c.id)).not.toContain("workspace-links");
    expect(runCli(["sync", ...W(s)]).code).toBe(0);
    const { dir } = await outside();
    await fs.writeFile(path.join(dir, "r.md"), SECRET);
    await fs.rm(path.join(s.wsRoot, ".claude/rules"), { recursive: true });
    await fs.symlink(dir, path.join(s.wsRoot, ".claude/rules"), "junction");
    const d = runCli(["doctor", "--json", ...W(s)], { env: await NO_PROGRAMS() });
    const checks = JSON.parse(d.stdout).checks as Array<{ id: string; level: string; message: string }>;
    expect(checks.find((c) => c.id === "status")).toMatchObject({ level: "ok", message: "up to date" });
    expect(checks.map((c) => c.id)).toContain("workspace-links");
  });

  it("workspaces and forge impact: error, with the one reason", async () => {
    const s = await base();
    expect(runCli(["sync", ...W(s)]).code).toBe(0);
    const { dir } = await outside();
    await fs.writeFile(path.join(dir, "r.md"), SECRET);
    await fs.rm(path.join(s.wsRoot, ".claude/rules"), { recursive: true });
    await fs.symlink(dir, path.join(s.wsRoot, ".claude/rules"), "junction");
    const w = runCli(["workspaces", "--json"]);
    const row = JSON.parse(w.stdout).workspaces.find((x: { path: string }) => x.path.endsWith(path.basename(s.wsRoot)) && x.path.includes(path.basename(s.root)));
    expect(row.status).toBe("error");
    expect(JSON.stringify(JSON.parse(w.stdout))).toContain("leaves the workspace");
    quiet(w);
    const i = runCli(["forge", "impact", "--forge", s.forgeRoot, "--json"]);
    const irow = JSON.parse(i.stdout).workspaces[0];
    expect(irow.state).toBe("error");
    expect(irow.error).toContain("leaves the workspace");
    quiet(i);
  });
});

describe("craftar.yaml and CLAUDE.md stay links to be read (spec 48 §5 edge 5)", () => {
  posixIt("a CLAUDE.md link out is no refusal: nothing is written there", async () => {
    const s = await base();
    const { file } = await outside();
    await fs.symlink(file, path.join(s.wsRoot, "CLAUDE.md"));
    const r = runCli(["sync", ...W(s)]);
    expect(r.code).toBe(0);
    expect(await fs.readFile(file, "utf8")).toBe(SECRET);
    quiet(r);
  });
});

describe("the other surfaces", () => {
  async function rows() {
    const s = await base();
    expect(runCli(["sync", ...W(s)]).code).toBe(0);
    const { dir } = await outside();
    await fs.writeFile(path.join(dir, "r.md"), SECRET);
    await fs.rm(path.join(s.wsRoot, ".claude/rules"), { recursive: true });
    await fs.symlink(dir, path.join(s.wsRoot, ".claude/rules"), "junction");
    return { s, dir };
  }

  async function session(s: S, writers: boolean) {
    const home = process.env.CRAFTAR_HOME!;
    const { readWorkspaceConfig } = await import("../src/core/sync.js");
    const { handleLine, pinOf } = await import("../src/core/mcp-protocol.js");
    const { mcpWriters } = await import("../src/core/write-actions.js");
    const { allowWrites } = await import("../src/core/registry.js");
    const config = await readWorkspaceConfig(s.wsRoot);
    const pin = pinOf(config);
    if (writers) await allowWrites(home, s.wsRoot, { forge: { source: "../forge", ref: null }, profile: "acme" });
    const ctx = { root: s.wsRoot, fetch: false, home, version: "9.9.9", registryOff: false, env: {}, pin, ...(writers ? { writers: mcpWriters(home, false) } : {}) };
    const state = { initialized: false };
    const request = async (method: string, params?: unknown) => {
      const out = await handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }), ctx as never, state as never);
      return JSON.parse(out!);
    };
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    return (name: string, args?: Record<string, unknown>) => request("tools/call", { name, ...(args ? { arguments: args } : {}) }).then((a) => a.result);
  }

  it("N: the diff and status tools of craftar mcp return nothing of the file, and say why", async () => {
    const { s } = await rows();
    const tool = await session(s, false);
    for (const [name, args] of [["diff", { path: RULE }], ["diff", undefined], ["status", undefined]] as const) {
      const a = JSON.stringify(await tool(name, args as never));
      expect(a).not.toContain(SECRET);
      expect(a).not.toContain(MARK);
      expect(a).toContain("leaves the workspace through a symbolic link");
    }
  });

  it("the writing tools: sync answers a tool error, add_recipe says next sync refused", async () => {
    const { s, dir } = await rows();
    const tool = await session(s, true);
    const sync = await tool("sync");
    expect(sync.isError).toBe(true);
    expect(JSON.stringify(sync)).toContain("leaves the workspace through a symbolic link");
    expect(await fs.readFile(path.join(dir, "r.md"), "utf8")).toBe(SECRET);
    const add = await tool("add_recipe", { names: ["more"] });
    expect(JSON.stringify(add)).toContain("next sync: refused — ");
  });

  it("craftar ui: refused on the workspace answer, nothing in the diff route, both writing routes refused", async () => {
    const { s, dir } = await rows();
    const { get, post } = await import("./helpers/ui.js");
    const { workspaceId } = await import("../src/ui/routes.js");
    const id = workspaceId(await fs.realpath(s.wsRoot));
    const w = await get(`/api/workspaces/${id}`, { allowWrites: true });
    const body = w.body as { refused: string; digest: string };
    expect(body.refused).toContain("leaves the workspace through a symbolic link");
    expect(JSON.stringify(body)).not.toContain(SECRET);
    const d = await get(`/api/workspaces/${id}/diff?path=${encodeURIComponent(RULE)}`, { allowWrites: true });
    expect(JSON.stringify(d.body)).not.toContain(SECRET);
    expect(JSON.stringify(d.body)).not.toContain(MARK);
    const sync = await post(`/api/workspaces/${id}/sync`, { digest: body.digest });
    expect(sync.status).toBe(409);
    expect(JSON.stringify(sync.body)).toContain("leaves the workspace");
    const discard = await post(`/api/workspaces/${id}/discard`, { digest: body.digest, path: RULE });
    expect(discard.status).toBe(409);
    expect(await fs.readFile(path.join(dir, "r.md"), "utf8")).toBe(SECRET);
  });

  it("services: up refuses a recorded file behind a link, status reports it as link, and nothing goes to Docker", async () => {
    const s = await scenario(
      {
        ingredients: [{ meta: { type: "service", name: "echo" }, files: { "compose.yaml": "services:\n  echo:\n    image: example/echo:1\n" } }],
        recipes: [recipe("base", ["service/echo"])],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    const { dir } = await outside();
    await fs.copyFile(path.join(s.wsRoot, ".craftar/services/echo/compose.yaml"), path.join(dir, "compose.yaml"));
    await fs.rm(path.join(s.wsRoot, ".craftar/services/echo"), { recursive: true });
    await fs.symlink(dir, path.join(s.wsRoot, ".craftar/services/echo"), "junction");
    const env = await NO_PROGRAMS();
    const up = runCli(["services", "up", "--workspace", s.wsRoot], { env });
    expect(up.code).toBe(1);
    expect(up.stderr).toContain(".craftar/services/echo/compose.yaml is a symbolic link craftar does not follow — replace it with a file");
    expect(up.stderr).not.toContain("docker not found");
    const st = runCli(["services", "status", "--json", "--workspace", s.wsRoot], { env });
    expect(JSON.parse(st.stdout).pending).toContainEqual({ path: ".craftar/services/echo/compose.yaml", reason: "link" });
  });

  posixIt("U: drift promote refuses an ingredient holding a file that leaves, the Forge untouched, also under --dry-run", async () => {
    const s = await scenario(
      {
        ingredients: [{ meta: { type: "skill", name: "k", layout: "dir" }, files: { "SKILL.md": "---\nname: k\ndescription: d\n---\nDo.\n" } }],
        recipes: [recipe("base", ["skill/k"])],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    const { git } = await import("./helpers/remote.js");
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q", "-b", "main", s.forgeRoot]);
    git(s.forgeRoot, "add", "-A");
    git(s.forgeRoot, "commit", "-q", "-m", "forge");
    expect(runCli(["sync", ...W(s as S)]).code).toBe(0);
    const { file } = await outside();
    await fs.writeFile(path.join(s.wsRoot, ".claude/skills/k/SKILL.md"), "---\nname: k\ndescription: d\n---\nEdited.\n");
    await fs.symlink(file, path.join(s.wsRoot, ".claude/skills/k/note.txt"));
    for (const flags of [["--dry-run"], []]) {
      const r = runCli(["drift", "promote", ".claude/skills/k/SKILL.md", ...W(s as S), ...flags]);
      expect(r.code, flags.join()).toBe(1);
      expect(r.stderr).toContain(".claude/skills/k/note.txt leaves the workspace through a symbolic link");
      quiet(r);
      expect(git(s.forgeRoot, "status", "--porcelain")).toBe("");
    }
  });

  posixIt("drift promote on the path that escapes is refused, before anything is read", async () => {
    const s = await base();
    const { execFileSync } = await import("node:child_process");
    const { git } = await import("./helpers/remote.js");
    execFileSync("git", ["init", "-q", "-b", "main", s.forgeRoot]);
    git(s.forgeRoot, "add", "-A");
    git(s.forgeRoot, "commit", "-q", "-m", "forge");
    expect(runCli(["sync", ...W(s)]).code).toBe(0);
    const { file } = await outside();
    await linkedRule(s, file);
    const r = runCli(["drift", "promote", RULE, ...W(s)]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(LEAVES);
    quiet(r);
  });

  posixIt("S: import --write-config does not write through a craftar.yaml that leaves, with the Forge untouched", async () => {
    const s = await base();
    const { file } = await outside();
    await fs.rm(path.join(s.wsRoot, "craftar.yaml"));
    await fs.symlink(file, path.join(s.wsRoot, "craftar.yaml"));
    await writeFiles(s.wsRoot, { ".claude/rules/fresh.md": "# Fresh\n" });
    const forge = path.join(s.root, "new-forge");
    const r = runCli(["import", "--from", "claude-code", "--workspace", s.wsRoot, "--forge", forge, "--profile", "acme", "--write-config"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("craftar.yaml leaves the workspace through a symbolic link — replace it with a file");
    expect(await fs.readFile(file, "utf8")).toBe(SECRET);
    await expect(fs.lstat(forge)).rejects.toThrow();
    quiet(r);
  });
});

describe("init --clone", () => {
  it("clones nothing when a path of the first sync leaves the workspace", async () => {
    const { fakeGit } = await import("./helpers/fake-git.js");
    const fg = await fakeGit();
    cleanups.push(fg.cleanup);
    const s = await scenario(
      {
        ingredients: [rule("r", "# R\n")],
        recipes: [recipe("base", ["rule/r"])],
        profiles: [profile("acme", ["base"], ["claude-code"], { repos: [{ name: "app", url: "https://example.invalid/acme/app.git" }] })],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    const { dir } = await outside();
    const ws = path.join(s.root, "fresh");
    await fs.mkdir(path.join(ws, ".claude"), { recursive: true });
    await fs.symlink(dir, path.join(ws, ".claude/rules"), "junction");
    const r = runCli(["init", "--forge", s.forgeRoot, "--profile", "acme", "--workspace", ws, "--clone"], { env: fg.env() });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(LEAVES);
    await expect(fs.lstat(path.join(ws, "app"))).rejects.toThrow();
    await expect(fs.readFile(fg.log, "utf8")).rejects.toThrow();
    // Under --no-sync the first sync is not run, and it is still the sync that would be refused.
    const n = path.join(s.root, "fresh2");
    await fs.mkdir(path.join(n, ".claude"), { recursive: true });
    await fs.symlink(dir, path.join(n, ".claude/rules"), "junction");
    const no = runCli(["init", "--forge", s.forgeRoot, "--profile", "acme", "--workspace", n, "--clone", "--no-sync"], { env: fg.env() });
    expect(no.stdout).toContain("next sync: refused — ");
    await expect(fs.lstat(path.join(n, "app"))).rejects.toThrow();
  });
});
