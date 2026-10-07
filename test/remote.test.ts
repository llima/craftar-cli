import { describe, expect, it } from "vitest";
import { cacheKey, classifyForge, credentialFault, parseLsRemote, resolveRef } from "../src/core/remote.js";

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

const A = "a".repeat(40), B = "b".repeat(40), T = "c".repeat(40), P = "d".repeat(40), V = "e".repeat(40);
const LS = [
  "ref: refs/heads/main\tHEAD",
  `${A}\tHEAD`,
  `${A}\trefs/heads/main`,
  `${B}\trefs/heads/v1`,
  `${V}\trefs/tags/v1`,
  `${T}\trefs/tags/v2`,
  `${P}\trefs/tags/v2^{}`,
  "",
].join("\n");
const URL1 = "file:///tmp/acme-forge.git";

describe("resolving a ref (spec 13 §6.2)", () => {
  const refs = parseLsRemote(LS);
  it("no ref → the remote's default branch", () => expect(resolveRef(refs, null, URL1)).toEqual({ commit: A, defaultBranch: "main" }));
  it("a branch", () => expect(resolveRef(refs, "main", URL1)).toEqual({ commit: A, defaultBranch: null }));
  it("an annotated tag is peeled", () => expect(resolveRef(refs, "v2", URL1)).toEqual({ commit: P, defaultBranch: null }));
  it("qualified forms", () => {
    expect(resolveRef(refs, "refs/heads/v1", URL1)).toEqual({ commit: B, defaultBranch: null });
    expect(resolveRef(refs, "refs/tags/v1", URL1)).toEqual({ commit: V, defaultBranch: null });
  });
  it("a full SHA", () => expect(resolveRef(refs, B, URL1)).toEqual({ commit: B, defaultBranch: null }));
  it("a name that is both a branch and a tag", () =>
    expect(() => resolveRef(refs, "v1", URL1)).toThrow(`ref "v1" is both a branch and a tag in ${URL1} — write refs/heads/v1 or refs/tags/v1`));
  it("an abbreviated SHA and an unknown name", () => {
    expect(() => resolveRef(refs, "aaaaaaa", URL1)).toThrow(`ref "aaaaaaa" not found in ${URL1}`);
    expect(() => resolveRef(refs, "nope", URL1)).toThrow(`ref "nope" not found in ${URL1}`);
  });
});
