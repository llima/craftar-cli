import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { runCli } from "./helpers/cli.js";
import { git } from "./helpers/remote.js";
import { FORGE_SCHEMA_SECTION_FILES } from "../src/schema/index.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles } from "./helpers/forge.js";

/** Spec 55 §5.6, tests 17–20: `craftar forge sections extract` end to end. */

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

const big = (n: number, tag: string) => `${tag} `.repeat(Math.ceil(n / (tag.length + 1))).slice(0, n - 1) + "\n";

/** 40 values: 30 over 500 bytes (one CRLF, one with no final newline), one empty, one starting with U+FEFF, 8 small. */
function sections(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (let i = 0; i < 30; i++) {
    let v = big(1100, `v${i}`);
    if (i === 0) v = v.replace(/\n/g, "\r\n");
    if (i === 1) v = v.slice(0, -1);
    (out[`rule/r${i % 5}`] ??= {})[`s${i}`] = v;
  }
  out["rule/r0"].empty = "";
  out["rule/r1"].bom = "﻿" + big(800, "bom");
  for (let i = 0; i < 8; i++) out["rule/r2"][`small${i}`] = `small ${i}\n`;
  return out;
}

async function setup(opts: { schema?: number; extra?: (s: Record<string, Record<string, string>>) => void } = {}) {
  const root = await tmpDir("craftar-extract-cli-");
  roots.push(root);
  const forge = path.join(root, "forge");
  const values = sections();
  opts.extra?.(values);
  const marks = (r: number) => Object.keys(values[`rule/r${r}`]).map((s) => `<!-- craftar:section ${s} -->\nd\n<!-- /craftar:section -->\n`).join("");
  await makeForge(forge, {
    ingredients: [0, 1, 2, 3, 4].map((r) => rule(`r${r}`, marks(r))),
    recipes: [recipe("core", [0, 1, 2, 3, 4].map((r) => `rule/r${r}`))],
    profiles: [profile("acme", ["core"], ["claude-code", "kiro", "agents-md"], { sections: values })],
  });
  await writeFiles(forge, { "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema: opts.schema ?? FORGE_SCHEMA_SECTION_FILES }) });
  git(forge, "init", "-q", "-b", "main");
  git(forge, "add", "-A");
  git(forge, "commit", "-q", "-m", "forge");
  const ws = path.join(root, "ws");
  await makeWorkspace(ws, forge, { config: { profile: "acme" } });
  const r = runCli(["sync", "--workspace", ws]);
  expect(r.code, r.stderr).toBe(0);
  return { root, forge, ws };
}

const bytes = async (p: string) => (await fs.stat(p)).size;
const status = (forge: string) => git(forge, "status", "--porcelain", "--untracked-files=all");

describe("craftar forge sections extract (spec 55 §5.6)", () => {
  it("test 17: moves the 30, leaves the empty and the U+FEFF one, every workspace unchanged, profile.yaml under 20%", async () => {
    const s = await setup();
    const before = await bytes(path.join(s.forge, "profiles/acme/profile.yaml"));
    const r = runCli(["forge", "sections", "extract", "--profile", "acme", "--forge", s.forge, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(Object.keys(out)).toEqual(["profile", "minBytes", "dryRun", "moved", "profileBytes", "impact", "warnings"]);
    expect(out.moved).toHaveLength(30);
    expect(out.minBytes).toBe(500);
    expect(out.impact).toHaveLength(1);
    expect(out.impact[0].state).toBe("no-effect");
    expect(out.warnings.some((w: string) => w.includes("rule/r1.bom"))).toBe(true);
    const doc = YAML.parse(await fs.readFile(path.join(s.forge, "profiles/acme/profile.yaml"), "utf8"));
    expect(doc.sections["rule/r0"].empty).toBe("");
    expect(typeof doc.sections["rule/r1"].bom).toBe("string");
    expect(doc.sections["rule/r0"].s0).toEqual({ file: "sections/rule/r0/s0.md" });
    expect(await fs.readFile(path.join(s.forge, "profiles/acme/sections/rule/r0/s0.md"), "utf8")).toContain("\r\n");
    expect(await bytes(path.join(s.forge, "profiles/acme/profile.yaml"))).toBeLessThan(before * 0.2);
    git(s.forge, "add", "-A");
    git(s.forge, "commit", "-q", "-m", "extract");
    expect(runCli(["sync", "--check", "--workspace", s.ws]).code).toBe(0);
    expect(r.stdout).not.toContain("v0 v0");
  });

  it("test 18: --dry-run writes nothing, leaves no scratch copy, and fills impact", async () => {
    const s = await setup();
    const tmp = path.dirname(s.root);
    const scratchBefore = (await fs.readdir(tmp)).filter((d) => d.startsWith("craftar-sections-extract-"));
    const r = runCli(["forge", "sections", "extract", "--profile", "acme", "--forge", s.forge, "--dry-run", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.dryRun).toBe(true);
    expect(out.moved).toHaveLength(30);
    expect(out.impact).toHaveLength(1);
    expect(status(s.forge)).toBe("");
    expect((await fs.readdir(tmp)).filter((d) => d.startsWith("craftar-sections-extract-"))).toEqual(scratchBefore);
  });

  it("test 19: below the gate it refuses and never bumps the schema", async () => {
    const s = await setup({ schema: FORGE_SCHEMA_SECTION_FILES - 1 });
    const r = runCli(["forge", "sections", "extract", "--profile", "acme", "--forge", s.forge]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`forge sections extract needs a Forge at schema: ${FORGE_SCHEMA_SECTION_FILES}`);
    expect(status(s.forge)).toBe("");
  });

  it("test 19: refuses a dirty profile.yaml with the Forge untouched", async () => {
    const s = await setup();
    await fs.appendFile(path.join(s.forge, "profiles/acme/profile.yaml"), "# edit\n");
    const statusBefore = status(s.forge);
    const r = runCli(["forge", "sections", "extract", "--profile", "acme", "--forge", s.forge]);
    expect(r.code).toBe(1);
    expect(status(s.forge)).toBe(statusBefore);
  });

  it("test 19: refuses an ignored sections/ with the Forge untouched", async () => {
    const s = await setup();
    await fs.writeFile(path.join(s.forge, ".gitignore"), "profiles/acme/sections/\n");
    git(s.forge, "add", "-A");
    git(s.forge, "commit", "-q", "-m", "ignore");
    const r = runCli(["forge", "sections", "extract", "--profile", "acme", "--forge", s.forge]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ignored");
    expect(status(s.forge)).toBe("");
  });

  it("test 19: refuses a section named con, naming the key and section, with the line to move it by hand", async () => {
    const s = await setup({ extra: (v) => void (v["rule/r3"].con = big(900, "con")) });
    const r = runCli(["forge", "sections", "extract", "--profile", "acme", "--forge", s.forge]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("rule/r3.con");
    expect(r.stderr).toContain("by hand");
    expect(status(s.forge)).toBe("");
  });

  it("test 19: refuses a key whose folder would end in a dot", async () => {
    const s = await setup({ extra: (v) => void (v["rule/end."] = { s: big(900, "dot") }) });
    const r = runCli(["forge", "sections", "extract", "--profile", "acme", "--forge", s.forge]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("rule/end..s");
    expect(status(s.forge)).toBe("");
  });

  it("test 19: refuses a link on the path with the Forge untouched", async () => {
    const s = await setup();
    const outside = path.join(s.root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(s.forge, "profiles/acme/sections"), "junction");
    git(s.forge, "add", "-A");
    git(s.forge, "commit", "-q", "-m", "link");
    const r = runCli(["forge", "sections", "extract", "--profile", "acme", "--forge", s.forge]);
    expect(r.code).toBe(1);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("test 19: a remote Forge is refused before anything is fetched", async () => {
    const root = await tmpDir("craftar-extract-remote-");
    roots.push(root);
    await writeFiles(root, { "craftar.yaml": YAML.stringify({ forge: "https://example.invalid/forge.git", profile: "acme" }) });
    const r = runCli(["forge", "sections", "extract", "--profile", "acme", "--workspace", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("remote");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a profile.yaml it cannot write is refused by the proof, with the Forge untouched", async () => {
    const s = await setup();
    const profileAbs = path.join(s.forge, "profiles/acme/profile.yaml");
    await fs.chmod(profileAbs, 0o444);
    const r = runCli(["forge", "sections", "extract", "--profile", "acme", "--forge", s.forge]);
    await fs.chmod(profileAbs, 0o644);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("profiles/acme/profile.yaml could not be written on the scratch copy");
    expect(r.stderr).not.toContain("craftar-sections-extract-");
    expect(status(s.forge)).toBe("");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "test 20: a failure after the files are written leaves a journal whose checkout and clean -fd restore the Forge",
    async () => {
      const { loadForge } = await import("../src/core/forge.js");
      const { applyExtract, planExtract } = await import("../src/core/sections-extract.js");
      const s = await setup();
      const f = await loadForge(s.forge);
      const x = await planExtract(f, "acme", 500);
      const profileAbs = path.join(s.forge, "profiles/acme/profile.yaml");
      await fs.chmod(profileAbs, 0o444);
      const journal: Array<{ abs: string; created: boolean }> = [];
      await expect(applyExtract(x, journal)).rejects.toThrow(/EACCES/);
      await fs.chmod(profileAbs, 0o644);
      const rel = (abs: string) => path.relative(s.forge, abs).split(path.sep).join("/");
      expect(journal.filter((j) => j.created).map((j) => rel(j.abs))).toEqual(["profiles/acme/sections"]);
      expect(journal.filter((j) => !j.created).map((j) => rel(j.abs))).toEqual(["profiles/acme/profile.yaml"]);
      expect(status(s.forge)).not.toBe("");
      git(s.forge, "checkout", "--", "profiles/acme/profile.yaml");
      git(s.forge, "clean", "-fd", "--", "profiles/acme/sections");
      expect(status(s.forge)).toBe("");
    },
  );
});
