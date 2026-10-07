import { describe, expect, it } from "vitest";
import { cacheKey, classifyForge, credentialFault } from "../src/core/remote.js";

describe("what counts as a URL (spec 13 §6.1)", () => {
  it("URLs", () => {
    for (const v of ["https://example.com/acme/forge.git", "ssh://git@example.com/acme/forge.git", "git://example.com/forge", "file:///tmp/forge.git", "git@example.com:acme/forge.git", "deploy@example.com:acme/forge"])
      expect(classifyForge(v), v).toBe("url");
  });
  it("paths", () => {
    for (const v of ["../forge", "C:/forge", "C:\\forge", "host:p", "forge", "/abs/forge"]) expect(classifyForge(v), v).toBe("path");
  });
});

describe("credentials (spec 13 §4.3, §6.1)", () => {
  it("refused", () => {
    for (const v of ["https://u@example.com/p", "https://u:p@example.com/p", "https://ghp_TOKEN@example.com/p", "http://u:p@example.com/p", "ssh://u:p@example.com/p", "u:p@host:path"])
      expect(credentialFault(v), v).toBe(true);
  });
  it("accepted", () => {
    for (const v of ["ssh://git@example.com/p", "git@example.com:p", "https://example.com/acme/forge.git", "file:///tmp/forge.git", "../forge"])
      expect(credentialFault(v), v).toBe(false);
  });
});

describe("the cache key (spec 13 §6.3)", () => {
  it("is stable across a trailing slash, .git, and scheme/host case", () => {
    const k = cacheKey("https://example.com/acme/forge");
    expect(cacheKey("https://example.com/acme/forge/")).toBe(k);
    expect(cacheKey("https://example.com/acme/forge.git")).toBe(k);
    expect(cacheKey("HTTPS://Example.COM/acme/forge")).toBe(k);
    expect(cacheKey("https://example.com/acme/other")).not.toBe(k);
    expect(k).toMatch(/^example\.com-acme-forge-[0-9a-f]{12}$/);
  });
});
