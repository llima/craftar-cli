import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { exists } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, scenario, type ForgeSpec } from "./helpers/forge.js";

// Spec 29 §4.1 / §9 slice A — what each command prints and exits with when a declared, cited parameter has no value.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const DECLARED = { org: { description: "the organisation" } };
const FORGE = (declared: boolean): ForgeSpec => ({
  ingredients: [rule("a", "Org: {{org}}\n", { params: declared ? DECLARED : {} }), rule("b", "Also {{org}}\n")],
  recipes: [recipe("base", ["rule/a", "rule/b"])],
  profiles: [profile("acme", ["base"])],
});
const BLOCK = [
  "error: 1 declared parameter(s) have no value — nothing written",
  "  org  declared by rule/a · cited by rule/a, rule/b",
  "  fix: set each under params in the profile, or under overrides.params in craftar.yaml",
  "",
].join("\n");
const WARN = '  warn param "org" has no value in any layer — left verbatim (rule/a, rule/b)';

async function fresh(declared = true) {
  const s = await scenario(FORGE(declared), { config: { profile: "acme" } });
  cleanups.push(s.cleanup);
  return s;
}
/** Synced while `org` was undeclared (so `{{org}}` is on disk and in the lock), then declared: refused, every file unchanged. */
async function syncedThenDeclared() {
  const s = await fresh(false);
  expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
  const meta = path.join(s.forgeRoot, "ingredients/rules/a/ingredient.yaml");
  await fs.writeFile(meta, YAML.stringify({ ...YAML.parse(await fs.readFile(meta, "utf8")), params: DECLARED }));
  return s;
}
const registry = () => path.join(process.env.CRAFTAR_HOME!, "registry.json");

describe("sync with an unset declared parameter", () => {
  it("exits 1 with the block on stderr, the warning before it on stdout, and writes nothing — no file, no lock, no registry entry", async () => {
    const s = await fresh();
    const hadRegistry = await exists(registry());
    const r = runCli(["sync", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(BLOCK);
    expect(r.stdout.split("\n")).toContain(WARN);
    expect(r.stdout).not.toContain("wrote");
    expect(await exists(path.join(s.wsRoot, ".claude"))).toBe(false);
    expect(await exists(path.join(s.wsRoot, "craftar.lock"))).toBe(false);
    if (!hadRegistry) expect(await exists(registry())).toBe(false);
    // the scenario's unique temp directory name, so the check holds whatever the path escaping in JSON
    else expect(await fs.readFile(registry(), "utf8")).not.toContain(path.basename(s.root));
  });

  it("--dry-run exits 1 with the same block", async () => {
    const s = await fresh();
    const r = runCli(["sync", "--dry-run", "--workspace", s.wsRoot]);
    expect([r.code, r.stderr]).toEqual([1, BLOCK]);
    expect(r.stdout.split("\n")).toContain(WARN);
    expect(r.stdout).not.toContain("would write");
  });

  it("with the value in craftar.yaml it syncs (control for the fix line)", async () => {
    const s = await fresh();
    await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), YAML.stringify({ ...YAML.parse(await fs.readFile(path.join(s.wsRoot, "craftar.yaml"), "utf8")), overrides: { params: { org: "acme-inc" } } }));
    const r = runCli(["sync", "--workspace", s.wsRoot]);
    expect([r.code, r.stderr]).toEqual([0, ""]);
    expect(await fs.readFile(path.join(s.wsRoot, ".claude/rules/a.md"), "utf8")).toBe("Org: acme-inc\n");
  });

  it("--check exits 1 even when every file is unchanged, and says neither 'in sync' nor 'out of sync'", async () => {
    const s = await syncedThenDeclared();
    const r = runCli(["sync", "--check", "--workspace", s.wsRoot]);
    expect([r.code, r.stderr]).toEqual([1, BLOCK]);
    expect(r.stdout).toContain("craftar status");
    expect(r.stdout).not.toContain("workspace in sync");
    expect(r.stdout).not.toContain("out of sync");
  });
});

describe("status with an unset declared parameter", () => {
  it("prints its listing, then the block on stderr, and exits 1", async () => {
    const s = await fresh();
    const r = runCli(["status", "--workspace", s.wsRoot]);
    expect([r.code, r.stderr]).toEqual([1, BLOCK]);
    expect(r.stdout).toContain(".claude/rules/a.md");
    expect(r.stdout.split("\n")).toContain(WARN);
  });

  it("--json still prints the whole object, unsetParams last, and exits 1", async () => {
    const s = await fresh();
    const r = runCli(["status", "--workspace", s.wsRoot, "--json"]);
    expect(r.code).toBe(1);
    const json = JSON.parse(r.stdout);
    expect(Object.keys(json)).toEqual(["forge", "statuses", "warnings", "unsetParams"]);
    expect(json.unsetParams).toEqual([{ key: "org", declaredBy: ["rule/a"], citedBy: ["rule/a", "rule/b"] }]);
    expect(json.statuses.map((x: { state: string }) => x.state)).toEqual(["new", "new"]);
  });

  it("--json without one: unsetParams is [], exit 0", async () => {
    const s = await fresh(false);
    const r = runCli(["status", "--workspace", s.wsRoot, "--json"]);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(Object.keys(json)).toEqual(["forge", "statuses", "warnings", "unsetParams"]);
    expect(json.unsetParams).toEqual([]);
  });
});

describe("diff with an unset declared parameter", () => {
  it("without --exit-code: the diff as today, the block on stderr, exit 0", async () => {
    const s = await fresh();
    const r = runCli(["diff", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(BLOCK);
    expect(r.stdout).toContain("+++ .claude/rules/a.md (forge)");
  });

  it("--exit-code exits 1 with no differences at all — exactly when sync --check does", async () => {
    const s = await syncedThenDeclared();
    const r = runCli(["diff", "--exit-code", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("no differences");
    expect(r.stderr).toContain(BLOCK);
  });

  it("--exit-code with a [path] answers for that file only: unchanged is exit 0", async () => {
    const s = await syncedThenDeclared();
    const r = runCli(["diff", "--exit-code", ".claude/rules/a.md", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
  });
});
