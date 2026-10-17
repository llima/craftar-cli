import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { listFiles } from "../src/core/forge.js";
import { profile, recipe, rule, type ForgeSpec } from "./helpers/forge.js";
import { forgeAt, mcp } from "./helpers/integrations.js";
import { startMcp } from "./helpers/mcp-process.js";

// Spec 35 beside spec 34: what `craftar mcp` answers for a workspace whose Forge is at schema 4 and whose profile
// gives a param rendered into an MCP server a value that looks like a credential. The plan is refused (spec 34
// §4.5); a tool result goes wherever the AI coder sends its context, so no result may hold the value.

const GHP = "ghp_" + "x".repeat(36); // assembled at runtime on purpose
const MESSAGE =
  "mcp/idp: the value rendered into server.headers.Authorization looks like a credential (github-token) — a generated file is committed, so a secret cannot come from a param; have the server read it from the environment";
const SERVER = { type: "http", url: "https://idp.example.com/mcp", headers: { Authorization: "Bearer {{token}}" } };
/** `token` declared with a default; the profile gives it the token-like value when `withToken`. */
const forge = (withToken: boolean): ForgeSpec => ({
  ingredients: [rule("workflow", "# Workflow\n"), mcp("idp", SERVER, { params: { token: { default: "public" } } })],
  recipes: [recipe("base", ["rule/workflow", "mcp/idp"])],
  profiles: [profile("acme", ["base"], ["claude-code", "kiro"], withToken ? { params: { token: GHP } } : {})],
});
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } };
const CALLS: Array<[string, Record<string, unknown>?]> = [
  ["status"],
  ["diff"],
  ["diff", { path: ".mcp.json" }],
  ["explain", { path: ".mcp.json" }],
  ["recipes"],
  ["ingredients"],
  ["targets"],
  ["doctor"],
];

const cleanups: Array<() => Promise<unknown>> = [];
const children: Array<ReturnType<typeof startMcp>> = [];
afterEach(async () => {
  for (const c of children.splice(0)) c.kill();
  while (cleanups.length) await cleanups.pop()!();
});
/** One session: every call of CALLS, in order, then the end of input. */
async function session(withToken: boolean) {
  const s = await forgeAt(4, forge(withToken));
  cleanups.push(s.cleanup);
  const m = startMcp(["--workspace", s.wsRoot], { env: { CRAFTAR_HOME: path.join(s.root, "home") } });
  children.push(m);
  expect((await m.request("initialize", INIT)).result.protocolVersion).toBe("2025-06-18");
  const results: any[] = [];
  for (const [name, args] of CALLS) results.push(await m.tool(name, args));
  return { s, results, end: await m.end() };
}

describe("craftar mcp — a schema 4 Forge whose param value looks like a credential", () => {
  it("the tools that plan answer isError with the plan's one line; no result and no stderr holds the value; nothing is written", async () => {
    const { s, results, end } = await session(true);
    // the value is really there to leak: the profile holds it
    expect(await fs.readFile(path.join(s.forgeRoot, "profiles/acme/profile.yaml"), "utf8")).toContain(GHP);

    const [status, diff, diffPath, explain, recipes, ingredients, targets, doctor] = results;
    for (const r of [status, diff, diffPath, explain]) expect(r).toEqual({ content: [{ type: "text", text: MESSAGE }], isError: true });
    // the catalogue reads the Forge as written and never plans: it answers
    for (const r of [recipes, ingredients, targets]) expect(r.isError).toBeUndefined();
    expect(ingredients.structuredContent.ingredients.map((i: { ref: string }) => i.ref)).toEqual(["rule/workflow", "mcp/idp"]);
    // doctor answers, and reports the refusal as its plan check
    expect(doctor.isError).toBeUndefined();
    const plan = doctor.structuredContent.checks.filter((c: { id: string }) => c.id === "plan");
    expect(plan.map((c: { level: string; message: string }) => [c.level, c.message])).toEqual([["error", MESSAGE]]);

    for (const r of results) expect(JSON.stringify(r)).not.toContain(GHP);
    expect(end.stdout).not.toContain(GHP);
    expect([end.code, end.stderr]).toEqual([0, ""]);
    expect(await listFiles(s.wsRoot)).toEqual(["craftar.yaml"]);
  });

  it("control: the same Forge without the token-like value plans, and every tool answers", async () => {
    const { results, end } = await session(false);
    const [status, diff, diffPath, explain, , , , doctor] = results;
    for (const r of results) expect(r.isError).toBeUndefined();
    expect(status.structuredContent.statuses.find((f: { path: string }) => f.path === ".mcp.json").state).toBe("new");
    expect(diff.structuredContent).toBeDefined();
    // the planned side of .mcp.json holds the rendered value — the bytes sync would commit
    expect(JSON.stringify(diffPath)).toContain("Bearer public");
    expect(explain.structuredContent.ingredient).toBe("mcp/*");
    expect(doctor.structuredContent.checks.filter((c: { id: string; level: string }) => c.id === "plan").map((c: { level: string }) => c.level)).toEqual(["ok"]);
    expect([end.code, end.stderr]).toEqual([0, ""]);
  });
});
