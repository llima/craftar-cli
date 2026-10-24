import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { allowWrites, revokeWrites, readRegistry } from "../src/core/registry.js";
import {
  handleLine,
  INSTRUCTIONS,
  INSTRUCTIONS_WRITES,
  PIN_CHANGED,
  pinOf,
  REGISTRY_UNREADABLE,
  TOOL_NAMES,
  WRITE_TOOL_NAMES,
  WRITES_NEED_REGISTRY,
  WRITES_NOT_ALLOWED,
  CONSENT_STALE,
  SYNC_NEEDS_FETCH,
  type McpContext,
  type McpState,
} from "../src/core/mcp-protocol.js";
import { mcpWriters, type McpWriters } from "../src/core/write-actions.js";
import { readWorkspaceConfig } from "../src/core/sync.js";
import { profile, recipe, rule, scenario, tmpDir, writeFiles, type Scenario } from "./helpers/forge.js";
import { eightStates, type Scenario as StateScenario } from "./helpers/states.js";

// Spec 40 Part B §5.3-§5.6 — the writing tools of `craftar mcp --allow-writes`.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario | StateScenario>(s: T): T => (cleanups.push(s.cleanup), s);

/** Every file under `dir` with its bytes, sorted by path. */
async function tree(dir: string): Promise<Array<[string, Buffer]>> {
  const out: Array<[string, Buffer]> = [];
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push([path.relative(dir, p).replace(/\\/g, "/"), await fs.readFile(p)]);
    }
  };
  await walk(dir);
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

/** A fresh temp home for registry isolation. */
async function freshHome(): Promise<string> {
  const home = await tmpDir("home-");
  cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

/** In-process MCP session with optional writers. */
async function fresh(
  wsRoot: string,
  opts: { home: string; writers?: McpWriters; registryOff?: boolean; fetch?: boolean; git?: McpContext["git"] } = { home: "" },
) {
  const ctx: McpContext = {
    root: wsRoot,
    fetch: opts.fetch ?? false,
    home: opts.home,
    version: "9.9.9",
    registryOff: opts.registryOff ?? false,
    env: {},
    pin: pinOf(await readWorkspaceConfig(wsRoot)),
    writers: opts.writers,
    git: opts.git,
  };
  const state: McpState = { initialized: false };
  const send = async (m: unknown) => {
    const out = await handleLine(typeof m === "string" ? m : JSON.stringify(m), ctx, state);
    return out === null ? null : JSON.parse(out);
  };
  const request = async (method: string, params?: unknown) =>
    send(JSON.stringify({ jsonrpc: "2.0", id: Math.random(), method, ...(params === undefined ? {} : { params }) }));
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  const tool = async (name: string, args?: Record<string, unknown>) => {
    const a = await request("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) });
    return a.error ? { content: [], rpcError: a.error } : a.result;
  };
  return { ctx, state, send, request, tool };
}

describe("craftar mcp --allow-writes — the writing tools", () => {
  // Test 1: No writers: `tools/list` names are the seven; `tools/call sync` → `-32602` with the seven-name message.
  it("1. no writers: tools/list names the seven, sync is -32602", async () => {
    const home = await freshHome();
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );
    const { request, tool } = await fresh(s.wsRoot, { home });
    const list = await request("tools/list");
    expect(list.result.tools.map((t: any) => t.name)).toEqual([...TOOL_NAMES]);
    expect(list.result.tools).toHaveLength(7);
    const sync = await tool("sync");
    expect(sync.rpcError).toEqual({ code: -32602, message: `unknown tool — one of ${TOOL_NAMES.join(", ")}` });
  });

  // Test 2: Writers, no consent
  it("2. writers, no consent: tools/list has 10, instructions = INSTRUCTIONS_WRITES, each call is WRITES_NOT_ALLOWED, files unchanged", async () => {
    const home = await freshHome();
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n"), rule("extra", "# Extra\n")], recipes: [recipe("base", ["rule/keep"]), recipe("extra", ["rule/extra"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );
    const writers = mcpWriters(home, false);
    const { request, tool, state } = await fresh(s.wsRoot, { home, writers });

    // tools/list
    const list = await request("tools/list");
    const names = list.result.tools.map((t: any) => t.name);
    expect(names).toEqual([...TOOL_NAMES, ...WRITE_TOOL_NAMES]);
    expect(names).toHaveLength(10);

    // Check annotations for the three writing tools
    for (const t of list.result.tools.filter((t: any) => WRITE_TOOL_NAMES.includes(t.name))) {
      expect(t.annotations.readOnlyHint).toBe(false);
      expect(t.annotations.idempotentHint).toBe(true);
      if (t.name === "sync") {
        expect(t.annotations.destructiveHint).toBe(true);
      } else {
        expect(t.annotations.destructiveHint).toBe(false);
      }
    }

    // Re-initialize to check instructions
    const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(init.result.instructions).toBe(INSTRUCTIONS_WRITES);
    expect(INSTRUCTIONS_WRITES).toBe(
      INSTRUCTIONS +
        " " +
        "Started with --allow-writes, the server also has `sync`, `add_recipe` and `remove_recipe`, which write only in a workspace where a person typed `craftar mcp allow-writes`; `sync` never discards a hand edit — a person resolves a drift with `craftar drift discard`.",
    );

    const before = await tree(s.wsRoot);

    // Each of the three calls should return WRITES_NOT_ALLOWED
    const syncResult = await tool("sync");
    expect(syncResult.isError).toBe(true);
    expect(syncResult.content[0].text).toBe(WRITES_NOT_ALLOWED);

    const addResult = await tool("add_recipe", { names: ["extra"] });
    expect(addResult.isError).toBe(true);
    expect(addResult.content[0].text).toBe(WRITES_NOT_ALLOWED);

    const removeResult = await tool("remove_recipe", { names: ["base"] });
    expect(removeResult.isError).toBe(true);
    expect(removeResult.content[0].text).toBe(WRITES_NOT_ALLOWED);

    // Files unchanged
    const after = await tree(s.wsRoot);
    expect(after).toEqual(before);
  });

  // Test 3: Consent + eightStates: sync writes correctly
  it("3. consent + eightStates: sync result has correct written/removed/skipped, files unchanged where expected, no content in result", async () => {
    const { loadWorkspace, plan } = await import("../src/core/sync.js");
    const home = await freshHome();
    const s = kept(await eightStates());
    const writers = mcpWriters(home, false);

    // Record consent
    await allowWrites(home, s.wsRoot, { forge: { source: "../forge", ref: null }, profile: "acme" });

    // Compute the plan before the call to get all planned file contents
    const ws = await loadWorkspace(s.wsRoot, { home });
    const p = await plan(ws);

    const { tool } = await fresh(s.wsRoot, { home, writers });

    const result = await tool("sync");
    expect(result.isError).toBeUndefined();

    const sc = result.structuredContent;
    // written should be adopted, fresh, moved (sorted)
    const writtenPaths = sc.written.sort();
    expect(writtenPaths).toEqual([".claude/rules/adopted.md", ".claude/rules/fresh.md", ".claude/rules/moved.md"]);

    // removed should be gone
    expect(sc.removed).toEqual([{ path: ".claude/rules/gone.md", reason: "orphan: no longer produced by the Forge" }]);

    // skipped paths and states
    const skipped = sc.skipped.map((s: any) => ({ path: s.path, state: s.state })).sort((a: any, b: any) => a.path.localeCompare(b.path));
    expect(skipped).toEqual([
      { path: ".claude/rules/clash.md", state: "collision" },
      { path: ".claude/rules/edited.md", state: "drift" },
      { path: ".claude/rules/gone-edited.md", state: "orphan-drift" },
    ]);

    // registry updated
    expect(sc.registry).toBe("updated");

    // On disk: hand-edited files unchanged
    expect(await fs.readFile(path.join(s.wsRoot, ".claude/rules/edited.md"), "utf8")).toBe("# Edited\nby hand\n");
    expect(await fs.readFile(path.join(s.wsRoot, ".claude/rules/gone-edited.md"), "utf8")).toBe("# Gone edited\nby hand\n");
    expect(await fs.readFile(path.join(s.wsRoot, ".claude/rules/clash.md"), "utf8")).toBe("# Clash\ndisk side\n");

    // Full content scan: walk every string leaf of the result and check no planned body line appears.
    // Collect all string leaves from structuredContent and parsed content[0].text
    const leaves: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") leaves.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(sc);
    if (result.content?.[0]?.text) {
      try {
        walk(JSON.parse(result.content[0].text));
      } catch {
        leaves.push(result.content[0].text);
      }
    }

    // Collect significant lines from all planned files (non-empty, trimmed, > 3 chars)
    const forbiddenLines: string[] = [];
    for (const f of p.files) {
      const lines = f.content.toString("utf8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 3) forbiddenLines.push(trimmed);
      }
    }

    // No leaf may contain any forbidden line
    for (const leaf of leaves) {
      for (const forbidden of forbiddenLines) {
        expect(leaf).not.toContain(forbidden);
      }
    }
  });

  // Test 4: A second sync right after: written [], removed [], lock unchanged
  it("4. second sync: written [], removed [], lock bytes unchanged", async () => {
    const home = await freshHome();
    const s = kept(await eightStates());
    const writers = mcpWriters(home, false);

    await allowWrites(home, s.wsRoot, { forge: { source: "../forge", ref: null }, profile: "acme" });

    const { tool } = await fresh(s.wsRoot, { home, writers });

    // First sync
    await tool("sync");
    const lockBefore = await fs.readFile(path.join(s.wsRoot, "craftar.lock"), "utf8");

    // Second sync
    const result = await tool("sync");
    expect(result.structuredContent.written).toEqual([]);
    expect(result.structuredContent.removed).toEqual([]);

    const lockAfter = await fs.readFile(path.join(s.wsRoot, "craftar.lock"), "utf8");
    expect(lockAfter).toBe(lockBefore);
  });

  // Test 5: CONSENT_STALE: consent recorded with profile: "acme-old"
  it("5. CONSENT_STALE: consent with different profile, text matches constant and does not contain 'acme-old'", async () => {
    const home = await freshHome();
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"]), profile("acme-old", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );
    const writers = mcpWriters(home, false);

    // Consent with wrong profile
    await allowWrites(home, s.wsRoot, { forge: { source: "../forge", ref: null }, profile: "acme-old" });

    const { tool } = await fresh(s.wsRoot, { home, writers });

    const result = await tool("sync");
    expect(result.isError).toBe(true);
    const expected = `the write consent of this workspace was given for another profile — a person types craftar mcp allow-writes again to allow the current one`;
    expect(result.content[0].text).toBe(expected);
    expect(result.content[0].text).not.toContain("acme-old");
  });

  // Test 5b: CONSENT_STALE: consent recorded with different forge source
  it("5b. CONSENT_STALE: consent with different forge, text equals CONSENT_STALE([forge]), tree unchanged", async () => {
    const home = await freshHome();
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );
    const writers = mcpWriters(home, false);
    const before = await tree(s.wsRoot);

    // Consent with wrong forge source
    await allowWrites(home, s.wsRoot, { forge: { source: "../other-forge", ref: null }, profile: "acme" });

    const { tool } = await fresh(s.wsRoot, { home, writers });

    const result = await tool("sync");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(CONSENT_STALE(["forge"]));

    const after = await tree(s.wsRoot);
    expect(after).toEqual(before);
  });

  // Test 5c: CONSENT_STALE: consent recorded with ref: "v1" while config has no ref
  it("5c. CONSENT_STALE: consent with ref: 'v1', config has no ref, text equals CONSENT_STALE([ref]), tree unchanged", async () => {
    const home = await freshHome();
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );
    const writers = mcpWriters(home, false);
    const before = await tree(s.wsRoot);

    // Consent with a ref while config has none (ref: null in the pin)
    await allowWrites(home, s.wsRoot, { forge: { source: "../forge", ref: "v1" }, profile: "acme" });

    const { tool } = await fresh(s.wsRoot, { home, writers });

    const result = await tool("sync");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(CONSENT_STALE(["ref"]));

    const after = await tree(s.wsRoot);
    expect(after).toEqual(before);
  });

  // Test 6: PIN_CHANGED first: consent with profile: "other" AND craftar.yaml changed after pin
  it("6. PIN_CHANGED takes precedence over CONSENT_STALE when config changed after pin", async () => {
    const home = await freshHome();
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"]), profile("other", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );
    const writers = mcpWriters(home, false);

    // Consent with wrong profile
    await allowWrites(home, s.wsRoot, { forge: { source: "../forge", ref: null }, profile: "other" });

    const { tool, ctx } = await fresh(s.wsRoot, { home, writers });

    // Change craftar.yaml after the pin was taken
    await writeFiles(s.wsRoot, { "craftar.yaml": "forge: ../forge\nprofile: other\n" });

    const result = await tool("sync");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(PIN_CHANGED);
  });

  // Test 7: Remote Forge without fetch: SYNC_NEEDS_FETCH, and git runner recorded no call
  it("7. remote Forge without --fetch: SYNC_NEEDS_FETCH, no git call", async () => {
    const home = await freshHome();
    // Create a workspace with a remote Forge URL
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );
    // Overwrite craftar.yaml with a remote URL
    await writeFiles(s.wsRoot, { "craftar.yaml": "forge: https://example.com/acme/forge.git\nprofile: acme\n" });

    const writers = mcpWriters(home, false);

    // Consent matching the remote URL
    await allowWrites(home, s.wsRoot, { forge: { source: "https://example.com/acme/forge.git", ref: null }, profile: "acme" });

    // Recording git runner
    const calls: string[][] = [];
    const recordingGit: McpContext["git"] = async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", exitCode: 1 };
    };

    const { tool } = await fresh(s.wsRoot, { home, writers, fetch: false, git: recordingGit });

    const result = await tool("sync");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(SYNC_NEEDS_FETCH);
    expect(calls).toEqual([]);
  });

  // Test 8: registry: "not updated" when chmod 0o555
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("8. registry cannot be written: registry: 'not updated', files written, no home/registry/EACCES in answer", async () => {
    const home = await freshHome();
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );
    const writers = mcpWriters(home, false);

    await allowWrites(home, s.wsRoot, { forge: { source: "../forge", ref: null }, profile: "acme" });

    try {
      await fs.chmod(home, 0o555);
      const { tool } = await fresh(s.wsRoot, { home, writers });

      const result = await tool("sync");
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent.registry).toBe("not updated");

      // Files should still be written
      expect(await fs.access(path.join(s.wsRoot, ".claude/rules/keep.md"))).toBeUndefined();

      // The answer must not contain home path, registry.json, or EACCES/EPERM
      const json = JSON.stringify(result);
      expect(json).not.toContain(home);
      expect(json).not.toContain("registry.json");
      expect(json).not.toContain("EACCES");
      expect(json).not.toContain("EPERM");
    } finally {
      await fs.chmod(home, 0o755);
    }
  });

  // Test 9: add_recipe and remove_recipe
  it("9. add_recipe then remove_recipe: changed, craftarYaml, recipes, nextSync", async () => {
    const home = await freshHome();
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n"), rule("extra", "# Extra\n")], recipes: [recipe("base", ["rule/keep"]), recipe("extra", ["rule/extra"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );
    const writers = mcpWriters(home, false);

    await allowWrites(home, s.wsRoot, { forge: { source: "../forge", ref: null }, profile: "acme" });

    const { tool } = await fresh(s.wsRoot, { home, writers });

    // add_recipe
    const addResult = await tool("add_recipe", { names: ["extra"] });
    expect(addResult.isError).toBeUndefined();
    const addSc = addResult.structuredContent;
    expect(addSc.changed).toBe(true);
    expect(typeof addSc.craftarYaml).toBe("string");
    expect(addSc.recipes).toEqual(["base", "extra"]);
    expect(addSc.nextSync).toMatch(/^next sync: /);

    // Verify craftar.yaml was updated
    const yaml = await fs.readFile(path.join(s.wsRoot, "craftar.yaml"), "utf8");
    expect(yaml).toContain("extra");

    // remove_recipe
    const removeResult = await tool("remove_recipe", { names: ["extra"] });
    expect(removeResult.isError).toBeUndefined();
    const removeSc = removeResult.structuredContent;
    expect(removeSc.changed).toBe(true);
    expect(removeSc.recipes).toEqual(["base"]);
  });

  // Test 10: Arguments validation
  it("10. arguments: add_recipe {}, { names: [] }, 33 names, { names: ['x'], other: 1 } → each -32602", async () => {
    const home = await freshHome();
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );
    const writers = mcpWriters(home, false);

    await allowWrites(home, s.wsRoot, { forge: { source: "../forge", ref: null }, profile: "acme" });

    const { tool } = await fresh(s.wsRoot, { home, writers });

    // Missing names
    const r1 = await tool("add_recipe", {});
    expect(r1.rpcError?.code).toBe(-32602);

    // Empty names
    const r2 = await tool("add_recipe", { names: [] });
    expect(r2.rpcError?.code).toBe(-32602);

    // 33 names (max is 32)
    const r3 = await tool("add_recipe", { names: Array(33).fill("x") });
    expect(r3.rpcError?.code).toBe(-32602);

    // Extra property
    const r4 = await tool("add_recipe", { names: ["x"], other: 1 });
    expect(r4.rpcError?.code).toBe(-32602);
  });

  // Test 11: R1 refusal
  it("11. R1: craftar.local.yaml sets recipes, consent present → isError with R1 message, craftar.yaml unchanged", async () => {
    const home = await freshHome();
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n"), rule("extra", "# Extra\n")], recipes: [recipe("base", ["rule/keep"]), recipe("extra", ["rule/extra"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" }, local: { recipes: { add: ["extra"] } } },
      ),
    );
    const writers = mcpWriters(home, false);

    await allowWrites(home, s.wsRoot, { forge: { source: "../forge", ref: null }, profile: "acme" });

    const yamlBefore = await fs.readFile(path.join(s.wsRoot, "craftar.yaml"), "utf8");

    const { tool } = await fresh(s.wsRoot, { home, writers });

    const result = await tool("add_recipe", { names: ["extra"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("craftar.local.yaml sets recipes");

    const yamlAfter = await fs.readFile(path.join(s.wsRoot, "craftar.yaml"), "utf8");
    expect(yamlAfter).toBe(yamlBefore);
  });

  // Test 12: Revoke mid-session
  it("12. revoke mid-session: consent, add_recipe succeeds, revokeWrites, next remove_recipe → WRITES_NOT_ALLOWED", async () => {
    const home = await freshHome();
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n"), rule("extra", "# Extra\n")], recipes: [recipe("base", ["rule/keep"]), recipe("extra", ["rule/extra"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );
    const writers = mcpWriters(home, false);

    await allowWrites(home, s.wsRoot, { forge: { source: "../forge", ref: null }, profile: "acme" });

    const { tool } = await fresh(s.wsRoot, { home, writers });

    // First call succeeds
    const addResult = await tool("add_recipe", { names: ["extra"] });
    expect(addResult.isError).toBeUndefined();

    // Revoke consent
    await revokeWrites(home, s.wsRoot);

    // Next call fails
    const removeResult = await tool("remove_recipe", { names: ["extra"] });
    expect(removeResult.isError).toBe(true);
    expect(removeResult.content[0].text).toBe(WRITES_NOT_ALLOWED);
  });

  // Test 13: registryOff: true → WRITES_NEED_REGISTRY, reading tool status still answers
  it("13. registryOff: true → WRITES_NEED_REGISTRY; status still answers", async () => {
    const home = await freshHome();
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );
    const writers = mcpWriters(home, true); // registryOff = true in writers

    const { tool, ctx } = await fresh(s.wsRoot, { home, writers, registryOff: true });

    // Writing tool fails
    const syncResult = await tool("sync");
    expect(syncResult.isError).toBe(true);
    expect(syncResult.content[0].text).toBe(WRITES_NEED_REGISTRY);

    // Reading tool still works
    const statusResult = await tool("status");
    expect(statusResult.isError).toBeUndefined();
    expect(statusResult.structuredContent.statuses).toBeDefined();
  });

  // Test 14: Unset declared parameter
  it("14. unset declared parameter: sync is isError, .claude/rules/api.md not written", async () => {
    const home = await freshHome();
    const s = kept(
      await scenario(
        {
          ingredients: [rule("api", "Port {{api.port}}.\n", { params: { "api.port": {} } })],
          recipes: [recipe("base", ["rule/api"])],
          profiles: [profile("acme", ["base"])],
        },
        { config: { profile: "acme" } },
      ),
    );
    const writers = mcpWriters(home, false);

    await allowWrites(home, s.wsRoot, { forge: { source: "../forge", ref: null }, profile: "acme" });

    const { tool } = await fresh(s.wsRoot, { home, writers });

    const result = await tool("sync");
    expect(result.isError).toBe(true);
    // Should contain the unset refusal text
    expect(result.content[0].text).toContain("declared parameter");

    // File not written
    await expect(fs.access(path.join(s.wsRoot, ".claude/rules/api.md"))).rejects.toThrow();
  });

  // Test 15: Remote Forge warnings in add_recipe without --fetch
  it("15. remote Forge without --fetch: add_recipe result warnings[0] starts with 'Forge' and contains 'read from the copy cached'", async () => {
    const { remoteForge } = await import("./helpers/remote.js");
    const { loadWorkspace } = await import("../src/core/sync.js");
    const home = await freshHome();
    const r = await remoteForge({
      ingredients: [rule("keep", "# Keep\n"), rule("extra", "# Extra\n")],
      recipes: [recipe("base", ["rule/keep"]), recipe("extra", ["rule/extra"])],
      profiles: [profile("acme", ["base"])],
    });
    cleanups.push(r.cleanup);

    // Create workspace pointing at remote Forge
    const wsRoot = await tmpDir("ws-remote-");
    cleanups.push(() => fs.rm(wsRoot, { recursive: true, force: true }));
    await fs.writeFile(path.join(wsRoot, "craftar.yaml"), `forge: ${r.url}\nprofile: acme\n`);

    // Warm the cache with a sync
    await loadWorkspace(wsRoot, { home, mode: "sync" });

    // Record consent matching the remote Forge
    await allowWrites(home, wsRoot, { forge: { source: r.url, ref: null }, profile: "acme" });

    const writers = mcpWriters(home, false);
    const { tool } = await fresh(wsRoot, { home, writers, fetch: false });

    const result = await tool("add_recipe", { names: ["extra"] });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.warnings).toBeDefined();
    expect(result.structuredContent.warnings.length).toBeGreaterThan(0);
    expect(result.structuredContent.warnings[0]).toMatch(/^Forge /);
    expect(result.structuredContent.warnings[0]).toContain("read from the copy cached");
  });

  // Test 16: MCP sync loads in mode sync — a failed fetch says what to do from the AI coder
  it("16. remote Forge with --fetch, fetch fails: isError, text starts with 'cannot fetch', tail says 'craftar mcp syncs', no .claude/ or lock", async () => {
    const { remoteForge } = await import("./helpers/remote.js");
    const { loadWorkspace } = await import("../src/core/sync.js");
    const home = await freshHome();
    const r = await remoteForge({
      ingredients: [rule("keep", "# Keep\n")],
      recipes: [recipe("base", ["rule/keep"])],
      profiles: [profile("acme", ["base"])],
    });
    cleanups.push(r.cleanup);

    // Create workspace pointing at remote Forge
    const wsRoot = await tmpDir("ws-remote-");
    cleanups.push(() => fs.rm(wsRoot, { recursive: true, force: true }));
    await fs.writeFile(path.join(wsRoot, "craftar.yaml"), `forge: ${r.url}\nprofile: acme\n`);

    // Warm the cache with a sync
    await loadWorkspace(wsRoot, { home, mode: "sync" });

    // Record consent matching the remote Forge
    await allowWrites(home, wsRoot, { forge: { source: r.url, ref: null }, profile: "acme" });

    // Git seam that delegates to real runner but fails fetch and ls-remote
    const { defaultGit } = await import("../src/core/remote.js");
    const failingGit: McpContext["git"] = async (args: string[], opts) => {
      if (args[0] === "fetch" || args[0] === "ls-remote") {
        return { stdout: "", stderr: "simulated failure", exitCode: 1 };
      }
      return defaultGit(args, opts);
    };

    const writers = mcpWriters(home, false);
    const { tool } = await fresh(wsRoot, { home, writers, fetch: true, git: failingGit });

    const result = await tool("sync");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^cannot fetch the Forge /);
    expect(result.content[0].text).toContain("craftar mcp syncs a remote Forge only from a fresh fetch — run craftar sync --offline in a terminal to use the cached copy");

    // No .claude/ files written
    const claudeDir = path.join(wsRoot, ".claude");
    await expect(fs.access(claudeDir)).rejects.toThrow();

    // No craftar.lock written
    const lockFile = path.join(wsRoot, "craftar.lock");
    await expect(fs.access(lockFile)).rejects.toThrow();
  });

  // Test 17: Unreadable registry
  it("17. unreadable registry: isError, text exactly REGISTRY_UNREADABLE, workspace files unchanged", async () => {
    const home = await freshHome();
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );
    const writers = mcpWriters(home, false);
    const before = await tree(s.wsRoot);

    // Write a malformed registry that does not parse (writeConsent[0].path should be a string, not a number)
    await fs.writeFile(path.join(home, "registry.json"), JSON.stringify({ schema: 1, workspaces: [], writeConsent: [{ path: 1 }] }));

    const { tool } = await fresh(s.wsRoot, { home, writers });

    const result = await tool("sync");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(REGISTRY_UNREADABLE);

    // Workspace files unchanged
    const after = await tree(s.wsRoot);
    expect(after).toEqual(before);
  });

  // Test 18: openWorldHint on writing tools: false without --fetch, true with --fetch
  it("18. openWorldHint on writing tools: false without --fetch, true with --fetch", async () => {
    const home = await freshHome();
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );
    const writers = mcpWriters(home, false);

    // Without --fetch: openWorldHint = false
    const { request: reqNoFetch } = await fresh(s.wsRoot, { home, writers, fetch: false });
    const listNoFetch = await reqNoFetch("tools/list");
    for (const t of listNoFetch.result.tools.filter((t: any) => WRITE_TOOL_NAMES.includes(t.name))) {
      expect(t.annotations.openWorldHint).toBe(false);
    }

    // With --fetch: openWorldHint = true
    const { request: reqFetch } = await fresh(s.wsRoot, { home, writers, fetch: true });
    const listFetch = await reqFetch("tools/list");
    for (const t of listFetch.result.tools.filter((t: any) => WRITE_TOOL_NAMES.includes(t.name))) {
      expect(t.annotations.openWorldHint).toBe(true);
    }
  });
});
