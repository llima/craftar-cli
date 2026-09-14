import { afterEach, describe, expect, it } from "vitest";
import { profile, recipe, rule, scenario } from "./helpers/forge.js";
import { runCli } from "./helpers/cli.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("cli", () => {
  it("status prints the unresolved-param warning and exits 0; sync --check still passes", async () => {
    const s = await scenario(
      { ingredients: [rule("a", "Org: {{missing}}\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);

    const st = runCli(["status", "--workspace", s.wsRoot]);
    expect(st.code).toBe(0);
    expect(st.stdout).toContain('param "missing" has no value in any layer');

    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    const check = runCli(["sync", "--check", "--workspace", s.wsRoot]);
    expect(check.code).toBe(0);
    expect(check.stdout).toContain("workspace in sync");
  });
});
