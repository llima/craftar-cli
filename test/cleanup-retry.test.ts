import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A CRAFTAR_HOME holding a Forge cache, and the bare repository a remote Forge is fetched from, hold git
// repositories a git child has just used; on Windows their removal can meet EBUSY (tech debt 2026-10-24).
// The two helpers every such test goes through remove them with removeWithRetry.
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");

describe("cleanups of a Forge cache and a remote Forge retry a busy directory", () => {
  it("the per-file CRAFTAR_HOME is removed through removeWithRetry", () => {
    const text = read("setup/craftar-home.ts");
    expect(text).toContain("removeWithRetry(home)");
    expect(text).not.toMatch(/\brmSync\(|\bfs\.rm\(/);
  });

  it("remoteForge's cleanup removes its root through removeWithRetry", () => {
    const text = read("helpers/remote.ts");
    expect(text).toContain("cleanup: () => removeWithRetry(root)");
    expect(text).not.toMatch(/\bfs\.rm\(/);
  });
});
