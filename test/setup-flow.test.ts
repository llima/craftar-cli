import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InitIo } from "../src/core/init-flow.js";
import { askSetup, confirmSetup, setupAgainLine, type SetupGiven } from "../src/core/setup-flow.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";

// Spec 62 §4.5 — the interactive questions, driven through a fake InitIo (spec 28's way; no test forces a TTY).

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function fakeIo(answers: Array<string | null>): InitIo & { asked: string[]; said: string[] } {
  const asked: string[] = [];
  const said: string[] = [];
  const next = async (q: string) => {
    asked.push(q);
    if (answers.length === 0) throw new Error(`unexpected question: ${q}`);
    return answers.shift()!;
  };
  return { asked, said, ask: next, confirm: next, say: (l) => void said.push(l) };
}

async function cwdDir(files: Record<string, string> = {}) {
  const root = await fs.realpath(await tmpDir("craftar-setup-flow-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "acme-app");
  await fs.mkdir(cwd);
  await writeFiles(cwd, files);
  return { root, cwd, ctx: { cwd, home: path.join(root, "home"), platform: process.platform } };
}

const none: SetupGiven = { git: true, workspaces: [], sync: true };

describe("askSetup", () => {
  it("asks Forge, name, profile, the workspace, more workspaces, targets, starter — in that order, with their defaults", async () => {
    const { root, cwd, ctx } = await cwdDir();
    const io = fakeIo(["", "", "", "", "", "kiro,opencode", ""]);
    const r = await askSetup(none, io, ctx);
    expect(io.asked).toEqual([
      `Where should the new Forge live [${path.join(root, "acme-app-forge")}]: `,
      "Forge name [acme-app-forge]: ",
      "First profile's name [acme-app]: ",
      `Start a workspace in ${cwd} [yes]: `,
      "Another workspace directory (empty to finish): ",
      expect.stringMatching(/^Targets — claude-code \(working\), .*opencode \(mvp\), separated by commas \[claude-code\]: $/),
      "Add a starter rule so the first sync writes a file [yes]: ",
    ]);
    expect(io.asked[5]).not.toContain("gemini");
    expect(r).toEqual({
      kind: "answered",
      answers: { forgeAbs: path.join(root, "acme-app-forge"), name: "acme-app-forge", profile: "acme-app", targets: ["kiro", "opencode"], starter: true, git: true, workspaces: [cwd], importWs: null },
    });
  });

  it("asks a refused answer again, saying the refusal's words", async () => {
    const { ctx } = await cwdDir();
    const io = fakeIo(["", "Bad Name", "team", "Acme", "acme", "no", "", "gemini", "claude-code", "no"]);
    const r = await askSetup(none, io, ctx);
    expect(io.said.some((l) => l.includes("is not a Forge name"))).toBe(true);
    expect(io.said.some((l) => l.includes("is not a profile name"))).toBe(true);
    expect(io.said.some((l) => l.includes("gemini target was removed"))).toBe(true);
    expect(r.kind === "answered" && r.answers).toMatchObject({ name: "team", profile: "acme", targets: ["claude-code"], starter: false, workspaces: [] });
  });

  it("offers the import when the current directory holds .claude/, and then asks no targets and no starter", async () => {
    const { cwd, ctx } = await cwdDir({ ".claude/rules/a.md": "a\n" });
    const io = fakeIo(["", "", "", "", ""]);
    const r = await askSetup(none, io, ctx);
    expect(io.asked[0]).toBe("This directory holds a Claude Code harness. Create a Forge from it (import) [yes]: ");
    expect(io.asked.some((q) => q.startsWith("Targets"))).toBe(false);
    expect(io.asked.some((q) => q.startsWith("Add a starter"))).toBe(false);
    expect(r.kind === "answered" && r.answers).toMatchObject({ importWs: cwd, workspaces: [cwd], starter: false, targets: ["claude-code"] });
  });

  it("refuses a Forge location that is not empty, then takes the next answer", async () => {
    const { root, ctx } = await cwdDir();
    await writeFiles(path.join(root, "busy"), { "x.txt": "x" });
    const io = fakeIo([path.join(root, "busy"), path.join(root, "free"), "", "", "no", "", "", ""]);
    const r = await askSetup(none, io, ctx);
    expect(io.said.some((l) => l.includes("exists and is not empty"))).toBe(true);
    expect(r.kind === "answered" && r.answers.forgeAbs).toBe(path.join(root, "free"));
  });

  it("asks nothing a flag gave", async () => {
    const { root, ctx } = await cwdDir();
    const io = fakeIo(["", ""]);
    const r = await askSetup({ ...none, forgeDir: path.join(root, "f"), name: "f", profile: "acme", targets: ["claude-code"], starter: true }, io, ctx);
    expect(io.asked).toEqual([expect.stringMatching(/^Start a workspace in /), "Another workspace directory (empty to finish): "]);
    expect(r.kind).toBe("answered");
  });

  it("an ended input cancels", async () => {
    const { ctx } = await cwdDir();
    expect(await askSetup(none, fakeIo([null]), ctx)).toEqual({ kind: "cancelled" });
  });
});

describe("confirmSetup and the again line", () => {
  const answers = { forgeAbs: "/w/acme-forge", name: "acme-forge", profile: "acme", targets: ["codex" as const], starter: true, git: true, workspaces: ["/w/app"], importWs: null };

  it("lists the files, notes S12, and asks once; no and an ended input cancel", async () => {
    const io = fakeIo([""]);
    expect(await confirmSetup(answers, io, { sync: true })).toBe("confirmed");
    expect(io.said).toContain("  + profiles/acme/profile.yaml");
    expect(io.said.some((l) => l.includes("the starter rule reaches no file"))).toBe(true);
    expect(io.asked).toEqual(["Create the Forge, commit it and start 1 workspace [yes]: "]);
    expect(await confirmSetup(answers, fakeIo(["maybe", "no"]), { sync: true })).toBe("cancelled");
    expect(await confirmSetup(answers, fakeIo([null]), { sync: true })).toBe("cancelled");
  });

  it("the again line is the same run as flags", () => {
    expect(setupAgainLine(answers, "/w", { sync: false, platform: "linux" })).toBe(
      "  again craftar setup --forge-dir acme-forge --name acme-forge --profile acme --targets codex --workspace app --no-import --no-sync",
    );
  });
});

describe("askSetup — review round 1", () => {
  it("refuses a second workspace holding .claude/ once one is imported, at the answer (S9)", async () => {
    const { root, cwd, ctx } = await cwdDir({ ".claude/rules/a.md": "a\n" });
    await writeFiles(path.join(root, "b"), { ".claude/rules/b.md": "b\n" });
    const io = fakeIo(["", "", "", "", path.join(root, "b"), ""]);
    const r = await askSetup(none, io, ctx);
    expect(io.said.some((l) => l.startsWith("setup imports one workspace"))).toBe(true);
    expect(r.kind === "answered" && r.answers).toMatchObject({ importWs: cwd, workspaces: [cwd] });
  });

  it("offers the import for a workspace the flags gave", async () => {
    const { root, ctx } = await cwdDir();
    await writeFiles(path.join(root, "b"), { ".claude/rules/b.md": "b\n" });
    const io = fakeIo(["", "", "", "", ""]);
    const r = await askSetup({ ...none, workspaces: [path.join(root, "b")] }, io, ctx);
    expect(io.asked[0]).toBe(`${path.join(root, "b")} holds .claude/. Import it into the Forge [yes]: `);
    expect(r.kind === "answered" && r.answers.importWs).toBe(path.join(root, "b"));
  });

  it("does not offer the current directory when the Forge would nest in it, and says why (S2)", async () => {
    const { cwd, ctx } = await cwdDir();
    const io = fakeIo([path.join(cwd, "forge"), "", "", "", "", ""]);
    const r = await askSetup(none, io, ctx);
    expect(io.said.some((l) => l.startsWith(`not offering ${cwd} as a workspace: the Forge and a workspace cannot nest`))).toBe(true);
    expect(io.asked.some((q) => q.startsWith("Start a workspace in"))).toBe(false);
    expect(r.kind === "answered" && r.answers.workspaces).toEqual([]);
  });

  it("quotes the again line for a POSIX shell", () => {
    const a = { forgeAbs: "/w/it's $f", name: "f", profile: "acme", targets: ["claude-code" as const], starter: true, git: true, workspaces: [], importWs: null };
    expect(setupAgainLine(a, "/w", { sync: true, platform: "linux" })).toContain(`--forge-dir 'it'\\''s $f'`);
  });
});

