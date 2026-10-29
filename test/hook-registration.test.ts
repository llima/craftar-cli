/**
 * Hook registration emitter tests (spec 43 §5.1–§5.6).
 * These tests cover the hookRegistrations() and settingsExample() functions and their
 * integration with the claude-code emitter.
 */
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, plan, type Plan } from "../src/core/sync.js";
import { profile, recipe, scenario, writeFiles, type ForgeSpec, type IngredientSpec, type WorkspaceSpec } from "./helpers/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function planFor(
  ingredients: IngredientSpec[],
  files?: WorkspaceSpec["files"],
  targets = ["claude-code"],
  local?: WorkspaceSpec["local"],
): Promise<Plan> {
  const forge: ForgeSpec = {
    ingredients,
    recipes: [recipe("base", ingredients.map((i) => `${i.meta.type}/${i.meta.name}`))],
    profiles: [profile("acme", ["base"], targets)],
  };
  const s = await scenario(forge, { config: { profile: "acme" }, files, local });
  cleanups.push(s.cleanup);
  return plan(await loadWorkspace(s.wsRoot));
}

const text = (p: Plan, rel: string) => p.files.find((f) => f.path === rel)?.content.toString("utf8");

const EX = ".claude/settings.craftar.example.json";

// Fixture H from the preamble: a hook ingredient with registration
const fixtureH = (): IngredientSpec => ({
  meta: {
    type: "hook",
    name: "guard-path",
    files: ["guard-path.py"],
    params: { "hooks.python": { default: "python3" } },
    registration: [
      {
        event: "PreToolUse",
        matcher: "Bash|PowerShell",
        command: "{{hooks.python}}",
        args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-path.py"],
        timeout: 10,
      },
    ],
  },
  files: { "guard-path.py": 'print("ok")\n' },
});

// Fixture H without registration
const fixtureHNoReg = (): IngredientSpec => ({
  meta: {
    type: "hook",
    name: "guard-path",
    files: ["guard-path.py"],
  },
  files: { "guard-path.py": 'print("ok")\n' },
});

// Fixture M from the preamble: an MCP ingredient with authEnv
const fixtureM = (): IngredientSpec => ({
  meta: {
    type: "mcp",
    name: "tracker",
    authEnv: ["ACME_TOKEN"],
    server: { command: "npx", args: ["acme-tracker"] },
  },
});

describe("hook registration emitter (spec 43 §5.1–§5.6)", () => {
  it("1. Forge = H + M: the example file is EXACTLY the JSON of spec §5.1", async () => {
    // The exact expected JSON from spec §5.1 (env before hooks, 2-space indent, trailing newline)
    const expected = `{
  "env": {
    "ACME_TOKEN": ""
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "python3",
            "args": [
              "\${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-path.py"
            ],
            "timeout": 10
          }
        ]
      }
    ]
  }
}
`;
    const p = await planFor([fixtureH(), fixtureM()]);
    const actual = text(p, EX);
    expect(actual).toBe(expected);
    // Verify the file is tagged mcp/*
    const f = p.files.find((f) => f.path === EX);
    expect(f?.ingredient).toBe("mcp/*");
  });

  it("2. Forge = H alone: the file exists, { \"hooks\": … } only, no env key", async () => {
    const p = await planFor([fixtureH()]);
    const actual = text(p, EX);
    expect(actual).toBeDefined();
    // Verify only hooks key, no env key
    const parsed = JSON.parse(actual!);
    expect(Object.keys(parsed)).toEqual(["hooks"]);
    expect(parsed.env).toBeUndefined();
    expect(parsed.hooks).toBeDefined();
    expect(parsed.hooks.PreToolUse).toBeDefined();
  });

  it("3. Two hooks A then B both on PreToolUse, plus C on Stop (order A, C, B) → hooks keys [PreToolUse, Stop], PreToolUse holds two groups", async () => {
    // Resolution order: A, C, B
    const hookA: IngredientSpec = {
      meta: {
        type: "hook",
        name: "hook-a",
        files: ["a.sh"],
        registration: [{ event: "PreToolUse", command: "a-cmd" }],
      },
      files: { "a.sh": "echo a\n" },
    };
    const hookC: IngredientSpec = {
      meta: {
        type: "hook",
        name: "hook-c",
        files: ["c.sh"],
        registration: [{ event: "Stop", command: "c-cmd" }],
      },
      files: { "c.sh": "echo c\n" },
    };
    const hookB: IngredientSpec = {
      meta: {
        type: "hook",
        name: "hook-b",
        files: ["b.sh"],
        registration: [{ event: "PreToolUse", command: "b-cmd" }],
      },
      files: { "b.sh": "echo b\n" },
    };

    const p = await planFor([hookA, hookC, hookB]);
    const actual = text(p, EX);
    const parsed = JSON.parse(actual!);

    // Keys should be in order: PreToolUse (first from A), then Stop (from C)
    expect(Object.keys(parsed.hooks)).toEqual(["PreToolUse", "Stop"]);

    // PreToolUse should have two groups (A's then B's), never merged
    expect(parsed.hooks.PreToolUse).toHaveLength(2);
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe("a-cmd");
    expect(parsed.hooks.PreToolUse[1].hooks[0].command).toBe("b-cmd");

    // Stop should have one group (C's)
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe("c-cmd");
  });

  it("4. an entry without matcher → its group has no matcher key (Object.keys(group) is [\"hooks\"])", async () => {
    const hookNoMatcher: IngredientSpec = {
      meta: {
        type: "hook",
        name: "no-matcher",
        files: ["run.sh"],
        registration: [{ event: "Stop", command: "run-cmd" }],
      },
      files: { "run.sh": "echo run\n" },
    };

    const p = await planFor([hookNoMatcher]);
    const actual = text(p, EX);
    const parsed = JSON.parse(actual!);

    // The group should have only "hooks" key, no "matcher" key
    const group = parsed.hooks.Stop[0];
    expect(Object.keys(group)).toEqual(["hooks"]);
    expect(group.matcher).toBeUndefined();
  });

  it("5. shell form → handler keys in order [type, command, shell]; handler with type,command,args,timeout → that order", async () => {
    // Shell form test
    const hookShell: IngredientSpec = {
      meta: {
        type: "hook",
        name: "shell-hook",
        files: ["lint.sh"],
        registration: [{ event: "Stop", command: "npx eslint --fix", shell: "bash" }],
      },
      files: { "lint.sh": "echo lint\n" },
    };

    const p = await planFor([hookShell]);
    const actual = text(p, EX);
    const parsed = JSON.parse(actual!);
    const handler = parsed.hooks.Stop[0].hooks[0];

    // Shell form handler keys: type, command, shell
    expect(Object.keys(handler)).toEqual(["type", "command", "shell"]);

    // Now test exec form with all fields (type, command, args, timeout)
    const p2 = await planFor([fixtureH()]);
    const actual2 = text(p2, EX);
    const parsed2 = JSON.parse(actual2!);
    const handler2 = parsed2.hooks.PreToolUse[0].hooks[0];

    // Exec form handler keys: type, command, args, timeout
    expect(Object.keys(handler2)).toEqual(["type", "command", "args", "timeout"]);
  });

  it("6. the spec §5.6 warning: registration cites .claude/hooks/other.py → warning; with guard-path.py → no warning; npx eslint → none", async () => {
    // Case 1: cites a path the ingredient does NOT write
    const hookOther: IngredientSpec = {
      meta: {
        type: "hook",
        name: "guard-path",
        files: ["guard-path.py"],
        params: { "hooks.python": { default: "python3" } },
        registration: [
          {
            event: "PreToolUse",
            matcher: "Bash|PowerShell",
            command: "{{hooks.python}}",
            args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/other.py"],
            timeout: 10,
          },
        ],
      },
      files: { "guard-path.py": 'print("ok")\n' },
    };

    const p1 = await planFor([hookOther]);
    const warningsWithOther = p1.warnings.filter((w) =>
      w.includes("hook/guard-path: registration cites .claude/hooks/other.py, which this ingredient does not write")
    );
    expect(warningsWithOther).toHaveLength(1);

    // Case 2: cites a path the ingredient DOES write → no warning
    const p2 = await planFor([fixtureH()]);
    const warningsWithSelf = p2.warnings.filter((w) =>
      w.includes("registration cites .claude/hooks/")
    );
    expect(warningsWithSelf).toHaveLength(0);

    // Case 3: npx eslint (no .claude/hooks/ path) → no warning
    const hookNpx: IngredientSpec = {
      meta: {
        type: "hook",
        name: "lint-hook",
        files: ["lint.sh"],
        registration: [{ event: "Stop", command: "npx", args: ["eslint"] }],
      },
      files: { "lint.sh": "echo lint\n" },
    };

    const p3 = await planFor([hookNpx]);
    const warningsNpx = p3.warnings.filter((w) =>
      w.includes("registration cites .claude/hooks/")
    );
    expect(warningsNpx).toHaveLength(0);
  });

  it("7. H aimed with targets: \"*\" in a workspace with targets claude-code, kiro, agents-md: .kiro/ and AGENTS.md gain nothing compared with H without registration", async () => {
    // Create H with targets: "*"
    const hookWithTargets: IngredientSpec = {
      meta: {
        ...fixtureH().meta,
        targets: "*",
      },
      files: fixtureH().files,
    };

    // Create H without registration but with same targets
    const hookNoRegWithTargets: IngredientSpec = {
      meta: {
        ...fixtureHNoReg().meta,
        targets: "*",
      },
      files: fixtureHNoReg().files,
    };

    const allTargets = ["claude-code", "kiro", "agents-md"];

    // Plan with registration
    const pWithReg = await planFor([hookWithTargets], undefined, allTargets);

    // Plan without registration
    const pNoReg = await planFor([hookNoRegWithTargets], undefined, allTargets);

    // Get .kiro/ files and AGENTS.md from both plans
    const kiroFilesWithReg = pWithReg.files.filter((f) => f.path.startsWith(".kiro/") || f.path === "AGENTS.md");
    const kiroFilesNoReg = pNoReg.files.filter((f) => f.path.startsWith(".kiro/") || f.path === "AGENTS.md");

    // Compare paths: should be identical
    const pathsWithReg = kiroFilesWithReg.map((f) => f.path).sort();
    const pathsNoReg = kiroFilesNoReg.map((f) => f.path).sort();
    expect(pathsWithReg).toEqual(pathsNoReg);

    // Compare contents: should be identical
    for (const f1 of kiroFilesWithReg) {
      const f2 = kiroFilesNoReg.find((f) => f.path === f1.path);
      expect(f2).toBeDefined();
      expect(f1.content.toString("utf8")).toBe(f2!.content.toString("utf8"));
    }

    // Compare warnings: should be identical (same skip warnings for kiro and agents-md)
    // Filter out any warnings that are about the registration itself
    const regWarningsWithReg = pWithReg.warnings.filter((w) => !w.includes("registration"));
    const regWarningsNoReg = pNoReg.warnings.filter((w) => !w.includes("registration"));
    expect(regWarningsWithReg).toEqual(regWarningsNoReg);
  });

  it("8. Task 01's pins stay green unmodified", async () => {
    // This test verifies that a Forge with no registration produces the same bytes as at 0.34.2.
    // The actual pin file test is in test/pins.test.ts; this is a sanity check.

    // A Forge with only authEnv (no registration) should produce the same example file
    const p = await planFor([fixtureM()]);
    const actual = text(p, EX);
    expect(actual).toBe(`{
  "env": {
    "ACME_TOKEN": ""
  }
}
`);

    // A Forge with neither authEnv nor registration should produce no example file
    const noAuthEnv: IngredientSpec = {
      meta: {
        type: "mcp",
        name: "simple",
        server: { command: "npx" },
      },
    };
    const p2 = await planFor([noAuthEnv]);
    expect(p2.files.some((f) => f.path === EX)).toBe(false);
  });
});
