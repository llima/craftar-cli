import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 36 §9: the README says what `craftar ui` is — one row, loopback, the run token — and no longer lists it as unbuilt.

const README = readFileSync(path.resolve(__dirname, "../README.md"), "utf8");
const count = (needle: string): number => README.split(needle).length - 1;

describe("README — craftar ui", () => {
  it("one Commands row; loopback and the run token said once", () => {
    expect(count("| `craftar ui [--port <n>] [--allow-writes]` |")).toBe(1);
    expect(count("it listens on `127.0.0.1`")).toBe(1);
    expect(count("needs a token generated for that run")).toBe(1);
    // Spec 37 moved Phase 1's `Next:` item to its shipped list, so the entry is no longer followed by `. Next:`.
    expect(count("`craftar ui` (a local, read-only dashboard of the registered workspaces, on `127.0.0.1` only)")).toBe(1);
    expect(count("### to 0.30.0")).toBe(1);
  });

  it("no longer listed as not built, nor under Later", () => {
    // Since spec 37 no line says what is not built; whatever line says it again must not name craftar ui.
    for (const l of README.split("\n").filter((x) => x.includes("is not built yet."))) expect(l.slice(l.lastIndexOf("Everything else"))).not.toContain("craftar ui");
    const later = README.split("\n").filter((l) => l.startsWith("Later:"));
    expect(later).toHaveLength(1);
    expect(later[0]).not.toContain("craftar ui");
  });
});

// Spec 37 §9: the two repos rows, the Repositories paragraph, the roadmap item shipped, the status line's last sentence.
describe("README — init --clone and craftar repos", () => {
  it("one row each, one Repositories paragraph, the roadmap item shipped, no `Next: cloning`", () => {
    expect(count("| `craftar repos [--workspace .] [--offline] [--json]` |")).toBe(1);
    expect(count("| `craftar repos clone [<name>…] [--workspace .]` |")).toBe(1);
    expect(count("[--clone \\| --no-clone]")).toBe(1);
    expect(count("**Repositories.** A profile's `repos`")).toBe(1);
    expect(count("; cloning a profile's repositories (`init --clone`, `craftar repos`); a new profile from `craftar init` (`--new-profile`, `--like`); writing tools for `craftar mcp` (`--allow-writes`: `sync`, `add_recipe`, `remove_recipe`, behind a consent typed per workspace); writing actions in `craftar ui` (`--allow-writes`: Sync and Discard edit, confirmed in the page).")).toBe(1);
    expect(count("Next: cloning")).toBe(0);
    expect(count("Everything else in the spec (cloning a profile's repositories at init) is not built yet.")).toBe(0);
  });
});

// Spec 40 §6: craftar ui --allow-writes
describe("README — craftar ui --allow-writes", () => {
  it("the new README text for --allow-writes appears once each", () => {
    expect(count("**Read-only unless `--allow-writes`**")).toBe(1);
    expect(count("started with `--allow-writes`, it also syncs a workspace or discards one hand-edited file")).toBe(1);
    expect(count("### to 0.37.0")).toBe(1);
  });
});
