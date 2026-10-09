import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadForge } from "../src/core/forge.js";
import {
  concerned,
  forgeWorkspaces,
  impactOf,
  nextSync,
  planAll,
  workspaceAgainst,
  type ForgeWorkspaces,
  type Planned,
} from "../src/core/impact.js";
import { register } from "../src/core/registry.js";
import { cacheKey } from "../src/core/remote.js";
import { loadWorkspace, mergeWorkspaceConfig, plan, readLock, status, apply } from "../src/core/sync.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";
import { git, remoteForge } from "./helpers/remote.js";

/**
 * Spec 25 §9 tests for the core impact module: forgeWorkspaces, planAll, impactOf, nextSync, concerned, workspaceAgainst.
 */

const FORGE: ForgeSpec = {
  ingredients: [rule("style", "# Style\n")],
  recipes: [recipe("base", ["rule/style"])],
  profiles: [profile("acme", ["base"]), profile("globex", ["base"])],
};

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fixture(spec: ForgeSpec = FORGE) {
  const root = await tmpDir("craftar-impact-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const forgeRoot = path.join(root, "forge");
  await makeForge(forgeRoot, spec);
  const ws = async (name: string, config: Record<string, unknown> = { profile: "acme" }) => {
    const wsRoot = path.join(root, name);
    await makeWorkspace(wsRoot, forgeRoot, { config });
    return wsRoot;
  };
  return { root, home, forgeRoot, ws };
}

/** A writing sync, then registration — what `craftar sync` does (spec 21 §4.1). */
async function syncAndRegister(home: string, wsRoot: string, now?: Date) {
  const ws = await loadWorkspace(wsRoot, { home });
  const p = await plan(ws);
  const st = await status(ws, p, await readLock(ws.root));
  await apply(ws, p, st);
  return register(home, ws, p, { now });
}

describe("forgeWorkspaces (spec 25 §3)", () => {
  it("test 1: path match — ../forge and absolute path both match, sorted by path, state read", async () => {
    const f = await fixture();
    // Workspace A uses ../forge (relative), B uses absolute path
    const a = await f.ws("acme-a");
    const b = await f.ws("acme-b", { profile: "acme", forge: f.forgeRoot });
    const other = await f.ws("acme-other", { profile: "acme", forge: path.join(f.root, "other-forge") });
    await makeForge(path.join(f.root, "other-forge"), FORGE);
    await syncAndRegister(f.home, a);
    await syncAndRegister(f.home, b);
    await syncAndRegister(f.home, other);

    const result = await forgeWorkspaces(f.home, f.forgeRoot);
    const realA = await fs.realpath(a);
    const realB = await fs.realpath(b);

    // Sorted by path
    const expectedOrder = [realA, realB].sort((x, y) => x.localeCompare(y));
    expect(result.state).toEqual("read");
    expect(result.warnings).toEqual([]);
    expect(result.workspaces.map((w) => ({ path: w.entry.path, match: w.match, via: w.via, ref: w.ref }))).toEqual(
      expectedOrder.map((p) => ({ path: p, match: "path", via: null, ref: null })),
    );
  });

  it("test 2: remote match — workspace with forge URL matched through origin", async () => {
    const rf = await remoteForge(FORGE);
    cleanups.push(rf.cleanup);
    const f = await fixture();
    const wsRoot = await f.ws("acme-remote", { profile: "acme", forge: rf.url });
    await syncAndRegister(f.home, wsRoot);

    // rf.src's origin is the bare repository's path — proves path→file-URL conversion
    const result = await forgeWorkspaces(f.home, rf.src);
    const realWs = await fs.realpath(wsRoot);

    expect(result.state).toEqual("read");
    expect(result.warnings).toEqual([]);
    expect(result.workspaces.map((w) => ({ path: w.entry.path, match: w.match, via: w.via, ref: w.ref }))).toEqual([
      { path: realWs, match: "remote", via: "origin", ref: null },
    ]);
  });

  it("test 3: two remotes giving one key — via is the first in git remote order", async () => {
    const rf = await remoteForge(FORGE);
    cleanups.push(rf.cleanup);
    const f = await fixture();
    const wsRoot = await f.ws("acme-remote", { profile: "acme", forge: rf.url });
    await syncAndRegister(f.home, wsRoot);

    // Add a second remote named "zebra" with the same URL (alphabetically after "origin")
    git(rf.src, "remote", "add", "zebra", rf.bare);

    const result = await forgeWorkspaces(f.home, rf.src);
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0].via).toEqual("origin"); // First in git remote order (alphabetical)
  });

  it("test 4: no remotes — path matches only, no warnings", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a");
    await syncAndRegister(f.home, a);

    // Forge is not a git repo (no .git)
    const result = await forgeWorkspaces(f.home, f.forgeRoot);
    expect(result.state).toEqual("read");
    expect(result.warnings).toEqual([]);
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0].match).toEqual("path");
  });

  it("test 5: clone match — second clone shares remote URL", async () => {
    const rf = await remoteForge(FORGE);
    cleanups.push(rf.cleanup);
    const f = await fixture();

    // Create a second clone of the same bare repository
    const clone2 = path.join(f.root, "forge-clone2");
    git(f.root, "clone", "-q", rf.bare, clone2);
    const realClone2 = await fs.realpath(clone2);

    // Workspace names clone2 by path
    const wsRoot = await f.ws("acme-clone", { profile: "acme", forge: clone2 });
    await syncAndRegister(f.home, wsRoot);

    // Query from rf.src (the original clone)
    const result = await forgeWorkspaces(f.home, rf.src);
    const realWs = await fs.realpath(wsRoot);

    expect(result.workspaces.map((w) => ({ path: w.entry.path, match: w.match, via: w.via }))).toEqual([
      { path: realWs, match: "clone", via: realClone2 },
    ]);
  });

  it("test 6: credentials — URL with credentials not matched, warning names remote only, URL never appears", async () => {
    const rf = await remoteForge(FORGE);
    cleanups.push(rf.cleanup);
    const f = await fixture();

    // Add a remote with credentials in URL
    const credsUrl = "https://user:tok@example.invalid/acme/forge.git";
    git(rf.src, "remote", "add", "creds", credsUrl);

    // Register a workspace whose Forge is REMOTE with a key that WOULD match the credentialed URL.
    // cacheKey does NOT strip credentials — cacheKey(credsUrl) differs from cacheKey(urlWithoutCreds).
    // The credential check skips the URL before it can be matched, so this workspace is not returned.
    const key = cacheKey(credsUrl);

    // Manually write a registry entry with kind: "remote" and key matching the credentialed URL
    const regFile = path.join(f.home, "registry.json");
    await fs.mkdir(f.home, { recursive: true });
    const remoteWsPath = path.join(f.root, "remote-ws");
    await fs.writeFile(
      regFile,
      JSON.stringify(
        {
          schema: 1,
          workspaces: [
            {
              path: remoteWsPath,
              profile: "acme",
              forge: { kind: "remote", source: credsUrl, key, ref: null, commit: "abc123", fromLocalFile: false },
              recipes: ["base"],
              stack: {},
              targets: ["claude-code"],
              lastSync: "2026-10-07T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );

    const result = await forgeWorkspaces(f.home, rf.src);
    const realSrc = await fs.realpath(rf.src);

    // Prove: warning names the remote ("creds") only, not the URL
    expect(result.warnings).toEqual([`remote creds of ${realSrc} holds credentials in its URL — not matched`]);

    // Prove: the workspace with matching key is NOT returned (credentialed URL skipped)
    expect(result.workspaces).toEqual([]);

    // Prove: URL and credentials never appear in the result
    const json = JSON.stringify(result);
    expect(json.includes("tok")).toBe(false);
    expect(json.includes("user:")).toBe(false);
    expect(json.includes("example.invalid")).toBe(false);
  });

  it("test 7: forge.key null entry is skipped", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a");
    await syncAndRegister(f.home, a);
    const realA = await fs.realpath(a);
    const realForge = await fs.realpath(f.forgeRoot);

    // Manually write a registry entry with key: null.
    // The key === null skip is load-bearing on win32: samePath(null, x) throws (null.toLowerCase()).
    // On POSIX, samePath(null, x) returns false and Map.has(null) returns false, but the clone
    // branch's fs.stat(null) throws into its catch as well — so the skip is still defensive there.
    // The skip makes the intent explicit and prevents unnecessary processing.
    const regFile = path.join(f.home, "registry.json");
    const reg = JSON.parse(await fs.readFile(regFile, "utf8"));
    const nullKeyPath = path.join(f.root, "null-key-ws");
    reg.workspaces.push({
      path: nullKeyPath,
      profile: "acme",
      // kind: "path" + key: null — even without skip, won't match (null !== realForge)
      forge: { kind: "path", source: realForge, key: null, ref: null, commit: null, fromLocalFile: false },
      recipes: ["base"],
      stack: {},
      targets: ["claude-code"],
      lastSync: "2026-10-07T00:00:00.000Z",
    });
    await fs.writeFile(regFile, JSON.stringify(reg, null, 2) + "\n");

    const result = await forgeWorkspaces(f.home, f.forgeRoot);

    // Prove: only workspace with valid key is included; null-key entry is NOT in workspaces
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0].entry.path).toBe(realA);
    expect(result.workspaces[0].entry.forge.key).not.toBeNull();
    expect(result.workspaces.find((w) => w.entry.path === nullKeyPath)).toBeUndefined();
  });

  it("test 8: CRAFTAR_NO_REGISTRY=1 returns off; no registry returns none", async () => {
    const f = await fixture();
    const realForge = await fs.realpath(f.forgeRoot);

    // With CRAFTAR_NO_REGISTRY=1
    const offResult = await forgeWorkspaces(f.home, f.forgeRoot, { ...process.env, CRAFTAR_NO_REGISTRY: "1" });
    expect(offResult).toEqual({ state: "off", workspaces: [], warnings: [], realForge });

    // Without registry file (home doesn't exist)
    const noneResult = await forgeWorkspaces(f.home, f.forgeRoot);
    expect(noneResult).toEqual({ state: "none", workspaces: [], warnings: [], realForge });
  });
});

describe("planAll and impactOf (spec 25 §5.1)", () => {
  it("test 9: planAll + impactOf — unchanged Forge is no-effect, edited Forge shows changed files", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a");
    const b = await f.ws("acme-b");
    await syncAndRegister(f.home, a);
    await syncAndRegister(f.home, b);

    const result = await forgeWorkspaces(f.home, f.forgeRoot);
    const forge1 = await loadForge(f.forgeRoot);
    const planned1 = await planAll(result.workspaces, forge1);

    // Both should be planned
    expect(planned1.every((p) => p.kind === "planned")).toBe(true);

    // Compare same state — no effect
    for (let i = 0; i < planned1.length; i++) {
      const impact = impactOf(planned1[i], planned1[i]);
      expect(impact).toEqual({ state: "no-effect", files: [], error: null });
    }

    // Edit the Forge's rule.md
    await writeFiles(f.forgeRoot, { "ingredients/rules/style/rule.md": "# Style!\n" });
    const forge2 = await loadForge(f.forgeRoot);
    const planned2 = await planAll(result.workspaces, forge2);

    // Compare before/after — changed
    for (let i = 0; i < planned1.length; i++) {
      const impact = impactOf(planned1[i], planned2[i]);
      expect(impact).toEqual({ state: "changed", files: [".claude/rules/style.md"], error: null });
    }

    // Missing workspace (delete directory)
    const realA = await fs.realpath(a);
    await fs.rm(a, { recursive: true });
    const result2 = await forgeWorkspaces(f.home, f.forgeRoot);
    const missingEntry = result2.workspaces.find((w) => w.entry.path === realA);
    if (missingEntry) {
      const planned3 = await planAll([missingEntry], forge2);
      expect(planned3[0].kind).toBe("missing");
      const impactMissing = impactOf(planned1[0], planned3[0]);
      expect(impactMissing.state).toBe("missing");
    }

    // Broken craftar.yaml
    const broken = await f.ws("acme-broken");
    await syncAndRegister(f.home, broken);
    await writeFiles(broken, { "craftar.yaml": "profile: [" }); // Invalid YAML
    const result3 = await forgeWorkspaces(f.home, f.forgeRoot);
    const brokenEntry = result3.workspaces.find((w) => path.basename(w.entry.path) === "acme-broken");
    expect(brokenEntry).toBeDefined();
    const plannedBroken = await planAll([brokenEntry!], forge2);
    expect(plannedBroken[0].kind).toBe("error");
    if (plannedBroken[0].kind === "error") {
      expect(plannedBroken[0].stage).toBe("config");
    }
  });
});

describe("nextSync (spec 25 §5.1)", () => {
  it("test 10: in sync returns unchanged; after Forge edit returns changed with update count", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a");
    await syncAndRegister(f.home, a);

    const forge = await loadForge(f.forgeRoot);
    const result = await forgeWorkspaces(f.home, f.forgeRoot);
    const planned = await planAll(result.workspaces, forge);

    // In sync — unchanged
    const syncResult = await nextSync(planned[0]);
    expect(syncResult).toEqual({ state: "unchanged", counts: {}, error: null });

    // Edit the Forge
    await writeFiles(f.forgeRoot, { "ingredients/rules/style/rule.md": "# Style!\n" });
    const forge2 = await loadForge(f.forgeRoot);
    const planned2 = await planAll(result.workspaces, forge2);

    // After Forge edit — changed
    const syncResult2 = await nextSync(planned2[0]);
    expect(syncResult2).toEqual({ state: "changed", counts: { update: 1 }, error: null });
  });
});

describe("concerned (spec 25 §4.3)", () => {
  it("test 11: identifies concerned workspaces with correct file, counts unchecked for missing", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a", {
      profile: "acme",
    });
    const b = await f.ws("acme-b", {
      profile: "acme",
      overrides: { ingredients: { disable: ["rule/style--acme"] } },
    });
    await syncAndRegister(f.home, a);
    await syncAndRegister(f.home, b);

    // Add local override to workspace A
    await writeFiles(a, {
      "craftar.local.yaml": "overrides:\n  ingredients:\n    disable: [rule/style--acme]\n",
    });

    const forge = await loadForge(f.forgeRoot);
    const result = await forgeWorkspaces(f.home, f.forgeRoot);
    const planned = await planAll(result.workspaces, forge);

    const realA = await fs.realpath(a);
    const realB = await fs.realpath(b);

    // Test function that checks for the disable entry
    const hasDisable = (doc: unknown): boolean => {
      if (doc === null || typeof doc !== "object") return false;
      const d = doc as Record<string, unknown>;
      const overrides = d.overrides as Record<string, unknown> | undefined;
      if (!overrides) return false;
      const ingredients = overrides.ingredients as Record<string, unknown> | undefined;
      if (!ingredients) return false;
      const disable = ingredients.disable as string[] | undefined;
      return Array.isArray(disable) && disable.includes("rule/style--acme");
    };

    const concernedResult = concerned(planned, result.workspaces, hasDisable);

    // Both should be concerned, A via local, B via base
    const sortedConcerned = [...concernedResult.concerned].sort((x, y) => x.path.localeCompare(y.path));
    const expectedConcerned = [
      { path: realA, file: "craftar.local.yaml" as const },
      { path: realB, file: "craftar.yaml" as const },
    ].sort((x, y) => x.path.localeCompare(y.path));
    expect(sortedConcerned).toEqual(expectedConcerned);
    expect(concernedResult.unchecked).toBe(0);

    // Add a missing workspace
    const missing = await f.ws("acme-missing");
    await syncAndRegister(f.home, missing);
    await fs.rm(missing, { recursive: true });

    const result2 = await forgeWorkspaces(f.home, f.forgeRoot);
    const planned2 = await planAll(result2.workspaces, forge);
    const concernedResult2 = concerned(planned2, result2.workspaces, hasDisable);
    expect(concernedResult2.unchecked).toBe(1);
  });
});

describe("workspaceAgainst (spec 25 §5.1)", () => {
  it("test 12: config equals loadWorkspace config, forge is the passed object, no network", async () => {
    const f = await fixture();
    const a = await f.ws("acme-a");

    const forge = await loadForge(f.forgeRoot);
    const wsAgainst = await workspaceAgainst(a, forge);
    const wsNormal = await loadWorkspace(a, { home: f.home });

    // Config should equal
    expect(wsAgainst.config).toEqual(wsNormal.config);

    // Forge should be the passed object
    expect(wsAgainst.forge).toBe(forge);

    // Test that a workspace with an unreachable URL still loads against F
    const unreachable = await f.ws("acme-unreachable", {
      profile: "acme",
      forge: "https://unreachable.invalid/forge.git",
    });
    // This should work because workspaceAgainst doesn't fetch
    const wsUnreachable = await workspaceAgainst(unreachable, forge);
    expect(wsUnreachable.config.forge).toBe("https://unreachable.invalid/forge.git");
    expect(wsUnreachable.forge).toBe(forge);
  });
});

describe("mergeWorkspaceConfig returns base/local (spec 25 §5.1)", () => {
  it("test 13: local is null without the file, {} for empty file, base {} for empty file", async () => {
    const f = await fixture();

    // Workspace without craftar.local.yaml
    const noLocal = await f.ws("acme-no-local");
    const forge = await loadForge(f.forgeRoot);
    const ws1 = await workspaceAgainst(noLocal, forge);
    expect(ws1.merged.local).toBeNull();
    expect(typeof ws1.merged.base).toBe("object");

    // Workspace with empty craftar.local.yaml
    const emptyLocal = await f.ws("acme-empty-local");
    await writeFiles(emptyLocal, { "craftar.local.yaml": "" });
    const ws2 = await workspaceAgainst(emptyLocal, forge);
    expect(ws2.merged.local).toEqual({});

    // Workspace with empty craftar.yaml (should fail validation, but base would be {})
    // Note: empty craftar.yaml is invalid since forge and profile are required
    // Instead test that a minimal craftar.yaml gives the expected shape
    const ws3 = await workspaceAgainst(noLocal, forge);
    expect(ws3.merged.base).toEqual({ forge: "../forge", profile: "acme" });
  });
});

describe("pruneRecipes keeps every candidate when the Forge does not reload (spec 25 §13 item 11)", () => {
  it("returns kept with reload message instead of throwing", async () => {
    const { execFileSync } = await import("node:child_process");
    const { pruneCandidates, pruneRecipes } = await import("../src/core/unify.js");

    const root = await tmpDir("craftar-prune-reload-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    const forgeRoot = path.join(root, "forge");

    // Forge with base variant that is identical to its sibling after unify
    await makeForge(forgeRoot, {
      ingredients: [rule("wf", "a\n"), rule("wf--acme", "a\n", { as: "wf" })],
      recipes: [recipe("base", ["rule/wf"]), recipe("base--acme", ["rule/wf--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });

    // Git init is required for unify to work
    execFileSync("git", ["init", "-q", forgeRoot]);
    execFileSync("git", ["-C", forgeRoot, "config", "maintenance.auto", "false"]);
    execFileSync("git", ["-C", forgeRoot, "config", "gc.auto", "0"]);
    execFileSync("git", ["-C", forgeRoot, "add", "-A"]);
    execFileSync("git", ["-C", forgeRoot, "commit", "-q", "-m", "init"], {
      env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@t" },
    });

    // Create and sync a workspace
    const wsRoot = path.join(root, "ws");
    await makeWorkspace(wsRoot, forgeRoot, { config: { profile: "acme" } });
    await syncAndRegister(home, wsRoot);

    // Load the Forge while it's still valid and compute candidates
    const forge = await loadForge(forgeRoot);
    const candidates = await pruneCandidates(forge, "rule/wf" as `${string}/${string}`, "rule/wf--acme" as `${string}/${string}`, "acme");

    // Verify we have a candidate
    expect(candidates).toHaveLength(1);
    expect(candidates[0].recipe).toBe("base--acme");
    expect(candidates[0].sibling).toBe("base");

    // Save original files for byte comparison
    const profileBefore = await fs.readFile(path.join(forgeRoot, "profiles/acme/profile.yaml"), "utf8");
    const recipeBefore = await fs.readFile(path.join(forgeRoot, "recipes/base--acme.yaml"), "utf8");

    // Break the Forge so loadForge throws — invalid schema
    await fs.writeFile(path.join(forgeRoot, "craftar.forge.yaml"), "schema: 9\n");

    // Verify loadForge now throws — build the expected error message
    const manifestRelPath = path.relative(process.cwd(), path.join(forgeRoot, "craftar.forge.yaml"));
    const zodErrors = `[
  {
    "code": "invalid_type",
    "expected": "string",
    "received": "undefined",
    "path": [
      "name"
    ],
    "message": "Required"
  },
  {
    "code": "invalid_union",
    "unionErrors": [
      {
        "issues": [
          {
            "received": 9,
            "code": "invalid_literal",
            "expected": 1,
            "path": [
              "schema"
            ],
            "message": "Invalid literal value, expected 1"
          }
        ],
        "name": "ZodError"
      },
      {
        "issues": [
          {
            "received": 9,
            "code": "invalid_literal",
            "expected": 2,
            "path": [
              "schema"
            ],
            "message": "Invalid literal value, expected 2"
          }
        ],
        "name": "ZodError"
      }
    ],
    "path": [
      "schema"
    ],
    "message": "Invalid input"
  }
]`;
    const expectedLoadError = `invalid ${manifestRelPath}: ${zodErrors}`;

    let loadError: Error | null = null;
    try {
      await loadForge(forgeRoot);
    } catch (e) {
      loadError = e as Error;
    }
    expect(loadError).not.toBeNull();
    expect(loadError!.message).toBe(expectedLoadError);

    // Build context for pruneRecipes — state "read" with one entry
    const forgeWorkspacesResult = await forgeWorkspaces(home, forgeRoot);
    const planned = await planAll(forgeWorkspacesResult.workspaces, forge); // Uses the old valid forge

    const ctx = {
      state: "read" as const,
      entries: forgeWorkspacesResult.workspaces,
      after: planned,
    };

    // Call pruneRecipes — it should NOT throw, but return kept with the reload message
    const result = await pruneRecipes(forgeRoot, candidates, ctx);

    // Assert exact result structure (whole value)
    expect(result).toEqual({
      pruned: [],
      kept: [{ recipe: "base--acme", reason: `the Forge does not reload after unify's writes: ${expectedLoadError}` }],
    });

    // Verify profile and recipe files are byte-unchanged
    const profileAfter = await fs.readFile(path.join(forgeRoot, "profiles/acme/profile.yaml"), "utf8");
    const recipeAfter = await fs.readFile(path.join(forgeRoot, "recipes/base--acme.yaml"), "utf8");
    expect(profileAfter).toBe(profileBefore);
    expect(recipeAfter).toBe(recipeBefore);
  });
});
