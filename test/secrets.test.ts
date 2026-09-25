import { describe, expect, it } from "vitest";
import { findSecrets, looksLikeSecretValue, secretValueKind, shannonEntropy } from "../src/core/secrets.js";

// Token-shaped values are assembled at runtime so no scanner ever sees a literal token in this file.
const fake = {
  github: "ghp_" + "x".repeat(36),
  githubPat: "github_pat_" + "A1".repeat(20),
  aws: "AKIA" + "ABCDEFGHIJKLMNOP",
  slack: "xoxb-" + "1234567890-abcdef",
  apiKey: "sk-ant-" + "a1B2".repeat(10),
  pem: "-----BEGIN " + "RSA PRIVATE KEY-----",
  azure: "a1b2c3d4".repeat(6) + "a1b2",
  azure84: "Ab1".repeat(25) + "c" + "AZDO" + "x9Y8",
};

describe("findSecrets", () => {
  it.each([
    ["github-token", fake.github],
    ["github-token", fake.githubPat],
    ["aws-access-key", fake.aws],
    ["slack-token", fake.slack],
    ["api-key", fake.apiKey],
    ["private-key", fake.pem],
    ["azure-devops-pat", fake.azure],
    ["azure-devops-pat", fake.azure84],
  ])("detects %s", (kind, value) => {
    expect(findSecrets(`# Title\n\nvalue: ${value}\n`)).toEqual([{ kind, line: 3 }]);
  });

  it("ignores SHAs, hashes and URLs quoted in markdown", () => {
    const text = [
      "commit 9f2c1e7a3b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f",
      "hash sha256:" + "ab".repeat(32),
      "see https://github.com/llima/craftar-cli",
      "tokens are referenced as ${GITHUB_TOKEN}",
    ].join("\n");
    expect(findSecrets(text)).toEqual([]);
  });
});

describe("azure-devops-pat precision", () => {
  it("has the lengths the patterns expect", () => {
    expect(fake.azure).toHaveLength(52);
    expect(fake.azure84).toHaveLength(84);
    expect(fake.azure84.indexOf("AZDO")).toBe(76);
  });

  it("does not flag a 52-char lowercase run with no digit", () => {
    expect(findSecrets(`value: ${"abcd".repeat(13)}\n`)).toEqual([]);
  });

  it("does not flag a 52-char token embedded in a snake_case identifier", () => {
    expect(findSecrets(`word_${fake.azure}_suffix\n`)).toEqual([]);
    expect(findSecrets(`word_${fake.azure84}_suffix\n`)).toEqual([]);
  });

  it("does not flag an 84-char run without the AZDO signature", () => {
    expect(findSecrets(`value: ${"Ab1".repeat(28)}\n`)).toEqual([]);
  });
});

describe("secret values (MCP env / args)", () => {
  it("computes Shannon entropy per character", () => {
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy("abcd")).toBe(2);
  });

  it.each(["${GITHUB_TOKEN}", "production", "@playwright/mcp@0.0.80", "https://mcp.example.com/sse", "1600x900", "--browser"])("accepts %s", (v) => {
    expect(looksLikeSecretValue(v)).toBe(false);
    expect(secretValueKind(v)).toBeNull();
  });

  it("flags a long random token by entropy", () => {
    expect(secretValueKind("Xk9f2LmQ7pR4tZ8wB3nV")).toBe("high-entropy-value");
  });

  it("prefers the pattern kind when one matches", () => {
    expect(secretValueKind(fake.github)).toBe("github-token");
  });
});
