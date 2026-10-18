import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { againLine, askClone, askInit, confirmInit, type InitAnswers, type InitIo } from "../src/core/init-flow.js";
import { planInit } from "../src/core/init.js";
import { loadWorkspace } from "../src/core/sync.js";
import { makeForge, profile, recipe, rule, tmpDir } from "./helpers/forge.js";
import { runCli } from "./helpers/cli.js";
import { git, remoteForge } from "./helpers/remote.js";

// Spec 37 §4.2–§4.3, §5.2 — planInit with clone, askClone, confirmInit's clone questions, the again line, and
// LoadOptions.fetchHint (R4's tail). Nothing here runs git clone.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const REPOS = [
  { name: "portal-api", url: "https://git.example.com/acme/portal-api.git" },
  { name: "portal-web", url: "git@git.example.com:acme/portal-web.git", path: "apps/portal-web", ref: "release" },
];

async function setup(opts: { repos?: unknown[]; declared?: boolean } = {}) {
  const parent = await fs.realpath(await tmpDir("craftar-init-clone-"));
  cleanups.push(() => fs.rm(parent, { recursive: true, force: true }));
  const forge = path.join(parent, "forge");
  const extra = opts.declared ? { params: { token: { description: "a value nobody set" } } } : {};
  await makeForge(forge, {
    ingredients: [rule("a", opts.declared ? "# A {{token}}\n" : "# A\n", extra)],
    recipes: [recipe("base", ["rule/a"])],
    profiles: [profile("acme", ["base"], ["claude-code"], { repos: opts.repos ?? REPOS })],
  });
  const ws = path.join(parent, "ws");
  return { parent, forge, ws };
}

function script(answers: Array<string | null>) {
  const said: string[] = [];
  const confirmed: string[] = [];
  const io: InitIo = {
    ask: async (q) => {
      throw new Error(`unexpected ask: ${q}`);
    },
    confirm: async (q) => {
      confirmed.push(q);
      if (!answers.length) throw new Error(`no scripted answer left for: ${q}`);
      return answers.shift()!;
    },
    say: (l) => void said.push(l),
  };
  return { io, said, confirmed, left: () => answers.length };
}
const GIT = "/usr/bin/git";

describe("planInit with clone (C3–C5 through planClone)", () => {
  it("clone: the entries, in order, in InitPlan.repos; without it, repos is []", async () => {
    const s = await setup();
    const withClone = await planInit(s.ws, { forge: s.forge, profile: "acme", clone: true });
    expect(withClone.repos.map((e) => [e.name, e.path, e.ref])).toEqual([
      ["portal-api", "portal-api", null],
      ["portal-web", "apps/portal-web", "release"],
    ]);
    const without = await planInit(s.ws, { forge: s.forge, profile: "acme" });
    expect(without.repos).toEqual([]);
  });
  it("C3: no entry", async () => {
    const s = await setup({ repos: [] });
    await expect(planInit(s.ws, { forge: s.forge, profile: "acme", clone: true })).rejects.toThrow(
      /^profile acme lists no repositories — nothing to clone; drop --clone$/,
    );
  });
  it("C4: a block that does not read — only when cloning is asked for", async () => {
    const s = await setup({ repos: [{ name: "a", url: "file:///srv/a.git" }] });
    await expect(planInit(s.ws, { forge: s.forge, profile: "acme", clone: true })).rejects.toThrow(/^profile acme: repos\[0\]: url is not an https or ssh git URL$/);
    await expect(planInit(s.ws, { forge: s.forge, profile: "acme" })).resolves.toBeTruthy();
  });
  it("a dot-folder destination (.claude) is refused by profileRepos itself — C4 — before any destination check", async () => {
    const s = await setup({ repos: [{ name: "claude", url: "https://git.example.com/acme/c.git", path: "Claude-Thing/x" }, { name: "x", url: "https://git.example.com/acme/x.git", path: ".claude" }] });
    await expect(planInit(s.ws, { forge: s.forge, profile: "acme", clone: true })).rejects.toThrow(/^profile acme: repos\[1\]: path is not a relative path of plain names$/);
  });
  it("C5: a destination that exists, in a workspace that exists", async () => {
    const s = await setup();
    await fs.mkdir(path.join(s.ws, "portal-api"), { recursive: true });
    await expect(planInit(s.ws, { forge: s.forge, profile: "acme", clone: true })).rejects.toThrow(
      /^cannot clone portal-api: portal-api already exists in the workspace — move it, or leave the clone out$/,
    );
  });
  it("C5: inside the Forge, for a workspace that lies inside its Forge", async () => {
    const s = await setup();
    const ws = path.join(s.forge, "clients", "acme");
    await expect(planInit(ws, { forge: s.forge, profile: "acme", clone: true })).rejects.toThrow(/^cannot clone portal-api: portal-api lies inside the Forge$/);
  });
});

describe("askClone — the list and the question (§4.3)", () => {
  it("the list (name, URL as written, destination, ref) and the question; Enter is no", async () => {
    const s = await setup();
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme" });
    const sc = script([""]);
    const r = await askClone(sc.io, init, { root: s.ws, offline: false, git: GIT });
    expect(r).toEqual({ clone: false, entries: [] });
    expect(sc.said).toEqual([
      "Repositories of acme:",
      "  1) portal-api   https://git.example.com/acme/portal-api.git   → portal-api",
      "  2) portal-web   git@git.example.com:acme/portal-web.git       → apps/portal-web  @ release",
    ]);
    expect(sc.confirmed).toEqual(["Clone them into the workspace [no]: "]);
  });
  it("yes / y clones; no / n does not; anything else re-asks", async () => {
    const s = await setup();
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme" });
    for (const [answers, clone] of [[["y"], true], [["YES"], true], [["n"], false], [["no"], false], [["maybe", "yes"], true]] as const) {
      const sc = script([...answers]);
      const r = await askClone(sc.io, init, { root: s.ws, offline: false, git: GIT });
      expect(r === "cancelled" ? r : r.clone, answers.join(",")).toBe(clone);
      if (r !== "cancelled" && r.clone) expect(r.entries.map((e) => e.name)).toEqual(["portal-api", "portal-web"]);
      expect(sc.left()).toBe(0);
      if (answers.includes("maybe")) expect(sc.said).toContain("answer yes or no");
    }
  });
  it("end of input cancels", async () => {
    const s = await setup();
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme" });
    expect(await askClone(script([null]).io, init, { root: s.ws, offline: false, git: GIT })).toBe("cancelled");
  });
  it("no question: a profile with no entry, and --offline", async () => {
    const s = await setup({ repos: [] });
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme" });
    const sc = script([]);
    expect(await askClone(sc.io, init, { root: s.ws, offline: false, git: GIT })).toEqual({ clone: false, entries: [] });
    const t = await setup();
    const init2 = await planInit(t.ws, { forge: t.forge, profile: "acme" });
    const sc2 = script([]);
    expect(await askClone(sc2.io, init2, { root: t.ws, offline: true, git: GIT })).toEqual({ clone: false, entries: [] });
    expect([...sc.said, ...sc2.said, ...sc.confirmed, ...sc2.confirmed]).toEqual([]);
  });
  it("a block that does not read: one line, no question", async () => {
    const s = await setup({ repos: [{ name: "a" }] });
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme" });
    const sc = script([]);
    expect(await askClone(sc.io, init, { root: s.ws, offline: false, git: GIT })).toEqual({ clone: false, entries: [] });
    expect(sc.said).toEqual(["repositories: not offered — profile acme: repos[0]: url is missing"]);
  });
  it("a plan whose first sync would be refused: no list, no question (confirmInit says why)", async () => {
    const s = await setup({ declared: true });
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme" });
    const sc = script([]);
    expect(await askClone(sc.io, init, { root: s.ws, offline: false, git: GIT })).toEqual({ clone: false, entries: [], refused: true });
    expect([...sc.said, ...sc.confirmed]).toEqual([]);
  });
  it("yes meeting C6 (no git) or C5 (a destination appeared): said, and the question asked again", async () => {
    const s = await setup();
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme" });
    const sc = script(["yes", "no"]);
    expect(await askClone(sc.io, init, { root: s.ws, offline: false, git: null })).toEqual({ clone: false, entries: [] });
    expect(sc.said).toContain("cloning needs git — install it, or leave the clone out");
    expect(sc.confirmed.length).toBe(2);
    await fs.mkdir(path.join(s.ws, "apps", "portal-web"), { recursive: true });
    const sc2 = script(["yes", ""]);
    expect(await askClone(sc2.io, init, { root: s.ws, offline: false, git: GIT })).toEqual({ clone: false, entries: [] });
    expect(sc2.said).toContain("cannot clone portal-web: apps/portal-web already exists in the workspace — move it, or leave the clone out");
  });
});

describe("confirmInit — the question names the clone (§4.3)", () => {
  it("sync and clone; --no-sync and clone; one repository; no clone as today", async () => {
    const s = await setup();
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme" });
    const ask = async (opts: Parameters<typeof confirmInit>[3]) => {
      const sc = script([""]);
      await confirmInit(init, s.ws, sc.io, opts);
      return sc.confirmed[0];
    };
    expect(await ask({ sync: true, clone: 2 })).toBe("Write craftar.yaml, sync and clone 2 repositories [yes]: ");
    expect(await ask({ sync: false, clone: 2 })).toBe("Write craftar.yaml and clone 2 repositories [yes]: ");
    expect(await ask({ sync: true, clone: 1 })).toBe("Write craftar.yaml, sync and clone 1 repository [yes]: ");
    expect(await ask({ sync: true })).toBe("Write craftar.yaml and sync [yes]: ");
    expect(await ask({ sync: false })).toBe("Write craftar.yaml [yes]: ");
  });
  it("a refused first sync: the not-cloned line before the question, which offers neither sync nor clone", async () => {
    const s = await setup({ declared: true });
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme" });
    const sc = script([""]);
    await confirmInit(init, s.ws, sc.io, { sync: true, cloneRefused: true });
    expect(sc.confirmed).toEqual(["Write craftar.yaml [yes]: "]);
    expect(sc.said.at(-1)).toBe("  repositories: not cloned — the first sync is refused");
    const sc2 = script([""]);
    await confirmInit(init, s.ws, sc2.io, { sync: true });
    expect(sc2.said).not.toContain("  repositories: not cloned — the first sync is refused");
  });
});

describe("againLine — --clone", () => {
  const answers: InitAnswers = { forge: "../forge", profile: "acme", addRecipes: [], removeRecipes: [], replace: false };
  it("gains --clone when the answer was yes or the flag was given; nothing for a no", () => {
    expect(againLine(answers, { sync: true, offline: false, clone: true })).toBe("  again craftar init --forge ../forge --profile acme --clone");
    expect(againLine(answers, { sync: true, offline: false, clone: false })).toBe("  again craftar init --forge ../forge --profile acme");
    expect(againLine(answers, { sync: true, offline: false })).toBe("  again craftar init --forge ../forge --profile acme");
  });
});

describe("LoadOptions.fetchHint — R4's tail (§5.2)", () => {
  it("fresh-copy: the sync-mode fetch failure without the --offline advice; the default keeps it", async () => {
    const r = await remoteForge({ ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] });
    cleanups.push(r.cleanup);
    const ws = await fs.realpath(await tmpDir("craftar-fetchhint-ws-"));
    const home = await fs.realpath(await tmpDir("craftar-fetchhint-home-"));
    cleanups.push(() => fs.rm(ws, { recursive: true, force: true }), () => fs.rm(home, { recursive: true, force: true }));
    await fs.writeFile(path.join(ws, "craftar.yaml"), `forge: ${r.url}\nprofile: acme\n`);
    await loadWorkspace(ws, { mode: "sync", home });
    const sha = git(r.src, "rev-parse", "HEAD").slice(0, 8);
    await fs.rename(r.bare, r.bare + ".gone");
    const msg = async (opts: Record<string, unknown>) => {
      try {
        await loadWorkspace(ws, { mode: "sync", home, ...opts });
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error("expected the load to fail");
    };
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(await msg({ fetchHint: "fresh-copy" })).toMatch(
      new RegExp(`^cannot fetch the Forge ${esc(r.url)}: [^\\n]+ — repos clone reads the profile's repositories only from a fresh copy$`),
    );
    expect(await msg({ fetchHint: "fresh-copy" })).not.toContain("--offline");
    expect(await msg({})).toMatch(new RegExp(` — run with --offline to use the cached copy \\(${sha} fetched [^)]+\\)$`));
    expect(await msg({ fetchHint: "offline" })).toMatch(new RegExp(` — run with --offline to use the cached copy \\(${sha} fetched [^)]+\\)$`));
  });
});

/** Answers in order, then Enter for every later question — never a loop on the same answer. */
function queued(answers: string[]): InitIo {
  const next = async () => (answers.length ? answers.shift()! : "");
  return { ask: next, confirm: next, say: () => {} };
}

describe("askInit carries a typed --clone into planInit (review round 1 blocker)", () => {
  it("given.clone true: the input planInit gets asks to clone, so C3–C5 are checked and the entries come back", async () => {
    const s = await setup();
    const answers = ["acme"];
    const asked: string[] = [];
    const next = async (q: string) => (asked.push(q), answers.length ? answers.shift()! : "");
    const io: InitIo = { ask: next, confirm: next, say: () => {} };
    const r = await askInit(s.ws, { forge: s.forge, addRecipes: [], removeRecipes: [], replace: false, clone: true }, { doc: null, keys: [] }, io, { registryOff: true });
    if (r.kind !== "answered") throw new Error("expected answers");
    expect(r.input.clone).toBe(true);
    const init = await planInit(s.ws, r.input);
    expect(init.repos.map((e) => e.name)).toEqual(["portal-api", "portal-web"]);
    const t = await setup({ repos: [] });
    const r2 = await askInit(t.ws, { forge: t.forge, addRecipes: [], removeRecipes: [], replace: false, clone: true }, { doc: null, keys: [] }, queued(["acme"]), { registryOff: true });
    if (r2.kind !== "answered") throw new Error("expected answers");
    await expect(planInit(t.ws, r2.input)).rejects.toThrow(/^profile acme lists no repositories — nothing to clone; drop --clone$/);
  });
  it("given.clone absent or false: the input does not ask to clone", async () => {
    const s = await setup();
    for (const clone of [undefined, false]) {
      const io = queued(["acme"]);
      const r = await askInit(s.ws, { forge: s.forge, addRecipes: [], removeRecipes: [], replace: false, ...(clone === undefined ? {} : { clone }) }, { doc: null, keys: [] }, io, { registryOff: true });
      if (r.kind !== "answered") throw new Error("expected answers");
      expect(r.input.clone).not.toBe(true);
    }
  });
});

describe("a leftover craftar.lock (no craftar.yaml) is read for the destination checks (review round 2)", () => {
  it("a path the old lock records is a file sync writes — planInit with clone refuses it, as craftar repos would", async () => {
    const s = await setup();
    expect(runCli(["init", "--forge", s.forge, "--profile", "acme", "--workspace", s.ws]).code).toBe(0);
    await fs.rm(path.join(s.ws, "craftar.yaml"));
    const lockFile = path.join(s.ws, "craftar.lock");
    const lock = JSON.parse(await fs.readFile(lockFile, "utf8"));
    lock.files.push({ path: "portal-api/readme.md", hash: "sha256:" + "0".repeat(64), target: "claude-code", ingredient: "rule/a" });
    await fs.writeFile(lockFile, JSON.stringify(lock, null, 2) + "\n");
    await expect(planInit(s.ws, { forge: s.forge, profile: "acme", clone: true })).rejects.toThrow(/^cannot clone portal-api: portal-api is a file sync writes$/);
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme" });
    const said: string[] = [];
    const answers = ["yes", "no"];
    const io: InitIo = { ask: async () => "", confirm: async () => answers.shift() ?? "no", say: (l) => void said.push(l) };
    expect(await askClone(io, init, { root: s.ws, offline: false, git: GIT })).toEqual({ clone: false, entries: [] });
    expect(said).toContain("cannot clone portal-api: portal-api is a file sync writes");
  });
});
