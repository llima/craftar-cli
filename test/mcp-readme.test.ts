import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runCli } from "./helpers/cli.js";

// Spec 35 §9 and Ruling 2: what the README must say where it tells a team how to register the server.

const README = readFileSync(path.resolve(__dirname, "../README.md"), "utf8");
const count = (needle: string) => README.split(needle).length - 1;

describe("craftar mcp — README and --help", () => {
  it("--help names the command's contract and its two options", () => {
    const help = runCli(["mcp", "--help"]).stdout.replace(/\s+/g, " ");
    expect(help).toContain(
      "Serve this workspace to an AI coder over the Model Context Protocol, on stdin and stdout: seven reading tools — status, diff, explain, recipes, ingredients, targets, doctor — with the data those commands print. Started by the AI coder, not typed. Reads only; reads without the network unless --fetch",
    );
    expect(help).toContain("--workspace <dir>");
    expect(help).toContain("--fetch");
  });

  it("the Commands row, the section, the registration snippet and the warning of Ruling 2 are there, once each", () => {
    expect(count("| `craftar mcp [--workspace <dir>] [--fetch]` |")).toBe(1);
    expect(count("## Craftar inside the AI coder")).toBe(1);
    expect(count('{ "mcpServers": { "craftar": { "command": "craftar", "args": ["mcp"] } } }')).toBe(1);
    expect(count("**the names of every profile of the Forge and the workspace an ingredient was imported from**")).toBe(1);
    expect(count("unless `ref` is a full commit SHA")).toBe(1);
  });

  it("craftar mcp is no longer listed as not built, nor as a later item", () => {
    expect(README).not.toContain("`craftar ui`, `craftar mcp`) is not built yet");
    expect(README).not.toContain("`craftar mcp` + Claude Code");
    // `craftar ui` left both lists when it was built (spec 36): `test/ui-readme.test.ts` holds that half.
    // the roadmap still names the shipped command, and the results paragraph says what is left out
    expect(count("`craftar mcp` (a read-only MCP server: seven reading tools for an AI coder, over stdin and stdout);")).toBe(1);
    expect(count("with three things left out")).toBe(1);
  });
});
