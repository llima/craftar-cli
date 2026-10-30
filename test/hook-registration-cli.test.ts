/**
 * Spec 43 §4.3, §8, acceptance 3, 4, 11 — hook registration params and credentials through the CLI.
 * Each test is run BEFORE the code to prove it catches the behaviour.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listFiles } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, tmpDir, type ForgeSpec, type IngredientSpec, type WorkspaceSpec } from "./helpers/forge.js";
import { forgeAt } from "./helpers/integrations.js";

// Assembled at runtime so it never reaches a git search (spec 34 convention).
const GHP = "ghp_" + "x".repeat(36);

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Create a Forge at schema 1 (no schema bump needed for hooks) and a workspace. */
async function forgeWith(spec: ForgeSpec, ws: WorkspaceSpec = { config: { profile: "acme" } }) {
  const s = await forgeAt(1, spec, ws);
  cleanups.push(s.cleanup);
  return { ...s, env: { CRAFTAR_HOME: path.join(s.root, "home") } };
}

/** Fixture H with a custom params block. */
const hookWith = (params: Record<string, unknown>, registration?: unknown[]): IngredientSpec => ({
  meta: {
    type: "hook",
    name: "guard-path",
    files: ["guard-path.py"],
    params,
    registration: registration ?? [
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

/** A hook ingredient with no default for the declared param. */
const hookNoDefault = (): IngredientSpec => hookWith({ "hooks.python": {} });

/** Fixture H from preamble. */
const fixtureH = (): IngredientSpec => hookWith({ "hooks.python": { default: "python3" } });

describe("hook registration params through the CLI (spec 43 §4.3, §8, acceptance 3, 4, 11)", () => {
  it("1. unset declared param: sync --check exits 1, stderr holds key, declared by, and fix", async () => {
    const forge: ForgeSpec = {
      ingredients: [hookNoDefault()],
      recipes: [recipe("base", ["hook/guard-path"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const s = await forgeWith(forge);

    // sync --check
    const check = runCli(["sync", "--check", "--workspace", s.wsRoot], { env: s.env });
    expect(check.code).toBe(1);
    expect(check.stderr).toContain("hooks.python");
    expect(check.stderr).toContain("declared by hook/guard-path");
    expect(check.stderr).toContain("fix: set each under params in the profile, or under overrides.params in craftar.yaml");

    // sync
    const sync = runCli(["sync", "--workspace", s.wsRoot], { env: s.env });
    expect(sync.code).toBe(1);
    // No file written
    const files = await listFiles(s.wsRoot);
    expect(files.sort()).toEqual(["craftar.yaml"]);

    // status
    const status = runCli(["status", "--workspace", s.wsRoot], { env: s.env });
    expect(status.code).toBe(1);

    // diff --exit-code
    const diff = runCli(["diff", "--exit-code", "--workspace", s.wsRoot], { env: s.env });
    expect(diff.code).toBe(1);

    // doctor --json
    const doctor = runCli(["doctor", "--json", "--workspace", s.wsRoot], { env: s.env });
    expect(doctor.code).toBe(1);
    const checks: Array<{ id: string; level: string }> = JSON.parse(doctor.stdout).checks;
    const paramsCheck = checks.find((c) => c.id === "params");
    expect(paramsCheck?.level).toBe("error");
  });

  it("2. craftar.local.yaml sets the param: sync exits 0, example file handler command is the value", async () => {
    const forge: ForgeSpec = {
      ingredients: [hookNoDefault()],
      recipes: [recipe("base", ["hook/guard-path"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const s = await forgeWith(forge, {
      config: { profile: "acme" },
      local: { overrides: { params: { "hooks.python": "python" } } },
    });

    const sync = runCli(["sync", "--workspace", s.wsRoot], { env: s.env });
    expect(sync.code).toBe(0);

    // Check the example file
    const examplePath = path.join(s.wsRoot, ".claude/settings.craftar.example.json");
    const example = JSON.parse(await fs.readFile(examplePath, "utf8"));
    expect(example.hooks.PreToolUse[0].hooks[0].command).toBe("python");
  });

  it("3. two hooks: A declares key with default, B cites without declaring — B stays braces, warning only when layer values it", async () => {
    // Hook A: declares hooks.python with default "python3"
    const hookA: IngredientSpec = {
      meta: {
        type: "hook",
        name: "hook-a",
        files: ["a.sh"],
        params: { "hooks.python": { default: "python3" } },
        registration: [{ event: "PreToolUse", command: "{{hooks.python}}" }],
      },
      files: { "a.sh": "echo a\n" },
    };
    // Hook B: cites {{hooks.python}} without declaring it
    const hookB: IngredientSpec = {
      meta: {
        type: "hook",
        name: "hook-b",
        files: ["b.sh"],
        registration: [
          { event: "Stop", command: "{{hooks.python}}" },
          { event: "SessionStart", command: "{{hooks.python}}" }, // two entries citing the same key
        ],
      },
      files: { "b.sh": "echo b\n" },
    };

    // Case 1: no layer sets hooks.python → B stays braces, NO warning (silent case)
    const forge1: ForgeSpec = {
      ingredients: [hookA, hookB],
      recipes: [recipe("base", ["hook/hook-a", "hook/hook-b"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const s1 = await forgeWith(forge1);
    const sync1 = runCli(["sync", "--workspace", s1.wsRoot], { env: s1.env });
    expect(sync1.code).toBe(0);

    const example1 = JSON.parse(await fs.readFile(path.join(s1.wsRoot, ".claude/settings.craftar.example.json"), "utf8"));
    // A's command is substituted (python3)
    expect(example1.hooks.PreToolUse[0].hooks[0].command).toBe("python3");
    // B's command stays braces
    expect(example1.hooks.Stop[0].hooks[0].command).toBe("{{hooks.python}}");
    expect(example1.hooks.SessionStart[0].hooks[0].command).toBe("{{hooks.python}}");

    // No warning about undeclared key (silent case: not declared, not valued)
    expect(sync1.stdout).not.toContain("hooks.python");
    expect(sync1.stderr).not.toContain("hooks.python");

    // Case 2: profile sets hooks.python: py → B stays braces, exactly one warning
    const forge2: ForgeSpec = {
      ingredients: [hookA, hookB],
      recipes: [recipe("base", ["hook/hook-a", "hook/hook-b"])],
      profiles: [profile("acme", ["base"], ["claude-code"], { params: { "hooks.python": "py" } })],
    };
    const s2 = await forgeWith(forge2);
    const sync2 = runCli(["sync", "--workspace", s2.wsRoot], { env: s2.env });
    expect(sync2.code).toBe(0);

    const example2 = JSON.parse(await fs.readFile(path.join(s2.wsRoot, ".claude/settings.craftar.example.json"), "utf8"));
    // A's command is substituted (py from profile)
    expect(example2.hooks.PreToolUse[0].hooks[0].command).toBe("py");
    // B's command stays braces (not declared by B)
    expect(example2.hooks.Stop[0].hooks[0].command).toBe("{{hooks.python}}");
    expect(example2.hooks.SessionStart[0].hooks[0].command).toBe("{{hooks.python}}");

    // Exactly one warning about undeclared key with a value
    const expectedWarning = "hook/hook-b: registration cites {{hooks.python}}, which has a value but is not declared in the ingredient's params — left verbatim";
    const warningMatches = (sync2.stdout + sync2.stderr).split(expectedWarning).length - 1;
    expect(warningMatches).toBe(1);
  });

  it("4. credential: profile param is a token → sync exits 1, stderr contains field but NOT the token", async () => {
    // Hook that declares tok and uses it in args
    const hookWithTok: IngredientSpec = {
      meta: {
        type: "hook",
        name: "guard-path",
        files: ["guard-path.py"],
        params: { tok: {} },
        registration: [
          {
            event: "PreToolUse",
            command: "python3",
            args: ["--token={{tok}}"],
            timeout: 10,
          },
        ],
      },
      files: { "guard-path.py": 'print("ok")\n' },
    };

    const forge: ForgeSpec = {
      ingredients: [hookWithTok],
      recipes: [recipe("base", ["hook/guard-path"])],
      profiles: [profile("acme", ["base"], ["claude-code"], { params: { tok: GHP } })],
    };
    const s = await forgeWith(forge);

    const sync = runCli(["sync", "--workspace", s.wsRoot], { env: s.env });
    expect(sync.code).toBe(1);
    expect(sync.stderr).toContain("registration[0].args[0]");
    expect(sync.stderr).toContain("have the hook read it from the environment");
    // The token must NOT appear in stdout or stderr
    expect(sync.stdout).not.toContain(GHP);
    expect(sync.stderr).not.toContain(GHP);

    // No example file written
    const files = await listFiles(s.wsRoot);
    expect(files.sort()).toEqual(["craftar.yaml"]);
  });

  it("5. entropy: a 40-char random-looking value warns but sync exits 0", async () => {
    // Build a high-entropy string at runtime (not a known token format, so it warns instead of refusing)
    const entropy = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0";

    const hookWithEntropy: IngredientSpec = {
      meta: {
        type: "hook",
        name: "guard-path",
        files: ["guard-path.py"],
        params: { secret: {} },
        registration: [
          {
            event: "PreToolUse",
            command: "python3",
            args: ["--secret={{secret}}"],
          },
        ],
      },
      files: { "guard-path.py": 'print("ok")\n' },
    };

    const forge: ForgeSpec = {
      ingredients: [hookWithEntropy],
      recipes: [recipe("base", ["hook/guard-path"])],
      profiles: [profile("acme", ["base"], ["claude-code"], { params: { secret: entropy } })],
    };
    const s = await forgeWith(forge);

    const sync = runCli(["sync", "--workspace", s.wsRoot], { env: s.env });
    expect(sync.code).toBe(0);

    // Exactly one warning about high-entropy-value
    const combined = sync.stdout + sync.stderr;
    expect(combined).toContain("may be a secret (high-entropy-value)");
    expect(combined).toContain("registration[0].args[0]");
    // The value must NOT appear
    expect(combined).not.toContain(entropy);
  });

  it("6. an ingredient's default does not reach another ingredient: A declares k default one, B declares k no default → B refuses", async () => {
    // Hook A: declares k with default "one"
    const hookA: IngredientSpec = {
      meta: {
        type: "hook",
        name: "hook-a",
        files: ["a.sh"],
        params: { k: { default: "one" } },
        registration: [{ event: "PreToolUse", command: "{{k}}" }],
      },
      files: { "a.sh": "echo a\n" },
    };
    // Hook B: declares k with no default, cites it
    const hookB: IngredientSpec = {
      meta: {
        type: "hook",
        name: "hook-b",
        files: ["b.sh"],
        params: { k: {} },
        registration: [{ event: "Stop", command: "{{k}}" }],
      },
      files: { "b.sh": "echo b\n" },
    };

    const forge: ForgeSpec = {
      ingredients: [hookA, hookB],
      recipes: [recipe("base", ["hook/hook-a", "hook/hook-b"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    };
    const s = await forgeWith(forge);

    // sync should fail because B's k has no value (A's default does not reach B)
    const sync = runCli(["sync", "--workspace", s.wsRoot], { env: s.env });
    expect(sync.code).toBe(1);
    expect(sync.stderr).toContain("k");
    expect(sync.stderr).toContain("declared by hook/hook-b");

    // No file written
    const files = await listFiles(s.wsRoot);
    expect(files.sort()).toEqual(["craftar.yaml"]);
  });
});
