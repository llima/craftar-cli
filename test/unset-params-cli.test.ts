import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { exists } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { makeForge, profile, recipe, rule, scenario, tmpDir, type ForgeSpec } from "./helpers/forge.js";

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

describe("sync --check with an unset declared parameter and files out of sync", () => {
  it("(control) prints the listing, the block and the out-of-sync line, and exits 1", async () => {
    const s = await fresh();
    const r = runCli(["sync", "--check", "--workspace", s.wsRoot]);
    expect([r.code, r.stderr]).toEqual([1, BLOCK]);
    expect(r.stdout).toContain("2 file(s) out of sync");
    expect(r.stdout).not.toContain("workspace in sync");
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
    // the block is still said: only the exit code answers for the one file
    expect(r.stderr).toContain(BLOCK);
  });
});

describe("init and the recipe commands with an unset declared parameter", () => {
  async function forgeOnly() {
    const root = await tmpDir("craftar-unset-init-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    await makeForge(forge, FORGE(true));
    return { forge, ws: path.join(root, "ws") };
  }

  it("init writes craftar.yaml, does not sync, prints the block with 'then run craftar sync', exits 1", async () => {
    const f = await forgeOnly();
    const r = runCli(["init", "--forge", f.forge, "--profile", "acme", "--workspace", f.ws]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      [
        "error: 1 declared parameter(s) have no value — craftar.yaml written, sync not run",
        "  org  declared by rule/a · cited by rule/a, rule/b",
        "  fix: set each under params in the profile, or under overrides.params in craftar.yaml, then run craftar sync",
        "",
      ].join("\n"),
    );
    expect(r.stdout).toContain("craftar init — wrote craftar.yaml");
    expect(r.stdout.split("\n")).toContain(WARN);
    expect(await exists(path.join(f.ws, "craftar.yaml"))).toBe(true);
    expect(await exists(path.join(f.ws, "craftar.lock"))).toBe(false);
    expect(await exists(path.join(f.ws, ".claude"))).toBe(false);
  });

  it("after init's refusal, setting the value in craftar.yaml and running sync succeeds", async () => {
    const f = await forgeOnly();
    runCli(["init", "--forge", f.forge, "--profile", "acme", "--workspace", f.ws]);
    const file = path.join(f.ws, "craftar.yaml");
    await fs.writeFile(file, YAML.stringify({ ...YAML.parse(await fs.readFile(file, "utf8")), overrides: { params: { org: "acme-inc" } } }));
    expect(runCli(["sync", "--workspace", f.ws]).code).toBe(0);
    expect(await fs.readFile(path.join(f.ws, ".claude/rules/b.md"), "utf8")).toBe("Also acme-inc\n");
  });

  it("init --no-sync: the edit is made, the next-sync line says refused, exit 0", async () => {
    const f = await forgeOnly();
    const r = runCli(["init", "--forge", f.forge, "--profile", "acme", "--workspace", f.ws, "--no-sync"]);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")).toContain("next sync: refused — 1 declared parameter(s) have no value (org)");
    expect(r.stdout).not.toContain("run `craftar sync`");
    expect(await exists(path.join(f.ws, "craftar.yaml"))).toBe(true);
  });

  it("add recipe that brings an unset declared parameter: craftar.yaml is edited, the line says refused, exit 0", async () => {
    const s = await scenario(
      {
        ingredients: [rule("style", "# Style\n"), rule("a", "Org: {{org}}\n", { params: DECLARED })],
        recipes: [recipe("base", ["rule/style"]), recipe("extra", ["rule/a"])],
        profiles: [profile("acme", ["base"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    const r = runCli(["add", "recipe", "extra", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")).toContain("next sync: refused — 1 declared parameter(s) have no value (org)");
    expect(YAML.parse(await fs.readFile(path.join(s.wsRoot, "craftar.yaml"), "utf8")).recipes.add).toEqual(["extra"]);
    // and removing it again puts the ordinary line back
    const back = runCli(["remove", "recipe", "extra", "--workspace", s.wsRoot]);
    expect(back.code).toBe(0);
    expect(back.stdout.split("\n")).toContain("next sync: nothing to sync");
  });
});

describe("workspaces and forge impact with an unset declared parameter", () => {
  it("workspaces: the row is error, the reason is a warning line, and no key or value is new", async () => {
    const s = await syncedThenDeclared(); // the sync registered it
    const r = runCli(["workspaces", "--json"]);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout);
    const row = json.workspaces.find((w: { path: string }) => w.path.includes(path.basename(s.root)));
    expect(row.status).toBe("error");
    expect(row.files).toBeNull();
    expect(json.warnings.filter((w: string) => w.includes(path.basename(s.root)) && w.endsWith(": sync refused: declared parameter(s) with no value: org"))).toHaveLength(1);
    const text = runCli(["workspaces"]);
    expect(text.stdout).toContain("error");
  });

  it("forge impact: the workspace's state is error with the reason; exit and shape as for any error row", async () => {
    const s = await syncedThenDeclared();
    const r = runCli(["forge", "impact", "--forge", s.forgeRoot, "--json"]);
    const json = JSON.parse(r.stdout);
    const row = json.workspaces.find((w: { path: string }) => w.path.includes(path.basename(s.root)));
    expect(Object.keys(row)).toEqual(["path", "profile", "match", "via", "ref", "state", "counts", "error"]);
    expect([row.state, row.counts, row.error]).toEqual(["error", {}, "sync refused: declared parameter(s) with no value: org"]);
  });

  it("(control) before the declaration both read the workspace as in sync", async () => {
    const s = await fresh(false);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    const row = JSON.parse(runCli(["workspaces", "--json"]).stdout).workspaces.find((w: { path: string }) => w.path.includes(path.basename(s.root)));
    expect(row.status).toBe("up-to-date");
    const imp = JSON.parse(runCli(["forge", "impact", "--forge", s.forgeRoot, "--json"]).stdout).workspaces.find((w: { path: string }) => w.path.includes(path.basename(s.root)));
    expect(imp.state).toBe("unchanged");
  });
});
