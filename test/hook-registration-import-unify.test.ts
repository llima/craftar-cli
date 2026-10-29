import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
import YAML from "yaml";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { loadForge, type LoadedIngredient } from "../src/core/forge.js";
import { loadWorkspace, plan, apply, status } from "../src/core/sync.js";
import { metaDifferences } from "../src/core/unify.js";
import { checkParamWrites } from "../src/core/param-writes.js";
import type { Extraction } from "../src/core/extract.js";
import { makeForge, makeWorkspace, profile, recipe, scenario, tmpDir, writeFiles, type IngredientSpec, type ForgeSpec } from "./helpers/forge.js";
import { runCli } from "./helpers/cli.js";

// Spec 43 §7.2 rows 7–11, §8: import, unify, promote carry the registration.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Git environment variables for predictable commits. */
const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "craftar-test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "craftar-test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
});

/** Initialize a git repo with one commit. */
function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "maintenance.auto", "false"]);
  execFileSync("git", ["-C", dir, "config", "gc.auto", "0"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"], { env: gitEnv() });
}

/** Helper for importing. */
const importInto = (forge: string, workspaceRoot: string, profileName: string) =>
  importClaudeCode({ workspaceRoot, forgeRoot: forge, profileName });

/** Hook base B from task spec: has registration citing hooks.python, plus x param in body.
 * Declares targets: ["claude-code"] as an imported hook would (the schema default for import). */
const hookBaseB = (): IngredientSpec => ({
  meta: {
    type: "hook",
    name: "guard-path",
    files: ["guard-path.py"],
    targets: ["claude-code"], // an imported hook gets this default
    params: {
      "hooks.python": { default: "python3" },
      x: { default: "one" },
    },
    registration: [
      {
        event: "PreToolUse",
        command: "{{hooks.python}}",
        args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-path.py"],
      },
    ],
  },
  files: {
    "guard-path.py": "print(\"{{x}}\")\n", // body cites x
  },
});

/** Helper to read YAML file. */
const yaml = async (file: string) => YAML.parse(await fs.readFile(file, "utf8"));

describe("import — hook with registration (spec 43 §7.2 rows 7–11)", () => {
  it("1. import reuses hook when workspace file equals base rendered", async () => {
    // Setup: Forge with hook base B, workspace with .claude/hooks/guard-path.py equal to rendered
    const root = await tmpDir("craftar-import-hook-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeDir = path.join(root, "forge");
    const wsDir = path.join(root, "ws");

    // Create Forge with hook B
    await makeForge(forgeDir, {
      ingredients: [hookBaseB()],
      recipes: [recipe("base", ["hook/guard-path"])],
      profiles: [profile("acme", ["base"])],
    });

    // Create workspace with hook file equal to the rendered version (x=one)
    await writeFiles(wsDir, {
      ".claude/hooks/guard-path.py": "print(\"one\")\n",
    });

    // Import
    const r = await importInto(forgeDir, wsDir, "acme");

    // Should be reused, not variant
    expect(r.reused).toContain("hook/guard-path");
    expect(r.variants.map((v) => v.name)).not.toContain("hook/guard-path--acme");
  });

  it("2. import creates variant with registration from base, carrying only hooks.python (cited by registration)", async () => {
    // Setup: Forge with hook base B, workspace with different hook file
    const root = await tmpDir("craftar-import-hook-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeDir = path.join(root, "forge");
    const wsDir = path.join(root, "ws");

    // Create Forge with hook B
    await makeForge(forgeDir, {
      ingredients: [hookBaseB()],
      recipes: [recipe("base", ["hook/guard-path"])],
      profiles: [profile("acme", ["base"])],
    });

    // Create workspace with hook file that CANNOT be matched through inference
    // (the base template is `print("{{x}}")`, so anything not matching that pattern forces a variant)
    await writeFiles(wsDir, {
      ".claude/hooks/guard-path.py": "# completely different script\nimport sys\n",
    });

    // Import
    const r = await importInto(forgeDir, wsDir, "acme");

    // Should be a variant
    expect(r.variants.map((v) => v.name)).toContain("hook/guard-path--acme");

    // Read the variant's ingredient.yaml
    const variantMeta = await yaml(path.join(forgeDir, "ingredients/hooks/guard-path--acme/ingredient.yaml"));

    // Should have registration equal to base's
    expect(variantMeta.registration).toEqual([
      {
        event: "PreToolUse",
        command: "{{hooks.python}}",
        args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-path.py"],
      },
    ]);

    // Should have ONLY hooks.python in params (cited by registration), NOT x
    expect(variantMeta.params).toEqual({ "hooks.python": { default: "python3" } });

    // Registration should come after files in the YAML
    const rawYaml = await fs.readFile(path.join(forgeDir, "ingredients/hooks/guard-path--acme/ingredient.yaml"), "utf8");
    const filesIndex = rawYaml.indexOf("files:");
    const registrationIndex = rawYaml.indexOf("registration:");
    expect(registrationIndex).toBeGreaterThan(filesIndex);

    // Now plan and verify the example file has rendered command, not {{
    await makeWorkspace(wsDir, forgeDir, { config: { profile: "acme" } });
    const ws = await loadWorkspace(wsDir);
    const p = await plan(ws);

    // Find the example file
    const exampleFile = p.files.find((f) => f.path === ".claude/settings.craftar.example.json");
    expect(exampleFile).toBeDefined();
    const content = JSON.parse(typeof exampleFile!.content === "string" ? exampleFile!.content : exampleFile!.content.toString("utf8"));
    // Should have "command": "python3", not {{hooks.python}}
    expect(content.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command).toBe("python3");
  });

  it("3. rewriting existing variant keeps its own registration (differing from base)", async () => {
    // Setup: Forge with hook base B and existing variant with different registration
    const root = await tmpDir("craftar-import-hook-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeDir = path.join(root, "forge");
    const wsDir = path.join(root, "ws");

    // Create Forge with hook B and existing variant with different registration
    const variantRegistration = [
      {
        event: "PreToolUse",
        matcher: "Bash",
        command: "{{hooks.python}}",
        args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-path.py"],
        timeout: 30,
      },
    ];
    await makeForge(forgeDir, {
      ingredients: [
        hookBaseB(),
        {
          meta: {
            type: "hook",
            name: "guard-path--acme",
            as: "guard-path",
            files: ["guard-path.py"],
            targets: ["claude-code"], // as an import writes
            params: { "hooks.python": { default: "python3" } },
            registration: variantRegistration,
          },
          files: { "guard-path.py": "print(\"old\")\n" },
        },
      ],
      recipes: [recipe("base", ["hook/guard-path"]), recipe("base--acme", ["hook/guard-path--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });

    // Create workspace with hook file that CANNOT be matched through inference
    // (forces a rewrite of the existing variant)
    await writeFiles(wsDir, {
      ".claude/hooks/guard-path.py": "# new script content\nimport os\n",
    });

    // Import
    const r = await importInto(forgeDir, wsDir, "acme");

    // Should still be a variant
    expect(r.variants.map((v) => v.name)).toContain("hook/guard-path--acme");

    // Read the variant's ingredient.yaml - should keep its OWN registration
    const variantMeta = await yaml(path.join(forgeDir, "ingredients/hooks/guard-path--acme/ingredient.yaml"));
    expect(variantMeta.registration).toEqual(variantRegistration);

    // Should still have only hooks.python in params (cited by registration)
    expect(variantMeta.params).toEqual({ "hooks.python": { default: "python3" } });
  });

  it("3b. rewriting existing variant keeps only base's params entries the variant's registration cites", async () => {
    // Setup: Forge with hook base B and existing variant with hooks.python AND unrelated x param
    const root = await tmpDir("craftar-import-hook-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeDir = path.join(root, "forge");
    const wsDir = path.join(root, "ws");

    // Existing variant has registration citing hooks.python, plus an unrelated x param
    const variantRegistration = [
      {
        event: "PreToolUse",
        matcher: "Bash",
        command: "{{hooks.python}}",
        args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-path.py"],
        timeout: 30,
      },
    ];
    await makeForge(forgeDir, {
      ingredients: [
        hookBaseB(),
        {
          meta: {
            type: "hook",
            name: "guard-path--acme",
            as: "guard-path",
            files: ["guard-path.py"],
            targets: ["claude-code"],
            // Existing variant has BOTH hooks.python (cited by registration) AND x (unrelated)
            params: {
              "hooks.python": { default: "python3" },
              x: { default: "old-value" },
            },
            registration: variantRegistration,
          },
          files: { "guard-path.py": "print(\"old\")\n" },
        },
      ],
      recipes: [recipe("base", ["hook/guard-path"]), recipe("base--acme", ["hook/guard-path--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });

    // Create workspace with hook file that forces a rewrite
    await writeFiles(wsDir, {
      ".claude/hooks/guard-path.py": "# completely new script\nimport sys\n",
    });

    // Import (rewrites the existing variant)
    const r = await importInto(forgeDir, wsDir, "acme");

    // Should still be a variant
    expect(r.variants.map((v) => v.name)).toContain("hook/guard-path--acme");

    // Read the variant's ingredient.yaml after rewrite
    const variantMeta = await yaml(path.join(forgeDir, "ingredients/hooks/guard-path--acme/ingredient.yaml"));

    // Should keep the variant's own registration
    expect(variantMeta.registration).toEqual(variantRegistration);

    // After rewrite: params should be ONLY the base's entries for keys the variant's registration cites.
    // The variant's registration cites hooks.python. The base declares hooks.python with default python3.
    // So we should have ONLY hooks.python, NOT x.
    expect(variantMeta.params).toEqual({ "hooks.python": { default: "python3" } });
  });

  it("3c. rewriting existing variant keeps its own params entry when base doesn't declare the key", async () => {
    // Task 12 bug fix: the base declares no params (or a different key), but the existing variant
    // has params declaring hooks.node. The variant's registration cites {{hooks.node}}.
    // After rewrite, the variant should still have hooks.node declared with its own default.
    const root = await tmpDir("craftar-import-hook-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeDir = path.join(root, "forge");
    const wsDir = path.join(root, "ws");

    // Hook base that declares NO params at all
    const hookBaseNoParams: IngredientSpec = {
      meta: {
        type: "hook",
        name: "run-lint",
        files: ["run-lint.sh"],
        targets: ["claude-code"],
        // NO params - the base doesn't declare anything
        registration: [
          {
            event: "PreToolUse",
            matcher: "Edit",
            command: "sh",
            args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/run-lint.sh"],
          },
        ],
      },
      files: { "run-lint.sh": "#!/bin/sh\necho lint\n" },
    };

    // Existing variant that has its OWN registration citing {{hooks.node}}, with params declaring hooks.node
    const variantRegistration = [
      {
        event: "PostToolUse",
        command: "{{hooks.node}}",
        args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/run-lint.sh", "--check"],
      },
    ];
    await makeForge(forgeDir, {
      ingredients: [
        hookBaseNoParams,
        {
          meta: {
            type: "hook",
            name: "run-lint--acme",
            as: "run-lint",
            files: ["run-lint.sh"],
            targets: ["claude-code"],
            // Existing variant declares hooks.node because its registration cites it
            params: { "hooks.node": { default: "node" } },
            registration: variantRegistration,
          },
          files: { "run-lint.sh": "#!/bin/sh\necho old\n" },
        },
      ],
      recipes: [recipe("base", ["hook/run-lint"]), recipe("base--acme", ["hook/run-lint--acme"])],
      profiles: [profile("acme", ["base--acme"])],
    });

    // Create workspace with hook file that differs (forces a rewrite of the existing variant)
    await writeFiles(wsDir, {
      ".claude/hooks/run-lint.sh": "#!/bin/sh\necho new script\n",
    });

    // Import (rewrites the existing variant)
    const r = await importInto(forgeDir, wsDir, "acme");

    // Should still be a variant
    expect(r.variants.map((v) => v.name)).toContain("hook/run-lint--acme");

    // Read the rewritten variant's ingredient.yaml
    const variantMeta = await yaml(path.join(forgeDir, "ingredients/hooks/run-lint--acme/ingredient.yaml"));

    // Should keep the variant's own registration
    expect(variantMeta.registration).toEqual(variantRegistration);

    // CRITICAL: The variant's params should still have hooks.node declared.
    // The variant's registration cites {{hooks.node}}. The base declares no params at all.
    // Per spec §7.2: "take the base's entry when base declares it; otherwise take the existing
    // variant's own entry when the variant declares it; otherwise nothing."
    // So the variant's own declaration of hooks.node should be kept.
    expect(variantMeta.params).toEqual({ "hooks.node": { default: "node" } });

    // Verify sync writes the example file with "node" rendered, not {{hooks.node}}
    await makeWorkspace(wsDir, forgeDir, { config: { profile: "acme" } });
    const ws = await loadWorkspace(wsDir);
    const p = await plan(ws);

    const exampleFile = p.files.find((f) => f.path === ".claude/settings.craftar.example.json");
    expect(exampleFile).toBeDefined();
    const content = JSON.parse(typeof exampleFile!.content === "string" ? exampleFile!.content : exampleFile!.content.toString("utf8"));
    // Should have "command": "node", not {{hooks.node}}
    expect(content.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command).toBe("node");
  });
});

describe("drift promote — hook with registration (spec 43 §7.2 row 10)", () => {
  it("4. drift promote keeps registration and cited params entries", async () => {
    // Setup: Forge with hook base B, sync workspace, hand-edit, promote
    const root = await tmpDir("craftar-promote-hook-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeDir = path.join(root, "forge");
    const wsDir = path.join(root, "ws");

    // Create Forge with hook B
    await makeForge(forgeDir, {
      ingredients: [hookBaseB()],
      recipes: [recipe("base", ["hook/guard-path"])],
      profiles: [profile("acme", ["base"])],
    });
    gitInit(forgeDir);

    // Create and sync workspace
    await makeWorkspace(wsDir, forgeDir, { config: { profile: "acme" } });
    expect(runCli(["sync", "--workspace", wsDir]).code).toBe(0);

    // Hand-edit the hook file
    await fs.appendFile(path.join(wsDir, ".claude/hooks/guard-path.py"), "# hand edit\n");

    // Promote
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-tmp-"));
    cleanups.push(() => fs.rm(tmp, { recursive: true, force: true }));

    const P = ["drift", "promote", ".claude/hooks/guard-path.py", "--workspace", wsDir];
    const r = runCli(P, { env: { TMPDIR: tmp, TEMP: tmp, TMP: tmp } });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hook/guard-path--acme (variant");

    // Read the variant's ingredient.yaml
    const variantMeta = await yaml(path.join(forgeDir, "ingredients/hooks/guard-path--acme/ingredient.yaml"));

    // Should have registration from base
    expect(variantMeta.registration).toEqual([
      {
        event: "PreToolUse",
        command: "{{hooks.python}}",
        args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-path.py"],
      },
    ]);

    // Should have hooks.python in params (cited by registration)
    expect(variantMeta.params).toEqual({ "hooks.python": { default: "python3" } });

    // Proof should pass - the example file should have the same bytes
    expect(r.stdout).toContain("proved");

    // Status should be unchanged
    const st = runCli(["status", "--workspace", wsDir]);
    expect(st.code).toBe(0);
    expect(st.stdout).toContain("unchanged");
  });

  it("4b. drift promote infers profile-params outcome for hook with registration (not a variant)", async () => {
    // Task 10 Item 2: a hook base with registration and params should allow profile-params outcome.
    // The issue: sourceMeta stripped only params, leaving registration, causing fingerprint mismatch.
    const root = await tmpDir("craftar-promote-hook-params-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeDir = path.join(root, "forge");
    const wsDir = path.join(root, "ws");

    // Create hook where the body cites x (not hooks.python), and registration cites hooks.python
    const hookBaseBParamsOnly: IngredientSpec = {
      meta: {
        type: "hook",
        name: "guard-path",
        files: ["guard-path.py"],
        targets: ["claude-code"],
        params: {
          "hooks.python": { default: "python3" },
          x: {}, // no default, profile sets it
        },
        registration: [
          {
            event: "PreToolUse",
            command: "{{hooks.python}}",
            args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-path.py"],
          },
        ],
      },
      files: { "guard-path.py": 'print("{{x}}")\n' }, // body only cites x
    };

    await makeForge(forgeDir, {
      ingredients: [hookBaseBParamsOnly],
      recipes: [recipe("base", ["hook/guard-path"])],
      profiles: [profile("acme", ["base"], ["claude-code"], { params: { x: "one" } })], // profile sets x
    });
    gitInit(forgeDir);

    // Sync workspace
    await makeWorkspace(wsDir, forgeDir, { config: { profile: "acme" } });
    expect(runCli(["sync", "--workspace", wsDir]).code).toBe(0);

    // File should render x=one
    const before = await fs.readFile(path.join(wsDir, ".claude/hooks/guard-path.py"), "utf8");
    expect(before).toBe('print("one")\n');

    // Hand-edit to x=two
    await fs.writeFile(path.join(wsDir, ".claude/hooks/guard-path.py"), 'print("two")\n');

    // Promote — should infer params outcome, NOT create a variant
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-tmp-"));
    cleanups.push(() => fs.rm(tmp, { recursive: true, force: true }));

    const P = ["drift", "promote", ".claude/hooks/guard-path.py", "--workspace", wsDir, "--json"];
    const r = runCli(P, { env: { TMPDIR: tmp, TEMP: tmp, TMP: tmp } });

    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);

    // Should be params outcome, not variant
    expect(out.outcome).toBe("params");
    expect(out.params).toEqual([{ key: "x", old: "one", value: "two" }]);

    // No variant directory should exist
    const variantDir = path.join(forgeDir, "ingredients/hooks/guard-path--acme");
    const variantExists = await fs.stat(variantDir).then(() => true, () => false);
    expect(variantExists).toBe(false);

    // The base's ingredient.yaml should be unchanged (registration still there)
    const baseMetaRaw = await fs.readFile(path.join(forgeDir, "ingredients/hooks/guard-path/ingredient.yaml"), "utf8");
    const baseMeta = YAML.parse(baseMetaRaw);
    expect(baseMeta.registration).toEqual([
      {
        event: "PreToolUse",
        command: "{{hooks.python}}",
        args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-path.py"],
      },
    ]);
    expect(baseMeta.params).toEqual({
      "hooks.python": { default: "python3" },
      x: {},
    });

    // Profile should have x: "two" now
    const profileMeta = await yaml(path.join(forgeDir, "profiles/acme/profile.yaml"));
    expect(profileMeta.params.x).toBe("two");
  });
});

describe("forge unify — take:param refused on registration-cited key (spec 43 §7.2 row 8)", () => {
  it("5. take:param on hooks.python (cited by registration only) is refused", async () => {
    // Setup: Forge with hook base that cites hooks.python ONLY in registration (not in body),
    // and a variant with different value
    const root = await tmpDir("craftar-unify-hook-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeDir = path.join(root, "forge");

    // Create hook where hooks.python is ONLY cited in registration
    const hookBase: IngredientSpec = {
      meta: {
        type: "hook",
        name: "guard",
        files: ["guard.py"],
        params: { "hooks.python": { default: "python3" } },
        registration: [{ event: "PreToolUse", command: "{{hooks.python}}", args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.py"] }],
      },
      files: { "guard.py": "# guard\n" }, // body does NOT cite hooks.python
    };

    // Variant with same body but we'll try to extract the registration key
    const hookVariant: IngredientSpec = {
      meta: {
        type: "hook",
        name: "guard--acme",
        as: "guard",
        files: ["guard.py"],
        params: { "hooks.python": { default: "python3" } },
        registration: [{ event: "PreToolUse", command: "{{hooks.python}}", args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.py"] }],
      },
      files: { "guard.py": "# guard\n" },
    };

    await makeForge(forgeDir, {
      ingredients: [hookBase, hookVariant],
      recipes: [recipe("base", ["hook/guard"]), recipe("base--acme", ["hook/guard--acme"])],
      profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"])],
    });

    const forge = await loadForge(forgeDir);
    const base = forge.ingredients.get("hook/guard")!;
    const variant = forge.ingredients.get("hook/guard--acme")!;

    // Try to extract hooks.python - should be refused because registration cites it
    const ext: Extraction = {
      key: "hooks.python",
      default: "python3",
      value: "python",
      sites: [{ file: "guard.py", hunk: 1 }],
      reused: false,
    };

    await expect(checkParamWrites(forge, base, variant, "acme", [ext])).rejects.toThrow(
      /hook\/guard(--.*)? already uses \{\{hooks\.python\}\}/
    );
  });

  it("5b. take:param on uncited key is allowed", async () => {
    // Setup: hook with registration, but extract a key the registration doesn't cite
    const root = await tmpDir("craftar-unify-hook-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeDir = path.join(root, "forge");

    // Hook with hooks.python in registration and k in body
    const hookBase: IngredientSpec = {
      meta: {
        type: "hook",
        name: "guard",
        files: ["guard.py"],
        params: {
          "hooks.python": { default: "python3" },
          k: { default: "globex-api" },
        },
        registration: [{ event: "PreToolUse", command: "{{hooks.python}}", args: [] }],
      },
      files: { "guard.py": "use globex-api\n" },
    };

    const hookVariant: IngredientSpec = {
      meta: {
        type: "hook",
        name: "guard--acme",
        as: "guard",
        files: ["guard.py"],
        params: { "hooks.python": { default: "python3" }, k: { default: "globex-api" } },
        registration: [{ event: "PreToolUse", command: "{{hooks.python}}", args: [] }],
      },
      files: { "guard.py": "use acme-api\n" },
    };

    await makeForge(forgeDir, {
      ingredients: [hookBase, hookVariant],
      recipes: [recipe("base", ["hook/guard"]), recipe("base--acme", ["hook/guard--acme"])],
      profiles: [profile("acme", ["base--acme"]), profile("globex", ["base"])],
    });

    const forge = await loadForge(forgeDir);
    const base = forge.ingredients.get("hook/guard")!;
    const variant = forge.ingredients.get("hook/guard--acme")!;

    // Try to extract k (not cited by registration) - should be allowed
    const ext: Extraction = {
      key: "k",
      default: "globex-api",
      value: "acme-api",
      sites: [{ file: "guard.py", hunk: 1 }],
      reused: false,
    };

    // This should NOT throw
    const result = await checkParamWrites(forge, base, variant, "acme", [ext]);
    expect(result.ingredientYaml).toBeNull(); // k is already declared
    expect(result.profile).not.toBeNull(); // value goes to profile
  });
});

describe("metaDifferences — hook with registration (spec 43 §7.2 row 9)", () => {
  it("6a. variant with only hooks.python (cited by registration) → no params diff", async () => {
    // Base has hooks.python and x, variant has only hooks.python → metaDifferences returns []
    const root = await tmpDir("craftar-meta-hook-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeDir = path.join(root, "forge");

    const hookBase: IngredientSpec = {
      meta: {
        type: "hook",
        name: "guard",
        files: ["guard.py"],
        params: {
          "hooks.python": { default: "python3" },
          x: { default: "one" },
        },
        registration: [{ event: "PreToolUse", command: "{{hooks.python}}", args: [] }],
      },
      files: { "guard.py": "print(\"{{x}}\")\n" },
    };

    // Variant has ONLY hooks.python (the registration-cited param)
    const hookVariant: IngredientSpec = {
      meta: {
        type: "hook",
        name: "guard--acme",
        as: "guard",
        files: ["guard.py"],
        params: { "hooks.python": { default: "python3" } },
        registration: [{ event: "PreToolUse", command: "{{hooks.python}}", args: [] }],
      },
      files: { "guard.py": "print(\"two\")\n" },
    };

    await makeForge(forgeDir, {
      ingredients: [hookBase, hookVariant],
      recipes: [recipe("base", ["hook/guard"])],
      profiles: [profile("acme", ["base"])],
    });

    const forge = await loadForge(forgeDir);
    const base = forge.ingredients.get("hook/guard")!;
    const variant = forge.ingredients.get("hook/guard--acme")!;

    // Should NOT report params as different
    const diffs = metaDifferences(base, variant);
    expect(diffs).not.toContain("params");
  });

  it("6b. variant declaring x with different default → params diff", async () => {
    const root = await tmpDir("craftar-meta-hook-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeDir = path.join(root, "forge");

    const hookBase: IngredientSpec = {
      meta: {
        type: "hook",
        name: "guard",
        files: ["guard.py"],
        params: {
          "hooks.python": { default: "python3" },
          x: { default: "one" },
        },
        registration: [{ event: "PreToolUse", command: "{{hooks.python}}", args: [] }],
      },
      files: { "guard.py": "print(\"{{x}}\")\n" },
    };

    // Variant declares x with DIFFERENT default
    const hookVariant: IngredientSpec = {
      meta: {
        type: "hook",
        name: "guard--acme",
        as: "guard",
        files: ["guard.py"],
        params: {
          "hooks.python": { default: "python3" },
          x: { default: "two" }, // Different!
        },
        registration: [{ event: "PreToolUse", command: "{{hooks.python}}", args: [] }],
      },
      files: { "guard.py": "print(\"two\")\n" },
    };

    await makeForge(forgeDir, {
      ingredients: [hookBase, hookVariant],
      recipes: [recipe("base", ["hook/guard"])],
      profiles: [profile("acme", ["base"])],
    });

    const forge = await loadForge(forgeDir);
    const base = forge.ingredients.get("hook/guard")!;
    const variant = forge.ingredients.get("hook/guard--acme")!;

    // SHOULD report params as different
    const diffs = metaDifferences(base, variant);
    expect(diffs).toContain("params");
  });

  it("6c. variant with different registration → registration diff", async () => {
    const root = await tmpDir("craftar-meta-hook-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeDir = path.join(root, "forge");

    const hookBase: IngredientSpec = {
      meta: {
        type: "hook",
        name: "guard",
        files: ["guard.py"],
        registration: [{ event: "PreToolUse", command: "python3", args: [] }],
      },
      files: { "guard.py": "# guard\n" },
    };

    // Variant has different registration
    const hookVariant: IngredientSpec = {
      meta: {
        type: "hook",
        name: "guard--acme",
        as: "guard",
        files: ["guard.py"],
        registration: [{ event: "PreToolUse", command: "python", args: [], timeout: 30 }], // Different!
      },
      files: { "guard.py": "# guard\n" },
    };

    await makeForge(forgeDir, {
      ingredients: [hookBase, hookVariant],
      recipes: [recipe("base", ["hook/guard"])],
      profiles: [profile("acme", ["base"])],
    });

    const forge = await loadForge(forgeDir);
    const base = forge.ingredients.get("hook/guard")!;
    const variant = forge.ingredients.get("hook/guard--acme")!;

    // SHOULD report registration as different
    const diffs = metaDifferences(base, variant);
    expect(diffs).toContain("registration");
  });

  it("6d. variant with no params at all under base whose registration cites declared key → params diff", async () => {
    const root = await tmpDir("craftar-meta-hook-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeDir = path.join(root, "forge");

    // Base declares hooks.python AND registration cites it
    const hookBase: IngredientSpec = {
      meta: {
        type: "hook",
        name: "guard",
        files: ["guard.py"],
        params: { "hooks.python": { default: "python3" } },
        registration: [{ event: "PreToolUse", command: "{{hooks.python}}", args: [] }],
      },
      files: { "guard.py": "# guard\n" },
    };

    // Variant has NO params at all
    const hookVariant: IngredientSpec = {
      meta: {
        type: "hook",
        name: "guard--acme",
        as: "guard",
        files: ["guard.py"],
        // NO params
        registration: [{ event: "PreToolUse", command: "{{hooks.python}}", args: [] }],
      },
      files: { "guard.py": "# guard\n" },
    };

    await makeForge(forgeDir, {
      ingredients: [hookBase, hookVariant],
      recipes: [recipe("base", ["hook/guard"])],
      profiles: [profile("acme", ["base"])],
    });

    const forge = await loadForge(forgeDir);
    const base = forge.ingredients.get("hook/guard")!;
    const variant = forge.ingredients.get("hook/guard--acme")!;

    // SHOULD report params as different (like MCP: the declaration decides the example file's bytes)
    const diffs = metaDifferences(base, variant);
    expect(diffs).toContain("params");
  });
});

describe("import F9 — delta on key cited by another hook's registration (spec 43 §7.2 row 8)", () => {
  it("7. setting hooks.python would change another hook → variant", async () => {
    // Setup: two hooks, one's body can infer hooks.python, another's registration cites it
    const root = await tmpDir("craftar-import-f9-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forgeDir = path.join(root, "forge");
    const wsDir = path.join(root, "ws");

    // Hook A: declares hooks.python with default, body uses the placeholder
    const hookA: IngredientSpec = {
      meta: {
        type: "hook",
        name: "hook-a",
        files: ["hook-a.py"],
        targets: ["claude-code"], // as an import writes
        params: { "hooks.python": { default: "python3" } },
        // NO registration
      },
      files: { "hook-a.py": "#!/usr/bin/env {{hooks.python}}\n" },  // Uses the placeholder
    };

    // Hook B: registration cites hooks.python (declared)
    const hookB: IngredientSpec = {
      meta: {
        type: "hook",
        name: "hook-b",
        files: ["hook-b.py"],
        targets: ["claude-code"], // as an import writes
        params: { "hooks.python": { default: "python3" } },
        registration: [{ event: "PreToolUse", command: "{{hooks.python}}", args: [] }],
      },
      files: { "hook-b.py": "# hook b\n" },
    };

    await makeForge(forgeDir, {
      ingredients: [hookA, hookB],
      recipes: [recipe("base", ["hook/hook-a", "hook/hook-b"])],
      profiles: [profile("acme", ["base"])],
    });

    // Create workspace with hook-a implying a different value for hooks.python
    await writeFiles(wsDir, {
      ".claude/hooks/hook-a.py": "#!/usr/bin/env python\n", // Would infer hooks.python = python
      ".claude/hooks/hook-b.py": "# hook b\n",
    });

    // Import
    const r = await importInto(forgeDir, wsDir, "acme");

    // hook-a should become a variant because setting hooks.python would change hook-b
    expect(r.variants.some((v) => v.name === "hook/hook-a--acme")).toBe(true);
    const variant = r.variants.find((v) => v.name === "hook/hook-a--acme");
    expect(variant?.reason).toContain("setting hooks.python would change hook/hook-b");
  });
});
