import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Spec 51 §4.3: a reader of a Forge's recipe or ingredient maps decides whether it means the root or a profile's view.
 * This scan, by property name and whatever the variable is called, names every file under `src/` that reads one; a new
 * file reading them fails here until §4.3's table (and this list) place it.
 */
const ALLOWED = [
  "src/cli.ts",
  "src/core/catalogue.ts",
  "src/core/init-flow.ts",
  "src/core/integrations.ts",
  "src/core/new-profile.ts",
  "src/core/param-writes.ts",
  "src/core/profile-local.ts",
  "src/core/promote.ts",
  "src/core/recipe-edit.ts",
  "src/core/registry.ts",
  "src/core/report.ts",
  "src/core/resolve.ts",
  "src/core/sync.ts",
  "src/core/unify.ts",
  "src/core/variants.ts",
  "src/core/write-actions.ts",
  "src/emitters/shared.ts",
  "src/importers/claude-code.ts",
  "src/importers/decide.ts",
  "src/importers/drift-promote.ts",
  "src/importers/provided.ts",
];

const READ = /\.(recipes|ingredients)\.(get|has|values|keys|entries)\(|of [A-Za-z.?]*\.(recipes|ingredients)\)|\[\.\.\.[A-Za-z.?]*\.(recipes|ingredients)\]/;

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sources(abs)));
    else if (e.name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

describe("the readers of a Forge's maps (spec 51 §4.3)", () => {
  it("are the files the allow-list names, no more and no fewer", async () => {
    const repo = path.resolve(__dirname, "..");
    const found: string[] = [];
    for (const abs of await sources(path.join(repo, "src"))) {
      if (READ.test(await fs.readFile(abs, "utf8"))) found.push(path.relative(repo, abs).split(path.sep).join("/"));
    }
    expect(found.sort()).toEqual([...ALLOWED].sort());
  });
});
