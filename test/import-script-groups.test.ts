import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { exists } from "../src/core/forge.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function setup() {
  const root = await tmpDir("craftar-import-groups-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return { root, forge: path.join(root, "forge"), ws: (n: string) => path.join(root, n) };
}
const importInto = (forge: string, workspaceRoot: string, profileName: string) =>
  importClaudeCode({ workspaceRoot, forgeRoot: forge, profileName });
const yaml = async (f: string) => YAML.parse(await fs.readFile(f, "utf8"));

// Detect case-insensitive file system at module load
let caseInsensitiveFs = false;
(async () => {
  const probeTmpDir = await tmpDir("craftar-fs-probe-");
  try {
    await fs.writeFile(path.join(probeTmpDir, "probe.txt"), "probe");
    caseInsensitiveFs = await exists(path.join(probeTmpDir, "PROBE.TXT"));
  } finally {
    await fs.rm(probeTmpDir, { recursive: true, force: true });
  }
})();

describe("import groups scripts/hooks by base name", () => {
  it("1. two scripts with one base name become one ingredient listing both", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), {
      ".claude/scripts/run-x.ps1": "Write-Host hi\n",
      ".claude/scripts/run-x.sh": "echo hi\n",
    });
    const r = await importInto(t.forge, t.ws("a"), "acme");

    // No variants — both files in one ingredient
    expect(r.variants).toEqual([]);

    // script/run-x created, no script/run-x--acme
    expect(r.created).toContain("script/run-x");
    expect(r.created.filter((c) => c.startsWith("script/run-x--"))).toEqual([]);

    // ingredient.yaml has both files
    const meta = await yaml(path.join(t.forge, "ingredients/scripts/run-x/ingredient.yaml"));
    expect(meta.files).toEqual(["run-x.ps1", "run-x.sh"]);

    // Both files exist
    expect(await exists(path.join(t.forge, "ingredients/scripts/run-x/run-x.ps1"))).toBe(true);
    expect(await exists(path.join(t.forge, "ingredients/scripts/run-x/run-x.sh"))).toBe(true);

    // No variant folder
    expect(await exists(path.join(t.forge, "ingredients/scripts/run-x--acme"))).toBe(false);
  });

  it("2. names that differ only in case group (Windows-shaped)", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), {
      ".claude/scripts/X.PS1": "Write-Host x\n",
      ".claude/scripts/x.sh": "echo x\n",
    });
    const r = await importInto(t.forge, t.ws("a"), "acme");

    // Both have base name "x" (lowercase), so they group
    expect(r.variants).toEqual([]);
    expect(r.created).toContain("script/x");
    expect(r.created.filter((c) => c.startsWith("script/x--"))).toEqual([]);

    const meta = await yaml(path.join(t.forge, "ingredients/scripts/x/ingredient.yaml"));
    // Files in sorted order: X.PS1 < x.sh
    expect(meta.files).toEqual(["X.PS1", "x.sh"]);
  });

  it("3. hooks group the same way", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), {
      ".claude/hooks/guard.ps1": "Write-Host guard\n",
      ".claude/hooks/guard.sh": "echo guard\n",
    });
    const r = await importInto(t.forge, t.ws("a"), "acme");

    expect(r.variants).toEqual([]);
    expect(r.created).toContain("hook/guard");
    expect(r.created.filter((c) => c.startsWith("hook/guard--"))).toEqual([]);

    const meta = await yaml(path.join(t.forge, "ingredients/hooks/guard/ingredient.yaml"));
    expect(meta.files).toEqual(["guard.ps1", "guard.sh"]);
  });

  it.skipIf(caseInsensitiveFs)(
    "4. two files equal ignoring case are rejected (skipped on a case-insensitive file system)",
    async () => {
      const t = await setup();
      // On a case-sensitive FS, both files can coexist
      await writeFiles(t.ws("a"), {
        ".claude/scripts/run.SH": "echo a\n",
        ".claude/scripts/run.sh": "echo b\n",
      });
      const r = await importInto(t.forge, t.ws("a"), "acme");

      // Should be rejected due to case collision
      expect(r.rejected).toEqual([
        {
          name: "script/run",
          reason: "files run.SH and run.sh differ only in case — they would collide on a case-insensitive checkout",
        },
      ]);

      // No ingredient written
      expect(await exists(path.join(t.forge, "ingredients/scripts/run"))).toBe(false);
    },
  );

  it("5. sync after the import writes both files, with no duplicate-write warning", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), {
      ".claude/scripts/run-x.ps1": "Write-Host hi\n",
      ".claude/scripts/run-x.sh": "echo hi\n",
    });
    await importInto(t.forge, t.ws("a"), "acme");

    // Write craftar.yaml
    const forgeAbs = path.resolve(t.forge);
    await writeFiles(t.ws("a"), {
      "craftar.yaml": `forge: ${forgeAbs}\nprofile: acme\n`,
    });

    const ws = await loadWorkspace(t.ws("a"));
    const p = await plan(ws);

    // Both files planned
    const paths = p.files.map((f) => f.path);
    expect(paths).toContain(".claude/scripts/run-x.ps1");
    expect(paths).toContain(".claude/scripts/run-x.sh");

    // Contents match
    const ps1File = p.files.find((f) => f.path === ".claude/scripts/run-x.ps1")!;
    const shFile = p.files.find((f) => f.path === ".claude/scripts/run-x.sh")!;
    expect(ps1File.content.toString()).toBe("Write-Host hi\n");
    expect(shFile.content.toString()).toBe("echo hi\n");

    // No duplicate-write warning
    expect(p.warnings.some((w) => w.startsWith("two ingredients write"))).toBe(false);
  });

  it("6. a second profile reuses the grouped ingredient", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), {
      ".claude/scripts/run-x.ps1": "Write-Host hi\n",
      ".claude/scripts/run-x.sh": "echo hi\n",
    });
    await importInto(t.forge, t.ws("a"), "acme");

    // Import an identical workspace as beta
    await writeFiles(t.ws("b"), {
      ".claude/scripts/run-x.ps1": "Write-Host hi\n",
      ".claude/scripts/run-x.sh": "echo hi\n",
    });
    const r2 = await importInto(t.forge, t.ws("b"), "beta");

    expect(r2.reused).toContain("script/run-x");
    expect(r2.variants).toEqual([]);
  });

  it("7. a Forge imported before keeps working and a re-import rewrites the old variant", async () => {
    const t = await setup();

    // Build the OLD shape by hand: base with one file, variant with the other
    await writeFiles(t.forge, {
      "craftar.forge.yaml": "name: forge\nschema: 1\n",
      "ingredients/scripts/run-x/ingredient.yaml": YAML.stringify({
        type: "script",
        name: "run-x",
        files: ["run-x.ps1"],
        targets: ["claude-code"],
        tags: [],
      }),
      "ingredients/scripts/run-x/run-x.ps1": "Write-Host hi\n",
      "ingredients/scripts/run-x--acme/ingredient.yaml": YAML.stringify({
        type: "script",
        name: "run-x--acme",
        as: "run-x",
        files: ["run-x.sh"],
        targets: ["claude-code"],
        tags: [],
      }),
      "ingredients/scripts/run-x--acme/run-x.sh": "echo hi\n",
      "recipes/base--acme.yaml": YAML.stringify({
        name: "base--acme",
        ingredients: ["script/run-x--acme"],
      }),
      "profiles/acme/profile.yaml": YAML.stringify({
        name: "acme",
        recipes: ["base--acme"],
        targets: ["claude-code"],
      }),
    });

    // Re-import ws `a` (case 1's files) as acme
    await writeFiles(t.ws("a"), {
      ".claude/scripts/run-x.ps1": "Write-Host hi\n",
      ".claude/scripts/run-x.sh": "echo hi\n",
    });
    const r = await importInto(t.forge, t.ws("a"), "acme");

    // Record for report
    console.log("Case 7 — r.warnings:", r.warnings);
    console.log("Case 7 — r.variants:", r.variants);

    // The variant directory should now have BOTH files
    const variantMeta = await yaml(path.join(t.forge, "ingredients/scripts/run-x--acme/ingredient.yaml"));
    expect(variantMeta.files).toEqual(["run-x.ps1", "run-x.sh"]);

    // Plan the workspace
    const forgeAbs = path.resolve(t.forge);
    await writeFiles(t.ws("a"), {
      "craftar.yaml": `forge: ${forgeAbs}\nprofile: acme\n`,
    });
    const ws = await loadWorkspace(t.ws("a"));
    const p = await plan(ws);

    // Record for report
    console.log("Case 7 — plan warnings:", p.warnings);

    // Both planned files equal sources
    const ps1File = p.files.find((f) => f.path === ".claude/scripts/run-x.ps1")!;
    const shFile = p.files.find((f) => f.path === ".claude/scripts/run-x.sh")!;
    expect(ps1File.content.toString()).toBe("Write-Host hi\n");
    expect(shFile.content.toString()).toBe("echo hi\n");
  });

  it("8. a leftover file in a rewritten script folder is warned", async () => {
    const t = await setup();

    // Forge with base script/run-x [run-x.ps1] with DIFFERENT content so variant is made
    // and an existing variant folder with a stray file
    await writeFiles(t.forge, {
      "craftar.forge.yaml": "name: forge\nschema: 1\n",
      "ingredients/scripts/run-x/ingredient.yaml": YAML.stringify({
        type: "script",
        name: "run-x",
        files: ["run-x.ps1"],
        targets: ["claude-code"],
        tags: [],
      }),
      "ingredients/scripts/run-x/run-x.ps1": "Write-Host OLD\n",
      "ingredients/scripts/run-x--acme/ingredient.yaml": YAML.stringify({
        type: "script",
        name: "run-x--acme",
        as: "run-x",
        files: ["run-x.ps1"],
        targets: ["claude-code"],
        tags: [],
      }),
      "ingredients/scripts/run-x--acme/run-x.ps1": "Write-Host OLD\n",
      "ingredients/scripts/run-x--acme/stale.sh": "echo stale\n",
      "recipes/base.yaml": YAML.stringify({
        name: "base",
        ingredients: ["script/run-x"],
      }),
    });

    // Import ws with only .claude/scripts/run-x.ps1 with NEW content
    await writeFiles(t.ws("a"), {
      ".claude/scripts/run-x.ps1": "Write-Host hi\n",
    });
    const r = await importInto(t.forge, t.ws("a"), "acme");

    // Should warn about the leftover file
    expect(r.warnings).toContain(
      "ingredients/scripts/run-x--acme/stale.sh is not in the files of script/run-x--acme — sync does not write it; remove it by hand",
    );
  });
});
