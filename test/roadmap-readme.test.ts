import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The user's ruling of 2026-11-02: Phase 1 and Phase 2 are closed; Later is unchanged.
// A Windows checkout holds the README with CRLF; every assertion below reads it as LF.
const README = readFileSync(path.resolve(__dirname, "../README.md"), "utf8").replace(/\r\n/g, "\n");
const lines = README.split("\n");
const phase = (n: number): string => lines.find((l) => l.startsWith(`Phase ${n} `))!;

describe("README — the roadmap with phases 1 and 2 closed", () => {
  it("Phase 0, 1 and 2 read done, none reads in progress or has a Next:", () => {
    for (const n of [0, 1, 2]) {
      expect(phase(n)).toMatch(/^Phase \d — [a-z ]+ \(done\)/);
      expect(phase(n)).not.toContain("in progress");
      expect(phase(n)).not.toContain("Next:");
    }
    expect(lines.filter((l) => /^Phase \d/.test(l))).toHaveLength(3);
  });

  it("Phase 1's shipped list ends with Kiro agents' permissions and craftar settings apply", () => {
    expect(phase(1)).toContain("; Kiro agents' `permissions` (`permissions.rules` derived from the agent's tools, so kiro-cli 2.37 no longer rewrites the file); ");
    expect(phase(1).endsWith("; `craftar settings apply` (the generated `hooks` and `env` names merged into `.claude/settings.json`, only when a person types it).")).toBe(true);
  });

  it("Later is unchanged", () => {
    const later = lines.filter((l) => l.startsWith("Later:"));
    expect(later).toEqual(["Later: rulesync bridge for Codex/Kimi/Cursor specifics; the Agent Plugin packaging of `craftar mcp`."]);
  });

  it("the status line opens with the three phases done and gains the 0.49.0, 0.50.0, 0.53.0, 0.55.0 and 0.59.0 sentences", () => {
    const status = lines[4];
    expect(status.startsWith("> Status: **phases 0, 1 and 2 done** — the foundations, the client profile and the environment. ")).toBe(true);
    expect(status).not.toContain("in progress");
    expect(status).toContain("Each Kiro agent gets `permissions.rules`, derived from its tools as kiro-cli 2.37 derives them, so Kiro no longer rewrites the file (see *Targets*).");
    expect(status).toContain("`craftar settings apply` merges the generated `hooks` and the `env` names into `.claude/settings.json` — only when a person types it, keeping every `env` value, `permissions` and every other key (see *Commands*).");
    expect(status).toContain("In a Forge that declares `schema: 11`, a profile's section value can be held in a file under its folder (`{ file: sections/….md }`), and `craftar forge sections extract` moves the long ones there; `craftar doctor`'s `skill-trigger` says when a skill's description does not say when to use it (see *Forge layout* and *Commands*).");
    expect(status).toContain("In a Forge that declares `schema: 12`, a profile's local may override a root base of the same ref for that profile alone — `craftar forge localize` turns the profile's own variant into one, and `craftar forge promote --variant` makes a variant several profiles share the base.");
    expect(status).toContain("In a Forge that declares `schema: 13`, a profile can extend an abstract one, so a client's profiles share one parent's values, recipes and locals (see *Forge layout*).");
    // Spec 55 Part A: the status line's last sentence is the list params'.
    expect(status.endsWith("In a Forge that declares `schema: 14`, a param can be a list, cited through a filter that writes a Python, PowerShell, shell, JSON or YAML literal, or the items joined (see *Forge layout*).")).toBe(true);
  });
});
