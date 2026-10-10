import { parseFrontmatter } from "../core/frontmatter.js";
import type { ResolvedIngredient } from "../core/resolve.js";
import { buildRuleLookup, resolveRuleRefs, RULE_NAME_CHARS } from "../emitters/shared.js";
import { IngredientSchema } from "../schema/index.js";
import { GENERATED_BANNER } from "./kiro-report.js";

// Spec 29 §4.3 — `import --prefer-kiro`: a rule's source text read back from its Kiro steering mirror, and the proof
// that sync would render that text to the steering body it came from. Pure: no file is read here.

/** `--prefer-kiro a,b`: the names, trimmed, in the order given. Throws PK5 for an empty or a repeated name. */
export function parsePreferKiro(value: string): string[] {
  const names = value.split(",").map((n) => n.trim());
  const seen = new Set<string>();
  for (const n of names) {
    if (!n) throw new Error("--prefer-kiro: an empty rule name");
    if (seen.has(n)) throw new Error(`--prefer-kiro: ${n} is named twice`);
    seen.add(n);
  }
  return names;
}

/**
 * A steering file's text without its frontmatter and its opening banner — the default one, or the line the importing
 * profile's `kiro.banner` renders for this rule — with the one blank line the emitter puts after it. `steering` is LF,
 * BOM-less. A banner lower in the body is the user's text and stays.
 */
export function steeringBody(steering: string, name: string, banner: string | null): string {
  const body = parseFrontmatter(steering).body.replace(/^\n+/, "");
  const nl = body.indexOf("\n");
  const first = nl === -1 ? body : body.slice(0, nl);
  const own = banner !== null && first === banner.replace("{{source}}", `.claude/rules/${name}.md`);
  if (!GENERATED_BANNER.test(first) && !own) return body;
  return (nl === -1 ? "" : body.slice(nl + 1)).replace(/^\n/, "");
}

// `.kiro/steering/`, then `commands/`, or a name and `.md` at the right boundary `resolveRuleRefs` uses for a reference.
const STEERING_PATH = new RegExp(`\\.kiro/steering/(commands/)?(?:([${RULE_NAME_CHARS}]+?)\\.md(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-]))?`, "g");

/**
 * The inverse of the kiro emitter's rewrite: every `.kiro/steering/` becomes `.claude/rules/`, except a path under
 * `commands/` and a reference to a hand-written steering file — a steering name that is no rule — which the emitter
 * never rewrote.
 */
export function ruleTextOf(body: string, rules: ReadonlySet<string>, handSteering: ReadonlySet<string>): string {
  return body.replace(STEERING_PATH, (m: string, commands: string | undefined, x: string | undefined) => {
    if (commands) return m;
    if (x !== undefined && handSteering.has(x) && !rules.has(x)) return m;
    return ".claude/rules/" + m.slice(".kiro/steering/".length);
  });
}

// What kiro writes for a rule it does not write (spec 17 §4.3): its four forms hold one of these three. Each is named
// by a fixed label, never by the text matched — a refusal is printed before anything was scanned for secrets.
const UNCERTAIN: Array<{ form: string; at: RegExp }> = [
  { form: "AGENTS.md (rule: <x>)", at: /AGENTS\.md \(rule: [^)\n]+\)/ },
  { form: "](AGENTS.md)", at: /\]\(AGENTS\.md\)/ },
  { form: "rule not in this workspace)", at: /rule not in this workspace\)/ },
];

/** PK3: the first line holding a form kiro writes for a rule it does not write, 1-based within `body`, and that form's label; null when none. */
export function uncertainForm(body: string): { line: number; form: string } | null {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const hit = UNCERTAIN.map((u) => ({ form: u.form, index: lines[i].search(u.at) }))
      .filter((u) => u.index !== -1)
      .sort((a, b) => a.index - b.index)[0];
    if (hit) return { line: i + 1, form: hit.form };
  }
  return null;
}

export interface PreferKiroInput {
  name: string;
  /** `.kiro/steering/<name>.md` as read: LF, BOM-less. */
  steering: string;
  /** Every rule of the imported workspace. */
  rules: ReadonlySet<string>;
  /** Its steering files that are no rule's mirror. */
  handSteering: ReadonlySet<string>;
  /** The importing profile's `kiro.banner`, when it sets one. */
  banner: string | null;
}

/**
 * The rule's source text built from its steering file, the steering body it was proved against — rendered for kiro over
 * the workspace's own rules, the text gives that body back — and `offset`, the lines of the file above that body.
 * Throws PK3 for a form with no certain source and PK4 for a body that does not come back; both name a line of the
 * steering file and quote none of it. The proof is over the body: the frontmatter and the banner are sync's to write.
 */
export function preferKiro(i: PreferKiroInput): { text: string; body: string; offset: number } {
  const body = steeringBody(i.steering, i.name, i.banner);
  // The lines the frontmatter and the banner took, so a line of `body` is named as the file has it.
  const offset = i.steering.split("\n").length - body.split("\n").length;
  const where = `import: --prefer-kiro ${i.name}: .kiro/steering/${i.name}.md line`;
  const drop = `edit the steering file or drop ${i.name} from --prefer-kiro`;
  const form = uncertainForm(body);
  if (form) throw new Error(`${where} ${form.line + offset} holds "${form.form}", which Kiro writes for a rule it does not have — that form has no certain source; ${drop}`);
  const text = ruleTextOf(body, i.rules, i.handSteering);
  // The lookup import's own metadata gives: a rule aimed at every target, a hand-written steering file at kiro.
  const entry = (type: "rule" | "steering", name: string): ResolvedIngredient => ({
    ref: `${type}/${name}`,
    dir: "",
    meta: IngredientSchema.parse(type === "rule" ? { type, name, file: "rule.md", targets: "*" } : { type, name, file: "steering.md", targets: ["kiro"] }),
    via: [],
  });
  const lookup = buildRuleLookup([
    ...[...i.rules].map((n) => entry("rule", n)),
    ...[...i.handSteering].filter((n) => !i.rules.has(n)).map((n) => entry("steering", n)),
  ]);
  const back = resolveRuleRefs(text, `rule/${i.name}`, lookup, ["claude-code", "kiro"], "kiro").text;
  if (back !== body) {
    const a = back.split("\n");
    const b = body.split("\n");
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    throw new Error(`${where} ${n + 1 + offset} would not come back from the rule built from it — it names .claude/rules/ where sync writes .kiro/steering/; ${drop}`);
  }
  return { text, body, offset };
}
