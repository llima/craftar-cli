import { afterEach, describe, expect, it } from "vitest";
import { promises as fs, mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { importClaudeCode, mergeEmitted, type EmittedSource } from "../src/importers/claude-code.js";
import { exists } from "../src/core/forge.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";

// Synchronous probe at module load: case-insensitive on NTFS/APFS, case-sensitive on most Linux.
const caseInsensitiveFs = (() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "craftar-case-"));
  try {
    writeFileSync(path.join(dir, "probe.txt"), "probe");
    return existsSync(path.join(dir, "PROBE.TXT"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

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

    // The re-import produces a variant (old shape differs from new)
    expect(r.variants).toEqual([{ name: "script/run-x--acme", reason: "differs from script/run-x already in the Forge" }]);

    // The recipe no longer lists script/run-x but lists the variant
    const recipeMeta = await yaml(path.join(t.forge, "recipes/base--acme.yaml"));
    expect(recipeMeta.ingredients).not.toContain("script/run-x");
    expect(recipeMeta.ingredients).toContain("script/run-x--acme");

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

    // No duplicate-write warning
    expect(p.warnings.filter((w) => w.startsWith("two ingredients write"))).toEqual([]);

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

  it("9. a secret in the second file of a group names that file", async () => {
    const t = await setup();
    // Assemble token at runtime to avoid tripping the repo's own secret scanner
    const token = "ghp_" + "x".repeat(36);
    await writeFiles(t.ws("a"), {
      ".claude/scripts/run-x.ps1": "Write-Host hi\n",
      ".claude/scripts/run-x.sh": "echo hi\ntoken=" + token + "\n",
    });
    const r = await importInto(t.forge, t.ws("a"), "acme");

    // The rejection must name the .sh file (where the secret is), not the .ps1 file
    expect(r.rejected).toEqual([
      { name: "script/run-x", reason: "secret-like value (github-token) in .claude/scripts/run-x.sh line 2" },
    ]);

    // No ingredient written
    expect(await exists(path.join(t.forge, "ingredients/scripts/run-x"))).toBe(false);
  });
});

describe("mergeEmitted", () => {
  it("one part is returned as is", () => {
    const part: EmittedSource = {
      meta: { type: "script", name: "x", files: ["x.sh"], targets: ["claude-code"], tags: [] },
      files: { "x.sh": "echo x\n" },
      scan: {},
    };
    const merged = mergeEmitted([part]);
    expect(merged).toBe(part);
  });

  it("three parts: files concatenated in order, union of files/scan, warnings concatenated", () => {
    const a: EmittedSource = {
      meta: { type: "script", name: "x", files: ["a.sh"], targets: ["claude-code"], tags: [], origin: { workspace: "w", path: ".claude/scripts/a.sh" } },
      files: { "a.sh": "echo a\n" },
      scan: { "a.sh": "scanned a" },
      warnings: ["warn a"],
    };
    const b: EmittedSource = {
      meta: { type: "script", name: "x", files: ["b.ps1"], targets: ["claude-code"], tags: [], origin: { workspace: "w", path: ".claude/scripts/b.ps1" } },
      files: { "b.ps1": "Write b\n" },
      scan: {},
    };
    const c: EmittedSource = {
      meta: { type: "script", name: "x", files: ["c.sh"], targets: ["claude-code"], tags: [], origin: { workspace: "w", path: ".claude/scripts/c.sh" } },
      files: { "c.sh": "echo c\n" },
      scan: { "c.sh": "scanned c" },
      warnings: ["warn c"],
    };

    const merged = mergeEmitted([a, b, c]);

    // Meta from first part, files list concatenated
    expect((merged.meta as { files?: string[] }).files).toEqual(["a.sh", "b.ps1", "c.sh"]);

    // Origin is the first part's origin (unchanged)
    expect(merged.meta.origin).toEqual({ workspace: "w", path: ".claude/scripts/a.sh" });

    // Files is the union of all
    expect(merged.files).toEqual({ "a.sh": "echo a\n", "b.ps1": "Write b\n", "c.sh": "echo c\n" });

    // Scan is the union of all
    expect(merged.scan).toEqual({ "a.sh": "scanned a", "c.sh": "scanned c" });

    // Warnings concatenated
    expect(merged.warnings).toEqual(["warn a", "warn c"]);
  });

  it("warnings key absent when no part has warnings", () => {
    const a: EmittedSource = {
      meta: { type: "script", name: "x", files: ["a.sh"], targets: ["claude-code"], tags: [] },
      files: { "a.sh": "echo a\n" },
      scan: {},
    };
    const b: EmittedSource = {
      meta: { type: "script", name: "x", files: ["b.sh"], targets: ["claude-code"], tags: [] },
      files: { "b.sh": "echo b\n" },
      scan: {},
    };

    const merged = mergeEmitted([a, b]);

    expect("warnings" in merged).toBe(false);
  });
});
