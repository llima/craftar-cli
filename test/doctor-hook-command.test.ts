/**
 * doctor's hook-command check: a hook registration whose command names a program not on PATH
 * (an install test on Ubuntu, where `python` is not installed and `python3` is).
 */
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { hookProgram, runDoctor, shownProgram, type Check, type DoctorOptions } from "../src/core/doctor.js";
import { makeForge, makeWorkspace, profile, recipe, type ForgeSpec, type IngredientSpec } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";

const WIN = process.platform === "win32";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

let home: string;
let claudeDir: string;
/** A PATH of one directory holding `python3` and `node`, executables (stubs). */
let binDir: string;

beforeAll(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), "craftar-home-"));
  claudeDir = mkdtempSync(path.join(os.tmpdir(), "craftar-claude-"));
  binDir = mkdtempSync(path.join(os.tmpdir(), "craftar-bin-"));
  for (const name of ["python3", "node"]) {
    const file = path.join(binDir, WIN ? `${name}.exe` : name);
    await fs.writeFile(file, "");
    if (!WIN) await fs.chmod(file, 0o755);
  }
});

afterAll(async () => {
  await removeWithRetry(home);
  await removeWithRetry(claudeDir);
  await removeWithRetry(binDir);
});

type Reg = { event: string; matcher?: string; command: string; args?: string[]; shell?: "bash" | "powershell" };
const hook = (name: string, registration: Reg[], params?: Record<string, { default?: string }>): IngredientSpec => ({
  meta: { type: "hook", name, files: [`${name}.py`], registration, ...(params ? { params } : {}) },
  files: { [`${name}.py`]: 'print("ok")\n' },
});

const run = (o: Partial<DoctorOptions> & { workspace: string }) =>
  runDoctor({
    version: "0.0.0",
    fetch: false,
    strict: false,
    registryOff: false,
    env: { PATH: binDir },
    nodeVersion: "22.11.0",
    gitVersion: async () => "2.53.0",
    home,
    claudeUserDir: claudeDir,
    ...o,
  });

const of = (checks: Check[], id: string) => checks.filter((c) => c.id === id);

async function fixture(ingredients: IngredientSpec[]) {
  const root = mkdtempSync(path.join(os.tmpdir(), "craftar-doctor-hook-command-"));
  cleanups.push(() => removeWithRetry(root));
  const forge: ForgeSpec = {
    ingredients,
    recipes: [recipe("base", ingredients.map((i) => `${i.meta.type}/${i.meta.name}`))],
    profiles: [profile("acme", ["base"], ["claude-code"])],
  };
  const forgeRoot = path.join(root, "forge");
  await makeForge(forgeRoot, forge);
  const wsRoot = path.join(root, "ws");
  await makeWorkspace(wsRoot, forgeRoot, { config: { profile: "acme" } });
  return wsRoot;
}

describe("hook-command check", () => {
  it("1. a shell-form command whose first word is not on PATH warns, naming the hook and the program", async () => {
    const ws = await fixture([hook("guard", [{ event: "PreToolUse", command: 'python "$CLAUDE_PROJECT_DIR/.claude/hooks/guard.py"' }])]);
    const r = await run({ workspace: ws });
    const found = of(r.checks, "hook-command");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      level: "warn",
      message: "hook/guard: registration 0 (PreToolUse) runs python, which is not on this machine's PATH",
      fix: "install python, or change the hook's command in the Forge to a program this machine has",
    });
  });

  it("2. an exec-form command (with args) is checked whole, after its params render", async () => {
    const ws = await fixture([
      hook("guard", [{ event: "PreToolUse", command: "{{hooks.python}}", args: ["x.py"] }], { "hooks.python": { default: "python" } }),
    ]);
    const found = of((await run({ workspace: ws })).checks, "hook-command");
    expect(found.map((c) => c.message)).toEqual(["hook/guard: registration 0 (PreToolUse) runs python, which is not on this machine's PATH"]);
  });

  it("3. a program on PATH gives no line at all", async () => {
    const ws = await fixture([
      hook("guard", [
        { event: "PreToolUse", command: 'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/guard.py"' },
        { event: "Stop", command: "node", args: ["x.js"] },
      ]),
    ]);
    expect(of((await run({ workspace: ws })).checks, "hook-command")).toEqual([]);
  });

  it("3b. hookProgram reads the program a handler starts, or null when it cannot judge", () => {
    expect(hookProgram({ type: "command", command: "python x.py" })).toBe("python");
    expect(hookProgram({ type: "command", command: "  python3\tx.py" })).toBe("python3");
    expect(hookProgram({ type: "command", command: "python", args: ["x.py"] })).toBe("python");
    expect(hookProgram({ type: "command", command: "python x.py", args: ["y"] })).toBeNull();
    expect(hookProgram({ type: "command", command: "x", shell: "powershell" })).toBeNull();
    expect(hookProgram({ type: "command", command: "VAR=1 python x.py" })).toBeNull();
    expect(hookProgram({ type: "command", command: "a".repeat(65) })).toBeNull();
    expect(hookProgram(null)).toBeNull();
    expect(hookProgram({ command: 3 })).toBeNull();
  });

  it("4. what is not a bare program name is not judged: a path, a variable, quotes, a shell builtin, powershell", async () => {
    const ws = await fixture([
      hook("guard", [
        { event: "PreToolUse", command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/guard.py"' },
        { event: "PreToolUse", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/guard.sh" },
        { event: "PreToolUse", command: "./guard.sh" },
        { event: "PreToolUse", command: "/usr/bin/missing-tool --x" },
        { event: "PreToolUse", command: "'python' guard.py" },
        { event: "PreToolUse", command: "cd .claude/hooks && python3 guard.py" },
        { event: "PreToolUse", command: "exec python3 guard.py" },
        { event: "PreToolUse", command: "pwsh-only-tool -File guard.ps1", shell: "powershell" },
      ]),
    ]);
    expect(of((await run({ workspace: ws })).checks, "hook-command")).toEqual([]);
  });

  it("4b. on Windows a .cmd or .bat on PATH counts, as a hook's shell finds it; elsewhere it does not", async () => {
    await fs.writeFile(path.join(binDir, "shimtool.cmd"), "@echo off\r\n");
    cleanups.push(() => fs.rm(path.join(binDir, "shimtool.cmd"), { force: true }));
    const ws = await fixture([hook("guard", [{ event: "PreToolUse", command: "shimtool guard.py" }])]);
    const found = of((await run({ workspace: ws })).checks, "hook-command");
    expect(found.map((c) => c.message)).toEqual(WIN ? [] : ["hook/guard: registration 0 (PreToolUse) runs shimtool, which is not on this machine's PATH"]);
  });

  it("5. no PATH in the environment: nothing can be judged, no line", async () => {
    const ws = await fixture([hook("guard", [{ event: "PreToolUse", command: "python guard.py" }])]);
    expect(of((await run({ workspace: ws, env: {} })).checks, "hook-command")).toEqual([]);
  });

  it("6. a first word shaped like a token is never printed", async () => {
    const token = "ghp_" + "x".repeat(36);
    const ws = await fixture([
      hook("guard", [{ event: "PreToolUse", command: "{{hooks.cmd}} guard.py" }], { "hooks.cmd": { default: token } }),
    ]);
    const r = await run({ workspace: ws });
    // The plan refuses the substituted token first (credentialIn), so no hook-command line is reached.
    expect(of(r.checks, "plan")[0]?.level).toBe("error");
    expect(of(r.checks, "hook-command")).toEqual([]);
    for (const c of r.checks) expect(JSON.stringify(c)).not.toContain(token);
    // The naming rule itself: a first word findSecrets flags is never shown.
    expect(shownProgram(token)).toBe("the first word of its command (not shown)");
    expect(shownProgram("python")).toBe("python");
  });

  it("7. a hook-command line is at most warn, so only --strict changes doctor's exit", async () => {
    const ws = await fixture([hook("guard", [{ event: "PreToolUse", command: "python guard.py" }])]);
    const r = await run({ workspace: ws });
    expect(of(r.checks, "hook-command").every((c) => c.level === "warn")).toBe(true);
  });
});
