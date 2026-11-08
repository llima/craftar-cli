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
  // to differ only by those warning lines and doctor's resulting `plan` `ok` line and summary. All three moved again for 1.9.0:
  // `status --json` gains `forge.newerTag`, null here; regenerated with their flags, checked by script to differ only by that key.
  "agents-md-primary-off": "0dd238664fba6d830ba7bd646a03b29d33e66fee6dfdfd6e7f9cdd263035f442",
  "profile-local-off": "0c8762015e0b291e895301a30b169ef40d03e449fc08aa20a81919803b4e8892",
  "real-path-containment-off": "106387738d62f76e53e47f13be0ac209f5067174d9a5e518c3409d046f75e984",
  "rules-index-off": "714aee5b5a594ac5ad201bc4051ba8e4da6850750ccdb712f471889766e32796",
  "target-sections-off": "0828cb9c57f43e125ad4e6935e86f1649651523c33a95b82d435e6a47ea224b1",
};
// All three moved for 1.9.0 by `forge.newerTag: null` in their status documents alone (regenerated with their flags, checked by
// script); they still hold no skill.
const UNMOVED: Record<string, string> = {
  "check-committed-off": "e33c21772d13714b8316a568c49012c5457163c0454b5bb20a5a62673dc70ba3",
  // metadata-params-off's hash moved for spec 57 (kiro writes LF on a new file) and for 1.5.0 (an agent's empty tools line left
  // out, checked by script), and for 1.8.0 (the covered agents-md skip warning silent, checked by script); it still holds no skill.
  "metadata-params-off": "2d09c1a9c71465079dccbe20afff4d9d5fed32fa1e19fd62ab82a9b32f5f2a4a",
  "settings-apply-off": "ef5ff800ae852a3d11593b5f31c0eb302d22e6a26b326a4f6545d0c45d1f410d",
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
