import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/core/doctor.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, scenario } from "./helpers/forge.js";

// E18.3: a craftar.lock written before 0.27.1 can still record a Forge URL with credentials. doctor's
// `lock-credential` says so, never the value; it is a `warn`, so only `doctor --strict` exits 1.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const MARK = ["tok", "MARKER123"].join("");
const URL_WITH_CREDENTIAL = "https://user:" + MARK + "@example.com/forge.git";
const MESSAGE = "craftar.lock records a Forge URL with credentials (not shown)";
const FIX = "rotate the credential, set forge: in craftar.yaml to a URL without it, then craftar sync — the old value stays in git history";
const NO_REGISTRY = { CRAFTAR_NO_REGISTRY: "1" };

async function synced(credential: boolean) {
  const s = await scenario(
    { ingredients: [rule("style", "# Style\n")], recipes: [recipe("base", ["rule/style"])], profiles: [profile("acme", ["base"], ["claude-code"])] },
    { config: { profile: "acme" } },
  );
  cleanups.push(s.cleanup);
  const r = runCli(["sync", "--workspace", s.wsRoot], { env: NO_REGISTRY });
  expect(r.code).toBe(0);
  if (credential) {
    const lockPath = path.join(s.wsRoot, "craftar.lock");
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    lock.forge.source = URL_WITH_CREDENTIAL;
    await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
  }
  return s;
}

const doctorOf = (workspace: string, home: string) =>
  runDoctor({ version: "0.0.0", home, workspace, fetch: false, strict: false, registryOff: true, env: {}, nodeVersion: "22.11.0", gitVersion: async () => "2.53.0" });

describe("doctor lock-credential (E18.3)", () => {
  it("one warn in fixed words, and the report never holds the value", async () => {
    const s = await synced(true);
    const report = await doctorOf(s.wsRoot, path.join(s.root, "home"));
    expect(report.checks.filter((c) => c.id === "lock-credential")).toEqual([{ id: "lock-credential", scope: "workspace", level: "warn", message: MESSAGE, fix: FIX }]);
    expect(JSON.stringify(report)).not.toContain(MARK);
  });

  it("the CLI's text and --json never print the value, and --strict exits 1", async () => {
    const s = await synced(true);
    for (const args of [["doctor"], ["doctor", "--json"]]) {
      const r = runCli([...args, "--workspace", s.wsRoot], { env: NO_REGISTRY });
      expect(r.stdout + r.stderr).toContain(args.length === 1 ? MESSAGE : '"lock-credential"');
      expect(r.stdout + r.stderr).not.toContain(MARK);
    }
    const strict = runCli(["doctor", "--strict", "--workspace", s.wsRoot], { env: NO_REGISTRY });
    expect(strict.code).toBe(1);
    expect(strict.stdout + strict.stderr).not.toContain(MARK);
  });

  it("still said when craftar.yaml does not read", async () => {
    const s = await synced(true);
    await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), "forge: [\n");
    const report = await doctorOf(s.wsRoot, path.join(s.root, "home"));
    expect(report.checks.filter((c) => c.id === "lock-credential")).toEqual([{ id: "lock-credential", scope: "workspace", level: "warn", message: MESSAGE, fix: FIX }]);
    expect(JSON.stringify(report)).not.toContain(MARK);
  });

  it("absent for a lock with no credential", async () => {
    const s = await synced(false);
    const report = await doctorOf(s.wsRoot, path.join(s.root, "home"));
    expect(report.checks.some((c) => c.id === "lock-credential")).toBe(false);
  });
});
