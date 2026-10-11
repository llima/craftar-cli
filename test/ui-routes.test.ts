import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, scenario, tmpDir, makeWorkspace } from "./helpers/forge.js";
import { remoteForge } from "./helpers/remote.js";
import { MCP_FILES, eightStates, explained, mcpWorkspace, syncOnce, type Scenario } from "./helpers/states.js";
import { HOME, get, syncRegistered } from "./helpers/ui.js";
import { renderDiff } from "../src/core/diff.js";
import { registryFile } from "../src/core/registry.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { register } from "../src/core/registry.js";
import { hashNormalized } from "../src/core/text.js";
import { routePattern, routeReason, workspaceId } from "../src/ui/routes.js";

// Spec 36 §4.4, §4.5, §6, §7.3, §7.5, §10.2 — every answer of the data routes, without a socket.

const cleanups: Array<() => Promise<unknown>> = [];
beforeEach(async () => {
  await fs.rm(registryFile(HOME()), { force: true }); // one registry per test: the home is per file
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends { cleanup: () => Promise<unknown> }>(s: T): T => (cleanups.push(s.cleanup), s);
const R = ".claude/rules";
const BASE = { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] };
const enc = encodeURIComponent;

/** eightStates(), registered as the first sync left it (its registry entry is not touched by the later edits). */
async function eight() {
  const s = kept(await eightStates());
  const ws = await loadWorkspace(s.wsRoot, { home: HOME() });
  const entry = await register(HOME(), ws, await plan(ws));
  return { s, id: workspaceId(entry.path), real: entry.path };
}
async function tree(dir: string): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push([path.relative(dir, p).replace(/\\/g, "/"), createHash("sha256").update(await fs.readFile(p)).digest("hex")]);
    }
  };
  await walk(dir);
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

describe("the id and the route patterns", () => {
  it("workspaceId is the first 16 hex characters of hashNormalized(path)", () => {
    expect(workspaceId("/home/acme/ws")).toBe(hashNormalized("/home/acme/ws").slice(7, 23));
    expect(workspaceId("/home/acme/ws")).toMatch(/^[0-9a-f]{16}$/);
    expect(workspaceId("/home/acme/ws")).not.toBe(workspaceId("/home/acme/ws2"));
  });

  it("routePattern names a route by its pattern, never by the request", () => {
    const id = "0123456789abcdef";
    expect(routePattern("/api/workspaces")).toBe("/api/workspaces");
    expect(routePattern(`/api/workspaces/${id}`)).toBe("/api/workspaces/<id>");
    for (const what of ["diff", "explain", "recipes", "ingredients"]) expect(routePattern(`/api/workspaces/${id}/${what}`)).toBe(`/api/workspaces/<id>/${what}`);
    for (const p of ["/", "/api", "/api/workspaces/", `/api/workspaces/${id}/`, `/api/workspaces/${id}/status`, "/api/workspaces/SENTINEL", `/api/workspaces/${id.toUpperCase()}`, `/api/workspaces/${id}/diff/x`, "/favicon.ico"])
      expect(routePattern(p), p).toBeNull();
  });
});

describe("routeReason", () => {
  it("one line, whatever is thrown", () => {
    expect(routeReason("a string\nsecond line")).toBe("a string");
    expect(routeReason(42)).toBe("42");
    expect(routeReason(undefined)).toBe("undefined");
    expect(routeReason(new Error("first\nsecond"))).toBe("first");
    expect(routeReason(new Error("craftar.lock is not valid JSON"))).toBe("craftar.lock is not valid JSON");
  });
});

describe("/api/workspaces", () => {
  it("no registry yet: an empty table", async () => {
    expect(await get("/api/workspaces")).toEqual({ status: 200, body: { version: "0.0.0-test", registry: registryFile(HOME()), fetch: false, workspaces: [], warnings: [] } });
  });

  it("the document of `craftar workspaces --json`, with version first and an id first in every row", async () => {
    const a = await eight();
    const b = kept(await scenario(BASE, { config: { profile: "acme" } }));
    const bid = await syncRegistered(b.wsRoot);
    const cli = JSON.parse(runCli(["workspaces", "--json"]).stdout);
    const got = (await get("/api/workspaces")).body as any;
    expect(Object.keys(got)).toEqual(["version", "registry", "fetch", "workspaces", "warnings"]);
    expect(got.workspaces.map((r: any) => Object.keys(r)[0])).toEqual(["id", "id"]);
    expect(got.workspaces.map(({ id, ...row }: any) => row)).toEqual(cli.workspaces);
    expect([got.registry, got.fetch, got.warnings]).toEqual([cli.registry, false, cli.warnings]);
    expect(got.workspaces.map((r: any) => r.id).sort()).toEqual([a.id, bid.id].sort());
    expect(got.workspaces.map((r: any) => r.status).sort()).toEqual(["drift", "up-to-date"]);
  });

  it("an error row: the same rows as the command, its reason in one line, and nothing of a broken lock's text", async () => {
    const s = kept(await scenario(BASE, { config: { profile: "acme" } }));
    const one = await syncRegistered(s.wsRoot);
    const two = path.join(s.root, "ws-two");
    await makeWorkspace(two, s.forgeRoot, { config: { profile: "acme" } });
    const twoId = await syncRegistered(two);
    await fs.writeFile(path.join(s.wsRoot, "craftar.lock"), '{ "schema": 2, SENTINEL-9c1e');
    await fs.writeFile(path.join(two, "craftar.yaml"), YAML.stringify({ forge: "../forge", profile: "acme", targets: ["SENTINEL-YAML", "SENTINEL-TWO"] }));
    const answer = await get("/api/workspaces");
    const got = answer.body as any;
    expect(got.workspaces.map((r: any) => r.status)).toEqual(["error", "error"]);
    expect(got.workspaces.map(({ id, ...row }: any) => row)).toEqual(JSON.parse(runCli(["workspaces", "--json"]).stdout).workspaces);
    expect(got.warnings).toEqual([
      `${one.path}: craftar.lock is not valid JSON`,
      `${twoId.path}: invalid craftar.yaml (targets.0: Invalid enum value. Expected 'claude-code' | 'kiro' | 'agents-md', and 1 more)`,
    ]);
    expect(JSON.stringify(answer)).not.toContain("SENTINEL");
  });
});

describe("/api/workspaces/<id>", () => {
  it("the status --json document of the workspace, under id, path, profile, recipes and targets", async () => {
    const { s, id, real } = await eight();
    const cli = JSON.parse(runCli(["status", "--json", "--workspace", s.wsRoot]).stdout);
    const got = await get(`/api/workspaces/${id}`);
    expect(got.status).toBe(200);
    expect(Object.keys(got.body as object)).toEqual(["id", "path", "profile", "recipes", "targets", "forge", "statuses", "warnings", "unsetParams"]);
    expect(JSON.parse(JSON.stringify(got.body))).toEqual({ id, path: real, profile: "acme", recipes: ["base"], targets: ["claude-code"], ...cli });
    expect(JSON.stringify(got.body)).not.toContain('"planned"');
  });

  it("an unknown id is 404; a missing workspace is 409 with the fixed sentence", async () => {
    const { s, id } = await eight();
    expect(await get("/api/workspaces/0000000000000000")).toEqual({ status: 404, body: { error: "not found" } });
    await fs.rm(path.join(s.wsRoot, "craftar.yaml"));
    const missing = { status: 409, body: { error: "the directory or its craftar.yaml is gone — craftar workspaces prune", warnings: [] } };
    for (const what of ["", "/recipes", "/ingredients", `/diff?path=${enc(`${R}/keep.md`)}`, `/explain?path=${enc(`${R}/keep.md`)}`]) expect(await get(`/api/workspaces/${id}${what}`), what).toEqual(missing);
  });

  it("a workspace spec 29 refuses answers 200 with unsetParams filled", async () => {
    const s = kept(await scenario({ ingredients: [rule("api", "port {{api.port}}\n", { params: { "api.port": {} } })], recipes: [recipe("base", ["rule/api"])], profiles: [profile("acme", ["base"])] }, { config: { profile: "acme" } }));
    const ws = await loadWorkspace(s.wsRoot, { home: HOME() });
    const entry = await register(HOME(), ws, await plan(ws));
    const got = await get(`/api/workspaces/${workspaceId(entry.path)}`);
    expect([got.status, (got.body as any).unsetParams]).toEqual([200, [{ key: "api.port", declaredBy: ["rule/api"], citedBy: ["rule/api"] }]]);
    expect(((await get("/api/workspaces")).body as any).workspaces[0].status).toBe("error");
  });

  it("what cannot be shown is 409 with one line: a Forge that is gone, a broken lock, a refused lock, a refused craftar.yaml", async () => {
    const { s, id } = await eight();
    const lockFile = path.join(s.wsRoot, "craftar.lock");
    const lock = await fs.readFile(lockFile, "utf8");
    await fs.writeFile(lockFile, '{ "schema": 2, SENTINEL-9c1e');
    const broken = await get(`/api/workspaces/${id}`);
    expect(broken).toEqual({ status: 409, body: { error: "craftar.lock is not valid JSON", warnings: [] } });
    // the two catalogue routes neither plan nor read the lock
    expect((await get(`/api/workspaces/${id}/recipes`)).status).toBe(200);
    expect((await get(`/api/workspaces/${id}/ingredients`)).status).toBe(200);
    expect((await get(`/api/workspaces/${id}/explain?path=${enc(`${R}/keep.md`)}`)).status).toBe(409);
    const refused = JSON.parse(lock);
    refused.files[0].target = "SENTINEL-TARGET";
    await fs.writeFile(lockFile, JSON.stringify(refused));
    const r = await get(`/api/workspaces/${id}`);
    expect(r).toEqual({ status: 409, body: { error: "craftar.lock is not a valid lock (files.0.target: Invalid enum value. Expected 'claude-code' | 'kiro' | 'agents-md')", warnings: [] } });
    await fs.writeFile(lockFile, lock);
    await fs.appendFile(path.join(s.wsRoot, "craftar.yaml"), "targets: [SENTINEL-YAML]\n");
    const y = await get(`/api/workspaces/${id}/recipes`);
    expect(y).toEqual({ status: 409, body: { error: "invalid craftar.yaml (targets.0: Invalid enum value. Expected 'claude-code' | 'kiro' | 'agents-md')", warnings: [] } });
    await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), YAML.stringify({ forge: "../forge", profile: "acme", ref: "v1" }));
    await fs.rename(s.forgeRoot, `${s.forgeRoot}-away`);
    expect(await get(`/api/workspaces/${id}`)).toEqual({ status: 409, body: { error: `Forge not found at ${s.forgeRoot}`, warnings: [] } });
    await fs.rename(`${s.forgeRoot}-away`, s.forgeRoot);
    await fs.rm(path.join(s.forgeRoot, "profiles/acme"), { recursive: true });
    // the load succeeded, so its warnings ride along, without the `<path>: ` prefix the table adds
    const gone = { error: 'profile "acme" not found in Forge (none)', warnings: ['ref "v1" is ignored: the Forge is a path (../forge), read as its working tree'] };
    expect(await get(`/api/workspaces/${id}/recipes`)).toEqual({ status: 409, body: gone });
    expect(await get(`/api/workspaces/${id}`)).toEqual({ status: 409, body: gone });
    for (const a of [broken, r, y]) expect(JSON.stringify(a)).not.toContain("SENTINEL");
  });
});

describe("diff", () => {
  const D = (id: string, p: string) => get(`/api/workspaces/${id}/diff?path=${enc(p)}`);

  it("each of the six states: the labels, the note, the body renderDiff gives unpainted", async () => {
    const { id } = await eight();
    const f = (n: string) => `${R}/${n}.md`;
    expect((await D(id, f("edited"))).body).toEqual({ path: f("edited"), state: "drift", from: `${f("edited")} (disk, drift)`, to: `${f("edited")} (forge)`, hidden: false, note: null, diff: "  # Edited\n- by hand\n+ by the forge" });
    expect(renderDiff("# Edited\nby hand\n", "# Edited\nby the forge\n")).toBe("  # Edited\n- by hand\n+ by the forge");
    expect((await D(id, f("clash"))).body).toEqual({ path: f("clash"), state: "collision", from: `${f("clash")} (disk, collision)`, to: `${f("clash")} (forge)`, hidden: false, note: null, diff: "  # Clash\n- disk side\n+ forge side" });
    expect((await D(id, f("fresh"))).body).toEqual({ path: f("fresh"), state: "new", from: `${f("fresh")} (disk, new)`, to: `${f("fresh")} (forge)`, hidden: false, note: null, diff: "+ # Fresh" });
    expect((await D(id, f("moved"))).body).toEqual({ path: f("moved"), state: "update", from: `${f("moved")} (disk, update)`, to: `${f("moved")} (forge)`, hidden: false, note: null, diff: "  # Moved\n- old line\n+ new line" });
    expect((await D(id, f("gone"))).body).toEqual({ path: f("gone"), state: "orphan", from: `${f("gone")} (disk, orphan)`, to: `${f("gone")} (forge: no longer produced — sync removes it)`, hidden: false, note: null, diff: "- # Gone" });
    expect((await D(id, f("gone-edited"))).body).toEqual({ path: f("gone-edited"), state: "orphan-drift", from: `${f("gone-edited")} (disk, orphan-drift)`, to: null, hidden: false, note: "no longer produced by the Forge but hand-edited — kept; `craftar drift discard <path>` removes it, or delete it yourself", diff: null });
  });

  it("unchanged and adopt: every field null, hidden false", async () => {
    const { id } = await eight();
    for (const [n, state] of [["keep", "unchanged"], ["adopted", "adopt"]]) expect(await D(id, `${R}/${n}.md`)).toEqual({ status: 200, body: { path: `${R}/${n}.md`, state, from: null, to: null, hidden: false, note: null, diff: null } });
  });

  it("path is required, once, and must decode — decided before the registry is read", async () => {
    const { id } = await eight();
    const bad = { status: 400, body: { error: "path is required, once" } };
    for (const q of ["", "?", "?other=1", "?path=a&path=b", "?path=%E0%A4%A", "?path", "?Path=x"]) expect(await get(`/api/workspaces/${id}/diff${q}`), q).toEqual(q === "?path" ? { status: 404, body: { error: "not found" } } : bad);
    expect(await get(`/api/workspaces/${id}/explain`)).toEqual(bad);
    // an unknown id with no path is 400, not 404; with a broken registry it is still 400
    expect(await get("/api/workspaces/0000000000000000/diff")).toEqual(bad);
    await fs.writeFile(registryFile(HOME()), "{ broken");
    expect(await get(`/api/workspaces/${id}/diff`)).toEqual(bad);
    await expect(get(`/api/workspaces/${id}/diff?path=x`)).rejects.toThrow(/^cannot read .*registry\.json: not valid JSON$/);
  });

  it("the query is decoded once, with decodeURIComponent: escaped or bare slashes, never twice, and + is not a space", async () => {
    const { id } = await eight();
    const p = `${R}/edited.md`;
    expect((await get(`/api/workspaces/${id}/diff?path=${enc(p)}`)).status).toBe(200); // .claude%2Frules%2Fedited.md
    expect((await get(`/api/workspaces/${id}/diff?path=${p}`)).status).toBe(200); // bare slashes
    expect((await get(`/api/workspaces/${id}/diff?path=${enc(enc(p))}`)).status).toBe(404); // decoded once, not twice
    expect((await get(`/api/workspaces/${id}/diff?path=${p}&other=1`)).status).toBe(200); // another key is ignored
    expect((await get(`/api/workspaces/${id}/diff?path=${p.replace("edited", "edi+ted")}`)).status).toBe(404);
  });

  it("a path that is not a row is a bare 404: the answer does not hold the path asked", async () => {
    const { id } = await eight();
    for (const what of ["diff", "explain"]) {
      const a = await get(`/api/workspaces/${id}/${what}?path=${enc(".claude/rules/SENTINEL-NAME.md")}`);
      expect(a).toEqual({ status: 404, body: { error: "not found" } });
    }
    expect((await D(id, `./${R}/edited.md`)).status).toBe(404); // character for character: no normalization
    expect((await D(id, `${R}\\edited.md`)).status).toBe(404);
  });

  it("traversal: a file outside the workspace is never opened", async () => {
    const { s, id } = await eight();
    const outside = path.join(s.root, "outside.txt");
    await fs.writeFile(outside, "SENTINEL-OUTSIDE\n");
    for (const p of ["../outside.txt", outside, "..\\outside.txt", `${R}/../../../outside.txt`, "craftar.yaml", "craftar.lock"])
      for (const what of ["diff", "explain"]) {
        const a = await get(`/api/workspaces/${id}/${what}?path=${enc(p)}`);
        expect(a, `${what} ${p}`).toEqual({ status: 404, body: { error: "not found" } });
      }
  });

  it("the example file: withheld in drift and collision, its content in no answer in any state", async () => {
    const EX = MCP_FILES[2];
    for (const state of ["drift", "collision", "orphan-drift"] as const) {
      await fs.rm(registryFile(HOME()), { force: true });
      const s = kept(await mcpWorkspace());
      if (state !== "collision") await syncOnce(s.wsRoot);
      if (state === "orphan-drift") await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), "name: base\ningredients: [rule/keep]\n");
      await fs.mkdir(path.dirname(path.join(s.wsRoot, EX)), { recursive: true });
      await fs.appendFile(path.join(s.wsRoot, EX), "SENTINEL-DISK\n");
      const ws = await loadWorkspace(s.wsRoot, { home: HOME() });
      const id = workspaceId((await register(HOME(), ws, await plan(ws))).path);
      const a = await D(id, EX);
      expect(JSON.stringify(a), state).not.toContain("SENTINEL-DISK");
      if (state === "orphan-drift") expect(a.body).toMatchObject({ state, hidden: false, to: null, diff: null, note: "no longer produced by the Forge but hand-edited — kept; `craftar drift discard <path>` removes it, or delete it yourself" });
      else expect(a.body).toEqual({ path: EX, state, from: `${EX} (disk, ${state})`, to: `${EX} (forge)`, hidden: true, note: "content not shown: an example file may hold a value typed by hand", diff: null });
      // the two MCP files are shown, as `craftar diff` shows them
      if (state === "drift") {
        await fs.appendFile(path.join(s.wsRoot, ".mcp.json"), "MARKER-SHOWN\n");
        expect(((await D(id, ".mcp.json")).body as any).diff).toContain("- MARKER-SHOWN");
      }
    }
  });
});

describe("explain, recipes, ingredients", () => {
  it("explain answers the object the shared builder returns; a path the Forge does not produce is 404", async () => {
    const s = kept(await explained());
    const ws = await loadWorkspace(s.wsRoot, { home: HOME() });
    const id = workspaceId((await register(HOME(), ws, await plan(ws))).path);
    const E = (p: string) => get(`/api/workspaces/${id}/explain?path=${enc(p)}`);
    expect(await E(`${R}/api.md`)).toEqual({
      status: 200,
      body: {
        path: `${R}/api.md`,
        target: "claude-code",
        ingredient: "rule/api",
        origin: null,
        via: ["stack-node"],
        sections: [{ name: "review", layer: "profile" }],
        params: [{ key: "api.port", layer: "default" }, { key: "region", layer: "workspace" }, { key: "team", layer: { profile: "acme" } }],
        profile: "acme",
        recipes: ["base", "stack-node"],
        hash: "sha256:e850fe1c8108a9d898a4557335d8b92b3fb82f57e775cc5695707e53503c891b",
      },
    });
    expect((await E("AGENTS.md")).body).toMatchObject({ ingredient: "rule/*", via: null, origin: null, sections: [], params: [] });
    expect((await E(`${R}/legacy.md`)).body).toMatchObject({ origin: { workspace: "acme-portal", path: ".claude/rules/legacy.md" } });
    expect(await E(`${R}/nope.md`)).toEqual({ status: 404, body: { error: "not found" } });
  });

  it("recipes and ingredients equal the commands' --json, load warnings first", async () => {
    const { s, id } = await eight();
    await fs.appendFile(path.join(s.wsRoot, "craftar.yaml"), "ref: v1\n");
    for (const what of ["recipes", "ingredients"]) {
      const cli = JSON.parse(runCli([what, "--json", "--workspace", s.wsRoot]).stdout);
      expect(cli.warnings).toEqual(['ref "v1" is ignored: the Forge is a path (../forge), read as its working tree']);
      expect(JSON.parse(JSON.stringify((await get(`/api/workspaces/${id}/${what}`)).body)), what).toEqual(cli);
    }
  });
});

describe("/api/workspaces/<id> on a remote Forge (spec 36 §10.2)", () => {
  const OFFLINE = "not fetched (--offline)";
  /** `status --json --offline`, with the one warning that says it did not fetch taken out — found by its text. */
  const offline = (ws: string) => {
    const r = runCli(["status", "--json", "--offline", "--workspace", ws]);
    expect(r.code, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.warnings.filter((w: string) => w.includes(OFFLINE))).toHaveLength(1);
    return { ...doc, warnings: doc.warnings.filter((w: string) => !w.includes(OFFLINE)) };
  };

  it("the document of status --json --offline, without its not-fetched warning", async () => {
    const r = kept(await remoteForge(BASE));
    const ws = await tmpDir();
    cleanups.push(() => fs.rm(ws, { recursive: true, force: true }));
    await fs.writeFile(path.join(ws, "craftar.yaml"), YAML.stringify({ forge: r.url, profile: "acme" }));
    const { id, path: real } = await syncRegistered(ws);
    const got = await get(`/api/workspaces/${id}`);
    expect(got.status).toBe(200);
    expect(JSON.stringify(got.body)).not.toContain(OFFLINE);
    expect(JSON.parse(JSON.stringify(got.body))).toEqual({ id, path: real, profile: "acme", recipes: ["base"], targets: ["claude-code"], ...offline(ws) });
    expect((got.body as any).forge).toMatchObject({ kind: "remote", source: r.url, fetched: false });
  });

  it("the same with the Forge named by craftar.local.yaml", async () => {
    const r = kept(await remoteForge(BASE));
    const ws = await tmpDir();
    cleanups.push(() => fs.rm(ws, { recursive: true, force: true }));
    await fs.writeFile(path.join(ws, "craftar.yaml"), YAML.stringify({ forge: "../no-such-forge", profile: "acme" }));
    await fs.writeFile(path.join(ws, "craftar.local.yaml"), YAML.stringify({ forge: r.url }));
    const { id, path: real } = await syncRegistered(ws);
    const got = await get(`/api/workspaces/${id}`);
    expect(got.status).toBe(200);
    expect(JSON.parse(JSON.stringify(got.body))).toEqual({ id, path: real, profile: "acme", recipes: ["base"], targets: ["claude-code"], ...offline(ws) });
    expect((got.body as any).forge).toMatchObject({ kind: "remote", source: r.url });
  });
});

describe("routeReason on a schema refusal", () => {
  it("the first issue and a count, as doctor words it", async () => {
    const s = kept(await scenario(BASE, { config: { profile: "acme" } }));
    await syncRegistered(s.wsRoot);
    await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), "forge: ../forge\nprofile: acme\ntargets: [nope, neither]\n");
    const thrown: unknown = await loadWorkspace(s.wsRoot, { mode: "no-fetch", home: HOME() }).then(() => null, (e: unknown) => e);
    expect(routeReason(thrown)).toBe("invalid craftar.yaml (targets.0: Invalid enum value. Expected 'claude-code' | 'kiro' | 'agents-md', and 1 more)");
  });
});

describe("what the routes never do", () => {
  const ALL = (id: string) => ["/api/workspaces", `/api/workspaces/${id}`, `/api/workspaces/${id}/recipes`, `/api/workspaces/${id}/ingredients`, `/api/workspaces/${id}/diff?path=${enc(`${R}/edited.md`)}`, `/api/workspaces/${id}/explain?path=${enc(`${R}/keep.md`)}`, `/api/workspaces/${id}/diff?path=nope`, "/api/workspaces/0000000000000000"];

  it("write: the workspace, its lock, the Forge and the registry are byte-identical after every route", async () => {
    const { s, id } = await eight();
    const before = [await tree(s.wsRoot), await tree(s.forgeRoot), await fs.readFile(registryFile(HOME()), "utf8")];
    for (const t of ALL(id)) await get(t);
    expect([await tree(s.wsRoot), await tree(s.forgeRoot), await fs.readFile(registryFile(HOME()), "utf8")]).toEqual(before);
  });

  it("fetch: a remote Forge that gained a commit is still answered from the cached copy", async () => {
    const r = kept(await remoteForge(BASE));
    const ws = await tmpDir();
    cleanups.push(() => fs.rm(ws, { recursive: true, force: true }));
    await fs.writeFile(path.join(ws, "craftar.yaml"), YAML.stringify({ forge: r.url, profile: "acme" }));
    const { id } = await syncRegistered(ws);
    const cached = (await loadWorkspace(ws, { mode: "no-fetch", home: HOME() })).forge.commit;
    const forges = path.join(HOME(), "forges");
    const stamps = async () => Promise.all((await fs.readdir(forges)).map((e) => fs.readFile(path.join(forges, e, "fetched"), "utf8").catch(() => null)));
    const stampBefore = await stamps();
    const moved = await r.commit({ "ingredients/rules/keep/rule.md": "# Keep\nmoved on the remote\n" });
    expect(moved).not.toBe(cached);
    for (const t of ["/api/workspaces", `/api/workspaces/${id}`, `/api/workspaces/${id}/recipes`, `/api/workspaces/${id}/ingredients`, `/api/workspaces/${id}/diff?path=${enc(`${R}/keep.md`)}`, `/api/workspaces/${id}/explain?path=${enc(`${R}/keep.md`)}`]) {
      const a = await get(t);
      expect(a.status, t).toBe(200);
      expect(JSON.stringify(a), t).not.toContain("not fetched (");
    }
    const one = (await get(`/api/workspaces/${id}`)).body as any;
    expect([one.forge.commit, one.forge.fetched, one.statuses[0].state]).toEqual([cached, false, "unchanged"]);
    const row = ((await get("/api/workspaces")).body as any).workspaces[0];
    expect([row.forge.commit, row.forge.fetched]).toEqual([cached, false]);
    expect(await stamps()).toEqual(stampBefore);
    // (control) a `read` load does see the new commit: the remote is reachable, so the routes chose not to ask
    expect((await loadWorkspace(ws, { mode: "read", home: HOME() })).forge.commit).toBe(moved);
  });

  it("read the environment: every answer is the same bytes with a variable unset and set", async () => {
    const s = kept(await mcpWorkspace());
    const { id } = await syncRegistered(s.wsRoot);
    const targets = ["/api/workspaces", `/api/workspaces/${id}`, `/api/workspaces/${id}/recipes`, `/api/workspaces/${id}/ingredients`, `/api/workspaces/${id}/diff?path=.mcp.json`, `/api/workspaces/${id}/explain?path=.mcp.json`];
    delete process.env.ACME_TOKEN;
    const unset = await Promise.all(targets.map(async (t) => JSON.stringify(await get(t))));
    process.env.ACME_TOKEN = "SENTINEL-ENV";
    try {
      const set = await Promise.all(targets.map(async (t) => JSON.stringify(await get(t))));
      expect(set).toEqual(unset);
      expect(set.join("\n")).not.toContain("SENTINEL-ENV");
    } finally {
      delete process.env.ACME_TOKEN;
    }
  });
});
