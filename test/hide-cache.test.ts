import path from "node:path";
import { describe, expect, it } from "vitest";
import { hideCacheSegment, hideUnvouched, vouchedKeys } from "../src/core/registry.js";
import { UNVOUCHED_HIDDEN } from "../src/core/remote.js";
import { RegistryEntrySchema } from "../src/schema/index.js";

const KEY = "fake" + "user-" + "nota" + "secret-example.invalid-f-0123456789ab";

describe("hideCacheSegment (spec 39 §5.1, the no-snapshot rule)", () => {
  const cases: Array<[string, string]> = [
    ["a plain home", "/tmp/h"],
    ["a home holding $&", "/tmp/h$&x"],
    ["a home holding $1", "/tmp/h$1x"],
    ["a home holding $` and $'", "/tmp/h$`$'x"],
    ["a home holding regex characters", "/tmp/h.(+)*[x]"],
    ["the root as home", "/"],
  ];
  for (const [name, home] of cases)
    it(`${name}: the segment after forges/ is the label, the key never printed`, () => {
      const resolved = path.resolve(home);
      const msg = `EACCES: permission denied, open '${path.join(resolved, "forges", KEY, "fetched")}'`;
      const out = hideCacheSegment(msg, home);
      expect(out.includes(KEY), out).toBe(false);
      expect(out).toContain(UNVOUCHED_HIDDEN);
    });
  it("either separator after forges, and a ~removing- name, are replaced whole", () => {
    const out = hideCacheSegment(`rmdir '/tmp/h\\forges\\~removing-${KEY}-4242\\repo.git'`, "/tmp/h");
    expect(out.includes(KEY)).toBe(false);
    expect(out).toContain(UNVOUCHED_HIDDEN);
  });
  it("text that names no cache entry is given back as it is", () => {
    expect(hideCacheSegment("cannot read /tmp/h/forges: not a directory", "/tmp/h")).toBe("cannot read /tmp/h/forges: not a directory");
  });
});

/** Build a minimal RegistryEntry, validated through the schema. */
function entry(over: {
  path?: string;
  profile?: string;
  forge: { kind: "path"; source: string; key: string | null } | { kind: "remote"; source: string; key: string; ref: string | null };
  lastSync?: string;
}) {
  const base = {
    path: over.path ?? "/ws",
    profile: over.profile ?? "acme",
    forge: {
      kind: over.forge.kind,
      source: over.forge.source,
      key: over.forge.key,
      ref: over.forge.kind === "remote" ? over.forge.ref : null,
      commit: null,
      fromLocalFile: false,
    },
    recipes: ["base"],
    stack: {},
    targets: ["claude-code"],
    lastSync: over.lastSync ?? "2026-01-01T00:00:00.000Z",
  };
  return RegistryEntrySchema.parse(base);
}

describe("hideUnvouched and vouchedKeys (spec 39 §3, §5.1)", () => {
  it("hideUnvouched replaces each key by the label and ignores an empty key", () => {
    expect(hideUnvouched(`forges/${KEY}/trees`, [KEY])).toBe(`forges/${UNVOUCHED_HIDDEN}/trees`);
    expect(hideUnvouched("forges/abc", [""])).toBe("forges/abc");
  });
  it("vouchedKeys: empty with no registry or no named map; a key both named and flagged is not vouched", () => {
    const named = new Map([["clean-key", ["/ws/a"]], ["flagged-key", ["/ws/b"]]]);
    expect(vouchedKeys(named, null).size).toBe(0);
    expect(vouchedKeys(new Map(), { schema: 1, workspaces: [] } as never).size).toBe(0);
    const reg = { schema: 1 as const, workspaces: [
      entry({ path: "/ws/a", forge: { kind: "remote", source: "https://example.invalid/a.git", key: "clean-key", ref: null } }),
      entry({ path: "/ws/b", forge: { kind: "remote", source: "https://" + "u" + ":" + "p" + "@example.invalid/b.git", key: "flagged-key", ref: null } }),
    ] };
    expect([...vouchedKeys(named, reg)]).toEqual(["clean-key"]);
  });
});
