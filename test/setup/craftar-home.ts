// Global vitest setup (spec 21 §10.1, E1): a fresh CRAFTAR_HOME per test file, so no test — and no
// CLI process a test spawns, which inherits process.env — reads or writes the developer's registry
// or Forge cache. Tests that need their own home still pass CRAFTAR_HOME explicitly.
// Also sets CLAUDE_CONFIG_DIR to a temp dir so no test reads the developer's ~/.claude/settings.json.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { removeWithRetry } from "../helpers/fs.js";

const home = mkdtempSync(path.join(os.tmpdir(), "craftar-home-"));
process.env.CRAFTAR_HOME = home;
delete process.env.CRAFTAR_NO_REGISTRY;

const claudeDir = mkdtempSync(path.join(os.tmpdir(), "craftar-claude-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;

afterAll(async () => {
  await removeWithRetry(home);
  await removeWithRetry(claudeDir);
});
