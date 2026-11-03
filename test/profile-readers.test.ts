/**
 * Spec 54 §6 — the readers of a Forge's `profiles` map, each decided once: a new reader must be placed in this table.
 *
 * - `effective`: reads a profile as its family makes it (`mergedProfile`, `effectiveProfile`, `resolve`, `forgeFor`);
 * - `written`: reads the written file on purpose, to edit it or to tell a written entry from an inherited one;
 * - `concrete`: walks the profiles a workspace may use (`concreteProfiles`, or abstract ones skipped);
 * - `lookup`: a name's existence or the list of names, no value read;
 * - `family`: the family module itself.
 */
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { listFiles } from "../src/core/forge.js";

type Decision = "effective" | "written" | "concrete" | "lookup" | "family";

const TABLE: Record<string, Decision[]> = {
  "cli.ts": ["effective", "lookup"], // templates through mergedProfile; unify's own sections (written, refused for an abstract --profile)
  "core/catalogue.ts": ["effective", "lookup", "concrete"],
  "core/docs-validate.ts": ["effective"],
  "core/doctor.ts": ["effective"],
  "core/init-flow.ts": ["concrete", "lookup", "written"], // abstract filtered from the lists; --like's template is written
  "core/integrations.ts": ["family"], // the chain walk of effectiveProfile
  "core/localize.ts": ["concrete", "written", "lookup"],
  "core/new-profile-gate.ts": ["lookup"],
  "core/new-profile.ts": ["written", "lookup"], // --like copies the written recipes and targets; an abstract one refused
  "core/param-writes.ts": ["written"],
  "core/profile-extends.ts": ["family"],
  "core/profile-local.ts": ["family", "lookup"],
  "core/promote.ts": ["written"],
  "core/recipe-edit.ts": ["effective"],
  "core/resolve.ts": ["effective"],
  "core/sections-extract.ts": ["written", "lookup"],
  "core/unify.ts": ["written", "effective"],
  "importers/claude-code.ts": ["written", "effective", "lookup"],
  "importers/drift-promote.ts": ["written", "effective"],
  "importers/provided.ts": ["effective"],
};

const READER = /\b(?:forge|f|root|loaded|left|current|edited|ws\.forge|run\.ctx\.forge)\??\.profiles\b/;

describe("the readers of a Forge's profiles (spec 54 §6)", () => {
  it("every file that reads a Forge's profiles map is in the table, and the table names no other", async () => {
    const src = path.resolve(__dirname, "..", "src");
    const readers: string[] = [];
    for (const f of await listFiles(src)) {
      if (!f.endsWith(".ts")) continue;
      if (READER.test(await fs.readFile(path.join(src, f), "utf8"))) readers.push(f);
    }
    expect(readers.sort()).toEqual(Object.keys(TABLE).sort());
  });
});
