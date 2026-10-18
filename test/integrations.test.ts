import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { effectiveProfile, integrationOrigin, INTEGRATIONS_PREFIX, readsIntegrations, recipesOrWritten } from "../src/core/integrations.js";
import { listFiles } from "../src/core/forge.js";
import { ProfileSchema, type Profile } from "../src/schema/index.js";

// Spec 33 §9.1 — the block is read in one place, only at schema 3 and above.

const forge = (schema: number) => ({ manifest: { name: "f", schema } }) as Parameters<typeof effectiveProfile>[0];
const prof = (integrations: Record<string, unknown>, extra: Record<string, unknown> = {}): Profile =>
  ProfileSchema.parse({ name: "acme", recipes: ["base", "stack-dotnet"], integrations, ...extra });
const FULL = {
  pm: { kind: "azure-devops", org: "acme", project: "Platform" },
  idp: { kind: "mcp", url: "https://idp.example.com/mcp" },
  browser: { chromeDevtools: "1.7.0" },
};
const err = (integrations: Record<string, unknown>, schema = 3): string | null => {
  try {
    effectiveProfile(forge(schema), prof(integrations));
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};
const KIND = 'profile acme: integrations.pm.kind is not a kind name — a string of lowercase letters, digits, ".", "_" and "-", starting with a letter or a digit';
const SLOT = (s: string) => `profile acme: integrations key ${JSON.stringify(s)} is not a slot name — letters, digits and _, starting with a letter`;
const KEY = (k: string) => `profile acme: integrations.pm key ${JSON.stringify(k)} is not a key name — letters, digits and _ only`;

describe("effectiveProfile — below schema 3", () => {
  for (const schema of [1, 2]) {
    for (const [label, block] of [
      ["a valid block", FULL],
      ["a malformed slot name", { "my-slot": 1 }],
      ["a kind with no recipe", { pm: { kind: "jira" } }],
      ["a slot that is a list", { pm: [1] }],
    ] as const) {
      it(`schema ${schema}, ${label}: the profile's own recipes and params, the same objects, nothing else`, () => {
        const p = prof(block as Record<string, unknown>, { params: { a: 1 } });
        const e = effectiveProfile(forge(schema), p);
        expect(e.recipes).toBe(p.recipes);
        expect(e.params).toBe(p.params);
        expect([e.warnings, e.selected, e.blockKeys]).toEqual([[], [], []]);
      });
    }
  }

  it("readsIntegrations is false at 1 and 2, true at 3 and at 4", () => {
    expect([1, 2, 3, 4].map((schema) => readsIntegrations({ schema } as Parameters<typeof readsIntegrations>[0]))).toEqual([false, false, true, true]);
  });
});

describe("effectiveProfile — schema 3", () => {
  it("a kind appends <slot>-<kind> after the profile's recipes, in block order; no kind, no recipe", () => {
    const e = effectiveProfile(forge(3), prof(FULL));
    expect(e.recipes).toEqual(["base", "stack-dotnet", "pm-azure-devops", "idp-mcp"]);
    expect(e.selected).toEqual([
      { slot: "pm", kind: "azure-devops", recipe: "pm-azure-devops" },
      { slot: "idp", kind: "mcp", recipe: "idp-mcp" },
    ]);
    expect(e.warnings).toEqual([]);
  });

  it("schema 4 reads the block exactly as 3 does", () => {
    expect(effectiveProfile(forge(4), prof(FULL))).toEqual(effectiveProfile(forge(3), prof(FULL)));
  });

  it("a recipe the profile already lists is not repeated, and keeps the position recipes gave it", () => {
    const e = effectiveProfile(forge(3), prof({ pm: { kind: "azure-devops" } }, { recipes: ["pm-azure-devops", "base"] }));
    expect(e.recipes).toEqual(["pm-azure-devops", "base"]);
    expect(e.selected).toEqual([{ slot: "pm", kind: "azure-devops", recipe: "pm-azure-devops" }]);
  });

  it("does not mutate the profile", () => {
    const p = prof(FULL, { params: { x: 1 } });
    const before = structuredClone(p);
    effectiveProfile(forge(3), p);
    expect(p).toEqual(before);
  });

  it("every scalar is the param integrations.<slot>.<key>, kind included, in block order", () => {
    const e = effectiveProfile(forge(3), prof(FULL));
    expect(Object.entries(e.params)).toEqual([
      ["integrations.pm.kind", "azure-devops"],
      ["integrations.pm.org", "acme"],
      ["integrations.pm.project", "Platform"],
      ["integrations.idp.kind", "mcp"],
      ["integrations.idp.url", "https://idp.example.com/mcp"],
      ["integrations.browser.chromeDevtools", "1.7.0"],
    ]);
    expect(e.blockKeys).toEqual(Object.keys(e.params));
    expect(Object.keys(e.params).every((k) => k.startsWith(INTEGRATIONS_PREFIX))).toBe(true);
  });

  it("numbers and booleans are params (0, false and \"\" too); null is absent; a mapping and a list are warned and skipped", () => {
    const e = effectiveProfile(forge(3), prof({ pm: { port: 8080, on: true, off: false, zero: 0, empty: "", org: null, labels: { a: 1 }, tags: ["x"] } }));
    expect(e.params).toEqual({ "integrations.pm.port": 8080, "integrations.pm.on": true, "integrations.pm.off": false, "integrations.pm.zero": 0, "integrations.pm.empty": "" });
    expect(e.warnings).toEqual([
      "profile acme: integrations.pm.labels is not a scalar — not available as a param",
      "profile acme: integrations.pm.tags is not a scalar — not available as a param",
    ]);
    expect(e.selected).toEqual([]);
    expect(e.recipes).toEqual(["base", "stack-dotnet"]);
  });

  it("an explicit params entry of the same key wins, and that key is not a block key", () => {
    const e = effectiveProfile(forge(3), prof({ pm: { org: "acme", project: "Platform" } }, { params: { "integrations.pm.org": "other", x: 1 } }));
    expect(e.params).toEqual({ "integrations.pm.org": "other", "integrations.pm.project": "Platform", x: 1 });
    expect(e.blockKeys).toEqual(["integrations.pm.project"]);
  });

  it("integrations: {} selects nothing and derives nothing", () => {
    const p = prof({}, { params: { a: 1 } });
    const e = effectiveProfile(forge(3), p);
    expect(e).toEqual({ recipes: ["base", "stack-dotnet"], params: { a: 1 }, warnings: [], selected: [], blockKeys: [] });
  });

  it("each malformed block is an error naming the profile and the key", () => {
    expect(err({ "my-slot": { kind: "x" } })).toBe(SLOT("my-slot"));
    expect(err({ "1pm": {} })).toBe(SLOT("1pm"));
    expect(err({ pm: "azure-devops" })).toBe("profile acme: integrations.pm is not a mapping");
    expect(err({ pm: ["a"] })).toBe("profile acme: integrations.pm is not a mapping");
    expect(err({ pm: 5 })).toBe("profile acme: integrations.pm is not a mapping");
    expect(err({ pm: null })).toBe("profile acme: integrations.pm is not a mapping");
    expect(err({ pm: { "api-url": "x" } })).toBe(KEY("api-url"));
    expect(err({ pm: { "a.b": "x" } })).toBe(KEY("a.b"));
    for (const kind of [5, true, "", "Azure", "-x", "a b", { a: 1 }, ["x"]]) expect(err({ pm: { kind } }), JSON.stringify(kind)).toBe(KIND);
  });

  it("kind: null is absent — no recipe, no error", () => {
    expect(err({ pm: { kind: null, org: "acme" } })).toBeNull();
    expect(effectiveProfile(forge(3), prof({ pm: { kind: null, org: "acme" } })).selected).toEqual([]);
  });

  it("the first fault in block order is the one thrown", () => {
    expect(err({ ok: { a: 1 }, "bad-one": {}, pm: "x" })).toBe(SLOT("bad-one"));
    expect(err({ pm: { org: { a: 1 }, "b-c": 1 } })).toBe(KEY("b-c"));
  });

  it("the same malformed blocks are silent below the gate", () => {
    for (const block of [{ "my-slot": 1 }, { pm: "x" }, { pm: { "a.b": 1 } }, { pm: { kind: 5 } }]) expect(err(block, 2)).toBeNull();
  });

  it("a slot or a key that is not shaped like a name is named by its position, never echoed (tech-debt integrations item 7)", () => {
    const user = "some" + "user";
    const pw = "PLACE" + "HOLDER" + "pw";
    const url = "https://" + user + ":" + pw + "@forge.example.com/acme";
    const slotMsg = err({ pm: { kind: "x" }, [url]: {} });
    expect(slotMsg).toBe("profile acme: integrations key #2 is not a slot name — letters, digits and _, starting with a letter (not shown: not shaped like a name)");
    const keyMsg = err({ pm: { org: "acme", [url]: "x" } });
    expect(keyMsg).toBe("profile acme: integrations.pm key #2 is not a key name — letters, digits and _ only (not shown: not shaped like a name)");
    for (const m of [slotMsg, keyMsg]) {
      expect(m).not.toContain(user);
      expect(m).not.toContain(pw);
    }
    // A bad name that looks like a name is still named, as before.
    expect(err({ "my-slot": { kind: "x" } })).toBe(SLOT("my-slot"));
    expect(err({ pm: { "api-url": "x" } })).toBe(KEY("api-url"));
    // A name-like key longer than 64 characters is not echoed either.
    expect(err({ pm: { ["k".repeat(70) + "-"]: "x" } })).toBe("profile acme: integrations.pm key #1 is not a key name — letters, digits and _ only (not shown: not shaped like a name)");
  });

  it("a slot or a key that is a token of a known format is not named either, even when it is shaped like a name", () => {
    const sk = "sk-" + "a".repeat(40);
    const slack = "xoxb-" + "1234567890" + "-" + "abcdefghij";
    expect(err({ pm: { kind: "x" }, [sk]: {} })).toBe("profile acme: integrations key #2 is not a slot name — letters, digits and _, starting with a letter (not shown: not shaped like a name)");
    expect(err({ pm: { [slack]: "x" } })).toBe("profile acme: integrations.pm key #1 is not a key name — letters, digits and _ only (not shown: not shaped like a name)");
  });
});

describe("integrationOrigin and recipesOrWritten", () => {
  it("names the slot and the profile", () => {
    expect(integrationOrigin("pm", "acme")).toBe("integrations.pm of profile acme");
  });

  it("a readable block: the effective recipes, no warning", () => {
    expect(recipesOrWritten(forge(3), prof({ pm: { kind: "azure-devops" } }))).toEqual({ recipes: ["base", "stack-dotnet", "pm-azure-devops"], warning: null });
  });

  it("a malformed block: the written recipes and the one warning", () => {
    expect(recipesOrWritten(forge(3), prof({ pm: "x" }))).toEqual({
      recipes: ["base", "stack-dotnet"],
      warning: "profile acme: integrations.pm is not a mapping — its recipes are read as written",
    });
  });

  it("below the gate a malformed block is not read: no warning", () => {
    expect(recipesOrWritten(forge(2), prof({ pm: "x" }))).toEqual({ recipes: ["base", "stack-dotnet"], warning: null });
  });
});

describe("one reader", () => {
  // Comments are dropped first, so prose may say "profile.integrations"; a URL inside a string loses its tail, which this check never needs.
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const ACCESS = /\.integrations\b|\[\s*["'`]integrations["'`]\s*\]/;

  it("no file under src/ but src/core/integrations.ts reads a property named integrations", async () => {
    const root = path.resolve(__dirname, "../src");
    const offenders: string[] = [];
    for (const rel of await listFiles(root)) {
      if (!rel.endsWith(".ts") || rel === "core/integrations.ts") continue;
      if (ACCESS.test(code(await fs.readFile(path.join(root, rel), "utf8")))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("(control) the check sees an access and ignores a comment and an object key", () => {
    expect(ACCESS.test(code("const x = profile.integrations;"))).toBe(true);
    expect(ACCESS.test(code('const x = profile["integrations"];'))).toBe(true);
    expect(ACCESS.test(code("// reads profile.integrations\nconst p = { integrations: {} };"))).toBe(false);
    expect(ACCESS.test(code("/* profile.integrations */ const k = `integrations.${slot}`;"))).toBe(false);
  });
});
