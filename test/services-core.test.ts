/**
 * Unit tests for src/core/services.ts core functions.
 * Tests for parseFragment (direct unit tests for each refusal reason).
 */
import { describe, it, expect } from "vitest";
import { parseFragment } from "../src/core/services.js";

describe("parseFragment", () => {
  it("parses a valid fragment", () => {
    const result = parseFragment("services:\n  echo:\n    image: alpine\n");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fragment.services).toEqual({ echo: { image: "alpine" } });
    }
  });

  it("refuses invalid YAML", () => {
    const result = parseFragment("services: [unterminated");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not valid YAML after rendering/);
    }
  });

  it("refuses when not a mapping (null)", () => {
    const result = parseFragment("null\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("a fragment must be a YAML mapping");
    }
  });

  it("refuses when not a mapping (array)", () => {
    const result = parseFragment("[]\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("a fragment must be a YAML mapping");
    }
  });

  it("refuses when not a mapping (scalar)", () => {
    const result = parseFragment("hello\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("a fragment must be a YAML mapping");
    }
  });

  it("refuses top-level name", () => {
    const result = parseFragment("name: myproject\nservices:\n  x:\n    image: x\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("a fragment must not declare a top-level name — the project name is craftar's");
    }
  });

  it("refuses include", () => {
    const result = parseFragment("include: []\nservices:\n  x:\n    image: x\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("a fragment must not declare include — every file of the stack is in craftar.lock");
    }
  });

  it("refuses __proto__ key in services", () => {
    // Use JSON.parse to create a real __proto__ key in the object, then convert to YAML
    // For YAML parsing, __proto__ in services map should be refused
    const result = parseFragment("services:\n  __proto__:\n    image: x\n  echo:\n    image: y\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("a __proto__ key is not allowed");
    }
  });

  it("refuses __proto__ key in volumes", () => {
    const result = parseFragment("services:\n  x:\n    image: x\nvolumes:\n  __proto__: {}\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("a __proto__ key is not allowed");
    }
  });

  it("refuses volumes: [] (must be a mapping)", () => {
    const result = parseFragment("services:\n  x:\n    image: x\nvolumes: []\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("volumes must be a mapping");
    }
  });

  it("refuses networks: [] (must be a mapping)", () => {
    const result = parseFragment("services:\n  x:\n    image: x\nnetworks: []\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("networks must be a mapping");
    }
  });

  it("refuses empty services", () => {
    const result = parseFragment("services: {}\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("a fragment must declare at least one service");
    }
  });

  it("refuses no services key", () => {
    const result = parseFragment("volumes:\n  data: {}\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("a fragment must declare at least one service");
    }
  });

  it("passes through unknown keys (version, x-*, etc.)", () => {
    const result = parseFragment("version: '3.8'\nx-foo: bar\nservices:\n  echo:\n    image: alpine\n");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing passthrough
      expect((result.fragment as any).version).toBe("3.8");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing passthrough
      expect((result.fragment as any)["x-foo"]).toBe("bar");
    }
  });
});
