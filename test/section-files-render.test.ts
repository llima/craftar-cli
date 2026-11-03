import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { FORGE_SCHEMA_SECTION_FILES } from "../src/schema/index.js";
import { acmeSections } from "./helpers/section-files.js";

/** Spec 55 §5.4, test 22 (spec 51's acceptance 10, kept): a file-held section renders byte for byte as the same string. */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function planned(checklist: unknown, files: Record<string, string> = {}) {
  const s = await acmeSections({ schema: FORGE_SCHEMA_SECTION_FILES, sections: { "rule/review": { checklist, tone: "Short.\n" } }, files });
  cleanups.push(s.cleanup);
  const p = await plan(await loadWorkspace(s.wsRoot));
  return Object.fromEntries(p.files.map((f) => [f.path, f.content.toString("hex")]));
}

describe("a file-held section renders byte for byte as the same string (spec 55 §5.4)", () => {
  it.each([
    ["CRLF", "- one\r\n- two\r\n"],
    ["a BOM", "﻿- one\n- two\n"],
    ["no final newline", "- one\n- two"],
    ["empty", ""],
  ])("%s", async (_label, text) => {
    const asString = await planned(text.replace(/^﻿/, ""));
    const asFile = await planned({ file: "sections/rule/review/checklist.md" }, { "profiles/acme/sections/rule/review/checklist.md": text });
    expect(Object.keys(asFile).length).toBeGreaterThan(0);
    expect(asFile).toEqual(asString);
  });
});
