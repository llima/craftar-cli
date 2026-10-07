import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import { planInit, type InitInput } from "../src/core/init.js";
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
