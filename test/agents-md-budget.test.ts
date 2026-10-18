import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace, plan, type Plan } from "../src/core/sync.js";
import { agentsMdOverBudget } from "../src/core/sync.js";
import { profile, recipe, rule, scenario, type ForgeSpec } from "./helpers/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function planFor(
  ingredients: ForgeSpec["ingredients"],
  profileExtra: Record<string, unknown> = {},
  targets = ["agents-md"],
): Promise<Plan> {
  const forge: ForgeSpec = {
    ingredients,
    recipes: [recipe("base", ingredients!.map((i) => `${i.meta.type}/${i.meta.name}`))],
    profiles: [profile("acme", ["base"], targets, profileExtra)],
  };
  const s = await scenario(forge, { config: { profile: "acme" } });
  cleanups.push(s.cleanup);
  return plan(await loadWorkspace(s.wsRoot));
}

const agentsMdContent = (p: Plan) => p.files.find((f) => f.path === "AGENTS.md")?.content;

describe("agents-md.maxBytes budget (core)", () => {
  // Case 1: two always-on rules, no budget set → defaults
  it("1. two large rules, no budget → explicit false, maxBytes 32768, warning matches pattern, agentsMdOverBudget null", async () => {
    const p = await planFor([
      rule("big", "# Big\n" + "x".repeat(20000) + "\n"),
      rule("mid", "# Mid\n" + "y".repeat(15000) + "\n"),
    ]);
    expect(p.agentsMd).not.toBeNull();
    expect(p.agentsMd!.explicit).toBe(false);
    expect(p.agentsMd!.maxBytes).toBe(32768);
    expect(p.agentsMd!.bytes).toBe(agentsMdContent(p)!.length);
    const budgetWarning = p.warnings.find((w) => w.startsWith("AGENTS.md is"));
    expect(budgetWarning).toMatch(
      /^AGENTS\.md is \d+ bytes, over the default budget of 32768 \(agents-md\.maxBytes\) — largest rules: big \(\d+ bytes\), mid \(\d+ bytes\)$/,
    );
    // Not explicit → agentsMdOverBudget returns null
    expect(agentsMdOverBudget(p)).toBeNull();
  });

  // Case 2: same with explicit budget 1000 → explicit, agentsMdOverBudget returns the pair
  it("2. explicit budget 1000 (number) → explicit true, warning says 1000, agentsMdOverBudget returns { bytes, maxBytes }", async () => {
    const p = await planFor(
      [
        rule("big", "# Big\n" + "x".repeat(20000) + "\n"),
        rule("mid", "# Mid\n" + "y".repeat(15000) + "\n"),
      ],
      { params: { "agents-md.maxBytes": 1000 } },
    );
    expect(p.agentsMd).not.toBeNull();
    expect(p.agentsMd!.explicit).toBe(true);
    expect(p.agentsMd!.maxBytes).toBe(1000);
    const budgetWarning = p.warnings.find((w) => w.startsWith("AGENTS.md is"));
    expect(budgetWarning).toContain("over the budget of 1000 set by agents-md.maxBytes; sync --check fails");
    const over = agentsMdOverBudget(p);
    expect(over).toEqual({ bytes: p.agentsMd!.bytes, maxBytes: 1000 });
  });

  // Case 3: string "1000" treated as 1000
  it("3. explicit budget '1000' (string) → treated as 1000, explicit true", async () => {
    const p = await planFor(
      [
        rule("big", "# Big\n" + "x".repeat(20000) + "\n"),
        rule("mid", "# Mid\n" + "y".repeat(15000) + "\n"),
      ],
      { params: { "agents-md.maxBytes": "1000" } },
    );
    expect(p.agentsMd).not.toBeNull();
    expect(p.agentsMd!.explicit).toBe(true);
    expect(p.agentsMd!.maxBytes).toBe(1000);
  });

  // Case 4: budget 0 turns it off → no warning, agentsMdOverBudget null
  it("4. budget 0 → no budget warning, agentsMdOverBudget null", async () => {
    const p = await planFor(
      [
        rule("big", "# Big\n" + "x".repeat(20000) + "\n"),
        rule("mid", "# Mid\n" + "y".repeat(15000) + "\n"),
      ],
      { params: { "agents-md.maxBytes": 0 } },
    );
    expect(p.agentsMd).not.toBeNull();
    const budgetWarning = p.warnings.find((w) => w.startsWith("AGENTS.md is"));
    expect(budgetWarning).toBeUndefined();
    expect(agentsMdOverBudget(p)).toBeNull();
  });

  // Case 5: small rule, no budget → no warning
  it("5. one small rule, no budget → no warning starting with 'AGENTS.md is'", async () => {
    const p = await planFor([rule("small", "# Small\n")]);
    expect(p.agentsMd).not.toBeNull();
    const budgetWarning = p.warnings.find((w) => w.startsWith("AGENTS.md is"));
    expect(budgetWarning).toBeUndefined();
  });

  // Case 6: invalid value "abc" → invalid-value warning, explicit false, maxBytes 32768
  it("6. invalid value 'abc' → invalid-value warning, explicit false, maxBytes 32768", async () => {
    const p = await planFor(
      [
        rule("big", "# Big\n" + "x".repeat(20000) + "\n"),
        rule("mid", "# Mid\n" + "y".repeat(15000) + "\n"),
      ],
      { params: { "agents-md.maxBytes": "abc" } },
    );
    expect(p.agentsMd).not.toBeNull();
    expect(p.agentsMd!.explicit).toBe(false);
    expect(p.agentsMd!.maxBytes).toBe(32768);
    expect(p.warnings).toContain(
      "agents-md.maxBytes must be a whole number of bytes (0 turns the budget off) — the default 32768 is used",
    );
  });

  // Case 7: seven always-on rules r1…r7, one embedded scoped rule, budget 100 → warning names scoped + r1-r4 (top 5 by bytes)
  it("7. seven always-on rules, one embedded scoped, budget 100 → warning names scoped, r1-r4, rules array has 8 entries", async () => {
    const p = await planFor(
      [
        rule("r1", "# R1\n" + "z".repeat(10000) + "\n"),
        rule("r2", "# R2\n" + "z".repeat(9000) + "\n"),
        rule("r3", "# R3\n" + "z".repeat(8000) + "\n"),
        rule("r4", "# R4\n" + "z".repeat(7000) + "\n"),
        rule("r5", "# R5\n" + "z".repeat(6000) + "\n"),
        rule("r6", "# R6\n" + "z".repeat(5000) + "\n"),
        rule("r7", "# R7\n" + "z".repeat(4000) + "\n"),
        // This scoped rule has targets: "*", but since we only have agents-md target, it becomes embedded (State C)
        rule("scoped", "# Scoped\n" + "z".repeat(50000) + "\n", { inclusion: "fileMatch", fileMatchPattern: "src/**" }),
      ],
      { params: { "agents-md.maxBytes": 100 } },
    );
    expect(p.agentsMd).not.toBeNull();
    expect(p.agentsMd!.rules).toHaveLength(8); // 7 always-on + 1 embedded scoped
    // Rules sorted by bytes desc, then name asc; scoped is largest
    const names = p.agentsMd!.rules.map((r) => r.name);
    expect(names[0]).toBe("scoped");
    expect(names.slice(1, 6)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    // Check scoped flag
    expect(p.agentsMd!.rules[0].scoped).toBe(true);
    expect(p.agentsMd!.rules[1].scoped).toBe(false);
    // Warning names top 5: scoped, r1, r2, r3, r4
    const budgetWarning = p.warnings.find((w) => w.startsWith("AGENTS.md is"));
    expect(budgetWarning).toMatch(/largest rules: scoped \(scoped, \d+ bytes\), r1 \(\d+ bytes\)/);
    expect(budgetWarning).toContain("r1 (");
    expect(budgetWarning).toContain("r2 (");
    expect(budgetWarning).toContain("r3 (");
    expect(budgetWarning).toContain("r4 (");
    expect(budgetWarning).not.toContain("r5 ("); // 6th largest
    expect(budgetWarning).not.toContain("r6 (");
    expect(budgetWarning).not.toContain("r7 (");
  });

  // Case 8: profile without agents-md target → agentsMd is null, no budget warning
  it("8. profile without agents-md target → agentsMd is null, no budget warning", async () => {
    const p = await planFor([rule("a", "# A\n")], {}, ["claude-code"]);
    expect(p.agentsMd).toBeNull();
    const budgetWarning = p.warnings.find((w) => w.startsWith("AGENTS.md is"));
    expect(budgetWarning).toBeUndefined();
  });

  // A recipe's params default is a layer like any other: the budget counts as set
  it("9. the budget given as a recipe param default → explicit true", async () => {
    const big = rule("big", "# Big\n" + "x".repeat(5000) + "\n");
    const forge: ForgeSpec = {
      ingredients: [big],
      recipes: [recipe("base", ["rule/big"], { params: { "agents-md.maxBytes": { default: 1000 } } })],
      profiles: [profile("acme", ["base"], ["agents-md"])],
    };
    const s = await scenario(forge, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    const p = await plan(await loadWorkspace(s.wsRoot));
    expect(p.agentsMd!.explicit).toBe(true);
    expect(p.agentsMd!.maxBytes).toBe(1000);
    expect(agentsMdOverBudget(p)).toEqual({ bytes: agentsMdContent(p)!.length, maxBytes: 1000 });
  });
});
