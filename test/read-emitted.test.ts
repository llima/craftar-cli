import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readEmitted } from "../src/importers/claude-code.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("readEmitted (spec 30 §5.1)", () => {
  it("rule: CRLF + BOM → LF, no BOM; meta matches planImport's", async () => {
    const root = await tmpDir("craftar-read-emitted-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const claudeDir = path.join(root, ".claude");
    // BOM (0xEF 0xBB 0xBF) + "line\r\n"
    await writeFiles(claudeDir, { "rules/r.md": Buffer.from([0xef, 0xbb, 0xbf, 0x6c, 0x69, 0x6e, 0x65, 0x0d, 0x0a]) });
    const origin = (rel: string) => ({ workspace: "w", path: rel });
    const r = await readEmitted(claudeDir, "rule", "r.md", origin, { inclusion: "always" });
    expect(r).not.toBeNull();
    expect(r!.files).toEqual({ "rule.md": "line\n" });
    expect(r!.meta).toEqual({
      type: "rule",
      name: "r",
      inclusion: "always",
      fileMatchPattern: undefined,
      file: "rule.md",
      targets: "*",
      tags: [],
      origin: { workspace: "w", path: ".claude/rules/r.md" },
    });
  });

  it("agent: frontmatter fields and frontmatterRaw as planImport builds them", async () => {
    const root = await tmpDir("craftar-read-emitted-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const claudeDir = path.join(root, ".claude");
    await writeFiles(claudeDir, {
      "agents/x.md": "---\nname: x\ndescription: D\ntools: Read, Grep\nmodel: opus\n---\nbody\n",
    });
    const origin = (rel: string) => ({ workspace: "w", path: rel });
    const r = await readEmitted(claudeDir, "agent", "x.md", origin);
    expect(r).not.toBeNull();
    expect(r!.meta.description).toBe("D");
    expect(r!.meta.tools).toEqual(["Read", "Grep"]);
    expect(r!.meta.model).toBe("opus");
    expect(r!.meta.frontmatterRaw).toBe("name: x\ndescription: D\ntools: Read, Grep\nmodel: opus");
    expect(r!.files).toEqual({ "agent.md": "body\n" });
  });

  it("command: argument-hint and allowed-tools fields, frontmatterRaw", async () => {
    const root = await tmpDir("craftar-read-emitted-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const claudeDir = path.join(root, ".claude");
    await writeFiles(claudeDir, {
      "commands/deploy.md": "---\ndescription: Deploy it\nargument-hint: <env>\nallowed-tools: Bash, Write\n---\nDo the deploy.\n",
    });
    const origin = (rel: string) => ({ workspace: "w", path: rel });
    const r = await readEmitted(claudeDir, "command", "deploy.md", origin);
    expect(r).not.toBeNull();
    expect(r!.meta.description).toBe("Deploy it");
    expect(r!.meta.argumentHint).toBe("<env>");
    expect(r!.meta.allowedTools).toBe("Bash, Write");
    expect(r!.meta.frontmatterRaw).toBe("description: Deploy it\nargument-hint: <env>\nallowed-tools: Bash, Write");
    expect(r!.files).toEqual({ "command.md": "Do the deploy.\n" });
  });

  it("skill directory: SKILL.md + notes.txt + binary → three keys; binary value Buffer.equals; no SKILL.md → null", async () => {
    const root = await tmpDir("craftar-read-emitted-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const claudeDir = path.join(root, ".claude");
    await writeFiles(claudeDir, {
      "skills/demo/SKILL.md": "# Demo Skill\n",
      "skills/demo/notes.txt": "note\n",
    });
    await fs.writeFile(path.join(claudeDir, "skills/demo/logo.bin"), Buffer.from([0, 1, 2]));
    const origin = (rel: string) => ({ workspace: "w", path: rel });

    const r = await readEmitted(claudeDir, "skill", "demo", origin);
    expect(r).not.toBeNull();
    expect(Object.keys(r!.files).sort()).toEqual(["SKILL.md", "logo.bin", "notes.txt"]);
    expect(r!.files["SKILL.md"]).toBe("# Demo Skill\n");
    expect(r!.files["notes.txt"]).toBe("note\n");
    expect(Buffer.isBuffer(r!.files["logo.bin"])).toBe(true);
    expect((r!.files["logo.bin"] as Buffer).equals(Buffer.from([0, 1, 2]))).toBe(true);

    // Directory without SKILL.md → null
    await writeFiles(claudeDir, { "skills/empty/readme.md": "no skill\n" });
    const r2 = await readEmitted(claudeDir, "skill", "empty", origin);
    expect(r2).toBeNull();
  });

  it("script: name is lowercased, preserves original filename in files", async () => {
    const root = await tmpDir("craftar-read-emitted-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const claudeDir = path.join(root, ".claude");
    await writeFiles(claudeDir, { "scripts/Run.SH": "#!/bin/bash\necho hi\n" });
    const origin = (rel: string) => ({ workspace: "w", path: rel });
    const r = await readEmitted(claudeDir, "script", "Run.SH", origin);
    expect(r).not.toBeNull();
    expect(r!.meta.name).toBe("run");
    expect(r!.meta.files).toEqual(["Run.SH"]);
    expect(r!.meta.targets).toEqual(["claude-code"]);
  });

  it("skill: a symlink to a directory returns null (spec 30, 30d)", async () => {
    const root = await tmpDir("craftar-read-emitted-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const claudeDir = path.join(root, ".claude");

    // Create a real skill directory OUTSIDE .claude/, holding SKILL.md
    const realSkill = path.join(root, "real-skill");
    await fs.mkdir(realSkill, { recursive: true });
    await fs.writeFile(path.join(realSkill, "SKILL.md"), "# S\n");

    // Create .claude/skills/ and a symlink to the real directory
    await fs.mkdir(path.join(claudeDir, "skills"), { recursive: true });
    await fs.symlink(realSkill, path.join(claudeDir, "skills", "linked"), "junction");

    const origin = (rel: string) => ({ workspace: "w", path: rel });
    const r = await readEmitted(claudeDir, "skill", "linked", origin);
    expect(r).toBe(null);
  });

  it("script: a dangling symlink throws ENOENT (spec 30r1 §3.4)", async () => {
    const root = await tmpDir("craftar-read-emitted-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const claudeDir = path.join(root, ".claude");

    // Create .claude/scripts/
    await fs.mkdir(path.join(claudeDir, "scripts"), { recursive: true });
    // Create a dangling symlink: points at a target that does not exist
    const link = path.join(claudeDir, "scripts", "gone.sh");
    const target = path.join(root, "nonexistent.sh");
    await fs.symlink(target, link);

    const origin = (rel: string) => ({ workspace: "w", path: rel });
    await expect(readEmitted(claudeDir, "script", "gone.sh", origin)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
