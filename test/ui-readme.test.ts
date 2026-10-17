import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 36 §9: the README says what `craftar ui` is — one row, loopback, the run token — and no longer lists it as unbuilt.

const README = readFileSync(path.resolve(__dirname, "../README.md"), "utf8");
const count = (needle: string): number => README.split(needle).length - 1;

describe("README — craftar ui", () => {
  it("one Commands row; loopback and the run token said once", () => {
    expect(count("| `craftar ui [--port <n>]` |")).toBe(1);
    expect(count("it listens on `127.0.0.1`")).toBe(1);
    expect(count("needs a token generated for that run")).toBe(1);
    expect(count("`craftar ui` (a local, read-only dashboard of the registered workspaces, on `127.0.0.1` only). Next:")).toBe(1);
    expect(count("### to 0.30.0")).toBe(1);
  });

  it("no longer listed as not built, nor under Later", () => {
    const unbuilt = README.split("\n").filter((l) => l.includes("is not built yet."));
    expect(unbuilt).toHaveLength(1);
    expect(unbuilt[0]).toContain("Everything else in the spec");
    expect(unbuilt[0].slice(unbuilt[0].lastIndexOf("Everything else in the spec"))).not.toContain("craftar ui");
    const later = README.split("\n").filter((l) => l.startsWith("Later:"));
    expect(later).toHaveLength(1);
    expect(later[0]).not.toContain("craftar ui");
  });
});
