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
