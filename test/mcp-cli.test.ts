import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { runCli } from "./helpers/cli.js";
import { makeWorkspace, tmpDir, scenario, rule, recipe, profile } from "./helpers/forge.js";
import { startMcp } from "./helpers/mcp-process.js";
import { eightStates, type Scenario } from "./helpers/states.js";
import { registryFile } from "../src/core/registry.js";

// Spec 35 §4.1, §4.9, §10.3 — the process: launch refusals, a whole session over real pipes, nothing written.

const VERSION = JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf8")).version as string;
const R = ".claude/rules";
const cleanups: Array<() => Promise<unknown>> = [];
const children: Array<ReturnType<typeof startMcp>> = [];
afterEach(async () => {
  for (const c of children.splice(0)) c.kill();
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);
const start = (...a: Parameters<typeof startMcp>) => {
  const c = startMcp(...a);
  children.push(c);
  return c;
};
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } };
async function emptyDir() {
  const d = await tmpDir();
  cleanups.push(() => fs.rm(d, { recursive: true, force: true }));
  return d;
}
/** Every file under `dir` with the hash of its bytes, sorted. */
async function tree(dir: string): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push([path.relative(dir, p).replace(/\\/g, "/"), createHash("sha256").update(await fs.readFile(p)).digest("hex")]);
    }
  };
  await walk(dir);
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

describe("craftar mcp — a session over stdin and stdout", () => {
  it("initialize, tools/list and every tool: one JSON line per request, nothing on stderr, nothing written, exit 0", async () => {
    const s = kept(await eightStates());
    // A registry to compare: a second workspace of the same Forge, registered by a real sync
    const other = path.join(s.root, "ws-registered");
    await makeWorkspace(other, s.forgeRoot, { config: { profile: "acme" } });
    expect(runCli(["sync", "--workspace", other]).code).toBe(0);
    const registry = registryFile(process.env.CRAFTAR_HOME!);
    const before = [await tree(s.wsRoot), await tree(s.forgeRoot), await fs.readFile(registry, "utf8")];
    expect(before[0].map((f) => (f as [string, string])[0])).toContain("craftar.lock");

    const m = start(["--workspace", s.wsRoot]);
    const init = await m.request("initialize", INIT);
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.serverInfo).toEqual({ name: "craftar", version: VERSION });
    m.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect((await m.request("tools/list")).result.tools).toHaveLength(7);
    const answers = [
      await m.request("tools/call", { name: "status" }),
      await m.request("tools/call", { name: "diff" }),
      await m.request("tools/call", { name: "explain", arguments: { path: `${R}/keep.md` } }),
      await m.request("tools/call", { name: "recipes" }),
      await m.request("tools/call", { name: "ingredients" }),
      await m.request("tools/call", { name: "targets" }),
      await m.request("tools/call", { name: "doctor" }),
      await m.request("tools/call", { name: "diff", arguments: { path: `${R}/edited.md` } }),
    ];
    for (const a of answers) {
      expect(a.error).toBeUndefined();
      expect(a.result.isError).toBeUndefined();
    }
    expect(answers[0].result.structuredContent.statuses).toHaveLength(8);
    expect(answers[7].result.structuredContent.files[0].diff).toBe("  # Edited\n- by hand\n+ by the forge");

    const done = await m.end();
    expect(done.code).toBe(0);
    expect(done.stderr).toBe("");
    // 1 initialize + 1 tools/list + 8 tools/call; the notification wrote nothing
    expect(done.lines).toHaveLength(10);
    expect(done.stdout.endsWith("\n")).toBe(true);
    for (const line of done.lines) expect(JSON.parse(line).jsonrpc).toBe("2.0");
    expect([await tree(s.wsRoot), await tree(s.forgeRoot), await fs.readFile(registry, "utf8")]).toEqual(before);
  });

  it("stdin closing during a call: the answer is written, exit 0", async () => {
    const s = kept(await eightStates());
    const m = start(["--workspace", s.wsRoot]);
    await m.request("initialize", INIT);
    m.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status" } }));
    const done = await m.end();
    expect(done.code).toBe(0);
    const last = JSON.parse(done.lines[done.lines.length - 1]);
    expect(last.id).toBe(2);
    expect(last.result.structuredContent.statuses).toHaveLength(8);
  });

  it("a malformed line does not end the server", async () => {
    const s = kept(await eightStates());
    const m = start(["--workspace", s.wsRoot]);
    m.write("{ not json");
    expect((await m.request("ping")).result).toEqual({});
    const done = await m.end();
    expect([done.code, done.lines.length, done.stderr]).toEqual([0, 1, ""]);
  });

  it("the default workspace is the working directory", async () => {
    const s = kept(await eightStates());
    const m = start([], { cwd: s.wsRoot });
    await m.request("initialize", INIT);
    expect((await m.tool("status")).structuredContent.statuses).toHaveLength(8);
    expect((await m.end()).code).toBe(0);
  });

  it("--fetch turns the open-world hint on; CRAFTAR_NO_REGISTRY at launch reaches doctor", async () => {
    const s = kept(await eightStates());
    const off = start(["--workspace", s.wsRoot]);
    await off.request("initialize", INIT);
    expect((await off.request("tools/list")).result.tools[0].annotations.openWorldHint).toBe(false);
    await off.end();
    const on = start(["--workspace", s.wsRoot, "--fetch"], { env: { CRAFTAR_NO_REGISTRY: "1" } });
    await on.request("initialize", INIT);
    expect((await on.request("tools/list")).result.tools[0].annotations.openWorldHint).toBe(true);
    const doctor = (await on.tool("doctor")).structuredContent;
    expect(doctor.checks.find((c: any) => c.id === "registered")).toMatchObject({ level: "ok", message: "registry off" });
    await on.end();
  });

  it("a valid configuration whose Forge is missing: the server starts, and each call says so", async () => {
    const d = await emptyDir();
    await fs.writeFile(path.join(d, "craftar.yaml"), "forge: ../forge-that-is-not-there\nprofile: acme\n");
    const m = start(["--workspace", d]);
    expect((await m.request("initialize", INIT)).result.protocolVersion).toBe("2025-06-18");
    const status = await m.tool("status");
    expect(status.isError).toBe(true);
    expect(status.content[0].text).toBe(`Forge not found at ${path.resolve(d, "../forge-that-is-not-there")}`);
    expect((await m.tool("targets")).structuredContent.warnings).toHaveLength(1);
    const done = await m.end();
    expect([done.code, done.stderr]).toEqual([0, ""]);
  });
});

describe("craftar mcp — launch refusals: exit 1, one line on stderr, nothing on stdout", () => {
  it("no craftar.yaml in the directory", async () => {
    const d = await emptyDir();
    const done = await start(["--workspace", d]).end();
    expect(done).toMatchObject({
      code: 1,
      stdout: "",
      stderr: `error: no craftar.yaml in ${path.resolve(d)} — craftar mcp serves one workspace; start it in one, or pass --workspace\n`,
    });
  });

  it("a craftar.yaml its schema refuses: the configuration's message, without the value", async () => {
    const d = await emptyDir();
    await fs.writeFile(path.join(d, "craftar.yaml"), "forge: ../forge\nprofile: acme\ntargets: [SENTINEL-YAML]\n");
    const done = await start(["--workspace", d]).end();
    expect(done).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "error: invalid craftar.yaml: targets.0: Invalid enum value. Expected 'claude-code' | 'kiro' | 'agents-md'\n",
    });
  });

  it("credentials in forge: are refused before anything can print them", async () => {
    const d = await emptyDir();
    const secret = "SENTINEL-" + "PW";
    await fs.writeFile(path.join(d, "craftar.yaml"), `forge: https://user:${secret}@example.com/f.git\nprofile: acme\n`);
    const done = await start(["--workspace", d]).end();
    expect(done).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "error: craftar.yaml › forge holds credentials in the URL — remove them and let git authenticate (credential helper, SSH agent; see README › Remote Forge)\n",
    });
  });
});


describe("craftar mcp --allow-writes — a real process", () => {
  it("tools/list has 10 tools; sync writes the workspace rule; nothing on stderr; exit 0", async () => {
    const home = await tmpDir("home-");
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
    const s = kept(
      await scenario(
        { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
        { config: { profile: "acme" } },
      ),
    );
    // Record consent in-process
    const { allowWrites } = await import("../src/core/registry.js");
    await allowWrites(home, s.wsRoot, { forge: { source: "../forge", ref: null }, profile: "acme" });

    const m = start(["--allow-writes", "--workspace", s.wsRoot], { env: { CRAFTAR_HOME: home } });
    await m.request("initialize", INIT);

    // tools/list has 10 tools
    const list = await m.request("tools/list");
    expect(list.result.tools).toHaveLength(10);

    // sync writes the workspace rule
    const sync = await m.tool("sync");
    expect(sync.isError).toBeUndefined();
    expect(sync.structuredContent.written).toContain(".claude/rules/keep.md");

    // Verify file was written
    const content = await fs.readFile(path.join(s.wsRoot, ".claude/rules/keep.md"), "utf8");
    expect(content).toBe("# Keep\n");

    const done = await m.end();
    expect(done.stderr).toBe("");
    expect(done.code).toBe(0);
  });
});
