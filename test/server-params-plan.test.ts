import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { exists } from "../src/core/forge.js";
import { loadWorkspace, plan, unsetDeclared } from "../src/core/sync.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, writeFiles, type ForgeSpec, type IngredientSpec } from "./helpers/forge.js";
import { forgeAt, mcp, states, sync } from "./helpers/integrations.js";

// Spec 34 §9 — the rendered server in both MCP files, the gate, the three warnings and the plan error.

const GHP = "ghp_" + "x".repeat(36); // assembled at runtime on purpose
const HIGH = ["a1b2c3d4", "e5f6", "7890", "abcd", "ef1234567890"].join("-"); // a GUID the entropy rule matches (spec §4.3)
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
async function planned(schema: number, spec: ForgeSpec) {
  const s = await forgeAt(schema, spec);
  cleanups.push(s.cleanup);
  return { s, p: await plan(await loadWorkspace(s.wsRoot)) };
}
const file = (p: Awaited<ReturnType<typeof plan>>, f: string) => p.files.find((x) => x.path === f)?.content.toString("utf8");
const mcpJson = (servers: Record<string, unknown>) => JSON.stringify({ mcpServers: servers }, null, 2) + "\n";
const failure = (schema: number, spec: ForgeSpec) => planned(schema, spec).then(() => "no error", (e: Error) => e.message);
/** Spec §1's example: one ingredient, the address from the profile's block (no kind: params only). */
const EXAMPLE = forge({ type: "http", url: "{{integrations.idp.url}}" }, { declare: { "integrations.idp.url": {} }, block: { idp: { url: URL } } });
const BRACES = '{\n  "mcpServers": {\n    "idp": {\n      "type": "http",\n      "url": "{{integrations.idp.url}}"\n    }\n  }\n}\n';
const RENDERED = '{\n  "mcpServers": {\n    "idp": {\n      "type": "http",\n      "url": "https://idp.example.com/mcp"\n    }\n  }\n}\n';

describe("rendered server in MCP files", () => {
  it("case 1: schema 4: both MCP files hold the rendered server (criterion 1)", async () => {
    const { p } = await planned(4, EXAMPLE);
    expect(file(p, ".mcp.json")).toBe(RENDERED);
    expect(file(p, ".kiro/settings/mcp.json")).toBe(RENDERED.replace(/\n/g, "\r\n"));
    expect(p.warnings).toEqual([]);
    expect(p.missingParams).toEqual([]);
  });

  it("case 2: schema 1, 2 and 3: the braces, byte for byte, and no new warning (criterion 2)", async () => {
    for (const schema of [1, 2, 3]) {
      const { p } = await planned(schema, EXAMPLE);
      expect(file(p, ".mcp.json")).toBe(BRACES);
      expect(file(p, ".kiro/settings/mcp.json")).toBe(BRACES.replace(/\n/g, "\r\n"));
      expect(p.warnings).toEqual([]);
    }
  });

  it("case 3: schema 4, nothing to substitute: the bytes of schema 3", async () => {
    const spec = forge({ command: "npx", args: ["-y", "x", "{{free}}", "{{ 'X' | localize }}", "${HOME}"] });
    const { p: p3 } = await planned(3, spec);
    const { p: p4 } = await planned(4, spec);
    expect(file(p4, ".mcp.json")).toBe(file(p3, ".mcp.json"));
    expect(p3.warnings).toEqual([]);
    expect(p4.warnings).toEqual([]);
  });

  it("case 4: key order and nesting are the Forge's", async () => {
    const spec = forge(
      { url: "{{u}}", type: "http", headers: { B: "{{u}}", A: "1", deep: { z: "{{u}}", a: 2 } }, args: ["{{u}}", "3"], n: 3 },
      { declare: { u: {} }, params: { u: "v" } }
    );
    const { p } = await planned(4, spec);
    expect(file(p, ".mcp.json")).toBe(mcpJson({ idp: { url: "v", type: "http", headers: { B: "v", A: "1", deep: { z: "v", a: 2 } }, args: ["v", "3"], n: 3 } }));
  });

  it("case 5: a number renders as a string; a value with a quote and a line break is escaped by the serializer", async () => {
    const spec = forge({ port: "{{port}}", note: "{{note}}" }, { declare: { port: {}, note: {} }, params: { port: 8080, note: 'a"b\nc' } });
    const { p } = await planned(4, spec);
    expect(JSON.parse(file(p, ".mcp.json")!).mcpServers.idp).toEqual({ port: "8080", note: 'a"b\nc' });
  });

  it("case 6: layers: the ingredient's default, a recipe default, the block, the profile's params, the workspace", async () => {
    // Default from ingredient
    const spec1 = forge({ url: "{{k}}" }, { declare: { k: { default: "ingredient" } } });
    const { p: p1 } = await planned(4, spec1);
    expect(JSON.parse(file(p1, ".mcp.json")!).mcpServers.idp.url).toBe("ingredient");

    // Profile params wins over ingredient default
    const spec2 = forge({ url: "{{k}}" }, { declare: { k: { default: "ingredient" } }, params: { k: "profile" } });
    const { p: p2 } = await planned(4, spec2);
    expect(JSON.parse(file(p2, ".mcp.json")!).mcpServers.idp.url).toBe("profile");

    // Workspace wins over all
    const spec3 = forge({ url: "{{k}}" }, { declare: { k: { default: "ingredient" } }, params: { k: "profile" } });
    const s3 = await forgeAt(4, spec3, { config: { profile: "acme", overrides: { params: { k: "workspace" } } } });
    cleanups.push(s3.cleanup);
    const p3 = await plan(await loadWorkspace(s3.wsRoot));
    expect(JSON.parse(file(p3, ".mcp.json")!).mcpServers.idp.url).toBe("workspace");

    // Recipe default
    const spec4: ForgeSpec = {
      ingredients: [rule("workflow", "# Workflow\n"), mcp("idp", { url: "{{k}}" }, { params: { k: {} } })],
      recipes: [recipe("base", ["rule/workflow", "mcp/idp"], { params: { k: { default: "recipe" } } })],
      profiles: [profile("acme", ["base"], ["claude-code", "kiro"], {})],
    };
    const { p: p4 } = await planned(4, spec4);
    expect(JSON.parse(file(p4, ".mcp.json")!).mcpServers.idp.url).toBe("recipe");
  });

  it("case 7: declared, cited, no value: left as written, reported as missing, and the sync is refused (spec §4.2; spec 29 slice A)", async () => {
    // Schema 4 with no value
    const spec = forge({ type: "http", url: "{{integrations.idp.url}}" }, { declare: { "integrations.idp.url": {} }, block: {} });
    const { s, p } = await planned(4, spec);
    expect(file(p, ".mcp.json")).toBe(BRACES);
    expect(p.missingParams).toEqual([
      { key: "integrations.idp.url", refs: ["mcp/idp"], warning: 'param "integrations.idp.url" has no value in any layer — left verbatim (mcp/idp)', declaredBy: ["mcp/idp"] },
    ]);
    expect(unsetDeclared(p)).toEqual([{ key: "integrations.idp.url", declaredBy: ["mcp/idp"], citedBy: ["mcp/idp"] }]);

    const r = runCli(["sync", "--workspace", s.wsRoot]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      "error: 1 declared parameter(s) have no value — nothing written\n  integrations.idp.url  declared by mcp/idp · cited by mcp/idp\n  fix: set each under params in the profile, or under overrides.params in craftar.yaml\n"
    );
    expect(await exists(path.join(s.wsRoot, ".mcp.json"))).toBe(false);

    // Control: Schema 3 with the same Forge — no error
    const { p: p3 } = await planned(3, spec);
    expect(p3.missingParams).toEqual([]);
    const s3 = await forgeAt(3, spec);
    cleanups.push(s3.cleanup);
    const r3 = runCli(["sync", "--workspace", s3.wsRoot]);
    expect(r3.code).toBe(0);
  });

  it("case 8: undeclared but valued: left, and warned once though two targets write it", async () => {
    const spec = forge({ type: "http", url: URL, headers: { "X-Org": "{{org}}" } }, { params: { org: "acme" } });
    const { p } = await planned(4, spec);
    expect(JSON.parse(file(p, ".mcp.json")!).mcpServers.idp.headers["X-Org"]).toBe("{{org}}");
    expect(p.warnings).toEqual(["mcp/idp: server cites {{org}}, which has a value but is not declared in the ingredient's params — left verbatim"]);

    // Control: Schema 3 with the same Forge — no warning
    const { p: p3 } = await planned(3, spec);
    expect(p3.warnings).toEqual([]);
  });

  it("case 9: undeclared and valueless: left, no warning (§6.2); ${NAME} and {{ 'X' | localize }} untouched", async () => {
    const spec = forge({ command: "npx", args: ["-y", "x", "{{free}}", "{{ 'X' | localize }}", "${HOME}"] });
    const { p } = await planned(4, spec);
    const content = file(p, ".mcp.json")!;
    expect(content).toContain('"{{free}}"');
    expect(content).toContain('"{{ \'X\' | localize }}"');
    expect(content).toContain('"${HOME}"');
  });

  it("case 10: row T fails the plan, in the spec's words, without the value", async () => {
    const spec = forge({ type: "http", url: URL, headers: { Authorization: "Bearer {{token}}" } }, { declare: { token: {} }, params: { token: GHP } });
    const m = await failure(4, spec);
    expect(m).toBe(
      "mcp/idp: the value rendered into server.headers.Authorization looks like a credential (github-token) — a generated file is committed, so a secret cannot come from a param; have the server read it from the environment"
    );
    expect(m.includes(GHP)).toBe(false);

    // Control: Schema 3 — no error, file holds the braces
    const m3 = await failure(3, spec);
    expect(m3).toBe("no error");
    const { p: p3 } = await planned(3, spec);
    expect(file(p3, ".mcp.json")).toContain("Bearer {{token}}");
  });

  it("case 11: row U fails the plan — also inside a longer leaf, also assembled from parts (§6.10–§6.12)", async () => {
    // URL with credentials in args (inside longer leaf)
    const spec1 = forge(
      { command: "npx", args: ["-y", "--url={{integrations.idp.url}}"] },
      { declare: { "integrations.idp.url": {} }, block: { idp: { url: "https://u:p@idp.example.com/" } } }
    );
    const m1 = await failure(4, spec1);
    expect(m1).toBe(
      "mcp/idp: the value rendered into server.args[1] holds a URL with credentials (url-credentials) — a generated file is committed, so a secret cannot come from a param; have the server read it from the environment"
    );
    expect(m1.includes("u:p")).toBe(false);

    // URL assembled from user and pass
    const spec2 = forge(
      { url: "https://{{user}}:{{pass}}@idp.example.com/" },
      { declare: { user: {}, pass: {} }, params: { user: "u", pass: "p" } }
    );
    const m2 = await failure(4, spec2);
    expect(m2).toContain("server.url");
    expect(m2).toContain("url-credentials");
    expect(m2.includes("u:p")).toBe(false);

    // §6.11: literal credentials with one placeholder for host
    const spec3 = forge(
      { url: "https://u:p@{{host}}/" },
      { declare: { host: {} }, params: { host: "idp.example.com" } }
    );
    const m3 = await failure(4, spec3);
    expect(m3).toContain("server.url");
    expect(m3).toContain("url-credentials");

    // Control: same literal with no placeholder — passes
    const spec4 = forge({ url: "https://u:p@idp.example.com/" });
    const m4 = await failure(4, spec4);
    expect(m4).toBe("no error");

    // ghp_ token assembled from parts in headers
    const spec5 = forge(
      { headers: { A: "ghp_{{rest}}" } },
      { declare: { rest: {} }, params: { rest: "x".repeat(36) } }
    );
    const m5 = await failure(4, spec5);
    expect(m5).toContain("server.headers.A");
    expect(m5).toContain("github-token");
    expect(m5.includes(GHP)).toBe(false);
  });

  it("case 12: row E warns, once, and the plan stands", async () => {
    const spec = forge(
      { command: "x", env: { ACME_KEY: "{{key}}" }, headers: { H: "{{key}}" } },
      { declare: { key: {} }, params: { key: HIGH } }
    );
    const { p } = await planned(4, spec);
    expect(p.warnings).toEqual([
      "mcp/idp: the value rendered into server.env.ACME_KEY may be a secret (high-entropy-value) — a generated file is committed; if it is one, have the server read it from the environment",
    ]);
    expect(JSON.parse(file(p, ".mcp.json")!).mcpServers.idp.env.ACME_KEY).toBe(HIGH);
    expect(p.warnings.some((w) => w.includes(HIGH))).toBe(false);
  });

  it("case 13: what passes and should", async () => {
    const spec = forge(
      { command: "npx", args: ["--org={{org}}", "{{url}}"], env: { TOKEN: "{{ref}}", HOST: "{{url}}" }, url: "{{auth}}" },
      {
        declare: { org: {}, url: {}, ref: {}, auth: {} },
        params: {
          org: "acme",
          url: "https://dev.azure.com/acme/Portal",
          ref: "${ACME_TOKEN}",
          auth: "https://${IDP_USER}:${IDP_TOKEN}@idp.example.com/",
        },
      }
    );
    const { p } = await planned(4, spec);
    expect(p.warnings).toEqual([]);
    const server = JSON.parse(file(p, ".mcp.json")!).mcpServers.idp;
    expect(server.args).toEqual(["--org=acme", "https://dev.azure.com/acme/Portal"]);
    expect(server.env).toEqual({ TOKEN: "${ACME_TOKEN}", HOST: "https://dev.azure.com/acme/Portal" });
    expect(server.url).toBe("https://${IDP_USER}:${IDP_TOKEN}@idp.example.com/");
  });

  it("case 14: a variant with `as` (§6.13)", async () => {
    // Variant with as but no params declaration — the braces stay
    const spec1: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        mcp("idp", { url: "{{k}}" }, { params: { k: { default: "base" } } }),
        mcp("idp--acme", { url: "{{k}}" }, { as: "idp" }),
      ],
      recipes: [recipe("base", ["rule/workflow", "mcp/idp--acme"])],
      profiles: [profile("acme", ["base"], ["claude-code", "kiro"], { params: { k: "profile" } })],
    };
    const { p: p1 } = await planned(4, spec1);
    expect(file(p1, ".mcp.json")).toContain('"url": "{{k}}"');
    expect(p1.warnings).toEqual([
      "mcp/idp--acme: server cites {{k}}, which has a value but is not declared in the ingredient's params — left verbatim",
    ]);

    // Same variant with params: {} — renders the value
    const spec2: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        mcp("idp", { url: "{{k}}" }, { params: { k: { default: "base" } } }),
        mcp("idp--acme", { url: "{{k}}" }, { as: "idp", params: { k: {} } }),
      ],
      recipes: [recipe("base", ["rule/workflow", "mcp/idp--acme"])],
      profiles: [profile("acme", ["base"], ["claude-code", "kiro"], { params: { k: "profile" } })],
    };
    const { p: p2 } = await planned(4, spec2);
    expect(JSON.parse(file(p2, ".mcp.json")!).mcpServers.idp.url).toBe("profile");
    expect(p2.warnings).toEqual([]);
  });

  it("case 15: two ingredients writing one server name: only the survivor is rendered and checked (§6.14)", async () => {
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        mcp("idp", { headers: { A: "{{token}}" } }, { params: { token: {} } }),
        mcp("idp--acme", { url: URL }, { as: "idp" }),
      ],
      recipes: [recipe("base", ["rule/workflow", "mcp/idp", "mcp/idp--acme"])],
      profiles: [profile("acme", ["base"], ["claude-code", "kiro"], { params: { token: GHP } })],
    };
    const { p } = await planned(4, spec);
    // Does NOT fail — the dropped ingredient's credential is not checked
    expect(JSON.parse(file(p, ".mcp.json")!).mcpServers.idp.url).toBe(URL);
    // The collision warnings — print once at <BASE> on schema 3 then pin
    expect(p.warnings).toEqual([
      'claude-code: two ingredients write the MCP server "idp" into .mcp.json: mcp/idp and mcp/idp--acme (last wins)',
      'kiro: two ingredients write the MCP server "idp" into .kiro/settings/mcp.json: mcp/idp and mcp/idp--acme (last wins)',
    ]);

    // Verify same warnings at schema 3
    const { p: p3 } = await planned(3, spec);
    expect(p3.warnings).toEqual([
      'claude-code: two ingredients write the MCP server "idp" into .mcp.json: mcp/idp and mcp/idp--acme (last wins)',
      'kiro: two ingredients write the MCP server "idp" into .kiro/settings/mcp.json: mcp/idp and mcp/idp--acme (last wins)',
    ]);
  });

  it("case 16: an ingredient aimed only at a target that skips MCP is neither rendered nor checked (§6.15)", async () => {
    const spec = forge(
      { type: "http", url: URL, headers: { Authorization: "Bearer {{token}}" } },
      { declare: { token: {} }, params: { token: GHP }, targets: ["claude-code", "agents-md"], meta: { targets: ["agents-md"] } }
    );
    const { p } = await planned(4, spec);
    // Does NOT fail — ingredient aimed at agents-md is not rendered
    expect(p.warnings).toEqual(["agents-md: 1 mcp ingredient(s) have no AGENTS.md equivalent — skipped: mcp/idp"]);
    expect(p.files.find((f) => f.path === ".mcp.json")).toBeUndefined();
  });

  it("case 17: an existing .mcp.json equal to the rendered server as JSON adopts (§6.21)", async () => {
    const s = await forgeAt(4, EXAMPLE);
    cleanups.push(s.cleanup);
    // Write one-line JSON that parses to the same value
    await writeFiles(s.wsRoot, { ".mcp.json": JSON.stringify(JSON.parse(RENDERED)) });
    const st = await states(s.wsRoot);
    expect(st[".mcp.json"]).toBe("adopt");

    // With braces instead — collision
    const s2 = await forgeAt(4, EXAMPLE);
    cleanups.push(s2.cleanup);
    await writeFiles(s2.wsRoot, { ".mcp.json": JSON.stringify(JSON.parse(BRACES)) });
    const st2 = await states(s2.wsRoot);
    expect(st2[".mcp.json"]).toBe("collision");
  });

  it("case 18: a Forge that moves from 3 to 4 sees update on its MCP files (§6.17)", async () => {
    const s = await forgeAt(3, EXAMPLE);
    cleanups.push(s.cleanup);
    await sync(s.wsRoot);

    // Rewrite manifest to schema 4
    await fs.writeFile(path.join(s.forgeRoot, "craftar.forge.yaml"), "name: test-forge\nschema: 4\n");

    const st = await states(s.wsRoot);
    expect(st[".mcp.json"]).toBe("update");
    expect(st[".kiro/settings/mcp.json"]).toBe("update");
    expect(st[".claude/rules/workflow.md"]).toBe("unchanged");
  });
});
