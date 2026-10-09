import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import { checkInitFlags, checkLocalKeys, forgeSource, initLine, planInit, type InitInput } from "../src/core/init.js";
import { loadForgeSource } from "../src/core/sync.js";
import { defaultGit, type GitRunner } from "../src/core/remote.js";
import { makeForge, profile, recipe, rule, tmpDir, writeFiles, type ForgeSpec } from "./helpers/forge.js";
import { remoteForge } from "./helpers/remote.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

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

/** A temp dir holding `forge/`; the workspace `ws/` is not created (init creates it). */
async function setup(spec: ForgeSpec = SPEC) {
  const root = await tmpDir("craftar-init-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const forge = path.join(root, "forge");
  await makeForge(forge, spec);
  const ws = path.join(root, "ws");
  const home = path.join(root, "home");
  const run = (input: Partial<InitInput>) => planInit(ws, { forge, profile: "acme", ...input }, { home });
  return { root, forge, ws, home, run };
}

const refused = async (p: Promise<unknown>) => ((await p.then(() => null, (e: Error) => e)) as Error | null)?.message;

describe("planInit — the craftar.yaml it would write (spec 23 §4.2, §5.1)", () => {
  it("a path Forge: forge then profile only, forge relative and POSIX; targets follow the profile", async () => {
    const s = await setup();
    const r = await s.run({});
    expect(r.text).toBe("forge: ../forge\nprofile: acme\n");
    expect(r.targetsFrom).toBe("profile");
    expect(r.notes).toEqual([]);
    expect(r.plan.resolution.recipes).toEqual(["base", "stack-api", "front-a"]);
    expect(r.statuses.map((x) => [x.path, x.state])).toEqual([
      [".claude/rules/api.md", "new"],
      [".claude/rules/base.md", "new"],
      [".claude/rules/front-a.md", "new"],
    ]);
    expect(r.lock).toBeNull();
    // planInit never writes: the workspace directory is still absent.
    await expect(fs.stat(s.ws)).rejects.toThrow();
  });

  it("each key appears only when given, in the order forge, ref, profile, recipes, targets", async () => {
    const s = await setup();
    expect((await s.run({ targets: ["kiro"] })).text).toBe("forge: ../forge\nprofile: acme\ntargets:\n  - kiro\n");
    expect((await s.run({ targets: ["kiro"] })).targetsFrom).toBe("flag");
    expect((await s.run({ addRecipes: ["extra"] })).text).toBe("forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - extra\n");
    expect((await s.run({ removeRecipes: ["front-a"], addRecipes: ["extra"], targets: ["claude-code", "kiro"] })).text).toBe(
      "forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - extra\n  remove:\n    - front-a\ntargets:\n  - claude-code\n  - kiro\n",
    );
    expect((await s.run({ removeRecipes: ["front-a"] })).text).toBe("forge: ../forge\nprofile: acme\nrecipes:\n  remove:\n    - front-a\n");
    // Both lists end empty: no recipes key.
    expect((await s.run({ addRecipes: ["base"] })).text).toBe("forge: ../forge\nprofile: acme\n");
  });
});

describe("planInit — recipe flags through spec 22's core (spec 23 §4.3)", () => {
  it("removes first, then adds; --replace swaps a slot holder", async () => {
    const s = await setup();
    const r = await s.run({ removeRecipes: ["front-a"], addRecipes: ["front-b"] });
    expect(r.ws.config.recipes).toEqual({ add: ["front-b"], remove: ["front-a"] });
    expect(r.plan.resolution.recipes).toEqual(["base", "stack-api", "front-b"]);
    const swap = await s.run({ addRecipes: ["front-b"], replace: true });
    expect(swap.ws.config.recipes).toEqual({ add: ["front-b"], remove: ["front-a"] });
    expect(swap.text).toBe("forge: ../forge\nprofile: acme\nrecipes:\n  add:\n    - front-b\n  remove:\n    - front-a\n");
  });

  it("spec 22's refusals, with its messages, and a name in both lists", async () => {
    const s = await setup();
    expect(await refused(s.run({ addRecipes: ["nope"] }))).toBe('recipe "nope" not found in this Forge (base, extra, front-a, front-b, stack-api)');
    expect(await refused(s.run({ addRecipes: ["front-b"] }))).toBe('recipe "front-b" occupies slot "front", held by "front-a" — pass --replace to swap them');
    expect(await refused(s.run({ removeRecipes: ["base"] }))).toBe('recipe "base" comes in through "stack-api" (extends) — remove "stack-api", or change the Forge');
    expect(await refused(s.run({ addRecipes: ["extra", "extra"] }))).toBe('recipe "extra" is named twice');
    expect(await refused(s.run({ addRecipes: ["extra"], removeRecipes: ["extra"] }))).toBe('recipe "extra" is both added and removed');
  });

  it("a call whose every name is a no-op yields a note; a no-op beside a real change yields none", async () => {
    const s = await setup();
    expect((await s.run({ removeRecipes: ["extra"] })).notes).toEqual(["extra is not in use"]);
    expect((await s.run({ addRecipes: ["base", "front-a"] })).notes).toEqual(["base is already in use, front-a is already in use"]);
    expect((await s.run({ removeRecipes: ["extra"], addRecipes: ["base"] })).notes).toEqual(["extra is not in use", "base is already in use"]);
    expect((await s.run({ removeRecipes: ["extra", "front-a"] })).notes).toEqual([]);
    expect((await s.run({ replace: true })).text).toBe("forge: ../forge\nprofile: acme\n");
  });
});

describe("planInit — craftar.local.yaml (spec 23 N10, §6 case 3)", () => {
  const withLocal = async (local: string) => {
    const s = await setup();
    await writeFiles(s.ws, { "craftar.local.yaml": local });
    return s;
  };

  it("forge or profile: refused", async () => {
    expect(await refused((await withLocal("forge: ../forge\n")).run({}))).toBe(
      "craftar.local.yaml sets forge, which would replace --forge — move it aside and re-run init",
    );
    expect(await refused((await withLocal("profile: acme\n")).run({}))).toBe(
      "craftar.local.yaml sets profile, which would replace --profile — move it aside and re-run init",
    );
  });

  it("ref: refused with --ref, merged without it", async () => {
    const s = await withLocal("ref: v1\n");
    expect(await refused(s.run({ forge: "file:///nowhere/forge.git", ref: "main" }))).toBe(
      "craftar.local.yaml sets ref, which would replace --ref — move it aside and re-run init",
    );
    const r = await s.run({});
    expect(r.ws.config.ref).toBe("v1");
    expect(r.text).toBe("forge: ../forge\nprofile: acme\n");
    expect(r.plan.warnings[0]).toBe('ref "v1" is ignored: the Forge is a path (../forge), read as its working tree');
  });

  it("recipes: refused with a recipe flag, accepted without one", async () => {
    const s = await withLocal("recipes:\n  add: [extra]\n");
    const msg = "craftar.local.yaml sets recipes, which would replace --add-recipe / --remove-recipe — move it aside and re-run init";
    expect(await refused(s.run({ addRecipes: ["front-b"], replace: true }))).toBe(msg);
    expect(await refused(s.run({ removeRecipes: ["front-a"] }))).toBe(msg);
    const r = await s.run({});
    expect(r.plan.resolution.recipes).toEqual(["base", "stack-api", "front-a", "extra"]);
    expect(r.text).toBe("forge: ../forge\nprofile: acme\n");
  });

  it("targets: refused with --targets, merged without it and labelled as the local file's", async () => {
    const s = await withLocal("targets: [kiro]\n");
    expect(await refused(s.run({ targets: ["claude-code"] }))).toBe(
      "craftar.local.yaml sets targets, which would replace --targets — move it aside and re-run init",
    );
    const r = await s.run({});
    expect(r.targetsFrom).toBe("local");
    expect(r.plan.resolution.targets).toEqual(["kiro"]);
    expect(r.text).toBe("forge: ../forge\nprofile: acme\n");
  });
});

describe("planInit — the Forge and the flags (spec 23 N3–N11)", () => {
  it("a remote file:// Forge: the URL kept as given, ref written after it", async () => {
    const rf = await remoteForge(SPEC);
    cleanups.push(rf.cleanup);
    const s = await setup();
    expect((await s.run({ forge: rf.url })).text).toBe(`forge: ${rf.url}\nprofile: acme\n`);
    const r = await s.run({ forge: rf.url, ref: "main" });
    expect(r.text).toBe(`forge: ${rf.url}\nref: main\nprofile: acme\n`);
    expect(r.ws.origin.kind).toBe("remote");
  });

  it("a credential in --forge is refused naming the flag, before any load", async () => {
    const s = await setup();
    const m = await refused(s.run({ forge: "https://alice:s3cr3t@example.invalid/acme/forge.git" }));
    expect(m).toBe("--forge holds credentials in the URL — remove them and let git authenticate (credential helper, SSH agent; see README › Remote Forge)");
    // Before the target and local-file checks too.
    await writeFiles(s.ws, { "craftar.local.yaml": "forge: x\n" });
    expect(await refused(s.run({ forge: "u:p@host:path", targets: ["cursor"] }))).toBe(m);
    expect(await fs.readdir(s.home).catch(() => [])).toEqual([]);
  });

  it("--ref with a directory Forge (N11), an unknown target (N7), an unknown profile (N5), a plan failure (N8)", async () => {
    const s = await setup();
    expect(await refused(s.run({ ref: "v1" }))).toBe("--ref goes with a remote Forge — a path Forge is read as its working tree");
    expect(await refused(s.run({ targets: ["claude-code", "cursor"] }))).toBe('unknown target "cursor" (claude-code, kiro, agents-md)');
    expect(await refused(s.run({ profile: "nope" }))).toBe('profile "nope" not found in Forge (acme)');
    expect(await refused(s.run({ profile: "nope", addRecipes: ["extra"] }))).toBe('profile "nope" not found in Forge (acme)');
    const marked = await setup({
      ...SPEC,
      ingredients: [...SPEC.ingredients!.filter((i) => i.meta.name !== "extra"), rule("extra", "<!-- craftar:section s -->\nx\n<!-- /craftar:section -->\n")],
    });
    expect(await refused(marked.run({ addRecipes: ["extra"] }))).toMatch(/^craftar\.forge\.yaml declares schema: 1, but .* holds a section marker — set schema: 2/);
  });

  it("the Forge is loaded under sync's network rule: a remote that cannot be fetched and no cache is refused", async () => {
    const s = await setup();
    const url = pathToFileURL(path.join(s.root, "missing.git")).href;
    expect(await refused(s.run({ forge: url }))).toMatch(new RegExp(`^cannot fetch the Forge ${url.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}: .* — and there is no cached copy to fall back on$`, "s"));
  });
});

describe("planInit with a loaded Forge (spec 28 §5.2, §9.1)", () => {
  const load = async (ws: string, source: string, ref: string | null, home: string) =>
    loadForgeSource(ws, source, ref, { home, mode: "sync" });

  it("path Forge, the same result: comparing with and without loaded for multiple inputs", async () => {
    const s = await setup();
    const inputs = [
      {},
      { targets: ["kiro"] },
      { removeRecipes: ["front-a"], addRecipes: ["front-b"] },
      { addRecipes: ["front-b"], replace: true },
    ] as const;

    for (const input of inputs) {
      const a = await planInit(s.ws, { forge: s.forge, profile: "acme", ...input }, { home: s.home });
      const loaded = await load(s.ws, "../forge", null, s.home);
      const b = await planInit(s.ws, { forge: s.forge, profile: "acme", ...input, loaded }, { home: s.home });
      expect(b.text).toBe(a.text);
      expect(b.notes).toEqual(a.notes);
      expect(b.targetsFrom).toBe(a.targetsFrom);
      expect(b.statuses.map((x) => [x.path, x.state])).toEqual(a.statuses.map((x) => [x.path, x.state]));
      expect(b.plan.warnings).toEqual(a.plan.warnings);
      expect(b.ws.origin).toEqual(a.ws.origin);
      expect(b.ws.config).toEqual(a.ws.config);
    }
    // And verify the first input is not vacuous
    const loaded = await load(s.ws, "../forge", null, s.home);
    const b = await planInit(s.ws, { forge: s.forge, profile: "acme", loaded }, { home: s.home });
    expect(b.text).toBe("forge: ../forge\nprofile: acme\n");
    expect(b.plan.resolution.recipes).toEqual(["base", "stack-api", "front-a"]);
  });

  it("remote Forge, one fetch: loaded is reused by planInit", async () => {
    const rf = await remoteForge(SPEC);
    cleanups.push(rf.cleanup);
    const s = await setup();
    let counter = 0;
    const counting: GitRunner = async (args, opts) => {
      counter++;
      return defaultGit(args, opts);
    };
    const loaded = await loadForgeSource(s.ws, rf.url, null, { home: s.home, mode: "sync", git: counting });
    const afterFirstLoad = counter;
    const init = await planInit(s.ws, { forge: rf.url, profile: "acme", loaded }, { home: s.home, mode: "sync", git: counting });
    expect(counter).toBe(afterFirstLoad); // no extra fetch
    expect(init.text).toBe(`forge: ${rf.url}\nprofile: acme\n`);
    // Control: without loaded, the counter increases
    await planInit(s.ws, { forge: rf.url, profile: "acme" }, { home: s.home, mode: "sync", git: counting });
    expect(counter).toBeGreaterThan(afterFirstLoad);
  });

  it("a wrong loaded is refused: source mismatch and ref mismatch", async () => {
    const s = await setup();
    const forge2 = path.join(s.root, "forge2");
    await makeForge(forge2, SPEC);

    // Source mismatch
    const loaded = await load(s.ws, "../forge", null, s.home);
    await expect(planInit(s.ws, { forge: forge2, profile: "acme", loaded }, { home: s.home })).rejects.toThrow(
      new Error('planInit: the loaded Forge is "../forge", not "../forge2"'),
    );

    // Remote: ref mismatch
    const rf = await remoteForge(SPEC);
    cleanups.push(rf.cleanup);
    const loadedRemote = await loadForgeSource(s.ws, rf.url, null, { home: s.home, mode: "sync" });
    await expect(planInit(s.ws, { forge: rf.url, ref: "main", profile: "acme", loaded: loadedRemote }, { home: s.home })).rejects.toThrow(
      new Error('planInit: the loaded Forge is at ref null, not "main"'),
    );
  });

  it("a path Forge and a local ref: the ignored-ref warning is present", async () => {
    const s = await setup();
    await writeFiles(s.ws, { "craftar.local.yaml": "ref: v1\n" });
    const loaded = await load(s.ws, "../forge", null, s.home);
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme", loaded }, { home: s.home });
    expect(init.plan.warnings[0]).toBe('ref "v1" is ignored: the Forge is a path (../forge), read as its working tree');
    // The same planInit without loaded gives toEqual warnings
    const initWithout = await planInit(s.ws, { forge: s.forge, profile: "acme" }, { home: s.home });
    expect(init.plan.warnings).toEqual(initWithout.plan.warnings);
  });

  it("opts.local is used instead of the file", async () => {
    const s = await setup();
    await writeFiles(s.ws, { "craftar.local.yaml": "targets: [kiro]\n" });

    // With opts.local: { doc: null, keys: [] } the file on disk is not read
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme" }, { home: s.home, local: { doc: null, keys: [] } });
    expect(init.targetsFrom).toBe("profile");
    expect(init.plan.resolution.targets).toEqual(["claude-code"]);

    // Without opts.local: the file on disk is read
    const initWithout = await planInit(s.ws, { forge: s.forge, profile: "acme" }, { home: s.home });
    expect(initWithout.targetsFrom).toBe("local");
    expect(initWithout.plan.resolution.targets).toEqual(["kiro"]);
  });

  it("checkInitFlags: refuses N3, N7, N11, N6 with their messages", () => {
    // N3: credentials in forge
    expect(() => checkInitFlags({ forge: "https://alice:" + "s3" + "cr3t" + "@example.invalid/forge.git" })).toThrow(
      new Error("--forge holds credentials in the URL — remove them and let git authenticate (credential helper, SSH agent; see README › Remote Forge)"),
    );
    // N7: unknown target
    expect(() => checkInitFlags({ targets: ["nope"] })).toThrow(new Error('unknown target "nope" (claude-code, kiro, agents-md)'));
    // N11: ref with path Forge
    expect(() => checkInitFlags({ forge: "../forge", ref: "main" })).toThrow(
      new Error("--ref goes with a remote Forge — a path Forge is read as its working tree"),
    );
    // N6: recipe both added and removed
    expect(() => checkInitFlags({ addRecipes: ["extra"], removeRecipes: ["extra"] })).toThrow(
      new Error('recipe "extra" is both added and removed'),
    );
    // And what it lets through
    expect(() => checkInitFlags({})).not.toThrow();
    expect(() => checkInitFlags({ ref: "main" })).not.toThrow(); // no forge: N11 cannot be known yet
    expect(() => checkInitFlags({ forge: "https://example.com/acme/forge.git", ref: "main" })).not.toThrow();
  });

  it("checkLocalKeys: refuses with N10 messages", () => {
    expect(() => checkLocalKeys(["forge"], { ref: false, recipes: false, targets: false })).toThrow(
      new Error("craftar.local.yaml sets forge, which would replace --forge — move it aside and re-run init"),
    );
    expect(() => checkLocalKeys(["profile"], { ref: false, recipes: false, targets: false })).toThrow(
      new Error("craftar.local.yaml sets profile, which would replace --profile — move it aside and re-run init"),
    );
    // ref: false does not throw, ref: true throws
    expect(() => checkLocalKeys(["ref"], { ref: false, recipes: false, targets: false })).not.toThrow();
    expect(() => checkLocalKeys(["ref"], { ref: true, recipes: false, targets: false })).toThrow(
      new Error("craftar.local.yaml sets ref, which would replace --ref — move it aside and re-run init"),
    );
    // recipes
    expect(() => checkLocalKeys(["recipes"], { ref: false, recipes: true, targets: false })).toThrow(
      new Error("craftar.local.yaml sets recipes, which would replace --add-recipe / --remove-recipe — move it aside and re-run init"),
    );
    // targets
    expect(() => checkLocalKeys(["targets"], { ref: false, recipes: false, targets: true })).toThrow(
      new Error("craftar.local.yaml sets targets, which would replace --targets — move it aside and re-run init"),
    );
  });

  it("forgeSource: returns URL as given, directory as POSIX relative, equal as .", () => {
    expect(forgeSource("/w/ws", "https://example.com/acme/forge.git")).toBe("https://example.com/acme/forge.git");
  });

  it("forgeSource: a directory relative to root", async () => {
    const s = await setup();
    expect(forgeSource(s.ws, s.forge)).toBe("../forge");
    expect(forgeSource(s.forge, s.forge)).toBe(".");
  });

  it("initLine: formats the line correctly", async () => {
    const s = await setup();
    const init = await planInit(s.ws, { forge: s.forge, profile: "acme" }, { home: s.home });
    expect(initLine(init)).toBe("forge ../forge · profile acme · recipes base → stack-api → front-a · targets claude-code (from the profile)");

    const initTargets = await planInit(s.ws, { forge: s.forge, profile: "acme", targets: ["kiro", "claude-code"] }, { home: s.home });
    expect(initLine(initTargets)).toBe("forge ../forge · profile acme · recipes base → stack-api → front-a · targets kiro, claude-code");
  });
});
