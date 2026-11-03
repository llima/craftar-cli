import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Spec 55 §9: Part C regenerated five doctor pins. Each pin, with every skill-trigger check and line taken out, must hash to
 * what the pin held before Part C (the hashes below were taken from `main` @ 9c7a8f2, the base of this build) — so the
 * regeneration added skill-trigger lines and changed nothing else. The three doctor pins that hold no skill must not move.
 */

const pin = (n: string) => readFileSync(path.resolve(__dirname, `pins/${n}.json`), "utf8");
const isTrigger = (x: unknown) =>
  (typeof x === "object" && x !== null && (x as { id?: unknown }).id === "skill-trigger") ||
  (typeof x === "string" && (x.includes("does not say when to use it") || x.includes("Use when …")));
function strip(x: unknown): unknown {
  if (Array.isArray(x)) return x.filter((e) => !isTrigger(e)).map(strip);
  if (typeof x === "string" && x.includes("\n")) return x.split("\n").filter((l) => !isTrigger(l)).join("\n");
  if (typeof x === "object" && x !== null) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, strip(v)]));
  return x;
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const STRIPPED: Record<string, string> = {
  "agents-md-primary-off": "6e15cbd74dc1a81abccdd92deba24000039da606c2a69937cedf75f48ac54c0f",
  "profile-local-off": "43ab9ff612369fcef7ecf7a0f60a6296c08a1df1d4d92bc47e6230001dddd399",
  "real-path-containment-off": "f8a463411d18475556e0f81a85364eb98f27e21939b917ec4e0473e24dd81ed1",
  "rules-index-off": "da64b90a15b0b33a18889ad426bc581deb46b90b6b11661f4e10a7fda5969d28",
  "target-sections-off": "6d73f92c4d8bcc08698aadcc8a0365abf71729e3a885f9aec82bfbd267df9506",
};
const UNMOVED: Record<string, string> = {
  "check-committed-off": "a23e75649bb333461ba89e062c192bae2ce2659a6a7b693c744034974aa1c976",
  "metadata-params-off": "652d87547140bd7f3e701a494c7fbe534cff244478f4b2cf9c43555d11ddb60b",
  "settings-apply-off": "1369dc58b74b5c287edb7885680b92c8a11c455d32cf9eb3b178adf27e4d2676",
};

describe("the pins Part C regenerated changed only by skill-trigger lines (spec 55 §9)", () => {
  it.each(Object.keys(STRIPPED))("%s", (n) => {
    expect(sha(JSON.stringify(strip(JSON.parse(pin(n)))))).toBe(STRIPPED[n]);
    expect(pin(n)).toContain("skill-trigger");
  });
  it.each(Object.keys(UNMOVED))("%s holds no skill and did not move", (n) => {
    expect(sha(pin(n))).toBe(UNMOVED[n]);
    expect(pin(n)).not.toContain("skill-trigger");
  });
});
