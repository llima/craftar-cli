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
  // pins were checked by script to differ only by that line and its hashes). They, and real-path-containment-off, moved again for
  // 1.8.0: the agents-md skip of an ingredient another target writes is silent — regenerated with their flags, checked by script
  // to differ only by those warning lines and doctor's resulting `plan` `ok` line and summary.
  "agents-md-primary-off": "854ebd1c710035d67ec4bc993e96a6c33407fd39bab666f2b666e243ad2f46bc",
  "profile-local-off": "0c8762015e0b291e895301a30b169ef40d03e449fc08aa20a81919803b4e8892",
  "real-path-containment-off": "af774a0592577dafbc01016611f3b3f3185ea594edcdfed772517e5d002a60bc",
  "rules-index-off": "5abdc02a3149bfcde42559fea8822378460078cbc011d180961830c1705f8730",
  "target-sections-off": "0828cb9c57f43e125ad4e6935e86f1649651523c33a95b82d435e6a47ea224b1",
};
const UNMOVED: Record<string, string> = {
  "check-committed-off": "a23e75649bb333461ba89e062c192bae2ce2659a6a7b693c744034974aa1c976",
  // metadata-params-off's hash moved for spec 57 (kiro writes LF on a new file) and for 1.5.0 (an agent's empty tools line left
  // out, checked by script), and for 1.8.0 (the covered agents-md skip warning silent, checked by script); it still holds no skill.
  "metadata-params-off": "0268283979272317aab549f7bcfa854fda879d2a33e12b3756a475a37b69cedf",
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
