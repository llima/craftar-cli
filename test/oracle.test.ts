import { describe, it, expect, beforeAll } from "vitest";
import { promises as fs, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { loadWorkspace, plan, status, apply, readLock } from "../src/core/sync.js";
import { listFiles } from "../src/core/forge.js";
import { hasBom } from "../src/core/text.js";

/**
 * The oracle runs against a real workspace, which is never committed: it is
 * client material. Point CRAFTAR_ORACLE_FIXTURE at one, or drop a single
 * workspace directory into `fixtures/`. Without a fixture this suite is
 * skipped and the rest of the tests still run.
 */
function findFixture(): string | null {
  const fromEnv = process.env.CRAFTAR_ORACLE_FIXTURE;
  if (fromEnv) return path.resolve(fromEnv);
  const dir = path.resolve(__dirname, "../fixtures");
  let dirs: string[];
  try {
    dirs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return null;
  }
  return dirs.length === 1 ? path.join(dir, dirs[0]) : null;
}

const FOUND = findFixture();
const LEGACY_BANNER = "<!-- GENERATED from {{source}} by .claude/scripts/sync-steering.ps1 -- do not edit. -->";

let tmp: string;
let ws: string;
let forge: string;

async function cp(src: string, dst: string) {
  await fs.mkdir(dst, { recursive: true });
  for (const rel of await listFiles(src)) {
    await fs.mkdir(path.dirname(path.join(dst, rel)), { recursive: true });
    await fs.copyFile(path.join(src, rel), path.join(dst, rel));
  }
}

describe.skipIf(!FOUND)("oracle: real workspace (sync-steering.ps1 output)", () => {
  const FIXTURE = FOUND as string;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-oracle-"));
    ws = path.join(tmp, "workspace");
    forge = path.join(tmp, "forge");
    await cp(FIXTURE, ws);
    await importClaudeCode({ workspaceRoot: ws, forgeRoot: forge, profileName: "acme-portal", writeWorkspaceConfig: true });
    await fs.appendFile(path.join(ws, "craftar.yaml"), `overrides:\n  params:\n    kiro.banner: ${JSON.stringify(LEGACY_BANNER)}\n`);
  });

  it("import → plan reproduces every existing .claude and .kiro file (adopt, never collision)", async () => {
    const w = await loadWorkspace(ws);
    const p = await plan(w);
    const st = await status(w, p, null);
    const collisions = st.filter((s) => s.state === "collision").map((s) => s.path);
    expect(collisions).toEqual([]);
    const adopted = st.filter((s) => s.state === "adopt").map((s) => s.path);
    // 13 generated steering + 5 hand-written + README + 3 kiro agents + all .claude files
    expect(adopted).toEqual(expect.arrayContaining([".kiro/steering/workflow.md", ".kiro/steering/product.md", ".kiro/agents/frontend-reviewer.json", ".mcp.json"]));
    const rules = (await listFiles(path.join(FIXTURE, ".claude/rules"))).filter((r) => r.endsWith(".md")).map((r) => `.claude/rules/${r}`);
    expect(rules.length).toBeGreaterThan(0);
    expect(adopted).toEqual(expect.arrayContaining(rules));
    expect(adopted.length).toBeGreaterThanOrEqual(50);
  });

  it("sync writes byte-identical steering (CRLF, no BOM) and a second sync is a no-op", async () => {
    const w = await loadWorkspace(ws);
    const p = await plan(w);
    await apply(w, p, await status(w, p, null));
    for (const rel of await listFiles(path.join(FIXTURE, ".kiro"))) {
      if (rel.startsWith("specs/")) continue;
      const a = await fs.readFile(path.join(FIXTURE, ".kiro", rel));
      const b = await fs.readFile(path.join(ws, ".kiro", rel));
      expect(b.equals(a), `.kiro/${rel} differs`).toBe(true);
      if (rel.endsWith(".md")) {
        expect(hasBom(b)).toBe(false);
        expect(b.toString("utf8").includes("\r\n")).toBe(true);
      }
    }
    const again = await apply(w, p, await status(w, p, await readLock(ws)));
    expect(again.written).toEqual([]);
    expect(again.removed).toEqual([]);
  });

  it("a Forge change flows to every target; a hand edit becomes drift and is never overwritten silently", async () => {
    await fs.appendFile(path.join(forge, "ingredients/rules/workflow/rule.md"), "\nNova regra.\n");
    const w = await loadWorkspace(ws);
    let st = await status(w, await plan(w), await readLock(ws));
    expect(st.filter((s) => s.state === "update").map((s) => s.path)).toEqual([".claude/rules/workflow.md", ".kiro/steering/workflow.md"]);

    await fs.appendFile(path.join(ws, ".kiro/steering/worktrees.md"), "\r\nEDITADO NA MAO\r\n");
    const p = await plan(w);
    st = await status(w, p, await readLock(ws));
    expect(st.find((s) => s.path === ".kiro/steering/worktrees.md")?.state).toBe("drift");
    const r = await apply(w, p, st);
    expect(r.skipped.map((s) => s.path)).toEqual([".kiro/steering/worktrees.md"]);
    expect((await fs.readFile(path.join(ws, ".kiro/steering/worktrees.md"), "utf8")).includes("EDITADO NA MAO")).toBe(true);
  });

  it("removing an ingredient from a recipe removes its orphans in every target", async () => {
    const recipe = path.join(forge, "recipes/base.yaml");
    await fs.writeFile(recipe, (await fs.readFile(recipe, "utf8")).replace("  - rule/handoff\n", ""));
    const w = await loadWorkspace(ws);
    const p = await plan(w);
    const r = await apply(w, p, await status(w, p, await readLock(ws)));
    expect(r.removed.sort()).toEqual([".claude/rules/handoff.md", ".kiro/steering/handoff.md"]);
  });

  it("files craftar never generated are left alone", async () => {
    const stray = path.join(ws, ".claude/rules/minha-regra-local.md");
    await fs.writeFile(stray, "# local\n");
    const w = await loadWorkspace(ws);
    const p = await plan(w);
    await apply(w, p, await status(w, p, await readLock(ws)));
    expect(await fs.readFile(stray, "utf8")).toBe("# local\n");
  });
});
