import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { FORGE_SCHEMA_METADATA_PARAMS } from "../src/schema/index.js";
import { runCli } from "./helpers/cli.js";
import { acmePrimary } from "./helpers/agents-md-primary.js";
type Scenario = Awaited<ReturnType<typeof acmePrimary>>;

/**
 * Spec 50 §11 item 21: a round trip at the metadata gate under agents-md.primary, with the rules index in the same
 * Forge — sync, then re-import into the Forge it came from: every base reused, nothing created, the Forge unchanged.
 */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

async function snapshot(root: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const walk = async (dir: string) => {
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) await walk(abs);
      else out.set(path.relative(root, abs).split(path.sep).join("/"), await fs.readFile(abs));
    }
  };
  await walk(root);
  return out;
}

async function rewrite(file: string, f: (text: string) => string) {
  const text = await fs.readFile(file, "utf8");
  const next = f(text);
  expect(next).not.toBe(text);
  await fs.writeFile(file, next);
}

describe("spec 50 §11 item 21: a round trip at the metadata gate", () => {
  it("under agents-md.primary with the rules index: every base reused, the Forge unchanged", async () => {
    const s = kept(await acmePrimary({ schema: 5 }));
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    const forge2 = path.join(s.root, "forge2");
    expect(runCli(["import", "--from", "claude-code", "--forge", forge2, "--profile", "acme", "--workspace", s.wsRoot, "--write-config"]).code).toBe(0);
    await fs.writeFile(path.join(s.wsRoot, "craftar.yaml"), YAML.stringify({ forge: "../forge2", profile: "acme", targets: ["claude-code", "kiro", "agents-md"] }));

    // The Forge at the gate, with the mode on, the index in an always-on rule and metadata that cites {{org}}.
    await rewrite(path.join(forge2, "craftar.forge.yaml"), (t) => YAML.stringify({ ...YAML.parse(t), schema: FORGE_SCHEMA_METADATA_PARAMS }));
    await rewrite(path.join(forge2, "profiles/acme/profile.yaml"), (t) => {
      const doc = YAML.parse(t);
      return YAML.stringify({ ...doc, params: { ...doc.params, "agents-md.primary": true, org: "acme", area: "src/api" } });
    });
    await rewrite(path.join(forge2, "ingredients/rules/style/rule.md"), (t) => `${t}\n{{craftar.rules.index}}\n`);
    // A rule's description reaches no file import reads (spec 44's known limit), so the rule's templated field is its pattern.
    await rewrite(path.join(forge2, "ingredients/rules/api/ingredient.yaml"), (t) => {
      const doc = YAML.parse(t);
      expect(doc.fileMatchPattern).toBe("src/api/**");
      return YAML.stringify({ ...doc, fileMatchPattern: "{{area}}/**" });
    });
    await rewrite(path.join(forge2, "ingredients/agents/api-reviewer/ingredient.yaml"), (t) => t.replaceAll("Reviews API changes", "Reviews {{org}} API changes"));
    await rewrite(path.join(forge2, "ingredients/commands/review/ingredient.yaml"), (t) => t.replaceAll("Run a review", "Run an {{org}} review"));

    const synced = runCli(["sync", "--workspace", s.wsRoot]);
    expect(synced.code, synced.stderr).toBe(0);
    // What the round trip has to reproduce: rendered metadata, the rewording and the index, all on disk.
    expect(await fs.readFile(path.join(s.wsRoot, ".claude/agents/api-reviewer.md"), "utf8")).toContain("Reviews acme API changes against AGENTS.md (rule: style)");
    expect(await fs.readFile(path.join(s.wsRoot, ".claude/commands/review.md"), "utf8")).toContain("Run an acme review");
    expect(await fs.readFile(path.join(s.wsRoot, ".kiro/steering/api.md"), "utf8")).toContain('fileMatchPattern: "src/api/**"');
    expect(await fs.readFile(path.join(s.wsRoot, "AGENTS.md"), "utf8")).toContain("- `.claude/rules/api.md` (applies to `src/api/**`)");

    const before = await snapshot(forge2);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-report-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const report = path.join(dir, "report.md");
    const r = runCli(["import", "--from", "claude-code", "--forge", forge2, "--profile", "acme", "--workspace", s.wsRoot, "--report", report]);
    expect(r.code, r.stderr).toBe(0);
    const text = await fs.readFile(report, "utf8");
    expect(text).toContain("## Variants (0)");
    expect(text).toContain("## Created (0)");
    const after = await snapshot(forge2);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, v] of before) expect(after.get(k)!.equals(v), k).toBe(true);
  });
});
