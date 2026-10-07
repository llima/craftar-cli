/**
 * Capability matrix test (spec 16 §10.2): one synthetic Forge with one ingredient of every type,
 * two skills (dir and file layout), each with `targets: "*"` written explicitly and distinct
 * output names, every body carrying a `.claude/rules/<x>.md` reference, then verified against
 * each target alone to prove the 24 cells of CAPABILITIES.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { CAPABILITIES } from "../src/core/capabilities.js";
import { loadForge } from "../src/core/forge.js";
import { plan, loadWorkspace } from "../src/core/sync.js";
import { toLf, stripBom } from "../src/core/text.js";
import { tmpDir, writeFiles, makeWorkspace, type IngredientSpec } from "./helpers/forge.js";
import { INGREDIENT_TYPES, TARGETS, type IngredientType, type Target } from "../src/schema/index.js";
import type { PlannedFile } from "../src/emitters/types.js";

/**
 * Creates a Forge with one ingredient per type (two skills: dir and file layout), each with
 * `targets: "*"` and a unique output name, and every body referencing `.claude/rules/cite-me.md`.
 */
async function makeCapabilityForge(root: string): Promise<void> {
  // Create the forge manifest
  await writeFiles(root, { "craftar.forge.yaml": YAML.stringify({ name: "capability-forge", schema: 1 }) });

  const REFERENCE = ".claude/rules/cite-me.md";

  // Each ingredient type with a unique name and a reference in its body
  const ingredients: IngredientSpec[] = [
    // rule
    {
      meta: { type: "rule", name: "cap-rule", targets: "*" },
      files: { "rule.md": `# Rule\nSee ${REFERENCE} for conventions.\n` },
    },
    // agent
    {
      meta: {
        type: "agent",
        name: "cap-agent",
        targets: "*",
        tools: ["Read", "Bash"],
        description: `Refer to ${REFERENCE}`,
      },
      files: { "agent.md": `Follow ${REFERENCE}.\n` },
    },
    // command
    {
      meta: { type: "command", name: "cap-command", targets: "*", description: `See ${REFERENCE}` },
      files: { "command.md": `Run with ${REFERENCE}.\n` },
    },
    // skill (dir layout)
    {
      meta: { type: "skill", name: "cap-skill-dir", targets: "*", layout: "dir" },
      files: { "SKILL.md": `# Skill\nUse ${REFERENCE}.\n`, "helper.txt": `Helper referencing ${REFERENCE}.\n` },
    },
    // skill (file layout)
    {
      meta: { type: "skill", name: "cap-skill-file", targets: "*", layout: "file" },
      files: { "SKILL.md": `# Single-file skill\n${REFERENCE}\n` },
    },
    // mcp
    {
      meta: { type: "mcp", name: "cap-mcp", targets: "*", server: { command: "npx", args: ["cap-server"] } },
    },
    // script
    {
      meta: { type: "script", name: "cap-script", targets: "*", files: ["run.ps1"] },
      files: { "run.ps1": `# Script\n# ${REFERENCE}\n` },
    },
    // steering (Kiro-only by default, but we set targets: "*" to aim it everywhere)
    {
      meta: { type: "steering", name: "cap-steering", targets: "*" },
      files: { "steering.md": `# Steering\nRefer to ${REFERENCE}.\n` },
    },
    // hook
    {
      meta: { type: "hook", name: "cap-hook", targets: "*", files: ["on-event.sh"] },
      files: { "on-event.sh": `#!/bin/bash\n# ${REFERENCE}\necho hook\n` },
    },
  ];

  // Write all ingredients
  const folder = (type: string) => (type === "mcp" ? "mcp" : `${type}s`);
  for (const ing of ingredients) {
    const dir = path.join(root, "ingredients", folder(ing.meta.type), ing.meta.name);
    await writeFiles(dir, { "ingredient.yaml": YAML.stringify(ing.meta), ...(ing.files ?? {}) });
  }

  // Create a recipe that includes all ingredients
  const allRefs = ingredients.map((ing) => `${ing.meta.type}/${ing.meta.name}`);
  await writeFiles(root, { "recipes/all.yaml": YAML.stringify({ name: "all", ingredients: allRefs }) });

  // Create a profile
  await writeFiles(root, { "profiles/test/profile.yaml": YAML.stringify({ name: "test", recipes: ["all"], targets: TARGETS.slice() }) });
}

/**
 * Creates a workspace with a specific target (or targets).
 */
async function createWorkspace(root: string, forgeRoot: string, targets: Target[]): Promise<string> {
  const wsRoot = path.join(root, `ws-${targets.join("-")}`);
  await makeWorkspace(wsRoot, forgeRoot, { config: { profile: "test", targets } });
  return wsRoot;
}

/**
 * Check if a planned file matches a pattern.
 * Literal patterns (like `AGENTS.md`, `.mcp.json`) must match exactly.
 * Patterns with `<name>` and `<file>` are expanded.
 */
function matchesPattern(filePath: string, pattern: string, outName: string): boolean {
  // Replace <name> with the output name
  let regex = pattern.replace(/<name>/g, outName);
  // Replace <file> with a wildcard for one or more path segments
  regex = regex.replace(/<file>/g, "[^/]+");
  // Escape dots and make it a full match
  regex = "^" + regex.replace(/\./g, "\\.") + "$";
  return new RegExp(regex).test(filePath);
}

/**
 * Strip leading frontmatter block from markdown content.
 */
function stripFrontmatter(content: string): string {
  const lines = content.split("\n");
  if (lines[0] !== "---") return content;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      // Skip the frontmatter and any blank lines after it
      let start = i + 1;
      while (start < lines.length && lines[start].trim() === "") start++;
      return lines.slice(start).join("\n");
    }
  }
  return content;
}

/**
 * Check if a file is "as held" (unchanged from source).
 * - For text files: equals the source with line endings normalized.
 * - For MCP: the planned JSON has the server object under its name.
 * - For Claude Code agents/commands: setting aside the frontmatter block (spec 16 §10.2).
 * - For AGENTS.md (shared file with ingredient = "rule/*"): never as held by construction (spec 16 §10.2).
 */
async function isAsHeld(
  f: PlannedFile,
  ing: { dir: string; meta: Record<string, unknown> },
  type: IngredientType,
  outName: string,
): Promise<boolean> {
  if (type === "mcp") {
    // MCP: check if the server object is deep-equal under the output name
    try {
      const planned = JSON.parse(f.content.toString("utf8"));
      if (!planned.mcpServers || !planned.mcpServers[outName]) return false;
      const server = ing.meta.server as Record<string, unknown>;
      return JSON.stringify(planned.mcpServers[outName]) === JSON.stringify(server);
    } catch {
      return false;
    }
  }

  // For AGENTS.md (shared rule/* file), it is not as held by construction (spec 16 §10.2)
  if (f.ingredient === "rule/*") {
    return false;
  }

  // Text files: compare normalized content
  // We need to find the source file
  const meta = ing.meta as Record<string, unknown>;
  const sourceFiles: string[] = [];
  if (type === "agent" || type === "command" || type === "rule" || type === "steering") {
    sourceFiles.push((meta.file as string) || `${type === "steering" ? "steering" : type}.md`);
  } else if (type === "skill") {
    const layout = meta.layout as string;
    if (layout === "file") {
      sourceFiles.push("SKILL.md");
    } else {
      // For dir layout, list all files in the ingredient directory
      try {
        const files = await fs.readdir(ing.dir);
        sourceFiles.push(...files.filter((f) => f !== "ingredient.yaml"));
      } catch {
        sourceFiles.push("SKILL.md");
      }
    }
  } else if (type === "script" || type === "hook") {
    sourceFiles.push(...((meta.files as string[]) || []));
  }

  // For claude-code agents and commands, we compare setting aside frontmatter
  // This means we compare the body after stripping frontmatter from both sides
  if ((type === "agent" || type === "command") && f.target === "claude-code") {
    for (const srcFile of sourceFiles) {
      try {
        const srcPath = path.join(ing.dir, srcFile);
        const srcContent = toLf(stripBom((await fs.readFile(srcPath)).toString("utf8")));
        const dstContent = toLf(stripBom(f.content.toString("utf8")));

        // Strip frontmatter from both and compare
        const srcBody = stripFrontmatter(srcContent).replace(/\n+$/, "").trim();
        const dstBody = stripFrontmatter(dstContent).replace(/\n+$/, "").trim();

        if (srcBody === dstBody) return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  // For skill with dir layout, check the specific file in the planned path
  if (type === "skill" && (meta.layout as string) === "dir") {
    // Get the filename from the planned path
    const pathParts = f.path.split("/");
    const fileName = pathParts[pathParts.length - 1];
    try {
      const srcPath = path.join(ing.dir, fileName);
      const srcContent = toLf(stripBom((await fs.readFile(srcPath)).toString("utf8")));
      const dstContent = toLf(stripBom(f.content.toString("utf8")));
      return srcContent.replace(/\n+$/, "").trim() === dstContent.replace(/\n+$/, "").trim();
    } catch {
      return false;
    }
  }

  // For other types, compare directly
  for (const srcFile of sourceFiles) {
    try {
      const srcPath = path.join(ing.dir, srcFile);
      const srcContent = toLf(stripBom((await fs.readFile(srcPath)).toString("utf8")));
      const dstContent = toLf(stripBom(f.content.toString("utf8")));
      if (dstContent.replace(/\n+$/, "").trim() === srcContent.replace(/\n+$/, "").trim()) return true;
    } catch {
      continue;
    }
  }

  return false;
}

describe("capability matrix against emitters (spec 16 §10.2)", () => {
  let root: string;
  let forgeRoot: string;

  // Set up the shared Forge once
  beforeAll(async () => {
    root = await tmpDir("craftar-capabilities-");
    forgeRoot = path.join(root, "forge");
    await makeCapabilityForge(forgeRoot);
  });

  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  // Test each target
  for (const target of TARGETS) {
    describe(`target: ${target}`, () => {
      let wsRoot: string;
      let plannedFiles: PlannedFile[];
      let warnings: string[];
      let forge: Awaited<ReturnType<typeof loadForge>>;

      beforeAll(async () => {
        wsRoot = await createWorkspace(root, forgeRoot, [target]);
        const ws = await loadWorkspace(wsRoot);
        forge = ws.forge;
        const p = await plan(ws);
        plannedFiles = p.files;
        warnings = p.warnings;
      });

      // Test each ingredient type
      for (const type of INGREDIENT_TYPES) {
        it(`${target} · ${type}`, async () => {
          const cap = CAPABILITIES[target][type];
          const cellName = `${target} · ${type}`;

          // Find the ingredient ref(s) for this type in the fixture
          // We have cap-<type> for most, cap-skill-dir and cap-skill-file for skills
          const fixtureRefs =
            type === "skill"
              ? ["skill/cap-skill-dir", "skill/cap-skill-file"]
              : [`${type}/cap-${type}`];

          // Collect all files for this cell:
          // - Files whose `ingredient` is one of the fixture refs
          // - Plus shared files: AGENTS.md for rule (ingredient = "rule/*"), MCP files (ingredient = "mcp/*")
          const cellFiles: PlannedFile[] = [];
          for (const f of plannedFiles) {
            // Direct match to a fixture ref
            if (fixtureRefs.some((ref) => f.ingredient === ref)) {
              cellFiles.push(f);
              continue;
            }
            // Shared files: AGENTS.md belongs to type=rule
            if (type === "rule" && f.ingredient === "rule/*" && f.path === "AGENTS.md") {
              cellFiles.push(f);
              continue;
            }
            // Shared files: MCP files belong to type=mcp
            if (type === "mcp" && f.ingredient === "mcp/*") {
              cellFiles.push(f);
              continue;
            }
          }

          // Check rule 2: unsupported ⇔ no cell files AND a warning names each fixture ref AND output is empty
          if (cap.state === "unsupported") {
            expect(
              cellFiles.length,
              `${cellName}: unsupported should have no cell files, but found: ${cellFiles.map((f) => f.path).join(", ")}`,
            ).toBe(0);

            // Should have a warning naming each fixture ingredient
            for (const ref of fixtureRefs) {
              const hasWarning = warnings.some((w) => w.includes(ref) && w.includes("skipped"));
              expect(hasWarning, `${cellName}: unsupported should have a skip warning for ${ref}`).toBe(true);
            }

            // output should be empty
            expect(cap.output.length, `${cellName}: unsupported should have empty output`).toBe(0);
          } else {
            // native or converted (writing cells): check rules 3, and both directions

            // Rule 3: at least one cell file (no if around the expect!)
            expect(
              cellFiles.length,
              `${cellName}: a writing cell should have at least one file`,
            ).toBeGreaterThan(0);

            // Direction 1: every cell file matches at least one output pattern
            for (const f of cellFiles) {
              // For a shared file, any fixture ref's output name works
              const outNamesToTry = f.ingredient === "rule/*" || f.ingredient === "mcp/*"
                ? fixtureRefs.map((ref) => ref.split("/")[1])
                : [fixtureRefs.find((ref) => f.ingredient === ref)?.split("/")[1] ?? f.ingredient.split("/")[1]];

              const matchesSomePattern = outNamesToTry.some((outName) =>
                cap.output.some((pattern) => matchesPattern(f.path, pattern, outName))
              );

              expect(
                matchesSomePattern,
                `${cellName}: file "${f.path}" (ingredient ${f.ingredient}) should match at least one output pattern (${cap.output.join(", ")})`,
              ).toBe(true);
            }

            // Direction 2: every output pattern is matched by at least one cell file
            for (const pattern of cap.output) {
              const matchedByFile = cellFiles.some((f) => {
                // For a shared file, any fixture ref's output name works
                const outNamesToTry = f.ingredient === "rule/*" || f.ingredient === "mcp/*"
                  ? fixtureRefs.map((ref) => ref.split("/")[1])
                  : [fixtureRefs.find((ref) => f.ingredient === ref)?.split("/")[1] ?? f.ingredient.split("/")[1]];

                return outNamesToTry.some((outName) => matchesPattern(f.path, pattern, outName));
              });

              expect(
                matchedByFile,
                `${cellName}: pattern "${pattern}" should be matched by at least one cell file`,
              ).toBe(true);
            }

            // No skip warning for any fixture ingredient
            for (const ref of fixtureRefs) {
              const hasSkipWarning = warnings.some((w) => w.includes(ref) && w.includes("skipped"));
              expect(
                hasSkipWarning,
                `${cellName}: native/converted should not have skip warning for ${ref}`,
              ).toBe(false);
            }
          }

          // Rule 4: among writing cells, native ⇔ every cell file is as held; converted ⇔ at least one is not
          if (cap.state === "native" || cap.state === "converted") {
            let allAsHeld = true;

            for (const f of cellFiles) {
              // Find the ingredient for this file
              // For shared files, pick any matching fixture ingredient for the check
              let ingRef: string;
              if (f.ingredient === "rule/*" || f.ingredient === "mcp/*") {
                ingRef = fixtureRefs[0]; // Any fixture ref of this type
              } else {
                ingRef = f.ingredient;
              }

              const ing = forge.ingredients.get(ingRef);
              if (!ing) continue;

              const outName = ingRef.split("/")[1];
              const asHeld = await isAsHeld(f, ing, type, outName);
              if (!asHeld) allAsHeld = false;
            }

            if (cap.state === "native") {
              expect(allAsHeld, `${cellName}: native should have all files as held`).toBe(true);
            } else {
              expect(
                allAsHeld,
                `${cellName}: converted should have at least one file not as held`,
              ).toBe(false);
            }
          }
        });
      }
    });
  }
});

describe("capability notes are plain text (spec 16 §4.4)", () => {
  it("the five converted notes, word for word, with no markdown backticks", () => {
    expect(CAPABILITIES.kiro.rule.note).toBe(
      "inclusion frontmatter and a banner are added; a .claude/rules/ reference becomes .kiro/steering/ when kiro writes that file, and otherwise follows the rule it names (kept for claude-code, AGENTS.md (rule: <x>), or <x> (rule not in this workspace) with a warning)",
    );
    expect(CAPABILITIES.kiro.agent.note).toBe(
      "written as JSON; tools mapped to Kiro names, one with no equivalent dropped with a warning; .claude/rules/ references resolved as for a rule; resources taken from the ingredient, else derived from the steering files",
    );
    expect(CAPABILITIES.kiro.command.note).toBe(
      "written as manual steering; .claude/rules/ references resolved as for a rule, in the body and the description",
    );
    expect(CAPABILITIES.kiro.skill.note).toBe(
      "in its text files (.md, .txt, .json, .yaml, .yml), .claude/rules/ references resolved as for a rule; other files are copied as they are; a single-file skill becomes <name>/SKILL.md",
    );
    expect(CAPABILITIES["agents-md"].rule.note).toBe(
      "always-on rules are embedded in AGENTS.md; a scoped rule is listed at the file another target writes, or embedded when none does; .claude/rules/ references in the bodies, link text included, point at the file a target writes or the rule's place in AGENTS.md, or read <x> (rule not in this workspace) with a warning",
    );
  });

  it("no note of the 24 cells holds a backtick; native notes are null; unsupported notes are the one sentence", () => {
    const bad: string[] = [];
    for (const t of TARGETS)
      for (const ty of INGREDIENT_TYPES) {
        const c = CAPABILITIES[t][ty];
        if (c.note !== null && c.note.includes("`")) bad.push(`${t} · ${ty}`);
        if (c.state === "native" && c.note !== null) bad.push(`${t} · ${ty} (native with a note)`);
        if (c.state === "unsupported" && c.note !== "skipped with a warning when aimed at this target") bad.push(`${t} · ${ty} (unsupported note)`);
      }
    expect(bad).toEqual([]);
  });
});
