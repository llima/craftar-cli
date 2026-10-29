import { describe, expect, it } from "vitest";
import { credentialIn, credentialMessage, entropyMessage, holdsBaseCitations, registrationCitations, rendersServers, renderServer, serverCitations, serverSecret, undeclaredMessage, type SubstitutedLeaf } from "../src/core/mcp-server.js";
import { IngredientSchema, type Ingredient } from "../src/schema/index.js";

// Spec 34 §9 — the one place a server is rendered or scanned for placeholders.

type McpMeta = Extract<Ingredient, { type: "mcp" }>;
const GHP = "ghp_" + "x".repeat(36); // assembled at runtime on purpose
const AZDO = "a1".repeat(26); // the legacy 52-character shape, assembled at runtime
const DECLARED = { "idp.url": {}, org: {}, port: {} };
/** `params: null` builds an ingredient with NO `params` key (`undefined` would take the default). */
const meta = (server: unknown, params: Record<string, unknown> | null = DECLARED, extra: Record<string, unknown> = {}): McpMeta =>
  IngredientSchema.parse({ type: "mcp", name: "idp", server, ...(params === null ? {} : { params }), ...extra }) as McpMeta;
/** A params record as `paramsFor` builds it: a null prototype, own keys only. */
const P = (o: Record<string, unknown>): Record<string, unknown> => Object.assign(Object.create(null), o);
const json = (v: unknown) => JSON.stringify(v);
const leaf = (path: string, value: string): SubstitutedLeaf => ({ path, under: path.split(/[.[]/)[0], value });

describe("rendersServers", () => {
  it("is false at 1, 2 and 3, true at 4", () => {
    expect([1, 2, 3, 4].map((schema) => rendersServers({ schema } as Parameters<typeof rendersServers>[0]))).toEqual([false, false, false, true]);
  });
});

describe("renderServer", () => {
  const SRC = {
    type: "http",
    url: "{{idp.url}}",
    args: ["-y", "--org={{org}}", "{{ port }}"],
    env: { ORG: "{{org}}", KEEP: "${NAME}" },
    headers: { nested: { "X-Org": "{{org}}", "X-L": "{{ 'X' | localize }}" } },
    n: 5,
    b: true,
    z: null,
  };
  const VALUES = P({ "idp.url": "https://idp.example.com/mcp", org: "acme", port: 8080 });

  it("substitutes a declared key in url, in an args item, in env and in a nested headers value — key order kept at every depth", () => {
    const r = renderServer(meta(SRC), VALUES);
    expect(json(r.server)).toBe(
      '{"type":"http","url":"https://idp.example.com/mcp","args":["-y","--org=acme","8080"],"env":{"ORG":"acme","KEEP":"${NAME}"},"headers":{"nested":{"X-Org":"acme","X-L":"{{ \'X\' | localize }}"}},"n":5,"b":true,"z":null}',
    );
    expect([r.missing, r.undeclared]).toEqual([[], []]);
  });

  it("lists every substituted leaf with its path, its top-level key and its rendered value, in the server's order", () => {
    expect(renderServer(meta(SRC), VALUES).substituted).toEqual([
      { path: "url", under: "url", value: "https://idp.example.com/mcp" },
      { path: "args[1]", under: "args", value: "--org=acme" },
      { path: "args[2]", under: "args", value: "8080" },
      { path: "env.ORG", under: "env", value: "acme" },
      { path: "headers.nested.X-Org", under: "headers", value: "acme" },
    ]);
  });

  it("returns the very object it was given when nothing is substituted", () => {
    const m = meta({ command: "npx", args: ["{{free}}", "{{ 'X' | localize }}", "${HOME}"] });
    const r = renderServer(m, P({ org: "acme" }));
    expect(r.server).toBe(m.server);
    expect([r.missing, r.undeclared, r.substituted]).toEqual([[], [], []]);
  });

  it("keeps the untouched containers of a server it rebuilds", () => {
    const m = meta({ url: "{{org}}", args: ["a", "b"], env: { A: "1" } });
    const r = renderServer(m, P({ org: "acme" }));
    expect(r.server).not.toBe(m.server);
    expect((r.server as { args: unknown }).args).toBe((m.server as { args: unknown }).args);
    expect((r.server as { env: unknown }).env).toBe((m.server as { env: unknown }).env);
  });

  it("does not mutate the Forge's object", () => {
    const m = meta(SRC);
    const before = json(m.server);
    renderServer(m, VALUES);
    expect(json(m.server)).toBe(before);
  });

  it("two placeholders in one leaf, one declared: the declared one is replaced, the other stays, the leaf is substituted (§6.9); an undeclared valued key is reported, a declared valueless one is missing", () => {
    const r = renderServer(meta({ url: "{{team}}/{{idp.url}}/{{org}}" }, { "idp.url": {}, org: {} }), P({ team: "t", org: "acme" }));
    expect(json(r.server)).toBe('{"url":"{{team}}/{{idp.url}}/acme"}');
    expect([r.missing, r.undeclared, r.substituted.map((x) => x.path)]).toEqual([["idp.url"], ["team"], ["url"]]);
  });

  it("an undeclared valueless key is left and reported nowhere (§6.2)", () => {
    const m = meta({ url: "{{nobody}}" });
    const r = renderServer(m, P({}));
    expect(r.server).toBe(m.server);
    expect([r.missing, r.undeclared, r.substituted]).toEqual([[], [], []]);
  });

  it("a declared key the server does not cite is nothing (§6.16)", () => {
    expect(renderServer(meta({ url: "https://idp.example.com" }), P({})).missing).toEqual([]);
  });

  it("a key is never substituted (§6.8)", () => {
    const m = meta({ env: { "{{org}}": "x" } });
    const r = renderServer(m, P({ org: "acme" }));
    expect(r.server).toBe(m.server);
    expect(r.substituted).toEqual([]);
  });

  it("a value with a quote, a backslash and a line break round-trips through the serializer", () => {
    const r = renderServer(meta({ url: "{{org}}" }), P({ org: 'a"b\\c\nd' }));
    expect(JSON.parse(JSON.stringify(r.server, null, 2)).url).toBe('a"b\\c\nd');
  });

  it("{{ k }} with spaces is a placeholder (§6.3); a value holding {{other}} is not substituted again (§6.4)", () => {
    expect(json(renderServer(meta({ url: "{{ org }}" }), P({ org: "acme" })).server)).toBe('{"url":"acme"}');
    expect(json(renderServer(meta({ url: "{{org}}" }), P({ org: "{{port}}", port: 1 })).server)).toBe('{"url":"{{port}}"}');
  });

  it("a number and a boolean render as strings (§6.6); a mapping and a list render through String() (§6.7)", () => {
    expect(json(renderServer(meta({ a: "{{org}}", b: "{{port}}" }), P({ org: true, port: 8080 })).server)).toBe('{"a":"true","b":"8080"}');
    expect(json(renderServer(meta({ a: "{{org}}", b: "{{port}}" }), P({ org: { x: 1 }, port: [1, 2] })).server)).toBe('{"a":"[object Object]","b":"1,2"}');
  });

  it("a __proto__ key survives as an entry, on a null prototype", () => {
    const m = meta(JSON.parse('{"env":{"__proto__":"{{org}}","A":"1"}}'));
    const r = renderServer(m, P({ org: "acme" }));
    expect(json(r.server)).toBe('{"env":{"__proto__":"acme","A":"1"}}');
    expect(Object.getPrototypeOf((r.server as { env: object }).env)).toBeNull();
    expect(Object.getPrototypeOf(r.server)).toBeNull();
  });

  it("a key named like an Object.prototype member is neither declared nor valued by accident", () => {
    const m = meta({ url: "{{constructor}}/{{toString}}" }, {});
    const r = renderServer(m, P({}));
    expect(r.server).toBe(m.server);
    expect([r.missing, r.undeclared]).toEqual([[], []]);
  });

  it("an ingredient with no params key substitutes nothing and reports a valued key as undeclared", () => {
    const m = meta({ url: "{{org}}" }, null);
    const r = renderServer(m, P({ org: "acme" }));
    expect(r.server).toBe(m.server);
    expect(r.undeclared).toEqual(["org"]);
  });
});

describe("serverCitations", () => {
  it("each key once, in the server's order, declared or not; {{ 'X' | localize }} and ${NAME} are not placeholders", () => {
    expect(serverCitations(meta({ url: "{{idp.url}}", h: ["{{team}}", "{{idp.url}}", "{{ 'X' | localize }}", "${HOME}"], env: { "{{org}}": "{{ port }}" } }))).toEqual([
      { key: "idp.url", declared: true },
      { key: "team", declared: false },
      { key: "port", declared: true },
    ]);
  });

  it("is empty for an ingredient that is not mcp", () => {
    expect(serverCitations(IngredientSchema.parse({ type: "rule", name: "r", params: { org: {} } }))).toEqual([]);
  });
});

describe("credentialIn", () => {
  const E1 = "--project=acme-portal-backend-2024";
  const E2 = "acme-portal-team-7/Backend_Services";
  const E3 = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

  it("row T: a token of a known format, in any field, is the error", () => {
    expect(credentialIn([leaf("headers.Authorization", "Bearer " + GHP)])).toEqual({ error: { path: "headers.Authorization", kind: "github-token" }, warnings: [] });
    expect(credentialIn([leaf("env.T", AZDO)]).error).toEqual({ path: "env.T", kind: "azure-devops-pat" });
  });

  it("row U: a URL with credentials, whole or inside the leaf, is the error", () => {
    expect(credentialIn([leaf("args[1]", "--url=https://u:p@idp.example.com/")])).toEqual({ error: { path: "args[1]", kind: "url-credentials" }, warnings: [] });
    expect(credentialIn([leaf("url", "https://u:p@idp.example.com/")]).error).toEqual({ path: "url", kind: "url-credentials" });
  });

  it("a leaf matching rows U and T reports U's kind", () => {
    expect(credentialIn([leaf("url", "https://" + GHP + "@idp.example.com/")]).error).toEqual({ path: "url", kind: "url-credentials" });
  });

  it("of two refused leaves, the first in the server's order is the one reported", () => {
    expect(credentialIn([leaf("env.A", E3), leaf("url", "https://u:p@h/"), leaf("headers.X", GHP)]).error).toEqual({ path: "url", kind: "url-credentials" });
    expect(credentialIn([leaf("headers.X", GHP), leaf("url", "https://u:p@h/")]).error).toEqual({ path: "headers.X", kind: "github-token" });
  });

  it("row E: a high-entropy value warns under env and args, and only there", () => {
    expect(credentialIn([leaf("env.ACME_KEY", E3), leaf("args[0]", E1), leaf("headers.X", E3), leaf("url", E2)])).toEqual({
      error: null,
      warnings: [
        { path: "env.ACME_KEY", kind: "high-entropy-value" },
        { path: "args[0]", kind: "high-entropy-value" },
      ],
    });
    expect(credentialIn([leaf("args[3]", E2)]).warnings).toEqual([{ path: "args[3]", kind: "high-entropy-value" }]);
  });

  it("what passes and should (§4.3), in env, in args and in url alike", () => {
    for (const v of ["https://idp.example.com/mcp", "acme", "--org=acme", "https://dev.azure.com/acme/Portal", "${ACME_TOKEN}", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"]) {
      expect(credentialIn([leaf("env.V", v), leaf("args[0]", v), leaf("url", v)]), v).toEqual({ error: null, warnings: [] });
    }
  });

  it("what passes though it is a secret (§4.3) — pinned, so a change here is a decision", () => {
    const unknown = ["aB3dE5gH", "7jK9mN1p", "Q2rS4tU6", "vW8xY0zZ"].join(""); // no known format; entropy 5.0, well above the rule's 4
    for (const v of ["Bearer " + unknown, "KEY: " + unknown, "Server=db;Password=" + unknown, "https://idp.example.com/mcp?api_key=" + unknown, "ssh://" + unknown + "@host/", "x-https://" + unknown + "@host/", "user:" + unknown + "@host"]) {
      expect(credentialIn([leaf("env.V", v), leaf("args[0]", v), leaf("url", v)]), v).toEqual({ error: null, warnings: [] });
    }
    // …and the same unknown token alone: silent outside env/args, a warning inside.
    expect(credentialIn([leaf("headers.X", unknown)])).toEqual({ error: null, warnings: [] });
    expect(credentialIn([leaf("env.X", unknown)]).warnings).toEqual([{ path: "env.X", kind: "high-entropy-value" }]);
  });

  it("an empty list is nothing", () => {
    expect(credentialIn([])).toEqual({ error: null, warnings: [] });
  });
});

describe("the three messages", () => {
  it("name the ingredient, the field and the kind — exactly the spec's text", () => {
    expect(credentialMessage("mcp/idp", { path: "headers.Authorization", kind: "github-token" })).toBe(
      "mcp/idp: the value rendered into server.headers.Authorization looks like a credential (github-token) — a generated file is committed, so a secret cannot come from a param; have the server read it from the environment",
    );
    expect(credentialMessage("mcp/idp", { path: "args[1]", kind: "url-credentials" })).toBe(
      "mcp/idp: the value rendered into server.args[1] holds a URL with credentials (url-credentials) — a generated file is committed, so a secret cannot come from a param; have the server read it from the environment",
    );
    expect(entropyMessage("mcp/idp", { path: "env.ACME_KEY", kind: "high-entropy-value" })).toBe(
      "mcp/idp: the value rendered into server.env.ACME_KEY may be a secret (high-entropy-value) — a generated file is committed; if it is one, have the server read it from the environment",
    );
    expect(undeclaredMessage("mcp/idp", "org")).toBe("mcp/idp: server cites {{org}}, which has a value but is not declared in the ingredient's params — left verbatim");
  });
});

describe("holdsBaseCitations", () => {
  const base = meta({ url: "{{idp.url}}" }, { "idp.url": {} });
  const variant = (server: unknown, params: Record<string, unknown> | null) => meta(server, params, { name: "idp--acme", as: "idp" });

  it("a params-less variant whose server cites a key the base declares", () => {
    expect(holdsBaseCitations(base, variant({ url: "{{idp.url}}" }, null))).toBe(true);
  });
  it("not for a literal server, a variant with params of its own, a key the base does not declare, a base that declares nothing, or a pair that is not mcp", () => {
    expect(holdsBaseCitations(base, variant({ url: "https://idp.example.com" }, null))).toBe(false);
    expect(holdsBaseCitations(base, variant({ url: "{{idp.url}}" }, {}))).toBe(false);
    expect(holdsBaseCitations(base, variant({ url: "{{other}}" }, null))).toBe(false);
    expect(holdsBaseCitations(meta({ url: "{{idp.url}}" }, {}), variant({ url: "{{idp.url}}" }, null))).toBe(false);
    const r = IngredientSchema.parse({ type: "rule", name: "r", params: { org: {} } });
    expect(holdsBaseCitations(r, IngredientSchema.parse({ type: "rule", name: "r--acme", as: "r" }))).toBe(false);
  });
});

describe("a server that refers back to itself (a YAML alias)", () => {
  const CYCLIC = "mcp/idp: ingredient metadata is cyclic (a YAML alias refers back to itself)";
  const cyclic = (): McpMeta => {
    const server: Record<string, unknown> = { url: "{{org}}" };
    server.again = { deeper: [server] };
    // Built by hand: the schema would walk the cycle. `loadForge` hands such an object over as YAML parsed it.
    return { type: "mcp", name: "idp", targets: "*", tags: [], params: { org: {} }, server } as unknown as McpMeta;
  };

  it("renderServer and serverCitations refuse it, naming the ingredient, instead of overflowing the stack", () => {
    expect(() => renderServer(cyclic(), P({ org: "acme" }))).toThrow(new Error(CYCLIC));
    expect(() => serverCitations(cyclic())).toThrow(new Error(CYCLIC));
  });

  it("(control) the same object reached twice without a cycle is rendered twice", () => {
    const shared = { "X-Org": "{{org}}" };
    const m = meta({ type: "http", headers: shared, more: { headers: shared } });
    const r = renderServer(m, P({ org: "acme" }));
    expect(json(r.server)).toBe(json({ type: "http", headers: { "X-Org": "acme" }, more: { headers: { "X-Org": "acme" } } }));
    expect(r.substituted.map((l) => l.path)).toEqual(["headers.X-Org", "more.headers.X-Org"]);
    expect(serverCitations(m)).toEqual([{ key: "org", declared: true }]);
  });
});

describe("serverSecret — import's scan of a server it read", () => {
  const HIGH = ["a1b2c3d4", "e5f6", "7890", "abcd", "ef1234567890"].join("-"); // a GUID the entropy rule matches (spec §4.3)

  it("the entropy rule is for env and args only; a known token is found in every field", () => {
    expect(serverSecret("idp", { env: { ACME_KEY: HIGH } })).toBe("secret-like value (high-entropy-value) in .mcp.json → mcpServers.idp.env.ACME_KEY");
    expect(serverSecret("idp", { args: ["-y", HIGH] })).toBe("secret-like value (high-entropy-value) in .mcp.json → mcpServers.idp.args[1]");
    expect(serverSecret("idp", { headers: { "X-Id": HIGH }, url: `https://idp.example.com/${HIGH}` })).toBeNull();
    expect(serverSecret("idp", { headers: { Authorization: `Bearer ${GHP}` } })).toBe("secret-like value (github-token) in .mcp.json → mcpServers.idp.headers.Authorization");
  });
});


// Spec 43 §7.2 — lifted functions for reuse by hook registration.

describe("renderLeaves / citationsIn (spec 43)", () => {
  describe("renderLeaves", () => {
    it("substitutes declared and valued keys, reports substituted leaves with path and under, returns nothing missing or undeclared", async () => {
      const { renderLeaves } = await import("../src/core/mcp-server.js");
      const input = { command: "{{py}}", args: ["${CLAUDE_PROJECT_DIR}/x.py", "{{py}} -u"], matcher: "Bash" };
      const declared = { py: {} };
      const params = P({ py: "python3" });
      const result = renderLeaves(input, declared, params, "hook/guard-path");

      expect(result.value).toEqual({ command: "python3", args: ["${CLAUDE_PROJECT_DIR}/x.py", "python3 -u"], matcher: "Bash" });
      expect(result.substituted).toEqual([
        { path: "command", under: "command", value: "python3" },
        { path: "args[1]", under: "args", value: "python3 -u" },
      ]);
      expect(result.missing).toEqual([]);
      expect(result.undeclared).toEqual([]);
    });

    it("a declared key with no value is left and added to missing; value is the same object", async () => {
      const { renderLeaves } = await import("../src/core/mcp-server.js");
      const input = { command: "{{py}}", args: ["${CLAUDE_PROJECT_DIR}/x.py", "{{py}} -u"], matcher: "Bash" };
      const declared = { py: {} };
      const params = P({});
      const result = renderLeaves(input, declared, params, "hook/guard-path");

      expect(result.value).toBe(input);
      expect(result.missing).toEqual(["py"]);
    });

    it("an undeclared key with a value is left and added to undeclared; value is the same object", async () => {
      const { renderLeaves } = await import("../src/core/mcp-server.js");
      const input = { command: "{{py}}", args: ["${CLAUDE_PROJECT_DIR}/x.py", "{{py}} -u"], matcher: "Bash" };
      const declared = {};
      const params = P({ py: "python3" });
      const result = renderLeaves(input, declared, params, "hook/guard-path");

      expect(result.value).toBe(input);
      expect(result.undeclared).toEqual(["py"]);
    });

    it("a cyclic object throws, naming the ref", async () => {
      const { renderLeaves } = await import("../src/core/mcp-server.js");
      const input: Record<string, unknown> = { command: "x" };
      input.self = input;
      const declared = {};
      const params = P({});

      expect(() => renderLeaves(input, declared, params, "hook/guard-path")).toThrow(
        new Error("hook/guard-path: ingredient metadata is cyclic (a YAML alias refers back to itself)"),
      );
    });
  });

  describe("citationsIn", () => {
    it("returns each key once, with declared flag, in order", async () => {
      const { citationsIn } = await import("../src/core/mcp-server.js");
      const input = { command: "{{a}}", args: ["{{b}}", "{{a}}"] };
      const declared = { a: {} };
      const result = citationsIn(input, declared, "hook/guard-path");

      expect(result).toEqual([
        { key: "a", declared: true },
        { key: "b", declared: false },
      ]);
    });
  });

  describe("registrationCitations", () => {
    it("returns each key once, with declared flag, in registration order — two entries citing a and b, a declared", () => {
      const hook: Ingredient = IngredientSchema.parse({
        type: "hook",
        name: "guard",
        files: ["guard.py"],
        params: { a: {} },
        registration: [
          { event: "PreToolUse", command: "{{a}}", args: [] },
          { event: "PostToolUse", command: "{{b}}", args: ["{{a}}"] },
        ],
      });
      expect(registrationCitations(hook)).toEqual([
        { key: "a", declared: true },
        { key: "b", declared: false },
      ]);
    });

    it("returns [] for a script (no registration)", () => {
      const script: Ingredient = IngredientSchema.parse({
        type: "script",
        name: "lint",
        files: ["lint.sh"],
        params: { a: {} },
      });
      expect(registrationCitations(script)).toEqual([]);
    });

    it("returns [] for a hook with no registration", () => {
      const hook: Ingredient = IngredientSchema.parse({
        type: "hook",
        name: "guard",
        files: ["guard.py"],
        params: { a: {} },
      });
      expect(registrationCitations(hook)).toEqual([]);
    });
  });

  describe("message parameters", () => {
    it("credentialMessage with custom prefix and remedy for a known token", () => {
      const result = credentialMessage("hook/guard-path", { path: "args[1]", kind: "github-token" }, { prefix: "registration[0].", remedy: "have the hook read it from the environment" });
      expect(result).toBe(
        "hook/guard-path: the value rendered into registration[0].args[1] looks like a credential (github-token) — a generated file is committed, so a secret cannot come from a param; have the hook read it from the environment",
      );
    });

    it("credentialMessage with custom prefix and remedy for url-credentials", () => {
      const result = credentialMessage("hook/guard-path", { path: "args[1]", kind: "url-credentials" }, { prefix: "registration[0].", remedy: "have the hook read it from the environment" });
      expect(result).toBe(
        "hook/guard-path: the value rendered into registration[0].args[1] holds a URL with credentials (url-credentials) — a generated file is committed, so a secret cannot come from a param; have the hook read it from the environment",
      );
    });

    it("entropyMessage with custom prefix and remedy", () => {
      const result = entropyMessage("hook/guard-path", { path: "args[0]", kind: "high-entropy-value" }, { prefix: "registration[0].", remedy: "have the hook read it from the environment" });
      expect(result).toBe(
        "hook/guard-path: the value rendered into registration[0].args[0] may be a secret (high-entropy-value) — a generated file is committed; if it is one, have the hook read it from the environment",
      );
    });

    it("undeclaredMessage with custom subject", () => {
      const result = undeclaredMessage("hook/guard-path", "x", "registration");
      expect(result).toBe(
        "hook/guard-path: registration cites {{x}}, which has a value but is not declared in the ingredient's params — left verbatim",
      );
    });
  });
});
