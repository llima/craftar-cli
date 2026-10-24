// Spec 40 §6.2, §6.4, §12.5 — the write routes of craftar ui --allow-writes, through route().

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { profile, recipe, rule, scenario, tmpDir, writeFiles } from "./helpers/forge.js";
import { remoteForge } from "./helpers/remote.js";
import { eightStates, mcpWorkspace, MCP_FILES, syncOnce, type Scenario } from "./helpers/states.js";
import { HOME, get, post, syncRegistered } from "./helpers/ui.js";
import { registryFile } from "../src/core/registry.js";
import { loadWorkspace, plan, readLock, status, unsetSummary } from "../src/core/sync.js";
import { statusDigest } from "../src/core/write-actions.js";
import { register } from "../src/core/registry.js";
import { renderDiff } from "../src/core/diff.js";
import { EXAMPLE_CONTENT_HIDDEN } from "../src/core/report.js";
import {
  NOT_FOUND,
  NOT_HAND_EDITED,
  REMOTE_FORGE,
  STALE_DIGEST,
  parseWriteBody,
  route,
  routePattern,
  workspaceId,
  WRITE_PATTERNS,
} from "../src/ui/routes.js";

const cleanups: Array<() => Promise<unknown>> = [];
beforeEach(async () => {
  await fs.rm(registryFile(HOME()), { force: true }); // one registry per test: the home is per file
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends { cleanup: () => Promise<unknown> }>(s: T): T => (cleanups.push(s.cleanup), s);

const R = ".claude/rules";
const BASE = { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] };

/** eightStates(), registered as the first sync left it (its registry entry is not touched by the later edits). */
async function eight() {
  const s = kept(await eightStates());
  const ws = await loadWorkspace(s.wsRoot, { home: HOME() });
  const entry = await register(HOME(), ws, await plan(ws));
  return { s, id: workspaceId(entry.path), real: entry.path };
}

/** Every file under `dir` with its sha256, sorted by path. */
async function tree(dir: string): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push([path.relative(dir, p).replace(/\\/g, "/"), createHash("sha256").update(await fs.readFile(p)).digest("hex")]);
    }
  };
  await walk(dir);
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

describe("writes flag and digest", () => {
  it("1. writes is false without the flag and true with it; digest absent without, 64 hex with it, matching statusDigest", async () => {
    const { s, id } = await eight();

    // Without allowWrites
    const without = await get(`/api/workspaces`);
    expect((without.body as any).writes).toBe(false);
    const statusWithout = await get(`/api/workspaces/${id}`);
    expect((statusWithout.body as any).digest).toBeUndefined();

    // With allowWrites
    const withWrites = await get(`/api/workspaces`, { allowWrites: true });
    expect((withWrites.body as any).writes).toBe(true);

    const statusWithWrites = await get(`/api/workspaces/${id}`, { allowWrites: true });
    const returnedDigest = (statusWithWrites.body as any).digest;
    expect(returnedDigest).toMatch(/^[0-9a-f]{64}$/);

    // Compare with statusDigest computed directly
    const ws = await loadWorkspace(s.wsRoot, { home: HOME() });
    const p = await plan(ws);
    const st = await status(ws, p, await readLock(ws.root));
    const computed = await statusDigest(ws, st);
    expect(returnedDigest).toBe(computed);
  });
});

describe("sync route", () => {
  it("2. sync with current digest → 200, then second GET digest differs; drift, orphan-drift, collision unchanged", async () => {
    const { s, id } = await eight();

    // Get the current digest
    const statusBefore = await get(`/api/workspaces/${id}`, { allowWrites: true });
    const digest = (statusBefore.body as any).digest;

    // Record the drift, orphan-drift, collision bytes before
    const driftBefore = await fs.readFile(path.join(s.wsRoot, `${R}/edited.md`));
    const orphanDriftBefore = await fs.readFile(path.join(s.wsRoot, `${R}/gone-edited.md`));
    const collisionBefore = await fs.readFile(path.join(s.wsRoot, `${R}/clash.md`));

    // Sync
    const result = await post(`/api/workspaces/${id}/sync`, { digest });
    expect(result.status).toBe(200);

    // Check the result
    const body = result.body as any;
    expect(body.profile).toBe("acme");
    expect(body.recipes).toEqual(["base"]);
    expect(body.targets).toEqual(["claude-code"]);
    expect(body.written.sort()).toEqual([".claude/rules/adopted.md", ".claude/rules/fresh.md", ".claude/rules/moved.md"]);
    expect(body.removed).toEqual([{ path: ".claude/rules/gone.md", reason: "orphan: no longer produced by the Forge" }]);
    expect(body.skipped.map((s: any) => s.path).sort()).toEqual([".claude/rules/clash.md", ".claude/rules/edited.md", ".claude/rules/gone-edited.md"]);
    expect(body.registry).toBe("updated");

    // Second GET: digest should differ
    const statusAfter = await get(`/api/workspaces/${id}`, { allowWrites: true });
    const digestAfter = (statusAfter.body as any).digest;
    expect(digestAfter).not.toBe(digest);

    // Drift, orphan-drift, collision files unchanged
    expect(await fs.readFile(path.join(s.wsRoot, `${R}/edited.md`))).toEqual(driftBefore);
    expect(await fs.readFile(path.join(s.wsRoot, `${R}/gone-edited.md`))).toEqual(orphanDriftBefore);
    expect(await fs.readFile(path.join(s.wsRoot, `${R}/clash.md`))).toEqual(collisionBefore);
  });

  it("3. sync with stale digest → 409 STALE_DIGEST, tree unchanged", async () => {
    const { s, id } = await eight();

    // Get the current digest
    const statusBefore = await get(`/api/workspaces/${id}`, { allowWrites: true });
    const digest = (statusBefore.body as any).digest;

    // Sync once to change the workspace state
    await syncRegistered(s.wsRoot);

    const treeBefore = await tree(s.wsRoot);

    // Try to sync with the old digest
    const result = await post(`/api/workspaces/${id}/sync`, { digest });
    expect(result.status).toBe(409);
    expect((result.body as any).error).toBe(STALE_DIGEST);

    // Tree unchanged
    expect(await tree(s.wsRoot)).toEqual(treeBefore);
  });
});

describe("discard route", () => {
  it("4. discard of drift path → 200, file now equals Forge's bytes, listed in written", async () => {
    const { s, id } = await eight();

    // Get status with digest
    const statusBefore = await get(`/api/workspaces/${id}`, { allowWrites: true });
    const digest = (statusBefore.body as any).digest;

    const driftPath = `${R}/edited.md`;

    // Discard
    const result = await post(`/api/workspaces/${id}/discard`, { digest, path: driftPath });
    expect(result.status).toBe(200);

    const body = result.body as any;
    expect(body.written).toContain(driftPath);

    // File now equals Forge's bytes
    const content = await fs.readFile(path.join(s.wsRoot, driftPath), "utf8");
    expect(content).toBe("# Edited\nby the forge\n");
  });

  it("5. discard of orphan-drift path → 200, file is gone, lock no longer lists it", async () => {
    const { s, id } = await eight();

    // Get status with digest
    const statusBefore = await get(`/api/workspaces/${id}`, { allowWrites: true });
    const digest = (statusBefore.body as any).digest;

    const orphanDriftPath = `${R}/gone-edited.md`;

    // Discard
    const result = await post(`/api/workspaces/${id}/discard`, { digest, path: orphanDriftPath });
    expect(result.status).toBe(200);

    const body = result.body as any;
    expect(body.removed).toContainEqual({ path: orphanDriftPath, reason: "hand-edited orphan: discarded" });

    // File is gone
    await expect(fs.access(path.join(s.wsRoot, orphanDriftPath))).rejects.toThrow();

    // Lock no longer lists it
    const lock = JSON.parse(await fs.readFile(path.join(s.wsRoot, "craftar.lock"), "utf8"));
    expect(lock.files.some((f: any) => f.path === orphanDriftPath)).toBe(false);
  });

  it("6. discard of update path → 409 NOT_HAND_EDITED, body does not contain the path, tree unchanged", async () => {
    const { s, id } = await eight();

    // Get status with digest
    const statusBefore = await get(`/api/workspaces/${id}`, { allowWrites: true });
    const digest = (statusBefore.body as any).digest;

    const treeBefore = await tree(s.wsRoot);

    const updatePath = `${R}/moved.md`;

    // Try to discard
    const result = await post(`/api/workspaces/${id}/discard`, { digest, path: updatePath });
    expect(result.status).toBe(409);
    expect((result.body as any).error).toBe(NOT_HAND_EDITED);
    expect(JSON.stringify(result.body)).not.toContain(updatePath);

    // Tree unchanged
    expect(await tree(s.wsRoot)).toEqual(treeBefore);
  });

  it("7. discard of path that is no row → 409 NOT_HAND_EDITED, answer does not contain it", async () => {
    const { s, id } = await eight();

    // Get status with digest
    const statusBefore = await get(`/api/workspaces/${id}`, { allowWrites: true });
    const digest = (statusBefore.body as any).digest;

    const treeBefore = await tree(s.wsRoot);

    const badPath = "../../etc/passwd";

    // Try to discard
    const result = await post(`/api/workspaces/${id}/discard`, { digest, path: badPath });
    expect(result.status).toBe(409);
    expect((result.body as any).error).toBe(NOT_HAND_EDITED);
    expect(JSON.stringify(result.body)).not.toContain(badPath);

    // Tree unchanged
    expect(await tree(s.wsRoot)).toEqual(treeBefore);
  });

  it("8. discard of .claude/settings.craftar.example.json in drift and orphan-drift → 409", async () => {
    const EX = MCP_FILES[2];

    // Test drift state
    {
      await fs.rm(registryFile(HOME()), { force: true });
      const s = kept(await mcpWorkspace());
      await syncOnce(s.wsRoot);
      await fs.appendFile(path.join(s.wsRoot, EX), "\n");
      const ws = await loadWorkspace(s.wsRoot, { home: HOME() });
      const entry = await register(HOME(), ws, await plan(ws));
      const id = workspaceId(entry.path);

      const statusResp = await get(`/api/workspaces/${id}`, { allowWrites: true });
      const digest = (statusResp.body as any).digest;
      const treeBefore = await tree(s.wsRoot);

      const result = await post(`/api/workspaces/${id}/discard`, { digest, path: EX });
      expect(result.status).toBe(409);
      expect((result.body as any).error).toBe(NOT_HAND_EDITED);
      expect(await tree(s.wsRoot)).toEqual(treeBefore);
    }

    // Test orphan-drift state
    {
      await fs.rm(registryFile(HOME()), { force: true });
      const s = kept(await mcpWorkspace());
      await syncOnce(s.wsRoot);
      // Remove MCP from recipe so the example file becomes orphan
      await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), YAML.stringify(recipe("base", ["rule/keep"])));
      await fs.appendFile(path.join(s.wsRoot, EX), "\n");
      const ws = await loadWorkspace(s.wsRoot, { home: HOME() });
      const entry = await register(HOME(), ws, await plan(ws));
      const id = workspaceId(entry.path);

      const statusResp = await get(`/api/workspaces/${id}`, { allowWrites: true });
      const digest = (statusResp.body as any).digest;
      const treeBefore = await tree(s.wsRoot);

      const result = await post(`/api/workspaces/${id}/discard`, { digest, path: EX });
      expect(result.status).toBe(409);
      expect((result.body as any).error).toBe(NOT_HAND_EDITED);
      expect(await tree(s.wsRoot)).toEqual(treeBefore);
    }
  });
});

describe("remote Forge", () => {
  it("9. remote Forge → 409 REMOTE_FORGE, tree unchanged", async () => {
    const r = kept(await remoteForge(BASE));
    const ws = await tmpDir();
    cleanups.push(() => fs.rm(ws, { recursive: true, force: true }));
    await fs.writeFile(path.join(ws, "craftar.yaml"), YAML.stringify({ forge: r.url, profile: "acme" }));
    const { id } = await syncRegistered(ws);

    const statusResp = await get(`/api/workspaces/${id}`, { allowWrites: true });
    const digest = (statusResp.body as any).digest;
    const treeBefore = await tree(ws);

    // Try sync
    const syncResult = await post(`/api/workspaces/${id}/sync`, { digest });
    expect(syncResult.status).toBe(409);
    expect((syncResult.body as any).error).toBe(REMOTE_FORGE);

    // Try discard (need to create a drift file first)
    await fs.writeFile(path.join(ws, `${R}/keep.md`), "# Keep\nedited\n");
    const statusResp2 = await get(`/api/workspaces/${id}`, { allowWrites: true });
    const digest2 = (statusResp2.body as any).digest;

    const discardResult = await post(`/api/workspaces/${id}/discard`, { digest: digest2, path: `${R}/keep.md` });
    expect(discardResult.status).toBe(409);
    expect((discardResult.body as any).error).toBe(REMOTE_FORGE);

    // Tree unchanged (except for the edit we made)
    const treeAfter = await tree(ws);
    // The keep.md file should still be edited
    expect(await fs.readFile(path.join(ws, `${R}/keep.md`), "utf8")).toBe("# Keep\nedited\n");
  });
});

describe("unset declared parameter", () => {
  it("10. unset declared parameter → 409 with unsetSummary text", async () => {
    const s = kept(
      await scenario(
        {
          ingredients: [rule("api", "port {{api.port}}\n", { params: { "api.port": {} } })],
          recipes: [recipe("base", ["rule/api"])],
          profiles: [profile("acme", ["base"])],
        },
        { config: { profile: "acme" } },
      ),
    );
    const ws = await loadWorkspace(s.wsRoot, { home: HOME() });
    const entry = await register(HOME(), ws, await plan(ws));
    const id = workspaceId(entry.path);

    const statusResp = await get(`/api/workspaces/${id}`, { allowWrites: true });
    const digest = (statusResp.body as any).digest;
    const treeBefore = await tree(s.wsRoot);

    const result = await post(`/api/workspaces/${id}/sync`, { digest });
    expect(result.status).toBe(409);
    expect((result.body as any).error).toBe(unsetSummary([{ key: "api.port", declaredBy: ["rule/api"], citedBy: ["rule/api"] }]));

    expect(await tree(s.wsRoot)).toEqual(treeBefore);
  });
});

describe("registry not updated", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("11. registry cannot be written: 'not updated' in result, no registry path in answer", async () => {
    const s = kept(
      await scenario(BASE, { config: { profile: "acme" } }),
    );
    const { id } = await syncRegistered(s.wsRoot);

    const statusResp = await get(`/api/workspaces/${id}`, { allowWrites: true });
    const digest = (statusResp.body as any).digest;

    // Make home directory read-only to prevent registry writes
    const home = HOME();
    const regPath = registryFile(home);
    try {
      await fs.chmod(home, 0o555);

      const result = await post(`/api/workspaces/${id}/sync`, { digest });
      expect(result.status).toBe(200);
      expect((result.body as any).registry).toBe("not updated");
      expect(JSON.stringify(result.body)).not.toContain(regPath);
    } finally {
      await fs.chmod(home, 0o755);
    }
  });
});

describe("parseWriteBody", () => {
  it("12. valid and invalid bodies", () => {
    // Valid sync
    expect(parseWriteBody("sync", JSON.stringify({ digest: "a".repeat(64) }))).toEqual({ digest: "a".repeat(64) });

    // Valid discard
    expect(parseWriteBody("discard", JSON.stringify({ digest: "b".repeat(64), path: "some/path.md" }))).toEqual({
      digest: "b".repeat(64),
      path: "some/path.md",
    });

    // Extra key
    expect(parseWriteBody("sync", JSON.stringify({ digest: "a".repeat(64), extra: "x" }))).toBeNull();
    expect(parseWriteBody("discard", JSON.stringify({ digest: "a".repeat(64), path: "x", extra: "y" }))).toBeNull();

    // Missing digest
    expect(parseWriteBody("sync", JSON.stringify({}))).toBeNull();
    expect(parseWriteBody("discard", JSON.stringify({ path: "x" }))).toBeNull();

    // Uppercase hex
    expect(parseWriteBody("sync", JSON.stringify({ digest: "A".repeat(64) }))).toBeNull();

    // 63 hex (one short)
    expect(parseWriteBody("sync", JSON.stringify({ digest: "a".repeat(63) }))).toBeNull();

    // path on sync
    expect(parseWriteBody("sync", JSON.stringify({ digest: "a".repeat(64), path: "x" }))).toBeNull();

    // No path on discard
    expect(parseWriteBody("discard", JSON.stringify({ digest: "a".repeat(64) }))).toBeNull();

    // path not a string
    expect(parseWriteBody("discard", JSON.stringify({ digest: "a".repeat(64), path: 123 }))).toBeNull();

    // Array
    expect(parseWriteBody("sync", "[]")).toBeNull();

    // null
    expect(parseWriteBody("sync", "null")).toBeNull();

    // String
    expect(parseWriteBody("sync", '"x"')).toBeNull();

    // Invalid JSON
    expect(parseWriteBody("sync", "{ broken")).toBeNull();
  });
});

describe("method and flag checks", () => {
  it("13. without flag: POST returns 404; GET to sync/discard returns 404; POST to diff returns 404", async () => {
    const { id } = await eight();
    const digest = "a".repeat(64);

    // POST without allowWrites → 404
    const postWithoutFlag = await route(
      { path: `/api/workspaces/${id}/sync`, query: "", method: "POST", body: { digest } },
      { home: HOME(), version: "0.0.0-test", allowWrites: false },
    );
    expect(postWithoutFlag.status).toBe(404);

    // GET to sync → 404
    const getSync = await get(`/api/workspaces/${id}/sync`, { allowWrites: true });
    expect(getSync.status).toBe(404);

    // GET to discard → 404
    const getDiscard = await get(`/api/workspaces/${id}/discard`, { allowWrites: true });
    expect(getDiscard.status).toBe(404);

    // POST to diff → 404 (with allowWrites, POST to reading route)
    const postDiff = await route(
      { path: `/api/workspaces/${id}/diff`, query: "path=x", method: "POST", body: { digest } },
      { home: HOME(), version: "0.0.0-test", allowWrites: true },
    );
    expect(postDiff.status).toBe(404);
  });
});

describe("orphan-drift diff under flag", () => {
  it("14. under flag, diff route of orphan-drift carries body; example file has diff: null, note: EXAMPLE_CONTENT_HIDDEN", async () => {
    const { s, id } = await eight();

    // Regular orphan-drift file should have body
    const orphanDriftPath = `${R}/gone-edited.md`;
    const diffResp = await get(`/api/workspaces/${id}/diff?path=${encodeURIComponent(orphanDriftPath)}`, { allowWrites: true });
    expect(diffResp.status).toBe(200);
    const body = diffResp.body as any;
    expect(body.state).toBe("orphan-drift");
    expect(body.diff).not.toBeNull();
    expect(body.diff).toContain("# Gone edited");
    expect(body.to).toBe(`${orphanDriftPath} (forge: no longer produced — discard removes it)`);

    // Example file in orphan-drift should have no body
    {
      await fs.rm(registryFile(HOME()), { force: true });
      const EX = MCP_FILES[2];
      const s = kept(await mcpWorkspace());
      await syncOnce(s.wsRoot);
      await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), YAML.stringify(recipe("base", ["rule/keep"])));
      await fs.appendFile(path.join(s.wsRoot, EX), "\n");
      const ws = await loadWorkspace(s.wsRoot, { home: HOME() });
      const entry = await register(HOME(), ws, await plan(ws));
      const id = workspaceId(entry.path);

      const exDiff = await get(`/api/workspaces/${id}/diff?path=${encodeURIComponent(EX)}`, { allowWrites: true });
      expect(exDiff.status).toBe(200);
      const exBody = exDiff.body as any;
      expect(exBody.state).toBe("orphan-drift");
      expect(exBody.diff).toBeNull();
      expect(exBody.note).toBe(EXAMPLE_CONTENT_HIDDEN);
    }
  });
});

describe("routePattern and WRITE_PATTERNS", () => {
  it("15. routePattern names the two write routes; invalid id is still null", () => {
    const id = "0123456789abcdef";
    expect(routePattern(`/api/workspaces/${id}/sync`)).toBe("/api/workspaces/<id>/sync");
    expect(routePattern(`/api/workspaces/${id}/discard`)).toBe("/api/workspaces/<id>/discard");
    expect(WRITE_PATTERNS).toEqual(["/api/workspaces/<id>/sync", "/api/workspaces/<id>/discard"]);

    // Invalid id (not 16 hex)
    expect(routePattern("/api/workspaces/invalid/sync")).toBeNull();
    expect(routePattern("/api/workspaces/0123456789ABCDEF/sync")).toBeNull(); // uppercase
    expect(routePattern("/api/workspaces/0123456789abcde/sync")).toBeNull(); // 15 chars
  });
});
