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
  // agents-md-primary-off and rules-index-off moved for 1.5.0 (claude-code leaves out an agent's empty tools line; the regenerated
  // pins were checked by script to differ only by that line and its hashes).
  "agents-md-primary-off": "a491269a773b7629560b85e32833b4739142322623c03df1d15d123df51a0656",
  "profile-local-off": "0c8762015e0b291e895301a30b169ef40d03e449fc08aa20a81919803b4e8892",
  "real-path-containment-off": "e55dbd181272524088b1974f67824470dec4df888424e1467a190adcde182aca",
  "rules-index-off": "bf2f8f6b6e387363a5037b521e6ed5785e236b538dec4cf310081f18bf593f03",
  "target-sections-off": "0828cb9c57f43e125ad4e6935e86f1649651523c33a95b82d435e6a47ea224b1",
};
const UNMOVED: Record<string, string> = {
  "check-committed-off": "a23e75649bb333461ba89e062c192bae2ce2659a6a7b693c744034974aa1c976",
  // metadata-params-off's hash moved for spec 57 (kiro writes LF on a new file) and for 1.5.0 (an agent's empty tools line left
  // out, checked by script); it still holds no skill.
  "metadata-params-off": "9e524be2a9a87e54d3ea8367836290c7a8c092699764238abd12b7a821887505",
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
