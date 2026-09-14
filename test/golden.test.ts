import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { importClaudeCode } from "../src/importers/claude-code.js";
import { apply, loadWorkspace, plan, readLock, status } from "../src/core/sync.js";
import { listFiles } from "../src/core/forge.js";
import { hasBom } from "../src/core/text.js";

/** The oracle script, run over committed synthetic workspaces — no client material, runs everywhere. */
const GOLDEN = path.resolve(__dirname, "golden");

let tmp: string;
let portal: string;
let web: string;
let forge: string;

async function cp(src: string, dst: string) {
  for (const rel of await listFiles(src)) {
    await fs.mkdir(path.dirname(path.join(dst, rel)), { recursive: true });
    await fs.copyFile(path.join(src, rel), path.join(dst, rel));
  }
}
async function syncOnce(root: string) {
  const w = await loadWorkspace(root);
  const p = await plan(w);
  return { p, r: await apply(w, p, await status(w, p, await readLock(root))) };
}

describe("golden: synthetic acme workspaces", () => {
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-golden-"));
    portal = path.join(tmp, "acme-portal");
    web = path.join(tmp, "acme-web");
    forge = path.join(tmp, "forge");
    await cp(path.join(GOLDEN, "acme-portal"), portal);
    await cp(path.join(GOLDEN, "acme-web"), web);
    const r = await importClaudeCode({ workspaceRoot: portal, forgeRoot: forge, profileName: "acme-portal", writeWorkspaceConfig: true });
    expect(r.rejected).toEqual([]);
  });
  afterAll(() => fs.rm(tmp, { recursive: true, force: true }));

  it("import → every planned file is adopt", async () => {
    const w = await loadWorkspace(portal);
    const p = await plan(w);
    const st = await status(w, p, null);
    expect(st.filter((s) => s.state !== "adopt").map((s) => `${s.state} ${s.path}`)).toEqual([]);
    expect(st.map((s) => s.path)).toEqual(expect.arrayContaining([".claude/rules/backend-node.md", ".kiro/steering/product.md", ".kiro/agents/release-helper.json", ".mcp.json"]));
    expect(p.warnings).toContain('kiro: tool "Task" has no Kiro equivalent; dropped');
  });

  it("sync reproduces every file byte for byte, CRLF and BOM included; a second sync is a no-op", async () => {
    await syncOnce(portal);
    const golden = path.join(GOLDEN, "acme-portal");
    for (const rel of await listFiles(golden)) {
      const a = await fs.readFile(path.join(golden, rel));
      const b = await fs.readFile(path.join(portal, rel));
      expect(b.equals(a), `${rel} differs`).toBe(true);
    }
    expect((await fs.readFile(path.join(portal, ".claude/rules/commit-conventions.md"), "utf8")).includes("\r\n")).toBe(true);
    expect(hasBom(await fs.readFile(path.join(portal, ".claude/rules/backend-node.md")))).toBe(true);
    expect(hasBom(await fs.readFile(path.join(portal, ".kiro/steering/backend-node.md")))).toBe(false);

    // LF golden files stay LF — a lost `-text` attribute would otherwise go unnoticed.
    for (const rel of [".claude/rules/workflow.md", ".mcp.json"]) {
      expect((await fs.readFile(path.join(portal, rel))).includes(0x0d), `${rel} has a CR byte`).toBe(false);
    }

    const again = await syncOnce(portal);
    expect(again.r.written).toEqual([]);
    expect(again.r.removed).toEqual([]);
  });

  it("a Forge edit reaches both targets", async () => {
    await fs.appendFile(path.join(forge, "ingredients/rules/workflow/rule.md"), "\n5. **Delete the plan** once the spec is refreshed.\n");
    const w = await loadWorkspace(portal);
    const st = await status(w, await plan(w), await readLock(portal));
    expect(st.filter((s) => s.state === "update").map((s) => s.path)).toEqual([".claude/rules/workflow.md", ".kiro/steering/workflow.md"]);
  });

  it("a hand edit becomes drift and survives sync", async () => {
    await fs.appendFile(path.join(portal, ".kiro/steering/commit-conventions.md"), "\r\nHAND EDIT\r\n");
    const { r } = await syncOnce(portal);
    expect(r.skipped.map((s) => [s.path, s.state])).toEqual([[".kiro/steering/commit-conventions.md", "drift"]]);
    expect(await fs.readFile(path.join(portal, ".kiro/steering/commit-conventions.md"), "utf8")).toContain("HAND EDIT");
  });

  it("removing an ingredient removes its outputs in every target", async () => {
    const recipe = path.join(forge, "recipes/base.yaml");
    await fs.writeFile(recipe, (await fs.readFile(recipe, "utf8")).replace("  - rule/workflow\n", ""));
    const { r } = await syncOnce(portal);
    expect(r.removed.sort()).toEqual([".claude/rules/workflow.md", ".kiro/steering/workflow.md"]);
  });

  it("files craftar never generated are left alone", async () => {
    const stray = path.join(portal, ".claude/rules/local-only.md");
    await fs.writeFile(stray, "# local\n");
    await syncOnce(portal);
    expect(await fs.readFile(stray, "utf8")).toBe("# local\n");
  });

  it("a second workspace reuses shared ingredients and its variant still round-trips", async () => {
    const r = await importClaudeCode({ workspaceRoot: web, forgeRoot: forge, profileName: "acme-web", writeWorkspaceConfig: true });
    expect(r.variants.map((v) => v.name)).toEqual(["rule/workflow--acme-web"]);
    expect(r.reused).toEqual(expect.arrayContaining(["rule/commit-conventions", "agent/docs-author"]));
    const w = await loadWorkspace(web);
    const p = await plan(w);
    const st = await status(w, p, null);
    expect(st.filter((s) => s.state !== "adopt").map((s) => `${s.state} ${s.path}`)).toEqual([]);
  });
});
