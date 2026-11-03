import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listFiles, loadForge } from "../src/core/forge.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { FORGE_SCHEMA_SECTION_FILES } from "../src/schema/index.js";
import { makeForge, makeWorkspace, profile, recipe, rule, tmpDir, writeFiles } from "./helpers/forge.js";

/** Spec 55 §5.1–§5.4: a section value held in a file, at load. */

const GATE = FORGE_SCHEMA_SECTION_FILES;
const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

const body = "# Review\n<!-- craftar:section checklist -->\ndefault\n<!-- /craftar:section -->\n";

async function forgeAt(schema: number, sections: Record<string, unknown>, files: Record<string, string | Buffer> = {}, folder = "acme") {
  const root = await tmpDir("craftar-section-files-");
  roots.push(root);
  await makeForge(root, { ingredients: [rule("review", body)], recipes: [recipe("core", ["rule/review"])], profiles: [] });
  await writeFiles(root, {
    "craftar.forge.yaml": YAML.stringify({ name: "test-forge", schema }),
    [`profiles/${folder}/profile.yaml`]: YAML.stringify({ ...profile("acme", ["core"]), sections }),
    ...files,
  });
  return root;
}

async function loadError(root: string): Promise<string> {
  try {
    await loadForge(root);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected the load to fail");
}

const file = (p: string) => ({ "rule/review": { checklist: { file: p } } });

describe("a section value held in a file (spec 55 §5)", () => {
  it("at the gate, the value is the file's text, a leading BOM dropped and nothing else changed", async () => {
    const root = await forgeAt(GATE, file("sections/rule/review/checklist.md"), {
      "profiles/acme/sections/rule/review/checklist.md": "﻿- one\r\n- two",
    });
    const f = await loadForge(root);
    expect(f.profiles.get("acme")!.sections["rule/review"].checklist).toBe("- one\r\n- two");
    expect(f.sectionFiles.get("profiles/acme/profile.yaml")!.get("rule/review")!.get("checklist")).toBe("sections/rule/review/checklist.md");
  });

  it("a string value beside a file value stays a string, untouched", async () => {
    const root = await forgeAt(GATE, { "rule/review": { checklist: { file: "sections/rule/review/checklist.md" }, tone: "Short.\n" } }, {
      "profiles/acme/sections/rule/review/checklist.md": "x\n",
    });
    expect((await loadForge(root)).profiles.get("acme")!.sections["rule/review"].tone).toBe("Short.\n");
  });

  it("resolves against the folder that holds profile.yaml, whatever the profile's name", async () => {
    const root = await forgeAt(GATE, file("sections/rule/review/checklist.md"), {
      "profiles/acme-folder/sections/rule/review/checklist.md": "from the folder\n",
    }, "acme-folder");
    expect((await loadForge(root)).profiles.get("acme")!.sections["rule/review"].checklist).toBe("from the folder\n");
  });

  it("below the gate, a { file: } value fails the load as a near miss naming the schema, never a value", async () => {
    const root = await forgeAt(GATE - 1, file("sections/rule/review/checklist.md"), {
      "profiles/acme/sections/rule/review/checklist.md": "SECRET-CONTENT\n",
    });
    const msg = await loadError(root);
    expect(msg).toContain(`profiles/acme/profile.yaml: sections.rule/review.checklist: a section value held in a file needs schema: ${GATE} in craftar.forge.yaml`);
    expect(msg).not.toContain("SECRET-CONTENT");
  });

  it("below the gate, an unnamed file under sections/ says nothing", async () => {
    const root = await forgeAt(GATE - 1, {}, { "profiles/acme/sections/rule/review/orphan.md": "x\n" });
    await expect(loadForge(root)).resolves.toBeDefined();
  });

  it.each([
    ["../outside.md", "climbs"],
    ["/abs/checklist.md", "absolute"],
    ["sections\\rule\\checklist.md", "backslash"],
    ["notes/checklist.md", "not under sections/"],
    ["sections/rule/review/checklist.txt", "not .md"],
    ["profile.yaml", "the profile file"],
    ["sections/.hidden/checklist.md", "a dot segment"],
    ["sections//checklist.md", "an empty segment"],
  ])("refuses the path %s (%s), naming the file and the key, never content", async (p) => {
    const root = await forgeAt(GATE, file(p), { "profiles/acme/sections/rule/review/checklist.md": "SECRET-CONTENT\n" });
    const msg = await loadError(root);
    expect(msg).toContain("profiles/acme/profile.yaml");
    expect(msg).toContain("rule/review");
    expect(msg).not.toContain("SECRET-CONTENT");
  });

  it.each([
    ["sections/con.md", "a Windows device name"],
    ["sections/rule./checklist.md", "a segment ending in a dot"],
  ])("refuses %s (%s) even when the file is there, a Forge a Windows checkout cannot hold", async (p) => {
    // The schema refuses the path before any read; the file is planted where the file system can hold it.
    const root = await forgeAt(GATE, file(p), process.platform === "win32" ? {} : { [`profiles/acme/${p}`]: "SECRET-CONTENT\n" });
    const msg = await loadError(root);
    expect(msg).toContain("rule/review");
    expect(msg).toContain("Windows cannot hold");
    expect(msg).not.toContain("SECRET-CONTENT");
  });

  it("refuses a key beside file", async () => {
    const root = await forgeAt(GATE, { "rule/review": { checklist: { file: "sections/rule/review/checklist.md", encoding: "utf8" } } }, {
      "profiles/acme/sections/rule/review/checklist.md": "x\n",
    });
    expect(await loadError(root)).toContain("rule/review");
  });

  it("refuses a missing file, naming the path", async () => {
    const root = await forgeAt(GATE, file("sections/rule/review/missing.md"));
    const msg = await loadError(root);
    expect(msg).toContain("profiles/acme/sections/rule/review/missing.md");
    expect(msg).not.toContain(root);
  });

  it("refuses a file that is not valid UTF-8, never printing its bytes", async () => {
    const root = await forgeAt(GATE, file("sections/rule/review/checklist.md"), {
      "profiles/acme/sections/rule/review/checklist.md": Buffer.from([0x53, 0x45, 0x43, 0xff, 0xfe, 0x0a]),
    });
    const msg = await loadError(root);
    expect(msg).toContain("sections/rule/review/checklist.md");
    expect(msg).not.toMatch(/SEC/);
  });

  it("refuses two values naming one file, and two paths equal without case", async () => {
    const one = await forgeAt(GATE, { "rule/review": { a: { file: "sections/x.md" }, b: { file: "sections/x.md" } } }, { "profiles/acme/sections/x.md": "x\n" });
    expect(await loadError(one)).toContain("sections.rule/review.a and sections.rule/review.b name one file");
    const two = await forgeAt(GATE, { "rule/review": { a: { file: "sections/x.md" }, b: { file: "sections/X.md" } } }, { "profiles/acme/sections/x.md": "x\n" });
    expect(await loadError(two)).toContain("sections.rule/review.a and sections.rule/review.b name one file");
  });

  it("refuses a link out of the declaring folder (a junction on Windows), naming no target", async () => {
    const root = await forgeAt(GATE, file("sections/rule/review/checklist.md"), { "elsewhere/checklist.md": "SECRET-CONTENT\n" });
    await fs.mkdir(path.join(root, "profiles/acme/sections/rule"), { recursive: true });
    await fs.symlink(path.join(root, "elsewhere"), path.join(root, "profiles/acme/sections/rule/review"), "junction");
    const msg = await loadError(root);
    expect(msg).toContain("profiles/acme/profile.yaml");
    expect(msg).not.toContain("elsewhere");
    expect(msg).not.toContain("SECRET-CONTENT");
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO without hanging", async () => {
    const root = await forgeAt(GATE, file("sections/rule/review/checklist.md"));
    await fs.mkdir(path.join(root, "profiles/acme/sections/rule/review"), { recursive: true });
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [path.join(root, "profiles/acme/sections/rule/review/checklist.md")]);
    expect(await loadError(root)).toContain("sections/rule/review/checklist.md");
  });

  it("an unnamed file under sections/ warns at the gate, once, and the plan succeeds", async () => {
    const root = await forgeAt(GATE, {}, { "profiles/acme/sections/rule/review/orphan.md": "x\n" });
    const ws = `${root}-ws`;
    roots.push(ws);
    await makeWorkspace(ws, root, { config: { profile: "acme" } });
    const p = await plan(await loadWorkspace(ws));
    expect(p.warnings.filter((w) => w.includes("no section value names this file"))).toEqual([
      "profiles/acme/sections/rule/review/orphan.md: no section value names this file",
    ]);
  });

  it.skipIf(process.platform === "win32")("an unnamed file whose name holds a control character is named by position, never as it is", async () => {
    const root = await forgeAt(GATE, {}, { "profiles/acme/sections/bad\u001b[31mname.md": "x\n" });
    const ws = `${root}-ws3`;
    roots.push(ws);
    await makeWorkspace(ws, root, { config: { profile: "acme" } });
    const p = await plan(await loadWorkspace(ws));
    const w = p.warnings.filter((x) => x.includes("no section value names this file"));
    expect(w).toEqual(["profiles/acme/sections/#1 (a name not shown): no section value names this file"]);
  });

  it("craftar.yaml cannot hold a { file: } value: the workspace's load fails naming the key", async () => {
    const root = await forgeAt(GATE, {});
    const ws = `${root}-ws2`;
    roots.push(ws);
    await makeWorkspace(ws, root, { config: { profile: "acme", overrides: { sections: file("sections/x.md") } } });
    await expect(loadWorkspace(ws)).rejects.toThrow(/rule\/review/);
  });
});

describe("one home for the shape of a section file (spec 55 §5.4)", () => {
  it("only the schema and section-files.ts spell the file value, its path grammar or its resolver", async () => {
    const src = path.resolve(__dirname, "../src");
    const offenders: string[] = [];
    for (const f of await listFiles(src)) {
      if (!f.endsWith(".ts") || f === "core/section-files.ts") continue;
      const text = await fs.readFile(path.join(src, f), "utf8");
      // The shape of a file-held value and its resolver have one home each: the schema, and section-files.ts.
      if (/SectionFileValue|SECTION_FILE_PATH|function resolveSectionFiles/.test(text) && f !== "schema/index.ts") offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
