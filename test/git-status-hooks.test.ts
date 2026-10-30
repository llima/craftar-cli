import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execProgram } from "../src/core/proc.js";
import { gitDirty, gitUnheld } from "../src/core/forge.js";
import { tmpDir } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";

// git status in a Forge runs less of what its .git names (--no-optional-locks and -c core.fsmonitor=false)

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function createGitRepo(): Promise<string> {
  const dir = await fs.realpath(await tmpDir("craftar-gitstatus-"));
  cleanups.push(() => removeWithRetry(dir));
  await execProgram("git", ["-C", dir, "init"]);
  await execProgram("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  await execProgram("git", ["-C", dir, "config", "user.name", "Test"]);
  await fs.writeFile(path.join(dir, "file.txt"), "content\n");
  await execProgram("git", ["-C", dir, "add", "file.txt"]);
  await execProgram("git", ["-C", dir, "commit", "-m", "init"]);
  return dir;
}

describe.skipIf(process.platform === "win32")("gitDirty and gitUnheld avoid running hooks", () => {
  it("core.fsmonitor hook is not triggered", async () => {
    const dir = await createGitRepo();
    
    // Create marker file path to detect if hook is called (using unique path)
    const fsmonitorMarker = path.join(dir, "fsmonitor-marker");
    
    // Plant a core.fsmonitor script
    const fsmonitorScript = path.join(dir, "fsmonitor-hook.sh");
    await fs.writeFile(fsmonitorScript, `#!/bin/sh
touch "${fsmonitorMarker}"
exit 0
`, { mode: 0o755 });
    await execProgram("git", ["-C", dir, "config", "core.fsmonitor", fsmonitorScript]);
    
    // Ensure the marker doesn't exist before we start
    await fs.rm(fsmonitorMarker, { force: true });
    
    // Touch the file with utimes to make the index stale (1.1 seconds in the future)
    const now = new Date();
    const later = new Date(now.getTime() + 1100);
    await fs.utimes(path.join(dir, "file.txt"), later, later);
    
    // Call gitDirty
    await gitDirty(dir);
    
    // Marker should not exist
    const fsmonitorExists = await fs.lstat(fsmonitorMarker).then(() => true, () => false);
    expect(fsmonitorExists, "core.fsmonitor should not have been triggered by gitDirty").toBe(false);
    
    // Call gitUnheld
    await gitUnheld(dir, [path.join(dir, "file.txt")]);
    
    // Marker should still not exist
    const fsmonitorExistsAfter = await fs.lstat(fsmonitorMarker).then(() => true, () => false);
    expect(fsmonitorExistsAfter, "core.fsmonitor should not have been triggered by gitUnheld").toBe(false);
  });

  it("post-index-change hook is not triggered", async () => {
    const dir = await createGitRepo();

    // Create marker file path to detect if hook is called
    const indexMarker = path.join(dir, "post-index-change-marker");

    // Plant an executable .git/hooks/post-index-change that touches a marker and exits 0
    const hookDir = path.join(dir, ".git", "hooks");
    await fs.mkdir(hookDir, { recursive: true });
    const hookScript = path.join(hookDir, "post-index-change");
    await fs.writeFile(hookScript, `#!/bin/sh
touch "${indexMarker}"
exit 0
`, { mode: 0o755 });

    // Ensure the marker doesn't exist before we start
    await fs.rm(indexMarker, { force: true });

    // Make the index stale by touching the file 1.1 seconds in the future
    const now = new Date();
    const later = new Date(now.getTime() + 1100);
    await fs.utimes(path.join(dir, "file.txt"), later, later);

    // Call gitDirty
    await gitDirty(dir);

    // Marker should not exist
    const markerAfterDirty = await fs.lstat(indexMarker).then(() => true, () => false);
    expect(markerAfterDirty, "post-index-change should not have been triggered by gitDirty").toBe(false);

    // Call gitUnheld
    await gitUnheld(dir, [path.join(dir, "file.txt")]);

    // Marker should still not exist
    const markerAfterUnheld = await fs.lstat(indexMarker).then(() => true, () => false);
    expect(markerAfterUnheld, "post-index-change should not have been triggered by gitUnheld").toBe(false);

    // Control: a plain git status --porcelain DOES trigger the hook
    // Re-stale the index
    const laterAgain = new Date(Date.now() + 1100);
    await fs.utimes(path.join(dir, "file.txt"), laterAgain, laterAgain);

    await execProgram("git", ["-C", dir, "status", "--porcelain"]);

    const markerAfterPlain = await fs.lstat(indexMarker).then(() => true, () => false);
    expect(markerAfterPlain, "control: plain git status should trigger post-index-change").toBe(true);
  });

  it("control: plain git status does trigger hooks", async () => {
    const dir = await createGitRepo();
    
    // Create marker files to detect if hooks are called
    const fsmonitorMarker = path.join(dir, "fsmonitor-ran2");
    
    // Plant a core.fsmonitor script
    const fsmonitorScript = path.join(dir, "fsmonitor-hook2.sh");
    await fs.writeFile(fsmonitorScript, `#!/bin/sh
touch "${fsmonitorMarker}"
exit 0
`, { mode: 0o755 });
    await execProgram("git", ["-C", dir, "config", "core.fsmonitor", fsmonitorScript]);
    
    // Touch the file with utimes to make the index stale
    const now = new Date();
    const later = new Date(now.getTime() + 1100);
    await fs.utimes(path.join(dir, "file.txt"), later, later);
    
    // Plain git status
    await execProgram("git", ["-C", dir, "status"]);
    
    // Marker should exist (proves the test can fail)
    const fsmonitorExists = await fs.lstat(fsmonitorMarker).then(() => true, () => false);
    expect(fsmonitorExists, "control: plain git status should trigger core.fsmonitor").toBe(true);
  });

  it("gitUnheld and gitDirty return equal results for a modified/untracked/ignored repo", async () => {
    const dir = await createGitRepo();
    
    // Create a modified file
    await fs.writeFile(path.join(dir, "file.txt"), "modified content\n");
    
    // Create an untracked file
    await fs.writeFile(path.join(dir, "untracked.txt"), "untracked\n");
    
    // Create an ignored file (add to .gitignore first)
    await fs.writeFile(path.join(dir, ".gitignore"), "ignored.txt\n");
    await fs.writeFile(path.join(dir, "ignored.txt"), "ignored\n");
    
    // gitDirty should return true (there's a modified file)
    const dirty = await gitDirty(dir);
    expect(dirty).toBe(true);
    
    // gitUnheld should return the modified and untracked files
    const allPaths = [
      path.join(dir, "file.txt"),
      path.join(dir, "untracked.txt"),
      path.join(dir, "ignored.txt"),
    ];
    const unheld = await gitUnheld(dir, allPaths);
    
    // Should have entries for modified, untracked, and ignored
    const reasons = unheld.map(u => u.reason).sort();
    expect(reasons).toContain("modified");
    expect(reasons).toContain("untracked");
    expect(reasons).toContain("ignored");
  });
});
