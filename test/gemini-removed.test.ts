/**
 * The `gemini` target removed in 1.4.0 (the user's ruling of 2026-11-07, a dated exception to the 1.x promise; README
 * *Compatibility*). Only the name is refused in an input — a workspace's `targets`, a Forge file's `targets`, a section marker's
 * `targets=`, `init --targets` — always with the same fixed words; a Forge at `schema: 17` and a lock at schema 6 still load, and a
 * lock entry owned by `gemini` reads as an orphan: removed by the next sync when intact, kept and listed when edited by hand.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadForge } from "../src/core/forge.js";
import { apply, loadWorkspace, orphanReason, plan, readLock, status } from "../src/core/sync.js";
import { checkInitFlags } from "../src/core/init.js";
import { hashNormalized } from "../src/core/text.js";
import { profile, recipe, scenario, type IngredientSpec } from "./helpers/forge.js";
import { runCli } from "./helpers/cli.js";
import { atLeastWin32 } from "./helpers/timeouts.js";

type Scenario = Awaited<ReturnType<typeof scenario>>;

/** The fixed words every refusal of the name carries. */
const REMOVED = "the gemini target was removed in craftar 1.4.0";
const REASON = "orphan: the gemini target was removed in craftar 1.4.0";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const rule = (name: string, meta: Record<string, unknown> = {}, body = `${name} body.\n`): IngredientSpec => ({ meta: { type: "rule", name, ...meta }, files: { "rule.md": body } });

async function ws(schema: number, targets: string[], ingredients: IngredientSpec[], config: Record<string, unknown> = {}): Promise<Scenario> {
  const refs = ingredients.map((i) => `${i.meta.type}/${i.meta.name}`);
  const s = await scenario({ ingredients, recipes: [recipe("base", refs)], profiles: [profile("acme", ["base"], targets)] }, { config: { profile: "acme", ...config } });
  cleanups.push(s.cleanup);
  await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));
  return s;
}
const load = (s: Scenario) => loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
async function syncOf(s: Scenario) {
  const w = await load(s);
  const p = await plan(w);
  const st = await status(w, p, await readLock(w.root));
  return { p, st, r: await apply(w, p, st, {}) };
}

describe("the name gemini is refused in every input, with the same words", () => {
  it("a workspace's craftar.yaml targets: [gemini] → the load refuses, naming the removal", async () => {
    const s = await ws(17, ["claude-code"], [rule("style")], { targets: ["claude-code", "gemini"] });
    await expect(load(s)).rejects.toThrow(REMOVED);
  });

  it("a profile's targets naming gemini in a schema-17 Forge → loadForge refuses, naming the file", async () => {
    const s = await ws(17, ["claude-code", "gemini"], [rule("style")]);
    const e = await loadForge(s.forgeRoot).then(() => null, (x: Error) => x);
    expect(e?.message).toContain(REMOVED);
    // A Forge file is named with native separators (backslashes on Windows): compare with slashes
    expect(e?.message.replace(/\\/g, "/")).toContain("profiles/acme/profile.yaml");
  });

  it("an ingredient's targets naming gemini in a schema-17 Forge → loadForge refuses, naming the file", async () => {
    const s = await ws(17, ["claude-code"], [rule("style", { targets: ["gemini"] })]);
    const e = await loadForge(s.forgeRoot).then(() => null, (x: Error) => x);
    expect(e?.message).toContain(REMOVED);
    expect(e?.message.replace(/\\/g, "/")).toContain("ingredients/rules/style/ingredient.yaml");
  });

  it("a section marked targets=gemini → the plan refuses, naming the removal", async () => {
    const marked: IngredientSpec = { meta: { type: "rule", name: "tone" }, files: { "rule.md": "<!-- craftar:section intro targets=gemini -->\nHi.\n<!-- /craftar:section -->\n" } };
    const s = await ws(17, ["claude-code"], [marked]);
    await expect(load(s).then(plan)).rejects.toThrow(REMOVED);
  });

  it("a craftar.local.yaml targets: [gemini] → the load refuses, naming the removal", async () => {
    const s = await ws(17, ["claude-code"], [rule("style")]);
    await fs.writeFile(path.join(s.wsRoot, "craftar.local.yaml"), "targets: [gemini]\n");
    await expect(load(s)).rejects.toThrow(REMOVED);
  });

  it("a Forge below schema 17 naming gemini → the removal's words, not the schema near miss", async () => {
    const s = await ws(16, ["claude-code"], [rule("style", { targets: ["gemini"] })]);
    const e = await loadForge(s.forgeRoot).then(() => null, (x: Error) => x);
    expect(e?.message).toContain(REMOVED);
    expect(e?.message).not.toContain("needs schema");
    const marked: IngredientSpec = { meta: { type: "rule", name: "tone" }, files: { "rule.md": "<!-- craftar:section intro targets=gemini -->\nHi.\n<!-- /craftar:section -->\n" } };
    const t = await ws(16, ["claude-code"], [marked]);
    const pe = await load(t).then(plan).then(() => null, (x: Error) => x);
    expect(pe?.message).toContain(REMOVED);
    expect(pe?.message).not.toContain("needs schema");
  });

  it("init --targets gemini → refused before anything is read, naming the removal", () => {
    expect(() => checkInitFlags({ targets: ["claude-code", "gemini"] })).toThrow(REMOVED);
  });

  it("the CLI: sync --check on a workspace naming gemini exits 1 with the fixed words on stderr", { timeout: atLeastWin32(60_000) }, async () => {
    const s = await ws(17, ["claude-code"], [rule("style")], { targets: ["gemini"] });
    const r = runCli(["sync", "--check", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(REMOVED);
  });
});

describe("schema 17 and lock 6 keep loading; a gemini lock entry is an orphan", () => {
  it("a schema-17 Forge that names no gemini loads and syncs, its lock at schema 2", async () => {
    const s = await ws(17, ["claude-code"], [rule("style")]);
    await expect(loadForge(s.forgeRoot)).resolves.toBeTruthy();
    expect((await syncOf(s)).r.lock.schema).toBe(2);
  });

  it("an intact gemini file is an orphan removed by sync with the fixed reason; an edited one is kept, its entry kept, lock stays 6", { timeout: atLeastWin32(60_000) }, async () => {
    const s = await ws(17, ["claude-code"], [rule("style")]);
    const first = await syncOf(s);
    const lockPath = path.join(s.wsRoot, "craftar.lock");
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    const intact = "<!-- GENERATED -->\n\nstyle body.\n";
    const edited = "name: reviewer\n";
    await fs.writeFile(path.join(s.wsRoot, "GEMINI.md"), intact);
    await fs.mkdir(path.join(s.wsRoot, ".gemini", "agents"), { recursive: true });
    await fs.writeFile(path.join(s.wsRoot, ".gemini", "agents", "reviewer.md"), edited + "hand edit\n");
    lock.schema = 6;
    lock.targets = ["claude-code", "gemini"];
    lock.files.push(
      { path: "GEMINI.md", hash: hashNormalized(intact), target: "gemini", ingredient: "rule/*" },
      { path: ".gemini/agents/reviewer.md", hash: hashNormalized(edited), target: "gemini", ingredient: "agent/reviewer" },
    );
    await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
    expect(first.r.lock.schema).toBe(2);

    const w = await load(s);
    const p = await plan(w);
    const st = await status(w, p, await readLock(w.root));
    expect(st.find((x) => x.path === "GEMINI.md")?.state).toBe("orphan");
    expect(st.find((x) => x.path === ".gemini/agents/reviewer.md")?.state).toBe("orphan-drift");
    expect(orphanReason(p, st, "GEMINI.md")).toBe(REASON);

    const r = await apply(w, p, st, {});
    await expect(fs.access(path.join(s.wsRoot, "GEMINI.md"))).rejects.toThrow();
    await expect(fs.readFile(path.join(s.wsRoot, ".gemini", "agents", "reviewer.md"), "utf8")).resolves.toBe(edited + "hand edit\n");
    expect(r.lock.schema).toBe(6);
    expect(r.lock.files.map((f) => f.path)).toContain(".gemini/agents/reviewer.md");
    expect(r.lock.files.map((f) => f.path)).not.toContain("GEMINI.md");

    // The person deletes the edited file: the next sync drops the entry and writes lock 2
    await fs.rm(path.join(s.wsRoot, ".gemini"), { recursive: true, force: true });
    const last = await syncOf(s);
    expect(last.r.lock.schema).toBe(2);
    expect(last.r.lock.files.some((f) => f.path.startsWith(".gemini/"))).toBe(false);
  });

  it("the CLI: diff names the removal in the orphan's header; drift discard removes an edited gemini file and the lock drops to 2", { timeout: atLeastWin32(60_000) }, async () => {
    const s = await ws(17, ["claude-code"], [rule("style")]);
    await syncOf(s);
    const lockPath = path.join(s.wsRoot, "craftar.lock");
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    const intact = "GEMINI\n";
    const edited = "agent\n";
    await fs.writeFile(path.join(s.wsRoot, "GEMINI.md"), intact);
    await fs.mkdir(path.join(s.wsRoot, ".gemini", "agents"), { recursive: true });
    await fs.writeFile(path.join(s.wsRoot, ".gemini", "agents", "r.md"), edited + "hand edit\n");
    lock.schema = 6;
    lock.targets = ["claude-code", "gemini"];
    lock.files.push(
      { path: "GEMINI.md", hash: hashNormalized(intact), target: "gemini", ingredient: "rule/*" },
      { path: ".gemini/agents/r.md", hash: hashNormalized(edited), target: "gemini", ingredient: "agent/r" },
    );
    await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
    const d = runCli(["diff", "--workspace", s.wsRoot]);
    expect(d.stdout).toContain("+++ GEMINI.md (forge: the gemini target was removed in craftar 1.4.0 — sync removes it)");
    const r = runCli(["drift", "discard", ".gemini/agents/r.md", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    await expect(fs.access(path.join(s.wsRoot, ".gemini", "agents", "r.md"))).rejects.toThrow();
    await expect(fs.access(path.join(s.wsRoot, "GEMINI.md"))).rejects.toThrow();
    const after = JSON.parse(await fs.readFile(lockPath, "utf8"));
    expect(after.schema).toBe(2);
    expect(after.files.some((f: { target: string }) => f.target === "gemini")).toBe(false);
  });

  it("the CLI: sync removes an intact gemini file and prints the fixed reason", { timeout: atLeastWin32(60_000) }, async () => {
    const s = await ws(17, ["claude-code"], [rule("style")]);
    await syncOf(s);
    const lockPath = path.join(s.wsRoot, "craftar.lock");
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    const body = "GEMINI\r\n";
    await fs.writeFile(path.join(s.wsRoot, "GEMINI.md"), body);
    lock.schema = 6;
    lock.targets = ["claude-code", "gemini"];
    lock.files.push({ path: "GEMINI.md", hash: hashNormalized(body), target: "gemini", ingredient: "rule/*" });
    await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
    const r = runCli(["sync", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(REASON);
    await expect(fs.access(path.join(s.wsRoot, "GEMINI.md"))).rejects.toThrow();
  });
});
