import { describe, expect, it } from "vitest";
import { driftList } from "../src/core/drift.js";
import type { FileStatus } from "../src/core/sync.js";
import { hashNormalized } from "../src/core/text.js";

// Spec 30 §4.2: the rows of `craftar drift show`, as data.

const planned = (p: string, target: "claude-code" | "kiro" | "agents-md", ingredient: string, body: string) => ({ path: p, content: Buffer.from(body), target, ingredient });
const drift = (p: string, target: "claude-code" | "kiro" | "agents-md", ingredient: string, lockBody: string, planBody: string): FileStatus => ({
  path: p,
  state: "drift",
  target,
  ingredient,
  planned: planned(p, target, ingredient, planBody),
  lock: { path: p, hash: hashNormalized(lockBody), target, ingredient },
});
const orphanDrift = (p: string, target: "claude-code" | "kiro" | "agents-md", ingredient: string): FileStatus => ({
  path: p,
  state: "orphan-drift",
  target,
  ingredient,
  lock: { path: p, hash: hashNormalized("was\n"), target, ingredient },
});

describe("driftList", () => {
  it("forge is same when the lock records the plan, changed when the Forge moved too, removed for a hand-edited orphan", () => {
    expect(
      driftList([drift("a.md", "claude-code", "rule/a", "x\n", "x\n"), drift("b.md", "claude-code", "rule/b", "x\n", "y\n"), orphanDrift("c.md", "claude-code", "rule/c")]),
    ).toEqual([
      { path: "a.md", state: "drift", target: "claude-code", ingredient: "rule/a", forge: "same", promotable: true, reason: null },
      { path: "b.md", state: "drift", target: "claude-code", ingredient: "rule/b", forge: "changed", promotable: true, reason: null },
      { path: "c.md", state: "orphan-drift", target: "claude-code", ingredient: "rule/c", forge: "removed", promotable: false, reason: "no longer produced" },
    ]);
  });

  it("the first static reason that applies: orphan, then kiro, then AGENTS.md, then .mcp.json", () => {
    const rows = driftList([
      drift(".kiro/steering/a.md", "kiro", "rule/a", "x\n", "x\n"),
      drift("AGENTS.md", "agents-md", "rule/*", "x\n", "x\n"),
      drift(".mcp.json", "claude-code", "mcp/*", "x\n", "x\n"),
      orphanDrift(".kiro/steering/old.md", "kiro", "rule/old"),
    ]);
    expect(rows.map((r) => [r.path, r.promotable, r.reason])).toEqual([
      [".kiro/steering/a.md", false, "kiro file"],
      ["AGENTS.md", false, "AGENTS.md"],
      [".mcp.json", false, ".mcp.json"],
      [".kiro/steering/old.md", false, "no longer produced"],
    ]);
  });

  it("every other state gives no row, and the order given is kept", () => {
    const other = (state: FileStatus["state"]): FileStatus => ({ path: `${state}.md`, state, target: "claude-code", ingredient: "rule/x" });
    expect(driftList((["unchanged", "update", "new", "adopt", "collision", "orphan"] as const).map(other))).toEqual([]);
    expect(driftList([drift("z.md", "claude-code", "rule/z", "x\n", "x\n"), other("update"), drift("a.md", "claude-code", "rule/a", "x\n", "x\n")]).map((r) => r.path)).toEqual(["z.md", "a.md"]);
  });
});
