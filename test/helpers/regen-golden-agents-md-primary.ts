/**
 * Regenerates test/golden/agents-md-primary/ — the acme workspace of spec 41 §11.1 synced under agents-md.primary (Forge
 * schema 5): every file sync writes, craftar.lock aside. A characterization snapshot: run it only after an intended change
 * to what the mode writes, and review the diff like code.  Usage: npx tsx test/helpers/regen-golden-agents-md-primary.ts
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apply, loadWorkspace, plan, readLock, status } from "../../src/core/sync.js";
import { acmePrimary } from "./agents-md-primary.js";

const GOLDEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../golden/agents-md-primary");

process.env.CRAFTAR_HOME ??= await fs.mkdtemp(path.join(os.tmpdir(), "craftar-home-"));
const s = await acmePrimary({ schema: 5, params: { "agents-md.primary": true } });
try {
  const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
  const p = await plan(ws);
  await apply(ws, p, await status(ws, p, await readLock(ws.root)), {});
  await fs.rm(GOLDEN, { recursive: true, force: true });
  for (const f of p.files) {
    await fs.mkdir(path.dirname(path.join(GOLDEN, f.path)), { recursive: true });
    await fs.copyFile(path.join(s.wsRoot, f.path), path.join(GOLDEN, f.path));
  }
  console.log(`regenerated test/golden/agents-md-primary (${p.files.length} files)`);
  for (const w of p.warnings) console.log(`warn ${w}`);
} finally {
  await s.cleanup();
}
