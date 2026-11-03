import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as fsMod from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { apply, loadWorkspace, plan, readLock, status, type ApplyOptions, type FileStatus } from "../src/core/sync.js";
import { exists } from "../src/core/forge.js";
import { hashNormalized } from "../src/core/text.js";
import { explainSkip } from "../src/core/report.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir } from "./helpers/forge.js";

const A = ".claude/rules/a.md";
const B = ".claude/rules/b.md";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function oneRule(files?: Record<string, string>) {
  const root = await tmpDir();
  const forgeRoot = path.join(root, "forge");
  const wsRoot = path.join(root, "ws");
  await makeForge(forgeRoot, {
    ingredients: [rule("a", "# A\n")],
    recipes: [recipe("base", ["rule/a"])],
    profiles: [profile("acme", ["base"])],
  });
  await makeWorkspace(wsRoot, forgeRoot, { config: { profile: "acme" }, files });
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return { root, forgeRoot, wsRoot };
}

async function twoRules() {
  const root = await tmpDir();
  const forgeRoot = path.join(root, "forge");
  const wsRoot = path.join(root, "ws");
  await makeForge(forgeRoot, {
    ingredients: [rule("a", "# A\n"), rule("b", "# B\n")],
    recipes: [recipe("base", ["rule/a", "rule/b"])],
    profiles: [profile("acme", ["base"])],
  });
  await makeWorkspace(wsRoot, forgeRoot, { config: { profile: "acme" } });
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return { root, forgeRoot, wsRoot };
}

async function syncOnce(wsRoot: string, opts: ApplyOptions = {}) {
  const w = await loadWorkspace(wsRoot);
  const p = await plan(w);
  return apply(w, p, await status(w, p, await readLock(w.root)), opts);
}

const read = (wsRoot: string, rel: string) => fs.readFile(path.join(wsRoot, rel));
const readText = (wsRoot: string, rel: string) => fs.readFile(path.join(wsRoot, rel), "utf8");
const dropFromRecipe = (forgeRoot: string) =>
  fs.writeFile(path.join(forgeRoot, "recipes/base.yaml"), YAML.stringify(recipe("base", [])));

const CHANGED_SKIP_TEXT = "changed while craftar was writing — kept; run craftar sync again";

describe("apply window: file edited between status() and apply()", () => {
  it("1. update edited in the window → kept as drift, old lock entry kept; second status() reads drift", async () => {
    const s = await oneRule();
    // Initial sync
    await syncOnce(s.wsRoot);
    const originalEntry = (await readLock(s.wsRoot))!.files[0];

    // Change the Forge so that the file would need an update
    await fs.writeFile(path.join(s.forgeRoot, "ingredients/rules/a/rule.md"), "# A updated\n");

    const w = await loadWorkspace(s.wsRoot);
    const p = await plan(w);
    const lock = await readLock(w.root);
    const st = await status(w, p, lock);
    const updateRow = st.find((x) => x.state === "update");
    expect(updateRow).toBeDefined();

    // *** EDIT IN THE WINDOW ***
    const handBytes = Buffer.from("# Hand edit in window\n");
    await fs.writeFile(path.join(s.wsRoot, A), handBytes);

    const result = await apply(w, p, st);

    // The disk keeps the hand bytes exactly
    expect(await read(s.wsRoot, A)).toEqual(handBytes);
    // NOT in written/removed
    expect(result.written).not.toContain(A);
    expect(result.removed).not.toContain(A);
    // IS in skipped with changedSinceStatus: true and state drift
    const skipped = result.skipped.find((x) => x.path === A);
    expect(skipped).toBeDefined();
    expect(skipped!.changedSinceStatus).toBe(true);
    expect(skipped!.state).toBe("drift");
    // explainSkip returns the new line
    expect(explainSkip(skipped!)).toBe(CHANGED_SKIP_TEXT);
    // The lock written to disk has the OLD entry kept
    const newLock = await readLock(s.wsRoot);
    const entry = newLock!.files.find((x) => x.path === A);
    expect(entry).toEqual(originalEntry);

    // A second status() reads it as drift
    const st2 = await status(w, p, newLock);
    expect(st2.find((x) => x.path === A)?.state).toBe("drift");
  });

  it("2. new created in the window → kept as collision, no lock entry; second status() reads collision", async () => {
    const s = await oneRule();
    // No initial sync - file is "new"
    const w = await loadWorkspace(s.wsRoot);
    const p = await plan(w);
    const lock = await readLock(w.root);
    const st = await status(w, p, lock);
    const newRow = st.find((x) => x.state === "new");
    expect(newRow).toBeDefined();

    // *** CREATE IN THE WINDOW ***
    const handBytes = Buffer.from("# User created this\n");
    await fs.mkdir(path.dirname(path.join(s.wsRoot, A)), { recursive: true });
    await fs.writeFile(path.join(s.wsRoot, A), handBytes);

    const result = await apply(w, p, st);

    // The disk keeps the hand bytes exactly
    expect(await read(s.wsRoot, A)).toEqual(handBytes);
    // NOT in written/removed
    expect(result.written).not.toContain(A);
    expect(result.removed).not.toContain(A);
    // IS in skipped with changedSinceStatus: true and state collision
    const skipped = result.skipped.find((x) => x.path === A);
    expect(skipped).toBeDefined();
    expect(skipped!.changedSinceStatus).toBe(true);
    expect(skipped!.state).toBe("collision");
    // explainSkip returns the new line
    expect(explainSkip(skipped!)).toBe(CHANGED_SKIP_TEXT);
    // The lock has NO entry for this path
    const newLock = await readLock(s.wsRoot);
    expect(newLock!.files.find((x) => x.path === A)).toBeUndefined();

    // A second status() reads collision
    const st2 = await status(w, p, newLock);
    expect(st2.find((x) => x.path === A)?.state).toBe("collision");
  });

  it("3. adopt changed in the window → kept as collision, no lock entry", async () => {
    const s = await oneRule();
    // Write file with same content as Forge (so it would be adopt)
    await fs.mkdir(path.dirname(path.join(s.wsRoot, A)), { recursive: true });
    await fs.writeFile(path.join(s.wsRoot, A), "# A\n");

    const w = await loadWorkspace(s.wsRoot);
    const p = await plan(w);
    const lock = await readLock(w.root); // null
    const st = await status(w, p, lock);
    const adoptRow = st.find((x) => x.state === "adopt");
    expect(adoptRow).toBeDefined();

    // *** EDIT IN THE WINDOW ***
    const handBytes = Buffer.from("# Hand edit during adopt\n");
    await fs.writeFile(path.join(s.wsRoot, A), handBytes);

    const result = await apply(w, p, st);

    // The disk keeps the hand bytes exactly
    expect(await read(s.wsRoot, A)).toEqual(handBytes);
    // NOT in written/removed
    expect(result.written).not.toContain(A);
    expect(result.removed).not.toContain(A);
    // IS in skipped with changedSinceStatus: true and state collision
    const skipped = result.skipped.find((x) => x.path === A);
    expect(skipped).toBeDefined();
    expect(skipped!.changedSinceStatus).toBe(true);
    expect(skipped!.state).toBe("collision");
    // explainSkip returns the new line
    expect(explainSkip(skipped!)).toBe(CHANGED_SKIP_TEXT);
    // No lock entry
    const newLock = await readLock(s.wsRoot);
    expect(newLock!.files.find((x) => x.path === A)).toBeUndefined();
  });

  it("4. orphan edited in the window → not removed, kept as orphan-drift, old lock entry kept", async () => {
    const s = await oneRule();
    // Initial sync
    await syncOnce(s.wsRoot);
    const originalEntry = (await readLock(s.wsRoot))!.files[0];

    // Drop from recipe to make it orphan
    await dropFromRecipe(s.forgeRoot);

    const w = await loadWorkspace(s.wsRoot);
    const p = await plan(w);
    const lock = await readLock(w.root);
    const st = await status(w, p, lock);
    const orphanRow = st.find((x) => x.state === "orphan");
    expect(orphanRow).toBeDefined();

    // *** EDIT IN THE WINDOW ***
    const handBytes = Buffer.from("# Hand edited orphan\n");
    await fs.writeFile(path.join(s.wsRoot, A), handBytes);

    const result = await apply(w, p, st);

    // The disk keeps the hand bytes exactly (NOT removed)
    expect(await read(s.wsRoot, A)).toEqual(handBytes);
    expect(await exists(path.join(s.wsRoot, A))).toBe(true);
    // NOT in written/removed
    expect(result.written).not.toContain(A);
    expect(result.removed).not.toContain(A);
    // IS in skipped with changedSinceStatus: true and state orphan-drift
    const skipped = result.skipped.find((x) => x.path === A);
    expect(skipped).toBeDefined();
    expect(skipped!.changedSinceStatus).toBe(true);
    expect(skipped!.state).toBe("orphan-drift");
    // explainSkip returns the new line
    expect(explainSkip(skipped!)).toBe(CHANGED_SKIP_TEXT);
    // The lock entry is kept
    const newLock = await readLock(s.wsRoot);
    const entry = newLock!.files.find((x) => x.path === A);
    expect(entry).toEqual(originalEntry);
  });

  it("5. drift named in overwritePaths edited again in the window → kept (drift), old entry kept", async () => {
    const s = await oneRule();
    // Initial sync
    await syncOnce(s.wsRoot);
    const originalEntry = (await readLock(s.wsRoot))!.files[0];

    // Hand-edit to make it drift
    await fs.writeFile(path.join(s.wsRoot, A), "# First hand edit\n");

    const w = await loadWorkspace(s.wsRoot);
    const p = await plan(w);
    const lock = await readLock(w.root);
    const st = await status(w, p, lock);
    const driftRow = st.find((x) => x.state === "drift");
    expect(driftRow).toBeDefined();

    // *** EDIT IN THE WINDOW *** (edit it again during the overwrite attempt)
    const handBytes = Buffer.from("# Second hand edit in window\n");
    await fs.writeFile(path.join(s.wsRoot, A), handBytes);

    const result = await apply(w, p, st, { overwritePaths: new Set([A]) });

    // The disk keeps the hand bytes exactly
    expect(await read(s.wsRoot, A)).toEqual(handBytes);
    // NOT in written/removed
    expect(result.written).not.toContain(A);
    expect(result.removed).not.toContain(A);
    // IS in skipped with changedSinceStatus: true and state drift
    const skipped = result.skipped.find((x) => x.path === A);
    expect(skipped).toBeDefined();
    expect(skipped!.changedSinceStatus).toBe(true);
    expect(skipped!.state).toBe("drift");
    // explainSkip returns the new line
    expect(explainSkip(skipped!)).toBe(CHANGED_SKIP_TEXT);
    // Old lock entry kept
    const newLock = await readLock(s.wsRoot);
    const entry = newLock!.files.find((x) => x.path === A);
    expect(entry).toEqual(originalEntry);
  });

  it("6. drift under overwriteDrift: true edited again in the window → kept (drift)", async () => {
    const s = await oneRule();
    // Initial sync
    await syncOnce(s.wsRoot);
    const originalEntry = (await readLock(s.wsRoot))!.files[0];

    // Hand-edit to make it drift
    await fs.writeFile(path.join(s.wsRoot, A), "# First hand edit\n");

    const w = await loadWorkspace(s.wsRoot);
    const p = await plan(w);
    const lock = await readLock(w.root);
    const st = await status(w, p, lock);
    const driftRow = st.find((x) => x.state === "drift");
    expect(driftRow).toBeDefined();

    // *** EDIT IN THE WINDOW ***
    const handBytes = Buffer.from("# Second hand edit in window\n");
    await fs.writeFile(path.join(s.wsRoot, A), handBytes);

    const result = await apply(w, p, st, { overwriteDrift: true });

    // The disk keeps the hand bytes exactly
    expect(await read(s.wsRoot, A)).toEqual(handBytes);
    // NOT in written/removed
    expect(result.written).not.toContain(A);
    expect(result.removed).not.toContain(A);
    // IS in skipped with changedSinceStatus: true and state drift
    const skipped = result.skipped.find((x) => x.path === A);
    expect(skipped).toBeDefined();
    expect(skipped!.changedSinceStatus).toBe(true);
    expect(skipped!.state).toBe("drift");
    // explainSkip returns the new line
    expect(explainSkip(skipped!)).toBe(CHANGED_SKIP_TEXT);
    // Old lock entry kept
    const newLock = await readLock(s.wsRoot);
    const entry = newLock!.files.find((x) => x.path === A);
    expect(entry).toEqual(originalEntry);
  });

  it("7. orphan-drift named in overwritePaths edited again in the window → not removed", async () => {
    const s = await oneRule();
    // Initial sync
    await syncOnce(s.wsRoot);
    const originalEntry = (await readLock(s.wsRoot))!.files[0];

    // Hand-edit and drop from recipe to make orphan-drift
    await fs.writeFile(path.join(s.wsRoot, A), "# First hand edit\n");
    await dropFromRecipe(s.forgeRoot);

    const w = await loadWorkspace(s.wsRoot);
    const p = await plan(w);
    const lock = await readLock(w.root);
    const st = await status(w, p, lock);
    const orphanDriftRow = st.find((x) => x.state === "orphan-drift");
    expect(orphanDriftRow).toBeDefined();

    // *** EDIT IN THE WINDOW ***
    const handBytes = Buffer.from("# Second hand edit in window\n");
    await fs.writeFile(path.join(s.wsRoot, A), handBytes);

    const result = await apply(w, p, st, { overwritePaths: new Set([A]) });

    // The disk keeps the hand bytes exactly (NOT removed)
    expect(await read(s.wsRoot, A)).toEqual(handBytes);
    expect(await exists(path.join(s.wsRoot, A))).toBe(true);
    // NOT in written/removed
    expect(result.written).not.toContain(A);
    expect(result.removed).not.toContain(A);
    // IS in skipped with changedSinceStatus: true and state orphan-drift
    const skipped = result.skipped.find((x) => x.path === A);
    expect(skipped).toBeDefined();
    expect(skipped!.changedSinceStatus).toBe(true);
    expect(skipped!.state).toBe("orphan-drift");
    // explainSkip returns the new line
    expect(explainSkip(skipped!)).toBe(CHANGED_SKIP_TEXT);
    // Old lock entry kept
    const newLock = await readLock(s.wsRoot);
    const entry = newLock!.files.find((x) => x.path === A);
    expect(entry).toEqual(originalEntry);
  });

  it("8. parent directory replaced by symlink to outside (empty dir) → row skipped with changedSinceStatus: true, nothing written outside", async () => {
    const s = await oneRule();
    // No initial sync - file is "new"
    const w = await loadWorkspace(s.wsRoot);
    const p = await plan(w);
    const lock = await readLock(w.root);
    const st = await status(w, p, lock);
    const newRow = st.find((x) => x.state === "new");
    expect(newRow).toBeDefined();

    // Create an outside directory WITHOUT a.md
    const outsideDir = path.join(s.root, "outside");
    await fs.mkdir(outsideDir, { recursive: true });

    // *** IN THE WINDOW: replace the parent directory with a symlink to outside ***
    const parentDir = path.join(s.wsRoot, ".claude/rules");
    // First ensure parent doesn't exist
    await fs.rm(path.join(s.wsRoot, ".claude"), { recursive: true, force: true });
    // Create .claude
    await fs.mkdir(path.join(s.wsRoot, ".claude"), { recursive: true });
    // Create symlink: .claude/rules -> outside directory
    await fs.symlink(outsideDir, parentDir, "junction");

    const result = await apply(w, p, st);

    // Outside a.md does NOT exist (nothing was written outside)
    const outsideFile = path.join(outsideDir, "a.md");
    await expect(fs.stat(outsideFile)).rejects.toMatchObject({ code: "ENOENT" });
    // NOT in written
    expect(result.written).not.toContain(A);
    // IS in skipped with changedSinceStatus: true and state collision
    const skipped = result.skipped.find((x) => x.path === A);
    expect(skipped).toBeDefined();
    expect(skipped!.changedSinceStatus).toBe(true);
    expect(skipped!.state).toBe("collision");
  });

  it("9. no edit in the window → exactly today's result: written, removed, skipped and lock as without change", async () => {
    const s = await oneRule();
    // No initial sync
    const w = await loadWorkspace(s.wsRoot);
    const p = await plan(w);
    const lock = await readLock(w.root);
    const st = await status(w, p, lock);

    // *** NO EDIT IN THE WINDOW ***
    const result = await apply(w, p, st);

    // File written normally
    expect(result.written).toContain(A);
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(await readText(s.wsRoot, A)).toBe("# A\n");
    // Lock has the entry
    const newLock = await readLock(s.wsRoot);
    expect(newLock!.files.find((x) => x.path === A)).toBeDefined();
  });

  it("10. dryRun: true with edit in window → result identical to dryRun today (row in written, not skipped), nothing on disk changes", async () => {
    const s = await oneRule();
    // No initial sync
    const w = await loadWorkspace(s.wsRoot);
    const p = await plan(w);
    const lock = await readLock(w.root);
    const st = await status(w, p, lock);

    // *** EDIT IN THE WINDOW ***
    const handBytes = Buffer.from("# User created this in window\n");
    await fs.mkdir(path.dirname(path.join(s.wsRoot, A)), { recursive: true });
    await fs.writeFile(path.join(s.wsRoot, A), handBytes);

    const result = await apply(w, p, st, { dryRun: true });

    // The row is in written (dryRun behavior unchanged)
    expect(result.written).toContain(A);
    // NOT in skipped
    expect(result.skipped.find((x) => x.path === A)).toBeUndefined();
    // Nothing on disk changes - file still has hand bytes
    expect(await read(s.wsRoot, A)).toEqual(handBytes);
    // No lock written
    expect(await exists(path.join(s.wsRoot, "craftar.lock"))).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "11. update row whose file is made unreadable in window → kept as drift (read error counts as changed)",
    async () => {
      const s = await oneRule();
      // Initial sync
      await syncOnce(s.wsRoot);
      const originalEntry = (await readLock(s.wsRoot))!.files[0];

      // Change the Forge so that the file would need an update
      await fs.writeFile(path.join(s.forgeRoot, "ingredients/rules/a/rule.md"), "# A updated\n");

      const w = await loadWorkspace(s.wsRoot);
      const p = await plan(w);
      const lock = await readLock(w.root);
      const st = await status(w, p, lock);
      const updateRow = st.find((x) => x.state === "update");
      expect(updateRow).toBeDefined();

      const filePath = path.join(s.wsRoot, A);
      try {
        // *** MAKE UNREADABLE IN THE WINDOW ***
        await fs.chmod(filePath, 0o000);

        const result = await apply(w, p, st);

        // NOT in written/removed
        expect(result.written).not.toContain(A);
        expect(result.removed).not.toContain(A);
        // IS in skipped with changedSinceStatus: true and state drift
        const skipped = result.skipped.find((x) => x.path === A);
        expect(skipped).toBeDefined();
        expect(skipped!.changedSinceStatus).toBe(true);
        expect(skipped!.state).toBe("drift");
        // explainSkip returns the new line
        expect(explainSkip(skipped!)).toBe(CHANGED_SKIP_TEXT);
        // Old lock entry kept
        const newLock = await readLock(s.wsRoot);
        const entry = newLock!.files.find((x) => x.path === A);
        expect(entry).toEqual(originalEntry);
      } finally {
        // Restore the mode
        await fs.chmod(filePath, 0o644);
      }
    },
  );

  it("12. two new files under same parent, link swap between writes → second file skipped with changedSinceStatus", async () => {
    const s = await twoRules();
    // No initial sync - both files are "new"
    const w = await loadWorkspace(s.wsRoot);
    const p = await plan(w);
    const lock = await readLock(w.root);
    const st = await status(w, p, lock);
    // Both a.md and b.md are new
    expect(st.filter((x) => x.state === "new").length).toBe(2);

    // Create an outside directory
    const outsideDir = path.join(s.root, "outside");
    await fs.mkdir(outsideDir, { recursive: true });

    const parentDir = path.join(s.wsRoot, ".claude/rules");
    let firstWriteDone = false;

    // Spy on fs.promises.writeFile to swap the parent to a junction after the first write
    const realWriteFile = fsMod.promises.writeFile;
    const spy = vi.spyOn(fsMod.promises, "writeFile").mockImplementation(async (...args) => {
      const [filePath, data, options] = args as [fsMod.PathLike, Parameters<typeof realWriteFile>[1], Parameters<typeof realWriteFile>[2]];
      await realWriteFile(filePath, data, options);

      // After first write (a.md), replace the parent with a junction
      if (!firstWriteDone && String(filePath).endsWith("a.md")) {
        firstWriteDone = true;
        // Move a.md out
        const aMd = path.join(parentDir, "a.md");
        const tmpA = path.join(s.root, "tmp-a.md");
        await fs.rename(aMd, tmpA);
        // Remove the directory
        await fs.rm(parentDir, { recursive: true, force: true });
        // Create junction to outside
        await fs.symlink(outsideDir, parentDir, "junction");
        // Move a.md back (into outside, through the junction)
        await fs.rename(tmpA, aMd);
      }
    });

    try {
      const result = await apply(w, p, st);

      // a.md was written (before the swap)
      expect(result.written).toContain(A);
      // b.md was NOT written outside
      const outsideB = path.join(outsideDir, "b.md");
      await expect(fs.stat(outsideB)).rejects.toMatchObject({ code: "ENOENT" });
      // b.md row is skipped with changedSinceStatus: true
      const skipped = result.skipped.find((x) => x.path === B);
      expect(skipped).toBeDefined();
      expect(skipped!.changedSinceStatus).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("13. update row with LF→CRLF change (same normalized content) → written, not skipped (hashNormalized folds CRLF)", async () => {
    // This test passes before and after the per-row cache change; it pins behaviour.
    const s = await oneRule();
    // Initial sync
    await syncOnce(s.wsRoot);

    // Verify initial state (LF from Forge)
    const initialContent = await readText(s.wsRoot, A);
    expect(initialContent).toBe("# A\n");

    // Resave the file with CRLF (same text after normalization)
    const crlf = "# A\r\n";
    await fs.writeFile(path.join(s.wsRoot, A), crlf);

    // Change the Forge so that the file would need an update
    await fs.writeFile(path.join(s.forgeRoot, "ingredients/rules/a/rule.md"), "# A updated\n");

    const w = await loadWorkspace(s.wsRoot);
    const p = await plan(w);
    const lock = await readLock(w.root);
    const st = await status(w, p, lock);
    // Should be update (disk matches lock via hashNormalized, plan differs)
    const row = st.find((x) => x.path === A);
    expect(row).toBeDefined();
    expect(row!.state).toBe("update");

    // Now "edit in window" by changing line endings (CRLF back to LF of same original text)
    // The normalized hash is the same, so changedSince returns false → file is written
    const lfOriginal = "# A\n";
    await fs.writeFile(path.join(s.wsRoot, A), lfOriginal);

    const result = await apply(w, p, st);

    // The row should be written (update proceeds), NOT skipped
    // (disk content normalized equals status diskHash, so no changedSinceStatus)
    expect(result.written).toContain(A);
    expect(result.skipped.find((x) => x.path === A)).toBeUndefined();
    // The file now has the Forge's new content (with CRLF preserved from when plan read the disk)
    // textFile preserves EOL style from existing file when status() was computed (file had CRLF)
    expect(await readText(s.wsRoot, A)).toBe("# A updated\r\n");
  });
});
