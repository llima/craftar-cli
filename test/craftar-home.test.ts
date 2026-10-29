import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 21 §10.1 (E1): every test runs with CRAFTAR_HOME in a temporary directory, set by the global
// setup file, so no test reads or writes the developer's registry or Forge cache.
// CLAUDE_CONFIG_DIR is also set to a temp dir so no test reads the developer's ~/.claude/settings.json.
describe("test isolation", () => {
  it("CRAFTAR_HOME is set and lies under the OS temporary directory", () => {
    const home = process.env.CRAFTAR_HOME;
    expect(home, "CRAFTAR_HOME is not set — test/setup/craftar-home.ts must be in vitest's setupFiles").toBeTruthy();
    const rel = path.relative(os.tmpdir(), path.resolve(home!));
    expect(rel.startsWith("..") || path.isAbsolute(rel), `CRAFTAR_HOME ${home} is outside ${os.tmpdir()}`).toBe(false);
  });

  it("CRAFTAR_NO_REGISTRY is unset, so the registry is exercised", () => {
    expect(process.env.CRAFTAR_NO_REGISTRY).toBeUndefined();
  });

  it("CLAUDE_CONFIG_DIR is set, not the real Claude config dir, and under the OS temporary directory", () => {
    const claudeDir = process.env.CLAUDE_CONFIG_DIR;
    expect(claudeDir, "CLAUDE_CONFIG_DIR is not set — test/setup/craftar-home.ts must set it").toBeTruthy();
    const resolved = path.resolve(claudeDir!);

    // Must not be the real Claude config dir (~/.claude) or inside it
    const realClaudeDir = path.join(os.homedir(), ".claude");
    const relToReal = path.relative(realClaudeDir, resolved);
    const isRealOrInside = !relToReal.startsWith("..") && !path.isAbsolute(relToReal);
    // On Windows, compare case-insensitively
    const isExactMatch = process.platform === "win32"
      ? resolved.toLowerCase() === realClaudeDir.toLowerCase()
      : resolved === realClaudeDir;
    expect(
      isExactMatch || isRealOrInside,
      `CLAUDE_CONFIG_DIR ${claudeDir} is the real Claude config dir or inside it (${realClaudeDir})`,
    ).toBe(false);

    // Must be under the OS temporary directory (as CRAFTAR_HOME test does)
    const relToTmp = path.relative(os.tmpdir(), resolved);
    expect(
      relToTmp.startsWith("..") || path.isAbsolute(relToTmp),
      `CLAUDE_CONFIG_DIR ${claudeDir} is outside ${os.tmpdir()}`,
    ).toBe(false);
  });
});
