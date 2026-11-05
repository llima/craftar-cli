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
        { path: "architecture", frontmatter: ["title", "date"], name: "any", values: {}, paths: {} },
        { path: "tech-debt", frontmatter: [], name: "dated", values: {}, paths: {} },
        { path: "specs/acme", frontmatter: [], name: "any", values: {}, paths: {} },
      ],
      uncovered: "error",
      related: "symmetric",
      relatedBase: "file",
      cited: null,
    });
  });

  it("an empty mapping is a block with no category, uncovered ignore, related off", () => {
    expect(declaredDocs({ docs: {} })).toEqual({ categories: [], uncovered: "ignore", related: "off", relatedBase: "file", cited: null });
  });
});

describe("declaredDocs — what is refused, by position, never by value (spec 47 §5.4)", () => {
  it.each([
    ["not a mapping", "x", "docs block: docs — the docs block is a mapping with categories, uncovered, related, relatedBase and cited"],
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
    ["frontmatter not a list", { categories: [{ path: "a", frontmatter: "title" }] }, "docs block: categories[0].frontmatter — frontmatter is a list of key names and one-key mappings to value lists"],
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
    expect(top).toBe("docs block: docs — the docs block has no such key (it has categories, uncovered, related, relatedBase and cited)");
    const inner = refusal({ categories: [{ path: "a", [`https://u:${M}@h`]: 1 }] });
    expect(inner).toBe("docs block: categories[0] — a category has no such key (it has path, frontmatter, name and paths)");
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
      let text = await fs.readFile(path.join(src, rel), "utf8");
      // Spec 54 §5.3: the family merge copies the block whole, never reading it — that one statement is allowed.
      if (rel === "core/profile-extends.ts") text = text.replace('if (written(forge, l, "docs")) out.docs = l.docs;', "");
      if (/\.docs\b(?!\s*\??:)/.test(text.replace(/language\??\.docs/g, "")) || text.includes("DocsBlockSchema")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

describe("spec 58 §4.1 — the new keys read", () => {
  it("the mapping form, paths, relatedBase and cited", () => {
    expect(
      declaredDocs({
        docs: {
          categories: [
            { path: "specs", frontmatter: ["title", { status: ["draft", "in-progress", "shipped", "deprecated"] }] },
            { path: "plans", name: "dated", frontmatter: ["title", { status: ["active", "shipped"] }, "spec"], paths: { spec: { base: "workspace", sentinel: "none" } } },
            { path: "notes", paths: { ref: { base: "file" } } },
          ],
          uncovered: "error",
          related: "symmetric",
          relatedBase: "workspace",
          cited: { roots: ["docs", ".claude", "local-stack", "docs/specs"], exempt: [".claude/settings.craftar.example.json", ".claude/settings.craftar.example.json"] },
        },
      }),
    ).toEqual({
      categories: [
        { path: "specs", frontmatter: ["title", "status"], name: "any", values: { status: ["draft", "in-progress", "shipped", "deprecated"] }, paths: {} },
        { path: "plans", frontmatter: ["title", "status", "spec"], name: "dated", values: { status: ["active", "shipped"] }, paths: { spec: { base: "workspace", sentinel: "none" } } },
        { path: "notes", frontmatter: [], name: "any", values: {}, paths: { ref: { base: "file", sentinel: null } } },
      ],
      uncovered: "error",
      related: "symmetric",
      relatedBase: "workspace",
      cited: { roots: ["docs", ".claude", "local-stack", "docs/specs"], exempt: [".claude/settings.craftar.example.json", ".claude/settings.craftar.example.json"] },
    });
  });

  it("a plain key repeated stays accepted, as before", () => {
    expect(declaredDocs({ docs: { categories: [{ path: "a", frontmatter: ["title", "title"] }] } })!.categories[0].frontmatter).toEqual(["title", "title"]);
  });

  it("cited with no exempt reads exempt as empty; relatedBase file is the default", () => {
    const b = declaredDocs({ docs: { cited: { roots: ["_drafts"] }, relatedBase: "file" } })!;
    expect(b.cited).toEqual({ roots: ["_drafts"], exempt: [] });
    expect(b.relatedBase).toBe("file");
  });
});

describe("spec 58 §4.2 — each refusal, by position, never by value", () => {
  const at = (c: Record<string, unknown>) => ({ categories: [{ path: "a", ...c }] });
  it.each([
    ["an item neither a string nor a mapping", at({ frontmatter: ["t", 5] }), "docs block: categories[0].frontmatter[1] — a frontmatter entry is a key name, or one key name mapped to a list of values"],
    ["a mapping of two keys", at({ frontmatter: [{ a: ["x"], b: ["y"] }] }), "docs block: categories[0].frontmatter[0] — a frontmatter entry is a key name, or one key name mapped to a list of values"],
    ["an empty mapping", at({ frontmatter: [{}] }), "docs block: categories[0].frontmatter[0] — a frontmatter entry is a key name, or one key name mapped to a list of values"],
    ["a mapping's key not shaped like a name", at({ frontmatter: [{ "a:b": ["x"] }] }), "docs block: categories[0].frontmatter[0] — a key name is letters, digits, _ and -, starting with a letter or _, at most 64 characters, and not a token"],
    ["an empty value list", at({ frontmatter: [{ status: [] }] }), "docs block: categories[0].frontmatter[0].status — a value list is a non-empty list of values"],
    ["a value list that is not a list", at({ frontmatter: [{ status: "draft" }] }), "docs block: categories[0].frontmatter[0].status — a value list is a non-empty list of values"],
    ["a value not shaped like a name", at({ frontmatter: [{ status: ["draft", "in progress"] }] }), "docs block: categories[0].frontmatter[0].status[1] — a value is letters, digits, _ and -, starting with a letter or _, at most 64 characters, and not a token"],
    ["a value that is not a string", at({ frontmatter: [{ status: ["draft", true] }] }), "docs block: categories[0].frontmatter[0].status[1] — a value is letters, digits, _ and -, starting with a letter or _, at most 64 characters, and not a token"],
    ["a number value", at({ frontmatter: [{ status: [2026] }] }), "docs block: categories[0].frontmatter[0].status[0] — a value is letters, digits, _ and -, starting with a letter or _, at most 64 characters, and not a token"],
    ["a value twice", at({ frontmatter: [{ status: ["draft", "shipped", "draft"] }] }), "docs block: categories[0].frontmatter[0].status[2] — a value appears once in its list, and a key with a value list appears once in frontmatter"],
    ["a mapped key repeated as a plain key", at({ frontmatter: [{ status: ["draft"] }, "status"] }), "docs block: categories[0].frontmatter[1] — a value appears once in its list, and a key with a value list appears once in frontmatter"],
    ["a plain key repeated as a mapped key", at({ frontmatter: ["status", { status: ["draft"] }] }), "docs block: categories[0].frontmatter[1] — a value appears once in its list, and a key with a value list appears once in frontmatter"],
    ["a mapped key mapped twice", at({ frontmatter: [{ status: ["a"] }, { status: ["b"] }] }), "docs block: categories[0].frontmatter[1] — a value appears once in its list, and a key with a value list appears once in frontmatter"],
    ["paths not a mapping", at({ paths: ["spec"] }), "docs block: categories[0].paths — paths maps key names to {base, sentinel}"],
    ["a paths entry not a mapping", at({ paths: { spec: "workspace" } }), "docs block: categories[0].paths.spec — paths maps key names to {base, sentinel}"],
    ["an unknown key in a paths entry", at({ paths: { spec: { base: "file", glob: "x" } } }), "docs block: categories[0].paths.spec.glob — an entry of paths has no such key (it has base and sentinel)"],
    ["a paths key not shaped like a name", at({ paths: { "a:b": { base: "file" } } }), "docs block: categories[0].paths — a key name is letters, digits, _ and -, starting with a letter or _, at most 64 characters, and not a token"],
    ["base missing", at({ paths: { spec: {} } }), "docs block: categories[0].paths.spec.base — base is file or workspace"],
    ["base another word", at({ paths: { spec: { base: "root" } } }), "docs block: categories[0].paths.spec.base — base is file or workspace"],
    ["a sentinel not shaped like a name", at({ paths: { spec: { base: "file", sentinel: "n/a" } } }), "docs block: categories[0].paths.spec.sentinel — a value is letters, digits, _ and -, starting with a letter or _, at most 64 characters, and not a token"],
    ["a sentinel that is not a string", at({ paths: { spec: { base: "file", sentinel: false } } }), "docs block: categories[0].paths.spec.sentinel — a value is letters, digits, _ and -, starting with a letter or _, at most 64 characters, and not a token"],
    ["a path key with a value list", at({ frontmatter: [{ spec: ["none"] }], paths: { spec: { base: "file" } } }), "docs block: categories[0].paths.spec — a key with a value list cannot be a path key"],
    ["relatedBase", { relatedBase: "root" }, "docs block: relatedBase — relatedBase is file or workspace"],
    ["cited not a mapping", { cited: ["docs"] }, "docs block: cited — cited is a mapping with roots and, optionally, exempt"],
    ["cited without roots", { cited: { exempt: [] } }, "docs block: cited — cited is a mapping with roots and, optionally, exempt"],
    ["cited roots empty", { cited: { roots: [] } }, "docs block: cited.roots — cited is a mapping with roots and, optionally, exempt"],
    ["cited roots not a list", { cited: { roots: "docs" } }, "docs block: cited.roots — cited is a mapping with roots and, optionally, exempt"],
    ["an unknown key in cited", { cited: { roots: ["docs"], extra: 1 } }, "docs block: cited.extra — cited is a mapping with roots and, optionally, exempt"],
    ["a root that is absolute", { cited: { roots: ["/docs"] } }, "docs block: cited.roots[0] — a cited root is a relative POSIX path: segments of letters, digits and . _ @ + -, no . or .. segment, no backslash, not absolute"],
    ["a root with ..", { cited: { roots: ["docs", "../x"] } }, "docs block: cited.roots[1] — a cited root is a relative POSIX path: segments of letters, digits and . _ @ + -, no . or .. segment, no backslash, not absolute"],
    ["a root with a backslash", { cited: { roots: ["a\\b"] } }, "docs block: cited.roots[0] — a cited root is a relative POSIX path: segments of letters, digits and . _ @ + -, no . or .. segment, no backslash, not absolute"],
    ["a root that is a Windows path", { cited: { roots: ["C:/x"] } }, "docs block: cited.roots[0] — a cited root is a relative POSIX path: segments of letters, digits and . _ @ + -, no . or .. segment, no backslash, not absolute"],
    ["a root that is not a string", { cited: { roots: [1] } }, "docs block: cited.roots[0] — a cited root is a relative POSIX path: segments of letters, digits and . _ @ + -, no . or .. segment, no backslash, not absolute"],
    ["a root twice", { cited: { roots: ["docs", "docs"] } }, "docs block: cited.roots[1] — a cited root appears once in roots"],
    ["a root .git", { cited: { roots: [".git"] } }, "docs block: cited.roots[0] — a cited root cannot be .git or start with .git/"],
    ["a root .Git (case-insensitive)", { cited: { roots: [".Git"] } }, "docs block: cited.roots[0] — a cited root cannot be .git or start with .git/"],
    ["a root .git/hooks", { cited: { roots: [".git/hooks"] } }, "docs block: cited.roots[0] — a cited root cannot be .git or start with .git/"],
    ["exempt not a list", { cited: { roots: ["docs"], exempt: "x.md" } }, "docs block: cited.exempt — exempt is a list of relative POSIX paths"],
    ["an exempt entry with ..", { cited: { roots: ["docs"], exempt: ["docs/../x.md"] } }, "docs block: cited.exempt[0] — an exempt entry is a relative POSIX path: no . or .. segment, no backslash, not absolute"],
    ["an exempt entry absolute", { cited: { roots: ["docs"], exempt: ["ok.md", "/x.md"] } }, "docs block: cited.exempt[1] — an exempt entry is a relative POSIX path: no . or .. segment, no backslash, not absolute"],
    ["an exempt entry with a backslash", { cited: { roots: ["docs"], exempt: ["a\\b.md"] } }, "docs block: cited.exempt[0] — an exempt entry is a relative POSIX path: no . or .. segment, no backslash, not absolute"],
    ["an exempt entry not a string", { cited: { roots: ["docs"], exempt: [null] } }, "docs block: cited.exempt[0] — an exempt entry is a relative POSIX path: no . or .. segment, no backslash, not absolute"],
    ["an unknown category key lists paths", at({ pattern: "x" }), "docs block: categories[0].pattern — a category has no such key (it has path, frontmatter, name and paths)"],
    ["an unknown top-level key lists the new keys", { strict: 1 }, "docs block: strict — the docs block has no such key (it has categories, uncovered, related, relatedBase and cited)"],
  ])("%s", (_label, docs, expected) => {
    expect(refusal(docs)).toBe(expected);
  });

  it("a nested root is accepted and an exempt entry given twice too", () => {
    expect(declaredDocs({ docs: { cited: { roots: ["docs", "docs/specs"], exempt: ["a.md", "a.md"] } } })!.cited).toEqual({ roots: ["docs", "docs/specs"], exempt: ["a.md", "a.md"] });
  });

  it("a __proto__ key is refused in each new mapping", () => {
    expect(refusal({ categories: [{ path: "a", frontmatter: [JSON.parse('{"__proto__": ["x"]}')] }] })).toBe("docs block: categories[0].frontmatter[0].__proto__ — a __proto__ key is not allowed");
    expect(refusal({ categories: [{ path: "a", paths: JSON.parse('{"__proto__": {"base": "file"}}') }] })).toBe("docs block: categories[0].paths.__proto__ — a __proto__ key is not allowed");
    expect(refusal({ categories: [{ path: "a", paths: { spec: JSON.parse('{"base": "file", "__proto__": 1}') } }] })).toBe("docs block: categories[0].paths.spec.__proto__ — a __proto__ key is not allowed");
    expect(refusal({ cited: JSON.parse('{"roots": ["docs"], "__proto__": 1}') })).toBe("docs block: cited.__proto__ — a __proto__ key is not allowed");
  });

  it("no value, sentinel, root or exempt entry of the block reaches a refusal", () => {
    const lines = [
      refusal({ categories: [{ path: "a", frontmatter: [{ status: [M, `${M}:`] }] }] }),
      refusal({ categories: [{ path: "a", frontmatter: [{ [`${M}:`]: ["x"] }] }] }),
      refusal({ categories: [{ path: "a", paths: { spec: { base: M, sentinel: `${M}/` } } }] }),
      refusal({ categories: [{ path: "a", paths: { [`${M}#`]: { base: "file" } } }] }),
      refusal({ categories: [{ path: "a", paths: { spec: { base: "file", [`${M}#`]: 1 } } }] }),
      refusal({ relatedBase: M }),
      refusal({ cited: { roots: [`/${M}`, `${M}/..`], exempt: [`/${M}.md`] } }),
      refusal({ cited: { roots: ["docs"], [`${M}#`]: 1 } }),
      refusal({ categories: [{ path: "a", frontmatter: [{ status: [TOKEN] }] }] }),
    ];
    for (const l of lines) {
      expect(l).not.toContain(M);
      expect(l).not.toContain(TOKEN);
    }
  });
});
