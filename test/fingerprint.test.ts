import { describe, expect, it } from "vitest";
import { fingerprintOf } from "../src/core/fingerprint.js";

const base = { type: "rule", name: "workflow", targets: "*" };

describe("fingerprintOf", () => {
  it("ignores name, as and origin — a variant of identical content matches its base", () => {
    const a = fingerprintOf({ ...base }, { "rule.md": "body\n" });
    const b = fingerprintOf(
      { ...base, name: "workflow--acme", as: "workflow", origin: { workspace: "w", path: "p" } },
      { "rule.md": "body\n" },
    );
    expect(b).toBe(a);
  });

  it("treats a metadata difference as a difference", () => {
    const a = fingerprintOf({ ...base }, { "rule.md": "body\n" });
    const b = fingerprintOf({ ...base, targets: ["kiro"] }, { "rule.md": "body\n" });
    expect(b).not.toBe(a);
  });

  it("normalizes line endings and the BOM in file content", () => {
    const a = fingerprintOf({ ...base }, { "rule.md": "one\ntwo\n" });
    const b = fingerprintOf({ ...base }, { "rule.md": "﻿one\r\ntwo\r\n" });
    expect(b).toBe(a);
  });

  it("depends on the file name, not only on its content", () => {
    const a = fingerprintOf({ ...base }, { "rule.md": "body\n" });
    const b = fingerprintOf({ ...base }, { "other.md": "body\n" });
    expect(b).not.toBe(a);
  });
});

describe("fingerprintOf — nested metadata", () => {
  const mcp = (server: Record<string, unknown>) => ({ type: "mcp", name: "srv", server });
  const files = { "mcp.json": "{}\n" };

  it("tells apart two MCP servers that differ only inside `server`", () => {
    const a = fingerprintOf(mcp({ command: "npx", args: ["public-server"] }), files);
    const b = fingerprintOf(mcp({ command: "npx", args: ["acme-server"] }), files);
    expect(b).not.toBe(a);
  });

  it("tells apart a difference two levels down, in server.env", () => {
    const a = fingerprintOf(mcp({ command: "npx", env: { TOKEN_VAR: "PUBLIC_TOKEN" } }), files);
    const b = fingerprintOf(mcp({ command: "npx", env: { TOKEN_VAR: "ACME_TOKEN" } }), files);
    expect(b).not.toBe(a);
  });

  it("ignores key order at every depth", () => {
    const a = fingerprintOf({ type: "mcp", name: "srv", server: { command: "npx", env: { A: "1", B: "2" } } }, files);
    const b = fingerprintOf({ server: { env: { B: "2", A: "1" }, command: "npx" }, name: "srv", type: "mcp" }, files);
    expect(b).toBe(a);
  });

  it("keeps array order significant", () => {
    const a = fingerprintOf(mcp({ command: "npx", args: ["x", "y"] }), files);
    const b = fingerprintOf(mcp({ command: "npx", args: ["y", "x"] }), files);
    expect(b).not.toBe(a);
  });

  it("leaves the fingerprint of flat metadata exactly where it was", () => {
    // Pinned from the previous algorithm at d488702. For metadata without nested objects the fix
    // must not move a single hash: saved unify plans and import's reuse decisions depend on it.
    const body = { "rule.md": "body\n" };
    expect(fingerprintOf({ type: "rule", name: "workflow", targets: "*" }, body)).toBe(
      "sha256:341317a494f49ec5e0c5ac12e5db1fe8a6636a6daf6954dd7aeebdd9c7aef1e1",
    );
    const flat = { type: "rule", name: "workflow", inclusion: "always", targets: ["kiro", "claude-code"], description: undefined };
    expect(fingerprintOf(flat, body)).toBe("sha256:0926dd41158b87f1291c922101bd040fd52c8b1b497c8ae3a624195b39c64e22");
  });
});
