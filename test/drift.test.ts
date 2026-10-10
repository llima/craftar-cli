import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";
import { loadWorkspace, plan, readLock, status, apply } from "../src/core/sync.js";
import { hashNormalized } from "../src/core/text.js";
import { profile, recipe, rule, scenario, tmpDir } from "./helpers/forge.js";

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

// In a listing every column is as wide as its longest value: `forge: same` is padded to `forge: removed` / `forge: changed`.
const ROW_A = `drift         ${A}  rule/a  forge: same     promote: yes\n`;
const ROW_B = `drift         ${B}  rule/b  forge: same     promote: yes\n`;
const ROW_C = `orphan-drift  ${C}  rule/c  forge: removed  promote: no (no longer produced)\n`;
/** The row of a alone: nothing to line up with. */
const ONLY_A = `drift         ${A}  rule/a  forge: same  promote: yes\n`;
const DIFF_A = `--- ${A} (disk, drift)\n+++ ${A} (forge)\n  A one\n  A two\n- hand a\n`;

/** Every file under `dir` with its bytes, to prove a command wrote nothing there. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else out[path.relative(dir, abs)] = (await fs.readFile(abs)).toString("base64");
    }
  };
  await walk(dir);
  return out;
}

describe("cli — drift show", () => {
  it("lists every hand-edited file with its Forge side and whether it can be promoted", async () => {
    const f = await F3();
    const r = runCli(["drift", "show", "--workspace", f.ws]);
    expect([r.code, r.stderr, r.stdout]).toEqual([0, "", ROW_A + ROW_B + ROW_C]);
  });

  it("craftar drift alone is drift show", async () => {
    const f = await F3();
    const r = runCli(["drift", "--workspace", f.ws]);
    expect([r.code, r.stderr, r.stdout]).toEqual([0, "", ROW_A + ROW_B + ROW_C]);
  });

  it("forge: changed when the Forge also moved the file since the last sync", async () => {
    const f = await F();
    await f.driftA();
    await f.updateB();
    await f.driftB();
    const r = runCli(["drift", "show", "--workspace", f.ws]);
    expect([r.code, r.stdout]).toEqual([0, ROW_A + `drift         ${B}  rule/b  forge: changed  promote: yes\n`]);
  });

  it("no drift", async () => {
    const f = await F();
    const r = runCli(["drift", "show", "--workspace", f.ws]);
    expect([r.code, r.stderr, r.stdout]).toEqual([0, "", "no drift\n"]);
  });

  it("a drifted path: its row, then what craftar diff prints for it", async () => {
    const f = await F3();
    const r = runCli(["drift", "show", A, "--workspace", f.ws]);
    expect([r.code, r.stderr, r.stdout]).toEqual([0, "", ONLY_A + DIFF_A]);
    expect(runCli(["diff", A, "--workspace", f.ws]).stdout).toBe(DIFF_A);
  });

  it("a hand-edited orphan: its row, then the removal of the whole file", async () => {
    const f = await F3();
    const r = runCli(["drift", "show", C, "--workspace", f.ws]);
    expect([r.code, r.stderr, r.stdout]).toEqual([
      0,
      "",
      ROW_C + `--- ${C} (disk, orphan-drift)\n+++ ${C} (forge: no longer produced — \`craftar drift discard\` removes it)\n- C one\n- hand c\n`,
    ]);
  });

  it("a managed path that is not drifted says so and exits 0", async () => {
    const f = await F();
    await f.driftA();
    const r = runCli(["drift", "show", B, "--workspace", f.ws]);
    expect([r.code, r.stderr, r.stdout]).toEqual([0, "", `${B} is not drifted (unchanged)\n`]);
  });

  it("a path craftar does not manage exits 1 with diff --exit-code's message", async () => {
    const f = await F3();
    const r = runCli(["drift", "show", "nope.md", "--workspace", f.ws]);
    expect([r.code, r.stdout, r.stderr]).toEqual([
      1,
      "",
      "error: nope.md is not a file craftar manages in this workspace — pass the workspace-relative path as `craftar status` prints it (forward slashes)\n",
    ]);
  });

  it("a leading ./ and backslashes name the same file", async () => {
    const f = await F3();
    for (const p of [`./${A}`, ".claude\\rules\\a.md"]) expect(runCli(["drift", "show", p, "--workspace", f.ws]).stdout).toBe(ONLY_A + DIFF_A);
  });

  it("--json: the rows as data, keys in order; a path narrows files, a clean one empties it", async () => {
    const f = await F3();
    const r = runCli(["drift", "show", "--json", "--workspace", f.ws]);
    expect([r.code, r.stderr]).toEqual([0, ""]);
    const parsed = JSON.parse(r.stdout);
    const row = (p: string, state: string, ingredient: string, forge: string, promotable: boolean, reason: string | null) => ({ path: p, state, target: "claude-code", ingredient, forge, promotable, reason });
    expect(parsed).toEqual({
      workspace: await fs.realpath(f.ws),
      profile: "acme",
      files: [row(A, "drift", "rule/a", "same", true, null), row(B, "drift", "rule/b", "same", true, null), row(C, "orphan-drift", "rule/c", "removed", false, "no longer produced")],
      warnings: [],
      unsetParams: [],
    });
    expect(Object.keys(parsed)).toEqual(["workspace", "profile", "files", "warnings", "unsetParams"]);
    expect(Object.keys(parsed.files[0])).toEqual(["path", "state", "target", "ingredient", "forge", "promotable", "reason"]);
    expect(JSON.parse(runCli(["drift", "show", A, "--json", "--workspace", f.ws]).stdout).files).toEqual([row(A, "drift", "rule/a", "same", true, null)]);
    await fs.writeFile(path.join(f.ws, B), "B one\nB two\n");
    expect(JSON.parse(runCli(["drift", "show", B, "--json", "--workspace", f.ws]).stdout).files).toEqual([]);
  });

  it("it writes nothing: not the lock, not $CRAFTAR_HOME", async () => {
    const f = await F3();
    const home = process.env.CRAFTAR_HOME!;
    const before = [await fs.readFile(path.join(f.ws, "craftar.lock")), await snapshot(home)] as const;
    for (const args of [["drift", "show"], ["drift", "show", A], ["drift", "show", "--json"]]) expect(runCli([...args, "--workspace", f.ws]).code).toBe(0);
    expect((await fs.readFile(path.join(f.ws, "craftar.lock"))).equals(before[0])).toBe(true);
    expect(await snapshot(home)).toEqual(before[1]);
  });
});

describe("cli — drift show, columns", () => {
  it("paths and ingredients of different lengths line up", async () => {
    const s = await scenario(
      {
        ingredients: [rule("a", "A one\n"), rule("backend-node", "N one\n")],
        recipes: [recipe("base", ["rule/a", "rule/backend-node"])],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    for (const n of ["a", "backend-node"]) await fs.appendFile(path.join(s.wsRoot, `.claude/rules/${n}.md`), "hand\n");
    expect(runCli(["drift", "show", "--workspace", s.wsRoot]).stdout).toBe(
      "drift         .claude/rules/a.md             rule/a             forge: same  promote: yes\n" +
        "drift         .claude/rules/backend-node.md  rule/backend-node  forge: same  promote: yes\n",
    );
  });
});

describe("cli — drift discard", () => {
  const NOW_DRIFT = "hand-edited since last sync — `craftar drift show <path>`, then `craftar drift discard` or `craftar drift promote`";
  const NOW_ORPHAN = "no longer produced by the Forge but hand-edited — kept; `craftar drift discard <path>` removes it, or delete it yourself";
  const ONE =
    `discarding 1 hand edit(s): ${A}\n` + HEADER + "  wrote 1, removed 0 orphan(s), skipped 2\n" + `  + ${A}\n` + `  ! ${B}  ${NOW_DRIFT}\n` + `  ! ${C}  ${NOW_ORPHAN}\n`;
  const TWO = (verb: string) =>
    `discarding 2 hand edit(s): ${A}, ${C}\n` + HEADER + `  ${verb} 1, removed 1 orphan(s), skipped 1\n` + `  + ${A}\n` + `  - ${C}  (hand-edited orphan: discarded)\n` + `  ! ${B}  ${NOW_DRIFT}\n`;
  const lockBytes = (ws: string) => fs.readFile(path.join(ws, "craftar.lock"));
  const hashes = async (f: Awaited<ReturnType<typeof F>>) => Object.fromEntries((await f.lock()).files.map((e) => [e.path, e.hash]));

  it("one drifted file is regenerated; the other hand edits and their lock entries stay", async () => {
    const f = await F3();
    const r = runCli(["drift", "discard", A, "--workspace", f.ws]);
    expect([r.code, r.stderr, r.stdout]).toEqual([0, "", ONE]);
    expect([await f.read(A), await f.read(B), await f.read(C)]).toEqual(["A one\nA two\n", "B one\nB two\nhand b\n", "C one\nhand c\n"]);
    expect(await hashes(f)).toEqual({ [A]: hashNormalized("A one\nA two\n"), [B]: HASH.b, [C]: HASH.c });
    expect(hashNormalized("A one\nA two\n")).toBe(HASH.a);
  });

  it("a drift and a hand-edited orphan, arguments out of order: one regenerated, one removed", async () => {
    const f = await F3();
    const r = runCli(["drift", "discard", C, `./${A}`, "--workspace", f.ws]);
    expect([r.code, r.stderr, r.stdout]).toEqual([0, "", TWO("wrote")]);
    await expect(fs.stat(path.join(f.ws, C))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.lock()).files.map((e) => e.path)).toEqual([A, B]);
  });

  it("a repeated path counts once", async () => {
    const f = await F3();
    expect(runCli(["drift", "discard", A, A, "--workspace", f.ws]).stdout).toBe(ONE);
  });

  it("a path that is not drifted fails the whole run, naming every offender; nothing is written", async () => {
    const f = await F();
    await f.driftA();
    const before = await lockBytes(f.ws);
    const r = runCli(["drift", "discard", A, B, "nope.md", "--workspace", f.ws]);
    expect([r.code, r.stdout, r.stderr]).toEqual([1, "", `error: not drifted: ${B} (unchanged), nope.md (not managed) — nothing was written\n`]);
    expect(await f.read(A)).toBe("A one\nA two\nhand a\n");
    expect((await lockBytes(f.ws)).equals(before)).toBe(true);
  });

  it("--dry-run says what it would do and touches neither the files nor the lock", async () => {
    const f = await F3();
    const before = await lockBytes(f.ws);
    const r = runCli(["drift", "discard", C, `./${A}`, "--dry-run", "--workspace", f.ws]);
    expect([r.code, r.stderr, r.stdout]).toEqual([0, "", TWO("would write")]);
    expect([await f.read(A), await f.read(B), await f.read(C)]).toEqual(["A one\nA two\nhand a\n", "B one\nB two\nhand b\n", "C one\nhand c\n"]);
    expect((await lockBytes(f.ws)).equals(before)).toBe(true);
  });

  it("the run is a sync: a pending update of another file is written with it", async () => {
    const f = await F();
    await f.driftA();
    await f.updateB();
    const r = runCli(["drift", "discard", A, "--workspace", f.ws]);
    expect([r.code, r.stdout]).toEqual([0, `discarding 1 hand edit(s): ${A}\n` + HEADER + "  wrote 2, removed 0 orphan(s), skipped 0\n" + `  + ${A}\n` + `  + ${B}\n`]);
    expect(await f.read(B)).toBe("B one\nB changed\n");
  });

  it("it registers the workspace as sync does, and not under --dry-run", async () => {
    for (const dry of [false, true]) {
      const s = await scenario(
        { ingredients: [rule("a", "A one\nA two\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      );
      cleanups.push(s.cleanup);
      // Synced through the API, so nothing is registered before the command under test.
      const w = await loadWorkspace(s.wsRoot);
      const p = await plan(w);
      await apply(w, p, await status(w, p, await readLock(w.root)));
      await fs.appendFile(path.join(s.wsRoot, A), "hand a\n");
      const env = { CRAFTAR_HOME: await tmpDir() };
      expect(runCli(["drift", "discard", A, ...(dry ? ["--dry-run"] : []), "--workspace", s.wsRoot], { env }).code).toBe(0);
      const listed = JSON.parse(runCli(["workspaces", "--json"], { env }).stdout).workspaces.map((x: { path: string }) => x.path);
      expect(listed).toEqual(dry ? [] : [await fs.realpath(s.wsRoot)]);
    }
  });

  it("no path is commander's own error; nothing is written", async () => {
    const f = await F3();
    const before = await lockBytes(f.ws);
    const r = runCli(["drift", "discard", "--workspace", f.ws]);
    expect([r.code, r.stdout, r.stderr]).toEqual([1, "", "error: missing required argument 'path'\n"]);
    expect((await lockBytes(f.ws)).equals(before)).toBe(true);
  });

  it("a workspace with an unset param refuses exactly as sync does — nothing printed on stdout", async () => {
    // A rule that declares a param with no default, and no layer sets it
    // Build a workspace that can sync, then add the unset param to the Forge
    const s = await scenario(
      {
        ingredients: [rule("a", "A one\n")],
        recipes: [recipe("base", ["rule/a"])],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);

    // Drift the file
    await fs.appendFile(path.join(s.wsRoot, A), "hand a\n");

    // Now add the unset param to the Forge - must use correct YAML structure
    const ingDir = path.join(s.forgeRoot, "ingredients/rules/a");
    await fs.writeFile(path.join(ingDir, "ingredient.yaml"), `type: rule
name: a
targets: "*"
tags: []
params:
  org: {}
`);
    await fs.writeFile(path.join(ingDir, "rule.md"), "Org: {{org}}\n");

    // First check that sync refuses with this param
    const syncR = runCli(["sync", "--workspace", s.wsRoot]);
    expect(syncR.code).toBe(1);
    const syncStdout = syncR.stdout;
    const syncStderr = syncR.stderr;
    expect(syncStderr).toContain("1 declared parameter(s) have no value");
    expect(syncStderr).toContain("org");

    // Now test discard - should refuse the same way (warnings on stdout, refusal on stderr)
    const lockBefore = await fs.readFile(path.join(s.wsRoot, "craftar.lock"));
    const r = runCli(["drift", "discard", A, "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    // The same stdout that sync prints (plan warnings before the refusal)
    expect(r.stdout).toBe(syncStdout);
    // The same stderr that sync prints
    expect(r.stderr).toBe(syncStderr);
    // Lock unchanged
    expect((await fs.readFile(path.join(s.wsRoot, "craftar.lock"))).equals(lockBefore)).toBe(true);
  });
});


describe("cli — drift show on refused workspaces (spec 30r5)", () => {
  // A workspace with a declared param that has no value has its sync REFUSED.
  // drift show decides the refused sync as status does:
  // - text mode: the listing, then the refusal block on stderr, exit 1
  // - --json: the object gains `unsetParams` (always present, after warnings), exit 1

  /** A workspace with one drifted file AND a declared param with no value. */
  async function refused() {
    const s = await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "a", params: { org: {} } },
            files: { "rule.md": "Org: {{org}}\n" },
          },
        ],
        recipes: [recipe("base", ["rule/a"])],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    // Write the file manually since sync refuses
    await fs.mkdir(path.join(s.wsRoot, ".claude/rules"), { recursive: true });
    await fs.writeFile(path.join(s.wsRoot, ".claude/rules/a.md"), "Org: {{org}}\n");
    // Create a lock manually - must match LockSchemaV2
    // Use the real hash to ensure forge: same
    const fileHash = hashNormalized("Org: {{org}}\n");
    await fs.writeFile(
      path.join(s.wsRoot, "craftar.lock"),
      JSON.stringify({
        schema: 2,
        generatedAt: new Date().toISOString(),
        forge: { source: "path", ref: null, commit: null },
        profile: "acme",
        recipes: ["base"],
        targets: ["claude-code"],
        files: [{ path: ".claude/rules/a.md", hash: fileHash, target: "claude-code", ingredient: "rule/a" }],
      }),
    );
    // Drift the file
    await fs.appendFile(path.join(s.wsRoot, ".claude/rules/a.md"), "hand\n");
    return s;
  }

  it("text mode: listing, then the refusal block on stderr, exit 1", async () => {
    const s = await refused();
    // First run status to get its exact stderr
    const statusR = runCli(["status", "--workspace", s.wsRoot]);
    expect(statusR.code).toBe(1);
    const expectedStderr = statusR.stderr;
    expect(expectedStderr).toBe(
      "error: 1 declared parameter(s) have no value — nothing written\n" +
        "  org  declared by rule/a · cited by rule/a\n" +
        "  fix: set each under params in the profile, or under overrides.params in craftar.yaml\n",
    );

    // Now run drift show
    const r = runCli(["drift", "show", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(expectedStderr);
    expect(r.stdout).toBe("drift         .claude/rules/a.md  rule/a  forge: same  promote: yes\n");
  });

  it("--json: unsetParams is present (same value as status --json), exit 1", async () => {
    const s = await refused();
    // First run status --json to get its unsetParams
    const statusR = runCli(["status", "--json", "--workspace", s.wsRoot]);
    expect(statusR.code).toBe(1);
    const statusParsed = JSON.parse(statusR.stdout);
    expect(statusParsed.unsetParams).toEqual([{ key: "org", declaredBy: ["rule/a"], citedBy: ["rule/a"] }]);

    // Now run drift show --json
    const r = runCli(["drift", "show", "--json", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.unsetParams).toEqual(statusParsed.unsetParams);
    expect(parsed.unsetParams).toEqual([{ key: "org", declaredBy: ["rule/a"], citedBy: ["rule/a"] }]);
    // Check key order: unsetParams comes after warnings
    expect(Object.keys(parsed)).toEqual(["workspace", "profile", "files", "warnings", "unsetParams"]);
  });

  it("with a path: the diff, then the refusal block, exit 1", async () => {
    const s = await refused();
    // First run status to get the exact stderr
    const statusR = runCli(["status", "--workspace", s.wsRoot]);
    const expectedStderr = statusR.stderr;

    const r = runCli(["drift", "show", ".claude/rules/a.md", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(expectedStderr);
    // The stdout should have the row and the diff
    expect(r.stdout).toBe(
      "drift         .claude/rules/a.md  rule/a  forge: same  promote: yes\n" +
        "--- .claude/rules/a.md (disk, drift)\n" +
        "+++ .claude/rules/a.md (forge)\n" +
        "  Org: {{org}}\n" +
        "- hand\n",
    );
  });

  it("no hand-edited files: the 'no drift' line, then the refusal block, exit 1", async () => {
    // A workspace with no drift but a refused param
    const s = await scenario(
      {
        ingredients: [
          {
            meta: { type: "rule", name: "a", params: { org: {} } },
            files: { "rule.md": "Org: {{org}}\n" },
          },
        ],
        recipes: [recipe("base", ["rule/a"])],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    // Write the file manually since sync refuses
    await fs.mkdir(path.join(s.wsRoot, ".claude/rules"), { recursive: true });
    await fs.writeFile(path.join(s.wsRoot, ".claude/rules/a.md"), "Org: {{org}}\n");
    // Create a lock with the same hash (no drift) - must match LockSchemaV2
    const hash = hashNormalized("Org: {{org}}\n");
    await fs.writeFile(
      path.join(s.wsRoot, "craftar.lock"),
      JSON.stringify({
        schema: 2,
        generatedAt: new Date().toISOString(),
        forge: { source: "path", ref: null, commit: null },
        profile: "acme",
        recipes: ["base"],
        targets: ["claude-code"],
        files: [{ path: ".claude/rules/a.md", hash, target: "claude-code", ingredient: "rule/a" }],
      }),
    );

    // First run status to get the exact stderr
    const statusR = runCli(["status", "--workspace", s.wsRoot]);
    expect(statusR.code).toBe(1);
    const expectedStderr = statusR.stderr;

    const r = runCli(["drift", "show", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(expectedStderr);
    expect(r.stdout).toBe("no drift\n");
  });
});


describe("cli — drift show and the example file (spec 27 Ruling 4)", () => {
  const EX = ".claude/settings.craftar.example.json";
  const MARKER = "MARKER_TYPED_30";
  const mcp = { meta: { type: "mcp", name: "tracker", authEnv: ["ACME_TRACKER_TOKEN"], server: { command: "npx" } } };

  it("drift show withholds the example file's content, as diff does", async () => {
    const s = await scenario(
      { ingredients: [mcp], recipes: [recipe("base", ["mcp/tracker"])], profiles: [profile("acme", ["base"])] },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    runCli(["sync", "--workspace", s.wsRoot]);
    // Overwrite the example file with a value containing the marker
    const drifted = '{\n  "env": {\n    "ACME_TRACKER_TOKEN": "' + MARKER + '"\n  }\n}\n';
    await fs.writeFile(path.join(s.wsRoot, EX), drifted);
    const r = runCli(["drift", "show", EX, "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      `drift         ${EX}  mcp/*  forge: same  promote: no (.mcp.json)\n` +
        `--- ${EX} (disk, drift)\n` +
        `+++ ${EX} (forge)\n` +
        "  content not shown: an example file may hold a value typed by hand\n",
    );
    expect(r.stdout.includes(MARKER)).toBe(false);
  });
});

describe("cli — drift --help", () => {
  it("lists show, discard and promote", () => {
    const r = runCli(["drift", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      "Usage: craftar drift [options] [command]\n\n" +
        "Hand-edited generated files: show them, discard the edit, or promote it to the\n" +
        "Forge\n\n" +
        "Options:\n" +
        "  -h, --help                   display help for command\n\n" +
        "Commands:\n" +
        "  show [options] [path]        List the files hand-edited since the last sync,\n" +
        "                               with the Forge's side and whether the edit can be\n" +
        "                               promoted; with a path, that file's row and its\n" +
        "                               diff. Writes nothing\n" +
        "  discard [options] <path...>  Regenerate the named hand-edited files from the\n" +
        "                               Forge (their edits are lost) and remove a named\n" +
        "                               hand-edited file the Forge no longer produces;\n" +
        "                               otherwise a sync like any other\n" +
        "  promote [options] <path>     Carry a hand-edited file to the Forge as a\n" +
        "                               profile variant, behind git's gate, proved before\n" +
        "                               any write; never writes the lock, the registry or\n" +
        "                               the cache\n" +
        "  help [command]               display help for command\n",
    );
  });
});
