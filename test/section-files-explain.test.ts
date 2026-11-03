import { afterEach, expect, it } from "vitest";
import { runCli } from "./helpers/cli.js";
import { FORGE_SCHEMA_SECTION_FILES } from "../src/schema/index.js";
import { acmeSections, type Scenario } from "./helpers/section-files.js";

/** Spec 55 §5.4, E3: `explain` names the file a profile's section value came from; a string value keeps today's words. */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = (s: Scenario) => (cleanups.push(s.cleanup), s);

it("explain names the file inside the layer's parenthesis; a string value keeps today's words", async () => {
  const s = kept(
    await acmeSections({
      schema: FORGE_SCHEMA_SECTION_FILES,
      sections: { "rule/review": { checklist: { file: "sections/rule/review/checklist.md" }, tone: "Short.\n" } },
      files: { "profiles/acme/sections/rule/review/checklist.md": "- one\n" },
    }),
  );
  const r = runCli(["explain", ".claude/rules/review.md", "--workspace", s.wsRoot]);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toContain("  sections    checklist (profile acme, sections/rule/review/checklist.md), tone (profile acme)\n");
});
