import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { apply, loadWorkspace, plan, readLock, status, type ApplyOptions } from "../src/core/sync.js";
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
