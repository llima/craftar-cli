import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, writeFiles, type ForgeSpec } from "./helpers/forge.js";
import { forgeAt, mcp, snapshot, states, sync } from "./helpers/integrations.js";

/**
 * Spec 34 §5.3 — import compares the rendered server, and guards the keys a server cites.
 * The invariant: import, then sync, leaves the workspace's MCP files byte for byte.
 */

const URL = "https://idp.example.com/mcp";
const IDP = (params: Record<string, unknown> = { "integrations.idp.url": {} }, server: Record<string, unknown> = { type: "http", url: "{{integrations.idp.url}}" }) =>
  mcp("idp", server, { params });

/** `shared`: a recipe `shared-defaults` (no ingredient, these param defaults) the profile lists after `base` — import does not own it, so it stays resolved. */
const listed = (
  o: {
    block?: Record<string, unknown>;
    params?: Record<string, unknown>;
    idp?: ReturnType<typeof IDP>;
    shared?: Record<string, unknown>;
    extra?: ForgeSpec["ingredients"];
    refs?: string[];
  } = {},
): ForgeSpec => ({
  ingredients: [rule("workflow", "# Workflow\n"), o.idp ?? IDP(), ...(o.extra ?? [])],
  recipes: [recipe("base", ["rule/workflow", "mcp/idp", ...(o.refs ?? [])]), ...(o.shared ? [recipe("shared-defaults", [], { params: o.shared })] : [])],
  profiles: [profile("acme", o.shared ? ["base", "shared-defaults"] : ["base"], ["claude-code", "kiro"], { integrations: o.block ?? {}, params: o.params ?? {} })],
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A Forge at `schema` and a workspace synced from it. */
async function synced(schema: number, spec: ForgeSpec, ws: { config: { profile: string; recipes?: { remove?: string[] } } } = { config: { profile: "acme" } }) {
  const s = await forgeAt(schema, spec, ws);
  cleanups.push(s.cleanup);
  await sync(s.wsRoot);
  return s;
}

const importBack = (s: { wsRoot: string; forgeRoot: string }, profileName = "acme") =>
  importClaudeCode({ workspaceRoot: s.wsRoot, forgeRoot: s.forgeRoot, profileName });

/** Import, and the Forge files whose bytes moved (added, removed or changed), sorted. */
async function moved(s: { wsRoot: string; forgeRoot: string }, profileName = "acme") {
  const before = await snapshot(s.forgeRoot);
  const r = await importBack(s, profileName);
  const after = await snapshot(s.forgeRoot);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).sort();
  return { r, changed };
}

const refusal = async (s: { wsRoot: string; forgeRoot: string }) => {
  const before = await snapshot(s.forgeRoot);
  const message = await importBack(s).then(
    () => "no error",
    (e: Error) => e.message,
  );
  return { message, untouched: JSON.stringify(await snapshot(s.forgeRoot)) === JSON.stringify(before) };
};

const mcpFile = (wsRoot: string) => fs.readFile(path.join(wsRoot, ".mcp.json"), "utf8");

const setSchema = (forgeRoot: string, schema: number) =>
  fs.writeFile(path.join(forgeRoot, "craftar.forge.yaml"), YAML.stringify({ name: "test-forge", schema }));

const variantMeta = async (forgeRoot: string) =>
  YAML.parse(await fs.readFile(path.join(forgeRoot, "ingredients/mcp/idp--acme/ingredient.yaml"), "utf8"));

/** Import, then sync through the CLI; returns the import report, what moved in the Forge, and the MCP file before and after. */
async function importThenSync(s: { wsRoot: string; forgeRoot: string }) {
  const before = await mcpFile(s.wsRoot);
  const m = await moved(s);
  const cli = runCli(["sync", "--workspace", s.wsRoot]);
  return { ...m, before, after: await mcpFile(s.wsRoot), cli };
}

describe("the rendered server reuses the base", () => {
  it("1. the value in the profile's params (criterion 4)", async () => {
    const s = await synced(4, listed({ params: { "integrations.idp.url": URL } }));
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(r.reused).toEqual(["rule/workflow", "mcp/idp"]);
    expect(r.variants).toEqual([]);
    expect(r.params).toEqual([]);
    expect(r.inferred).toEqual([]);
  });

  it("2. the value from the profile's integrations block", async () => {
    const s = await synced(4, listed({ block: { idp: { url: URL } } }));
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(r.reused).toEqual(["rule/workflow", "mcp/idp"]);
    expect(r.variants).toEqual([]);
    expect(r.params).toEqual([]);
    expect(r.inferred).toEqual([]);
    expect(r.leftToRecipes).toEqual([]);
  });

  it("3. (control) below 4, today's result: a variant", async () => {
    // Sync at schema 3 writes braces; hand-write the file with the URL
    const s = await synced(3, listed({ params: { "integrations.idp.url": URL } }));
    // Hand-write .mcp.json with the URL in place of braces (what sync at 4 would write)
    await writeFiles(s.wsRoot, {
      ".mcp.json": JSON.stringify({ mcpServers: { idp: { type: "http", url: URL } } }, null, 2) + "\n",
    });
    const { r } = await moved(s);
    expect(r.variants.map((v) => v.name)).toEqual(["mcp/idp--acme"]);
  });

  it("4. a differing server is a variant with a literal server, and nothing is inferred", async () => {
    const s = await synced(4, listed({ params: { "integrations.idp.url": URL } }));
    // Rewrite .mcp.json with a different URL
    await writeFiles(s.wsRoot, {
      ".mcp.json": JSON.stringify({ mcpServers: { idp: { type: "http", url: "https://other.example.com/mcp" } } }, null, 2) + "\n",
    });
    const { r } = await moved(s);
    expect(r.variants.map((v) => v.name)).toEqual(["mcp/idp--acme"]);
    expect(r.params).toEqual([]);
    expect(r.inferred).toEqual([]);
    const m = await variantMeta(s.forgeRoot);
    expect(m.server).toEqual({ type: "http", url: "https://other.example.com/mcp" });
    expect(m.as).toBe("idp");
    expect(Object.hasOwn(m, "params")).toBe(false);
    // Print once, then pin the profileWrite
    expect(r.profileWrite).toEqual({ path: "profiles/acme/profile.yaml", action: "edited", fields: ["recipes"] });
  });
});

describe("§6.18 — a workspace whose .mcp.json holds a literal {{k}}", () => {
  it("5. k has a value in import's map: a variant with the braces", async () => {
    // Sync at schema 3 (writes braces), then bump to 4, then import+sync
    const s = await synced(3, listed({ params: { "integrations.idp.url": URL } }));
    await setSchema(s.forgeRoot, 4);
    const { r, before, after, cli } = await importThenSync(s);
    expect(after).toBe(before);
    expect(r.variants.map((v) => v.name)).toEqual(["mcp/idp--acme"]);
    const m = await variantMeta(s.forgeRoot);
    expect(m.server).toEqual({ type: "http", url: "{{integrations.idp.url}}" });
    expect(Object.hasOwn(m, "params")).toBe(false);
    expect(cli.code).toBe(0);
    expect(cli.stdout.split("\n")).toContain(
      "  warn mcp/idp--acme: server cites {{integrations.idp.url}}, which has a value but is not declared in the ingredient's params — left verbatim",
    );
  });

  it("6. the value is only the base's own default: a variant, and no warning", async () => {
    const s = await synced(3, listed({ idp: IDP({ "integrations.idp.url": { default: URL } }) }));
    await setSchema(s.forgeRoot, 4);
    const { r, before, after, cli } = await importThenSync(s);
    expect(after).toBe(before);
    expect(r.variants.map((v) => v.name)).toEqual(["mcp/idp--acme"]);
    const m = await variantMeta(s.forgeRoot);
    expect(m.server).toEqual({ type: "http", url: "{{integrations.idp.url}}" });
    expect(cli.code).toBe(0);
    // No line starts with "  warn"
    expect(cli.stdout.split("\n").some((l) => l.startsWith("  warn"))).toBe(false);
  });

  it("7. k has no value anywhere: the base is reused, and the sync reports it as missing", async () => {
    // No value at all — the ingredient declares integrations.idp.url but nobody sets it
    const s = await synced(3, listed());
    await setSchema(s.forgeRoot, 4);
    const { r, changed, before, after, cli } = await importThenSync(s);
    expect(changed).toEqual([]);
    expect(r.reused).toContain("mcp/idp");
    // Sync exits 1 (spec 29 slice A refuses)
    expect(cli.code).toBe(1);
    expect(cli.stderr).toContain("integrations.idp.url  declared by mcp/idp · cited by mcp/idp");
    // after == before because nothing was written
    expect(after).toBe(before);
  });

  it("8. k is in neither params layer and a recipe gives it a default: G1 fires — a variant", async () => {
    const s = await synced(3, listed({ shared: { "integrations.idp.url": { default: URL } } }));
    await setSchema(s.forgeRoot, 4);
    const { r, before, after, cli } = await importThenSync(s);
    expect(after).toBe(before);
    expect(r.variants).toEqual([
      {
        name: "mcp/idp--acme",
        reason: "differs from mcp/idp already in the Forge (recipe shared-defaults defaults integrations.idp.url, which the server cites)",
      },
    ]);
    const m = await variantMeta(s.forgeRoot);
    expect(m.server).toEqual({ type: "http", url: "{{integrations.idp.url}}" });
    expect(cli.code).toBe(0);
    // The warning appears because the workspace still resolves shared-defaults, so the key has a value
    expect(cli.stdout.split("\n")).toContain(
      "  warn mcp/idp--acme: server cites {{integrations.idp.url}}, which has a value but is not declared in the ingredient's params — left verbatim",
    );
  });

  it("9. a second import of such a workspace moves no byte", async () => {
    const s = await synced(3, listed({ params: { "integrations.idp.url": URL } }));
    await setSchema(s.forgeRoot, 4);
    // First import
    await importThenSync(s);
    // Second import
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(r.variants.map((v) => v.name)).toEqual(["mcp/idp--acme"]);
  });
});

describe("§6.19 — a recipe default shadowing the ingredient's", () => {
  it("10. import's map and sync's map disagree; G1 keeps the bytes", async () => {
    // Base declares idp.url with default A, recipe gives default B
    const spec = listed({ idp: IDP({ k: { default: "https://a.example.com/mcp" } }, { type: "http", url: "{{k}}" }) });
    const s = await synced(4, spec);
    // .mcp.json holds https://a.example.com/mcp (the ingredient's default)

    // Give the recipe a default that differs
    const recipeYaml = path.join(s.forgeRoot, "recipes/base.yaml");
    await fs.writeFile(
      recipeYaml,
      YAML.stringify(recipe("base", ["rule/workflow", "mcp/idp"], { params: { k: { default: "https://b.example.com/mcp" } } })),
    );

    const { r, before, after, cli } = await importThenSync(s);
    expect(after).toBe(before);
    expect(r.variants.map((v) => v.name)).toEqual(["mcp/idp--acme"]);
    expect(r.variants[0].reason).toBe("differs from mcp/idp already in the Forge (recipe base defaults k, which the server cites)");
    const m = await variantMeta(s.forgeRoot);
    expect(m.server.url).toBe("https://a.example.com/mcp");
    expect(cli.code).toBe(0);
  });
});

describe("§6.20 — a profile param that already holds a credential URL", () => {
  it("11. the base is reused, then sync exits 1 on row U with the file untouched", async () => {
    const s = await forgeAt(4, listed({ params: { "integrations.idp.url": "https://u:p@idp.example.com/" } }));
    cleanups.push(s.cleanup);
    // No sync — hand-write the workspace files
    await writeFiles(s.wsRoot, {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": JSON.stringify({ mcpServers: { idp: { type: "http", url: "https://u:p@idp.example.com/" } } }, null, 2) + "\n",
    });

    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(r.reused).toContain("mcp/idp");
    expect(r.rejected).toEqual([]);

    const cli = runCli(["sync", "--workspace", s.wsRoot]);
    expect(cli.code).toBe(1);
    expect(cli.stderr).toBe(
      "error: mcp/idp: the value rendered into server.url holds a URL with credentials (url-credentials) — a generated file is committed, so a secret cannot come from a param; have the server read it from the environment\n",
    );

    // File is untouched
    const mcp = await mcpFile(s.wsRoot);
    expect(mcp).toBe(JSON.stringify({ mcpServers: { idp: { type: "http", url: "https://u:p@idp.example.com/" } } }, null, 2) + "\n");

    // The credential is not printed
    expect(cli.stdout).not.toContain("u:p");
    expect(cli.stderr).not.toContain("u:p");
  });
});

describe("the citation scans", () => {
  it("12. F9 refuses to set a param a server cites as a declared key — and does not for an undeclared one", async () => {
    // Forge with rule citing {{idp.host}} and MCP with server citing {{idp.host}} as declared
    const spec: ForgeSpec = {
      ingredients: [
        rule("deploy", "use {{idp.host}} here\n", { params: { "idp.host": { default: "globex-api" } } }),
        mcp("idp", { type: "http", url: "https://{{idp.host}}/mcp" }, { params: { "idp.host": {} } }),
      ],
      recipes: [recipe("base", ["rule/deploy", "mcp/idp"])],
      profiles: [profile("acme", ["base"], ["claude-code", "kiro"])],
    };
    const s = await forgeAt(4, spec);
    cleanups.push(s.cleanup);

    // A new workspace b with a different value for idp.host in the rule
    await writeFiles(s.wsRoot, {
      ".claude/rules/deploy.md": "use initech-api here\n",
    });

    const r = await importClaudeCode({ workspaceRoot: s.wsRoot, forgeRoot: s.forgeRoot, profileName: "b" });
    expect(r.inferred).toEqual([]);
    expect(r.variants).toEqual([{ name: "rule/deploy--b", reason: "differs from rule/deploy already in the Forge (setting idp.host would change mcp/idp)" }]);

    // Same test with the MCP ingredient declaring nothing
    const specUndeclared: ForgeSpec = {
      ingredients: [
        rule("deploy", "use {{idp.host}} here\n", { params: { "idp.host": { default: "globex-api" } } }),
        mcp("idp", { type: "http", url: "https://{{idp.host}}/mcp" }), // No params
      ],
      recipes: [recipe("base", ["rule/deploy", "mcp/idp"])],
      profiles: [profile("acme", ["base"], ["claude-code", "kiro"])],
    };
    const s2 = await forgeAt(4, specUndeclared);
    cleanups.push(s2.cleanup);
    await writeFiles(s2.wsRoot, { ".claude/rules/deploy.md": "use initech-api here\n" });
    const r2 = await importClaudeCode({ workspaceRoot: s2.wsRoot, forgeRoot: s2.forgeRoot, profileName: "b" });
    expect(r2.inferred).toEqual([{ name: "rule/deploy", values: { "idp.host": "initech-api" } }]);

    // Control: schema 3 — infers like the undeclared case
    const s3 = await forgeAt(3, spec);
    cleanups.push(s3.cleanup);
    await writeFiles(s3.wsRoot, { ".claude/rules/deploy.md": "use initech-api here\n" });
    const r3 = await importClaudeCode({ workspaceRoot: s3.wsRoot, forgeRoot: s3.forgeRoot, profileName: "b" });
    expect(r3.inferred).toEqual([{ name: "rule/deploy", values: { "idp.host": "initech-api" } }]);
  });

  it("13. a key a reused server relied on is pinned", async () => {
    // Forge with MCP declaring idp.host and steering citing idp.host, plus a rule for import to find
    const spec: ForgeSpec = {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        mcp("idp", { type: "http", url: "https://{{idp.host}}/mcp" }, { params: { "idp.host": {} } }),
        {
          meta: { type: "steering", name: "product", tags: ["client"], params: { "idp.host": {} } },
          files: { "steering.md": "host {{idp.host}}\n" },
        },
      ],
      recipes: [recipe("base", ["rule/workflow", "mcp/idp", "steering/product"])],
      profiles: [profile("acme", ["base"], ["claude-code", "kiro"], { params: { "idp.host": "a.example.com" } })],
    };
    const s = await synced(4, spec);

    // Check what sync wrote for the steering file
    const steeringPath = path.join(s.wsRoot, ".kiro/steering/product.md");
    const steeringContent = await fs.readFile(steeringPath, "utf8");
    // The file should have frontmatter, possibly a GENERATED banner, and the body

    // Rewrite the steering file to have a different host value (keep frontmatter)
    // The body should become "host b.example.com"
    const lines = steeringContent.split(/\r?\n/);
    // Find where the body starts (after frontmatter and banner)
    let bodyStart = 0;
    if (lines[0] === "---") {
      bodyStart = lines.indexOf("---", 1) + 1;
      // Skip GENERATED banner line if present
      while (bodyStart < lines.length && (lines[bodyStart].startsWith("<!---") || lines[bodyStart] === "")) bodyStart++;
    }
    // Replace body line
    const newLines = [...lines.slice(0, bodyStart), "host b.example.com", ""];
    await fs.writeFile(steeringPath, newLines.join("\r\n"));

    const { r } = await moved(s);
    // The profile's idp.host is NOT changed (pinned)
    expect(r.params).toEqual([]);
    expect(r.variants.map((v) => v.name)).toEqual(["steering/product--acme"]);
    // Print once, then pin the reason
    expect(r.variants[0].reason).toBe('differs from steering/product already in the Forge (idp.host is "a.example.com" in this import; steering/product implies "b.example.com")');

    // Control: schema 3 — the param DOES move
    const s3 = await synced(3, spec);
    const steering3 = await fs.readFile(path.join(s3.wsRoot, ".kiro/steering/product.md"), "utf8");
    const lines3 = steering3.split(/\r?\n/);
    let bodyStart3 = 0;
    if (lines3[0] === "---") {
      bodyStart3 = lines3.indexOf("---", 1) + 1;
      while (bodyStart3 < lines3.length && (lines3[bodyStart3].startsWith("<!---") || lines3[bodyStart3] === "")) bodyStart3++;
    }
    const newLines3 = [...lines3.slice(0, bodyStart3), "host b.example.com", ""];
    await fs.writeFile(path.join(s3.wsRoot, ".kiro/steering/product.md"), newLines3.join("\r\n"));
    const { r: r3 } = await moved(s3);
    expect(r3.params).toEqual([{ key: "idp.host", old: "a.example.com", value: "b.example.com", from: "steering/product" }]);
  });

  it("14. no integrations. key is inferred at schema 4", async () => {
    // This is spec 33e case 8 with forgeAt(4, ...)
    const spec: ForgeSpec = {
      ingredients: [
        rule("deploy", "use {{integrations.pm.org}} here\n", { params: { "integrations.pm.org": { default: "globex" } } }),
        rule("workflow", "# Workflow\n"),
      ],
      recipes: [recipe("base", ["rule/workflow", "rule/deploy"])],
      profiles: [profile("acme", ["base"], ["claude-code", "kiro"])],
    };
    const s = await forgeAt(4, spec);
    cleanups.push(s.cleanup);
    await writeFiles(s.wsRoot, { ".claude/rules/deploy.md": "use initech here\n" });
    const r = await importClaudeCode({ workspaceRoot: s.wsRoot, forgeRoot: s.forgeRoot, profileName: "b" });
    expect(r.inferred).toEqual([]);
    expect(r.variants.map((v) => v.name)).toEqual(["rule/deploy--b"]);
  });

  it("15. what the block provides is still skipped at 4, the server included", async () => {
    // Recipes: base (rule/workflow), idp-generic (mcp/idp)
    // Block selects idp-generic
    const spec: ForgeSpec = {
      ingredients: [rule("workflow", "# Workflow\n"), IDP()],
      recipes: [recipe("base", ["rule/workflow"]), recipe("idp-generic", ["mcp/idp"], { slot: "idp" })],
      profiles: [profile("acme", ["base"], ["claude-code", "kiro"], { integrations: { idp: { kind: "generic", url: URL } } })],
    };
    const s = await synced(4, spec);
    const { r, changed } = await moved(s);
    expect(changed).toEqual([]);
    expect(r.leftToRecipes).toEqual([{ recipe: "idp-generic", slot: "idp", refs: ["mcp/idp"] }]);

    // Edit the URL in .mcp.json
    await writeFiles(s.wsRoot, {
      ".mcp.json": JSON.stringify({ mcpServers: { idp: { type: "http", url: "https://other.example.com/mcp" } } }, null, 2) + "\n",
    });
    const { r: r2, changed: changed2 } = await moved(s);
    expect(changed2).toEqual([]);
    const st = await states(s.wsRoot);
    expect(st[".mcp.json"]).toBe("drift");
  });
});

describe("only declared citations count (spec 34 §5.2)", () => {
  it("16. a key the server cites WITHOUT declaring it, which a recipe defaults: G1 does not fire — the base is reused", async () => {
    // An undeclared placeholder is never substituted, so no recipe default can move the server's bytes.
    const server = { type: "http", url: URL, headers: { "X-Org": "{{org}}" } };
    const s = await synced(4, listed({ idp: IDP({}, server), shared: { org: { default: "acme" } } }));
    const { r, changed, before, after, cli } = await importThenSync(s);
    expect(changed).toEqual([]);
    expect(r.variants).toEqual([]);
    expect(r.reused).toEqual(["rule/workflow", "mcp/idp"]);
    expect(after).toBe(before);
    expect(JSON.parse(after).mcpServers.idp).toEqual(server);
    expect(cli.code).toBe(0);
    expect(cli.stdout.split("\n")).toContain("  warn mcp/idp: server cites {{org}}, which has a value but is not declared in the ingredient's params — left verbatim");
  });
});
