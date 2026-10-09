import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { apply, loadWorkspace, plan, readLock, status, type ApplyOptions } from "../src/core/sync.js";
import { exists } from "../src/core/forge.js";
import { profile, recipe, rule, scenario, type IngredientSpec } from "./helpers/forge.js";

const A = ".claude/rules/a.md";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function oneRule(files?: Record<string, string | Buffer>, extra: IngredientSpec[] = [], refs: string[] = ["rule/a"]) {
  const s = await scenario(
    { ingredients: [rule("a", "# A\n"), ...extra], recipes: [recipe("base", refs)], profiles: [profile("acme", ["base"])] },
    { config: { profile: "acme" }, files },
  );
  cleanups.push(s.cleanup);
  return s;
}

async function statuses(wsRoot: string) {
  const w = await loadWorkspace(wsRoot);
  const p = await plan(w);
  return { w, p, st: await status(w, p, await readLock(w.root)) };
}
const stateOf = async (wsRoot: string, rel: string) => (await statuses(wsRoot)).st.find((s) => s.path === rel)?.state;
async function sync(wsRoot: string, opts: ApplyOptions = {}) {
  const { w, p, st } = await statuses(wsRoot);
  return apply(w, p, st, opts);
}
const dropFromRecipe = (forgeRoot: string) => fs.writeFile(path.join(forgeRoot, "recipes/base.yaml"), YAML.stringify(recipe("base", [])));

describe("status", () => {
  it("new: planned, not on disk", async () => {
    const s = await oneRule();
    expect(await stateOf(s.wsRoot, A)).toBe("new");
  });

  it("adopt: on disk, not in the lock, same content", async () => {
    const s = await oneRule({ [A]: "# A\n" });
    expect(await stateOf(s.wsRoot, A)).toBe("adopt");
  });

  it("collision: on disk, not in the lock, different content", async () => {
    const s = await oneRule({ [A]: "# mine\n" });
    expect(await stateOf(s.wsRoot, A)).toBe("collision");
  });

  it("unchanged: disk == lock == plan", async () => {
    const s = await oneRule();
    await sync(s.wsRoot);
    expect(await stateOf(s.wsRoot, A)).toBe("unchanged");
  });

  it("update: disk == lock, the Forge moved", async () => {
    const s = await oneRule();
    await sync(s.wsRoot);
    await fs.writeFile(path.join(s.forgeRoot, "ingredients/rules/a/rule.md"), "# A v2\n");
    expect(await stateOf(s.wsRoot, A)).toBe("update");
  });

  it("drift: disk != lock", async () => {
    const s = await oneRule();
    await sync(s.wsRoot);
    await fs.appendFile(path.join(s.wsRoot, A), "hand edit\n");
    expect(await stateOf(s.wsRoot, A)).toBe("drift");
  });

  it("orphan: in the lock, no longer planned, untouched", async () => {
    const s = await oneRule();
    await sync(s.wsRoot);
    await dropFromRecipe(s.forgeRoot);
    expect(await stateOf(s.wsRoot, A)).toBe("orphan");
  });

  it("orphan-drift: in the lock, no longer planned, hand-edited", async () => {
    const s = await oneRule();
    await sync(s.wsRoot);
    await fs.appendFile(path.join(s.wsRoot, A), "hand edit\n");
    await dropFromRecipe(s.forgeRoot);
    expect(await stateOf(s.wsRoot, A)).toBe("orphan-drift");
  });

  it("adopts a JSON file that differs only in formatting", async () => {
    const mcp: IngredientSpec = { meta: { type: "mcp", name: "pw", server: { command: "npx", args: ["-y", "pw"] } } };
    const s = await oneRule({ ".mcp.json": '{"mcpServers":{"pw":{"command":"npx","args":["-y","pw"]}}}' }, [mcp], ["mcp/pw"]);
    expect(await stateOf(s.wsRoot, ".mcp.json")).toBe("adopt");
  });

  it("adopt rewrites a JSON file into the emitter's layout on the first sync — by design (0.8.1)", async () => {
    const mcp: IngredientSpec = { meta: { type: "mcp", name: "pw", server: { command: "npx", args: ["-y", "pw"] } } };
    const s = await oneRule({ ".mcp.json": '{"mcpServers":{"pw":{"command":"npx","args":["-y","pw"]}}}\n' }, [mcp], ["mcp/pw"]);
    expect(await stateOf(s.wsRoot, ".mcp.json")).toBe("adopt");
    await sync(s.wsRoot);
    expect(await fs.readFile(path.join(s.wsRoot, ".mcp.json"), "utf8")).toBe(
      '{\n  "mcpServers": {\n    "pw": {\n      "command": "npx",\n      "args": [\n        "-y",\n        "pw"\n      ]\n    }\n  }\n}\n',
    );
    expect(await stateOf(s.wsRoot, ".mcp.json")).toBe("unchanged");
  });

  it("adopt keeps the BOM and CRLF of the JSON file it rewrites — by design (0.8.1)", async () => {
    const mcp: IngredientSpec = { meta: { type: "mcp", name: "pw", server: { command: "npx", args: ["-y", "pw"] } } };
    const s = await oneRule({ ".mcp.json": '﻿{"mcpServers":{"pw":{"command":"npx","args":["-y","pw"]}}}\r\n' }, [mcp], ["mcp/pw"]);
    expect(await stateOf(s.wsRoot, ".mcp.json")).toBe("adopt");
    await sync(s.wsRoot);
    expect(await fs.readFile(path.join(s.wsRoot, ".mcp.json"), "utf8")).toBe(
      '﻿{\r\n  "mcpServers": {\r\n    "pw": {\r\n      "command": "npx",\r\n      "args": [\r\n        "-y",\r\n        "pw"\r\n      ]\r\n    }\r\n  }\r\n}\r\n',
    );
    expect(await stateOf(s.wsRoot, ".mcp.json")).toBe("unchanged");
  });

  it("a CRLF + BOM copy of a synced LF file is unchanged, not drift (FM-2)", async () => {
    const s = await oneRule();
    await sync(s.wsRoot);
    await fs.writeFile(path.join(s.wsRoot, A), "\uFEFF# A\r\n");
    expect(await stateOf(s.wsRoot, A)).toBe("unchanged");
  });
});

describe("status — MCP servers written as the Forge holds them (spec 07)", () => {
  const MCP = ".mcp.json";
  const KIRO_MCP = ".kiro/settings/mcp.json";
  const json = (server: Record<string, unknown>) => JSON.stringify({ mcpServers: { r: server } }, null, 2) + "\n";
  const crlf = (text: string) => text.replace(/\n/g, "\r\n");
  const mcpMeta = (server: Record<string, unknown>) => ({ type: "mcp", name: "r", server });
  async function mcpScenario(server: Record<string, unknown>, files?: Record<string, string>, targets = ["claude-code"]) {
    const s = await scenario(
      { ingredients: [{ meta: mcpMeta(server) }], recipes: [recipe("base", ["mcp/r"])], profiles: [profile("acme", ["base"], targets)] },
      { config: { profile: "acme" }, files },
    );
    cleanups.push(s.cleanup);
    return s;
  }
  const setServer = (forgeRoot: string, server: Record<string, unknown>) =>
    fs.writeFile(path.join(forgeRoot, "ingredients/mcp/r/ingredient.yaml"), YAML.stringify(mcpMeta(server)));

  it("update: a locked .mcp.json written without headers, once the Forge server carries them (AC 5)", async () => {
    const s = await mcpScenario({ url: "https://mcp.acme.dev" });
    await sync(s.wsRoot);
    await setServer(s.forgeRoot, { url: "https://mcp.acme.dev", headers: { "X-Team": "acme" } });
    expect(await stateOf(s.wsRoot, MCP)).toBe("update");
  });

  it("adopt: an unlocked .mcp.json carrying undeclared keys (AC 4)", async () => {
    const server = { url: "https://mcp.acme.dev", type: "http", headers: { "X-Team": "acme" } };
    const s = await mcpScenario(server, { [MCP]: json(server) });
    expect(await stateOf(s.wsRoot, MCP)).toBe("adopt");
  });

  it("adopt: a server that lists type first, and sync leaves its bytes alone (AC 16)", async () => {
    for (const server of [
      { type: "http", url: "https://mcp.acme.dev", headers: { "X-Team": "acme" } },
      { type: "stdio", command: "npx", args: ["srv"] },
    ]) {
      const s = await mcpScenario(server, { [MCP]: json(server) });
      expect(await stateOf(s.wsRoot, MCP)).toBe("adopt");
      await sync(s.wsRoot);
      expect(await fs.readFile(path.join(s.wsRoot, MCP), "utf8")).toBe(json(server));
    }
  });

  it("update on both MCP files: written in schema order by 0.2.4 from a server the Forge stores type first (AC 18)", async () => {
    const s = await mcpScenario({ command: "npx", args: ["srv"], type: "stdio" }, undefined, ["claude-code", "kiro"]);
    await sync(s.wsRoot);
    expect(await fs.readFile(path.join(s.wsRoot, KIRO_MCP), "utf8")).toBe(crlf(json({ command: "npx", args: ["srv"], type: "stdio" })));
    await setServer(s.forgeRoot, { type: "stdio", command: "npx", args: ["srv"] });
    expect(await stateOf(s.wsRoot, MCP)).toBe("update");
    expect(await stateOf(s.wsRoot, KIRO_MCP)).toBe("update");
  });
});


describe("status — .claude/settings.craftar.example.json (spec 27 §6)", () => {
  const EX = ".claude/settings.craftar.example.json";
  const PLANNED = '{\n  "env": {\n    "ACME_TRACKER_TOKEN": ""\n  }\n}\n';
  const mcp: IngredientSpec = { meta: { type: "mcp", name: "tracker", authEnv: ["ACME_TRACKER_TOKEN"], server: { command: "npx" } } };

  async function exScenario(files?: Record<string, string | Buffer>) {
    const s = await scenario(
      { ingredients: [mcp], recipes: [recipe("base", ["mcp/tracker"])], profiles: [profile("acme", ["base"])] },
      { config: { profile: "acme" }, files },
    );
    cleanups.push(s.cleanup);
    return s;
  }

  it("1. first sync: new → written with PLANNED, lock entry has ingredient mcp/*; second status: unchanged", async () => {
    const s = await exScenario();
    expect(await stateOf(s.wsRoot, EX)).toBe("new");
    await sync(s.wsRoot);
    expect(await fs.readFile(path.join(s.wsRoot, EX), "utf8")).toBe(PLANNED);
    const lock = await readLock(s.wsRoot);
    const entry = lock!.files.find((f) => f.path === EX);
    expect(entry?.ingredient).toBe("mcp/*");
    expect(await stateOf(s.wsRoot, EX)).toBe("unchanged");
  });

  it("2. remove authEnv from ingredient: orphan; sync removes file and lock entry", async () => {
    const s = await exScenario();
    await sync(s.wsRoot);
    // Remove authEnv from ingredient
    await fs.writeFile(
      path.join(s.forgeRoot, "ingredients/mcp/tracker/ingredient.yaml"),
      YAML.stringify({ type: "mcp", name: "tracker", server: { command: "npx" } }),
    );
    expect(await stateOf(s.wsRoot, EX)).toBe("orphan");
    await sync(s.wsRoot);
    expect(await exists(path.join(s.wsRoot, EX))).toBe(false);
    const lock = await readLock(s.wsRoot);
    expect(lock!.files.find((f) => f.path === EX)).toBeUndefined();
  });

  it("3. remove authEnv, but file edited first: orphan-drift; sync keeps the file", async () => {
    const s = await exScenario();
    await sync(s.wsRoot);
    await fs.appendFile(path.join(s.wsRoot, EX), " ");
    await fs.writeFile(
      path.join(s.forgeRoot, "ingredients/mcp/tracker/ingredient.yaml"),
      YAML.stringify({ type: "mcp", name: "tracker", server: { command: "npx" } }),
    );
    expect(await stateOf(s.wsRoot, EX)).toBe("orphan-drift");
    await sync(s.wsRoot);
    expect(await exists(path.join(s.wsRoot, EX))).toBe(true);
  });

  it("4. hand edit (replace \"\" with \"typed\"): drift; sync leaves file; with overwriteDrift the file is PLANNED", async () => {
    const s = await exScenario();
    await sync(s.wsRoot);
    const edited = PLANNED.replace('""', '"typed"');
    await fs.writeFile(path.join(s.wsRoot, EX), edited);
    expect(await stateOf(s.wsRoot, EX)).toBe("drift");
    await sync(s.wsRoot);
    expect(await fs.readFile(path.join(s.wsRoot, EX), "utf8")).toBe(edited);
    await sync(s.wsRoot, { overwriteDrift: true });
    expect(await fs.readFile(path.join(s.wsRoot, EX), "utf8")).toBe(PLANNED);
  });

  it("5. no lock entry, file on disk parses to same value with same key order: adopt", async () => {
    const compact = '{"env":{"ACME_TRACKER_TOKEN":""}}';
    const s = await exScenario({ [EX]: compact });
    expect(await stateOf(s.wsRoot, EX)).toBe("adopt");
  });

  it("6. no lock entry, file on disk has different key: collision; sync does not write it", async () => {
    const different = '{"env":{"OTHER":""}}';
    const s = await exScenario({ [EX]: different });
    expect(await stateOf(s.wsRoot, EX)).toBe("collision");
    await sync(s.wsRoot);
    expect(await fs.readFile(path.join(s.wsRoot, EX), "utf8")).toBe(different);
  });

  it("7. hand-maintained .claude/settings.example.json next to it: unchanged after sync and not in status", async () => {
    const handMaintained = '{"permissions":{}}\n';
    const s = await exScenario({ ".claude/settings.example.json": handMaintained });
    await sync(s.wsRoot);
    expect(await fs.readFile(path.join(s.wsRoot, ".claude/settings.example.json"), "utf8")).toBe(handMaintained);
    const { st } = await statuses(s.wsRoot);
    expect(st.find((x) => x.path === ".claude/settings.example.json")).toBeUndefined();
  });
});
