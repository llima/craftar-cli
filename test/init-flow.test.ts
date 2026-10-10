import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { RegistryEntrySchema, type Registry } from "../src/schema/index.js";
import { lastForge, yesNo, confirmInit, againLine, type InitIo, type OfferedForge, type InitAnswers } from "../src/core/init-flow.js";
import { planInit, type InitInput } from "../src/core/init.js";
import { makeForge, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Scripted io, defined once at the top of the file and used by T5b too. */
function script(answers: Array<string | null>) {
  const asked: string[] = [];      // every question, ask and confirm, in order
  const confirmed: string[] = [];  // the questions that went through io.confirm
  const said: string[] = [];
  let pending = 0;
  const next = async (q: string) => {
    pending++;
    asked.push(q);
    await Promise.resolve();
    pending--;
    if (!answers.length) throw new Error(`no scripted answer left for: ${q}`);
    return answers.shift()!;
  };
  const io: InitIo = { ask: next, confirm: (q) => (confirmed.push(q), next(q)), say: (l) => void said.push(l) };
  return { io, asked, confirmed, said, pending: () => pending, left: () => answers.length };
}

/** Spec 22's shape: `stack-api` extends `base`; `front-a` and `front-b` share slot `front`; `extra` is free. */
const SPEC: ForgeSpec = {
  ingredients: ["base", "api", "front-a", "front-b", "extra"].map((n) => rule(n, `# ${n}\n`)),
  recipes: [
    recipe("base", ["rule/base"]),
    recipe("stack-api", ["rule/api"], { extends: ["base"] }),
    recipe("front-a", ["rule/front-a"], { slot: "front" }),
    recipe("front-b", ["rule/front-b"], { slot: "front" }),
    recipe("extra", ["rule/extra"]),
  ],
  profiles: [profile("acme", ["stack-api", "front-a"])],
};

/** A temp dir holding `forge/`; the workspace `ws/` is created empty (for confirmInit). */
async function setup(spec: ForgeSpec = SPEC) {
  const root = await tmpDir("craftar-init-flow-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const forge = path.join(root, "forge");
  await makeForge(forge, spec);
  const ws = path.join(root, "ws");
  await fs.mkdir(ws, { recursive: true });
  const home = path.join(root, "home");
  return { root, forge, ws, home };
}

/** Build a minimal RegistryEntry, validated through the schema. */
function entry(over: {
  path?: string;
  profile?: string;
  forge: { kind: "path"; source: string; key: string | null } | { kind: "remote"; source: string; key: string; ref: string | null };
  lastSync: string;
}) {
  const base = {
    path: over.path ?? "/ws",
    profile: over.profile ?? "acme",
    forge: {
      kind: over.forge.kind,
      source: over.forge.source,
      key: over.forge.key,
      ref: over.forge.kind === "remote" ? over.forge.ref : null,
      commit: null,
      fromLocalFile: false,
    },
    recipes: ["base"],
    stack: {},
    targets: ["claude-code"],
    lastSync: over.lastSync,
  };
  return RegistryEntrySchema.parse(base);
}

/* ------------------------------------------------------------------ */
/* lastForge                                                           */
/* ------------------------------------------------------------------ */

describe("lastForge", () => {
  it("1. empty registry → null", () => {
    const reg: Registry = { schema: 1, workspaces: [] };
    expect(lastForge(reg, () => true)).toBeNull();
  });

  it("2. two entries — remote more recent → remote offered; swap → path offered", () => {
    const pathEntry = entry({
      forge: { kind: "path", source: "../forge", key: "/f/a" },
      lastSync: "2026-01-02T00:00:00.000Z",
    });
    const remoteEntry = entry({
      forge: { kind: "remote", source: "https://example.com/acme/forge.git", key: "example.com-acme-forge-abc123", ref: "v2" },
      lastSync: "2026-01-03T00:00:00.000Z",
    });
    const reg: Registry = { schema: 1, workspaces: [pathEntry, remoteEntry] };
    expect(lastForge(reg, () => true)).toEqual({ forge: "https://example.com/acme/forge.git", ref: "v2" });

    // Swap lastSync values
    const pathEntry2 = { ...pathEntry, lastSync: "2026-01-03T00:00:00.000Z" };
    const remoteEntry2 = { ...remoteEntry, lastSync: "2026-01-02T00:00:00.000Z" };
    const reg2: Registry = { schema: 1, workspaces: [pathEntry2, remoteEntry2] };
    expect(lastForge(reg2, () => true)).toEqual({ forge: "/f/a", ref: null });
  });

  it("3. most recent path entry's directory is gone → next one offered; key null → skipped", () => {
    const pathGone = entry({
      forge: { kind: "path", source: "../forge", key: "/f/a" },
      lastSync: "2026-01-03T00:00:00.000Z",
    });
    const pathExists = entry({
      forge: { kind: "path", source: "../forge2", key: "/f/b" },
      lastSync: "2026-01-02T00:00:00.000Z",
    });
    const reg: Registry = { schema: 1, workspaces: [pathGone, pathExists] };
    expect(lastForge(reg, (d) => d !== "/f/a")).toEqual({ forge: "/f/b", ref: null });

    // key null → skipped
    const pathNull = entry({
      forge: { kind: "path", source: "../forge", key: null },
      lastSync: "2026-01-03T00:00:00.000Z",
    });
    const reg2: Registry = { schema: 1, workspaces: [pathNull, pathExists] };
    expect(lastForge(reg2, () => true)).toEqual({ forge: "/f/b", ref: null });
  });

  it("4. most recent remote entry has credentials → skipped; no other → null", () => {
    const secret = "s3" + "cr3t";
    const remoteWithCreds = entry({
      forge: { kind: "remote", source: `https://alice:${secret}@example.invalid/f.git`, key: "example-abc", ref: "main" },
      lastSync: "2026-01-03T00:00:00.000Z",
    });
    const reg: Registry = { schema: 1, workspaces: [remoteWithCreds] };
    expect(lastForge(reg, () => true)).toBeNull();
  });

  it("5. path entry is offered by key, never source", () => {
    const pathEntry = entry({
      forge: { kind: "path", source: "../forge", key: "/abs/forge" },
      lastSync: "2026-01-02T00:00:00.000Z",
    });
    const reg: Registry = { schema: 1, workspaces: [pathEntry] };
    const result = lastForge(reg, () => true);
    expect(result).toEqual({ forge: "/abs/forge", ref: null });
  });
});

/* ------------------------------------------------------------------ */
/* confirmInit                                                         */
/* ------------------------------------------------------------------ */

describe("confirmInit", () => {
  it("6. Enter: said, asked, confirmed, result", async () => {
    const s = await setup();
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme" }, { home: s.home });
    const sc = script([""]);
    const result = await confirmInit(init, s.ws, sc.io, { sync: true });
    expect(sc.said).toEqual([
      `craftar init — about to write craftar.yaml in ${s.ws}`,
      "  forge ../forge · profile acme · recipes base → stack-api → front-a · targets claude-code (from the profile)",
      "  first sync: 3 new",
    ]);
    expect(sc.asked).toEqual(["Write craftar.yaml and sync [yes]: "]);
    expect(sc.confirmed).toEqual(["Write craftar.yaml and sync [yes]: "]);
    expect(result).toBe("confirmed");
  });

  it("7. { sync: false } → different question wording", async () => {
    const s = await setup();
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme" }, { home: s.home });
    const sc = script([""]);
    await confirmInit(init, s.ws, sc.io, { sync: false });
    expect(sc.asked).toEqual(["Write craftar.yaml [yes]: "]);
  });

  it("8. YES, y → confirmed; no, N, null → cancelled", async () => {
    const s = await setup();
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme" }, { home: s.home });

    for (const ans of ["YES", "y"]) {
      const sc = script([ans]);
      const result = await confirmInit(init, s.ws, sc.io, { sync: true });
      expect(result).toBe("confirmed");
    }

    for (const ans of ["no", "N", null]) {
      const sc = script([ans]);
      const result = await confirmInit(init, s.ws, sc.io, { sync: true });
      expect(result).toBe("cancelled");
    }
  });

  it("9. maybe then yes → asked twice, said has summary then 'answer yes or no', confirmed", async () => {
    const s = await setup();
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme" }, { home: s.home });
    const sc = script(["maybe", "yes"]);
    const result = await confirmInit(init, s.ws, sc.io, { sync: true });
    expect(sc.asked).toEqual(["Write craftar.yaml and sync [yes]: ", "Write craftar.yaml and sync [yes]: "]);
    expect(sc.said).toEqual([
      `craftar init — about to write craftar.yaml in ${s.ws}`,
      "  forge ../forge · profile acme · recipes base → stack-api → front-a · targets claude-code (from the profile)",
      "  first sync: 3 new",
      "answer yes or no",
    ]);
    expect(result).toBe("confirmed");
  });

  it("10. first sync: nothing to write when statuses is empty", async () => {
    const s = await setup();
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme" }, { home: s.home });
    const emptyInit = { ...init, statuses: [] };
    const sc = script([""]);
    await confirmInit(emptyInit, s.ws, sc.io, { sync: true });
    expect(sc.said[2]).toBe("  first sync: nothing to write");
  });

  it("11. collision in plan → first sync: 2 new, 1 collision", async () => {
    const s = await setup();
    // Create a file that will be a collision
    await fs.mkdir(path.join(s.ws, ".claude", "rules"), { recursive: true });
    await fs.writeFile(path.join(s.ws, ".claude", "rules", "base.md"), "different content\n");
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme" }, { home: s.home });
    const sc = script([""]);
    await confirmInit(init, s.ws, sc.io, { sync: true });
    expect(sc.said[2]).toBe("  first sync: 2 new, 1 collision");
  });

  // Spec 29 §4.1: the first sync of such a plan is refused, so the confirmation says it and offers no sync.
  const UNSET: ForgeSpec = {
    ingredients: [rule("a", "Org: {{org}}\n", { params: { org: { description: "o" } } }), rule("b", "Also {{org}}\n")],
    recipes: [recipe("base", ["rule/a", "rule/b"])],
    profiles: [profile("acme", ["base"])],
  };

  it("12. an unset declared parameter → first sync: refused, and the question offers no sync", async () => {
    const s = await setup(UNSET);
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme" }, { home: s.home });
    const sc = script([""]);
    const result = await confirmInit(init, s.ws, sc.io, { sync: true });
    expect(sc.said).toEqual([
      `craftar init — about to write craftar.yaml in ${s.ws}`,
      "  forge ../forge · profile acme · recipes base · targets claude-code (from the profile)",
      "  first sync: refused — 1 declared parameter(s) have no value (org)",
    ]);
    expect(sc.asked).toEqual(["Write craftar.yaml [yes]: "]);
    expect(result).toBe("confirmed");
  });

  it("13. (control) the same Forge with the value set → first sync: 2 new, and the sync is offered", async () => {
    const s = await setup({ ...UNSET, profiles: [profile("acme", ["base"], ["claude-code"], { params: { org: "acme-inc" } })] });
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme" }, { home: s.home });
    const sc = script([""]);
    await confirmInit(init, s.ws, sc.io, { sync: true });
    expect(sc.said[2]).toBe("  first sync: 2 new");
    expect(sc.asked).toEqual(["Write craftar.yaml and sync [yes]: "]);
  });
});

/* ------------------------------------------------------------------ */
/* againLine                                                           */
/* ------------------------------------------------------------------ */

describe("againLine", () => {
  it("12. minimal with addRecipes and replace", () => {
    const answers: InitAnswers = {
      forge: "../acme-forge",
      profile: "acme",
      addRecipes: ["frontend-react"],
      removeRecipes: [],
      replace: true,
    };
    expect(againLine(answers, { sync: true, offline: false })).toBe(
      "  again craftar init --forge ../acme-forge --profile acme --add-recipe frontend-react --replace",
    );
  });

  it("13. everything", () => {
    const answers: InitAnswers = {
      forge: "https://example.com/acme/forge.git",
      ref: "v2",
      profile: "acme",
      targets: ["kiro", "claude-code"],
      addRecipes: ["x", "y"],
      removeRecipes: ["z"],
      replace: false,
    };
    expect(againLine(answers, { workspace: "ws", sync: false, offline: true })).toBe(
      "  again craftar init --forge https://example.com/acme/forge.git --ref v2 --profile acme --targets kiro,claude-code --remove-recipe z --add-recipe x --add-recipe y --workspace ws --no-sync --offline",
    );
  });

  it("14. targets undefined → no --targets; replace true with no add → no --replace", () => {
    const answers1: InitAnswers = {
      forge: "../forge",
      profile: "acme",
      addRecipes: [],
      removeRecipes: [],
      replace: false,
    };
    expect(againLine(answers1, { sync: true, offline: false })).toBe(
      "  again craftar init --forge ../forge --profile acme",
    );

    const answers2: InitAnswers = {
      forge: "../forge",
      profile: "acme",
      addRecipes: [],
      removeRecipes: [],
      replace: true,
    };
    expect(againLine(answers2, { sync: true, offline: false })).toBe(
      "  again craftar init --forge ../forge --profile acme",
    );
  });

  it("15. quoting: spaces and backslashes", () => {
    const answers: InitAnswers = {
      forge: "/home/dev/my forge",
      profile: "acme",
      addRecipes: [],
      removeRecipes: [],
      replace: false,
    };
    expect(againLine(answers, { workspace: "C:\\work\\acme portal", sync: true, offline: false })).toBe(
      '  again craftar init --forge "/home/dev/my forge" --profile acme --workspace "C:\\work\\acme portal"',
    );

    // backslash alone is quoted too
    const answers2: InitAnswers = {
      forge: "../forge",
      profile: "acme",
      addRecipes: [],
      removeRecipes: [],
      replace: false,
    };
    expect(againLine(answers2, { workspace: "C:\\work\\acme", sync: true, offline: false })).toBe(
      '  again craftar init --forge ../forge --profile acme --workspace "C:\\work\\acme"',
    );
  });

  it("16. Forge with credentials → throws", () => {
    const secret = "s3" + "cr3t";
    const answers: InitAnswers = {
      forge: `https://alice:${secret}@example.invalid/forge.git`,
      profile: "acme",
      addRecipes: [],
      removeRecipes: [],
      replace: false,
    };
    expect(() => againLine(answers, { sync: true, offline: false })).toThrow(
      new Error("againLine: the Forge holds credentials"),
    );
  });
});

/* ------------------------------------------------------------------ */
/* yesNo                                                               */
/* ------------------------------------------------------------------ */

describe("yesNo", () => {
  it("17. yes variants → true; no variants → false; other → null", () => {
    for (const v of ["y", "Y", "yes", "Yes", " YES "]) {
      expect(yesNo(v)).toBe(true);
    }
    for (const v of ["n", "No", "NO "]) {
      expect(yesNo(v)).toBe(false);
    }
    for (const v of ["", "maybe", "1", "ye"]) {
      expect(yesNo(v)).toBeNull();
    }
  });
});

/* ------------------------------------------------------------------ */
/* askInit — T5b tests                                                  */
/* ------------------------------------------------------------------ */

import { existsSync } from "node:fs";
import { checkInitFlags, checkLocalKeys, forgeSource, type InitInput } from "../src/core/init.js";
import { readRegistry } from "../src/core/registry.js";
import { loadForgeSource, type LoadOptions } from "../src/core/sync.js";
import { askInit, type AskResult, type InitGiven } from "../src/core/init-flow.js";
import type { LocalKey } from "../src/core/workspace-yaml.js";
import { remoteForge, type RemoteForge } from "./helpers/remote.js";
import { resolve } from "../src/core/resolve.js";
import { TARGETS } from "../src/schema/index.js";

/** SPEC2 = SPEC + globex profile (for multi-profile tests). */
const SPEC2: ForgeSpec = {
  ...SPEC,
  profiles: [
    ...SPEC.profiles,
    profile("globex", ["base"], ["kiro"], { description: "Globex — services" }),
  ],
};

/** Forge with front-b having description "The other front". */
function specWithDescription(base: ForgeSpec): ForgeSpec {
  return {
    ...base,
    recipes: base.recipes?.map((r) =>
      r.name === "front-b" ? { ...r, description: "The other front" } : r
    ),
  };
}

const SPEC_DESC = specWithDescription(SPEC);
const SPEC2_DESC = specWithDescription(SPEC2);

/** Questions abbreviations expanded. */
const QF = "Forge — a directory or a git URL: ";
const QP = "Profile: ";
const QP1 = "Profile [acme]: ";
const QA = "Adjust the recipes [no]: ";
const QT = "Targets — claude-code, kiro, agents-md, separated by commas [claude-code, from the profile]: ";
const QTk = "Targets — claude-code, kiro, agents-md, separated by commas [kiro, from the profile]: ";

/** Setup for askInit tests. */
async function askSetup(spec: ForgeSpec = SPEC_DESC) {
  const root = await tmpDir("craftar-ask-init-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const forge = path.join(root, "forge");
  await makeForge(forge, spec);
  const ws = path.join(root, "ws");
  // ws is NOT created by setup — tests verify it doesn't get created
  const home = path.join(root, "home");
  return { root, forge, ws, home };
}

describe("askInit", () => {
  it("1. Nothing given, registry empty, four answers", async () => {
    const s = await askSetup();
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };
    const sc = script(["", s.forge, "", "", ""]);
    const result = await askInit(
      s.ws,
      given,
      local,
      sc.io,
      { home: s.home, registryOff: false, exists: existsSync }
    );
    expect(sc.asked).toEqual([QF, QF, QP1, QA, QT]);
    expect(sc.said).toEqual([
      "a Forge is needed — a directory or a git URL",
      `Profiles in ${s.forge}:`,
      "  1) acme",
      "Recipes of acme: base → stack-api → front-a",
    ]);
    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") throw new Error("unexpected");
    // Check input without loaded
    const { loaded, ...inputWithoutLoaded } = result.input;
    expect(inputWithoutLoaded).toEqual({ forge: s.forge, profile: "acme" });
    expect(result.answers).toEqual({
      forge: s.forge,
      profile: "acme",
      addRecipes: [],
      removeRecipes: [],
      replace: false,
    });
    expect(result.input.loaded!.origin.source).toBe("../forge");
    expect(sc.left()).toBe(0);
    // ws still does not exist
    expect(existsSync(s.ws)).toBe(false);
  });

  it("2. The registry's default", async () => {
    const s = await askSetup();
    const r = await remoteForge(SPEC_DESC);
    cleanups.push(r.cleanup);

    // Write registry with two entries: path Forge older, remote newer
    await fs.mkdir(s.home, { recursive: true });
    const registry = {
      schema: 1,
      workspaces: [
        {
          path: "/ws1",
          profile: "acme",
          forge: { kind: "path", source: "../forge", key: s.forge, ref: null, commit: null, fromLocalFile: false },
          recipes: ["base"],
          stack: {},
          targets: ["claude-code"],
          lastSync: "2026-01-02T00:00:00.000Z",
        },
        {
          path: "/ws2",
          profile: "acme",
          forge: { kind: "remote", source: r.url, key: "example-key", ref: "main", commit: null, fromLocalFile: false },
          recipes: ["base"],
          stack: {},
          targets: ["claude-code"],
          lastSync: "2026-01-03T00:00:00.000Z",
        },
      ],
    };
    await fs.writeFile(path.join(s.home, "registry.json"), JSON.stringify(registry));

    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };
    const sc = script(["", "", "", "", ""]);
    const result = await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc.asked[0]).toBe(`Forge — a directory or a git URL [${r.url}]: `);
    expect(sc.asked[1]).toBe("Ref — a branch, a tag or a full SHA [main]: ");
    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") throw new Error("unexpected");
    expect(result.input.ref).toBe("main");

    // Swap lastSync values to make path more recent
    registry.workspaces[0].lastSync = "2026-01-03T00:00:00.000Z";
    registry.workspaces[1].lastSync = "2026-01-02T00:00:00.000Z";
    await fs.writeFile(path.join(s.home, "registry.json"), JSON.stringify(registry));
    const sc2 = script(["", "", "", ""]);
    const result2 = await askInit(s.ws, given, local, sc2.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc2.asked[0]).toBe(`Forge — a directory or a git URL [${s.forge}]: `);
    expect(result2.kind).toBe("answered");
    if (result2.kind !== "answered") throw new Error("unexpected");
    expect(result2.input.forge).toBe(s.forge);

    // With registryOff: true
    const sc3 = script([s.forge, "", "", ""]);
    await askInit(s.ws, given, local, sc3.io, { home: s.home, registryOff: true, exists: existsSync });
    expect(sc3.asked[0]).toBe(QF);

    // With path entry's directory removed and it being the more recent
    const sc4 = script(["", "", "", "", ""]);
    await askInit(s.ws, given, local, sc4.io, { home: s.home, registryOff: false, exists: (d) => d !== s.forge });
    expect(sc4.asked[0]).toBe(`Forge — a directory or a git URL [${r.url}]: `);
  });

  it("3. An unreadable registry", async () => {
    const s = await askSetup();
    await fs.mkdir(s.home, { recursive: true });
    await fs.writeFile(path.join(s.home, "registry.json"), "{");

    // Get the actual error message from readRegistry
    let registryError: string;
    try {
      await readRegistry(s.home);
      throw new Error("should have thrown");
    } catch (e) {
      registryError = (e as Error).message;
      expect(registryError).toMatch(/^cannot read /);
    }

    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };
    const sc = script([s.forge, "", "", ""]);
    await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc.said[0]).toBe(`  warn cannot read the registry (${registryError}) — no Forge is offered`);
    expect(sc.asked[0]).toBe(QF);
  });

  it("4. A credential typed as the Forge", async () => {
    const s = await askSetup();
    const secret = "s3" + "cr3t";
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };
    const sc = script([`https://alice:${secret}@example.invalid/f.git`, s.forge, "", "", ""]);
    const result = await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc.asked).toEqual([QF, QF, QP1, QA, QT]);
    expect(sc.said[0]).toBe("the answer holds credentials in the URL — remove them and let git authenticate");
    // Verify secret is not in any output
    expect(JSON.stringify([sc.asked, sc.said, result])).not.toContain(secret);
    expect(sc.left()).toBe(0);
  });

  it("5. A Forge that does not load", async () => {
    const s = await askSetup();
    const nope = path.join(s.root, "nope");
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };

    // First: missing directory → re-ask with it as default
    const sc = script([nope, s.forge, "", "", ""]);
    await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc.said[0]).toBe(`Forge not found at ${nope}`);
    expect(sc.asked[1]).toBe(`Forge — a directory or a git URL [${nope}]: `);

    // With given.forge = nope → throws
    const given2: InitGiven = { forge: nope, addRecipes: [], removeRecipes: [], replace: false };
    const sc2 = script([]);
    await expect(
      askInit(s.ws, given2, local, sc2.io, { home: s.home, registryOff: false, exists: existsSync })
    ).rejects.toThrow(`Forge not found at ${nope}`);
    expect(sc2.asked).toEqual([]);
  });

  it("6. A file:// Forge, loaded once, nothing pending", async () => {
    const s = await askSetup();
    const r = await remoteForge(SPEC_DESC);
    cleanups.push(r.cleanup);

    // Counting runner
    let fetchCount = 0;
    const pendingValues: number[] = [];
    const countingGit: LoadOptions["git"] = async (args, opts) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileP = promisify(execFile);
      if (args.includes("fetch")) fetchCount++;
      const { stdout } = await execFileP("git", args);
      return stdout;
    };

    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };
    let pendingAtGit: number[] = [];
    const wrappedGit: LoadOptions["git"] = async (args, opts) => {
      pendingAtGit.push(sc.pending());
      return countingGit!(args, opts);
    };
    const sc = script([r.url, "", "", "", ""]);
    const result = await askInit(s.ws, given, local, sc.io, {
      home: s.home,
      registryOff: false,
      exists: existsSync,
      git: wrappedGit,
    });
    expect(sc.asked).toEqual([
      QF,
      "Ref — a branch, a tag or a full SHA [the default branch]: ",
      QP1,
      QA,
      QT,
    ]);
    expect(sc.said).toEqual([
      `Profiles in ${r.url}:`,
      "  1) acme",
      "Recipes of acme: base → stack-api → front-a",
    ]);
    expect(sc.left()).toBe(0);
    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") throw new Error("unexpected");
    expect(result.input.ref).toBe(undefined);

    // planInit should reuse the loaded Forge
    const plan = await planInit(s.ws, result.input, { home: s.home, mode: "sync", git: countingGit, local });
    expect(plan.text).toBe(`forge: ${r.url}\nprofile: acme\n`);
    expect(plan.plan.resolution.recipes).toEqual(["base", "stack-api", "front-a"]);
    expect(fetchCount).toBe(1);
    // Every recorded pending value should be 0
    for (const p of pendingAtGit) {
      expect(p).toBe(0);
    }
    expect(pendingAtGit.length).toBeGreaterThan(0);

    // Second run answering the ref "main"
    fetchCount = 0;
    pendingAtGit = [];
    const sc2 = script([r.url, "main", "", "", ""]);
    const result2 = await askInit(s.ws, given, local, sc2.io, {
      home: s.home,
      registryOff: false,
      exists: existsSync,
      git: wrappedGit,
    });
    expect(sc2.asked).toEqual([
      QF,
      "Ref — a branch, a tag or a full SHA [the default branch]: ",
      QP1,
      QA,
      QT,
    ]);
    expect(sc2.said).toEqual([
      `Profiles in ${r.url}:`,
      "  1) acme",
      "Recipes of acme: base → stack-api → front-a",
    ]);
    expect(sc2.left()).toBe(0);
    expect(result2.kind).toBe("answered");
    if (result2.kind !== "answered") throw new Error("unexpected");
    expect(result2.input.ref).toBe("main");
    const plan2 = await planInit(s.ws, result2.input, { home: s.home, mode: "sync", local });
    expect(plan2.text).toBe(`forge: ${r.url}\nref: main\nprofile: acme\n`);
  });

  it("7. A remote load that fails goes back with both defaults", async () => {
    const s = await askSetup();
    const r = await remoteForge(SPEC_DESC);
    cleanups.push(r.cleanup);

    // Get the expected error message from loadForgeSource
    let loadError: string;
    try {
      await loadForgeSource(s.ws, r.url, "nope-ref", { home: s.home, mode: "sync" });
      throw new Error("should have thrown");
    } catch (e) {
      loadError = (e as Error).message;
    }

    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };
    const sc = script([r.url, "nope-ref", "", "main", "", "", ""]);
    await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc.asked[2]).toBe(`Forge — a directory or a git URL [${r.url}]: `);
    expect(sc.asked[3]).toBe("Ref — a branch, a tag or a full SHA [nope-ref]: ");
    expect(sc.said[0]).toBe(loadError);
  });

  it("8. Profiles", async () => {
    const s = await askSetup(SPEC2_DESC);
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };

    // Check the profiles list — answer "globex"
    const sc = script([s.forge, "globex", "", ""]);
    await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc.asked).toEqual([QF, QP, QA, QTk]);
    expect(sc.said).toEqual([
      `Profiles in ${s.forge}:`,
      "  1) acme",
      "  2) globex  Globex — services",
      "Recipes of globex: base",
    ]);
    expect(sc.left()).toBe(0);

    // Answer "2" → globex
    const sc2 = script([s.forge, "2", "", ""]);
    const result2 = await askInit(s.ws, given, local, sc2.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc2.asked).toEqual([QF, QP, QA, QTk]);
    expect(sc2.said).toEqual([
      `Profiles in ${s.forge}:`,
      "  1) acme",
      "  2) globex  Globex — services",
      "Recipes of globex: base",
    ]);
    expect(sc2.left()).toBe(0);
    expect(result2.kind).toBe("answered");
    if (result2.kind !== "answered") throw new Error("unexpected");
    expect(result2.input.profile).toBe("globex");

    // Answer "globex" → globex (same as sc)
    const sc3 = script([s.forge, "globex", "", ""]);
    const result3 = await askInit(s.ws, given, local, sc3.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc3.asked).toEqual([QF, QP, QA, QTk]);
    expect(sc3.said).toEqual([
      `Profiles in ${s.forge}:`,
      "  1) acme",
      "  2) globex  Globex — services",
      "Recipes of globex: base",
    ]);
    expect(sc3.left()).toBe(0);
    expect(result3.kind).toBe("answered");
    if (result3.kind !== "answered") throw new Error("unexpected");
    expect(result3.input.profile).toBe("globex");

    // Empty → re-ask; "nope" → N5; "acme" → ok
    const sc4 = script([s.forge, "", "nope", "acme", "", ""]);
    const result4 = await askInit(s.ws, given, local, sc4.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc4.asked).toEqual([QF, QP, QP, QP, QA, QT]);
    expect(sc4.said).toEqual([
      `Profiles in ${s.forge}:`,
      "  1) acme",
      "  2) globex  Globex — services",
      "a profile is needed — a name or a number from the list",
      'profile "nope" not found in Forge (acme, globex)',
      "Recipes of acme: base → stack-api → front-a",
    ]);
    expect(sc4.left()).toBe(0);
    expect(result4.kind).toBe("answered");
    if (result4.kind !== "answered") throw new Error("unexpected");
    expect(result4.input.profile).toBe("acme");

    // For globex the targets question reads differently (QTk) and recipes line differs (same as sc)
    const sc5 = script([s.forge, "globex", "", ""]);
    const result5 = await askInit(s.ws, given, local, sc5.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc5.asked).toEqual([QF, QP, QA, QTk]);
    expect(sc5.said).toEqual([
      `Profiles in ${s.forge}:`,
      "  1) acme",
      "  2) globex  Globex — services",
      "Recipes of globex: base",
    ]);
    expect(sc5.left()).toBe(0);

    // With given.profile = "acme" → no Profiles in line and no profile question
    const sc6 = script([s.forge, "", ""]);
    await askInit(s.ws, { ...given, profile: "acme" }, local, sc6.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc6.asked).toEqual([QF, QA, QT]);
    expect(sc6.said).toEqual(["Recipes of acme: base → stack-api → front-a"]);
    expect(sc6.left()).toBe(0);

    // A Forge with a profile literally named "2" and another named "acme" (sorted: "2", "acme"):
    // answering "2" gives the profile "2" (name first)
    const specWith2 = {
      ...SPEC_DESC,
      profiles: [profile("2", ["stack-api", "front-a"]), profile("acme", ["stack-api", "front-a"])],
    };
    const s2 = await askSetup(specWith2);
    const sc7 = script([s2.forge, "2", "", ""]);
    const result7 = await askInit(s2.ws, given, local, sc7.io, { home: s2.home, registryOff: false, exists: existsSync });
    expect(sc7.asked).toEqual([QF, QP, QA, QT]);
    expect(sc7.said).toEqual([
      `Profiles in ${s2.forge}:`,
      "  1) 2",
      "  2) acme",
      "Recipes of 2: base → stack-api → front-a",
    ]);
    expect(sc7.left()).toBe(0);
    expect(result7.kind).toBe("answered");
    if (result7.kind !== "answered") throw new Error("unexpected");
    expect(result7.input.profile).toBe("2");

    // Answer "1" → profile "2" (number 1 in the sorted list)
    const sc8 = script([s2.forge, "1", "", ""]);
    const result8 = await askInit(s2.ws, given, local, sc8.io, { home: s2.home, registryOff: false, exists: existsSync });
    expect(sc8.asked).toEqual([QF, QP, QA, QT]);
    expect(sc8.said).toEqual([
      `Profiles in ${s2.forge}:`,
      "  1) 2",
      "  2) acme",
      "Recipes of 2: base → stack-api → front-a",
    ]);
    expect(sc8.left()).toBe(0);
    expect(result8.kind).toBe("answered");
    if (result8.kind !== "answered") throw new Error("unexpected");
    expect(result8.input.profile).toBe("2");
  });

  it("9. A Forge with no profile", async () => {
    const specNoProfile: ForgeSpec = {
      ingredients: SPEC_DESC.ingredients,
      recipes: SPEC_DESC.recipes,
      profiles: [],
    };
    const s = await askSetup(specNoProfile);
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };
    const sc = script([s.forge]);
    await expect(
      askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync })
    ).rejects.toThrow("the Forge has no profile — add one under profiles/, then re-run init");
    expect(sc.asked).toEqual([QF]);

    // given.profile = "nope" - use a Forge WITH a profile (SPEC_DESC) to get proper error
    const s2 = await askSetup(SPEC_DESC);
    const sc2 = script([s2.forge]);
    await expect(
      askInit(s2.ws, { ...given, profile: "nope" }, local, sc2.io, { home: s2.home, registryOff: false, exists: existsSync })
    ).rejects.toThrow('profile "nope" not found in Forge (acme)');
    expect(sc2.asked.some((q) => q.includes("Adjust the recipes"))).toBe(false);
  });

  it("10. Recipes, adjusted by name and by number", async () => {
    const s = await askSetup();
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };

    const sc = script([s.forge, "", "yes", "front-a", "front-b", ""]);
    const result = await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });

    // Check said from recipes line on
    const recipesIdx = sc.said.indexOf("Recipes of acme: base → stack-api → front-a");
    expect(recipesIdx).toBeGreaterThanOrEqual(0);
    expect(sc.said.slice(recipesIdx)).toEqual([
      "Recipes of acme: base → stack-api → front-a",
      `Recipes in ${s.forge}:`,
      "  1) base · in use",
      "  2) stack-api · in use",
      "  3) front-a · in use · slot front",
      "  4) extra",
      "  5) front-b · slot front · The other front",
      "Recipes: base → stack-api → front-b",
    ]);
    // Check asked after profile
    const profileIdx = sc.asked.findIndex((q) => q.includes("Profile"));
    expect(sc.asked.slice(profileIdx + 1)).toEqual([QA, "Remove [none]: ", "Add [none]: ", QT]);
    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") throw new Error("unexpected");
    expect(result.input.removeRecipes).toEqual(["front-a"]);
    expect(result.input.addRecipes).toEqual(["front-b"]);
    expect(result.input.replace).toBeFalsy();

    // Same with answers by number "y", "3", "5"
    const sc2 = script([s.forge, "", "y", "3", "5", ""]);
    const result2 = await askInit(s.ws, given, local, sc2.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(result2.kind).toBe("answered");
    if (result2.kind !== "answered") throw new Error("unexpected");
    expect(result2.input.removeRecipes).toEqual(["front-a"]);
    expect(result2.input.addRecipes).toEqual(["front-b"]);

    // planInit produces the expected text
    const plan = await planInit(s.ws, result.input, { home: s.home, local });
    expect(plan.text).toBe("forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - front-b\n  remove:\n    - front-a\n");
  });

  it("11. R3 → the replace question", async () => {
    const s = await askSetup();
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };

    const sc = script([s.forge, "", "yes", "", "front-b", "yes", ""]);
    const result = await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });

    const profileIdx = sc.asked.findIndex((q) => q.includes("Profile"));
    expect(sc.asked.slice(profileIdx + 1)).toEqual([
      QA,
      "Remove [none]: ",
      "Add [none]: ",
      'front-b takes the slot "front" that front-a holds — replace front-a [no]: ',
      QT,
    ]);
    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") throw new Error("unexpected");
    expect(result.input.addRecipes).toEqual(["front-b"]);
    expect(result.input.replace).toBe(true);
    expect(sc.said.at(-1)).toBe("Recipes: base → stack-api → front-b");

    // With "no" at the replace question → QA is asked again; answering "" ends with no recipe edit
    const sc2 = script([s.forge, "", "yes", "", "front-b", "no", "", ""]);
    const result2 = await askInit(s.ws, given, local, sc2.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc2.asked.filter((q) => q === QA).length).toBe(2);
    const plan2 = await planInit(s.ws, result2.input, { home: s.home, local });
    expect(plan2.text).toBe("forge: ../forge\nprofile: acme\n");

    // With "" at the replace question → same as "no"
    const sc3 = script([s.forge, "", "yes", "", "front-b", "", "", ""]);
    const result3 = await askInit(s.ws, given, local, sc3.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc3.asked.filter((q) => q === QA).length).toBe(2);
    const plan3 = await planInit(s.ws, result3.input, { home: s.home, local });
    expect(plan3.text).toBe("forge: ../forge\nprofile: acme\n");
  });

  it("12. Two slot conflicts in one Add answer", async () => {
    // Forge with slots front (front-a / front-b) and back (back-a / back-b)
    const specTwoSlots: ForgeSpec = {
      ingredients: [
        rule("base", "# base\n"),
        rule("front-a", "# front-a\n"),
        rule("front-b", "# front-b\n"),
        rule("back-a", "# back-a\n"),
        rule("back-b", "# back-b\n"),
      ],
      recipes: [
        recipe("base", ["rule/base"]),
        recipe("front-a", ["rule/front-a"], { slot: "front" }),
        recipe("front-b", ["rule/front-b"], { slot: "front" }),
        recipe("back-a", ["rule/back-a"], { slot: "back" }),
        recipe("back-b", ["rule/back-b"], { slot: "back" }),
      ],
      profiles: [profile("acme", ["base", "front-a", "back-a"])],
    };
    const s = await askSetup(specTwoSlots);
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };

    const sc = script([s.forge, "", "yes", "", "front-b, back-b", "yes", ""]);
    const result = await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });

    // One replace question (naming front-b / front-a)
    const replaceQuestions = sc.asked.filter((q) => q.includes("takes the slot"));
    expect(replaceQuestions.length).toBe(1);
    expect(replaceQuestions[0]).toBe('front-b takes the slot "front" that front-a holds — replace front-a [no]: ');
    // Final line shows both swapped
    expect(sc.said.at(-1)).toBe("Recipes: base → front-b → back-b");
    expect(result.kind).toBe("answered");
  });

  it("13. Refusals re-ask Adjust the recipes", async () => {
    const s = await askSetup();
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };

    // R2 Add = nope
    const sc = script([s.forge, "", "yes", "", "nope", "no", ""]);
    await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc.said.find((l) => l.includes("nope"))).toBe(
      'recipe "nope" not found in this Forge (base, extra, front-a, front-b, stack-api)'
    );
    expect(sc.asked.filter((q) => q === QA).length).toBe(2);

    // R4 Remove = base
    const sc2 = script([s.forge, "", "yes", "base", "", "no", ""]);
    await askInit(s.ws, given, local, sc2.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc2.said.find((l) => l.includes("comes in through"))).toBe(
      'recipe "base" comes in through "stack-api" (extends) — remove "stack-api", or change the Forge'
    );
    expect(sc2.asked.filter((q) => q === QA).length).toBe(2);

    // R7 Add = extra, extra
    const sc3 = script([s.forge, "", "yes", "", "extra, extra", "no", ""]);
    await askInit(s.ws, given, local, sc3.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc3.said.find((l) => l.includes("named twice"))).toBe('recipe "extra" is named twice');
    expect(sc3.asked.filter((q) => q === QA).length).toBe(2);

    // Both Remove = extra, Add = extra (N6)
    const sc4 = script([s.forge, "", "yes", "extra", "extra", "no", ""]);
    await askInit(s.ws, given, local, sc4.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc4.said.find((l) => l.includes("both added and removed"))).toBe(
      'recipe "extra" is both added and removed'
    );
    expect(sc4.asked.filter((q) => q === QA).length).toBe(2);
  });

  it("14. Every round starts from the profile", async () => {
    const s = await askSetup();
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };

    // Round 1: Remove = front-a, Add = nope (R2); Round 2: yes, Remove = "", Add = extra
    const sc = script([s.forge, "", "yes", "front-a", "nope", "yes", "", "extra", ""]);
    const result = await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc.said.at(-1)).toBe("Recipes: base → stack-api → front-a → extra");
    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") throw new Error("unexpected");
    // input.removeRecipes should NOT be ["front-a"]
    expect(result.input.removeRecipes).not.toEqual(["front-a"]);
  });

  it("15. A no-op", async () => {
    const s = await askSetup();
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };

    const sc = script([s.forge, "", "yes", "", "base", ""]);
    await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc.asked).toEqual([QF, QP1, QA, "Remove [none]: ", "Add [none]: ", QT]);
    expect(sc.said).toEqual([
      `Profiles in ${s.forge}:`,
      "  1) acme",
      "Recipes of acme: base → stack-api → front-a",
      `Recipes in ${s.forge}:`,
      "  1) base · in use",
      "  2) stack-api · in use",
      "  3) front-a · in use · slot front",
      "  4) extra",
      "  5) front-b · slot front · The other front",
      "  note base is already in use",
      "Recipes: base → stack-api → front-a",
    ]);
    expect(sc.left()).toBe(0);
  });

  it("16. Targets", async () => {
    const s = await askSetup();
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };

    // Enter → targets absent
    const sc = script([s.forge, "", "", ""]);
    const result = await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") throw new Error("unexpected");
    expect("targets" in result.input).toBe(false);

    // "claude-code" (equal to profile's) → present
    const sc2 = script([s.forge, "", "", "claude-code"]);
    const result2 = await askInit(s.ws, given, local, sc2.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(result2.kind).toBe("answered");
    if (result2.kind !== "answered") throw new Error("unexpected");
    expect(result2.input.targets).toEqual(["claude-code"]);

    // " kiro , agents-md " → ["kiro", "agents-md"]
    const sc3 = script([s.forge, "", "", " kiro , agents-md "]);
    const result3 = await askInit(s.ws, given, local, sc3.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(result3.kind).toBe("answered");
    if (result3.kind !== "answered") throw new Error("unexpected");
    expect(result3.input.targets).toEqual(["kiro", "agents-md"]);

    // "nope" → N7, then "kiro"
    const sc4 = script([s.forge, "", "", "nope", "kiro"]);
    const result4 = await askInit(s.ws, given, local, sc4.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc4.said.find((l) => l.includes("nope"))).toBe('unknown target "nope" (claude-code, kiro, agents-md)');
    expect(result4.kind).toBe("answered");
    if (result4.kind !== "answered") throw new Error("unexpected");
    expect(result4.input.targets).toEqual(["kiro"]);

    // Get the N7 message for ["kiro", "", ""]
    let n7Message: string;
    try {
      checkInitFlags({ targets: ["kiro", "", ""] });
      throw new Error("should have thrown");
    } catch (e) {
      n7Message = (e as Error).message;
    }

    // "kiro,," → N7-style refusal, then "kiro"
    const sc5 = script([s.forge, "", "", "kiro,,", "kiro"]);
    const result5 = await askInit(s.ws, given, local, sc5.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc5.said.find((l) => l.includes("unknown target"))).toBe(n7Message);
    expect(result5.kind).toBe("answered");
    if (result5.kind !== "answered") throw new Error("unexpected");
    expect(result5.input.targets).toEqual(["kiro"]);
  });

  it("17. Pre-answers skip exactly their question", async () => {
    const s = await askSetup();
    const r = await remoteForge(SPEC_DESC);
    cleanups.push(r.cleanup);
    const local = { doc: null, keys: [] as LocalKey[] };

    // given.forge → [QP1, QA, QT]
    const sc = script(["", "", ""]);
    await askInit(s.ws, { forge: s.forge, addRecipes: [], removeRecipes: [], replace: false }, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc.asked).toEqual([QP1, QA, QT]);

    // given.profile → [QF, QA, QT]
    const sc2 = script([s.forge, "", ""]);
    await askInit(s.ws, { profile: "acme", addRecipes: [], removeRecipes: [], replace: false }, local, sc2.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc2.asked).toEqual([QF, QA, QT]);

    // given.targets = ["kiro"] → [QF, QP1, QA]
    const sc3 = script([s.forge, "", ""]);
    await askInit(s.ws, { targets: ["kiro"], addRecipes: [], removeRecipes: [], replace: false }, local, sc3.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc3.asked).toEqual([QF, QP1, QA]);

    // given.addRecipes = ["extra"] → [QF, QP1, QT] and no Recipes of line
    const sc4 = script([s.forge, "", ""]);
    await askInit(s.ws, { addRecipes: ["extra"], removeRecipes: [], replace: false }, local, sc4.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc4.asked).toEqual([QF, QP1, QT]);
    expect(sc4.said.some((l) => l.includes("Recipes of"))).toBe(false);

    // given.forge = r.url (remote) → ref question is asked
    const sc5 = script(["", "", "", ""]);
    await askInit(s.ws, { forge: r.url, addRecipes: [], removeRecipes: [], replace: false }, local, sc5.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc5.asked[0]).toBe("Ref — a branch, a tag or a full SHA [the default branch]: ");

    // given.forge = r.url, given.ref = "main" → [QP1, QA, QT]
    const sc6 = script(["", "", ""]);
    await askInit(s.ws, { forge: r.url, ref: "main", addRecipes: [], removeRecipes: [], replace: false }, local, sc6.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc6.asked).toEqual([QP1, QA, QT]);
  });

  it("18. --ref beside a directory typed", async () => {
    const s = await askSetup();
    const r = await remoteForge(SPEC_DESC);
    cleanups.push(r.cleanup);
    const given: InitGiven = { ref: "main", addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };

    const sc = script([s.forge, r.url, "", "", ""]);
    await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc.said[0]).toBe("--ref goes with a remote Forge — a path Forge is read as its working tree");
    expect(sc.asked).toEqual([QF, QF, QP1, QA, QT]);
  });

  it("19. craftar.local.yaml", async () => {
    const s = await askSetup();
    const r = await remoteForge(SPEC_DESC);
    cleanups.push(r.cleanup);
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };

    // keys: ["targets"], doc: { targets: ["kiro"] }
    const sc = script([s.forge, "", ""]);
    await askInit(s.ws, given, { doc: { targets: ["kiro"] }, keys: ["targets"] }, sc.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc.asked).toEqual([QF, QP1, QA]);
    expect(sc.said).toEqual([
      `Profiles in ${s.forge}:`,
      "  1) acme",
      "Recipes of acme: base → stack-api → front-a",
      "Targets: kiro (from craftar.local.yaml)",
    ]);
    expect(sc.left()).toBe(0);

    // keys: ["recipes"], doc: { recipes: { add: ["extra"] } }
    const sc2 = script([s.forge, "", ""]);
    await askInit(s.ws, given, { doc: { recipes: { add: ["extra"] } }, keys: ["recipes"] }, sc2.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc2.asked).toEqual([QF, QP1, QT]);
    expect(sc2.said).toEqual([
      `Profiles in ${s.forge}:`,
      "  1) acme",
      "Recipes: base → stack-api → front-a → extra (from craftar.local.yaml)",
    ]);
    expect(sc2.left()).toBe(0);

    // keys: ["ref"], doc: { ref: "main" } with remote Forge
    // Questions: Forge, (Ref skipped - says line), Profile, Adjust, Targets = 4 questions
    const sc3 = script([r.url, "", "", ""]);
    const result3 = await askInit(s.ws, given, { doc: { ref: "main" }, keys: ["ref"] }, sc3.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc3.asked).toEqual([QF, QP1, QA, QT]);
    expect(sc3.said).toEqual([
      "Ref: main (from craftar.local.yaml)",
      `Profiles in ${r.url}:`,
      "  1) acme",
      "Recipes of acme: base → stack-api → front-a",
    ]);
    expect(sc3.left()).toBe(0);
    expect(result3.kind).toBe("answered");
    if (result3.kind !== "answered") throw new Error("unexpected");
    expect(result3.input.ref).toBe(undefined);
    expect(result3.input.loaded!.origin.ref).toBe("main");
    const plan3 = await planInit(s.ws, result3.input, { home: s.home, mode: "sync", local: { doc: { ref: "main" }, keys: ["ref"] } });
    expect(plan3.text).toBe(`forge: ${r.url}\nprofile: acme\n`);

    // keys: ["ref"], doc: { ref: "v1" } with PATH Forge → no "is ignored" line, no Ref: line, no ref question
    const sc4 = script([s.forge, "", "", ""]);
    await askInit(s.ws, given, { doc: { ref: "v1" }, keys: ["ref"] }, sc4.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(sc4.asked).toEqual([QF, QP1, QA, QT]);
    expect(sc4.said).toEqual([
      `Profiles in ${s.forge}:`,
      "  1) acme",
      "Recipes of acme: base → stack-api → front-a",
    ]);
    expect(sc4.left()).toBe(0);
  });

  it("20. N10 before any question", async () => {
    const s = await askSetup();
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };

    // keys: ["forge"]
    const sc = script([]);
    await expect(
      askInit(s.ws, given, { doc: { forge: "../other" }, keys: ["forge"] }, sc.io, { home: s.home, registryOff: false, exists: existsSync })
    ).rejects.toThrow("craftar.local.yaml sets forge, which would replace --forge — move it aside and re-run init");
    expect(sc.asked).toEqual([]);
    expect(sc.said).toEqual([]);

    // keys: ["profile"]
    const sc2 = script([]);
    await expect(
      askInit(s.ws, given, { doc: { profile: "globex" }, keys: ["profile"] }, sc2.io, { home: s.home, registryOff: false, exists: existsSync })
    ).rejects.toThrow("craftar.local.yaml sets profile, which would replace --profile — move it aside and re-run init");
    expect(sc2.asked).toEqual([]);
    expect(sc2.said).toEqual([]);

    // keys: ["targets"] with given.targets = ["kiro"]
    const sc3 = script([]);
    await expect(
      askInit(s.ws, { ...given, targets: ["kiro"] }, { doc: { targets: ["kiro"] }, keys: ["targets"] }, sc3.io, { home: s.home, registryOff: false, exists: existsSync })
    ).rejects.toThrow("craftar.local.yaml sets targets, which would replace --targets — move it aside and re-run init");

    // keys: ["ref"] with given.ref
    const sc4 = script([]);
    await expect(
      askInit(s.ws, { ...given, ref: "main" }, { doc: { ref: "main" }, keys: ["ref"] }, sc4.io, { home: s.home, registryOff: false, exists: existsSync })
    ).rejects.toThrow("craftar.local.yaml sets ref, which would replace --ref — move it aside and re-run init");

    // keys: ["recipes"] with given.addRecipes = ["extra"]
    const sc5 = script([]);
    await expect(
      askInit(s.ws, { ...given, addRecipes: ["extra"] }, { doc: { recipes: { add: [] } }, keys: ["recipes"] }, sc5.io, { home: s.home, registryOff: false, exists: existsSync })
    ).rejects.toThrow("craftar.local.yaml sets recipes, which would replace --add-recipe / --remove-recipe — move it aside and re-run init");
  });

  it("21. Cancel at each question", async () => {
    const s = await askSetup();
    const r = await remoteForge(SPEC_DESC);
    cleanups.push(r.cleanup);
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };

    // The full run with a remote Forge has: Forge, Ref, Profile, Adjust, Targets
    const fullAnswers = [r.url, "main", "", "", ""];
    for (let i = 0; i < fullAnswers.length; i++) {
      const answers = [...fullAnswers.slice(0, i), null];
      const sc = script(answers);
      const result = await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });
      expect(result).toEqual({ kind: "cancelled" });
      expect(sc.left()).toBe(0);
      expect(existsSync(s.ws)).toBe(false);
    }
  });

  it("22. A profile that does not resolve on its own (R5)", async () => {
    // A profile listing two recipes of the same slot
    const specR5: ForgeSpec = {
      ingredients: SPEC_DESC.ingredients,
      recipes: SPEC_DESC.recipes,
      profiles: [profile("broken", ["front-a", "front-b"])],
    };
    const s = await askSetup(specR5);
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };

    // Get the expected error from resolve
    const forge = await import("../src/core/forge.js").then((m) => m.loadForge(s.forge));
    let resolveError: string;
    try {
      resolve(forge, { forge: "../forge", profile: "broken", recipes: { add: [], remove: [] }, targets: [], overrides: { params: {}, sections: {}, ingredients: { disable: [] } } });
      throw new Error("should have thrown");
    } catch (e) {
      resolveError = (e as Error).message;
    }

    const sc = script([s.forge, ""]);
    await expect(
      askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync })
    ).rejects.toThrow(resolveError);
    expect(sc.asked.some((q) => q === QA)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* askInit → planInit (review of T5b)                                  */
/* ------------------------------------------------------------------ */

import { mergeWorkspaceConfig } from "../src/core/sync.js";

/**
 * A temp path or URL as the `again` line carries it. The rule of spec 28 §4.2 step 11, restated here and not
 * taken from `src/`: a value holding a character outside `[A-Za-z0-9_./:@=+,-]` is wrapped in double quotes.
 * A Windows temp path (`C:\\Users\\RUNNER~1\\…`) and its `file://` URL (`%7E`) are quoted; a Linux one is not.
 */
const asArg = (v: string): string => (/^[A-Za-z0-9_./:@=+,-]+$/.test(v) ? v : `"${v}"`);

describe("askInit → planInit (review of T5b)", () => {
  it("1. --ref given, the Forge asked", async () => {
    const s = await askSetup();
    const r = await remoteForge(SPEC_DESC);
    cleanups.push(r.cleanup);

    const given: InitGiven = { ref: "main", addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };
    const sc = script([r.url, "", "", ""]);
    const result = await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") throw new Error("unexpected");

    const plan = await planInit(s.ws, result.input, { home: s.home, mode: "sync", local });
    expect(plan.text).toBe(`forge: ${r.url}\nref: main\nprofile: acme\n`);
    expect(againLine(result.answers, { sync: true, offline: false })).toBe(
      `  again craftar init --forge ${asArg(r.url)} --ref main --profile acme`
    );
  });

  it("2. craftar.local.yaml sets recipes", async () => {
    const s = await askSetup();
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: { recipes: { add: ["extra"] } }, keys: ["recipes"] as LocalKey[] };
    const sc = script([s.forge, "", ""]);
    const result = await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") throw new Error("unexpected");

    // addRecipes and removeRecipes should NOT be in input
    expect("addRecipes" in result.input).toBe(false);
    expect("removeRecipes" in result.input).toBe(false);

    const plan = await planInit(s.ws, result.input, { home: s.home, mode: "sync", local });
    expect(plan.text).toBe("forge: ../forge\nprofile: acme\n");
    expect(plan.plan.resolution.recipes).toEqual(["base", "stack-api", "front-a", "extra"]);
    expect(againLine(result.answers, { sync: true, offline: false })).toBe(
      `  again craftar init --forge ${asArg(s.forge)} --profile acme`
    );
  });

  it("3. stale ref after failed remote load, then a directory", async () => {
    const s = await askSetup();
    const r = await remoteForge(SPEC_DESC);
    cleanups.push(r.cleanup);

    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };
    // Remote fails on nope-ref, then user types the path Forge
    const sc = script([r.url, "nope-ref", s.forge, "", "", ""]);
    const result = await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") throw new Error("unexpected");

    // ref should NOT be in input (the path Forge doesn't use a ref)
    expect("ref" in result.input).toBe(false);

    const plan = await planInit(s.ws, result.input, { home: s.home, mode: "sync", local });
    expect(plan.text).toBe("forge: ../forge\nprofile: acme\n");

    // asked should NOT have a ref question after the LAST Forge question (which has a default)
    // Find the last question that starts with "Forge —"
    const forgeIdx = sc.asked.reduce(
      (last, q, i) => (q.startsWith("Forge —") ? i : last),
      -1
    );
    expect(sc.asked.slice(forgeIdx + 1).some((q) => q.includes("Ref"))).toBe(false);
  });

  it("4. recipe answers are returned as typed, not as resulting lists", async () => {
    const s = await askSetup();
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };

    // R3 with yes: Add front-b, replace front-a
    const sc = script([s.forge, "", "yes", "", "front-b", "yes", ""]);
    const result = await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") throw new Error("unexpected");

    // input.addRecipes should be what was typed, not the final list
    expect(result.input.addRecipes).toEqual(["front-b"]);
    // removeRecipes should NOT be in input since nothing was typed for Remove
    expect("removeRecipes" in result.input).toBe(false);
    expect(result.input.replace).toBe(true);

    expect(againLine(result.answers, { sync: true, offline: false })).toBe(
      `  again craftar init --forge ${asArg(s.forge)} --profile acme --add-recipe front-b --replace`
    );

    const plan = await planInit(s.ws, result.input, { home: s.home, mode: "sync", local });
    expect(plan.text).toBe("forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - front-b\n  remove:\n    - front-a\n");

    // And a no-op: Add = base → result.input.addRecipes ["base"], plan.notes has the note
    const sc2 = script([s.forge, "", "yes", "", "base", ""]);
    const result2 = await askInit(s.ws, given, local, sc2.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(result2.kind).toBe("answered");
    if (result2.kind !== "answered") throw new Error("unexpected");
    expect(result2.input.addRecipes).toEqual(["base"]);

    const plan2 = await planInit(s.ws, result2.input, { home: s.home, mode: "sync", local });
    expect(plan2.notes).toEqual(["base is already in use"]);
    expect(plan2.text).toBe("forge: ../forge\nprofile: acme\n");
  });

  it("5. local document read through schema, never raw", async () => {
    const s = await askSetup();
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    // A string instead of an array for targets
    const local = { doc: { targets: "kiro" }, keys: ["targets"] as LocalKey[] };

    // Get the expected error from mergeWorkspaceConfig
    let mergeError: string;
    try {
      mergeWorkspaceConfig({ forge: "../forge", profile: "acme" }, local.doc);
      throw new Error("should have thrown");
    } catch (e) {
      mergeError = (e as Error).message;
    }
    expect(mergeError).toMatch(/^invalid craftar\.yaml \(merged with craftar\.local\.yaml\)/);

    const sc = script([s.forge, ""]);
    await expect(
      askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync })
    ).rejects.toThrow(mergeError);
  });

  it("6. note of a no-op is one line", async () => {
    const s = await askSetup();
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    const local = { doc: null, keys: [] as LocalKey[] };

    // Remove extra and front-b (neither in use)
    const sc = script([s.forge, "", "yes", "extra, front-b", "", ""]);
    await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });

    // Should have exactly one note line, then the Recipes line
    const noteLines = sc.said.filter((l) => l.startsWith("  note"));
    expect(noteLines).toEqual(["  note extra is not in use, front-b is not in use"]);
    expect(sc.said.at(-1)).toBe("Recipes: base → stack-api → front-a");
  });
});


describe("askInit → local.doc schema error after Forge answer (T5b-fix3)", () => {
  it("(a) schema error in local ref surfaces right after Forge answer", async () => {
    const s = await askSetup();
    const r = await remoteForge(SPEC_DESC);
    cleanups.push(r.cleanup);
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    // ref: 7 is invalid (should be string), and keys: ["ref"] means it will be used
    const local = { doc: { ref: 7 }, keys: ["ref"] as LocalKey[] };

    // Answer the Forge only — no other questions should be asked
    const sc = script([r.url]);
    await expect(
      askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync })
    ).rejects.toThrow(/^invalid craftar\.yaml \(merged with craftar\.local\.yaml\)/);
    // Only the Forge question was asked before the error
    expect(sc.asked).toEqual([QF]);
  });

  it("(b) valid local ref still works unedited", async () => {
    const s = await askSetup();
    const r = await remoteForge(SPEC_DESC);
    cleanups.push(r.cleanup);
    const given: InitGiven = { addRecipes: [], removeRecipes: [], replace: false };
    // valid ref
    const local = { doc: { ref: "main" }, keys: ["ref"] as LocalKey[] };

    const sc = script([r.url, "", "", ""]);
    const result = await askInit(s.ws, given, local, sc.io, { home: s.home, registryOff: false, exists: existsSync });
    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") throw new Error("unexpected");
    // Questions: Forge, Profile, Adjust, Targets (Ref skipped - from local)
    expect(sc.asked).toEqual([QF, QP1, QA, QT]);
    expect(sc.said).toContain("Ref: main (from craftar.local.yaml)");
  });
});

describe("askInit — answers that are not an item (review round 1)", () => {
  const given = (): InitGiven => ({ addRecipes: [], removeRecipes: [], replace: false });
  const local = { doc: null, keys: [] as LocalKey[] };
  const opts = (home: string) => ({ home, registryOff: true, exists: existsSync });

  it("a profile answer that only starts with a number is not that number", async () => {
    const s = await askSetup(SPEC2_DESC);
    for (const wrong of ["2x", "1.5", "2 x ", "+1", "0", "3"]) {
      const sc = script([s.forge, wrong, "acme", "", ""]);
      const result = await askInit(s.ws, given(), local, sc.io, opts(s.home));
      expect(sc.asked).toEqual([QF, QP, QP, QA, QT]);
      expect(sc.said).toEqual([
        `Profiles in ${s.forge}:`,
        "  1) acme",
        "  2) globex  Globex — services",
        `profile "${wrong.trim()}" not found in Forge (acme, globex)`,
        "Recipes of acme: base → stack-api → front-a",
      ]);
      expect(result.kind === "answered" && result.input.profile).toBe("acme");
      expect(sc.left()).toBe(0);
    }
  });

  it("a recipe answer that only starts with a number is kept as typed, so spec 22 names it", async () => {
    const s = await askSetup();
    const sc = script([s.forge, "", "yes", "", "4x", "", ""]);
    await askInit(s.ws, given(), local, sc.io, opts(s.home));
    expect(sc.asked).toEqual([QF, QP1, QA, "Remove [none]: ", "Add [none]: ", QA, QT]);
    expect(sc.said.at(-1)).toBe('recipe "4x" not found in this Forge (base, extra, front-a, front-b, stack-api)');
    expect(sc.left()).toBe(0);
  });

  it("a recipe literally named 2 is reached by its name, not read as position 2", async () => {
    const spec: ForgeSpec = {
      ingredients: ["base", "api", "two"].map((n) => rule(n, `# ${n}\n`)),
      recipes: [recipe("base", ["rule/base"]), recipe("api", ["rule/api"]), recipe("2", ["rule/two"])],
      profiles: [profile("acme", ["base", "api"])],
    };
    const s = await askSetup(spec);
    // The list: 1) base · in use, 2) api · in use, 3) 2 — so "2" as a position would be api, already in use.
    const sc = script([s.forge, "", "yes", "", "2", ""]);
    const result = await askInit(s.ws, given(), local, sc.io, opts(s.home));
    expect(sc.said).toEqual([
      `Profiles in ${s.forge}:`,
      "  1) acme",
      "Recipes of acme: base → api",
      `Recipes in ${s.forge}:`,
      "  1) base · in use",
      "  2) api · in use",
      "  3) 2",
      "Recipes: base → api → 2",
    ]);
    expect(result.kind === "answered" && result.input.addRecipes).toEqual(["2"]);
    expect(sc.left()).toBe(0);
  });

  it("the replace question asks again for anything but yes or no", async () => {
    const s = await askSetup();
    const Q = 'front-b takes the slot "front" that front-a holds — replace front-a [no]: ';
    const sc = script([s.forge, "", "yes", "", "front-b", "maybe", "yes", ""]);
    const result = await askInit(s.ws, given(), local, sc.io, opts(s.home));
    expect(sc.asked).toEqual([QF, QP1, QA, "Remove [none]: ", "Add [none]: ", Q, Q, QT]);
    expect(sc.said.slice(-2)).toEqual(["answer yes or no", "Recipes: base → stack-api → front-b"]);
    expect(result.kind === "answered" && [result.input.addRecipes, result.input.replace]).toEqual([["front-b"], true]);
    expect(sc.left()).toBe(0);
  });

  it("a cancel at Remove, at Add and at the replace question", async () => {
    const s = await askSetup();
    for (const answers of [
      [s.forge, "", "yes", null],
      [s.forge, "", "yes", "", null],
      [s.forge, "", "yes", "", "front-b", null],
    ]) {
      const sc = script(answers);
      expect(await askInit(s.ws, given(), local, sc.io, opts(s.home))).toEqual({ kind: "cancelled" });
      expect(sc.left()).toBe(0);
      expect(existsSync(s.ws)).toBe(false);
    }
  });

  it("a --forge pre-answer holding credentials is refused by the flow itself, never said", async () => {
    const s = await askSetup();
    const secret = "s3" + "cr3t";
    const sc = script([]);
    const p = askInit(s.ws, { ...given(), forge: `https://alice:${secret}@example.invalid/f.git` }, local, sc.io, opts(s.home));
    await expect(p).rejects.toThrow(
      new Error("--forge holds credentials in the URL — remove them and let git authenticate (credential helper, SSH agent; see README › Remote Forge)"),
    );
    expect([sc.asked, sc.said]).toEqual([[], []]);
  });
});
