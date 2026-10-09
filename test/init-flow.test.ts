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
