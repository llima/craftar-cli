import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 21 §10.1 (E1): every test runs with CRAFTAR_HOME in a temporary directory, set by the global
// setup file, so no test reads or writes the developer's registry or Forge cache.
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
});
