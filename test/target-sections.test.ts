import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { runCli } from "./helpers/cli.js";
import { acmeSections } from "./helpers/target-sections.js";
import { profile, recipe, scenario } from "./helpers/forge.js";
import { loadWorkspace, plan } from "../src/core/sync.js";

/**
 * Spec 41 Part B §11.5: target-scoped sections — tests for the plan behaviour.
 */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends { cleanup: () => Promise<unknown> }>(s: T): T => (cleanups.push(s.cleanup), s);

/** Section markers */
const O = (name: string, targets: string) => `<!-- craftar:section ${name} targets=${targets} -->`;
const OPEN = (name: string) => `<!-- craftar:section ${name} -->`;
const CLOSE = "<!-- /craftar:section -->";

describe("target-scoped sections (spec 41 Part B)", () => {
  describe("file content projection", () => {
    it(".claude/rules/style.md holds only's value, not kiro-note's default; .kiro/steering/style.md the reverse", async () => {
      // rule/style with two targeted sections:
      // - only (targets=claude-code): profile sets value
      // - kiro-note (targets=kiro): uses default
      const styleBody = [
        "# Style Guide",
        "",
        O("only", "claude-code"),
        "default only",
        CLOSE,
        "",
        "Middle text.",
        "",
        O("kiro-note", "kiro"),
        "default kiro-note",
        CLOSE,
        "",
        "End.",
      ].join("\n") + "\n";

      const s = kept(await scenario(
        {
          ingredients: [
            {
              meta: { type: "rule", name: "style" },
              files: { "rule.md": styleBody },
            },
          ],
          recipes: [recipe("base", ["rule/style"])],
          profiles: [
            profile("acme", ["base"], ["claude-code", "kiro", "agents-md"], {
              sections: { "rule/style": { only: "profile only value\n" } },
            }),
          ],
        },
        { config: { profile: "acme" } },
      ));
      await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test", schema: 6 }));

      const ws = await loadWorkspace(s.wsRoot);
      const p = await plan(ws);

      // Find the files
      const claudeFile = p.files.find((f) => f.path === ".claude/rules/style.md");
      const kiroFile = p.files.find((f) => f.path === ".kiro/steering/style.md");
      const agentsFile = p.files.find((f) => f.path === "AGENTS.md");

      expect(claudeFile).toBeDefined();
      expect(kiroFile).toBeDefined();
      expect(agentsFile).toBeDefined();

      const claudeText = claudeFile!.content.toString("utf8");
      const kiroText = kiroFile!.content.toString("utf8");
      const agentsText = agentsFile!.content.toString("utf8");

      // .claude/rules/style.md: holds only's profile value, not kiro-note
      expect(claudeText).toContain("profile only value");
      expect(claudeText).not.toContain("default only");
      expect(claudeText).not.toContain("default kiro-note");
      expect(claudeText).not.toContain("kiro-note");

      // .kiro/steering/style.md: holds kiro-note's default, not only
      expect(kiroText).toContain("default kiro-note");
      expect(kiroText).not.toContain("profile only value");
      expect(kiroText).not.toContain("default only");

      // AGENTS.md: neither section
      expect(agentsText).not.toContain("default only");
      expect(agentsText).not.toContain("profile only value");
      expect(agentsText).not.toContain("default kiro-note");

      // No marker lines in any file
      expect(claudeText).not.toContain("craftar:section");
      expect(kiroText).not.toContain("craftar:section");
      expect(agentsText).not.toContain("craftar:section");

      // Blank-line rule: "between blank lines" case - each file should have proper structure
      // The section removals should collapse blank lines properly
    });

    it("explain lists only sections the file's target receives", async () => {
      // Same fixture as above: rule/style with only (targets=claude-code) and kiro-note (targets=kiro)
      const styleBody = [
        "# Style Guide",
        "",
        O("only", "claude-code"),
        "default only",
        CLOSE,
        "",
        "Middle text.",
        "",
        O("kiro-note", "kiro"),
        "default kiro-note",
        CLOSE,
        "",
        "End.",
      ].join("\n") + "\n";

      const s = kept(await scenario(
        {
          ingredients: [
            {
              meta: { type: "rule", name: "style" },
              files: { "rule.md": styleBody },
            },
          ],
          recipes: [recipe("base", ["rule/style"])],
          profiles: [
            profile("acme", ["base"], ["claude-code", "kiro"], {
              sections: { "rule/style": { only: "profile only value\n" } },
            }),
          ],
        },
        { config: { profile: "acme" } },
      ));
      await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test", schema: 6 }));

      // Run sync first to create files
      expect(runCli(["sync"], { cwd: s.wsRoot }).code).toBe(0);

      // explain .kiro/steering/style.md should list kiro-note but not only
      const kiroExplain = runCli(["explain", ".kiro/steering/style.md"], { cwd: s.wsRoot });
      expect(kiroExplain.code, `stderr: ${kiroExplain.stderr}`).toBe(0);
      // The sections line shows "kiro-note (default)" - not "only"
      expect(kiroExplain.stdout).toContain("kiro-note (default)");
      expect(kiroExplain.stdout).not.toContain("only (");

      // explain .claude/rules/style.md should list only but not kiro-note
      const claudeExplain = runCli(["explain", ".claude/rules/style.md"], { cwd: s.wsRoot });
      expect(claudeExplain.code, `stderr: ${claudeExplain.stderr}`).toBe(0);
      // The sections line shows "only (profile acme)" - not "kiro-note"
      expect(claudeExplain.stdout).toContain("only (profile acme)");
      expect(claudeExplain.stdout).not.toContain("kiro-note (");
    });

    it("a section targets=agents-md reaches AGENTS.md only", async () => {
      const styleBody = [
        "# Style",
        "",
        O("md-only", "agents-md"),
        "agents-md content",
        CLOSE,
        "",
        "End.",
      ].join("\n") + "\n";

      const s = kept(await scenario(
        {
          ingredients: [
            { meta: { type: "rule", name: "style" }, files: { "rule.md": styleBody } },
          ],
          recipes: [recipe("base", ["rule/style"])],
          profiles: [profile("acme", ["base"], ["claude-code", "kiro", "agents-md"])],
        },
        { config: { profile: "acme" } },
      ));
      await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test", schema: 6 }));

      const ws = await loadWorkspace(s.wsRoot);
      const p = await plan(ws);

      const claudeText = p.files.find((f) => f.path === ".claude/rules/style.md")!.content.toString("utf8");
      const kiroText = p.files.find((f) => f.path === ".kiro/steering/style.md")!.content.toString("utf8");
      const agentsText = p.files.find((f) => f.path === "AGENTS.md")!.content.toString("utf8");

      // Only AGENTS.md has the section content
      expect(agentsText).toContain("agents-md content");
      expect(claudeText).not.toContain("agents-md content");
      expect(kiroText).not.toContain("agents-md content");
    });
  });

  describe("unset param in targeted section", () => {
    it("{{k}} declared with no default, cited only inside O(x,kiro): with targets [claude-code] sync is not refused", async () => {
      const styleBody = [
        "# Style",
        "",
        O("x", "kiro"),
        "Value: {{k}}",
        CLOSE,
        "",
        "End.",
      ].join("\n") + "\n";

      const s = kept(await scenario(
        {
          ingredients: [
            {
              meta: { type: "rule", name: "style", params: { k: {} } }, // declared with no default
              files: { "rule.md": styleBody },
            },
          ],
          recipes: [recipe("base", ["rule/style"])],
          profiles: [profile("acme", ["base"], ["claude-code"])], // only claude-code
        },
        { config: { profile: "acme" } },
      ));
      await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test", schema: 6 }));

      // With [claude-code] only, sync should succeed ({{k}} is only in kiro section)
      const r = runCli(["sync"], { cwd: s.wsRoot });
      expect(r.code).toBe(0);
    });

    it("{{k}} declared with no default, cited only inside O(x,kiro): with targets [kiro] sync is refused", async () => {
      const styleBody = [
        "# Style",
        "",
        O("x", "kiro"),
        "Value: {{k}}",
        CLOSE,
        "",
        "End.",
      ].join("\n") + "\n";

      const s = kept(await scenario(
        {
          ingredients: [
            {
              meta: { type: "rule", name: "style", params: { k: {} } }, // declared with no default
              files: { "rule.md": styleBody },
            },
          ],
          recipes: [recipe("base", ["rule/style"])],
          profiles: [profile("acme", ["base"], ["kiro"])], // only kiro
        },
        { config: { profile: "acme" } },
      ));
      await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test", schema: 6 }));

      // With [kiro] only, sync should be refused ({{k}} is cited in kiro section)
      const r = runCli(["sync"], { cwd: s.wsRoot });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("declared parameter");
    });
  });

  describe("edge case 14: section reaches no target", () => {
    it("rule targets: [claude-code] with O(x,kiro) → exactly that one warning", async () => {
      const styleBody = [
        "# Style",
        "",
        O("x", "kiro"),
        "kiro content",
        CLOSE,
        "",
        "End.",
      ].join("\n") + "\n";

      const s = kept(await scenario(
        {
          ingredients: [
            {
              meta: { type: "rule", name: "style", targets: ["claude-code"] }, // only claude-code
              files: { "rule.md": styleBody },
            },
          ],
          recipes: [recipe("base", ["rule/style"])],
          profiles: [profile("acme", ["base"], ["claude-code", "kiro"])],
        },
        { config: { profile: "acme" } },
      ));
      await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test", schema: 6 }));

      const r = runCli(["status", "--json"], { cwd: s.wsRoot });
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout);
      // Exactly one warning about section x reaching no target
      const warnings = json.warnings.filter((w: string) => w.includes("section x reaches no target"));
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("rule/style rule.md");
      expect(warnings[0]).toContain("targets=kiro");
    });

    it("the same section in a rule with targets: \"*\" → no warning", async () => {
      const styleBody = [
        "# Style",
        "",
        O("x", "kiro"),
        "kiro content",
        CLOSE,
        "",
        "End.",
      ].join("\n") + "\n";

      const s = kept(await scenario(
        {
          ingredients: [
            {
              meta: { type: "rule", name: "style", targets: "*" }, // all targets
              files: { "rule.md": styleBody },
            },
          ],
          recipes: [recipe("base", ["rule/style"])],
          profiles: [profile("acme", ["base"], ["claude-code", "kiro"])],
        },
        { config: { profile: "acme" } },
      ));
      await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test", schema: 6 }));

      const r = runCli(["status", "--json"], { cwd: s.wsRoot });
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout);
      // No warning about section x reaching no target
      const warnings = json.warnings.filter((w: string) => w.includes("section x reaches no target"));
      expect(warnings.length).toBe(0);
    });

    it("workspace targets [claude-code] only, rule targets: \"*\" with O(x,kiro) → no warning", async () => {
      // Important: we check against the ingredient's effective targets, not the workspace's targets
      const styleBody = [
        "# Style",
        "",
        O("x", "kiro"),
        "kiro content",
        CLOSE,
        "",
        "End.",
      ].join("\n") + "\n";

      const s = kept(await scenario(
        {
          ingredients: [
            {
              meta: { type: "rule", name: "style", targets: "*" }, // all targets
              files: { "rule.md": styleBody },
            },
          ],
          recipes: [recipe("base", ["rule/style"])],
          profiles: [profile("acme", ["base"], ["claude-code"])], // workspace has only claude-code
        },
        { config: { profile: "acme" } },
      ));
      await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test", schema: 6 }));

      const r = runCli(["status", "--json"], { cwd: s.wsRoot });
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout);
      // No warning: the rule's effective targets include kiro, so the section can reach kiro
      // (even though this workspace doesn't use kiro)
      const warnings = json.warnings.filter((w: string) => w.includes("section x reaches no target"));
      expect(warnings.length).toBe(0);
    });
  });

  describe("agents-md.primary interaction", () => {
    it("under agents-md.primary: always rule targets: \"*\" with O(x,claude-code) warns (effective targets are agents-md)", async () => {
      const styleBody = [
        "# Style",
        "",
        O("x", "claude-code"),
        "claude-code content",
        CLOSE,
        "",
        "End.",
      ].join("\n") + "\n";

      const s = kept(await scenario(
        {
          ingredients: [
            {
              meta: { type: "rule", name: "style", targets: "*" }, // default targets
              files: { "rule.md": styleBody },
            },
          ],
          recipes: [recipe("base", ["rule/style"])],
          profiles: [
            profile("acme", ["base"], ["claude-code", "kiro", "agents-md"], {
              params: { "agents-md.primary": true },
            }),
          ],
        },
        { config: { profile: "acme" } },
      ));
      // schema: 6 includes schema: 5 for agents-md.primary
      await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test", schema: 6 }));

      const r = runCli(["status", "--json"], { cwd: s.wsRoot });
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout);
      // Under agents-md.primary, an always-on rule with targets: "*" has effective targets ["agents-md"]
      // So a section targets=claude-code reaches no target
      const warnings = json.warnings.filter((w: string) => w.includes("section x reaches no target"));
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("targets=claude-code");
    });
  });

  describe("service with targeted section", () => {
    it("a service fragment with a targeted section fails the plan", async () => {
      const serviceCompose = [
        "services:",
        "  echo:",
        "    image: example/echo:1",
        "    environment:",
        O("env", "claude-code"),
        "      GREETING: hello",
        CLOSE,
      ].join("\n") + "\n";

      const s = kept(await scenario(
        {
          ingredients: [
            { meta: { type: "service", name: "echo" }, files: { "compose.yaml": serviceCompose } },
          ],
          recipes: [recipe("base", ["service/echo"])],
          profiles: [profile("acme", ["base"], ["claude-code"])],
        },
        { config: { profile: "acme" } },
      ));
      await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test", schema: 6 }));

      const r = runCli(["status"], { cwd: s.wsRoot });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("service/echo compose.yaml: section env names targets, but a service file is written for no target — remove targets=");
    });
  });

  describe("schema gate", () => {
    it("at schema: 5 the same rule file fails with the schema-6 near-miss message", async () => {
      const styleBody = [
        "# Style",
        "",
        O("x", "claude-code"),
        "content",
        CLOSE,
        "",
        "End.",
      ].join("\n") + "\n";

      const s = kept(await scenario(
        {
          ingredients: [
            { meta: { type: "rule", name: "style" }, files: { "rule.md": styleBody } },
          ],
          recipes: [recipe("base", ["rule/style"])],
          profiles: [profile("acme", ["base"], ["claude-code"])],
        },
        { config: { profile: "acme" } },
      ));
      // schema: 5 — should fail because targets= needs schema 6
      await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test", schema: 5 }));

      const r = runCli(["status"], { cwd: s.wsRoot });
      expect(r.code).toBe(1);
      // Message should name the file and line
      expect(r.stderr).toContain("ingredients/rules/style/rule.md:");
      expect(r.stderr).toContain("names targets");
      expect(r.stderr).toContain("schema: 6");
    });
  });

  describe("pins unchanged", () => {
    it("task 01 pin still passes (schema 5, no targets=)", async () => {
      const s = kept(await acmeSections({ schema: 5 }));
      const r = runCli(["sync"], { cwd: s.wsRoot });
      expect(r.code).toBe(0);
    });

    it("schema-6 twin of task 01 pin still passes (no targets= in markers)", async () => {
      const s = kept(await acmeSections({ schema: 6 }));
      const r = runCli(["sync"], { cwd: s.wsRoot });
      expect(r.code).toBe(0);
    });
  });
});
