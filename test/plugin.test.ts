import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { TOOL_NAMES, WRITE_TOOL_NAMES } from "../src/core/mcp-protocol.js";

// Spec 45 §10. Reads the files and starts no process: a change to these files publishes on merge.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "plugins", "craftar");
const read = (...parts: string[]) => fs.readFile(path.join(ROOT, ...parts), "utf8");
const readJson = async (...parts: string[]) => JSON.parse(await read(...parts));
const skillLines = async () => (await read("plugins", "craftar", "skills", "craftar", "SKILL.md")).split(/\r?\n/);

async function walk(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), name)));
    else out.push(name);
  }
  return out;
}

function frontmatter(lines: string[]): Record<string, unknown> {
  expect(lines[0]).toBe("---");
  const end = lines.indexOf("---", 1);
  expect(end).toBeGreaterThan(0);
  return YAML.parse(lines.slice(1, end).join("\n"));
}

function firstColumn(lines: string[]): string[] {
  const rows = lines.filter((l) => l.startsWith("|"));
  expect(rows.length).toBeGreaterThan(2);
  // rows[0] is the header and rows[1] the separator.
  return rows.slice(2).map((l) => l.split("|")[1].trim().replace(/`/g, ""));
}

describe("the Claude Code plugin (spec 45)", () => {
  it("1. .mcp.json is exactly the launch the rulings name", async () => {
    expect(await readJson("plugins", "craftar", ".mcp.json")).toStrictEqual({
      mcpServers: {
        craftar: {
          command: "craftar",
          args: ["mcp", "--workspace", "${CLAUDE_PROJECT_DIR}"],
        },
      },
    });
  });

  it("2. plugin.json is the spec's manifest, with a plain x.y.z version", async () => {
    // Compared whole: a manifest can declare mcpServers or hooks inline, a second launch path test 1 never reads.
    const manifest = await readJson("plugins", "craftar", ".claude-plugin", "plugin.json");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest).toStrictEqual({
      name: "craftar",
      version: manifest.version,
      description: "Lets the agent read a Craftar workspace's state through craftar mcp.",
      author: { name: "Craftar" },
      homepage: "https://craftar.dev",
      repository: "https://github.com/llima/craftar-cli",
      license: "MIT",
    });
  });

  it("3. plugins/craftar holds exactly the plugin's files", async () => {
    expect((await walk(PLUGIN)).sort()).toEqual(
      [".claude-plugin/plugin.json", ".mcp.json", "README.md", "skills/craftar/SKILL.md"].sort(),
    );
  });

  it("4a. the skill's frontmatter holds exactly name and description", async () => {
    expect(Object.keys(frontmatter(await skillLines())).sort()).toEqual(["description", "name"]);
  });

  it("4b. the skill's table names the seven reading tools and no writing tool", async () => {
    const tools = firstColumn(await skillLines());
    expect([...tools].sort()).toEqual([...TOOL_NAMES].sort());
    for (const name of WRITE_TOOL_NAMES) expect(tools).not.toContain(name);
  });

  it("5. the skill never offers --allow-writes, and names --overwrite-drift only to forbid it", async () => {
    const lines = await skillLines();
    expect(lines.filter((l) => l.includes("--allow-writes"))).toEqual([]);
    const drift = lines.filter((l) => l.includes("--overwrite-drift"));
    expect(drift).toHaveLength(1);
    expect(drift[0].split("--overwrite-drift")).toHaveLength(2);
    expect(drift[0].startsWith("Never add")).toBe(true);
  });

  it("6. the marketplace is the spec's, its one entry pointing at the plugin with no version", async () => {
    // Compared whole, as test 2 compares the manifest: an entry can carry its own mcpServers.
    expect(await readJson(".claude-plugin", "marketplace.json")).toStrictEqual({
      name: "craftar",
      description: "The Claude Code plugin of Craftar, a build system for AI-coding harnesses.",
      owner: { name: "Craftar" },
      plugins: [
        {
          name: "craftar",
          source: "./plugins/craftar",
          description: "Lets the agent read a Craftar workspace's state through craftar mcp.",
        },
      ],
    });
  });

  it("7. package.json's files does not reach plugins or .claude-plugin", async () => {
    // The whole list, since a glob such as "**/*" or "plugin*" reaches them with no name to match.
    const { files } = await readJson("package.json");
    expect(files).toStrictEqual(["dist", "bin", "README.md"]);
  });
});
