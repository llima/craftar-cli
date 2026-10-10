import { afterEach, describe, expect, it } from "vitest";
import { existsSync, promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, scenario, type IngredientSpec } from "./helpers/forge.js";

// No test here runs Docker: the child's PATH holds only node's own directory, so `docker` is not found.
const NODE_DIR = path.dirname(process.execPath);
const DOCKER_THERE = existsSync(path.join(NODE_DIR, "docker")) || existsSync(path.join(NODE_DIR, "docker.exe"));
const NO_DOCKER = { PATH: NODE_DIR, Path: NODE_DIR };
const NOT_FOUND = "docker not found — install Docker with the Compose plugin 2.20.0 or later";
const NO_SERVICES = "no services in this workspace — craftar sync writes them when a recipe brings a service ingredient";
const FRAGMENT = ".craftar/services/echo/compose.yaml";

const echo: IngredientSpec = {
  meta: { type: "service", name: "echo" },
  files: { "compose.yaml": "services:\n  echo:\n    image: example/echo:1\n" },
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A workspace whose recipe brings `service/echo` (or only a rule), not synced yet. */
async function workspace(withService = true, files: Record<string, string> = {}) {
  const s = await scenario(
    {
      ingredients: [echo, rule("a", "# A\n")],
      recipes: [recipe("base", withService ? ["rule/a", "service/echo"] : ["rule/a"])],
      profiles: [profile("acme", ["base"])],
    },
    { config: { profile: "acme" }, files },
  );
  cleanups.push(s.cleanup);
  return s;
}

async function synced(withService = true, files: Record<string, string> = {}) {
  const s = await workspace(withService, files);
  const r = runCli(["sync", "--workspace", s.wsRoot]);
  expect([r.code, r.stderr]).toEqual([0, ""]);
  return s;
}

/** Every file under `dir` with its bytes, as one comparable object. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p);
      else out[p] = (await fs.readFile(path.join(dir, p))).toString("base64");
    }
  };
  await walk("");
  return out;
}

const up = (ws: string, ...more: string[]) => runCli(["services", "up", "--workspace", ws, ...more], { env: NO_DOCKER });
const statusJson = (ws: string) => runCli(["services", "status", "--json", "--workspace", ws], { env: NO_DOCKER });

describe.skipIf(DOCKER_THERE)("craftar services — without Docker (spec 31 §4.2–§4.4)", () => {
  it("sync wrote the three service files and a schema 3 lock (the ground the other cases stand on)", async () => {
    const s = await synced();
    const lock = JSON.parse(await fs.readFile(path.join(s.wsRoot, "craftar.lock"), "utf8"));
    expect(lock.schema).toBe(3);
    expect(lock.files.filter((f: { target: string }) => f.target === "services").map((f: { path: string }) => f.path)).toEqual([
      ".craftar/.gitattributes",
      ".craftar/compose.yaml",
      FRAGMENT,
    ]);
  });

  it("no craftar.yaml: exit 1 with our message, for up, down and status", async () => {
    const s = await workspace();
    await fs.rm(path.join(s.wsRoot, "craftar.yaml"));
    for (const cmd of ["up", "down", "status"]) {
      const r = runCli(["services", cmd, "--workspace", s.wsRoot], { env: NO_DOCKER });
      expect([cmd, r.code, r.stdout, r.stderr]).toEqual([
        cmd,
        1,
        "",
        `error: no craftar.yaml in ${path.resolve(s.wsRoot)} — run craftar services inside a workspace, or pass --workspace <dir>\n`,
      ]);
    }
  });

  it("up: never synced, and synced without a service → the 'no services' line, before Docker", async () => {
    const never = await workspace();
    expect([up(never.wsRoot).code, up(never.wsRoot).stderr]).toEqual([1, `error: ${NO_SERVICES}\n`]);
    const none = await synced(false);
    expect([up(none.wsRoot).code, up(none.wsRoot).stderr]).toEqual([1, `error: ${NO_SERVICES}\n`]);
  });

  it("up: a hand-edited fragment is refused with the --overwrite-drift fix, and nothing is written", async () => {
    const s = await synced();
    await fs.appendFile(path.join(s.wsRoot, FRAGMENT), "# hand edit\n");
    const before = await tree(s.wsRoot);
    const r = up(s.wsRoot);
    expect([r.code, r.stdout, r.stderr]).toEqual([
      1,
      "",
      `error: ${FRAGMENT} — edited — run craftar sync --overwrite-drift to regenerate it, or delete it if craftar status calls it orphan-drift\n`,
    ]);
    expect(await tree(s.wsRoot)).toEqual(before);
  });

  it("up: a deleted fragment is refused with plain sync as the fix; two problems give two lines", async () => {
    const s = await synced();
    await fs.rm(path.join(s.wsRoot, FRAGMENT));
    expect(up(s.wsRoot).stderr).toBe(`error: ${FRAGMENT} — missing — run craftar sync\n`);
    await fs.appendFile(path.join(s.wsRoot, ".craftar/compose.yaml"), "# hand edit\n");
    expect(up(s.wsRoot).stderr).toBe(
      `error: .craftar/compose.yaml — edited — run craftar sync --overwrite-drift to regenerate it, or delete it if craftar status calls it orphan-drift\n` +
        `${FRAGMENT} — missing — run craftar sync\n`,
    );
  });

  it("up: a user's own .craftar/compose.yaml (a collision at the first sync) is never run", async () => {
    const s = await workspace(true, { ".craftar/compose.yaml": "services:\n  mine:\n    image: example/mine:1\n" });
    runCli(["sync", "--workspace", s.wsRoot]);
    const r = up(s.wsRoot);
    expect([r.code, r.stderr]).toEqual([1, "error: .craftar/compose.yaml is not craftar's — run craftar status\n"]);
    expect(await fs.readFile(path.join(s.wsRoot, ".craftar/compose.yaml"), "utf8")).toBe("services:\n  mine:\n    image: example/mine:1\n");
  });

  it("up: a user's own fragment file (a collision) is refused by its path", async () => {
    const s = await workspace(true, { [FRAGMENT]: "services:\n  mine:\n    image: example/mine:1\n" });
    runCli(["sync", "--workspace", s.wsRoot]);
    const r = up(s.wsRoot);
    expect([r.code, r.stderr]).toEqual([1, `error: ${FRAGMENT} is not craftar's — run craftar status\n`]);
  });

  it("up: a service name starting with '-' is refused first, even with no lock", async () => {
    const want = [1, 'error: service name "-v" starts with "-" — refused\n'];
    const s = await synced();
    const a = up(s.wsRoot, "--", "-v");
    expect([a.code, a.stderr]).toEqual(want);
    const never = await workspace();
    const b = up(never.wsRoot, "--", "-v");
    expect([b.code, b.stderr]).toEqual(want);
  });

  it("up: everything intact → only then Docker is looked for", async () => {
    const s = await synced();
    const r = up(s.wsRoot);
    expect([r.code, r.stderr]).toEqual([1, `error: ${NOT_FOUND}\n`]);
  });

  it("down is never gated on the lock or the files: with and without a lock it gets as far as Docker", async () => {
    const s = await synced();
    await fs.rm(path.join(s.wsRoot, FRAGMENT));
    const a = runCli(["services", "down", "--volumes", "--workspace", s.wsRoot], { env: NO_DOCKER });
    expect([a.code, a.stderr]).toEqual([1, `error: ${NOT_FOUND}\n`]);
    const never = await workspace();
    const b = runCli(["services", "down", "--workspace", never.wsRoot], { env: NO_DOCKER });
    expect([b.code, b.stderr]).toEqual([1, `error: ${NOT_FOUND}\n`]);
  });

  it("status --json: the contract's keys in order, every value, exit 1 with Docker absent", async () => {
    const s = await synced();
    const r = statusJson(s.wsRoot);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(Object.keys(j)).toEqual(["workspace", "project", "composeFile", "docker", "services", "pending", "warnings"]);
    expect(j.project).toMatch(/^craftar-ws-[0-9a-f]{8}$/);
    expect({ ...j, project: "<p>" }).toEqual({
      workspace: realpathSync(s.wsRoot),
      project: "<p>",
      composeFile: ".craftar/compose.yaml",
      docker: { available: false, compose: null },
      services: [{ name: "echo", ingredient: "service/echo", state: "not created", health: null, ports: [] }],
      pending: [],
      warnings: [NOT_FOUND],
    });
    expect(Object.keys(j.services[0])).toEqual(["name", "ingredient", "state", "health", "ports"]);
  });

  it("status --json: a missing fragment is pending and declares nothing; an unrecorded stack has composeFile null", async () => {
    const s = await synced();
    await fs.rm(path.join(s.wsRoot, FRAGMENT));
    const j = JSON.parse(statusJson(s.wsRoot).stdout);
    expect([j.pending, j.services, j.composeFile]).toEqual([[{ path: FRAGMENT, reason: "missing" }], [], ".craftar/compose.yaml"]);

    const c = await workspace(true, { ".craftar/compose.yaml": "services:\n  mine:\n    image: example/mine:1\n" });
    runCli(["sync", "--workspace", c.wsRoot]);
    const k = JSON.parse(statusJson(c.wsRoot).stdout);
    expect([k.pending, k.services, k.composeFile]).toEqual([[{ path: ".craftar/compose.yaml", reason: "unrecorded" }], [], null]);
  });

  it("status reads the lock only: the Forge can be gone; with no lock it reports nothing declared", async () => {
    const s = await synced();
    await fs.rm(s.forgeRoot, { recursive: true, force: true });
    const j = JSON.parse(statusJson(s.wsRoot).stdout);
    expect(j.services).toEqual([{ name: "echo", ingredient: "service/echo", state: "not created", health: null, ports: [] }]);

    const never = await workspace();
    const r = statusJson(never.wsRoot);
    const k = JSON.parse(r.stdout);
    expect([r.code, k.services, k.pending, k.composeFile]).toEqual([1, [], [], null]);
  });

  it("status (text): the service line, the pending line, the warning on stderr", async () => {
    const s = await synced();
    await fs.appendFile(path.join(s.wsRoot, ".craftar/.gitattributes"), "# hand edit\n");
    const r = runCli(["services", "status", "--workspace", s.wsRoot], { env: NO_DOCKER });
    expect(r.code).toBe(1);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^craftar services — project craftar-ws-[0-9a-f]{8}$/);
    expect(lines.slice(1)).toEqual([
      "  echo  service/echo  not created",
      "  .craftar/.gitattributes — edited — run craftar sync --overwrite-drift to regenerate it, or delete it if craftar status calls it orphan-drift",
    ]);
    expect(r.stderr).toBe(`warn ${NOT_FOUND}\n`);
  });
});

describe("craftar services — surfaces that need no Docker at all (spec 31 §4.7)", () => {
  it("`craftar services` alone prints the group's help", () => {
    const r = runCli(["services"]);
    const text = r.stdout + r.stderr;
    for (const word of ["up [options] [service...]", "down [options]", "status [options]"]) expect(text).toContain(word);
  });

  it("explain and status --json carry the owner `services` for a file under .craftar/", async () => {
    const s = await synced();
    const e = runCli(["explain", FRAGMENT, "--workspace", s.wsRoot]);
    expect(e.code).toBe(0);
    expect(e.stdout.split("\n")).toContain("  target      services");
    const j = JSON.parse(runCli(["status", "--json", "--workspace", s.wsRoot]).stdout);
    expect(Object.keys(j).at(-1)).toBe("unsetParams");
    expect(JSON.stringify(j)).toContain(`"path":"${FRAGMENT}"`);
    const flat = JSON.stringify(j);
    expect(flat.includes(`"target":"services"`)).toBe(true);
  });

  it("sync --check: clean after a sync, 1 with drift after a hand edit; diff --exit-code agrees", async () => {
    const s = await synced();
    expect(runCli(["sync", "--check", "--workspace", s.wsRoot]).code).toBe(0);
    expect(runCli(["diff", "--exit-code", "--workspace", s.wsRoot]).code).toBe(0);
    await fs.appendFile(path.join(s.wsRoot, FRAGMENT), "# hand edit\n");
    const c = runCli(["sync", "--check", "--workspace", s.wsRoot]);
    expect(c.code).toBe(1);
    expect(c.stdout + c.stderr).toMatch(/drift/);
    expect(runCli(["diff", "--exit-code", "--workspace", s.wsRoot]).code).toBe(1);
  });

  it("removing the recipe's service: the next sync deletes the three files and the lock is schema 2 again", async () => {
    const s = await synced();
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), "name: base\ningredients: [rule/a]\n");
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    for (const p of [".craftar/compose.yaml", ".craftar/.gitattributes", FRAGMENT]) expect(existsSync(path.join(s.wsRoot, p)), p).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(s.wsRoot, "craftar.lock"), "utf8")).schema).toBe(2);
  });

  it("ingredients --type service lists the ingredient", async () => {
    const s = await synced();
    const r = runCli(["ingredients", "--type", "service", "--json", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.ingredients.map((i: { ref: string; targets: string[]; inUse: boolean }) => [i.ref, i.targets, i.inUse])).toEqual([["service/echo", [], true]]);
  });
});
