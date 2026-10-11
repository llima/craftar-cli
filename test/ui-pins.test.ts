import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listWorkspaces } from "../src/core/registry.js";
import { runCli } from "./helpers/cli.js";
import { makeWorkspace, profile, recipe, rule, scenario } from "./helpers/forge.js";

/**
 * Spec 36 §10.1: what `craftar workspaces` and `craftar doctor` print for a workspace that does not load, pinned
 * before `listWorkspaces` takes a `reason` and `oneLine` is exported. No value written into a broken file may
 * reach an output: each one carries a sentinel.
 */

const BROKEN = ["ws-badjson", "ws-badlock", "ws-badyaml", "ws-futurelock"] as const;
const ENUM = "Invalid enum value. Expected 'claude-code' | 'kiro' | 'agents-md'";

let root = "";
let real = "";
let cleanup: () => Promise<void> = async () => {};

/** The scenario's directory as `<ROOT>` (the registry holds the native real path), the sync time as `<T>`. */
const norm = (x: string): string =>
  x
    .split(real)
    .join("<ROOT>")
    .split(root)
    .join("<ROOT>")
    .replace(/<ROOT>\\/g, "<ROOT>/")
    .replace(/synced \d{4}-\d\d-\d\d \d\d:\d\d UTC/g, "<T>");

const WARNINGS = [
  "<ROOT>/ws-badjson: craftar.lock is not valid JSON",
  `<ROOT>/ws-badlock: craftar.lock is not a valid lock: files.0.target: ${ENUM}`,
  `<ROOT>/ws-badyaml: invalid craftar.yaml: targets.0: ${ENUM}`,
  "<ROOT>/ws-futurelock: craftar.lock declares schema (not a whole number), which this craftar does not read — upgrade craftar",
];

beforeAll(async () => {
  const s = await scenario(
    { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
    { config: { profile: "acme" } },
  );
  root = s.root;
  real = realpathSync.native(s.root);
  cleanup = s.cleanup;
  for (const name of BROKEN) await makeWorkspace(path.join(root, name), s.forgeRoot, { config: { profile: "acme" } });
  for (const name of ["ws", ...BROKEN]) {
    const r = runCli(["sync", "--workspace", path.join(root, name)]);
    expect(r.code, r.stderr).toBe(0);
  }
  const lockOf = async (name: string) => JSON.parse(await fs.readFile(path.join(root, name, "craftar.lock"), "utf8"));
  await fs.writeFile(path.join(root, "ws-badjson", "craftar.lock"), '{ "schema": 2, SENTINEL-9c1e');
  const bad = await lockOf("ws-badlock");
  bad.files[0].target = "SENTINEL-TARGET";
  await fs.writeFile(path.join(root, "ws-badlock", "craftar.lock"), JSON.stringify(bad, null, 2));
  await fs.writeFile(path.join(root, "ws-badyaml", "craftar.yaml"), "forge: ../forge\nprofile: acme\ntargets: [SENTINEL-YAML]\n");
  const future = await lockOf("ws-futurelock");
  future.schema = "SENTINEL-SCHEMA";
  await fs.writeFile(path.join(root, "ws-futurelock", "craftar.lock"), JSON.stringify(future, null, 2));
}, 120_000);

afterAll(() => cleanup());

describe("pins: craftar workspaces and doctor on workspaces that do not load (spec 36 §10.1)", () => {
  it("1. craftar workspaces: the table, the four warnings, exit 0, nothing on stderr (control)", () => {
    const r = runCli(["workspaces"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(norm(r.stdout)).toBe(
      [
        "craftar workspaces — 5 registered",
        "  ws             <ROOT>/ws",
        "      profile acme · claude-code",
        "      forge ../forge @ no git · <T> · up to date",
        "  ws-badjson     <ROOT>/ws-badjson",
        "      profile acme · claude-code",
        "      <T> · error",
        "  ws-badlock     <ROOT>/ws-badlock",
        "      profile acme · claude-code",
        "      <T> · error",
        "  ws-badyaml     <ROOT>/ws-badyaml",
        "      profile acme · claude-code",
        "      <T> · error",
        "  ws-futurelock  <ROOT>/ws-futurelock",
        "      profile acme · claude-code",
        "      <T> · error",
        ...WARNINGS.map((w) => `  warn ${w}`),
        "",
      ].join("\n"),
    );
  });

  it("2. craftar workspaces --json: the same four warnings, the five statuses, no sentinel (control)", () => {
    const r = runCli(["workspaces", "--json"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("SENTINEL");
    const j = JSON.parse(r.stdout);
    expect(j.warnings.map(norm)).toEqual(WARNINGS);
    expect(j.workspaces.map((w: { status: string }) => w.status)).toEqual(["up-to-date", "error", "error", "error", "error"]);
  });

  it("3. listWorkspaces with no reason: the same warnings (control)", async () => {
    const t = await listWorkspaces(process.env.CRAFTAR_HOME!, { fetch: false });
    expect(t.warnings.map(norm)).toEqual(WARNINGS);
  });

  it("4. craftar doctor on each broken workspace: the failing check's line, exit 1, no sentinel (control)", () => {
    const expected: Record<(typeof BROKEN)[number], string> = {
      "ws-badjson": "  error  lock          craftar.lock is not valid JSON — repair or remove craftar.lock",
      "ws-badlock": `  error  lock          craftar.lock is not a valid lock (files.0.target: ${ENUM}) — repair or remove craftar.lock`,
      "ws-badyaml": `  error  config        invalid craftar.yaml (targets.0: ${ENUM})`,
      "ws-futurelock": "  error  lock          craftar.lock declares schema (not a whole number), which this craftar does not read — upgrade craftar",
    };
    for (const name of BROKEN) {
      const r = runCli(["doctor", "--workspace", path.join(root, name)]);
      expect(r.code, name).toBe(1);
      expect(r.stdout + r.stderr, name).not.toContain("SENTINEL");
      expect(r.stdout.split("\n").filter((l) => l.startsWith("  error  ")), name).toEqual([expected[name]]);
    }
  });
});
