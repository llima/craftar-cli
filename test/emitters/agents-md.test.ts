import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, plan } from "../../src/core/sync.js";
import { profile, recipe, rule, scenario } from "../helpers/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("agents-md emitter", () => {
  it("concatenates always rules and lists scoped rules with their pattern", async () => {
    const s = await scenario(
      {
        ingredients: [rule("a", "# A\n\nalways on\n"), rule("b", "# B\n", { inclusion: "fileMatch", fileMatchPattern: "projects/api/**" })],
        recipes: [recipe("base", ["rule/a", "rule/b"])],
        profiles: [profile("acme", ["base"], ["agents-md"])],
      },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    const p = await plan(await loadWorkspace(s.wsRoot));
    const doc = p.files.find((f) => f.path === "AGENTS.md")!.content.toString("utf8");
    expect(doc).toContain("<!-- rule: a -->\n# A\n\nalways on\n");
    expect(doc).toContain("## Scoped rules\n\n- `.claude/rules/b.md` — applies to `projects/api/**`\n");
    expect(doc).not.toContain("# B");
  });
});
