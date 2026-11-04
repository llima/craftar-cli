import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listFiles } from "../src/core/forge.js";
import { proveNewProfileLoads } from "../src/core/new-profile-write.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, profile, recipe, rule, tmpDir, type ForgeSpec } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";
import { git } from "./helpers/remote.js";

// E38.1: `init --new-profile` proves, on a scratch copy, that the Forge loads with the new profile — before writing it.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const SPEC: ForgeSpec = {
  ingredients: [rule("a", "# A\n")],
  recipes: [recipe("base", ["rule/a"])],
  profiles: [profile("acme", ["base"], ["claude-code"])],
};
async function setup() {
  const parent = await fs.realpath(await tmpDir("craftar-np-proof-"));
  cleanups.push(() => removeWithRetry(parent));
  const forge = path.join(parent, "forge");
  const tmp = path.join(parent, "tmp");
  await fs.mkdir(tmp);
  await makeForge(forge, SPEC);
  git(forge, "init", "-q", "-b", "main");
  git(forge, "add", "-A");
  git(forge, "commit", "-q", "-m", "init");
  return { parent, forge, tmp };
}
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of await listFiles(dir)) if (!rel.startsWith(".git/")) out[rel] = await fs.readFile(path.join(dir, rel), "utf8");
  return out;
}
async function withTmp<T>(tmp: string, f: () => Promise<T>): Promise<T> {
  const prev = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  for (const k of Object.keys(prev)) process.env[k] = tmp;
  try {
    return await f();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("proveNewProfileLoads (E38.1)", () => {
  it("refuses a profile the Forge would not load with, the Forge untouched and no copy left", async () => {
    // No profile `newProfile` builds fails the load on 0.60.0 (it is read back through ProfileSchema and planned in
    // memory first); the proof is the gate behind that, so it is handed a text that does not parse.
    const s = await setup();
    const before = await tree(s.forge);
    const init = { newProfile: { path: "profiles/initech/profile.yaml", text: "name: initech\nrecipes: [base\n" } } as never;
    const err = await withTmp(s.tmp, () => proveNewProfileLoads(s.forge, init).then(() => null, (e: Error) => e.message));
    expect(err).toMatch(/^init: the Forge would not load with profile initech:\n/);
    expect(err).toMatch(/\nnothing written$/);
    expect(err).not.toContain(s.tmp);
    expect(await tree(s.forge)).toEqual(before);
    expect((await fs.readdir(s.tmp)).filter((n) => n.startsWith("craftar-"))).toEqual([]);
  });

  it("(control) init --new-profile still writes the profile and leaves no scratch copy", async () => {
    const s = await setup();
    const ws = path.join(s.parent, "ws");
    const r = runCli(["init", "--forge", s.forge, "--new-profile", "initech", "--like", "acme", "--workspace", ws], {
      env: { CRAFTAR_HOME: path.join(s.parent, "home"), TMPDIR: s.tmp, TEMP: s.tmp, TMP: s.tmp },
    });
    expect(r.code, r.stderr).toBe(0);
    expect(await fs.readFile(path.join(s.forge, "profiles/initech/profile.yaml"), "utf8")).toContain("name: initech");
    expect((await fs.readdir(s.tmp)).filter((n) => n.startsWith("craftar-"))).toEqual([]);
  });
});
