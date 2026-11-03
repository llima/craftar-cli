import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execProgram } from "../src/core/proc.js";
import { gitDirty, gitIgnored, gitUnheld } from "../src/core/forge.js";
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
  it("core.fsmonitor hook is not triggered by gitDirty, gitUnheld, or gitIgnored", async () => {
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

    // Call gitIgnored
    await fs.rm(fsmonitorMarker, { force: true });
    const laterIgnored = new Date(Date.now() + 1100);
    await fs.utimes(path.join(dir, "file.txt"), laterIgnored, laterIgnored);
    await gitIgnored(dir, "file.txt");

    // Marker should still not exist
    const fsmonitorExistsIgnored = await fs.lstat(fsmonitorMarker).then(() => true, () => false);
    expect(fsmonitorExistsIgnored, "core.fsmonitor should not have been triggered by gitIgnored").toBe(false);
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

    // The same answers with a core.fsmonitor planted: git reads the worktree itself.
    const script = path.join(dir, "fsmonitor-equal.sh");
    await fs.writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await execProgram("git", ["-C", dir, "config", "core.fsmonitor", script]);
    expect(await gitDirty(dir)).toBe(dirty);
    expect(await gitUnheld(dir, allPaths)).toEqual(unheld);

    // Should have entries for modified, untracked, and ignored
    const reasons = unheld.map(u => u.reason).sort();
    expect(reasons).toContain("modified");
    expect(reasons).toContain("untracked");
    expect(reasons).toContain("ignored");
  });
});

// E11.2: a `filter.<x>.clean` set in the Forge's own configuration ran under the gate's `git status` (a stale index makes
// git re-read the file through the filter). The gate's three commands blank it; a filter set globally keeps running.
describe.skipIf(process.platform === "win32")("the gate's git commands do not run the Forge's own filters", () => {
  const stale = async (dir: string) => {
    const later = new Date(Date.now() + 2000 + Math.floor(Math.random() * 5000));
    await fs.utimes(path.join(dir, "file.txt"), later, later);
  };
  const ran = (marker: string) => fs.lstat(marker).then(() => true, () => false);
  async function filtered(): Promise<{ dir: string; marker: string; script: string }> {
    const dir = await createGitRepo();
    const marker = path.join(dir, "..", `${path.basename(dir)}-filter-ran`);
    cleanups.push(() => fs.rm(marker, { force: true }));
    const script = path.join(dir, "..", `${path.basename(dir)}-filter.sh`);
    cleanups.push(() => fs.rm(script, { force: true }));
    await fs.writeFile(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 });
    await fs.writeFile(path.join(dir, ".gitattributes"), "*.txt filter=mark\n");
    await execProgram("git", ["-C", dir, "add", ".gitattributes"]);
    await execProgram("git", ["-C", dir, "commit", "-m", "attributes"]);
    return { dir, marker, script };
  }

  it("a repo-local filter.<x>.clean does not run under gitDirty, gitUnheld or gitIgnored, and the tree reads clean", async () => {
    const { dir, marker, script } = await filtered();
    await execProgram("git", ["-C", dir, "config", "filter.mark.clean", script]);
    // Control: a plain status runs it.
    await stale(dir);
    await execProgram("git", ["-C", dir, "status", "--porcelain"]);
    expect(await ran(marker), "control: plain git status runs the filter").toBe(true);
    await fs.rm(marker);
    await stale(dir);
    expect(await gitDirty(dir)).toBe(false);
    await stale(dir);
    expect(await gitUnheld(dir, [path.join(dir, "file.txt")])).toEqual([]);
    await stale(dir);
    expect(await gitIgnored(dir, "file.txt")).toBe(false);
    expect(await ran(marker), "the Forge's own filter ran under the gate").toBe(false);
  });

  it("filter.<x>.required=true does not turn the blanked filter into a failure (the gate would refuse for ever)", async () => {
    const { dir, marker, script } = await filtered();
    await execProgram("git", ["-C", dir, "config", "filter.mark.clean", script]);
    await execProgram("git", ["-C", dir, "config", "filter.mark.required", "true"]);
    await stale(dir);
    expect(await gitDirty(dir)).toBe(false);
    await stale(dir);
    expect(await gitUnheld(dir, [path.join(dir, "file.txt")])).toEqual([]);
    expect(await ran(marker)).toBe(false);
  });

  it("a filter from a file the repository's configuration includes is blanked too", async () => {
    const { dir, marker, script } = await filtered();
    const inc = path.join(dir, "..", `${path.basename(dir)}-inc.cfg`);
    cleanups.push(() => fs.rm(inc, { force: true }));
    await fs.writeFile(inc, `[filter "mark"]\n\tclean = ${script}\n`);
    await execProgram("git", ["-C", dir, "config", "include.path", inc]);
    await stale(dir);
    expect(await gitDirty(dir)).toBe(false);
    expect(await ran(marker)).toBe(false);
  });

  it("a filter set in the global configuration still runs (a global LFS setup keeps working)", async () => {
    const { dir, marker, script } = await filtered();
    const global = path.join(dir, "..", `${path.basename(dir)}-global.cfg`);
    cleanups.push(() => fs.rm(global, { force: true }));
    await fs.writeFile(global, `[filter "mark"]\n\tclean = ${script}\n`);
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = global;
    try {
      await stale(dir);
      await gitDirty(dir);
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before;
    }
    expect(await ran(marker)).toBe(true);
  });

  // E11.3: the gate's commands run no diff driver: `diff.external` and a `textconv` planted in the Forge's configuration.
  it("diff.external and a textconv driver do not run under the gate's commands", async () => {
    const dir = await createGitRepo();
    const marker = path.join(dir, "..", `${path.basename(dir)}-diff-ran`);
    cleanups.push(() => fs.rm(marker, { force: true }));
    const script = path.join(dir, "..", `${path.basename(dir)}-diff.sh`);
    cleanups.push(() => fs.rm(script, { force: true }));
    await fs.writeFile(script, `#!/bin/sh\ntouch "${marker}"\ncat "$1" 2>/dev/null\n`, { mode: 0o755 });
    await fs.writeFile(path.join(dir, ".gitattributes"), "*.txt diff=conv\n");
    await execProgram("git", ["-C", dir, "add", ".gitattributes"]);
    await execProgram("git", ["-C", dir, "commit", "-m", "attributes"]);
    await execProgram("git", ["-C", dir, "config", "diff.external", script]);
    await execProgram("git", ["-C", dir, "config", "diff.conv.textconv", script]);
    await fs.writeFile(path.join(dir, "file.txt"), "changed\n");
    await gitDirty(dir);
    await gitUnheld(dir, [path.join(dir, "file.txt")]);
    await gitIgnored(dir, "file.txt");
    expect(await ran(marker), "a diff driver ran under the gate").toBe(false);
    // Control: a plain git diff runs it.
    await execProgram("git", ["-C", dir, "diff"]);
    expect(await ran(marker), "control: git diff runs the driver").toBe(true);
  });
});
