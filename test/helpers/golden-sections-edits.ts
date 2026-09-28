/**
 * The hand edits of the sections golden round trip (spec 11 §10.5), as data, for
 * `test/golden-sections.test.ts`.
 *
 * Inputs: `test/golden/sections-acme/` and `test/golden/sections-globex/` hold a hand-written
 * `.claude/rules/` (`review-posture.md`, which differs only in its reviewer table, and `shared.md`)
 * and the `.kiro/steering/` the craftar 0.6.2 emitter produced from it. They were made once, in a
 * throwaway copy of the 0.6.2 tree (`git archive 3b65826`, `npm ci --ignore-scripts`), as spec 10
 * §10.5 built `initech`: import each workspace's `.claude/` into a scratch Forge with
 * `--write-config`, add `kiro` to the profile's and the workspace's `targets`, `sync`, and copy the
 * written `.kiro/steering/` back. They change only with the emitter, and never by hand.
 *
 * The expected Forge after step 6, `test/golden/forge-sections-expected/`, is regenerated only with
 * the user's confirmation, and its diff reviewed like code:
 *   CRAFTAR_REGEN_GOLDEN_SECTIONS=1 npx vitest run test/golden-sections.test.ts
 */

export const OPEN = "<!-- craftar:section flavors -->\n";
export const CLOSE = "<!-- /craftar:section -->\n";

/** Step 3: wrap the rule's one table (its contiguous `|` lines) in `flavors` markers. */
export function addFlavorsMarkers(rule: string): string {
  const lines = rule.split(/(?<=\n)/);
  const first = lines.findIndex((l) => l.startsWith("|"));
  let last = first;
  while (last + 1 < lines.length && lines[last + 1].startsWith("|")) last++;
  if (first === -1 || lines.slice(last + 1).some((l) => l.startsWith("|"))) throw new Error("expected exactly one table in the rule");
  return [...lines.slice(0, first), OPEN, ...lines.slice(first, last + 1), CLOSE, ...lines.slice(last + 1)].join("");
}

/**
 * Step 1: `agents-md` appended to a block `targets` list. Applied to both profiles and, because
 * `--write-config` pins `targets` in `craftar.yaml` and a workspace's `targets` replace the
 * profile's (`resolve`), to both workspaces' `craftar.yaml` too.
 */
export function addAgentsMd(yaml: string): string {
  const out = yaml.replace(/^(targets:\n(?: {2}- .*\n)+)/m, "$1  - agents-md\n");
  if (out === yaml) throw new Error("expected a block targets list");
  return out;
}

/** Step 10: one more row in globex's reviewer table. */
export function addGlobexRow(rule: string): string {
  const row = "| `globex-desktop` | desktop-reviewer |\n";
  if (!rule.includes(row)) throw new Error("expected globex's desktop row");
  return rule.replace(row, `${row}| \`globex-mobile\` | mobile-reviewer |\n`);
}
