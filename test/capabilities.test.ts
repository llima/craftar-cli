/**
 * Capability matrix test (spec 16 §10.2): one synthetic Forge with one ingredient of every type,
 * two skills (dir and file layout), each with `targets: "*"` written explicitly and distinct
 * output names, every body carrying a `.claude/rules/<x>.md` reference, then verified against
 * each target alone to prove the 24 cells of CAPABILITIES.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { CAPABILITIES, type Capability, type CapabilityState } from "../src/core/capabilities.js";
import { loadForge } from "../src/core/forge.js";
import { plan, loadWorkspace } from "../src/core/sync.js";
import { resolve } from "../src/core/resolve.js";
import { toLf, stripBom } from "../src/core/text.js";
import { tmpDir, writeFiles, makeWorkspace, type IngredientSpec } from "./helpers/forge.js";
import { INGREDIENT_TYPES, TARGETS, type IngredientType, type Target } from "../src/schema/index.js";
import type { PlannedFile } from "../src/emitters/types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

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
 * Determine which planned files belong to a given ingredient ref or type.
 * - For most types: files where `ingredient` equals the ref.
 * - For `mcp`: files where `ingredient` is `mcp/*` and path matches the MCP file pattern.
 * - For `rule` with AGENTS.md: files where `ingredient` is `rule/*` and path is AGENTS.md.
 */
function filesFor(files: PlannedFile[], type: IngredientType, ref: string, target: Target): PlannedFile[] {
  return files.filter((f) => {
    if (f.ingredient === ref) return true;
    // Shared files: AGENTS.md is `rule/*`, MCP files are `mcp/*`
    if (type === "rule" && f.ingredient === "rule/*" && f.path === "AGENTS.md") return true;
    if (type === "mcp" && f.ingredient === "mcp/*") return true;
    return false;
  });
}

/**
 * Check if a planned file matches a pattern.
 */
function matchesPattern(filePath: string, pattern: string, outName: string): boolean {
  // Replace <name> with the output name
  let regex = pattern.replace(/<name>/g, outName);
  // Replace <file> with a wildcard
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

  // For AGENTS.md and other shared files, they are by construction not "as held"
  if (f.ingredient === "rule/*") {
    // AGENTS.md contains processed/combined content, never as held
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

          // Find the ingredient ref(s) for this type
          // We have cap-<type> for most, cap-skill-dir and cap-skill-file for skills
          const refs =
            type === "skill"
              ? ["skill/cap-skill-dir", "skill/cap-skill-file"]
              : [`${type}/cap-${type}`];

          // Collect all files for this type
          const typeFiles: PlannedFile[] = [];
          for (const ref of refs) {
            typeFiles.push(...filesFor(plannedFiles, type, ref, target));
          }

          // Check rule 1: unsupported ⇔ no file and a warning naming it
          if (cap.state === "unsupported") {
            // Should have no files for this ingredient
            const directFiles = typeFiles.filter((f) => refs.some((r) => f.ingredient === r));
            expect(
              directFiles.length,
              `${cellName}: unsupported should have no files, but found: ${directFiles.map((f) => f.path).join(", ")}`,
            ).toBe(0);

            // Should have a warning naming the ingredient
            const hasWarning = warnings.some((w) =>
              refs.some((r) => w.includes(r) && w.includes("skipped")),
            );
            expect(hasWarning, `${cellName}: unsupported should have a skip warning`).toBe(true);

            // output should be empty
            expect(cap.output.length, `${cellName}: unsupported should have empty output`).toBe(0);
          } else {
            // native or converted: check rules 2-4

            // Rule 2: at least one planned file matches each output pattern for this ingredient
            for (const pattern of cap.output) {
              let patternMatched = false;

              for (const ref of refs) {
                const outName = ref.split("/")[1];

                // For MCP, the pattern is a single file containing all servers
                if (type === "mcp") {
                  const mcpFiles = plannedFiles.filter((f) => f.ingredient === "mcp/*");
                  const matches = mcpFiles.filter((f) => matchesPattern(f.path, pattern, outName));
                  if (matches.length > 0) patternMatched = true;
                } else if (type === "rule" && target === "agents-md") {
                  // AGENTS.md is a single file for all rules
                  const agentsMdFiles = plannedFiles.filter((f) => f.path === "AGENTS.md");
                  if (agentsMdFiles.length > 0) patternMatched = true;
                } else if (type === "skill") {
                  // Skills have two layouts with different patterns
                  const isDir = ref.includes("skill-dir");
                  const patternHasFile = pattern.includes("<file>");
                  const patternIsSingleFile = pattern.endsWith("<name>.md");

                  if (isDir && patternHasFile) {
                    // Dir layout matches <name>/<file> pattern
                    const dirFiles = filesFor(plannedFiles, type, ref, target);
                    if (dirFiles.some((f) => matchesPattern(f.path, pattern, outName))) {
                      patternMatched = true;
                    }
                  } else if (!isDir && patternIsSingleFile && target === "claude-code") {
                    // File layout on claude-code matches <name>.md
                    const fileFiles = filesFor(plannedFiles, type, ref, target);
                    if (fileFiles.some((f) => matchesPattern(f.path, pattern, outName))) {
                      patternMatched = true;
                    }
                  } else if (!isDir && patternHasFile && target === "kiro") {
                    // File layout on kiro is converted to <name>/SKILL.md
                    const fileFiles = filesFor(plannedFiles, type, ref, target);
                    if (fileFiles.some((f) => matchesPattern(f.path, pattern, outName))) {
                      patternMatched = true;
                    }
                  }
                } else {
                  // Standard case: check if any file from this ref matches
                  const refFiles = filesFor(plannedFiles, type, ref, target);
                  if (refFiles.some((f) => matchesPattern(f.path, pattern, outName))) {
                    patternMatched = true;
                  }
                }
              }

              expect(
                patternMatched,
                `${cellName}: should have file matching pattern "${pattern}"`,
              ).toBe(true);
            }

            // No skip warning for this ingredient
            const hasSkipWarning = warnings.some((w) =>
              refs.some((r) => w.includes(r) && w.includes("skipped")),
            );
            expect(
              hasSkipWarning,
              `${cellName}: native/converted should not have skip warning`,
            ).toBe(false);
          }

          // Rule 3/4: native ⇔ every file is as held; converted ⇔ at least one is not
          if (cap.state === "native" || cap.state === "converted") {
            let allAsHeld = true;
            let hasAnyFile = false;

            for (const ref of refs) {
              const refFiles = filesFor(plannedFiles, type, ref, target).filter(
                (f) => f.ingredient === ref || (type === "mcp" && f.ingredient === "mcp/*"),
              );

              if (refFiles.length > 0) hasAnyFile = true;

              const ing = forge.ingredients.get(ref);
              if (!ing) continue;

              for (const f of refFiles) {
                const asHeld = await isAsHeld(f, ing, type, ref.split("/")[1]);
                if (!asHeld) allAsHeld = false;
              }
            }

            if (hasAnyFile) {
              if (cap.state === "native") {
                expect(allAsHeld, `${cellName}: native should have all files as held`).toBe(true);
              } else {
                expect(
                  allAsHeld,
                  `${cellName}: converted should have at least one file not as held`,
                ).toBe(false);
              }
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
