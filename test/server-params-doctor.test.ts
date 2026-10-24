import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runDoctor, type Check, type DoctorOptions } from "../src/core/doctor.js";
import { profile, recipe, rule, type ForgeSpec, type IngredientSpec } from "./helpers/forge.js";
import { forgeAt, mcp } from "./helpers/integrations.js";

// Spec 34 §9 — doctor checks for mcp-env and params on rendered servers.

const GHP = "ghp_" + "x".repeat(36); // assembled at runtime on purpose
const HIGH = ["a1b2c3d4", "e5f6", "7890", "abcd", "ef1234567890"].join("-"); // a GUID the entropy rule matches
const URL = "https://idp.example.com/mcp";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

interface Opts { declare?: Record<string, unknown>; params?: Record<string, unknown>; block?: Record<string, unknown>; targets?: string[]; extra?: IngredientSpec[]; refs?: string[]; meta?: Record<string, unknown> }
const forge = (server: Record<string, unknown>, o: Opts = {}): ForgeSpec => ({
  ingredients: [rule("workflow", "# Workflow\n"), mcp("idp", server, { ...(o.declare ? { params: o.declare } : {}), ...(o.meta ?? {}) }), ...(o.extra ?? [])],
  recipes: [recipe("base", ["rule/workflow", "mcp/idp", ...(o.refs ?? [])])],
  profiles: [profile("acme", ["base"], o.targets ?? ["claude-code", "kiro"], { integrations: o.block ?? {}, params: o.params ?? {} })],
});

const run = (o: Partial<DoctorOptions> & { home: string; workspace?: string }) =>
  runDoctor({ version: "0.0.0", workspace: o.workspace ?? null, fetch: false, strict: false, registryOff: false, env: o.env ?? {}, nodeVersion: "22.11.0", gitVersion: async () => "2.53.0", ...o });

const of = (checks: Check[], id: string) => checks.filter((c) => c.id === id);

/** Spec §1's example: one ingredient, the address from the profile's block (no kind: params only). */
const EXAMPLE = forge({ type: "http", url: "{{integrations.idp.url}}" }, { declare: { "integrations.idp.url": {} }, block: { idp: { url: URL } } });

describe("doctor reads the rendered server at schema 4", () => {
  it("case 19: mcp-env sees a ${NAME} a value brings into env, at schema 4 and not at 3", async () => {
    const spec = forge({ command: "x", env: { TOKEN: "{{tok}}" } }, { declare: { tok: {} }, params: { tok: "${ACME_TOKEN}" } });
    
    // At schema 4, env: {} — the variable is unset
    const s4 = await forgeAt(4, spec);
    cleanups.push(s4.cleanup);
    const r4 = await run({ home: path.join(s4.root, "home"), workspace: s4.wsRoot, env: {} });
    expect(of(r4.checks, "mcp-env")).toEqual([
      { id: "mcp-env", scope: "workspace", level: "warn", message: 'server "idp" expects ACME_TOKEN, not set', fix: "export ACME_TOKEN" },
    ]);

    // At schema 4, env: { ACME_TOKEN: "1" } — the variable is set
    const s4set = await forgeAt(4, spec);
    cleanups.push(s4set.cleanup);
    const r4set = await run({ home: path.join(s4set.root, "home"), workspace: s4set.wsRoot, env: { ACME_TOKEN: "1" } });
    expect(of(r4set.checks, "mcp-env")).toEqual([
      { id: "mcp-env", scope: "workspace", level: "ok", message: "every variable a written MCP server expects is set", fix: null },
    ]);

    // At schema 3 (control), env: {} — the ok line because the variable reference is not rendered
    const s3 = await forgeAt(3, spec);
    cleanups.push(s3.cleanup);
    const r3 = await run({ home: path.join(s3.root, "home"), workspace: s3.wsRoot, env: {} });
    expect(of(r3.checks, "mcp-env")).toEqual([
      { id: "mcp-env", scope: "workspace", level: "ok", message: "every variable a written MCP server expects is set", fix: null },
    ]);
  });

  it("case 20: a ${NAME} brought into url is not checked, as for a literal today", async () => {
    const spec = forge({ url: "{{u}}" }, { declare: { u: {} }, params: { u: "https://${IDP_HOST}/mcp" } });
    const s = await forgeAt(4, spec);
    cleanups.push(s.cleanup);
    const r = await run({ home: path.join(s.root, "home"), workspace: s.wsRoot, env: {} });
    // The ok line — ${IDP_HOST} in url is not checked
    expect(of(r.checks, "mcp-env")).toEqual([
      { id: "mcp-env", scope: "workspace", level: "ok", message: "every variable a written MCP server expects is set", fix: null },
    ]);
  });

  it("case 21: params gains the server's ref in 'cited by'", async () => {
    const spec = forge({ type: "http", url: "{{integrations.idp.url}}" }, { declare: { "integrations.idp.url": {} }, block: {} });

    // At schema 4 — cited by mcp/idp
    const s4 = await forgeAt(4, spec);
    cleanups.push(s4.cleanup);
    const r4 = await run({ home: path.join(s4.root, "home"), workspace: s4.wsRoot });
    expect(of(r4.checks, "params")).toEqual([
      { id: "params", scope: "workspace", level: "error", message: '"integrations.idp.url" declared by mcp/idp has no value — cited by mcp/idp', fix: "set integrations.idp.url in the profile's params or overrides.params" },
    ]);

    // At schema 3 (control) — no cited by, just warn level
    const s3 = await forgeAt(3, spec);
    cleanups.push(s3.cleanup);
    const r3 = await run({ home: path.join(s3.root, "home"), workspace: s3.wsRoot });
    expect(of(r3.checks, "params")).toEqual([
      { id: "params", scope: "workspace", level: "warn", message: '"integrations.idp.url" declared by mcp/idp has no value', fix: "set integrations.idp.url in the profile's params or overrides.params" },
    ]);
  });

  it("case 22: the credential error is one error plan line, without the value", async () => {
    const spec = forge({ type: "http", url: URL, headers: { Authorization: "Bearer {{token}}" } }, { declare: { token: {} }, params: { token: GHP } });
    const s = await forgeAt(4, spec);
    cleanups.push(s.cleanup);
    const r = await run({ home: path.join(s.root, "home"), workspace: s.wsRoot });
    
    expect(of(r.checks, "plan")).toEqual([
      {
        id: "plan",
        scope: "workspace",
        level: "error",
        message: "mcp/idp: the value rendered into server.headers.Authorization looks like a credential (github-token) — a generated file is committed, so a secret cannot come from a param; have the server read it from the environment",
        fix: null,
      },
    ]);

    // The value is not in any output
    expect(JSON.stringify(r).includes(GHP)).toBe(false);

    // mcp-env and params are empty because the plan failed
    expect(of(r.checks, "mcp-env")).toEqual([]);
    expect(of(r.checks, "params")).toEqual([]);
  });

  it("case 23: the entropy warning is a warn plan line", async () => {
    const spec = forge(
      { command: "x", env: { ACME_KEY: "{{key}}" }, headers: { H: "{{key}}" } },
      { declare: { key: {} }, params: { key: HIGH } }
    );
    const s = await forgeAt(4, spec);
    cleanups.push(s.cleanup);
    const r = await run({ home: path.join(s.root, "home"), workspace: s.wsRoot });
    
    expect(of(r.checks, "plan")).toEqual([
      {
        id: "plan",
        scope: "workspace",
        level: "warn",
        message: "mcp/idp: the value rendered into server.env.ACME_KEY may be a secret (high-entropy-value) — a generated file is committed; if it is one, have the server read it from the environment",
        fix: null,
      },
    ]);
  });

  it("case 24: at schema 4 a command that is a declared param valued cmd warns; at schema 3 it does not", async () => {
    const spec = forge({ command: "{{launcher}}", args: ["/c", "npx"] }, { declare: { launcher: {} }, params: { launcher: "cmd" } });
    const s4 = await forgeAt(4, spec);
    cleanups.push(s4.cleanup);
    const r4 = await run({ home: path.join(s4.root, "home"), workspace: s4.wsRoot });
    const checks4 = of(r4.checks, "mcp-launcher");
    expect(checks4).toHaveLength(1);
    expect(checks4[0].level).toBe("warn");
    expect(checks4[0].message).toBe('server "idp" starts through cmd /c \u2014 Windows only; it does not start on Linux or macOS (.mcp.json, .kiro/settings/mcp.json)');

    const s3 = await forgeAt(3, spec);
    cleanups.push(s3.cleanup);
    const r3 = await run({ home: path.join(s3.root, "home"), workspace: s3.wsRoot });
    const checks3 = of(r3.checks, "mcp-launcher");
    expect(checks3).toHaveLength(1);
    expect(checks3[0].level).toBe("ok");
  });
});
