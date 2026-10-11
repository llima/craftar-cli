import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { listFiles } from "../src/core/forge.js";

/**
 * Golden test for the services feature: a workspace with a service ingredient,
 * verifying that sync produces the expected .craftar/ output and a schema 3 lock.
 */
const GOLDEN = path.resolve(__dirname, "golden/acme-services");

let tmp: string;
let ws: string;
let forge: string;

async function cp(src: string, dst: string) {
  for (const rel of await listFiles(src)) {
    await fs.mkdir(path.dirname(path.join(dst, rel)), { recursive: true });
    await fs.copyFile(path.join(src, rel), path.join(dst, rel));
  }
}

describe("golden: acme-services workspace", () => {
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-golden-services-"));
    ws = path.join(tmp, "ws");
    forge = path.join(tmp, "forge");
    await cp(path.join(GOLDEN, "forge"), forge);
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(path.join(ws, "craftar.yaml"), `forge: ../forge\nprofile: acme\n`);
  });

  afterAll(() => fs.rm(tmp, { recursive: true, force: true }));

  it("sync produces the expected .craftar/ files", async () => {
    const w = await loadWorkspace(ws);
    const p = await plan(w);
    const st = await status(w, p, null);

    // All files should be new
    const notNew = st.filter((s) => s.state !== "new").map((s) => `${s.state} ${s.path}`);
    expect(notNew).toEqual([]);

    // Check the planned paths include .craftar/ files
    const craftarPaths = p.files.filter((f) => f.path.startsWith(".craftar/")).map((f) => f.path).sort();
    expect(craftarPaths).toEqual([
      ".craftar/.gitattributes",
      ".craftar/compose.yaml",
      ".craftar/services/echo/compose.yaml",
      ".craftar/services/echo/init/setup.sh",
    ]);

    // Apply the plan
    await apply(w, p, st);

    // Verify each .craftar/ file matches the golden output byte for byte
    const goldenCraftarDir = path.join(GOLDEN, ".craftar");
    for (const rel of await listFiles(goldenCraftarDir)) {
      const golden = await fs.readFile(path.join(goldenCraftarDir, rel));
      const actual = await fs.readFile(path.join(ws, ".craftar", rel));
      expect(actual.equals(golden), `.craftar/${rel} differs from golden`).toBe(true);
    }

    // Verify .claude/rules/workflow.md matches the golden byte for byte
    const goldenRule = await fs.readFile(path.join(GOLDEN, ".claude/rules/workflow.md"));
    const actualRule = await fs.readFile(path.join(ws, ".claude/rules/workflow.md"));
    expect(actualRule.equals(goldenRule), ".claude/rules/workflow.md differs from golden").toBe(true);
  });

  it("craftar.lock matches golden (schema 3)", async () => {
    const goldenLock = await fs.readFile(path.join(GOLDEN, "craftar.lock"), "utf8");
    const actualLock = await fs.readFile(path.join(ws, "craftar.lock"), "utf8");
    // Replace generatedAt with a fixed placeholder for comparison
    const normalize = (s: string) => s.replace(/"generatedAt":\s*"[^"]+"/, '"generatedAt": "TIMESTAMP"');
    expect(normalize(actualLock)).toBe(normalize(goldenLock));
    // Verify schema is 3
    expect(actualLock).toMatch(/"schema":\s*3/);
  });

  it("second sync is a no-op and status reports all unchanged", async () => {
    const w = await loadWorkspace(ws);
    const p = await plan(w);
    const lock = await readLock(ws);
    const st = await status(w, p, lock);

    // Every file should be unchanged
    const notUnchanged = st.filter((s) => s.state !== "unchanged").map((s) => `${s.state} ${s.path}`);
    expect(notUnchanged).toEqual([]);

    // Apply should write nothing
    const r = await apply(w, p, st);
    expect(r.written).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it("service files have LF line endings", async () => {
    const setupSh = await fs.readFile(path.join(ws, ".craftar/services/echo/init/setup.sh"));
    // Should not contain CRLF
    expect(setupSh.includes(0x0d)).toBe(false);
    // Should contain LF
    expect(setupSh.includes(0x0a)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("setup.sh is executable (mode 0755)", async () => {
    const stat = await fs.stat(path.join(ws, ".craftar/services/echo/init/setup.sh"));
    // Check executable bit is set
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });
});
