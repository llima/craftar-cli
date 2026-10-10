import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, scenario } from "./helpers/forge.js";

// Spec 30: what `sync`, `status` and `diff` do with a hand-edited file, and the `drift` commands over it.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const A = ".claude/rules/a.md";
const B = ".claude/rules/b.md";
const C = ".claude/rules/c.md";
const HASH = {
  a: "sha256:b6a7f9820b2718bf8b6bcdc19be80457e46d1bb8752c7ebb786cf4e937c64ae1",
  b: "sha256:048b356869ea169a3f9422cbcc74387065e2c5a80eb7cb4cdedd4b157e8f118f",
  c: "sha256:1b5dd7d4e03d0a3e31577f9e74dcdd8f9c5c594172e88bbf9894463b0031379e",
};

/** Three rules, one profile, claude-code only, synced once. */
async function F() {
  const s = await scenario(
    {
      ingredients: [rule("a", "A one\nA two\n"), rule("b", "B one\nB two\n"), rule("c", "C one\n")],
      recipes: [recipe("base", ["rule/a", "rule/b", "rule/c"])],
      profiles: [profile("acme", ["base"])],
    },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
  const at = (rel: string) => path.join(s.wsRoot, rel);
  return {
    ...s,
    ws: s.wsRoot,
    read: (rel: string) => fs.readFile(at(rel), "utf8"),
    lock: async () => JSON.parse(await fs.readFile(at("craftar.lock"), "utf8")) as { files: Array<{ path: string; hash: string; target: string; ingredient: string }> },
    driftA: () => fs.appendFile(at(A), "hand a\n"),
    driftB: () => fs.appendFile(at(B), "hand b\n"),
    orphanDriftC: async () => {
      await fs.appendFile(at(C), "hand c\n");
      await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), YAML.stringify(recipe("base", ["rule/a", "rule/b"])));
    },
    updateB: () => fs.writeFile(path.join(s.forgeRoot, "ingredients/rules/b/rule.md"), "B one\nB changed\n"),
  };
}

/** F with a hand edit on a and on b, and c hand-edited then dropped from the Forge. */
async function F3() {
  const f = await F();
  await f.driftA();
  await f.driftB();
  await f.orphanDriftC();
  return f;
}

const HEADER = "craftar sync — profile acme · recipes base · targets claude-code\n";
const SKIP_DRIFT = "hand-edited since last sync — `craftar drift show <path>`, then `craftar drift discard` or `craftar drift promote`";
const SKIP_ORPHAN = "no longer produced by the Forge but hand-edited — kept; `craftar drift discard <path>` removes it, or delete it yourself";
const entry = (p: string, hash: string, ingredient: string) => ({ path: p, hash, target: "claude-code", ingredient });

describe("cli — hand-edited files, pinned before spec 30", () => {
  it("sync skips the three and says why; the files and the lock stay", async () => {
    const f = await F3();
    const r = runCli(["sync", "--workspace", f.ws]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      HEADER +
        "  wrote 0, removed 0 orphan(s), skipped 3\n" +
        `  ! ${A}  ${SKIP_DRIFT}\n` +
        `  ! ${B}  ${SKIP_DRIFT}\n` +
        `  ! ${C}  ${SKIP_ORPHAN}\n`,
    );
    expect(await f.read(A)).toBe("A one\nA two\nhand a\n");
    expect(await f.read(B)).toBe("B one\nB two\nhand b\n");
    expect(await f.read(C)).toBe("C one\nhand c\n");
    expect((await f.lock()).files).toEqual([entry(A, HASH.a, "rule/a"), entry(B, HASH.b, "rule/b"), entry(C, HASH.c, "rule/c")]);
  });

  it("sync --overwrite-drift --dry-run would write the two drifted files and keeps the orphan", async () => {
    const f = await F3();
    const r = runCli(["sync", "--overwrite-drift", "--dry-run", "--workspace", f.ws]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(HEADER + "  would write 2, removed 0 orphan(s), skipped 1\n" + `  + ${A}\n` + `  + ${B}\n` + `  ! ${C}  ${SKIP_ORPHAN}\n`);
    expect([await f.read(A), await f.read(B), await f.read(C)]).toEqual(["A one\nA two\nhand a\n", "B one\nB two\nhand b\n", "C one\nhand c\n"]);
  });

  it("sync --overwrite-drift regenerates the drifted files; a hand-edited orphan is still kept, with its lock entry", async () => {
    const f = await F3();
    expect(runCli(["sync", "--overwrite-drift", "--workspace", f.ws]).code).toBe(0);
    expect([await f.read(A), await f.read(B), await f.read(C)]).toEqual(["A one\nA two\n", "B one\nB two\n", "C one\nhand c\n"]);
    expect((await f.lock()).files.find((x) => x.path === C)).toEqual(entry(C, HASH.c, "rule/c"));
  });

  it("status lists the three", async () => {
    const f = await F3();
    const r = runCli(["status", "--workspace", f.ws]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      "craftar status — profile acme · recipes base\n" +
        "  drift 2  orphan-drift 1\n" +
        `  drift         ${A}  rule/a\n` +
        `  drift         ${B}  rule/b\n` +
        `  orphan-drift  ${C}  rule/c\n`,
    );
  });

  it("diff shows the hand edit of a drifted file, and one line for a hand-edited orphan", async () => {
    const f = await F3();
    const a = runCli(["diff", A, "--workspace", f.ws]);
    expect([a.code, a.stdout]).toEqual([0, `--- ${A} (disk, drift)\n+++ ${A} (forge)\n  A one\n  A two\n- hand a\n`]);
    const c = runCli(["diff", C, "--workspace", f.ws]);
    expect([c.code, c.stdout]).toEqual([0, `--- ${C} (disk, orphan-drift)\n  ${SKIP_ORPHAN}\n`]);
  });

  it("sync --check exits 1", async () => {
    const f = await F3();
    expect(runCli(["sync", "--check", "--workspace", f.ws]).code).toBe(1);
  });
});
