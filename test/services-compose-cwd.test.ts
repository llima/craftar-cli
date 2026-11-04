import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCli } from "./helpers/cli.js";
import { fakeDocker, readDockerLog } from "./helpers/fake-docker.js";
import { profile, recipe, rule, scenario, type IngredientSpec } from "./helpers/forge.js";

// Tech-debt V1 (E15.2, E15.1). No test starts Docker: a copy of node named `docker` answers (helpers/fake-docker.ts).
// runCli starts craftar in the repository, never in the workspace, so the Compose child's directory tells the two apart.

const echo: IngredientSpec = {
  meta: { type: "service", name: "echo" },
  files: { "compose.yaml": "services:\n  echo:\n    image: example/echo:1\n" },
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function synced(files: Record<string, string> = {}) {
  const s = await scenario(
    {
      ingredients: [echo, rule("a", "# A\n")],
      recipes: [recipe("base", ["rule/a", "service/echo"])],
      profiles: [profile("acme", ["base"])],
    },
    { config: { profile: "acme" }, files },
  );
  cleanups.push(s.cleanup);
  const r = runCli(["sync", "--workspace", s.wsRoot]);
  expect([r.code, r.stderr]).toEqual([0, ""]);
  return s;
}

async function docker() {
  const d = await fakeDocker();
  cleanups.push(d.cleanup);
  return d;
}

/** Real paths compared as Windows compares them. */
const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

const STRAY_ENV =
  "error: .craftar/.env exists and the workspace has no .env — Compose would read it, and craftar.lock does not record it; move it to .env at the workspace root, or remove it";

describe("services: the Compose child runs in the workspace (E15.2)", () => {
  it("up, down and status run every compose call with the workspace's real path as working directory", async () => {
    const s = await synced();
    const d = await docker();
    const real = await fs.realpath(s.wsRoot);
    for (const sub of ["up", "down", "status"]) {
      const r = runCli(["services", sub, "--workspace", s.wsRoot], { env: d.env() });
      expect([sub, r.code, r.stderr]).toEqual([sub, 0, ""]);
    }
    const calls = (await readDockerLog(d.log)).filter((c) => c.args[1] !== "version");
    expect(calls.map((c) => c.args.find((a) => ["up", "down", "ps"].includes(a)))).toEqual(["up", "down", "ps"]);
    for (const c of calls) expect([c.args.join(" "), same(c.cwd, real)]).toEqual([c.args.join(" "), true]);
  });
});

describe("services up: an unrecorded .craftar/.env with no root .env (E15.1, decision 17)", () => {
  it("is refused before Docker is looked for, naming the file and never its content", async () => {
    const s = await synced();
    await fs.writeFile(path.join(s.wsRoot, ".craftar", ".env"), "SECRET_VALUE_XYZ=1\n");
    const d = await docker();
    const r = runCli(["services", "up", "--workspace", s.wsRoot], { env: d.env() });
    expect(r.code).toBe(1);
    expect(r.stderr.trimEnd()).toBe(STRAY_ENV);
    expect(r.stdout + r.stderr).not.toContain("SECRET_VALUE_XYZ");
    expect(await readDockerLog(d.log)).toEqual([]);
  });

  it("is refused when .craftar/.env is a directory", async () => {
    const s = await synced();
    await fs.mkdir(path.join(s.wsRoot, ".craftar", ".env"));
    const d = await docker();
    const r = runCli(["services", "up", "--workspace", s.wsRoot], { env: d.env() });
    expect([r.code, r.stderr.trimEnd()]).toEqual([1, STRAY_ENV]);
    expect(await readDockerLog(d.log)).toEqual([]);
  });

  it("goes on with a root .env, which is passed as --env-file", async () => {
    const s = await synced({ ".env": "A=1\n" });
    await fs.writeFile(path.join(s.wsRoot, ".craftar", ".env"), "B=2\n");
    const d = await docker();
    const r = runCli(["services", "up", "--workspace", s.wsRoot], { env: d.env() });
    expect([r.code, r.stderr]).toEqual([0, ""]);
    const upCall = (await readDockerLog(d.log)).find((c) => c.args.includes("up"));
    expect(upCall?.args).toContain("--env-file");
  });

  it("down and status are not refused on it (only up is, by decision 17)", async () => {
    const s = await synced();
    await fs.writeFile(path.join(s.wsRoot, ".craftar", ".env"), "B=2\n");
    const d = await docker();
    for (const sub of ["down", "status"]) {
      const r = runCli(["services", sub, "--workspace", s.wsRoot], { env: d.env() });
      expect([sub, r.code, r.stderr]).toEqual([sub, 0, ""]);
    }
  });
});
