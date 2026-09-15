/**
 * Regenerates test/golden/acme-portal/.kiro from the workspace's .claude/ through import + sync.
 * The result is a characterization snapshot of the emitter: run it only after an intended emitter
 * change, and review the diff like code.  Usage: npx tsx test/helpers/regen-golden.ts
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importClaudeCode } from "../../src/importers/claude-code.js";
import { apply, loadWorkspace, plan, status } from "../../src/core/sync.js";
import { listFiles } from "../../src/core/forge.js";

const GOLDEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../golden/acme-portal");
const GENERATED = /<!--\s*GENERATED from /;

async function copyTree(src: string, dst: string): Promise<void> {
  for (const rel of await listFiles(src)) {
    await fs.mkdir(path.dirname(path.join(dst, rel)), { recursive: true });
    await fs.copyFile(path.join(src, rel), path.join(dst, rel));
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-regen-"));
const ws = path.join(tmp, "ws");
try {
  await copyTree(GOLDEN, ws);
  const report = await importClaudeCode({ workspaceRoot: ws, forgeRoot: path.join(tmp, "forge"), profileName: "acme-portal", writeWorkspaceConfig: true });
  if (report.rejected.length) throw new Error(`golden workspace rejected: ${report.rejected.map((r) => r.name).join(", ")}`);

  // The importer has read the inclusion modes; drop every generated Kiro file so sync writes it fresh.
  for (const rel of await listFiles(path.join(ws, ".kiro"))) {
    const abs = path.join(ws, ".kiro", rel);
    const handWritten = rel.startsWith("steering/") && !rel.startsWith("steering/commands/") && !GENERATED.test((await fs.readFile(abs, "utf8")).slice(0, 400));
    if (!handWritten) await fs.rm(abs);
  }

  const w = await loadWorkspace(ws);
  const p = await plan(w);
  const st = await status(w, p, null);
  const unexpected = st.filter((s) => s.state !== "new" && s.state !== "adopt");
  if (unexpected.length) throw new Error(`unexpected states: ${unexpected.map((s) => `${s.state} ${s.path}`).join(", ")}`);
  await apply(w, p, st);

  await fs.rm(path.join(GOLDEN, ".kiro"), { recursive: true, force: true });
  await copyTree(path.join(ws, ".kiro"), path.join(GOLDEN, ".kiro"));
  console.log(`regenerated test/golden/acme-portal/.kiro (${(await listFiles(path.join(GOLDEN, ".kiro"))).length} files)`);
  for (const warning of p.warnings) console.log(`warn ${warning}`);
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
