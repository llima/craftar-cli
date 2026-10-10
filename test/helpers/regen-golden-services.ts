/**
 * Regenerates test/golden/acme-services from a synthetic Forge + workspace through sync.
 * Unlike regen-golden.ts (which imports from an existing workspace), this creates the Forge
 * from scratch to provide a minimal services example. Usage: npx tsx test/helpers/regen-golden-services.ts
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apply, loadWorkspace, plan, readLock, status } from "../../src/core/sync.js";
import { listFiles } from "../../src/core/forge.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.resolve(HERE, "../golden/acme-services");

async function copyTree(src: string, dst: string): Promise<void> {
  for (const rel of await listFiles(src)) {
    await fs.mkdir(path.dirname(path.join(dst, rel)), { recursive: true });
    await fs.copyFile(path.join(src, rel), path.join(dst, rel));
  }
}

/** Creates a minimal Forge with one rule and one service ingredient. */
async function createForge(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "craftar.forge.yaml"), "name: acme-services-forge\ndescription: Golden Forge for services testing\n");

  // service/echo
  const echoDir = path.join(dir, "ingredients/services/echo");
  await fs.mkdir(path.join(echoDir, "init"), { recursive: true });
  await fs.writeFile(path.join(echoDir, "ingredient.yaml"), `type: service
name: echo
compose: compose.yaml
files: [init/setup.sh]
executable: [init/setup.sh]
params:
  greeting: { default: hello }
`);
  await fs.writeFile(path.join(echoDir, "compose.yaml"), `services:
  echo:
    image: example/echo:1
    ports: ["8080:80"]
    environment:
      GREETING: "{{greeting}}"
      TOKEN: \${ECHO_TOKEN:-local}
`);
  await fs.writeFile(path.join(echoDir, "init/setup.sh"), `#!/bin/sh
# Setup script for echo service
echo "Initializing with greeting: {{greeting}}"
`);

  // rule/workflow
  const ruleDir = path.join(dir, "ingredients/rules/workflow");
  await fs.mkdir(ruleDir, { recursive: true });
  await fs.writeFile(path.join(ruleDir, "ingredient.yaml"), 'type: rule\nname: workflow\ninclusion: always\ntargets: "*"\n');
  await fs.writeFile(path.join(ruleDir, "rule.md"), "# Workflow\n\nFollow the project workflow.\n");

  // recipe
  await fs.mkdir(path.join(dir, "recipes"), { recursive: true });
  await fs.writeFile(path.join(dir, "recipes/base.yaml"), "name: base\ningredients: [rule/workflow, service/echo]\n");

  // profile
  await fs.mkdir(path.join(dir, "profiles/acme"), { recursive: true });
  await fs.writeFile(path.join(dir, "profiles/acme/profile.yaml"), "name: acme\nrecipes: [base]\ntargets: [claude-code]\n");
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "craftar-regen-services-"));
const ws = path.join(tmp, "ws");
const forge = path.join(tmp, "forge");

try {
  await createForge(forge);
  await fs.mkdir(ws, { recursive: true });
  await fs.writeFile(path.join(ws, "craftar.yaml"), "forge: ../forge\nprofile: acme\n");

  // First sync
  const w = await loadWorkspace(ws);
  const p = await plan(w);
  const st = await status(w, p, null);
  const unexpected = st.filter((s) => s.state !== "new");
  if (unexpected.length) throw new Error(`unexpected states: ${unexpected.map((s) => `${s.state} ${s.path}`).join(", ")}`);
  await apply(w, p, st);

  // Verify second sync is no-op
  const w2 = await loadWorkspace(ws);
  const p2 = await plan(w2);
  const st2 = await status(w2, p2, await readLock(ws));
  const changed = st2.filter((s) => s.state !== "unchanged");
  if (changed.length) throw new Error(`second sync has changes: ${changed.map((s) => `${s.state} ${s.path}`).join(", ")}`);

  // Copy to golden
  await fs.rm(GOLDEN, { recursive: true, force: true });
  await fs.mkdir(GOLDEN, { recursive: true });
  await copyTree(forge, path.join(GOLDEN, "forge"));
  for (const rel of ["craftar.yaml", "craftar.lock", ".claude", ".craftar"]) {
    const src = path.join(ws, rel);
    const dst = path.join(GOLDEN, rel);
    const stat = await fs.stat(src).catch(() => null);
    if (!stat) continue;
    stat.isDirectory() ? await copyTree(src, dst) : await fs.copyFile(src, dst);
  }

  console.log(`regenerated test/golden/acme-services (${(await listFiles(GOLDEN)).length} files)`);
  for (const warning of p.warnings) console.log(`warn ${warning}`);
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
