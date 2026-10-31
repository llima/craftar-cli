import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { loadWorkspace, plan, status, apply, readLock } from "../src/core/sync.js";
import { listVariants } from "../src/core/variants.js";
import { loadForge } from "../src/core/forge.js";
import { tmpDir, writeFiles, profile, recipe } from "./helpers/forge.js";

/**
 * Import reuse tests for 0.40.1 tech debt fixes.
 * script/hook bases with default targets reused when source has targets: ["claude-code"]
 * MCP variants carry base's authEnv
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("script and hook bases with default targets are reused", () => {
  describe("a hook base with default targets is reused when the source is at [\"claude-code\"]", () => {
    it("hook base at targets: '*' is reused, not made a variant", async () => {
      const root = await tmpDir("craftar-import-hook-targets-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      // Forge with hook ingredient that has NO targets key (defaults to "*")
      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 1 }),
        "ingredients/hooks/h/ingredient.yaml": YAML.stringify({
          type: "hook",
          name: "h",
          files: ["h.sh"],
          // No targets key — defaults to "*"
        }),
        "ingredients/hooks/h/h.sh": "#!/bin/bash\necho hello\n",
        "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["hook/h"] }),
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code"] }),
      });

      // Workspace with identical hook file
      await writeFiles(wsRoot, {
        "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
        ".claude/hooks/h.sh": "#!/bin/bash\necho hello\n",
      });

      // Import into the Forge
      const result = await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot,
        profileName: "acme",
      });

      // The hook should be reused, not turned into a variant
      expect(result.reused).toContain("hook/h");
      expect(result.variants.map((v) => v.name)).not.toContain("hook/h--acme");
      expect(result.created.filter((c) => c.includes("hook/h"))).toEqual([]);
    });
  });

  describe("a script base with default targets is reused when the source is at [\"claude-code\"]", () => {
    it("script base at targets: '*' is reused, not made a variant", async () => {
      const root = await tmpDir("craftar-import-script-targets-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      // Forge with script ingredient that has NO targets key (defaults to "*")
      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 1 }),
        "ingredients/scripts/deploy/ingredient.yaml": YAML.stringify({
          type: "script",
          name: "deploy",
          files: ["deploy.sh"],
          // No targets key — defaults to "*"
        }),
        "ingredients/scripts/deploy/deploy.sh": "#!/bin/bash\necho deploying\n",
        "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["script/deploy"] }),
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code"] }),
      });

      // Workspace with identical script file
      await writeFiles(wsRoot, {
        "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
        ".claude/scripts/deploy.sh": "#!/bin/bash\necho deploying\n",
      });

      // Import into the Forge
      const result = await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot,
        profileName: "acme",
      });

      // The script should be reused, not turned into a variant
      expect(result.reused).toContain("script/deploy");
      expect(result.variants.map((v) => v.name)).not.toContain("script/deploy--acme");
      expect(result.created.filter((c) => c.includes("script/deploy"))).toEqual([]);
    });
  });

  describe("controls that must pass before and after", () => {
    it("base at ['kiro'] stays a variant when source has ['claude-code']", async () => {
      const root = await tmpDir("craftar-import-hook-kiro-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      // Forge with hook that has targets: ["kiro"]
      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 1 }),
        "ingredients/hooks/h/ingredient.yaml": YAML.stringify({
          type: "hook",
          name: "h",
          files: ["h.sh"],
          targets: ["kiro"], // Different from ["claude-code"]
        }),
        "ingredients/hooks/h/h.sh": "#!/bin/bash\necho hello\n",
        "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["hook/h"] }),
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code"] }),
      });

      // Workspace with identical hook file (but import builds source at ["claude-code"])
      await writeFiles(wsRoot, {
        "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
        ".claude/hooks/h.sh": "#!/bin/bash\necho hello\n",
      });

      // Import into the Forge
      const result = await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot,
        profileName: "acme",
      });

      // The hook should be a variant because targets differ
      expect(result.variants.map((v) => v.name)).toContain("hook/h--acme");
      expect(result.reused).not.toContain("hook/h");
    });

    it("differing file content stays a variant", async () => {
      const root = await tmpDir("craftar-import-hook-diff-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      // Forge with hook
      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 1 }),
        "ingredients/hooks/h/ingredient.yaml": YAML.stringify({
          type: "hook",
          name: "h",
          files: ["h.sh"],
        }),
        "ingredients/hooks/h/h.sh": "#!/bin/bash\necho hello\n",
        "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["hook/h"] }),
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code"] }),
      });

      // Workspace with DIFFERENT hook file content
      await writeFiles(wsRoot, {
        "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
        ".claude/hooks/h.sh": "#!/bin/bash\necho different\n",
      });

      // Import into the Forge
      const result = await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot,
        profileName: "acme",
      });

      // The hook should be a variant because files differ
      expect(result.variants.map((v) => v.name)).toContain("hook/h--acme");
      expect(result.reused).not.toContain("hook/h");
    });

    it("a hook base at the default targets citing a key a recipe defaults is reused from a source holding it verbatim", async () => {
      const root = await tmpDir("craftar-import-hook-literal-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 1 }),
        "ingredients/hooks/h/ingredient.yaml": YAML.stringify({ type: "hook", name: "h", files: ["h.sh"] }),
        "ingredients/hooks/h/h.sh": "echo {{k}}\n",
        "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["hook/h"], params: { k: { default: "v" } } }),
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code"] }),
      });
      await writeFiles(wsRoot, {
        "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
        ".claude/hooks/h.sh": "echo {{k}}\n",
      });

      const result = await importClaudeCode({ workspaceRoot: wsRoot, forgeRoot, profileName: "acme" });

      expect(result.reused).toContain("hook/h");
      expect(result.variants).toEqual([]);
    });

    it("a rule with default targets versus ['claude-code'] metadata is unaffected (rules always compared with body)", async () => {
      const root = await tmpDir("craftar-import-rule-targets-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      // Forge with rule that has NO targets key (defaults to "*")
      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 1 }),
        "ingredients/rules/workflow/ingredient.yaml": YAML.stringify({
          type: "rule",
          name: "workflow",
          file: "rule.md",
          inclusion: "always",
          // No targets key — defaults to "*"
        }),
        "ingredients/rules/workflow/rule.md": "# Workflow\nDo the thing.\n",
        "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["rule/workflow"] }),
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code"] }),
      });

      // Workspace with same rule
      await writeFiles(wsRoot, {
        "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
        ".claude/rules/workflow.md": "# Workflow\nDo the thing.\n",
      });

      // Import into the Forge
      const result = await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot,
        profileName: "acme",
      });

      // Only a script or a hook reads "*" as ["claude-code"]: a rule's outcome stays what it was before 0.40.1.
      expect(result.rejected).toEqual([]);
      expect(result.reused).toEqual(["rule/workflow"]);
      expect(result.variants).toEqual([]);
    });
  });

  describe("forge variants reports a targets difference for hook", () => {
    it("variants report shows targets difference for hook", async () => {
      const root = await tmpDir("craftar-forge-variants-targets-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");

      // Forge with base hook (no targets) and variant (targets: ["kiro"])
      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 1 }),
        "ingredients/hooks/h/ingredient.yaml": YAML.stringify({
          type: "hook",
          name: "h",
          files: ["h.sh"],
          // No targets — defaults to "*"
        }),
        "ingredients/hooks/h/h.sh": "#!/bin/bash\necho hello\n",
        "ingredients/hooks/h--acme/ingredient.yaml": YAML.stringify({
          type: "hook",
          name: "h--acme",
          as: "h",
          files: ["h.sh"],
          targets: ["kiro"], // Different targets
        }),
        "ingredients/hooks/h--acme/h.sh": "#!/bin/bash\necho hello\n", // Same file content
        "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["hook/h"] }),
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code"] }),
      });

      // Load forge and check variants
      const forge = await loadForge(forgeRoot);
      const variants = await listVariants(forge);

      // Should report a variant with sameBodyDifferentMeta
      expect(variants.groups).toHaveLength(1);
      expect(variants.groups[0].base).toBe("hook/h");
      expect(variants.groups[0].variants[0].distance.sameBodyDifferentMeta).toBe(true);
    });
  });

  describe("status warns when a hook has no Kiro equivalent", () => {
    it("status warns that hook/h has no Kiro equivalent when kiro target is present", async () => {
      const root = await tmpDir("craftar-status-hook-skip-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      // Forge with hook (defaults to "*", which includes kiro as potential target)
      // But hooks are unsupported on kiro
      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 1 }),
        "ingredients/hooks/h/ingredient.yaml": YAML.stringify({
          type: "hook",
          name: "h",
          files: ["h.sh"],
        }),
        "ingredients/hooks/h/h.sh": "#!/bin/bash\necho hello\n",
        "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["hook/h"] }),
        "profiles/acme/profile.yaml": YAML.stringify({
          name: "acme",
          recipes: ["base"],
          targets: ["claude-code", "kiro"], // Both targets
        }),
      });

      // Workspace
      await writeFiles(wsRoot, {
        "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme", targets: ["claude-code", "kiro"] }),
      });

      // Run plan/status
      const ws = await loadWorkspace(wsRoot);
      const p = await plan(ws);

      // Should have warning about kiro not supporting hooks
      const hookSkipWarning = p.warnings.find((w) => w.includes("kiro") && w.includes("hook") && w.includes("skipped"));
      expect(hookSkipWarning).toBeDefined();
      expect(hookSkipWarning).toContain("kiro: hook hook/h has no Kiro equivalent");
    });
  });
});

describe("a new MCP variant keeps the base's authEnv", () => {
  describe("new MCP variant carries the base's authEnv names", () => {
    it("MCP variant created inherits base authEnv", async () => {
      const root = await tmpDir("craftar-import-mcp-authenv-g1-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      // Forge with MCP base that has authEnv, and a recipe that defaults a key the server cites
      // This triggers a recipe default the render cannot see
      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 4 }),
        "ingredients/mcp/srv/ingredient.yaml": YAML.stringify({
          type: "mcp",
          name: "srv",
          server: { command: "npx", args: ["-y", "some-server"], env: { ORG: "{{org}}" } },
          authEnv: ["SECRET_TOKEN", "API_KEY"],
          params: { org: { description: "The org" } },
        }),
        "recipes/base.yaml": YAML.stringify({
          name: "base",
          ingredients: ["mcp/srv"],
          params: { org: { default: "acme-corp" } }, // G1: recipe defaults the key
        }),
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code"] }),
      });

      // Workspace with different MCP server (will become variant)
      // Need .claude directory for import to work
      await writeFiles(wsRoot, {
        "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
        ".claude/rules/workflow.md": "# Workflow\n", // Need at least one claude file
        ".mcp.json": JSON.stringify({
          mcpServers: {
            srv: { command: "npx", args: ["-y", "different-server"] },
          },
        }),
      });

      // Import — should create variant
      const result = await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot,
        profileName: "acme",
      });

      // The MCP should become a variant
      expect(result.variants.map((v) => v.name)).toContain("mcp/srv--acme");

      // The variant should carry the base's authEnv
      const variantMeta = YAML.parse(
        await fs.readFile(path.join(forgeRoot, "ingredients/mcp/srv--acme/ingredient.yaml"), "utf8"),
      );
      expect(variantMeta.authEnv).toEqual(["SECRET_TOKEN", "API_KEY"]);
    });
  });

  describe("the next plan for that profile writes .claude/settings.craftar.example.json listing authEnv names", () => {
    it("settings example file lists the authEnv names from the variant", async () => {
      const root = await tmpDir("craftar-import-mcp-settings-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      // Forge at schema 4 with MCP that has authEnv
      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 4 }),
        "ingredients/mcp/srv/ingredient.yaml": YAML.stringify({
          type: "mcp",
          name: "srv",
          server: { command: "npx", args: ["-y", "some-server"] },
          authEnv: ["SECRET_TOKEN", "API_KEY"],
        }),
        "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["mcp/srv"] }),
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code"] }),
      });

      // Workspace
      await writeFiles(wsRoot, {
        "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
      });

      // Run plan
      const ws = await loadWorkspace(wsRoot);
      const p = await plan(ws);

      // Find the settings example file
      const settingsExample = p.files.find((f) => f.path === ".claude/settings.craftar.example.json");
      expect(settingsExample).toBeDefined();

      // Parse and check it lists the authEnv names
      const settings = JSON.parse(settingsExample!.content.toString("utf8"));
      expect(settings.env).toBeDefined();
      expect(settings.env.SECRET_TOKEN).toBeDefined();
      expect(settings.env.API_KEY).toBeDefined();
    });
  });

  describe("a rewritten variant keeps its own authEnv, not base's", () => {
    it("rewriting existing variant preserves its authEnv, not base's", async () => {
      const root = await tmpDir("craftar-import-mcp-rewrite-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      // Forge with base and existing variant with different authEnv
      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 4 }),
        "ingredients/mcp/srv/ingredient.yaml": YAML.stringify({
          type: "mcp",
          name: "srv",
          server: { command: "npx", args: ["-y", "base-server"] },
          authEnv: ["BASE_TOKEN"],
        }),
        "ingredients/mcp/srv--acme/ingredient.yaml": YAML.stringify({
          type: "mcp",
          name: "srv--acme",
          as: "srv",
          server: { command: "npx", args: ["-y", "acme-server"] },
          authEnv: ["ACME_TOKEN", "ACME_SECRET"], // Different from base
        }),
        "recipes/base.yaml": YAML.stringify({ name: "base", ingredients: ["mcp/srv"] }),
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code"] }),
      });

      // Workspace with yet another server (will rewrite the variant)
      // Need .claude directory for import to work
      await writeFiles(wsRoot, {
        "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
        ".claude/rules/workflow.md": "# Workflow\n",
        ".mcp.json": JSON.stringify({
          mcpServers: {
            srv: { command: "npx", args: ["-y", "new-acme-server"] },
          },
        }),
      });

      // Import — should update the existing variant
      const result = await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot,
        profileName: "acme",
      });

      // The variant should be updated
      expect(result.variants.map((v) => v.name)).toContain("mcp/srv--acme");

      // The variant should keep its own authEnv, not base's
      const variantMeta = YAML.parse(
        await fs.readFile(path.join(forgeRoot, "ingredients/mcp/srv--acme/ingredient.yaml"), "utf8"),
      );
      expect(variantMeta.authEnv).toEqual(["ACME_TOKEN", "ACME_SECRET"]);
    });
  });

  describe("a base with no authEnv adds no authEnv key to its variant", () => {
    it("variant from base without authEnv has no authEnv key", async () => {
      const root = await tmpDir("craftar-import-mcp-no-authenv-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeRoot = path.join(root, "forge");
      const wsRoot = path.join(root, "ws");

      // Forge with MCP base that has NO authEnv, triggering a recipe default not visible to render
      await writeFiles(forgeRoot, {
        "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: 4 }),
        "ingredients/mcp/srv/ingredient.yaml": YAML.stringify({
          type: "mcp",
          name: "srv",
          server: { command: "npx", args: ["-y", "some-server"], env: { ORG: "{{org}}" } },
          params: { org: { description: "The org" } },
          // No authEnv
        }),
        "recipes/base.yaml": YAML.stringify({
          name: "base",
          ingredients: ["mcp/srv"],
          params: { org: { default: "acme-corp" } }, // Triggers a recipe default not visible to render
        }),
        "profiles/acme/profile.yaml": YAML.stringify({ name: "acme", recipes: ["base"], targets: ["claude-code"] }),
      });

      // Workspace with different server
      // Need .claude directory for import to work
      await writeFiles(wsRoot, {
        "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme" }),
        ".claude/rules/workflow.md": "# Workflow\n",
        ".mcp.json": JSON.stringify({
          mcpServers: {
            srv: { command: "npx", args: ["-y", "different-server"] },
          },
        }),
      });

      // Import
      const result = await importClaudeCode({
        workspaceRoot: wsRoot,
        forgeRoot,
        profileName: "acme",
      });

      // The variant should be created
      expect(result.variants.map((v) => v.name)).toContain("mcp/srv--acme");

      // The variant should NOT have authEnv key
      const variantMeta = YAML.parse(
        await fs.readFile(path.join(forgeRoot, "ingredients/mcp/srv--acme/ingredient.yaml"), "utf8"),
      );
      expect(variantMeta.authEnv).toBeUndefined();
    });
  });
});
