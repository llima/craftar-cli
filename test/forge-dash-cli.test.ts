import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers/forge.js";
import { runCli } from "./helpers/cli.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('a Forge URL that starts with "-" (tech debt 2026-10-10)', () => {
  it("craftar sync refuses forge: -x@h:p without running git", async () => {
    const parent = await fs.realpath(await tmpDir("craftar-dash-"));
    cleanups.push(() => fs.rm(parent, { recursive: true, force: true }));
    const home = path.join(parent, "home");
    const ws = path.join(parent, "ws");
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(path.join(ws, "craftar.yaml"), 'forge: "-x@h:p"\nprofile: acme\n');

    const r = runCli(["sync", "--workspace", ws], { env: { CRAFTAR_HOME: home } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('a Forge URL that starts with "-" is refused — git would read it as an option');
    expect(r.stderr).not.toContain("x@h");
    await expect(fs.lstat(path.join(home, "forges"))).rejects.toThrow();

    // Also test status
    const status = runCli(["status", "--workspace", ws], { env: { CRAFTAR_HOME: home } });
    expect(status.code).not.toBe(0);
    expect(status.stdout + status.stderr).not.toContain("unknown switch");
    expect(status.stdout + status.stderr).not.toContain("x@h");
    await expect(fs.lstat(path.join(home, "forges"))).rejects.toThrow();

    // Also test doctor --fetch
    const doctor = runCli(["doctor", "--workspace", ws, "--fetch"], { env: { CRAFTAR_HOME: home } });
    expect(doctor.stdout + doctor.stderr).not.toContain("unknown switch");
    expect(doctor.stdout + doctor.stderr).not.toContain("x@h");
    await expect(fs.lstat(path.join(home, "forges"))).rejects.toThrow();
  });
});
