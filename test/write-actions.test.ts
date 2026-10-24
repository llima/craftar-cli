/**
 * Tests for src/core/write-actions.ts: syncWorkspace, editRecipes, statusDigest.
 * Core tests — no CLI, no subprocess, only in-process calls.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { readRegistry, registryFile } from "../src/core/registry.js";
import { syncWorkspace, editRecipes, statusDigest, confirmWrites, syncToolResult } from "../src/core/write-actions.js";
import { eightStates, type Scenario } from "./helpers/states.js";
import { tmpDir, scenario, rule, recipe, profile, writeFiles } from "./helpers/forge.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

describe("syncWorkspace", () => {
  it("1. returns apply result, registers workspace, forgeLine is null for path Forge", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(await eightStates());

    const ws = await loadWorkspace(s.wsRoot, { home });
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const st = await status(ws, p, lock);

    const outcome = await syncWorkspace(ws, p, st, lock, {
      home,
      registryOff: false,
    });

    // Check result matches what apply would return
    expect(outcome.result.written.sort()).toEqual([
      ".claude/rules/adopted.md",
      ".claude/rules/fresh.md",
      ".claude/rules/moved.md",
    ]);
    expect(outcome.result.removed).toEqual([".claude/rules/gone.md"]);
    expect(
      outcome.result.skipped
        .map((s) => [s.path, s.state])
        .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    ).toEqual([
      [".claude/rules/clash.md", "collision"],
      [".claude/rules/edited.md", "drift"],
      [".claude/rules/gone-edited.md", "orphan-drift"],
    ]);

    // Registry written and contains workspace
    expect(outcome.registry).toBeNull();
    const reg = await readRegistry(home);
    expect(reg.workspaces[0].path).toBe(await fs.realpath(s.wsRoot));

    // forgeLine is null for path Forge
    expect(outcome.forgeLine).toBeNull();
  });

  it("2. dryRun: nothing written, registry absent", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(await eightStates());

    const ws = await loadWorkspace(s.wsRoot, { home });
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const st = await status(ws, p, lock);

    const outcome = await syncWorkspace(ws, p, st, lock, {
      home,
      registryOff: false,
      dryRun: true,
    });

    // fresh.md should not exist
    await expect(fs.access(path.join(s.wsRoot, ".claude/rules/fresh.md"))).rejects.toThrow();

    // Registry should not exist
    await expect(fs.access(path.join(home, "registry.json"))).rejects.toThrow();

    // registry outcome is null (no failure, just not written)
    expect(outcome.registry).toBeNull();
  });

  it("3. registryOff: files written, registry absent", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(await eightStates());

    const ws = await loadWorkspace(s.wsRoot, { home });
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const st = await status(ws, p, lock);

    const outcome = await syncWorkspace(ws, p, st, lock, {
      home,
      registryOff: true,
    });

    // Files should be written
    await expect(fs.access(path.join(s.wsRoot, ".claude/rules/fresh.md"))).resolves.toBeUndefined();

    // Registry should not exist
    await expect(fs.access(path.join(home, "registry.json"))).rejects.toThrow();

    // registry outcome is null (not a failure)
    expect(outcome.registry).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "4. home is a file: does not throw, files written, registry error returned",
    async () => {
      const tmp = await tmpDir("home-");
      const homeFile = path.join(tmp, "home-file");
      await fs.writeFile(homeFile, "x");
      cleanups.push(() => fs.rm(tmp, { recursive: true, force: true }));

      const s = kept(await eightStates());
      const ws = await loadWorkspace(s.wsRoot, { home: homeFile });
      const p = await plan(ws);
      const lock = await readLock(ws.root);
      const st = await status(ws, p, lock);

      const outcome = await syncWorkspace(ws, p, st, lock, {
        home: homeFile,
        registryOff: false,
      });

      // Files should be written
      await expect(fs.access(path.join(s.wsRoot, ".claude/rules/fresh.md"))).resolves.toBeUndefined();

      // Registry error is returned, not thrown
      expect(outcome.registry).not.toBeNull();
      expect(outcome.registry!.file).toBe(registryFile(homeFile));
      expect(outcome.registry!.message).toBeTruthy();
    },
  );
});

describe("editRecipes", () => {
  it("5. add recipe extra: changed, craftar.yaml updated, next has statuses", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(
      await scenario(
        {
          ingredients: [rule("keep", "# Keep\n"), rule("extra-rule", "# Extra\n")],
          recipes: [recipe("base", ["rule/keep"]), recipe("extra", ["rule/extra-rule"])],
          profiles: [profile("acme", ["base"])],
        },
        { config: { profile: "acme" } },
      ),
    );

    const ws = await loadWorkspace(s.wsRoot, { home });
    const outcome = await editRecipes(ws, "add", ["extra"]);

    expect(outcome.changed).toBe(true);

    // craftar.yaml should now contain extra
    const yaml = await fs.readFile(path.join(s.wsRoot, "craftar.yaml"), "utf8");
    expect(yaml).toContain("extra");

    expect(outcome.next).not.toBeNull();
    expect(outcome.next!.recipes).toEqual(["base", "extra"]);

    // Check statuses include the new rule
    const newRule = outcome.next!.statuses.find((s) => s.path === ".claude/rules/extra-rule.md");
    expect(newRule).toBeDefined();
    expect(newRule!.state).toBe("new");

    expect(outcome.next!.unset).toEqual([]);
  });

  it("6. editRecipes when the edited workspace cannot plan — throws, craftar.yaml unchanged", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));

    // Create a Forge at schema 1 with a rule that has sections
    const s = kept(
      await scenario(
        {
          ingredients: [
            rule("keep", "# Keep\n"),
            rule("extra-rule", "<!-- craftar:section x -->\nx\n<!-- /craftar:section -->\n"),
          ],
          recipes: [recipe("base", ["rule/keep"]), recipe("extra", ["rule/extra-rule"])],
          profiles: [profile("acme", ["base"])],
        },
        { config: { profile: "acme" } },
      ),
    );
    // Ensure schema 1 (the default from scenario)
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), "name: test-forge\nschema: 1\n");

    const yamlBefore = await fs.readFile(path.join(s.wsRoot, "craftar.yaml"), "utf8");
    const ws = await loadWorkspace(s.wsRoot, { home });

    // Adding the extra recipe should fail because it has sections but schema is 1
    await expect(editRecipes(ws, "add", ["extra"])).rejects.toThrow();

    // craftar.yaml should be unchanged
    expect(await fs.readFile(path.join(s.wsRoot, "craftar.yaml"), "utf8")).toBe(yamlBefore);
  });

  it("7. R1: craftar.local.yaml sets recipes — throws with exact message", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(
      await scenario(
        {
          ingredients: [rule("keep", "# Keep\n"), rule("extra-rule", "# Extra\n")],
          recipes: [recipe("base", ["rule/keep"]), recipe("extra", ["rule/extra-rule"])],
          profiles: [profile("acme", ["base"])],
        },
        { config: { profile: "acme" }, local: { recipes: { add: ["extra"] } } },
      ),
    );

    const yamlBefore = await fs.readFile(path.join(s.wsRoot, "craftar.yaml"), "utf8");
    const ws = await loadWorkspace(s.wsRoot, { home });

    await expect(editRecipes(ws, "add", ["extra"])).rejects.toThrow(
      "craftar.local.yaml sets recipes, which replaces craftar.yaml's lists — edit it by hand, or remove its recipes key and re-run",
    );

    // craftar.yaml should be unchanged
    expect(await fs.readFile(path.join(s.wsRoot, "craftar.yaml"), "utf8")).toBe(yamlBefore);
  });

  it("8. add recipe base (already there): changed=false, next=null, craftar.yaml unchanged", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(
      await scenario(
        {
          ingredients: [rule("keep", "# Keep\n"), rule("extra-rule", "# Extra\n")],
          recipes: [recipe("base", ["rule/keep"]), recipe("extra", ["rule/extra-rule"])],
          profiles: [profile("acme", ["base"])],
        },
        { config: { profile: "acme" } },
      ),
    );

    const yamlBefore = await fs.readFile(path.join(s.wsRoot, "craftar.yaml"), "utf8");
    const ws = await loadWorkspace(s.wsRoot, { home });
    const outcome = await editRecipes(ws, "add", ["base"]);

    expect(outcome.changed).toBe(false);
    expect(outcome.next).toBeNull();
    expect(await fs.readFile(path.join(s.wsRoot, "craftar.yaml"), "utf8")).toBe(yamlBefore);
  });
});

describe("statusDigest", () => {
  it("9. returns 64 lowercase hex, same value for same workspace twice", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(await eightStates());

    const ws = await loadWorkspace(s.wsRoot, { home });
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const st1 = await status(ws, p, lock);
    const st2 = await status(ws, p, lock);

    const d1 = await statusDigest(ws, st1);
    const d2 = await statusDigest(ws, st2);

    expect(d1).toMatch(/^[0-9a-f]{64}$/);
    expect(d1).toBe(d2);
  });

  it("10. fail-first property: change disk file → digest changes", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(await eightStates());

    const ws = await loadWorkspace(s.wsRoot, { home });
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const st1 = await status(ws, p, lock);

    const d1 = await statusDigest(ws, st1);

    // Write a different content to edited.md (still drift)
    await fs.writeFile(path.join(s.wsRoot, ".claude/rules/edited.md"), "# Edited\nby hand, twice\n");

    // Get new status
    const st2 = await status(ws, p, lock);
    // Verify it's still drift
    const editedStatus = st2.find((s) => s.path === ".claude/rules/edited.md");
    expect(editedStatus).toBeDefined();
    expect(editedStatus!.state).toBe("drift");

    const d2 = await statusDigest(ws, st2);

    expect(d2).not.toBe(d1);
  });

  it("11. change Forge file → digest changes", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(await eightStates());

    const ws = await loadWorkspace(s.wsRoot, { home });
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const st1 = await status(ws, p, lock);

    const d1 = await statusDigest(ws, st1);

    // Change the Forge's moved rule
    await fs.writeFile(path.join(s.forgeRoot, "ingredients/rules/moved/rule.md"), "# Moved\nnewer line\n");

    // Reload workspace to pick up Forge change
    const ws2 = await loadWorkspace(s.wsRoot, { home });
    const p2 = await plan(ws2);
    const st2 = await status(ws2, p2, lock);

    // Verify moved is still update
    const movedStatus = st2.find((s) => s.path === ".claude/rules/moved.md");
    expect(movedStatus).toBeDefined();
    expect(movedStatus!.state).toBe("update");

    const d2 = await statusDigest(ws2, st2);

    expect(d2).not.toBe(d1);
  });
});

describe("confirmWrites", () => {
  const QUESTION = "Let craftar mcp --allow-writes write here [no]: ";

  /** A fake io that returns scripted answers and records questions and say calls. */
  function fakeIo(answers: Array<string | null>) {
    let index = 0;
    const questions: string[] = [];
    const said: string[] = [];
    return {
      io: {
        confirm: async (q: string) => {
          questions.push(q);
          return answers[index++] ?? null;
        },
        say: (line: string) => {
          said.push(line);
        },
      },
      questions,
      said,
    };
  }

  it('[""] → false', async () => {
    const { io, questions, said } = fakeIo([""]);
    expect(await confirmWrites(io)).toBe(false);
    expect(questions).toEqual([QUESTION]);
    expect(said).toEqual([]);
  });

  it("[null] → false", async () => {
    const { io, questions, said } = fakeIo([null]);
    expect(await confirmWrites(io)).toBe(false);
    expect(questions).toEqual([QUESTION]);
    expect(said).toEqual([]);
  });

  it('["n"] → false', async () => {
    const { io, questions, said } = fakeIo(["n"]);
    expect(await confirmWrites(io)).toBe(false);
    expect(questions).toEqual([QUESTION]);
    expect(said).toEqual([]);
  });

  it('["no"] → false', async () => {
    const { io, questions, said } = fakeIo(["no"]);
    expect(await confirmWrites(io)).toBe(false);
    expect(questions).toEqual([QUESTION]);
    expect(said).toEqual([]);
  });

  it('["NO "] → false', async () => {
    const { io, questions, said } = fakeIo(["NO "]);
    expect(await confirmWrites(io)).toBe(false);
    expect(questions).toEqual([QUESTION]);
    expect(said).toEqual([]);
  });

  it('["y"] → true', async () => {
    const { io, questions, said } = fakeIo(["y"]);
    expect(await confirmWrites(io)).toBe(true);
    expect(questions).toEqual([QUESTION]);
    expect(said).toEqual([]);
  });

  it('[" Yes "] → true', async () => {
    const { io, questions, said } = fakeIo([" Yes "]);
    expect(await confirmWrites(io)).toBe(true);
    expect(questions).toEqual([QUESTION]);
    expect(said).toEqual([]);
  });

  it('["maybe", "y"] → true, two questions asked, say got exactly ["answer yes or no"]', async () => {
    const { io, questions, said } = fakeIo(["maybe", "y"]);
    expect(await confirmWrites(io)).toBe(true);
    expect(questions).toEqual([QUESTION, QUESTION]);
    expect(said).toEqual(["answer yes or no"]);
  });

  it('["maybe", ""] → false', async () => {
    const { io, questions, said } = fakeIo(["maybe", ""]);
    expect(await confirmWrites(io)).toBe(false);
    expect(questions).toEqual([QUESTION, QUESTION]);
    expect(said).toEqual(["answer yes or no"]);
  });
});

describe("syncToolResult", () => {
  it("builds the sync tool result with skipped reasons and removed reasons", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(await eightStates());

    const ws = await loadWorkspace(s.wsRoot, { home });
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const st = await status(ws, p, lock);

    const outcome = await syncWorkspace(ws, p, st, lock, {
      home,
      registryOff: true,
    });

    const result = syncToolResult(ws, p, st, outcome, true);

    expect(result).toEqual({
      profile: "acme",
      recipes: ["base"],
      targets: ["claude-code"],
      forge: null,
      written: outcome.result.written,
      removed: [{ path: ".claude/rules/gone.md", reason: "orphan: no longer produced by the Forge" }],
      skipped: [
        { path: ".claude/rules/clash.md", state: "collision", reason: "exists but was never generated by craftar and differs from the Forge — rename it or import it" },
        { path: ".claude/rules/edited.md", state: "drift", reason: "hand-edited since last sync — `craftar drift show <path>`, then `craftar drift discard` or `craftar drift promote`" },
        { path: ".claude/rules/gone-edited.md", state: "orphan-drift", reason: "no longer produced by the Forge but hand-edited — kept; `craftar drift discard <path>` removes it, or delete it yourself" },
      ],
      warnings: p.warnings,
      registry: "off",
    });
  });

  it("marks the discarded path with the discard reason; other removed paths keep spec 41's orphanReason", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(await eightStates());

    const ws = await loadWorkspace(s.wsRoot, { home });
    const p = await plan(ws);
    const lock = await readLock(ws.root);
    const st = await status(ws, p, lock);

    // Include the orphan-drift path in overwritePaths to simulate drift discard
    const orphanDriftPath = ".claude/rules/gone-edited.md";
    const outcome = await syncWorkspace(ws, p, st, lock, {
      home,
      registryOff: true,
      overwritePaths: new Set([orphanDriftPath]),
    });

    // Both orphan (gone.md) and orphan-drift (gone-edited.md) are removed
    expect(outcome.result.removed.sort()).toEqual([".claude/rules/gone-edited.md", ".claude/rules/gone.md"]);

    // With discarded: the discarded path gets the special reason
    const result = syncToolResult(ws, p, st, outcome, true, orphanDriftPath);

    expect(result.removed).toContainEqual({ path: orphanDriftPath, reason: "hand-edited orphan: discarded" });
    expect(result.removed).toContainEqual({ path: ".claude/rules/gone.md", reason: "orphan: no longer produced by the Forge" });
  });
});