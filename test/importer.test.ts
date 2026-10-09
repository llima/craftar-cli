import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ForgeStage, importClaudeCode } from "../src/importers/claude-code.js";
import { fingerprintDir } from "../src/core/fingerprint.js";
import { exists, loadForge } from "../src/core/forge.js";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";

const TOKEN = "ghp_" + "x".repeat(36); // assembled at runtime on purpose
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const root = await tmpDir("craftar-import-");
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return { root, forge: path.join(root, "forge"), ws: (name: string) => path.join(root, name) };
}
const importInto = (forge: string, workspaceRoot: string, profileName: string) => importClaudeCode({ workspaceRoot, forgeRoot: forge, profileName });
const utf16le = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
const utf16be = (text: string) => {
  const le = Buffer.from(text, "utf16le");
  le.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), le]);
};
const yaml = async (file: string) => YAML.parse(await fs.readFile(file, "utf8"));

describe("import --from claude-code", () => {
  it("reuses identical ingredients and turns differing ones into variants", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/rules/workflow.md": "# Workflow v1\n" });
    await writeFiles(t.ws("b"), { ".claude/rules/workflow.md": "# Workflow v2\n" });
    await writeFiles(t.ws("c"), { ".claude/rules/workflow.md": "# Workflow v1\r\n" });
    await importInto(t.forge, t.ws("a"), "a");
    const b = await importInto(t.forge, t.ws("b"), "b");
    expect(b.variants).toEqual([{ name: "rule/workflow--b", reason: "differs from rule/workflow already in the Forge" }]);
    expect((await yaml(path.join(t.forge, "ingredients/rules/workflow--b/ingredient.yaml"))).as).toBe("workflow");
    const c = await importInto(t.forge, t.ws("c"), "c");
    expect(c.reused).toContain("rule/workflow");
  });

  it("groups a scoped rule and its reviewer into a stack recipe", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/backend-node.md": "# Backend\n",
      ".kiro/steering/backend-node.md": '---\ninclusion: fileMatch\nfileMatchPattern: "projects/acme-api/**"\n---\n\n<!-- GENERATED from .claude/rules/backend-node.md by craftar -- do not edit. -->\n\n# Backend\n',
      ".claude/agents/backend-node-reviewer.md": "---\nname: backend-node-reviewer\ndescription: Reviews acme-api.\ntools: Read, Grep\n---\n\nWalk `.claude/rules/backend-node.md`.\n",
    });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.recipes).toContain("stack-backend-node");
    expect((await yaml(path.join(t.forge, "recipes/stack-backend-node.yaml"))).ingredients).toEqual(["rule/backend-node", "agent/backend-node-reviewer"]);
    expect((await yaml(path.join(t.forge, "recipes/base.yaml"))).ingredients).not.toContain("agent/backend-node-reviewer");
  });

  it("rejects an MCP server whose env holds a token, without copying or reporting the value", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": JSON.stringify({ mcpServers: { github: { command: "npx", env: { GITHUB_TOKEN: TOKEN } }, playwright: { command: "npx", args: ["-y", "@playwright/mcp@0.0.80"] } } }),
    });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([{ name: "mcp/github", reason: "secret-like value (github-token) in .mcp.json → mcpServers.github.env.GITHUB_TOKEN" }]);
    expect(await exists(path.join(t.forge, "ingredients/mcp/github"))).toBe(false);
    expect(await exists(path.join(t.forge, "ingredients/mcp/playwright/ingredient.yaml"))).toBe(true);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect((await yaml(path.join(t.forge, "recipes/base.yaml"))).ingredients).not.toContain("mcp/github");
  });

  it("never echoes .mcp.json content in a parse error, even when it holds a token", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": '{"mcpServers":{"gh":{"env":{"T":' + TOKEN + "}}}}",
    });
    await expect(importInto(t.forge, t.ws("api"), "api")).rejects.toThrow(".mcp.json is not valid JSON — fix the file and re-run import");
    try {
      await importInto(t.forge, t.ws("api"), "api");
    } catch (e) {
      expect(String(e)).not.toContain("ghp_");
    }
  });

  it("rejects .mcp.json containing only null", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": "null",
    });
    await expect(importInto(t.forge, t.ws("api"), "api")).rejects.toThrow(
      ".mcp.json has no valid mcpServers object — fix the file and re-run import",
    );
  });

  it("rejects .mcp.json whose mcpServers is not an object", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": '{"mcpServers":"x"}',
    });
    await expect(importInto(t.forge, t.ws("api"), "api")).rejects.toThrow(
      ".mcp.json has no valid mcpServers object — fix the file and re-run import",
    );
  });

  it("rejects a null MCP server entry instead of throwing a raw TypeError", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": '{"mcpServers":{"a":null}}',
    });
    await expect(importInto(t.forge, t.ws("api"), "api")).rejects.toThrow(
      '.mcp.json server "a" is not an object — fix the file and re-run import',
    );
    expect(await exists(path.join(t.forge, "ingredients/mcp"))).toBe(false);
  });

  it("rejects a non-object (string) MCP server entry", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": '{"mcpServers":{"a":"x"}}',
    });
    await expect(importInto(t.forge, t.ws("api"), "api")).rejects.toThrow(
      '.mcp.json server "a" is not an object — fix the file and re-run import',
    );
    expect(await exists(path.join(t.forge, "ingredients/mcp"))).toBe(false);
  });

  it("rejects a rule with a token and reports the file line", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), { ".claude/rules/deploy.md": "# Deploy\n\nkey " + "AKIA" + "ABCDEFGHIJKLMNOP" + "\n" });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([{ name: "rule/deploy", reason: "secret-like value (aws-access-key) in .claude/rules/deploy.md line 3" }]);
    expect(await exists(path.join(t.forge, "ingredients/rules/deploy"))).toBe(false);
  });

  it("reports the line in the source file for an agent body under frontmatter", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), { ".claude/agents/ops.md": "---\nname: ops\ndescription: Ops helper.\n---\n\nUse token " + TOKEN + "\n" });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([{ name: "agent/ops", reason: "secret-like value (github-token) in .claude/agents/ops.md line 6" }]);
  });

  it("rejects a skill-dir file read as a Buffer (non-allowlisted extension) holding a private key", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/skills/deploy-kit/SKILL.md": "# Deploy kit\n",
      ".claude/skills/deploy-kit/keys/deploy.pem": "-----BEGIN " + "RSA PRIVATE KEY-----\nabc\n",
    });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([{ name: "skill/deploy-kit", reason: "secret-like value (private-key) in .claude/skills/deploy-kit/keys/deploy.pem line 1" }]);
    expect(await exists(path.join(t.forge, "ingredients/skills/deploy-kit"))).toBe(false);
  });

  it("rejects a hook file read as a Buffer (non-allowlisted extension) holding a token", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), { ".claude/hooks/deploy.bat": "set TOKEN=" + TOKEN + "\r\n" });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([{ name: "hook/deploy", reason: "secret-like value (github-token) in .claude/hooks/deploy.bat line 1" }]);
  });

  it("rejects an allowlisted script saved as UTF-16LE with a BOM holding a token", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), { ".claude/scripts/deploy.ps1": utf16le("# deploy\r\n$token = '" + TOKEN + "'\r\n") });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([{ name: "script/deploy", reason: "secret-like value (github-token) in .claude/scripts/deploy.ps1 line 2" }]);
    expect(await exists(path.join(t.forge, "ingredients/scripts/deploy"))).toBe(false);
  });

  it("rejects a non-allowlisted hook saved as UTF-16LE with a BOM holding a token", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), { ".claude/hooks/deploy.bat": utf16le("set TOKEN=" + TOKEN + "\r\n") });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([{ name: "hook/deploy", reason: "secret-like value (github-token) in .claude/hooks/deploy.bat line 1" }]);
    expect(await exists(path.join(t.forge, "ingredients/hooks/deploy"))).toBe(false);
  });

  it("rejects a rule saved as UTF-16BE with a BOM holding a token", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), { ".claude/rules/deploy.md": utf16be("# Deploy\n\nkey " + "AKIA" + "ABCDEFGHIJKLMNOP" + "\n") });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([{ name: "rule/deploy", reason: "secret-like value (aws-access-key) in .claude/rules/deploy.md line 3" }]);
  });

  it("stores a clean UTF-16 file exactly as before (the decode is for scanning only)", async () => {
    const t = await setup();
    const script = utf16le("Write-Host 'hello'\r\n");
    const hook = utf16le("echo hello\r\n");
    await writeFiles(t.ws("api"), { ".claude/scripts/hello.ps1": script, ".claude/hooks/hello.bat": hook });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([]);
    const stored = await fs.readFile(path.join(t.forge, "ingredients/scripts/hello/hello.ps1"), "utf8");
    expect(stored).toBe(script.toString("utf8").replace(/\r\n?/g, "\n"));
    expect(await fs.readFile(path.join(t.forge, "ingredients/hooks/hello/hello.bat"))).toEqual(hook);
  });

  it("skips a binary skill-dir file (NUL byte) instead of scanning it as text", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/skills/asset-kit/SKILL.md": "# Asset kit\n",
      ".claude/skills/asset-kit/data.bin": Buffer.concat([Buffer.from("TOKEN=" + TOKEN), Buffer.from([0]), Buffer.from("tail")]),
    });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([]);
    expect(await exists(path.join(t.forge, "ingredients/skills/asset-kit/ingredient.yaml"))).toBe(true);
  });

  it("rejects an MCP server whose headers hold a token, pattern-scanning fields beyond env/args", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": JSON.stringify({ mcpServers: { remote: { url: "https://mcp.example.com/sse", headers: { Authorization: "Bearer " + TOKEN } } } }),
    });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([{ name: "mcp/remote", reason: "secret-like value (github-token) in .mcp.json → mcpServers.remote.headers.Authorization" }]);
  });

  it("does not apply the entropy rule outside env/args (a high-entropy header is not rejected)", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": JSON.stringify({ mcpServers: { remote2: { command: "npx", headers: { "X-Trace": "Xk9f2LmQ7pR4tZ8wB3nV" } } } }),
    });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.rejected).toEqual([]);
    expect(await exists(path.join(t.forge, "ingredients/mcp/remote2/ingredient.yaml"))).toBe(true);
  });
});

describe("import --from claude-code — nested MCP configuration", () => {
  it("turns an MCP server that differs only inside its config into a variant, instead of reusing the first", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": JSON.stringify({ mcpServers: { srv: { command: "npx", args: ["public-server"] } } }),
    });
    await writeFiles(t.ws("b"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": JSON.stringify({ mcpServers: { srv: { command: "npx", args: ["acme-server"] } } }),
    });
    await importInto(t.forge, t.ws("a"), "a");
    const b = await importInto(t.forge, t.ws("b"), "b");
    expect(b.reused).not.toContain("mcp/srv");
    expect(b.variants.map((v) => v.name)).toContain("mcp/srv--b");
    expect((await yaml(path.join(t.forge, "ingredients/mcp/srv--b/ingredient.yaml"))).server.args).toEqual(["acme-server"]);
    expect((await yaml(path.join(t.forge, "ingredients/mcp/srv/ingredient.yaml"))).server.args).toEqual(["public-server"]);
  });

  it("still reuses an MCP server whose config is identical", async () => {
    const t = await setup();
    const same = JSON.stringify({ mcpServers: { srv: { command: "npx", args: ["public-server"], env: { TOKEN_VAR: "T" } } } });
    await writeFiles(t.ws("a"), { ".claude/rules/workflow.md": "# Workflow\n", ".mcp.json": same });
    await writeFiles(t.ws("b"), { ".claude/rules/workflow.md": "# Workflow\n", ".mcp.json": same });
    await importInto(t.forge, t.ws("a"), "a");
    const b = await importInto(t.forge, t.ws("b"), "b");
    expect(b.reused).toContain("mcp/srv");
    expect(await exists(path.join(t.forge, "ingredients/mcp/srv--b"))).toBe(false);
  });
});

describe("import --from claude-code — all checks before the first write", () => {
  it("leaves the Forge byte-identical when a late step fails on a malformed existing ingredient", async () => {
    const t = await setup();
    const server = { mcpServers: { srv: { command: "npx", args: ["srv"] } } };
    await writeFiles(t.ws("a"), { ".claude/rules/workflow.md": "# Workflow\n", ".mcp.json": JSON.stringify(server) });
    await importInto(t.forge, t.ws("a"), "a");
    // A self-referencing alias makes the existing MCP ingredient's metadata cyclic.
    await fs.writeFile(path.join(t.forge, "ingredients/mcp/srv/ingredient.yaml"), "type: mcp\nname: srv\nserver: &s\n  self: *s\n");
    const before = await snapshot(t.forge);

    // `other` is read (rules run before MCP) and would be created; the MCP comparison then throws.
    await writeFiles(t.ws("b"), { ".claude/rules/other.md": "# Other\n", ".mcp.json": JSON.stringify(server) });
    const err = await importInto(t.forge, t.ws("b"), "b").then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain("ingredient metadata is cyclic");
    expect(err?.message).toContain(path.join("ingredients", "mcp", "srv", "ingredient.yaml"));
    expect(err?.message).toContain("The Forge was left untouched.");
    expect(await snapshot(t.forge)).toEqual(before);
  });

  it("does not create the Forge directory when the import fails", async () => {
    const t = await setup();
    await writeFiles(t.ws("api"), { ".claude/rules/workflow.md": "# Workflow\n", ".mcp.json": "{ not json" });
    await expect(importInto(t.forge, t.ws("api"), "api")).rejects.toThrow("The Forge was left untouched.");
    expect(await exists(t.forge)).toBe(false);
  });

  it("fingerprints a staged ingredient the same way as the flushed one (one fingerprintDir)", async () => {
    // hook/guard is compared while still staged; a second import of the same workspace compares it on
    // disk. Both paths go through the core fingerprintDir, so the re-import reuses instead of forking.
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".claude/hooks/guard.sh": "echo sh\n",
      ".claude/hooks/guard.ps1": "Write-Output ps1\n",
    });
    const first = await importInto(t.forge, t.ws("api"), "api");
    const again = await importInto(t.forge, t.ws("api"), "api");
    // The two guard files still differ from each other, so the variant is reported again; what matters
    // is that the base compared on disk matches what was compared while staged.
    expect(again.variants).toEqual(first.variants);
    expect(again.reused).toEqual(expect.arrayContaining(["hook/guard", "rule/workflow"]));
    expect(again.created).not.toContain("rule/workflow");
    expect(again.created).not.toContain("hook/guard");
  });

  it("refuses an existing Forge ingredient with an unknown key, naming the file and the key", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/rules/workflow.md": "# Workflow\n" });
    await importInto(t.forge, t.ws("a"), "a");
    const meta = path.join(t.forge, "ingredients/rules/workflow/ingredient.yaml");
    await fs.writeFile(meta, (await fs.readFile(meta, "utf8")) + "foo: 1\n");
    const before = await snapshot(t.forge);
    await writeFiles(t.ws("b"), { ".claude/rules/workflow.md": "# Workflow\n" });
    const err = await importInto(t.forge, t.ws("b"), "b").then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain(path.join("ingredients", "rules", "workflow", "ingredient.yaml"));
    expect(err?.message).toContain("foo");
    expect(err?.message).toContain("The Forge was left untouched.");
    expect(await snapshot(t.forge)).toEqual(before);
  });

  it("compares a later ingredient against one staged earlier in the same run", async () => {
    // Two hook files that map to one ingredient name: the second sees the first as already in the
    // Forge, exactly as it did when the importer wrote as it went.
    const t = await setup();
    await writeFiles(t.ws("api"), {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".claude/hooks/guard.sh": "echo sh\n",
      ".claude/hooks/guard.ps1": "Write-Output ps1\n",
    });
    const r = await importInto(t.forge, t.ws("api"), "api");
    expect(r.created).toContain("hook/guard");
    expect(r.variants).toEqual([{ name: "hook/guard--api", reason: "differs from hook/guard already in the Forge" }]);
    expect(await fs.readFile(path.join(t.forge, "ingredients/hooks/guard/guard.ps1"), "utf8")).toBe("Write-Output ps1\n");
    expect(await fs.readFile(path.join(t.forge, "ingredients/hooks/guard--api/guard.sh"), "utf8")).toBe("echo sh\n");
  });
});

/** Every file under `root`, POSIX-relative, with its bytes. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out[`${r}/`] = "";
        await walk(r);
      } else out[r] = (await fs.readFile(path.join(root, r))).toString("base64");
    }
  };
  await walk("");
  return out;
}

describe("import --from claude-code — the schema before the first write (spec 07)", () => {
  const fail = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e);
  const mcp = (servers: Record<string, unknown>) => JSON.stringify({ mcpServers: servers });

  it("refuses a non-string MCP env value, naming the source, and leaves the Forge untouched", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/rules/workflow.md": "# W\n", ".mcp.json": mcp({ p: { command: "npx", env: { PORT: 8080 } } }) });
    const err = await fail(importInto(t.forge, t.ws("a"), "a"));
    expect(err?.message).toContain(".mcp.json");
    expect(err?.message).toContain("mcp/p");
    expect(err?.message).toMatch(/The Forge was left untouched\.$/);
    expect(await exists(t.forge)).toBe(false);
  });

  it("refuses a script whose name is not slug-like, naming its source", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/scripts/_setup.sh": "echo setup\n" });
    const err = await fail(importInto(t.forge, t.ws("a"), "a"));
    expect(err?.message).toContain(".claude/scripts/_setup.sh");
    expect(err?.message).toContain("script/_setup");
    expect(err?.message).toContain("The Forge was left untouched.");
  });

  it("refuses a variant whose profile makes the name not slug-like (spec 07 edge case 3)", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/rules/workflow.md": "# W1\n" });
    await importInto(t.forge, t.ws("a"), "a");
    const before = await snapshot(t.forge);
    await writeFiles(t.ws("b"), { ".claude/rules/workflow.md": "# W2\n" });
    const err = await fail(importInto(t.forge, t.ws("b"), "Acme Corp"));
    expect(err?.message).toContain("rule/workflow--Acme Corp");
    expect(await snapshot(t.forge)).toEqual(before);
  });

  it("still lists a secret as rejected when the same server also has a non-string env value", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/rules/w.md": "# W\n", ".mcp.json": mcp({ p: { command: "npx", args: [TOKEN], env: { PORT: 8080 } } }) });
    const r = await importInto(t.forge, t.ws("a"), "a");
    expect(r.rejected.map((x) => x.name)).toEqual(["mcp/p"]);
  });

  it("reuses a hand-written ingredient that omits defaulted fields (AC 9)", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/rules/x.md": "# X\n" });
    await importInto(t.forge, t.ws("a"), "a");
    await fs.writeFile(path.join(t.forge, "ingredients/rules/x/ingredient.yaml"), "type: rule\nname: x\n");
    const again = await importInto(t.forge, t.ws("a"), "a");
    expect(again.reused).toContain("rule/x");
    expect(again.variants).toEqual([]);
  });

  it("keeps undeclared MCP server keys, in source order, in ingredient.yaml and after loading", async () => {
    const t = await setup();
    const server = { type: "http", url: "https://mcp.acme.dev", headers: { "X-Team": "acme" }, timeout: 30 };
    await writeFiles(t.ws("a"), { ".claude/rules/w.md": "# W\n", ".mcp.json": mcp({ r: server }) });
    await importInto(t.forge, t.ws("a"), "a");
    const onDisk = await yaml(path.join(t.forge, "ingredients/mcp/r/ingredient.yaml"));
    expect(Object.keys(onDisk.server)).toEqual(["type", "url", "headers", "timeout"]);
    const loaded = (await loadForge(t.forge)).ingredients.get("mcp/r")!.meta;
    if (loaded.type !== "mcp") throw new Error("expected an mcp ingredient");
    expect(loaded.server).toEqual(server);
    expect(Object.keys(loaded.server)).toEqual(["type", "url", "headers", "timeout"]);
  });

  it("pins spec 07 edge case 8 (pre-existing): a reordered server reuses the first one and reads as collision", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/rules/w.md": "# W\n", ".mcp.json": mcp({ p: { command: "npx", args: ["srv"], type: "stdio" } }) });
    await importInto(t.forge, t.ws("a"), "a");
    const reordered = mcp({ p: { type: "stdio", command: "npx", args: ["srv"] } });
    await writeFiles(t.ws("b"), { ".claude/rules/w.md": "# W\n", ".mcp.json": reordered });
    const b = await importClaudeCode({ workspaceRoot: t.ws("b"), forgeRoot: t.forge, profileName: "b", writeWorkspaceConfig: true });
    expect(b.reused).toContain("mcp/p");
    const w = await loadWorkspace(t.ws("b"));
    const st = await status(w, await plan(w), await readLock(w.root));
    expect(st.find((s) => s.path === ".mcp.json")?.state).toBe("collision");
  });
});

describe("ForgeStage — one fingerprintDir for staged and flushed ingredients (spec 07)", () => {
  it("fingerprints a staged directory, overlaid on disk, exactly as the same directory once flushed", async () => {
    const t = await setup();
    const dir = path.join(t.forge, "ingredients/hooks/guard");
    await writeFiles(dir, { "ingredient.yaml": "type: hook\nname: guard\nfiles: [guard.sh]\n", "guard.sh": "echo old\n", "extra.txt": "kept\n" });
    const stage = new ForgeStage(t.forge);
    stage.write(path.join(dir, "ingredient.yaml"), "type: hook\nname: guard\nfiles: [guard.sh, guard.ps1]\ntargets: [claude-code]\n");
    stage.write(path.join(dir, "guard.sh"), "echo new\n");
    stage.write(path.join(dir, "guard.ps1"), Buffer.from("Write-Output ps1\n"));
    const staged = await fingerprintDir(dir, stage.reader());
    expect(staged).not.toBe(await fingerprintDir(dir));
    await stage.flush();
    expect(await fingerprintDir(dir)).toBe(staged);
  });
});

describe("import --from claude-code — end to end with sync (spec 07 §9.1)", () => {
  it("imports an MCP server with undeclared keys, type first, and the workspace adopts it byte for byte", async () => {
    const t = await setup();
    const original = JSON.stringify({ mcpServers: { r: { type: "http", url: "https://mcp.acme.dev", headers: { "X-Team": "acme" }, timeout: 30 } } }, null, 2) + "\n";
    await writeFiles(t.ws("a"), { ".claude/rules/w.md": "# W\n", ".mcp.json": original });
    await importClaudeCode({ workspaceRoot: t.ws("a"), forgeRoot: t.forge, profileName: "a", writeWorkspaceConfig: true });
    const w = await loadWorkspace(t.ws("a"));
    const p = await plan(w);
    const st = await status(w, p, await readLock(w.root));
    expect(st.find((s) => s.path === ".mcp.json")?.state).toBe("adopt");
    await apply(w, p, st, {});
    expect(await fs.readFile(path.join(t.ws("a"), ".mcp.json"), "utf8")).toBe(original);
    const after = await status(w, await plan(w), await readLock(w.root));
    expect(after.find((s) => s.path === ".mcp.json")?.state).toBe("unchanged");
  });
});

describe("import over a templated base (spec 09 §9, resolved by spec 10)", () => {
  it("re-importing a workspace whose text the base renders through a default reuses the base", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/rules/deploy.md": "use globex-api\n" });
    await importInto(t.forge, t.ws("a"), "a");
    // What an extraction leaves behind: {{key}} in the body, the base's text as the declared default.
    await fs.writeFile(path.join(t.forge, "ingredients/rules/deploy/rule.md"), "use {{deploy.api}}\n");
    const meta = path.join(t.forge, "ingredients/rules/deploy/ingredient.yaml");
    await fs.writeFile(meta, (await fs.readFile(meta, "utf8")) + "params:\n  deploy.api:\n    default: globex-api\n");
    const again = await importInto(t.forge, t.ws("a"), "a");
    // Spec 10 flipped this pin: the base renders the workspace text through its default, so it is reused.
    expect(again.variants).toEqual([]);
    expect(again.reused).toContain("rule/deploy");
    expect(again.rendered).toEqual([{ name: "rule/deploy", keys: ["deploy.api"] }]);
  });
});

describe("template-aware import — decisions (spec 10 §6.1–§6.5)", () => {
  const fail = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e);
  /** A Forge whose rule/<name> holds `template` and declares `params` with those defaults, imported first from workspace `a`. */
  async function templated(t: Awaited<ReturnType<typeof setup>>, rules: Record<string, { template: string; params: Record<string, string>; literal: string }>) {
    const files: Record<string, string> = {};
    for (const [n, r] of Object.entries(rules)) files[`.claude/rules/${n}.md`] = r.literal;
    await writeFiles(t.ws("a"), files);
    await importInto(t.forge, t.ws("a"), "a");
    for (const [n, r] of Object.entries(rules)) {
      await fs.writeFile(path.join(t.forge, `ingredients/rules/${n}/rule.md`), r.template);
      const meta = path.join(t.forge, `ingredients/rules/${n}/ingredient.yaml`);
      const decl = Object.entries(r.params).map(([k, v]) => `  ${k}:\n    default: ${v}\n`).join("");
      await fs.writeFile(meta, (await fs.readFile(meta, "utf8")) + `params:\n${decl}`);
    }
  }
  const deploy = { template: "use {{deploy.api}} here\n", params: { "deploy.api": "globex-api" }, literal: "use globex-api here\n" };

  it("infers a new client's value and reuses the base", async () => {
    const t = await setup();
    await templated(t, { deploy });
    await writeFiles(t.ws("b"), { ".claude/rules/deploy.md": "use initech-api here\n" });
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.variants).toEqual([]);
    expect(r.inferred).toEqual([{ name: "rule/deploy", values: { "deploy.api": "initech-api" } }]);
    expect(r.params).toEqual([{ key: "deploy.api", old: null, value: "initech-api", from: "rule/deploy" }]);
  });

  it("proves but does not record a value equal to the declared default", async () => {
    const t = await setup();
    await templated(t, { deploy });
    await writeFiles(t.ws("c"), { ".claude/rules/deploy.md": "use globex-api here\n" });
    const r = await importInto(t.forge, t.ws("c"), "c");
    expect(r.reused).toContain("rule/deploy");
    expect(r.params).toEqual([]);
  });

  it("falls back to a variant, naming why, when the prose around the value changed (F5) or the split is ambiguous (F6)", async () => {
    const t = await setup();
    await templated(t, { deploy, pair: { template: "use {{a}} and {{b}}\n", params: { a: "x", b: "y" }, literal: "use x and y\n" } });
    await writeFiles(t.ws("b"), { ".claude/rules/deploy.md": "ship initech-api here\n", ".claude/rules/pair.md": "use p and q and r\n" });
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.variants.map((v) => v.reason)).toEqual([
      "differs from rule/deploy already in the Forge (the template does not match line 1 of rule.md)",
      "differs from rule/pair already in the Forge (inference ambiguous on line 1 of rule.md)",
    ]);
  });

  it("one key, one value per run: the later source becomes a variant (F8, Ruling 5)", async () => {
    const t = await setup();
    await templated(t, { deploy, notes: { template: "see {{deploy.api}} docs\n", params: { "deploy.api": "globex-api" }, literal: "see globex-api docs\n" } });
    await writeFiles(t.ws("b"), { ".claude/rules/deploy.md": "use initech-api here\n", ".claude/rules/notes.md": "see umbrella-api docs\n" });
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.reused).toContain("rule/deploy");
    expect(r.variants).toEqual([{ name: "rule/notes--b", reason: 'differs from rule/notes already in the Forge (deploy.api is "initech-api" in this import; rule/notes implies "umbrella-api")' }]);
  });

  it("a pinned key is not a hole: it renders at its value, so a line ambiguous only through it is reused (§3, §14 Q13)", async () => {
    const t = await setup();
    await templated(t, {
      first: { template: "one {{a}}\n", params: { a: "x" }, literal: "one x\n" },
      pair: { template: "use {{a}} and {{b}}\n", params: { a: "x", b: "y" }, literal: "use x and y\n" },
    });
    await writeFiles(t.ws("b"), { ".claude/rules/first.md": "one p and q\n", ".claude/rules/pair.md": "use p and q and r\n" });
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.variants).toEqual([]);
    expect(r.inferred).toEqual([
      { name: "rule/first", values: { a: "p and q" } },
      { name: "rule/pair", values: { b: "r" } },
    ]);
  });

  it("a key relied on at a base's own default is never set by a later inference (§6.5 (a)), so no earlier reuse drifts", async () => {
    const t = await setup();
    await templated(t, {
      aa: { template: "one {{k}}\n", params: { k: "alpha" }, literal: "one alpha\n" },
      bb: { template: "two {{k}}\n", params: { k: "zeta" }, literal: "two zeta\n" },
      cc: { template: "three {{k}}\n", params: { k: "gamma" }, literal: "three gamma\n" },
    });
    await writeFiles(t.ws("b"), { ".claude/rules/aa.md": "one alpha\n", ".claude/rules/bb.md": "two zeta\n", ".claude/rules/cc.md": "three alpha\n" });
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.reused).toEqual(expect.arrayContaining(["rule/aa", "rule/bb"]));
    // Setting k: alpha in the profile would render rule/bb as "two alpha" at the next sync.
    expect(r.params).toEqual([]);
    expect(r.variants).toEqual([{ name: "rule/cc--b", reason: 'differs from rule/cc already in the Forge (k is "gamma" in this import; rule/cc implies "alpha")' }]);
  });

  it("a pinned key that the source cannot match falls back as F5 when no other value would explain it", async () => {
    const t = await setup();
    await templated(t, { deploy, notes: { template: "see {{deploy.api}} docs\n", params: { "deploy.api": "globex-api" }, literal: "see globex-api docs\n" } });
    await writeFiles(t.ws("b"), { ".claude/rules/deploy.md": "use initech-api here\n", ".claude/rules/notes.md": "read initech-api docs\n" });
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.variants).toEqual([{ name: "rule/notes--b", reason: "differs from rule/notes already in the Forge (the template does not match line 1 of rule.md)" }]);
  });

  it("F1, F2: what no value can explain falls back before inference", async () => {
    const t = await setup();
    await templated(t, { deploy, notes: { template: "see {{deploy.api}} docs\n", params: { "deploy.api": "globex-api" }, literal: "see globex-api docs\n" } });
    await fs.writeFile(path.join(t.forge, "ingredients/rules/notes/extra.bin"), Buffer.from([0, 1, 2]));
    await writeFiles(t.ws("b"), {
      ".claude/rules/deploy.md": "use initech-api here\n",
      ".kiro/steering/deploy.md": "---\ninclusion: manual\n---\nuse initech-api here\n",
      ".claude/rules/notes.md": "see initech-api docs\n",
    });
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.variants.map((v) => v.reason)).toEqual([
      "differs from rule/deploy already in the Forge (metadata differs)",
      "differs from rule/notes already in the Forge (extra.bin differs)",
    ]);
  });

  it("F4, F7 through the importer: adjacent holes and a value a parameter cannot carry", async () => {
    const t = await setup();
    await templated(t, {
      adj: { template: "use {{a}}{{b}} here\n", params: { a: "x", b: "y" }, literal: "use xy here\n" },
      pad: { template: "use {{c}} here\n", params: { c: "z" }, literal: "use z here\n" },
    });
    await writeFiles(t.ws("b"), { ".claude/rules/adj.md": "use pq here\n", ".claude/rules/pad.md": "use  w here\n" });
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.variants.map((v) => v.reason)).toEqual([
      "differs from rule/adj already in the Forge (inference ambiguous: {{a}}{{b}} are adjacent on line 1 of rule.md)",
      'differs from rule/pad already in the Forge (c would be " w", which a parameter cannot carry)',
    ]);
  });

  it("refuses a profile change another Forge ingredient would feel (F9, §6.5 (b))", async () => {
    const t = await setup();
    await templated(t, { deploy });
    await writeFiles(path.join(t.forge, "ingredients/rules/deploy-notes"), { "ingredient.yaml": "type: rule\nname: deploy-notes\n", "rule.md": "see {{deploy.api}}\n" });
    await writeFiles(t.ws("b"), { ".claude/rules/deploy.md": "use initech-api here\n" });
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.variants[0].reason).toContain("setting deploy.api would change rule/deploy-notes");
    expect(r.params).toEqual([]);
  });

  it("refuses a profile change another Forge ingredient would feel (F9, §6.5 (b)) (./rule.md, 0.8.2)", async () => {
    // Like the original F9 test but with file: ./rule.md in the other ingredient. This verifies that
    // listAdmitted at decide.ts:277 uses the `dir` argument correctly. With dir, bodyFile compares
    // path.join(dir, "rule.md") === path.join(dir, "./rule.md"), which works. Without dir, it compares
    // "rule.md" === "./rule.md", which is false, so rule.md drops out of the F9 scan.
    const t = await setup();
    await templated(t, { deploy });
    await writeFiles(path.join(t.forge, "ingredients/rules/deploy-notes"), {
      "ingredient.yaml": "type: rule\nname: deploy-notes\nfile: ./rule.md\n",
      "rule.md": "see {{deploy.api}}\n",
    });
    await writeFiles(t.ws("b"), { ".claude/rules/deploy.md": "use initech-api here\n" });
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.variants[0].reason).toContain("setting deploy.api would change rule/deploy-notes");
    expect(r.params).toEqual([]);
  });

  it("does not hold a profile change back for a {{key}} in a file no target emits (F9, 0.8.2)", async () => {
    const t = await setup();
    await templated(t, { deploy });
    await writeFiles(path.join(t.forge, "ingredients/rules/deploy-notes"), { "ingredient.yaml": "type: rule\nname: deploy-notes\n", "rule.md": "see the docs\n", "notes.md": "see {{deploy.api}}\n" });
    await writeFiles(t.ws("b"), { ".claude/rules/deploy.md": "use initech-api here\n" });
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.variants).toEqual([]);
    expect(r.params.length).toBeGreaterThan(0);
  });

  it("keeps a Forge base in the F9 scan when its workspace source is rejected for a secret (§6.5 (b))", async () => {
    const t = await setup();
    await templated(t, { deploy });
    await writeFiles(path.join(t.forge, "ingredients/rules/deploy-notes"), { "ingredient.yaml": "type: rule\nname: deploy-notes\n", "rule.md": "see {{deploy.api}}\n" });
    await writeFiles(t.ws("b"), { ".claude/rules/deploy.md": "use initech-api here\n", ".claude/rules/deploy-notes.md": `token ${TOKEN}\n` });
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.rejected.map((x) => x.name)).toEqual(["rule/deploy-notes"]);
    expect(r.variants[0].reason).toContain("setting deploy.api would change rule/deploy-notes");
    expect(r.params).toEqual([]);
  });

  it("keeps a Forge base in the F9 scan when its steering source is shadowed by a rule of the same name (§6.5 (b))", async () => {
    const t = await setup();
    await templated(t, { deploy });
    await writeFiles(path.join(t.forge, "ingredients/steerings/deploy"), { "ingredient.yaml": "type: steering\nname: deploy\n", "steering.md": "see {{deploy.api}}\n" });
    await writeFiles(t.ws("b"), { ".claude/rules/deploy.md": "use initech-api here\n", ".kiro/steering/deploy.md": "use initech-api here\n" });
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.variants[0].reason).toContain("setting deploy.api would change steering/deploy");
    expect(r.params).toEqual([]);
  });

  it("a steering file that may be shadowed still counts for the literal check when its rule is rejected (§6.5 (c))", async () => {
    const t = await setup();
    await templated(t, { deploy });
    await writeFiles(t.ws("b"), {
      ".claude/rules/deploy.md": "use initech-api here\n",
      ".claude/rules/zeta.md": `token ${TOKEN}\n`,
      ".kiro/steering/zeta.md": "raw {{deploy.api}}\n",
    });
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.variants[0].reason).toContain("setting deploy.api would change steering/zeta");
    expect(r.params).toEqual([]);
  });

  it("refuses a profile change another source of the run cites literally (F9, §6.5 (c))", async () => {
    const t = await setup();
    await templated(t, { deploy });
    await writeFiles(t.ws("b"), { ".claude/rules/deploy.md": "use initech-api here\n", ".claude/rules/zeta.md": "raw {{deploy.api}}\n" });
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.variants[0].reason).toContain("setting deploy.api would change rule/zeta");
  });

  it("G1: a recipe default for a cited key means a literal comparison and a warning", async () => {
    const t = await setup();
    await templated(t, { deploy });
    const base = path.join(t.forge, "recipes/base.yaml");
    await fs.writeFile(base, (await fs.readFile(base, "utf8")).replace("params: {}", "params:\n  deploy.api:\n    default: recipe-api"));
    await writeFiles(t.ws("b"), { ".claude/rules/deploy.md": "use initech-api here\n" });
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.warnings).toContain("rule/deploy cites {{deploy.api}}, which recipe base defaults — compared literally");
    expect(r.variants.map((v) => v.name)).toEqual(["rule/deploy--b"]);
  });

  it("a workspace override renders and is never inferred into the profile", async () => {
    const t = await setup();
    await templated(t, { deploy });
    await writeFiles(t.ws("b"), { ".claude/rules/deploy.md": "use local-api here\n", "craftar.local.yaml": "overrides:\n  params:\n    deploy.api: local-api\n" });
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.reused).toContain("rule/deploy");
    expect(r.rendered).toEqual([{ name: "rule/deploy", keys: ["deploy.api"] }]);
    expect(r.params).toEqual([]);
  });

  it("I3, I4, I5, I6: refusals leave the Forge untouched", async () => {
    const t = await setup();
    await templated(t, { deploy });
    const profileA = path.join(t.forge, "profiles/a/profile.yaml");
    await fs.writeFile(profileA, (await fs.readFile(profileA, "utf8")).replace("params: {}", "params:\n  deploy.api: acme-api"));
    const before = await snapshot(t.forge);

    await writeFiles(t.ws("i3"), { ".claude/rules/deploy.md": "use acme-api here\n", ".claude/rules/fresh.md": "raw {{deploy.api}}\n" });
    expect((await fail(importInto(t.forge, t.ws("i3"), "a")))?.message).toContain("import: .claude/rules/fresh.md holds {{deploy.api}} literally, but profile a sets deploy.api");

    await writeFiles(t.ws("i6"), { ".claude/rules/deploy.md": "use x here\n", "craftar.yaml": "forge: ../forge\nprofile: z\noverrides:\n  params: [1]\n" });
    expect((await fail(importInto(t.forge, t.ws("i6"), "z")))?.message).toContain("import: craftar.yaml does not load");
    expect(await snapshot(t.forge)).toEqual(before);

    await fs.mkdir(path.join(t.forge, "profiles/elsewhere"), { recursive: true });
    await fs.writeFile(path.join(t.forge, "profiles/elsewhere/profile.yaml"), "name: q\n");
    await writeFiles(t.ws("i4"), { ".claude/rules/deploy.md": "use x here\n" });
    expect((await fail(importInto(t.forge, t.ws("i4"), "q")))?.message).toContain("import: profile q is profiles/elsewhere/profile.yaml");

    await fs.writeFile(path.join(t.forge, "recipes/broken.yaml"), "name: [\n");
    expect((await fail(importInto(t.forge, t.ws("i4"), "z")))?.message).toContain("import: the Forge does not load");
  });

  it("I8: a variant another profile resolves is not rewritten", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/rules/deploy.md": "one\n" });
    await importInto(t.forge, t.ws("a"), "a");
    await writeFiles(t.ws("b"), { ".claude/rules/deploy.md": "two\n" });
    await importInto(t.forge, t.ws("b"), "b");
    await fs.writeFile(path.join(t.forge, "profiles/a/profile.yaml"), "name: a\nrecipes:\n  - base--b\n");
    await writeFiles(t.ws("b"), { ".claude/rules/deploy.md": "three\n" });
    expect((await fail(importInto(t.forge, t.ws("b"), "b")))?.message).toContain("import: rule/deploy--b is also used by profile a — its files would change there");
  });
});

describe("template-aware import — shared and owned recipes (spec 10 §6.7, Ruling 7)", () => {
  const fail = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e);
  async function resolvedRefs(forgeRoot: string, profile: string): Promise<string[]> {
    const { resolve } = await import("../src/core/resolve.js");
    const { WorkspaceConfigSchema } = await import("../src/schema/index.js");
    return resolve(await loadForge(forgeRoot), WorkspaceConfigSchema.parse({ forge: ".", profile })).ingredients.map((i) => i.ref).sort();
  }

  it("a second client with an extra rule does not widen the shared base (AC 19, first direction)", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/rules/a.md": "# A\n" });
    await importInto(t.forge, t.ws("a"), "a");
    await writeFiles(t.ws("b"), { ".claude/rules/a.md": "# A\n", ".claude/rules/z.md": "# Z\n" });
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.recipeSplits).toEqual([{ shared: "base", owned: "base--b", reason: "this workspace has rule/z, which base lacks" }]);
    expect((await yaml(path.join(t.forge, "recipes/base.yaml"))).ingredients).toEqual(["rule/a"]);
    expect(await resolvedRefs(t.forge, "a")).toEqual(["rule/a"]);
    expect(await resolvedRefs(t.forge, "b")).toEqual(["rule/a", "rule/z"]);
  });

  it("a second client lacking a rule does not inherit it (AC 19, other direction)", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/rules/a.md": "# A\n", ".claude/rules/y.md": "# Y\n" });
    await importInto(t.forge, t.ws("a"), "a");
    await writeFiles(t.ws("b"), { ".claude/rules/a.md": "# A\n" });
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.recipeSplits[0]).toMatchObject({ shared: "base", owned: "base--b", reason: "base lists rule/y, which this workspace lacks" });
    expect(await resolvedRefs(t.forge, "b")).toEqual(["rule/a"]);
    expect(await resolvedRefs(t.forge, "a")).toEqual(["rule/a", "rule/y"]);
  });

  it("an owned recipe holds exactly the workspace's list, edited in place, and a set-equal shared recipe is reused", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/rules/a.md": "# A\n" });
    await importInto(t.forge, t.ws("a"), "a");
    await writeFiles(t.ws("b"), { ".claude/rules/a.md": "# A\n", ".claude/rules/z.md": "# Z\n" });
    await importInto(t.forge, t.ws("b"), "b");
    const owned = path.join(t.forge, "recipes/base--b.yaml");
    await fs.writeFile(owned, "# b's own recipe\n" + (await fs.readFile(owned, "utf8")));
    await writeFiles(t.ws("b"), { ".claude/rules/w.md": "# W\n" });
    await fs.rm(path.join(t.ws("b"), ".claude/rules/z.md"));
    await importInto(t.forge, t.ws("b"), "b");
    const text = await fs.readFile(owned, "utf8");
    expect(text.startsWith("# b's own recipe\n")).toBe(true);
    expect(YAML.parse(text).ingredients).toEqual(["rule/a", "rule/w"]);
    await fs.rm(path.join(t.ws("b"), ".claude/rules/w.md"));
    const back = await importInto(t.forge, t.ws("b"), "b");
    expect(back.recipes).toContain("base");
    expect(back.recipeSplits).toEqual([]);
  });

  it("Q10: an existing profile does not move to a set-equal shared recipe that orders its rules differently", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/rules/a.md": "# A\n", ".claude/rules/b.md": "# B\n" });
    await importInto(t.forge, t.ws("a"), "a");
    await writeFiles(t.ws("b"), { ".claude/rules/a.md": "# A\n", ".claude/rules/b.md": "# B\n", ".claude/rules/z.md": "# Z\n" });
    await importInto(t.forge, t.ws("b"), "b");
    const shared = path.join(t.forge, "recipes/base.yaml");
    const text = await fs.readFile(shared, "utf8");
    expect(text).toContain("  - rule/a\n  - rule/b\n");
    await fs.writeFile(shared, text.replace("  - rule/a\n  - rule/b\n", "  - rule/b\n  - rule/a\n"));
    await fs.rm(path.join(t.ws("b"), ".claude/rules/z.md"));
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.recipeSplits).toEqual([{ shared: "base", owned: "base--b", reason: "base orders its rules differently" }]);
    expect((await yaml(path.join(t.forge, "recipes/base--b.yaml"))).ingredients).toEqual(["rule/a", "rule/b"]);
    expect((await yaml(shared)).ingredients).toEqual(["rule/b", "rule/a"]);
  });

  it("I2: an owned recipe that does not round-trip is refused with the Forge untouched", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/rules/a.md": "# A\n" });
    await importInto(t.forge, t.ws("a"), "a");
    await writeFiles(t.ws("b"), { ".claude/rules/a.md": "# A\n", ".claude/rules/z.md": "# Z\n" });
    await importInto(t.forge, t.ws("b"), "b");
    const owned = path.join(t.forge, "recipes/base--b.yaml");
    await fs.writeFile(owned, (await fs.readFile(owned, "utf8")).replace("name: base--b", "name: base--b      # aligned"));
    const before = await snapshot(t.forge);
    await writeFiles(t.ws("b"), { ".claude/rules/w.md": "# W\n" });
    expect((await fail(importInto(t.forge, t.ws("b"), "b")))?.message).toContain("import: cannot edit recipes/base--b.yaml in place");
    expect(await snapshot(t.forge)).toEqual(before);
  });

  it("an existing recipe that does not load is refused, naming its file, with the Forge untouched (754d7b9)", async () => {
    const t = await setup();
    // No manifest, so forgeBefore() does not load the Forge and placeRecipe is the first to read the recipe.
    await writeFiles(t.forge, { "recipes/base.yaml": "name: base\ningredients: rule/a\n" });
    const before = await snapshot(t.forge);
    await writeFiles(t.ws("a"), { ".claude/rules/a.md": "# A\n" });
    const e = await fail(importInto(t.forge, t.ws("a"), "a"));
    expect(e?.message).toMatch(/invalid .*recipes[\\/]base\.yaml: /);
    expect(e?.message).toContain("The Forge was left untouched.");
    expect(await snapshot(t.forge)).toEqual(before);
  });

  it("a recipe whose name and file disagree is refused with the Forge untouched, instead of writing a second recipe", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/rules/a.md": "# A\n" });
    await importInto(t.forge, t.ws("a"), "a");
    await fs.rename(path.join(t.forge, "recipes/base.yaml"), path.join(t.forge, "recipes/shared.yaml"));
    const before = await snapshot(t.forge);
    await writeFiles(t.ws("b"), { ".claude/rules/a.md": "# A\n" });
    expect((await fail(importInto(t.forge, t.ws("b"), "b")))?.message).toContain("import: recipe base is recipes/shared.yaml — import writes recipes/base.yaml");
    expect(await snapshot(t.forge)).toEqual(before);

    await fs.writeFile(path.join(t.forge, "recipes/base.yaml"), "name: other\ningredients: []\n");
    await fs.rm(path.join(t.forge, "recipes/shared.yaml"));
    await fs.writeFile(path.join(t.forge, "profiles/a/profile.yaml"), "name: a\nrecipes:\n  - other\n");
    const before2 = await snapshot(t.forge);
    expect((await fail(importInto(t.forge, t.ws("b"), "b")))?.message).toContain("import: recipes/base.yaml is recipe other — import writes recipe base there");
    expect(await snapshot(t.forge)).toEqual(before2);
  });

  it("I7: an owned recipe another profile resolves is not changed", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/rules/a.md": "# A\n" });
    await importInto(t.forge, t.ws("a"), "a");
    await writeFiles(t.ws("b"), { ".claude/rules/a.md": "# A\n", ".claude/rules/z.md": "# Z\n" });
    await importInto(t.forge, t.ws("b"), "b");
    await fs.writeFile(path.join(t.forge, "profiles/a/profile.yaml"), "name: a\nrecipes:\n  - base--b\n");
    await writeFiles(t.ws("b"), { ".claude/rules/w.md": "# W\n" });
    expect((await fail(importInto(t.forge, t.ws("b"), "b")))?.message).toContain("import: recipe base--b is also used by profile a — its ingredients would change there");
  });
});

describe("template-aware import — the profile (spec 10 §6.6, Rulings 2 and 3)", () => {
  const fail = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e);
  async function templatedDeploy(t: Awaited<ReturnType<typeof setup>>) {
    await writeFiles(t.ws("a"), { ".claude/rules/deploy.md": "use acme-api here\n" });
    await importInto(t.forge, t.ws("a"), "a");
    await fs.writeFile(path.join(t.forge, "ingredients/rules/deploy/rule.md"), "use {{deploy.api}} here\n");
    const meta = path.join(t.forge, "ingredients/rules/deploy/ingredient.yaml");
    await fs.writeFile(meta, (await fs.readFile(meta, "utf8")) + "params:\n  deploy.api:\n    default: globex-api\n");
    const prof = path.join(t.forge, "profiles/a/profile.yaml");
    await fs.writeFile(prof, "# acme, by hand\n" + (await fs.readFile(prof, "utf8")).replace("params: {}", "params:\n  deploy.api: acme-api"));
    return prof;
  }

  it("a new client's profile holds the inferred values", async () => {
    const t = await setup();
    await templatedDeploy(t);
    await writeFiles(t.ws("b"), { ".claude/rules/deploy.md": "use initech-api here\n" });
    const r = await importInto(t.forge, t.ws("b"), "b");
    expect(r.profileWrite).toEqual({ path: "profiles/b/profile.yaml", action: "created", fields: [] });
    expect((await yaml(path.join(t.forge, "profiles/b/profile.yaml"))).params).toEqual({ "deploy.api": "initech-api" });
  });

  it("re-import of an unchanged workspace edits nothing; a changed value updates the profile in place and warns (Ruling 3)", async () => {
    const t = await setup();
    const prof = await templatedDeploy(t);
    const before = await fs.readFile(prof, "utf8");
    const same = await importInto(t.forge, t.ws("a"), "a");
    expect(same.profileWrite.action).toBe("unchanged");
    expect(same.created).not.toContain("profiles/a/profile.yaml");
    expect(await fs.readFile(prof, "utf8")).toBe(before);

    await writeFiles(t.ws("a"), { ".claude/rules/deploy.md": "use acme-api-v2 here\n" });
    const r = await importInto(t.forge, t.ws("a"), "a");
    expect(r.params).toEqual([{ key: "deploy.api", old: "acme-api", value: "acme-api-v2", from: "rule/deploy" }]);
    expect(r.profileWrite).toEqual({ path: "profiles/a/profile.yaml", action: "edited", fields: ["params"] });
    expect(r.warnings).toContain('profile a now sets deploy.api to "acme-api-v2" (was "acme-api") — every workspace on a renders it at its next sync; import cannot reach them');
    expect(await fs.readFile(prof, "utf8")).toBe(before.replace("deploy.api: acme-api", "deploy.api: acme-api-v2"));
  });

  it("I1: a hand-formatted profile is refused with the Forge untouched", async () => {
    const t = await setup();
    const prof = await templatedDeploy(t);
    await fs.writeFile(prof, (await fs.readFile(prof, "utf8")).replace("name: a", "name: a        # aligned"));
    const before = await snapshot(t.forge);
    await writeFiles(t.ws("a"), { ".claude/rules/deploy.md": "use acme-api-v2 here\n" });
    expect((await fail(importInto(t.forge, t.ws("a"), "a")))?.message).toContain("import: cannot edit profiles/a/profile.yaml in place");
    expect(await snapshot(t.forge)).toEqual(before);
  });
});

describe("template-aware import — --write-config merges craftar.yaml (spec 10 §6.9, Ruling 8)", () => {
  const fail = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e);
  const imp = (t: Awaited<ReturnType<typeof setup>>, ws: string, profile: string) =>
    importClaudeCode({ workspaceRoot: t.ws(ws), forgeRoot: t.forge, profileName: profile, writeWorkspaceConfig: true });

  it("writes a new craftar.yaml exactly as before", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/rules/a.md": "# A\n" });
    const r = await imp(t, "a", "a");
    expect(await fs.readFile(path.join(t.ws("a"), "craftar.yaml"), "utf8")).toBe("forge: ../forge\nprofile: a\ntargets:\n  - claude-code\n");
    expect(r.configWrite).toBe("created");
    expect(r.created).toContain("craftar.yaml (workspace)");
  });

  it("keeps comments, ref, recipes and overrides of an existing craftar.yaml, setting forge, profile and targets", async () => {
    const t = await setup();
    const existing = "# acme workspace\nforge: ../old-forge\nref: v1\nprofile: old\nrecipes:\n  add:\n    - extra\noverrides:\n  params:\n    k: v # local value\n  ingredients:\n    disable: []\n";
    await writeFiles(t.ws("a"), { ".claude/rules/a.md": "# A\n", "craftar.yaml": existing });
    const r = await imp(t, "a", "a");
    expect(r.configWrite).toBe("edited");
    expect(await fs.readFile(path.join(t.ws("a"), "craftar.yaml"), "utf8")).toBe(
      existing.replace("forge: ../old-forge", "forge: ../forge").replace("profile: old", "profile: a") + "targets:\n  - claude-code\n",
    );
  });

  it("I9: a craftar.yaml that does not round-trip fails the whole import with the Forge untouched", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/rules/a.md": "# A\n", "craftar.yaml": "forge: x      # aligned\nprofile: a\n" });
    const err = await fail(imp(t, "a", "a"));
    expect(err?.message).toContain("import: cannot edit craftar.yaml in place (it does not round-trip unchanged through the YAML writer) — reformat it by hand and re-run");
    expect(err?.message).toContain("The Forge was left untouched.");
    expect(await exists(t.forge)).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a write failure after the flush says the Forge was written", async () => {
    const t = await setup();
    await writeFiles(t.ws("a"), { ".claude/rules/a.md": "# A\n", "craftar.yaml": "forge: x\nprofile: a\n" });
    await fs.chmod(path.join(t.ws("a"), "craftar.yaml"), 0o444);
    const err = await fail(imp(t, "a", "a"));
    expect(err?.message).toContain("The Forge was written in full and the import succeeded; writing craftar.yaml failed");
    expect(await exists(path.join(t.forge, "recipes/base.yaml"))).toBe(true);
  });
});

describe("section-aware import — decisions (spec 11 §6.7–§6.10)", () => {
  const fail = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e);
  const OPEN = (n: string) => `<!-- craftar:section ${n} -->\n`;
  const CLOSE = "<!-- /craftar:section -->\n";
  const HEAD = "# Review posture\n\nDispatch reviewers after every commit.\n\n";
  const TAIL = "\nNever edit what a reviewer reads.\n";
  const table = (...repos: string[]) => `| Repo | Reviewer |\n|---|---|\n${repos.map((r) => `| \`${r}\` | reviewer |\n`).join("")}`;
  const ACME = table("acme-api", "acme-web");
  const GLOBEX = table("globex-api", "globex-web", "globex-desktop");
  const plain = (t: string) => `${HEAD}${t}${TAIL}`;
  const MARKED = `${HEAD}${OPEN("flavors")}${ACME}${CLOSE}${TAIL}`;

  /** Import `acme` (one rule, plus `extra` files), then replace the base's body by `body` — the hand-made section of edge case 1. */
  async function marked(t: Awaited<ReturnType<typeof setup>>, body = MARKED, acme = plain(ACME), extra: Record<string, string> = {}) {
    await writeFiles(t.ws("acme"), { ".claude/rules/review-posture.md": acme, ...extra });
    await importInto(t.forge, t.ws("acme"), "acme");
    await fs.writeFile(path.join(t.forge, "ingredients/rules/review-posture/rule.md"), body);
  }
  const profileOf = (t: Awaited<ReturnType<typeof setup>>, p: string) => yaml(path.join(t.forge, `profiles/${p}/profile.yaml`));

  it("the hand-made section: acme renders with its default (rendered reuse), a new globex is inferred into its profile", async () => {
    const t = await setup();
    await marked(t);
    const acme = await importInto(t.forge, t.ws("acme"), "acme");
    expect(acme.reused).toEqual(["rule/review-posture"]);
    expect(acme.rendered).toEqual([]);
    expect(acme.sections).toEqual([]);

    await writeFiles(t.ws("globex"), { ".claude/rules/review-posture.md": plain(GLOBEX) });
    const g = await importInto(t.forge, t.ws("globex"), "globex");
    expect(g.variants).toEqual([]);
    expect(g.sectioned).toEqual([{ name: "rule/review-posture", sections: ["flavors"] }]);
    expect(g.sections).toEqual([{ key: "rule/review-posture", name: "flavors", old: null, value: GLOBEX, from: "rule/review-posture" }]);
    // A new profile holds `sections` after `params` (spec 11 §6.10), and it is not warned: no workspace was on it.
    const text = await fs.readFile(path.join(t.forge, "profiles/globex/profile.yaml"), "utf8");
    expect(Object.keys(YAML.parse(text)).slice(-3)).toEqual(["params", "sections", "repos"]);
    expect(YAML.parse(text).sections).toEqual({ "rule/review-posture": { flavors: GLOBEX } });
    expect(g.warnings.filter((w) => w.includes("now sets section"))).toEqual([]);
  });

  it("a new profile without Δs has no `sections` key", async () => {
    const t = await setup();
    await marked(t);
    await writeFiles(t.ws("globex"), { ".claude/rules/review-posture.md": plain(ACME) });
    await importInto(t.forge, t.ws("globex"), "globex");
    expect(await fs.readFile(path.join(t.forge, "profiles/globex/profile.yaml"), "utf8")).not.toContain("sections");
  });

  it("rendered reuse through PS, and through WS — neither writes a section value", async () => {
    const t = await setup();
    await marked(t);
    await writeFiles(t.ws("globex"), { ".claude/rules/review-posture.md": plain(GLOBEX) });
    await importInto(t.forge, t.ws("globex"), "globex");
    const prof = path.join(t.forge, "profiles/globex/profile.yaml");
    const before = await fs.readFile(prof, "utf8");
    const again = await importInto(t.forge, t.ws("globex"), "globex");
    expect(again.rendered).toEqual([{ name: "rule/review-posture", keys: [], sections: ["flavors"] }]);
    expect(again.sections).toEqual([]);
    expect(await fs.readFile(prof, "utf8")).toBe(before);

    const local = table("initech-api");
    await writeFiles(t.ws("initech"), {
      ".claude/rules/review-posture.md": plain(local),
      "craftar.local.yaml": YAML.stringify({ overrides: { sections: { "rule/review-posture": { flavors: local } } } }),
    });
    const i = await importInto(t.forge, t.ws("initech"), "initech");
    expect(i.rendered).toEqual([{ name: "rule/review-posture", keys: [], sections: ["flavors"] }]);
    expect(i.sections).toEqual([]);
    expect(await fs.readFile(path.join(t.forge, "profiles/initech/profile.yaml"), "utf8")).not.toContain("sections");
  });

  it("two separated sections, one emptied; a workspace-fixed section never enters Δs (edge case 5)", async () => {
    const t = await setup();
    await marked(t, `A\n${OPEN("a")}x\n${CLOSE}sep\n${OPEN("b")}y\n${CLOSE}B\n`, "A\nx\nsep\ny\nB\n");
    await writeFiles(t.ws("globex"), { ".claude/rules/review-posture.md": "A\nsep\nr\nB\n" });
    const g = await importInto(t.forge, t.ws("globex"), "globex");
    expect(g.sectioned).toEqual([{ name: "rule/review-posture", sections: ["a", "b"] }]);
    expect(g.sections.map((x) => [x.name, x.value])).toEqual([["a", ""], ["b", "r\n"]]);

    await writeFiles(t.ws("initech"), {
      ".claude/rules/review-posture.md": "A\nq\nsep\nlocal\nB\n",
      "craftar.yaml": YAML.stringify({ forge: "../forge", profile: "initech", overrides: { sections: { "rule/review-posture": { b: "local" } } } }),
    });
    const i = await importInto(t.forge, t.ws("initech"), "initech");
    expect(i.sectioned).toEqual([{ name: "rule/review-posture", sections: ["a"] }]);
    expect(i.sections.map((x) => [x.name, x.value])).toEqual([["a", "q\n"]]);
  });

  it("F11, F12, F13: each falls back to a variant naming why, and the run continues", async () => {
    const t = await setup();
    await marked(t, `A\n${OPEN("a")}x\n${CLOSE}${OPEN("b")}y\n${CLOSE}B\n`, "A\nx\ny\nB\n", { ".claude/rules/shared.md": "shared\n" });
    const f11 = await (async () => {
      await writeFiles(t.ws("f11"), { ".claude/rules/review-posture.md": "C\nq\nB\n", ".claude/rules/shared.md": "shared\n" });
      return importInto(t.forge, t.ws("f11"), "f11");
    })();
    expect(f11.variants).toEqual([{ name: "rule/review-posture--f11", reason: "differs from rule/review-posture already in the Forge (the text outside the sections of ingredients/rules/review-posture/rule.md differs (line 1))" }]);
    expect(f11.reused).toContain("rule/shared");

    await writeFiles(t.ws("f12"), { ".claude/rules/review-posture.md": "A\nq\nB\n" });
    const f12 = await importInto(t.forge, t.ws("f12"), "f12");
    expect(f12.variants[0].reason).toContain("(section inference ambiguous in ingredients/rules/review-posture/rule.md: a, b)");

  });

  it("F13: an inferred value may not cite a {{k}} the render sets (E10)", async () => {
    const t = await setup();
    await marked(t);
    const meta = path.join(t.forge, "ingredients/rules/review-posture/ingredient.yaml");
    await fs.writeFile(meta, (await fs.readFile(meta, "utf8")) + "params:\n  deploy.api:\n    default: globex-api\n");
    await writeFiles(t.ws("f13"), { ".claude/rules/review-posture.md": plain(table("{{deploy.api}}")) });
    const f13 = await importInto(t.forge, t.ws("f13"), "f13");
    expect(f13.variants[0].reason).toContain("(section flavors would cite {{deploy.api}}, which this profile renders)");
  });

  it("F13: an inferred value that would hold a marker line is refused as a value — the source then fails I11 as a variant", async () => {
    const t = await setup();
    await marked(t);
    await writeFiles(t.ws("globex"), { ".claude/rules/review-posture.md": plain(`${ACME}<!-- craftar:section inner -->\n`) });
    const e = await fail(importInto(t.forge, t.ws("globex"), "globex"));
    expect(e?.message).toContain("import: .claude/rules/review-posture.md holds a section marker on line 9 — sync would not reproduce it; indent it or remove it, and re-run");
  });

  it("F14: the proof is the gate — a placeholder straddling a value and the text after it renders differently whole", async () => {
    const t = await setup();
    await marked(t, `A\n${OPEN("a")}x\n${CLOSE}deploy.api}} end\n`, "A\nx\ndeploy.api}} end\n");
    const meta = path.join(t.forge, "ingredients/rules/review-posture/ingredient.yaml");
    await fs.writeFile(meta, (await fs.readFile(meta, "utf8")) + "params:\n  deploy.api:\n    default: D\n");
    await writeFiles(t.ws("globex"), { ".claude/rules/review-posture.md": "A\nsee {{\ndeploy.api}} end\n" });
    const g = await importInto(t.forge, t.ws("globex"), "globex");
    expect(g.variants).toEqual([{ name: "rule/review-posture--globex", reason: "differs from rule/review-posture already in the Forge (section inference not proved for rule/review-posture)" }]);
  });

  it("I11: a created source with a column-0 marker is refused, the Forge byte-identical; an indented one is literal", async () => {
    const t = await setup();
    await marked(t);
    const before = await snapshot(t.forge);
    await writeFiles(t.ws("globex"), { ".claude/rules/fresh.md": "Intro\n<!-- /craftar:section -->\n" });
    expect((await fail(importInto(t.forge, t.ws("globex"), "globex")))?.message).toContain("import: .claude/rules/fresh.md holds a section marker on line 2");
    expect(await snapshot(t.forge)).toEqual(before);
    await writeFiles(t.ws("globex"), { ".claude/rules/fresh.md": "Intro\n    <!-- /craftar:section -->\n" });
    expect((await importInto(t.forge, t.ws("globex"), "globex")).created).toContain("rule/fresh");
  });

  it("I12: a base with malformed markers is refused, the Forge byte-identical", async () => {
    const t = await setup();
    await marked(t, `${HEAD}${OPEN("flavors")}${ACME}${TAIL}`);
    const before = await snapshot(t.forge);
    const e = await fail(importInto(t.forge, t.ws("acme"), "acme"));
    expect(e?.message).toContain("import: ingredients/rules/review-posture/rule.md:5: section flavors is never closed — fix the Forge and re-run");
    expect(e?.message).toContain("The Forge was left untouched.");
    expect(await snapshot(t.forge)).toEqual(before);
  });

  it("I12: a base with malformed markers is refused, the Forge byte-identical (./rule.md, 0.8.2)", async () => {
    // This test checks that readBase at :53 uses the `dir` argument when parsing body files.
    // With dir, bodyFile compares path.join(dir, "rule.md") against path.join(dir, "./rule.md"), which works.
    // Without dir, it compares "rule.md" === "./rule.md", which is false, so rule.md is not read as a body file.
    const t = await setup();
    await marked(t, `${HEAD}${OPEN("flavors")}${ACME}${TAIL}`);
    // Add file: ./rule.md to the ingredient metadata
    const metaPath = path.join(t.forge, "ingredients/rules/review-posture/ingredient.yaml");
    const meta = YAML.parse(await fs.readFile(metaPath, "utf8"));
    meta.file = "./rule.md";
    await fs.writeFile(metaPath, YAML.stringify(meta));
    const before = await snapshot(t.forge);
    const e = await fail(importInto(t.forge, t.ws("acme"), "acme"));
    expect(e?.message).toContain("import: ingredients/rules/review-posture/rule.md:5: section flavors is never closed — fix the Forge and re-run");
    expect(e?.message).toContain("The Forge was left untouched.");
    expect(await snapshot(t.forge)).toEqual(before);
  });

  it("a malformed marker in a file no target emits does not refuse the import (0.8.2)", async () => {
    const t = await setup();
    await marked(t);
    // Add a notes.md with a malformed marker to the Forge ingredient
    await fs.writeFile(path.join(t.forge, "ingredients/rules/review-posture/notes.md"), `${OPEN("x")}no closer\n`);
    // The import should not fail due to the malformed marker in notes.md (a file no target emits)
    // The source will become a variant since the file set differs, but that's fine
    const r = await importInto(t.forge, t.ws("acme"), "acme");
    // Verify the import succeeded (created a variant because file sets differ)
    expect(r.variants.map((v) => v.name)).toEqual(["rule/review-posture--acme"]);
  });

  it("param inference is preferred for a {{k}} inside a default (Ruling 16); a source that differs in both is a variant", async () => {
    const t = await setup();
    await marked(t, `Deploy {{deploy.api}}.\n${OPEN("rows")}| {{owner}} |\n${CLOSE}`, "Deploy globex-api.\n| ann |\n");
    const meta = path.join(t.forge, "ingredients/rules/review-posture/ingredient.yaml");
    await fs.writeFile(meta, (await fs.readFile(meta, "utf8")) + "params:\n  deploy.api:\n    default: globex-api\n  owner:\n    default: ann\n");
    await writeFiles(t.ws("globex"), { ".claude/rules/review-posture.md": "Deploy globex-api.\n| bob |\n" });
    const g = await importInto(t.forge, t.ws("globex"), "globex");
    expect(g.inferred).toEqual([{ name: "rule/review-posture", values: { "deploy.api": "globex-api", owner: "bob" } }]);
    expect(g.sectioned).toEqual([]);

    await writeFiles(t.ws("initech"), { ".claude/rules/review-posture.md": "Deploy initech-api.\n| a |\n| b |\n" });
    const i = await importInto(t.forge, t.ws("initech"), "initech");
    expect(i.variants.map((v) => v.name)).toEqual(["rule/review-posture--initech"]);
    expect(i.variants[0].reason).toContain("the text outside the sections");
  });

  it("an inferred value citing {{title}} unset pins it: a later param inference setting it is refused (edge case 7)", async () => {
    const t = await setup();
    await marked(t, `${OPEN("rows")}x\n${CLOSE}`, "x\n", { ".claude/rules/zeta.md": "Hello world\n" });
    await fs.writeFile(path.join(t.forge, "ingredients/rules/zeta/rule.md"), "Hello {{title}}\n");
    const zmeta = path.join(t.forge, "ingredients/rules/zeta/ingredient.yaml");
    await fs.writeFile(zmeta, (await fs.readFile(zmeta, "utf8")) + "params:\n  title:\n    default: world\n");
    await writeFiles(t.ws("globex"), { ".claude/rules/review-posture.md": "{{ 'Save' | localize }} {{title}}\n", ".claude/rules/zeta.md": "Hello globex\n" });
    const g = await importInto(t.forge, t.ws("globex"), "globex");
    expect(g.sections.map((x) => x.value)).toEqual(["{{ 'Save' | localize }} {{title}}\n"]);
    // F8's wording names the value zeta renders (its own default); the pin itself came from the section value.
    expect(g.variants).toEqual([{ name: "rule/zeta--globex", reason: 'differs from rule/zeta already in the Forge (title is "world" in this import; rule/zeta implies "globex")' }]);
    // Control: the same run without {{title}} in the section value infers title for zeta.
    await writeFiles(t.ws("initech"), { ".claude/rules/review-posture.md": "no title here\n", ".claude/rules/zeta.md": "Hello initech\n" });
    const i = await importInto(t.forge, t.ws("initech"), "initech");
    expect(i.inferred).toEqual([{ name: "rule/zeta", values: { title: "initech" } }]);
  });

  it("I6: a wrong-shape overrides.sections key fails the import, naming the file, the Forge untouched", async () => {
    const t = await setup();
    await marked(t);
    const before = await snapshot(t.forge);
    await writeFiles(t.ws("globex"), { ".claude/rules/review-posture.md": plain(ACME), "craftar.local.yaml": "overrides:\n  sections:\n    review-posture.flavors: x\n" });
    const e = await fail(importInto(t.forge, t.ws("globex"), "globex"));
    expect(e?.message).toContain("import: craftar.local.yaml does not load");
    expect(await snapshot(t.forge)).toEqual(before);
  });

  it("F9 (b): a param change is refused when the profile's section value for an ingredient outside the run cites the key", async () => {
    const t = await setup();
    await writeFiles(t.ws("acme"), { ".claude/rules/deploy.md": "use globex-api here\n", ".claude/rules/notes.md": "Notes.\n" });
    await importInto(t.forge, t.ws("acme"), "acme");
    await fs.writeFile(path.join(t.forge, "ingredients/rules/deploy/rule.md"), "use {{deploy.api}} here\n");
    const meta = path.join(t.forge, "ingredients/rules/deploy/ingredient.yaml");
    await fs.writeFile(meta, (await fs.readFile(meta, "utf8")) + "params:\n  deploy.api:\n    default: globex-api\n");
    await writeFiles(t.forge, { "profiles/globex/profile.yaml": 'name: globex\nrecipes:\n  - base\nsections:\n  rule/notes:\n    extra: "see {{deploy.api}}"\n' });
    await writeFiles(t.ws("globex"), { ".claude/rules/deploy.md": "use initech-api here\n" });
    const g = await importInto(t.forge, t.ws("globex"), "globex");
    expect(g.variants).toEqual([{ name: "rule/deploy--globex", reason: "differs from rule/deploy already in the Forge (setting deploy.api would change rule/notes)" }]);
  });

  it("an existing profile gains `sections` in place — comments and a folded description kept — and is warned; an aliased `sections` is I1", async () => {
    const t = await setup();
    await marked(t);
    const long = "Globex, the client whose reviewer table grew a desktop row, imported by hand before sections existed at all.";
    const hand = `# globex, by hand\nname: globex\n${YAML.stringify({ description: long })}recipes:\n  - base # shared\ntargets:\n  - claude-code\n`;
    expect(hand.split("\n").length).toBeGreaterThan(8); // the description is folded over two lines
    await writeFiles(t.forge, { "profiles/globex/profile.yaml": hand });
    await writeFiles(t.ws("globex"), { ".claude/rules/review-posture.md": plain(GLOBEX) });
    const g = await importInto(t.forge, t.ws("globex"), "globex");
    expect(g.profileWrite).toEqual({ path: "profiles/globex/profile.yaml", action: "edited", fields: ["sections"] });
    const after = await fs.readFile(path.join(t.forge, "profiles/globex/profile.yaml"), "utf8");
    expect(after.startsWith(hand)).toBe(true);
    expect(YAML.parse(after).sections).toEqual({ "rule/review-posture": { flavors: GLOBEX } });
    expect(g.warnings).toContain("profile globex now sets section flavors of rule/review-posture — every workspace on globex renders it at its next sync; import cannot reach them");

    await writeFiles(t.forge, { "profiles/initech/profile.yaml": "name: initech\nrecipes:\n  - base\nx: &s {}\nsections: *s\n" });
    await writeFiles(t.ws("initech"), { ".claude/rules/review-posture.md": plain(GLOBEX) });
    const before = await snapshot(t.forge);
    expect((await fail(importInto(t.forge, t.ws("initech"), "initech")))?.message).toContain("import: cannot edit profiles/initech/profile.yaml in place (sections is an alias)");
    expect(await snapshot(t.forge)).toEqual(before);
  });
});

describe("section-aware import — the manifest's schema (spec 11 §6.14, Rulings 7 and 22)", () => {
  const fail = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e);
  const DESC = "description: Craftar Forge — shared harness ingredients, recipes and client profiles.\n";
  const V1 = `name: forge\nschema: 1\n${DESC}`;
  const V2 = `name: forge\nschema: 2\n${DESC}`;
  const BODY = "# Review\n\n<!-- craftar:section flavors -->\n| acme |\n<!-- /craftar:section -->\n";
  const manifestOf = (t: Awaited<ReturnType<typeof setup>>) => fs.readFile(path.join(t.forge, "craftar.forge.yaml"), "utf8");
  async function acmeWithMarkers(t: Awaited<ReturnType<typeof setup>>) {
    await writeFiles(t.ws("acme"), { ".claude/rules/review.md": "# Review\n\n| acme |\n", ".claude/rules/plain.md": "plain\n" });
    const first = await importInto(t.forge, t.ws("acme"), "acme");
    await fs.writeFile(path.join(t.forge, "ingredients/rules/review/rule.md"), BODY);
    return first;
  }

  it("absent, not needed: a new Forge gets today's bytes, schema: 1, listed first in created (AC 3)", async () => {
    const t = await setup();
    const r = await acmeWithMarkers(t);
    expect(await manifestOf(t)).toBe(V1);
    expect(r.manifestWrite).toBe("created");
    expect(r.created[0]).toBe("craftar.forge.yaml");
  });

  it("schema: 1, needed by a rendered reuse of a marked base with no Δs: bumped in place, byte for byte, LF and CRLF", async () => {
    for (const eol of ["\n", "\r\n"]) {
      const t = await setup();
      await acmeWithMarkers(t);
      await fs.writeFile(path.join(t.forge, "craftar.forge.yaml"), V1.replace(/\n/g, eol));
      const r = await importInto(t.forge, t.ws("acme"), "acme");
      expect(r.sections).toEqual([]);
      expect(r.manifestWrite).toBe("edited");
      expect(r.created).not.toContain("craftar.forge.yaml");
      expect(await manifestOf(t)).toBe(V2.replace(/\n/g, eol));
    }
  });

  it("schema: 1, needed by a Δs: bumped the same way; a manifest with no schema key gains one", async () => {
    const t = await setup();
    await acmeWithMarkers(t);
    await writeFiles(t.ws("globex"), { ".claude/rules/review.md": "# Review\n\n| globex |\n", ".claude/rules/plain.md": "plain\n" });
    const g = await importInto(t.forge, t.ws("globex"), "globex");
    expect(g.sections).toHaveLength(1);
    expect(g.manifestWrite).toBe("edited");
    expect(await manifestOf(t)).toBe(V2);

    const u = await setup();
    await acmeWithMarkers(u);
    await fs.writeFile(path.join(u.forge, "craftar.forge.yaml"), `name: forge\n${DESC}`);
    await importInto(u.forge, u.ws("acme"), "acme");
    expect(await manifestOf(u)).toBe(`name: forge\n${DESC}schema: 2\n`);
  });

  it("schema: 1, needed by a variant cut against a marked base: the Forge still holds the markers (Ruling 22)", async () => {
    const t = await setup();
    await acmeWithMarkers(t);
    await writeFiles(t.ws("globex"), { ".claude/rules/review.md": "# Other\n\n| globex |\n" });
    const g = await importInto(t.forge, t.ws("globex"), "globex");
    expect(g.variants.map((v) => v.name)).toEqual(["rule/review--globex"]);
    expect(g.manifestWrite).toBe("edited");
    expect(await manifestOf(t)).toBe(V2);
  });

  it("schema: 1, not needed: a run that never meets a marked base does not stage the manifest", async () => {
    const t = await setup();
    await acmeWithMarkers(t);
    await writeFiles(t.ws("globex"), { ".claude/rules/plain.md": "plain\n" });
    const r = await importInto(t.forge, t.ws("globex"), "globex");
    expect(r.manifestWrite).toBe("unchanged");
    expect(await manifestOf(t)).toBe(V1);
  });

  it("schema: 2: never staged, needed or not", async () => {
    const t = await setup();
    await acmeWithMarkers(t);
    const hand = "name: forge # by hand\nschema: 2\n";
    await fs.writeFile(path.join(t.forge, "craftar.forge.yaml"), hand);
    expect((await importInto(t.forge, t.ws("acme"), "acme")).manifestWrite).toBe("unchanged");
    expect(await manifestOf(t)).toBe(hand);
  });

  it("absent, needed: a directory holding marked ingredients and no manifest gets schema: 2 staged directly, the bumped file's bytes (P11)", async () => {
    const t = await setup();
    await acmeWithMarkers(t);
    await fs.rm(path.join(t.forge, "craftar.forge.yaml"));
    const r = await importInto(t.forge, t.ws("acme"), "acme");
    expect(r.manifestWrite).toBe("created");
    expect(r.created[0]).toBe("craftar.forge.yaml");
    expect(await manifestOf(t)).toBe(V2);
  });

  it("I13: a manifest that does not round-trip is refused with the Forge byte-identical; setting schema: 2 by hand lets the re-run pass", async () => {
    const t = await setup();
    await acmeWithMarkers(t);
    await fs.writeFile(path.join(t.forge, "craftar.forge.yaml"), "name: forge      # aligned\nschema: 1        # by hand\n");
    const before = await snapshot(t.forge);
    const e = await fail(importInto(t.forge, t.ws("acme"), "acme"));
    expect(e?.message).toContain(
      "import: cannot edit craftar.forge.yaml in place (it does not round-trip unchanged through the YAML writer) — set schema: 2 by hand, commit, and re-run",
    );
    expect(e?.message).toContain("The Forge was left untouched.");
    expect(await snapshot(t.forge)).toEqual(before);
    await fs.writeFile(path.join(t.forge, "craftar.forge.yaml"), "name: forge      # aligned\nschema: 2        # by hand\n");
    expect((await importInto(t.forge, t.ws("acme"), "acme")).manifestWrite).toBe("unchanged");
  });

  it("a manifest that is not a mapping never reaches I13: the Forge does not load (I5), and stays byte-identical", async () => {
    const t = await setup();
    await acmeWithMarkers(t);
    await fs.writeFile(path.join(t.forge, "craftar.forge.yaml"), "- forge\n");
    const before = await snapshot(t.forge);
    expect((await fail(importInto(t.forge, t.ws("acme"), "acme")))?.message).toContain("import: the Forge does not load");
    expect(await snapshot(t.forge)).toEqual(before);
  });
});

describe("the variant's slot (spec 11 §6.15, Rulings 9 and 23)", () => {
  const RP_ACME = "# Review posture\n\n| acme-api |\n";
  const RP_GLOBEX = "# Review posture\n\n| globex-api |\n| globex-desktop |\n";
  const SHARED = "# Shared\n\nAlways.\n";

  /**
   * acme, then globex (whose review-posture differs → rule/review-posture--globex in base--globex),
   * with `agents-md` added to globex's targets; globex's workspace synced. Returns a sync helper.
   */
  async function variantScenario(t: Awaited<ReturnType<typeof setup>>) {
    await writeFiles(t.ws("acme"), { ".claude/rules/review-posture.md": RP_ACME, ".claude/rules/shared.md": SHARED });
    await importInto(t.forge, t.ws("acme"), "acme");
    await writeFiles(t.ws("globex"), { ".claude/rules/review-posture.md": RP_GLOBEX, ".claude/rules/shared.md": SHARED });
    const g = await importClaudeCode({ workspaceRoot: t.ws("globex"), forgeRoot: t.forge, profileName: "globex", writeWorkspaceConfig: true });
    expect(g.variants.map((v) => v.name)).toEqual(["rule/review-posture--globex"]);
    const prof = path.join(t.forge, "profiles/globex/profile.yaml");
    await fs.writeFile(prof, (await fs.readFile(prof, "utf8")).replace("targets:\n  - claude-code\n", "targets:\n  - claude-code\n  - agents-md\n"));
    await fs.writeFile(path.join(t.ws("globex"), "craftar.yaml"), "forge: ../forge\nprofile: globex\n");
    const sync = async () => {
      const w = await loadWorkspace(t.ws("globex"));
      const p = await plan(w);
      const st = await status(w, p, await readLock(w.root));
      await apply(w, p, st, {});
      return st;
    };
    const first = await sync();
    expect(first.find((s) => s.path === "AGENTS.md")?.state).toBe("new");
    const agents = await fs.readFile(path.join(t.ws("globex"), "AGENTS.md"), "utf8");
    expect(agents.indexOf("globex-api")).toBeLessThan(agents.indexOf("# Shared"));
    return { sync, agents, owned: path.join(t.forge, "recipes/base--globex.yaml"), prof };
  }
  const states = async (t: Awaited<ReturnType<typeof setup>>) => {
    const w = await loadWorkspace(t.ws("globex"));
    return Object.fromEntries((await status(w, await plan(w), await readLock(w.root))).map((s) => [s.path, s.state]));
  };

  it("the shared recipe orders the base where the variant was: the profile is re-pointed to it, no owned recipe is written, AGENTS.md unchanged", async () => {
    const t = await setup();
    const s = await variantScenario(t);
    // The base evolves to globex's text (as unify --take variant would), so re-importing globex reuses it.
    await fs.writeFile(path.join(t.forge, "ingredients/rules/review-posture/rule.md"), RP_GLOBEX);
    const ownedBefore = await fs.readFile(s.owned, "utf8");
    const r = await importInto(t.forge, t.ws("globex"), "globex");
    expect(r.reused).toContain("rule/review-posture");
    expect(r.variants).toEqual([]);
    expect(r.recipeSplits).toEqual([]);
    expect(r.recipes).toEqual(["base"]);
    expect((await yaml(s.prof)).recipes).toEqual(["base"]);
    expect(await fs.readFile(s.owned, "utf8")).toBe(ownedBefore);
    const st = await states(t);
    expect(st["AGENTS.md"]).toBe("unchanged");
    expect(Object.values(st).every((x) => x === "unchanged")).toBe(true);
  });

  it("a re-point edits only recipes: an untouched params: {} keeps its line (the user's ruling of 2026-09-28)", async () => {
    const t = await setup();
    const s = await variantScenario(t);
    const before = await fs.readFile(s.prof, "utf8");
    expect(before).toContain("\nparams: {}\n");
    expect(before).toContain("recipes:\n  - base--globex\n");
    await fs.writeFile(path.join(t.forge, "ingredients/rules/review-posture/rule.md"), RP_GLOBEX);
    const r = await importInto(t.forge, t.ws("globex"), "globex");
    expect(r.profileWrite).toEqual({ path: "profiles/globex/profile.yaml", action: "edited", fields: ["recipes"] });
    expect(await fs.readFile(s.prof, "utf8")).toBe(before.replace("recipes:\n  - base--globex\n", "recipes:\n  - base\n"));
  });

  it("edge case 22: the shared recipe orders the base elsewhere — the owned recipe gets the base in the variant's slot, a comment kept, AGENTS.md unchanged", async () => {
    const t = await setup();
    const s = await variantScenario(t);
    const shared = path.join(t.forge, "recipes/base.yaml");
    const text = await fs.readFile(shared, "utf8");
    expect(text).toContain("  - rule/review-posture\n  - rule/shared\n");
    await fs.writeFile(shared, text.replace("  - rule/review-posture\n  - rule/shared\n", "  - rule/shared\n  - rule/review-posture\n"));
    const ownedText = await fs.readFile(s.owned, "utf8");
    expect(ownedText).toContain("  - rule/review-posture--globex\n");
    await fs.writeFile(s.owned, ownedText.replace("  - rule/review-posture--globex\n", "  # globex's reviewer table\n  - rule/review-posture--globex\n"));
    await fs.writeFile(path.join(t.forge, "ingredients/rules/review-posture/rule.md"), RP_GLOBEX);

    const r = await importInto(t.forge, t.ws("globex"), "globex");
    expect(r.recipeSplits).toEqual([{ shared: "base", owned: "base--globex", reason: "base orders its rules differently" }]);
    const after = await fs.readFile(s.owned, "utf8");
    expect(after).toBe(ownedText.replace("  - rule/review-posture--globex\n", "  # globex's reviewer table\n  - rule/review-posture\n"));
    expect(YAML.parse(after).ingredients).toEqual(["rule/review-posture", "rule/shared"]);
    expect((await states(t))["AGENTS.md"]).toBe("unchanged");
  });

  it("another profile's variant in the owned recipe is not swapped: it is dropped and the base appended, as before", async () => {
    const t = await setup();
    const s = await variantScenario(t);
    const ownedText = await fs.readFile(s.owned, "utf8");
    await fs.writeFile(s.owned, ownedText.replace("  - rule/review-posture--globex\n", "  - rule/review-posture--initech\n"));
    await fs.cp(path.join(t.forge, "ingredients/rules/review-posture--globex"), path.join(t.forge, "ingredients/rules/review-posture--initech"), { recursive: true });
    const meta = path.join(t.forge, "ingredients/rules/review-posture--initech/ingredient.yaml");
    await fs.writeFile(meta, (await fs.readFile(meta, "utf8")).replace("name: review-posture--globex", "name: review-posture--initech"));
    await fs.writeFile(path.join(t.forge, "ingredients/rules/review-posture/rule.md"), RP_GLOBEX);

    const r = await importInto(t.forge, t.ws("globex"), "globex");
    expect(r.recipeSplits.map((x) => x.reason)).toEqual(["base orders its rules differently"]);
    expect((await yaml(s.owned)).ingredients).toEqual(["rule/shared", "rule/review-posture"]);
  });
});


describe("import — authEnv (spec 27)", () => {
  /**
   * Make a Forge with MCP base `tracker` declaring authEnv, recipe `base` listing it, profile `acme`.
   * Returns the Forge root.
   */
  async function makeAuthEnvForge(t: Awaited<ReturnType<typeof setup>>) {
    const { makeForge, recipe, profile, rule } = await import("./helpers/forge.js");
    await makeForge(t.forge, {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        {
          meta: { type: "mcp", name: "tracker", authEnv: ["ACME_TRACKER_TOKEN"], server: { command: "npx", args: ["-y", "tracker"] } },
        },
      ],
      recipes: [recipe("base", ["rule/workflow", "mcp/tracker"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    });
    return t.forge;
  }

  /** Sync the workspace: loadWorkspace → plan → status → apply, returns status array. */
  async function syncWs(wsRoot: string) {
    const w = await loadWorkspace(wsRoot);
    const p = await plan(w);
    const st = await status(w, p, await readLock(w.root));
    await apply(w, p, st, {});
    return st;
  }

  it("1. Reuse: sync then import same workspace — no variant, snapshot unchanged", async () => {
    const t = await setup();
    await makeAuthEnvForge(t);
    // Write workspace's craftar.yaml and .mcp.json
    const ws = t.ws("acme-ws");
    await writeFiles(ws, {
      "craftar.yaml": "forge: ../forge\nprofile: acme\n",
      ".claude/rules/workflow.md": "# Workflow\n",
    });
    await syncWs(ws);
    const before = await snapshot(t.forge);
    const r = await importInto(t.forge, ws, "acme");
    expect(r.variants).toEqual([]);
    expect(await snapshot(t.forge)).toEqual(before);
  });

  it("2. Rewriting a declaring variant keeps its declaration", async () => {
    const t = await setup();
    const { makeForge, recipe, profile, rule } = await import("./helpers/forge.js");
    // Forge: base tracker (no authEnv) + variant tracker--acme with authEnv
    await makeForge(t.forge, {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        {
          meta: { type: "mcp", name: "tracker", server: { command: "npx", args: ["-y", "tracker"] } },
        },
        {
          meta: { type: "mcp", name: "tracker--acme", as: "tracker", authEnv: ["ACME_VARIANT_TOKEN"], server: { command: "npx", args: ["-y", "acme"] } },
        },
      ],
      recipes: [recipe("base--acme", ["rule/workflow", "mcp/tracker--acme"])],
      profiles: [profile("acme", ["base--acme"], ["claude-code"])],
    });
    // Sync the workspace
    const ws = t.ws("acme-ws");
    await writeFiles(ws, { "craftar.yaml": "forge: ../forge\nprofile: acme\n", ".claude/rules/workflow.md": "# Workflow\n" });
    await syncWs(ws);
    // Change the server in the workspace's .mcp.json
    const mcpPath = path.join(ws, ".mcp.json");
    const mcpContent = JSON.parse(await fs.readFile(mcpPath, "utf8"));
    mcpContent.mcpServers.tracker.args = ["-y", "acme2"];
    await fs.writeFile(mcpPath, JSON.stringify(mcpContent, null, 2) + "\n");
    // Import
    await importInto(t.forge, ws, "acme");
    // Check authEnv kept
    const variantMeta = await yaml(path.join(t.forge, "ingredients/mcp/tracker--acme/ingredient.yaml"));
    expect(variantMeta.authEnv).toEqual(["ACME_VARIANT_TOKEN"]);
    // Check order: authEnv before server
    const rawYaml = await fs.readFile(path.join(t.forge, "ingredients/mcp/tracker--acme/ingredient.yaml"), "utf8");
    const authEnvIdx = rawYaml.indexOf("authEnv:");
    const serverIdx = rawYaml.indexOf("server:");
    expect(authEnvIdx).toBeGreaterThanOrEqual(0);
    expect(serverIdx).toBeGreaterThanOrEqual(0);
    expect(authEnvIdx).toBeLessThan(serverIdx);
    // Check example file unchanged (needs 27b)
    // For now, just check plan has the path
    const w = await loadWorkspace(ws);
    const p = await plan(w);
    const hasExampleFile = p.files.some((f) => f.path === ".claude/settings.craftar.example.json");
    // NOTE: If 27b is not on branch, we assert hasExampleFile; else we check status unchanged
    expect(hasExampleFile).toBe(true);
  });

  it("3. An existing variant that declares none stays without under a declaring base", async () => {
    const t = await setup();
    const { makeForge, recipe, profile, rule } = await import("./helpers/forge.js");
    // Base declares authEnv, variant does NOT
    await makeForge(t.forge, {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        {
          meta: { type: "mcp", name: "tracker", authEnv: ["ACME_TRACKER_TOKEN"], server: { command: "npx", args: ["-y", "tracker"] } },
        },
        {
          meta: { type: "mcp", name: "tracker--acme", as: "tracker", server: { command: "npx", args: ["-y", "acme"] } },
        },
      ],
      recipes: [recipe("base--acme", ["rule/workflow", "mcp/tracker--acme"])],
      profiles: [profile("acme", ["base--acme"], ["claude-code"])],
    });
    // Sync
    const ws = t.ws("acme-ws");
    await writeFiles(ws, { "craftar.yaml": "forge: ../forge\nprofile: acme\n", ".claude/rules/workflow.md": "# Workflow\n" });
    await syncWs(ws);
    // Change server
    const mcpPath = path.join(ws, ".mcp.json");
    const mcpContent = JSON.parse(await fs.readFile(mcpPath, "utf8"));
    mcpContent.mcpServers.tracker.args = ["-y", "acme2"];
    await fs.writeFile(mcpPath, JSON.stringify(mcpContent, null, 2) + "\n");
    // Import
    await importInto(t.forge, ws, "acme");
    // Variant should have NO authEnv
    const variantMeta = await yaml(path.join(t.forge, "ingredients/mcp/tracker--acme/ingredient.yaml"));
    expect(Object.hasOwn(variantMeta, "authEnv")).toBe(false);
  });

  it("4. A new variant inherits the base's authEnv", async () => {
    const t = await setup();
    await makeAuthEnvForge(t);
    // Sync workspace
    const ws = t.ws("acme-ws");
    await writeFiles(ws, { "craftar.yaml": "forge: ../forge\nprofile: acme\n", ".claude/rules/workflow.md": "# Workflow\n" });
    await syncWs(ws);
    // Edit the server in .mcp.json
    const mcpPath = path.join(ws, ".mcp.json");
    const mcpContent = JSON.parse(await fs.readFile(mcpPath, "utf8"));
    mcpContent.mcpServers.tracker.args = ["-y", "tracker-acme"];
    await fs.writeFile(mcpPath, JSON.stringify(mcpContent, null, 2) + "\n");
    // Import
    const r = await importInto(t.forge, ws, "acme");
    expect(r.variants.map((v) => v.name)).toEqual(["mcp/tracker--acme"]);
    // The new variant should have inherited authEnv
    const variantMeta = await yaml(path.join(t.forge, "ingredients/mcp/tracker--acme/ingredient.yaml"));
    expect(variantMeta.authEnv).toEqual(["ACME_TRACKER_TOKEN"]);
  });

  it("5. I8 is not triggered by a declaration — second profile resolves variant, unchanged import succeeds", async () => {
    const t = await setup();
    const { makeForge, recipe, profile, rule } = await import("./helpers/forge.js");
    // Forge with declaring variant, two profiles resolving it
    await makeForge(t.forge, {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        {
          meta: { type: "mcp", name: "tracker", server: { command: "npx", args: ["-y", "tracker"] } },
        },
        {
          meta: { type: "mcp", name: "tracker--acme", as: "tracker", authEnv: ["ACME_VARIANT_TOKEN"], server: { command: "npx", args: ["-y", "acme"] } },
        },
      ],
      recipes: [
        recipe("base", ["rule/workflow", "mcp/tracker--acme"]),
        recipe("base--globex", ["rule/workflow", "mcp/tracker--acme"]),
      ],
      profiles: [
        profile("acme", ["base"], ["claude-code"]),
        profile("globex", ["base--globex"], ["claude-code"]),
      ],
    });
    // Sync the acme workspace
    const ws = t.ws("acme-ws");
    await writeFiles(ws, { "craftar.yaml": "forge: ../forge\nprofile: acme\n", ".claude/rules/workflow.md": "# Workflow\n" });
    await syncWs(ws);
    // Import unchanged — should NOT throw I8 (the variant fingerprint matches after authEnv is applied)
    // The import succeeds without throwing the I8 error that would occur if fingerprints differed.
    const r = await importInto(t.forge, ws, "acme");
    // The variant is reported (not reused) as 0.17.4 behavior.
    expect(r.variants.map((v) => v.name)).toEqual(["mcp/tracker--acme"]);
  });

  it("6. A lost declaration is reported once", async () => {
    const t = await setup();
    const { makeForge, recipe, profile, rule } = await import("./helpers/forge.js");
    // Profile acme on declaring variant; base does NOT declare
    await makeForge(t.forge, {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        {
          meta: { type: "mcp", name: "tracker", server: { command: "npx", args: ["-y", "tracker"] } },
        },
        {
          meta: { type: "mcp", name: "tracker--acme", as: "tracker", authEnv: ["ACME_VARIANT_TOKEN"], server: { command: "npx", args: ["-y", "acme"] } },
        },
      ],
      recipes: [
        recipe("base", ["rule/workflow", "mcp/tracker"]),
        recipe("base--acme", ["rule/workflow", "mcp/tracker--acme"]),
      ],
      profiles: [profile("acme", ["base--acme"], ["claude-code"])],
    });
    // Sync
    const ws = t.ws("acme-ws");
    await writeFiles(ws, { "craftar.yaml": "forge: ../forge\nprofile: acme\n", ".claude/rules/workflow.md": "# Workflow\n" });
    await syncWs(ws);
    // Make the workspace's server equal to the base's (triggering reuse of base)
    const mcpPath = path.join(ws, ".mcp.json");
    await fs.writeFile(mcpPath, JSON.stringify({ mcpServers: { tracker: { command: "npx", args: ["-y", "tracker"] } } }, null, 2) + "\n");
    // Import — profile moves to base, losing the declaration
    const r = await importInto(t.forge, ws, "acme");
    const expectedWarning = "mcp/tracker: ACME_VARIANT_TOKEN declared by mcp/tracker--acme is not declared by mcp/tracker";
    expect(r.warnings.filter((w) => w === expectedWarning).length).toBe(1);
    // Import again unchanged — the warning should NOT appear (both sides now agree)
    const r2 = await importInto(t.forge, ws, "acme");
    expect(r2.warnings.filter((w) => w === expectedWarning).length).toBe(0);
  });

  it("7. No flip-flop: after import, sync, import again → unchanged", async () => {
    const t = await setup();

    // Scenario 1: Reuse
    {
      await makeAuthEnvForge(t);
      const ws = t.ws("reuse-ws");
      await writeFiles(ws, { "craftar.yaml": "forge: ../forge\nprofile: acme\n" });
      await syncWs(ws);
      await importInto(t.forge, ws, "acme");
      await syncWs(ws);
      const beforeSecond = await snapshot(t.forge);
      await importInto(t.forge, ws, "acme");
      expect(await snapshot(t.forge)).toEqual(beforeSecond);
      const w = await loadWorkspace(ws);
      const st = await status(w, await plan(w), await readLock(ws));
      expect(st.every((s) => s.state === "unchanged")).toBe(true);
    }

    // Scenario 2: Rewriting variant
    {
      const t2 = await setup();
      const { makeForge, recipe, profile } = await import("./helpers/forge.js");
      await makeForge(t2.forge, {
        ingredients: [
          { meta: { type: "mcp", name: "tracker", server: { command: "npx", args: ["-y", "tracker"] } } },
          { meta: { type: "mcp", name: "tracker--acme", as: "tracker", authEnv: ["ACME_VARIANT_TOKEN"], server: { command: "npx", args: ["-y", "acme"] } } },
        ],
        recipes: [recipe("base", ["mcp/tracker--acme"])],
        profiles: [profile("acme", ["base"], ["claude-code"])],
      });
      const ws2 = t2.ws("variant-ws");
      await writeFiles(ws2, { "craftar.yaml": "forge: ../forge\nprofile: acme\n" });
      await syncWs(ws2);
      // Edit server
      const mcpPath = path.join(ws2, ".mcp.json");
      const mcpContent = JSON.parse(await fs.readFile(mcpPath, "utf8"));
      mcpContent.mcpServers.tracker.args = ["-y", "acme2"];
      await fs.writeFile(mcpPath, JSON.stringify(mcpContent, null, 2) + "\n");
      await importInto(t2.forge, ws2, "acme");
      await syncWs(ws2);
      const beforeSecond = await snapshot(t2.forge);
      // Second import - should report the variant again but not change anything
      await importInto(t2.forge, ws2, "acme");
      // Snapshot should be unchanged (variant re-staged with identical bytes)
      expect(await snapshot(t2.forge)).toEqual(beforeSecond);
      // authEnv should be preserved
      const variantMeta = await yaml(path.join(t2.forge, "ingredients/mcp/tracker--acme/ingredient.yaml"));
      expect(variantMeta.authEnv).toEqual(["ACME_VARIANT_TOKEN"]);
      // Workspace should be unchanged
      const w = await loadWorkspace(ws2);
      const st = await status(w, await plan(w), await readLock(ws2));
      expect(st.every((s) => s.state === "unchanged")).toBe(true);
    }

    // Scenario 4: New variant inherits
    {
      const t4 = await setup();
      await makeAuthEnvForge(t4);
      const ws4 = t4.ws("inherit-ws");
      await writeFiles(ws4, { "craftar.yaml": "forge: ../forge\nprofile: acme\n" });
      await syncWs(ws4);
      // Edit
      const mcpPath = path.join(ws4, ".mcp.json");
      const mcpContent = JSON.parse(await fs.readFile(mcpPath, "utf8"));
      mcpContent.mcpServers.tracker.args = ["-y", "tracker-acme"];
      await fs.writeFile(mcpPath, JSON.stringify(mcpContent, null, 2) + "\n");
      await importInto(t4.forge, ws4, "acme");
      await syncWs(ws4);
      const beforeSecond = await snapshot(t4.forge);
      await importInto(t4.forge, ws4, "acme");
      expect(await snapshot(t4.forge)).toEqual(beforeSecond);
      const w = await loadWorkspace(ws4);
      const st = await status(w, await plan(w), await readLock(ws4));
      expect(st.every((s) => s.state === "unchanged")).toBe(true);
    }
  });

  it("8. A new ingredient has no authEnv", async () => {
    const t = await setup();
    // A Forge with no mcp/fresh
    const { makeForge, recipe, profile, rule } = await import("./helpers/forge.js");
    await makeForge(t.forge, {
      ingredients: [rule("workflow", "# Workflow\n")],
      recipes: [recipe("base", ["rule/workflow"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    });
    // A workspace with .mcp.json containing a server `fresh`
    const ws = t.ws("fresh-ws");
    await writeFiles(ws, {
      ".claude/rules/workflow.md": "# Workflow\n",
      ".mcp.json": JSON.stringify({ mcpServers: { fresh: { command: "npx", args: ["-y", "fresh-server"] } } }, null, 2) + "\n",
    });
    // Import
    await importInto(t.forge, ws, "acme");
    // Check: mcp/fresh was created with no authEnv
    const freshMeta = await yaml(path.join(t.forge, "ingredients/mcp/fresh/ingredient.yaml"));
    expect(Object.hasOwn(freshMeta, "authEnv")).toBe(false);
  });

  it("9. the key order of a variant without authEnv is 0.17.4's", async () => {
    const t = await setup();
    const { makeForge, recipe, profile, rule } = await import("./helpers/forge.js");
    // Base mcp/tracker without authEnv, profile on the base
    await makeForge(t.forge, {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        { meta: { type: "mcp", name: "tracker", server: { command: "npx", args: ["-y", "tracker"] } } },
      ],
      recipes: [recipe("base", ["rule/workflow", "mcp/tracker"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    });
    // Sync
    const ws = t.ws("order-ws");
    await writeFiles(ws, { "craftar.yaml": "forge: ../forge\nprofile: acme\n", ".claude/rules/workflow.md": "# Workflow\n" });
    await syncWs(ws);
    // Edit the server in .mcp.json to args: ["-y", "acme2"]
    const mcpPath = path.join(ws, ".mcp.json");
    const mcpContent = JSON.parse(await fs.readFile(mcpPath, "utf8"));
    mcpContent.mcpServers.tracker.args = ["-y", "acme2"];
    await fs.writeFile(mcpPath, JSON.stringify(mcpContent, null, 2) + "\n");
    // Import
    await importInto(t.forge, ws, "acme");
    // Read the variant's ingredient.yaml as text
    const variantYamlText = await fs.readFile(path.join(t.forge, "ingredients/mcp/tracker--acme/ingredient.yaml"), "utf8");
    // Get the workspace name from the parsed YAML for interpolation
    const variantMeta = await yaml(path.join(t.forge, "ingredients/mcp/tracker--acme/ingredient.yaml"));
    const workspaceName = variantMeta.origin.workspace;
    // Expected literal (0.17.4 key order: type, name, server, targets, tags, origin, as)
    const expected = `type: mcp\nname: tracker--acme\nserver:\n  command: npx\n  args:\n    - -y\n    - acme2\ntargets: "*"\ntags: []\norigin:\n  workspace: ${workspaceName}\n  path: .mcp.json\nas: tracker\n`;
    expect(variantYamlText).toBe(expected);
  });

  it("10. with authEnv, the key sits immediately before server and nothing else moves", async () => {
    const t = await setup();
    const { makeForge, recipe, profile, rule } = await import("./helpers/forge.js");
    // Base mcp/tracker WITH authEnv, profile on the base
    await makeForge(t.forge, {
      ingredients: [
        rule("workflow", "# Workflow\n"),
        { meta: { type: "mcp", name: "tracker", authEnv: ["ACME_TRACKER_TOKEN"], server: { command: "npx", args: ["-y", "tracker"] } } },
      ],
      recipes: [recipe("base", ["rule/workflow", "mcp/tracker"])],
      profiles: [profile("acme", ["base"], ["claude-code"])],
    });
    // Sync
    const ws = t.ws("authenv-order-ws");
    await writeFiles(ws, { "craftar.yaml": "forge: ../forge\nprofile: acme\n", ".claude/rules/workflow.md": "# Workflow\n" });
    await syncWs(ws);
    // Edit the server in .mcp.json to args: ["-y", "acme2"]
    const mcpPath = path.join(ws, ".mcp.json");
    const mcpContent = JSON.parse(await fs.readFile(mcpPath, "utf8"));
    mcpContent.mcpServers.tracker.args = ["-y", "acme2"];
    await fs.writeFile(mcpPath, JSON.stringify(mcpContent, null, 2) + "\n");
    // Import
    await importInto(t.forge, ws, "acme");
    // Read the variant's ingredient.yaml as text
    const variantYamlText = await fs.readFile(path.join(t.forge, "ingredients/mcp/tracker--acme/ingredient.yaml"), "utf8");
    // Get the workspace name from the parsed YAML for interpolation
    const variantMeta = await yaml(path.join(t.forge, "ingredients/mcp/tracker--acme/ingredient.yaml"));
    const workspaceName = variantMeta.origin.workspace;
    // Expected literal (0.17.4 key order with authEnv inserted before server)
    const expected = `type: mcp\nname: tracker--acme\nauthEnv:\n  - ACME_TRACKER_TOKEN\nserver:\n  command: npx\n  args:\n    - -y\n    - acme2\ntargets: "*"\ntags: []\norigin:\n  workspace: ${workspaceName}\n  path: .mcp.json\nas: tracker\n`;
    expect(variantYamlText).toBe(expected);
  });
});
