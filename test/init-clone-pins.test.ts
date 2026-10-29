import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";
import { makeForge, profile, recipe, rule, tmpDir } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";
import { git, remoteForge } from "./helpers/remote.js";

// Spec 37 §5.2 and §10: three outputs pinned BEFORE the build touches the code behind them — a pin written
// first is what proves the move (`realpathOfNearest` to the core), the new load option (`fetchHint`) and the new
// flags (`--clone`) leave today's bytes as they are.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function scratch(prefix: string): Promise<string> {
  const dir = await fs.realpath(await tmpDir(prefix));
  cleanups.push(() => removeWithRetry(dir));
  return dir;
}

describe("pin — gateOutsideForge's two resolution messages (before realpathOfNearest moves)", () => {
  async function forge(): Promise<string> {
    const root = await scratch("craftar-pin-forge-");
    await makeForge(root, { ingredients: [rule("wf", "a\n"), rule("wf--acme", "b\n", { as: "wf" })], recipes: [recipe("base", ["rule/wf"])], profiles: [profile("acme", ["base"])] });
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
    return root;
  }

  it("a dangling link on the target's path: the whole line, byte for byte", async () => {
    const root = await forge();
    const outside = await scratch("craftar-pin-plan-");
    const link = path.join(outside, "dangling");
    await fs.symlink(path.join(root, "not-there-yet"), link, process.platform === "win32" ? "junction" : "dir");
    const target = path.join(link, "plan.yaml");
    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", target, "--forge", root]);
    expect(r.code).toBe(1);
    const line = (code: string) => `error: refusing to write the plan to ${target}: ${link} exists but cannot be resolved (${code}) — unify cannot prove the target lies outside the Forge\n`;
    // A dangling junction's realpath code is the platform's; on Linux a dangling symlink's is ENOENT.
    if (process.platform !== "win32") expect(r.stderr).toBe(line("ENOENT"));
    else expect(r.stderr).toBe(line(/\(([A-Z]+)\) — unify/.exec(r.stderr)?.[1] ?? "?"));
  });

  it.skipIf(process.platform === "win32")("a symlink loop on the target's path: the whole line, byte for byte (Linux: lstat fails with ELOOP)", async () => {
    const root = await forge();
    const outside = await scratch("craftar-pin-plan-");
    await fs.symlink(path.join(outside, "loopb"), path.join(outside, "loopa"), "dir");
    await fs.symlink(path.join(outside, "loopa"), path.join(outside, "loopb"), "dir");
    const target = path.join(outside, "loopa", "plan.yaml");
    const r = runCli(["forge", "unify", "rule/wf", "--profile", "acme", "--save-plan", target, "--forge", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      `error: refusing to write the plan to ${target}: ${path.join(outside, "loopa", "plan.yaml")} cannot be inspected (ELOOP) — unify cannot prove the target lies outside the Forge\n`,
    );
  });
});

describe("pin — sync's fetch failure tail (before LoadOptions.fetchHint)", () => {
  it("sync, unreachable remote with a cached copy: the whole line, git's reason aside", async () => {
    const r = await remoteForge({ ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] });
    cleanups.push(r.cleanup);
    const ws = await scratch("craftar-pin-ws-");
    const home = await scratch("craftar-pin-home-");
    await fs.writeFile(path.join(ws, "craftar.yaml"), `forge: ${r.url}\nprofile: acme\n`);
    const run = (args: string[]) => runCli([...args, "--workspace", ws], { env: { CRAFTAR_HOME: home } });
    expect(run(["sync"]).code).toBe(0);
    const sha = git(r.src, "rev-parse", "HEAD").slice(0, 8);
    await fs.rename(r.bare, r.bare + ".gone");
    const x = run(["sync"]);
    expect(x.code).toBe(1);
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(x.stderr).toMatch(new RegExp(`^error: cannot fetch the Forge ${esc(r.url)}: [^\\n]+ — run with --offline to use the cached copy \\(${sha} fetched [^)\\n]+\\)\\n$`));
  });
});

describe("pin — init with both flags on a profile that lists repositories (before --clone exists)", () => {
  it("stdout is byte for byte the stdout of the same profile with repos: [] — nothing asked, nothing said about repos", async () => {
    const repos = [
      { name: "portal-api", url: "https://git.example.com/acme/portal-api.git" },
      { name: "portal-web", url: "git@git.example.com:acme/portal-web.git", path: "apps/portal-web", ref: "release" },
    ];
    const out: string[] = [];
    for (const list of [repos, []]) {
      const parent = await scratch("craftar-pin-init-");
      const forge = path.join(parent, "forge");
      await makeForge(forge, { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"], ["claude-code"], { repos: list })] });
      const ws = path.join(parent, "ws");
      const r = runCli(["init", "--forge", forge, "--profile", "acme", "--workspace", ws]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).toBe("");
      out.push(r.stdout.split(parent).join("<P>"));
    }
    expect(out[0]).toBe(out[1]);
    expect(out[0]).not.toMatch(/repositor|clone|portal-/);
  });
});
