/**
 * Tests for native targets: the cursor target name, Forge schema 15, lock schema 4.
 * Spec 61 §7.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadForge } from "../src/core/forge.js";
import { loadWorkspace, plan, apply, readLock, status } from "../src/core/sync.js";
import { profile, recipe, scenario, tmpDir, writeFiles, type ForgeSpec, type IngredientSpec, type Scenario } from "./helpers/forge.js";
import { atLeastWin32 } from "./helpers/timeouts.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

/**
 * Helper to create a Forge with a specific schema and ingredient targeting cursor.
 */
async function forgeWithCursor(opts: {
  schema: number;
  ingredientTargets?: string[];
  profileTargets?: string[];
  sectionTargets?: string;
}): Promise<Scenario> {
  const ingredientTargets = opts.ingredientTargets ?? ["cursor"];
  const profileTargets = opts.profileTargets ?? ["claude-code", "cursor"];

  const ingredients: IngredientSpec[] = [
    {
      meta: { type: "rule", name: "style", targets: ingredientTargets },
      files: { "rule.md": "# Style\nBe consistent.\n" },
    },
  ];

  // If sectionTargets is provided, add a rule with a targeted section
  if (opts.sectionTargets) {
    ingredients.push({
      meta: { type: "rule", name: "tone" },
      files: {
        "rule.md": `# Tone\n\n<!-- craftar:section intro targets=${opts.sectionTargets} -->\nBe friendly.\n<!-- /craftar:section -->\n`,
      },
    });
  }

  const recipes = [recipe("base", ingredients.map((i) => `${i.meta.type}/${i.meta.name}`))];
  const profiles = [profile("acme", ["base"], profileTargets as string[])];

  const s = await scenario({ ingredients, recipes, profiles }, { config: { profile: "acme" } });

  // Overwrite craftar.forge.yaml with the requested schema
  await fs.writeFile(
    path.join(s.forgeRoot, "craftar.forge.yaml"),
    YAML.stringify({ name: "test-forge", schema: opts.schema }),
  );

  return s;
}

/**
 * Helper to create a Forge with a profile-level targets that include cursor.
 */
async function forgeWithProfileCursor(schema: number): Promise<Scenario> {
  const ingredients: IngredientSpec[] = [
    {
      meta: { type: "rule", name: "style" }, // default targets: "*"
      files: { "rule.md": "# Style\nBe consistent.\n" },
    },
  ];

  const recipes = [recipe("base", ["rule/style"])];
  const profiles = [profile("acme", ["base"], ["claude-code", "cursor"])];

  const s = await scenario({ ingredients, recipes, profiles }, { config: { profile: "acme" } });

  await fs.writeFile(
    path.join(s.forgeRoot, "craftar.forge.yaml"),
    YAML.stringify({ name: "test-forge", schema }),
  );

  return s;
}

describe("native targets gate (spec 61 §7)", () => {
  it("1. Forge schema 14, ingredient targets: [cursor] → loadForge rejects", { timeout: atLeastWin32(30_000) }, async () => {
    const s = kept(await forgeWithCursor({ schema: 14 }));
    await expect(loadForge(s.forgeRoot)).rejects.toThrow(
      "ingredients/rules/style/ingredient.yaml: targets: cursor needs schema: 15 in craftar.forge.yaml"
    );
  });

  it("2. Forge schema 14, profile targets: [claude-code, cursor] → loadForge rejects", { timeout: atLeastWin32(30_000) }, async () => {
    const s = kept(await forgeWithProfileCursor(14));
    await expect(loadForge(s.forgeRoot)).rejects.toThrow(
      "profiles/acme/profile.yaml: targets: cursor needs schema: 15 in craftar.forge.yaml"
    );
  });

  it("3. Forge schema 14, section targets=cursor → plan() rejects", { timeout: atLeastWin32(30_000) }, async () => {
    // A rule body with <!-- craftar:section intro targets=cursor -->
    const ingredients: IngredientSpec[] = [
      {
        meta: { type: "rule", name: "tone" },
        files: {
          "rule.md": `# Tone\n\n<!-- craftar:section intro targets=cursor -->\nBe friendly.\n<!-- /craftar:section -->\n`,
        },
      },
    ];
    const recipes = [recipe("base", ["rule/tone"])];
    const profiles = [profile("acme", ["base"], ["claude-code"])];

    const s = kept(await scenario({ ingredients, recipes, profiles }, { config: { profile: "acme" } }));
    await fs.writeFile(
      path.join(s.forgeRoot, "craftar.forge.yaml"),
      YAML.stringify({ name: "test-forge", schema: 14 }),
    );

    const ws = await loadWorkspace(s.wsRoot);
    await expect(plan(ws)).rejects.toThrow(
      "section markers in ingredients/rules/tone/rule.md:3: section intro targets=: cursor needs schema: 15 in craftar.forge.yaml"
    );
  });

  it("4. Forge schema 15 with the same three → loads and plans", { timeout: atLeastWin32(30_000) }, async () => {
    // Forge schema 15 with ingredient targets: [cursor], profile targets: [claude-code, cursor], section targets=cursor
    const ingredients: IngredientSpec[] = [
      {
        meta: { type: "rule", name: "style", targets: ["cursor"] },
        files: { "rule.md": "# Style\nBe consistent.\n" },
      },
      {
        meta: { type: "rule", name: "tone" },
        files: {
          "rule.md": `# Tone\n\n<!-- craftar:section intro targets=cursor -->\nBe friendly.\n<!-- /craftar:section -->\n`,
        },
      },
    ];
    const recipes = [recipe("base", ["rule/style", "rule/tone"])];
    const profiles = [profile("acme", ["base"], ["claude-code", "cursor"])];

    const s = kept(await scenario({ ingredients, recipes, profiles }, { config: { profile: "acme" } }));
    await fs.writeFile(
      path.join(s.forgeRoot, "craftar.forge.yaml"),
      YAML.stringify({ name: "test-forge", schema: 15 }),
    );

    const forge = await loadForge(s.forgeRoot);
    expect(forge.manifest.schema).toBe(15);

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);
    expect(p.resolution.targets).toContain("cursor");
  });

  it("5. Forge schema 14, workspace targets: [claude-code, cursor] → plans; warnings; lock schema 4", { timeout: atLeastWin32(60_000) }, async () => {
    // Forge schema 14 with default-targeted ingredients, workspace targets: [claude-code, cursor]
    const ingredients: IngredientSpec[] = [
      {
        meta: { type: "rule", name: "style" }, // default targets: "*"
        files: { "rule.md": "# Style\nBe consistent.\n" },
      },
    ];
    const recipes = [recipe("base", ["rule/style"])];
    const profiles = [profile("acme", ["base"], ["claude-code"])]; // profile targets legacy only

    const s = kept(await scenario(
      { ingredients, recipes, profiles },
      { config: { profile: "acme", targets: ["claude-code", "cursor"] } },
    ));
    await fs.writeFile(
      path.join(s.forgeRoot, "craftar.forge.yaml"),
      YAML.stringify({ name: "test-forge", schema: 14 }),
    );

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);
    
    // Cursor now supports rules, so no skip warning for rule/style
    // (The test verifies that cursor is in the workspace targets and produces files)
    expect(p.files.some((f) => f.target === "cursor" && f.path.endsWith(".mdc"))).toBe(true);

    // Get statuses and apply the plan
    const lock = await readLock(s.wsRoot);
    const statuses = await status(ws, p, lock);
    await apply(ws, p, statuses);

    // Read the lock and check schema
    const lockAfter = await readLock(s.wsRoot);
    expect(lockAfter!.schema).toBe(4);
    expect(lockAfter!.targets).toContain("cursor");
  });

  it("6. Same workspace with targets: [claude-code] → lock schema 2", { timeout: atLeastWin32(60_000) }, async () => {
    const ingredients: IngredientSpec[] = [
      {
        meta: { type: "rule", name: "style" },
        files: { "rule.md": "# Style\nBe consistent.\n" },
      },
    ];
    const recipes = [recipe("base", ["rule/style"])];
    const profiles = [profile("acme", ["base"], ["claude-code"])];

    const s = kept(await scenario(
      { ingredients, recipes, profiles },
      { config: { profile: "acme" } }, // uses profile targets: [claude-code]
    ));
    await fs.writeFile(
      path.join(s.forgeRoot, "craftar.forge.yaml"),
      YAML.stringify({ name: "test-forge", schema: 14 }),
    );

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);
    const lock = await readLock(s.wsRoot);
    const statuses = await status(ws, p, lock);
    await apply(ws, p, statuses);

    const lockAfter = await readLock(s.wsRoot);
    expect(lockAfter!.schema).toBe(2);
    expect(lockAfter!.targets).toEqual(["claude-code"]);
  });

  it("7a. craftar.lock schema 2 with targets: [claude-code, cursor] → readLock throws", { timeout: atLeastWin32(30_000) }, async () => {
    const dir = await tmpDir("craftar-test-lock-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));

    // Write a malformed lock: schema 2 but targets include cursor
    await writeFiles(dir, {
      "craftar.lock": JSON.stringify({
        schema: 2,
        forge: { source: "../forge", ref: null, commit: null },
        profile: "acme",
        recipes: ["base"],
        targets: ["claude-code", "cursor"],
        generatedAt: "2026-11-06T00:00:00.000Z",
        files: [],
      }, null, 2) + "\n",
    });

    await expect(readLock(dir)).rejects.toThrow();
  });

  it("7b. craftar.lock schema 3 with entry target: cursor → readLock throws", { timeout: atLeastWin32(30_000) }, async () => {
    const dir = await tmpDir("craftar-test-lock-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));

    // Write a malformed lock: schema 3 but an entry has target: cursor
    await writeFiles(dir, {
      "craftar.lock": JSON.stringify({
        schema: 3,
        forge: { source: "../forge", ref: null, commit: null },
        profile: "acme",
        recipes: ["base"],
        targets: ["claude-code"],
        generatedAt: "2026-11-06T00:00:00.000Z",
        files: [
          { path: ".cursor/rules/style.md", hash: "sha256:abc", target: "cursor", ingredient: "rule/style" },
        ],
      }, null, 2) + "\n",
    });

    await expect(readLock(dir)).rejects.toThrow();
  });

  it("7c. craftar.lock schema 4 → readLock succeeds", { timeout: atLeastWin32(30_000) }, async () => {
    const dir = await tmpDir("craftar-test-lock-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));

    // Write a valid lock: schema 4 with cursor target
    await writeFiles(dir, {
      "craftar.lock": JSON.stringify({
        schema: 4,
        forge: { source: "../forge", ref: null, commit: null },
        profile: "acme",
        recipes: ["base"],
        targets: ["claude-code", "cursor"],
        generatedAt: "2026-11-06T00:00:00.000Z",
        files: [
          { path: ".claude/rules/style.md", hash: "sha256:abc", target: "claude-code", ingredient: "rule/style" },
        ],
      }, null, 2) + "\n",
    });

    const lock = await readLock(dir);
    expect(lock.schema).toBe(4);
    expect(lock.targets).toContain("cursor");
  });

  it("8. craftar.lock schema 7 → readLock throws with upgrade message", { timeout: atLeastWin32(30_000) }, async () => {
    const dir = await tmpDir("craftar-test-lock-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));

    // Write a future lock: schema 7
    await writeFiles(dir, {
      "craftar.lock": JSON.stringify({
        schema: 7,
        forge: { source: "../forge", ref: null, commit: null },
        profile: "acme",
        recipes: ["base"],
        targets: ["claude-code"],
        generatedAt: "2026-11-06T00:00:00.000Z",
        files: [],
      }, null, 2) + "\n",
    });

    await expect(readLock(dir)).rejects.toThrow("declares schema 7, which this craftar does not read — upgrade craftar");
  });

  it("11. agent-skills in workspace targets at schema 15 → plans and writes lock schema 4", { timeout: atLeastWin32(60_000) }, async () => {
    // Spec 61 §6, Ruling 3: agent-skills target writes to .agents/skills/
    const ingredients: IngredientSpec[] = [
      {
        meta: { type: "skill", name: "analyze", targets: ["agent-skills"] },
        files: { "SKILL.md": "# Analyze\nAnalyze the code.\n" },
      },
    ];
    const recipes = [recipe("base", ["skill/analyze"])];
    const profiles = [profile("acme", ["base"], ["claude-code", "agent-skills"])];

    const s = kept(await scenario(
      { ingredients, recipes, profiles },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(
      path.join(s.forgeRoot, "craftar.forge.yaml"),
      YAML.stringify({ name: "test-forge", schema: 15 }),
    );

    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);
    expect(p.resolution.targets).toContain("agent-skills");

    // Verify agent-skills produces files under .agents/skills/
    expect(p.files.some((f) => f.target === "agent-skills" && f.path.startsWith(".agents/skills/"))).toBe(true);

    const lock = await readLock(s.wsRoot);
    const statuses = await status(ws, p, lock);
    await apply(ws, p, statuses);

    // Lock should be schema 4 (native target in use)
    const lockAfter = await readLock(s.wsRoot);
    expect(lockAfter!.schema).toBe(4);
    expect(lockAfter!.targets).toContain("agent-skills");
  });

  it("9. CRLF: synced workspace, .claude/rules/style.md rewritten with CRLF → status unchanged", { timeout: atLeastWin32(60_000) }, async () => {
    // Create a workspace with cursor target (lock schema 4)
    const ingredients: IngredientSpec[] = [
      {
        meta: { type: "rule", name: "style" },
        files: { "rule.md": "# Style\nBe consistent.\n" },
      },
    ];
    const recipes = [recipe("base", ["rule/style"])];
    const profiles = [profile("acme", ["base"], ["claude-code"])];

    const s = kept(await scenario(
      { ingredients, recipes, profiles },
      { config: { profile: "acme", targets: ["claude-code", "cursor"] } },
    ));
    await fs.writeFile(
      path.join(s.forgeRoot, "craftar.forge.yaml"),
      YAML.stringify({ name: "test-forge", schema: 15 }),
    );

    // Sync the workspace first
    const ws = await loadWorkspace(s.wsRoot);
    const p = await plan(ws);
    const lock = await readLock(s.wsRoot);
    const statuses = await status(ws, p, lock);
    await apply(ws, p, statuses);

    // Verify lock is schema 4
    const lockAfter = await readLock(s.wsRoot);
    expect(lockAfter!.schema).toBe(4);

    // Now rewrite .claude/rules/style.md with CRLF line endings
    const stylePath = path.join(s.wsRoot, ".claude/rules/style.md");
    const original = await fs.readFile(stylePath, "utf8");
    const crlf = original.replace(/\n/g, "\r\n");
    await fs.writeFile(stylePath, crlf);

    // Reload and check status - the file should still be "unchanged" (hashes are normalized)
    const ws2 = await loadWorkspace(s.wsRoot);
    const p2 = await plan(ws2);
    const lock2 = await readLock(s.wsRoot);
    const statuses2 = await status(ws2, p2, lock2);
    
    const styleStatus = statuses2.find((st) => st.path === ".claude/rules/style.md");
    expect(styleStatus?.state).toBe("unchanged");
  });

  it("10. Kept entry with native target → lock stays schema 4 even after removing native target from workspace", { timeout: atLeastWin32(60_000) }, async () => {
    // Spec 61 §7 Correction 3: lock schema 4 must be used when any kept entry has a native target,
    // even if the workspace targets no longer include the native target.
    //
    // Scenario:
    // 1. Workspace with targets: [claude-code, cursor] at schema 15
    // 2. Sync writes entries for both targets, lock schema 4
    // 3. Hand-write lock with entry {path:".cursor/rules/x.mdc", target:"cursor"} as orphan-drift
    // 4. Reduce workspace targets to [claude-code]
    // 5. Apply should produce lock schema 4 (because of the kept cursor entry)
    const ingredients: IngredientSpec[] = [
      {
        meta: { type: "rule", name: "style" },
        files: { "rule.md": "# Style\nBe consistent.\n" },
      },
    ];
    const recipes = [recipe("base", ["rule/style"])];
    const profiles = [profile("acme", ["base"], ["claude-code", "cursor"])];

    const s = kept(await scenario(
      { ingredients, recipes, profiles },
      { config: { profile: "acme" } },
    ));
    await fs.writeFile(
      path.join(s.forgeRoot, "craftar.forge.yaml"),
      YAML.stringify({ name: "test-forge", schema: 15 }),
    );

    // Step 1: Sync with targets [claude-code, cursor]
    const ws1 = await loadWorkspace(s.wsRoot);
    const p1 = await plan(ws1);
    const lock1 = await readLock(s.wsRoot);
    const statuses1 = await status(ws1, p1, lock1);
    await apply(ws1, p1, statuses1);

    // Verify lock is schema 4 with cursor target
    const lockAfter1 = await readLock(s.wsRoot);
    expect(lockAfter1!.schema).toBe(4);
    expect(lockAfter1!.targets).toContain("cursor");

    // Step 2: Hand-write a lock with an orphan cursor entry (simulating a kept entry)
    // This represents a file that was synced but is now orphan-drift (kept until manually deleted)
    const cursorFile = ".cursor/rules/orphan.mdc";
    await writeFiles(s.wsRoot, {
      [cursorFile]: "# Orphan rule\nThis is a hand-written file that becomes orphan-drift.\n",
    });
    const modifiedLock = {
      ...lockAfter1!,
      files: [
        ...lockAfter1!.files,
        { path: cursorFile, hash: "sha256:orphan", target: "cursor" as const, ingredient: "rule/orphan" },
      ],
      generatedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(s.wsRoot, "craftar.lock"), JSON.stringify(modifiedLock, null, 2) + "\n");

    // Step 3: Change workspace targets to [claude-code] only
    await writeFiles(s.wsRoot, {
      "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "acme", targets: ["claude-code"] }),
    });

    // Step 4: Reload, plan, and apply
    const ws2 = await loadWorkspace(s.wsRoot);
    const p2 = await plan(ws2);
    expect(p2.resolution.targets).toEqual(["claude-code"]); // no cursor in targets

    const lock2 = await readLock(s.wsRoot);
    const statuses2 = await status(ws2, p2, lock2);

    // The orphan cursor entry should be skipped (orphan-drift)
    const orphanStatus = statuses2.find((st) => st.path === cursorFile);
    expect(orphanStatus?.state).toBe("orphan-drift");

    await apply(ws2, p2, statuses2);

    // Step 5: Lock should STILL be schema 4 because of the kept cursor entry
    const lockAfter2 = await readLock(s.wsRoot);
    expect(lockAfter2!.schema).toBe(4);
    // Targets in resolution are [claude-code], but lock preserves the entry
    expect(lockAfter2!.targets).toEqual(["claude-code"]);
    // The cursor entry should still be in the lock files
    expect(lockAfter2!.files.some((f) => f.path === cursorFile && f.target === "cursor")).toBe(true);
  });
});
