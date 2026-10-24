// Spec 40 §5.2: `craftar mcp allow-writes` and `craftar mcp revoke-writes` CLI tests.
// The TTY branch (steps 6–8 of allow-writes) is NOT reachable from the test suite (spec 28 §9.2 declared gap).

import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCli } from "./helpers/cli.js";
import { tmpDir, scenario, rule, recipe, profile, type Scenario } from "./helpers/forge.js";
import { allowWrites, readRegistry } from "../src/core/registry.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

describe("craftar mcp allow-writes / revoke-writes", () => {
  // Case 1: allow-writes in non-TTY (piped stdin/stdout) fails at step 4
  it("allow-writes --workspace <ws>: not a terminal, code 1", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );
    // Sync first so there's a lock
    expect(runCli(["sync", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    const r = runCli(["mcp", "allow-writes", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      "error: craftar mcp allow-writes asks a person in a terminal — type it in one; it cannot be run from a script or an AI coder's shell tool\n",
    );
    expect(r.stdout).toBe("");
    // Registry should have no writeConsent
    const reg = await readRegistry(home);
    expect(reg.writeConsent).toBeUndefined();
  });

  // Case 2: allow-writes with CRAFTAR_NO_REGISTRY fails at step 2
  it("allow-writes with CRAFTAR_NO_REGISTRY=1: code 1, step 2 error", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );

    const r = runCli(["mcp", "allow-writes", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home, CRAFTAR_NO_REGISTRY: "1" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("error: the consent is recorded in the registry, and CRAFTAR_NO_REGISTRY is set — unset it to allow writes\n");
    expect(r.stdout).toBe("");
  });

  // Case 3: allow-writes on directory without craftar.yaml fails at step 1
  it("allow-writes on directory without craftar.yaml: code 1, step 1 error", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const emptyDir = await tmpDir("empty-");
    cleanups.push(() => fs.rm(emptyDir, { recursive: true, force: true }));

    const r = runCli(["mcp", "allow-writes", "--workspace", emptyDir], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    const resolvedPath = path.resolve(emptyDir);
    expect(r.stderr).toBe(
      `error: no craftar.yaml in ${resolvedPath} — the consent is given for one workspace; type it in one, or pass --workspace\n`,
    );
    expect(r.stdout).toBe("");
  });

  // Case 4: allow-writes --fetch (parent flag) is refused
  it("allow-writes --fetch --workspace <ws>: code 1, refuses parent flag", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );

    const r = runCli(["mcp", "allow-writes", "--fetch", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("error: craftar mcp allow-writes takes only --workspace\n");
    expect(r.stdout).toBe("");
  });

  // Case 5: revoke-writes with nothing recorded: code 0, "no consent recorded"
  it("revoke-writes --workspace <ws> with nothing recorded: code 0", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );

    const r = runCli(["mcp", "revoke-writes", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(0);
    const realPath = await fs.realpath(s.wsRoot);
    expect(r.stdout).toBe(`no consent recorded for ${realPath}\n`);
    expect(r.stderr).toBe("");
  });

  // Case 6: revoke-writes after in-process allowWrites: code 0, removes consent
  it("revoke-writes after allowWrites: code 0, removes consent", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );

    // Record consent in-process
    await allowWrites(home, s.wsRoot, { forge: { source: "../forge", ref: null }, profile: "acme" });

    // Verify consent was recorded
    let reg = await readRegistry(home);
    expect(reg.writeConsent).toHaveLength(1);

    const r = runCli(["mcp", "revoke-writes", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(0);
    const realPath = await fs.realpath(s.wsRoot);
    expect(r.stdout).toBe(`write consent removed for ${realPath}\n`);
    expect(r.stderr).toBe("");

    // Verify consent was removed
    reg = await readRegistry(home);
    expect(reg.writeConsent).toBeUndefined();
  });

  // Case 7: parent's --workspace spelling: mcp --workspace <ws> revoke-writes
  it("mcp --workspace <ws> revoke-writes: parent's spelling removes consent", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );
    // Create a different temp directory to run from
    const differentDir = await tmpDir("different-");
    cleanups.push(() => fs.rm(differentDir, { recursive: true, force: true }));

    // Record consent in-process
    await allowWrites(home, s.wsRoot, { forge: { source: "../forge", ref: null }, profile: "acme" });

    // Run with parent's --workspace spelling, from a different directory
    const r = runCli(["mcp", "--workspace", s.wsRoot, "revoke-writes"], { env: { CRAFTAR_HOME: home }, cwd: differentDir });
    expect(r.code).toBe(0);
    const realPath = await fs.realpath(s.wsRoot);
    expect(r.stdout).toBe(`write consent removed for ${realPath}\n`);
    expect(r.stderr).toBe("");

    // Verify consent was removed
    const reg = await readRegistry(home);
    expect(reg.writeConsent).toBeUndefined();
  });

  // Case 8: workspaces forget removes consent too
  it("workspaces forget <ws> after sync and allowWrites: consent is gone", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );

    // Sync to register the workspace
    expect(runCli(["sync", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } }).code).toBe(0);

    // Record consent in-process
    await allowWrites(home, s.wsRoot, { forge: { source: "../forge", ref: null }, profile: "acme" });

    // Verify consent was recorded
    let reg = await readRegistry(home);
    expect(reg.writeConsent).toHaveLength(1);
    expect(reg.workspaces).toHaveLength(1);

    // Forget the workspace
    const r = runCli(["workspaces", "forget", s.wsRoot], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(0);

    // Verify consent is gone
    reg = await readRegistry(home);
    expect(reg.writeConsent).toBeUndefined();
    expect(reg.workspaces).toHaveLength(0);
  });

  // Case 9: mcp --help contains the subcommands
  it("mcp --help contains allow-writes and revoke-writes", async () => {
    const r = runCli(["mcp", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("allow-writes");
    expect(r.stdout).toContain("revoke-writes");
  });

  it("mcp allow-writes --help contains --workspace", async () => {
    const r = runCli(["mcp", "allow-writes", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--workspace");
  });

  // Extra: revoke-writes with CRAFTAR_NO_REGISTRY=1
  it("revoke-writes with CRAFTAR_NO_REGISTRY=1: code 1, nothing to revoke", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );

    const r = runCli(["mcp", "revoke-writes", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home, CRAFTAR_NO_REGISTRY: "1" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("error: the consent is recorded in the registry, and CRAFTAR_NO_REGISTRY is set — nothing to revoke here\n");
    expect(r.stdout).toBe("");
  });

  // Extra: revoke-writes on directory without craftar.yaml
  it("revoke-writes on directory without craftar.yaml: code 1", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const emptyDir = await tmpDir("empty-");
    cleanups.push(() => fs.rm(emptyDir, { recursive: true, force: true }));

    const r = runCli(["mcp", "revoke-writes", "--workspace", emptyDir], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    const resolvedPath = path.resolve(emptyDir);
    expect(r.stderr).toBe(
      `error: no craftar.yaml in ${resolvedPath} — the consent is given for one workspace; type it in one, or pass --workspace\n`,
    );
    expect(r.stdout).toBe("");
  });

  // Extra: revoke-writes --fetch is refused
  it("revoke-writes --fetch --workspace <ws>: code 1, refuses parent flag", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );

    const r = runCli(["mcp", "revoke-writes", "--fetch", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("error: craftar mcp revoke-writes takes only --workspace\n");
    expect(r.stdout).toBe("");
  });

  // Case: allow-writes refuses a ref holding credentials before anything prints or records it
  it("allow-writes --workspace <ws> with ref holding credentials: code 1, hidden label, nothing in registry", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );

    // Write a craftar.yaml with a ref holding credentials (assembled at runtime to avoid committing a credential-like string)
    const secretRef = "https://user:" + "x".repeat(8) + "@example.com/r.git";
    await fs.writeFile(
      path.join(s.wsRoot, "craftar.yaml"),
      `forge: ../forge\nref: "${secretRef}"\nprofile: acme\n`,
    );

    const r = runCli(["mcp", "allow-writes", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("(a URL with credentials — not shown)");
    expect(r.stderr).not.toContain("xxxxxxxx");
    expect(r.stdout).toBe("");

    // Registry should have no writeConsent
    const reg = await readRegistry(home);
    expect(reg.writeConsent).toBeUndefined();
  });
});
