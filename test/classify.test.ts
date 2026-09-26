import { describe, expect, it } from "vitest";
import { classifyHunk, isIdentifierLike, paramSlug, tokenize } from "../src/core/classify.js";
import { diffLines } from "../src/core/diff.js";
import type { HunkSuggestion } from "../src/schema/index.js";

/** The one hunk between two texts, built by the real diff (spec 08 §9.1: never by hand). */
function hunkOf(a: string, b: string) {
  const hunks = diffLines(a, b);
  expect(hunks).toHaveLength(1);
  return hunks[0];
}
const classify = (a: string, b: string) => classifyHunk(hunkOf(a, b));
const brief = (s: HunkSuggestion) => `${s.class}: ${s.reason}`;

const REASONS = new Set([
  "only in the base",
  "only in the variant",
  "final newline only",
  "final newline differs",
  "line counts differ",
  "line too long to compare",
  "words added or removed",
  "numbering differs",
  "prose differs",
  "whitespace only",
]);
const allowed = (s: HunkSuggestion) => REASONS.has(s.reason) || /^(1 token differs|[0-9]+ tokens differ)$/.test(s.reason);

describe("tokenize", () => {
  it("splits whitespace runs, words and single other characters", () => {
    expect(tokenize("a  b\tc")).toEqual(["a", "  ", "b", "\t", "c"]);
    expect(tokenize("acme-api.")).toEqual(["acme-api", "."]);
    expect(tokenize("`x`")).toEqual(["`", "x", "`"]);
    expect(tokenize("| a |")).toEqual(["|", " ", "a", " ", "|"]);
  });

  it("keeps URLs, e-mails, scopes and dotted names as one word", () => {
    for (const w of ["https://acme.dev/docs", "ops@acme.dev", "@acme/npm", "Directory.Build.props", "NPM_PAT"]) expect(tokenize(w)).toEqual([w]);
  });

  it("reads Unicode letters as word characters", () => {
    expect(tokenize("ação-api")).toEqual(["ação-api"]);
  });
});

describe("isIdentifierLike", () => {
  it("accepts names, paths, versions and ports", () => {
    for (const t of ["acme-api", "package.json", "ops@acme.dev", "a/b", "x:y", "v2", "555", "44301", "NPM_PAT", "getAcmeUser"]) expect(isIdentifierLike(t), t).toBe(true);
  });

  it("refuses plain words, step numbers, emphasis and non-words", () => {
    for (const t of ["Acme", "acme", "5", "55", "_TODO_", "`", "|", "step"]) expect(isIdentifierLike(t), t).toBe(false);
  });

  it("stops at 40 characters", () => {
    expect(isIdentifierLike("a-" + "x".repeat(38))).toBe(true);
    expect(isIdentifierLike("a-" + "x".repeat(39))).toBe(false);
  });
});

describe("paramSlug", () => {
  it("slugs the base-side text with underscores", () => {
    expect(paramSlug("package.json")).toBe("param.package_json");
    expect(paramSlug("acme-portal-api")).toBe("param.acme_portal_api");
    expect(paramSlug("44301")).toBe("param.44301");
    expect(paramSlug("https://acme.dev/docs")).toBe("param.https_acme_dev_docs");
  });

  it("strips diacritics, falls back to value, and truncates to 40 characters", () => {
    expect(paramSlug("ação-api")).toBe("param.acao_api");
    expect(paramSlug("---")).toBe("param.value");
    expect(paramSlug("x".repeat(60))).toBe("param." + "x".repeat(40));
    expect(paramSlug("x".repeat(39) + "-y")).toBe("param." + "x".repeat(39));
  });
});

describe("classifyHunk — the seven shapes of spec 01 §2, synthetic", () => {
  it("workflow: a TODO replaced by a reference is evolution", () => {
    expect(brief(classify("# W\n_TODO_: decide who reviews.\n", "# W\nSee `review-posture.md`.\n"))).toBe("evolution: prose differs");
  });

  it("commit-conventions: a clause added is evolution", () => {
    expect(brief(classify("- No Co-Authored-By trailer.\n", "- No Co-Authored-By trailer, unless the user explicitly asks.\n"))).toBe(
      "evolution: words added or removed",
    );
  });

  it("branch-and-pr: a version file name swapped is a value", () => {
    const s = classify("# B\nBump `package.json` before the PR.\n", "# B\nBump `Directory.Build.props` before the PR.\n");
    expect(brief(s)).toBe("value: 1 token differs");
    expect(s.tokens).toEqual([{ a: "package.json", b: "Directory.Build.props", param: "param.package_json" }]);
  });

  it("commit-identity: a registry described away is evolution", () => {
    expect(
      brief(classify("The `NPM_PAT` token reads the `@acme-registry` feed.\n", "The `NPM_PAT` token reads the feed, if/when there is one.\n")),
    ).toBe("evolution: words added or removed");
  });

  it("review-posture: a client row added to a table is a block", () => {
    const row = "| acme-api | node-cli-reviewer |\n";
    expect(brief(classify(row, row + "| acme-desktop | desktop-reviewer |\n"))).toBe("block: only in the variant");
  });

  it("repo-discovery: a whole section only one client has is a block", () => {
    const common = "# Repos\nShared text.\n";
    expect(brief(classify(common + "## Desktop\nacme-desktop uses pnpm.\nBuild with electron.\n", common))).toBe("block: only in the base");
  });

  it("open-pr: a step renumbered next to a client mention is evolution", () => {
    expect(brief(classify("Step 6: open the PR for acme-desktop.\n", "Step 5: open the PR.\n"))).toBe("evolution: numbering differs");
  });
});

describe("classifyHunk — edge cases (spec 08 §7)", () => {
  it("1. a newline-only difference", () => {
    expect(brief(classify("a\nb\n", "a\nb"))).toBe("evolution: final newline only");
  });

  it("2. a line appended after an unterminated last line is a block, whatever the structural kind", () => {
    const h = hunkOf("a\nb", "a\nb\nc\n");
    expect(h.kind).toBe("inline");
    expect(brief(classifyHunk(h))).toBe("block: only in the variant");
  });

  it("3. a token swap plus a final-newline change is evolution", () => {
    expect(brief(classify("x\nacme-api", "x\nglobex-api\n"))).toBe("evolution: final newline differs");
  });

  it("4. step numbers and list markers", () => {
    expect(brief(classify("Step 6: open the PR.\n", "Step 5: open the PR.\n"))).toBe("evolution: numbering differs");
    expect(brief(classify("1. first\n", "2. first\n"))).toBe("evolution: numbering differs");
  });

  it("5. numbering plus a client mention: the first region names the reason", () => {
    expect(brief(classify("Step 6: open the PR for acme-desktop.\n", "Step 5: open the PR.\n"))).toBe("evolution: numbering differs");
  });

  it("6. a value and prose in one line", () => {
    expect(brief(classify("Use acme-api now.\n", "Use globex-api today.\n"))).toBe("evolution: prose differs");
  });

  it("7. a changed row plus added rows is evolution; added rows alone are a block", () => {
    const base = "| a | acme-api |\n";
    expect(brief(classify(base, "| a | globex-api |\n| b | globex-web |\n"))).toBe("evolution: line counts differ");
  });

  it("8. known false positives: hyphenated words, abbreviations and years", () => {
    expect(classify("A well-known rule.\n", "A long-lived rule.\n").class).toBe("value");
    expect(classify("Use e.g. this.\n", "Use i.e. this.\n").class).toBe("value");
    expect(classify("Since 2025.\n", "Since 2026.\n").class).toBe("value");
  });

  it("9. known false negatives: plain client names", () => {
    for (const [a, b] of [["acme", "globex"], ["Acme", "Globex"], ["ACME", "GLOBEX"]])
      expect(brief(classify(`Owned by ${a}.\n`, `Owned by ${b}.\n`))).toBe("evolution: prose differs");
  });

  it("10. a duplicated token is listed once", () => {
    const s = classify("acme-api and acme-api\n", "globex-api and globex-api\n");
    expect(brief(s)).toBe("value: 1 token differs");
    expect(s.tokens).toHaveLength(1);
  });

  it("11. a slug collision within one hunk gets a numeric suffix", () => {
    const s = classify("acme-api then acme_api\n", "x-1 then x-2\n");
    expect(s.tokens?.map((t) => t.param)).toEqual(["param.acme_api", "param.acme_api_2"]);
    expect(s.reason).toBe("2 tokens differ");
  });

  it("12. an over-long token is not a client identifier", () => {
    expect(brief(classify(`Use a-${"x".repeat(39)} here.\n`, "Use acme-api here.\n"))).toBe("evolution: prose differs");
  });

  it("13. an over-long line is not compared word by word", () => {
    const long = (w: string) => Array.from({ length: 201 }, () => w).join(" ") + "\n";
    expect(brief(classify(long("acme-api"), long("globex-api")))).toBe("evolution: line too long to compare");
  });

  it("15. the classifier sees what the diff sees", () => {
    expect(brief(classify("café-api\n", "cafe-api\n"))).toBe("value: 1 token differs");
  });
});

describe("classifyHunk — whitespace and markdown (spec 08 §6.2 consequences)", () => {
  it("table padding around a swapped value", () => {
    expect(brief(classify("| acme-api   |\n", "| globex-api |\n"))).toBe("value: 1 token differs");
  });
  it("a tab replaced by a space", () => {
    expect(brief(classify("a\tb\n", "a b\n"))).toBe("evolution: whitespace only");
  });
  it("backticks kept, content swapped", () => {
    expect(brief(classify("`acme-api`\n", "`globex-api`\n"))).toBe("value: 1 token differs");
  });
  it("backticks removed", () => {
    expect(brief(classify("`acme-api`\n", "acme-api\n"))).toBe("evolution: words added or removed");
  });
  it("a table cell added", () => {
    expect(brief(classify("| a |\n", "| a | b |\n"))).toBe("evolution: words added or removed");
  });
  it("an empty line against text", () => {
    expect(brief(classify("x\n\ny\n", "x\ntext\ny\n"))).toBe("evolution: words added or removed");
  });
});

describe("classifyHunk — contract (spec 08 AC 2)", () => {
  it("returns only reasons from the closed set, and tokens only for a value", () => {
    const corpus: Array<[string, string]> = [
      ["_TODO_: decide.\n", "See `x.md`.\n"],
      ["Bump `package.json`.\n", "Bump `a.props`.\n"],
      ["r\n", "r\nq\n"],
      ["a\nb\n", "a\nb"],
      ["Step 6.\n", "Step 5.\n"],
      ["a\tb\n", "a b\n"],
      ["x\nacme-api", "x\nglobex-api\n"],
      ["one\n", "one\ntwo\nthree\n"],
    ];
    for (const [a, b] of corpus) {
      for (const h of diffLines(a, b)) {
        const s = classifyHunk(h);
        expect(allowed(s), s.reason).toBe(true);
        expect(s.tokens !== undefined, s.reason).toBe(s.class === "value");
        for (const t of s.tokens ?? []) expect(t.param).toMatch(/^param\.[a-z0-9_]+$/);
      }
    }
  });
});
