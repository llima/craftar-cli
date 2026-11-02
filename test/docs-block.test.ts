import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { declaredDocs } from "../src/core/docs-validate.js";
import { listFiles } from "../src/core/forge.js";
import { ProfileSchema } from "../src/schema/index.js";

// Spec 47 §5 — the docs block: kept unvalidated at load, read by declaredDocs alone, refused in one line with no value.

const TOKEN = "ghp_" + "x".repeat(36);
const M = ["ZZ", "MARKER", "ZZ"].join("");

const refusal = (docs: unknown): string => {
  try {
    declaredDocs({ docs });
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("declaredDocs — what reads (spec 47 §5.1)", () => {
  it("absent and null declare nothing", () => {
    expect(declaredDocs({})).toBeNull();
    expect(declaredDocs({ docs: null })).toBeNull();
  });

  it("a full block reads with its defaults filled in", () => {
    expect(
      declaredDocs({
        docs: {
          categories: [{ path: "architecture", frontmatter: ["title", "date"] }, { path: "tech-debt", name: "dated" }, { path: "specs/acme" }],
          uncovered: "error",
          related: "symmetric",
        },
      }),
    ).toEqual({
      categories: [
        { path: "architecture", frontmatter: ["title", "date"], name: "any" },
        { path: "tech-debt", frontmatter: [], name: "dated" },
        { path: "specs/acme", frontmatter: [], name: "any" },
      ],
      uncovered: "error",
      related: "symmetric",
    });
  });

  it("an empty mapping is a block with no category, uncovered ignore, related off", () => {
    expect(declaredDocs({ docs: {} })).toEqual({ categories: [], uncovered: "ignore", related: "off" });
  });
});

describe("declaredDocs — what is refused, by position, never by value (spec 47 §5.4)", () => {
  it.each([
    ["not a mapping", "x", "docs block: docs — the docs block is a mapping with categories, uncovered and related"],
    ["categories not a list", { categories: "x" }, "docs block: categories — categories is a list of entries, each with a path"],
    ["an entry not a mapping", { categories: ["x"] }, "docs block: categories[0] — a category is a mapping with a path"],
    ["no path", { categories: [{}] }, "docs block: categories[0].path — a category path is"],
    ["an absolute path", { categories: [{ path: "/abs" }] }, "docs block: categories[0].path —"],
    ["a Windows path", { categories: [{ path: "C:/x" }] }, "docs block: categories[0].path —"],
    ["a backslash", { categories: [{ path: "a\\b" }] }, "docs block: categories[0].path —"],
    ["a .. segment", { categories: [{ path: "a/../b" }] }, "docs block: categories[0].path —"],
    ["a . segment", { categories: [{ path: "./a" }] }, "docs block: categories[0].path —"],
    ["an empty segment", { categories: [{ path: "a//b" }] }, "docs block: categories[0].path —"],
    ["a trailing slash", { categories: [{ path: "a/" }] }, "docs block: categories[0].path —"],
    ["a space", { categories: [{ path: "a b" }] }, "docs block: categories[0].path —"],
    ["frontmatter not a list", { categories: [{ path: "a", frontmatter: "title" }] }, "docs block: categories[0].frontmatter — frontmatter is a list of key names"],
    ["a frontmatter key with a colon", { categories: [{ path: "a", frontmatter: ["ok", "a:b"] }] }, "docs block: categories[0].frontmatter[1] — a key name is"],
    ["name outside the vocabulary", { categories: [{ path: "a", name: "^\\d+" }] }, "docs block: categories[0].name — name is any or dated"],
    ["uncovered", { uncovered: "warn" }, "docs block: uncovered — uncovered is ignore or error"],
    ["related", { related: true }, "docs block: related — related is off, resolve or symmetric"],
    ["an unknown key shaped like a name", { strict: 1 }, "docs block: strict — the docs block has no such key"],
    ["an unknown category key shaped like a name", { categories: [{ path: "a", pattern: "x" }] }, "docs block: categories[0].pattern — a category has no such key"],
  ])("%s", (_label, docs, expected) => {
    expect(refusal(docs).startsWith(expected)).toBe(true);
  });

  it("counts the other issues: (and N more)", () => {
    expect(refusal({ uncovered: 1, related: 2, categories: [{}] })).toMatch(/ \(and 2 more\)$/);
  });

  it("a __proto__ key is refused, never dropped", () => {
    const docs = JSON.parse('{"__proto__": {"x": 1}, "related": "off"}');
    expect(refusal(docs)).toBe("docs block: __proto__ — a __proto__ key is not allowed");
    const inCategory = JSON.parse('{"categories": [{"path": "a", "__proto__": 1}]}');
    expect(refusal(inCategory)).toBe("docs block: categories[0].__proto__ — a __proto__ key is not allowed");
  });

  it("a token or a marker as an unknown key is named by the mapping holding it, never echoed", () => {
    const top = refusal({ [TOKEN]: 1 });
    expect(top).toBe("docs block: docs — the docs block has no such key (it has categories, uncovered and related)");
    const inner = refusal({ categories: [{ path: "a", [`https://u:${M}@h`]: 1 }] });
    expect(inner).toBe("docs block: categories[0] — a category has no such key (it has path, frontmatter and name)");
    expect(top + inner).not.toContain(TOKEN);
    expect(inner).not.toContain(M);
  });

  it("a token as a required key is refused by position, never echoed", () => {
    const m = refusal({ categories: [{ path: "a", frontmatter: [TOKEN] }] });
    expect(m.startsWith("docs block: categories[0].frontmatter[0] — a key name is")).toBe(true);
    expect(m).not.toContain(TOKEN);
  });

  it("no value of the block reaches a refusal", () => {
    const m = refusal({ categories: [{ path: `${M}/../x`, name: M, frontmatter: [`${M}:`] }], uncovered: M, related: M, [M + "#"]: M });
    expect(m).not.toContain(M);
  });
});

describe("the docs key at load (spec 47 §5.2)", () => {
  it("ProfileSchema keeps any shape as written", () => {
    const docs = { categories: "not a list", anything: { deep: [1] } };
    expect(ProfileSchema.parse({ name: "acme", docs }).docs).toEqual(docs);
    expect(ProfileSchema.parse({ name: "acme" }).docs).toBeUndefined();
  });

  it("profile.docs and DocsBlockSchema are used by src/core/docs-validate.ts only (one reader)", async () => {
    const src = path.join(__dirname, "..", "src");
    const offenders: string[] = [];
    for (const rel of await listFiles(src)) {
      if (!rel.endsWith(".ts") || rel === "core/docs-validate.ts" || rel === "schema/index.ts") continue;
      const text = await fs.readFile(path.join(src, rel), "utf8");
      if (/\.docs\b(?!\s*\??:)/.test(text.replace(/language\??\.docs/g, "")) || text.includes("DocsBlockSchema")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
