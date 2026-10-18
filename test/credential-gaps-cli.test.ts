/**
 * Spec 39 gap 2 — CLI tests for single-slash credential spellings (`https:/user:pw@...`).
 *
 * These spellings used to be read as paths and printed whole. Now `credentialFault` flags them,
 * so every CLI command that loads a workspace refuses them with the credential message.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeForge, profile, recipe, rule, scenario, tmpDir, writeFiles } from "./helpers/forge.js";
import { runCli } from "./helpers/cli.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// Fake credentials assembled at runtime so a grep never finds them as a literal.
const USER = ["fake", "user"].join("");
const PW = ["NOTA", "SECRET"].join("");
const CRED = `${USER}:${PW}@`;

describe("spec 39 gap 2: a forge: spelled with one slash after the scheme", () => {
  // Single-slash spellings — a scheme followed by one `/` instead of `//`.
  const spellings = [
    `https:/${CRED}example.invalid/acme/forge.git`,
    `https:/${USER}@example.invalid/acme/forge.git`,
    `http:/${CRED}example.invalid/acme/forge.git`,
    `ssh:/${CRED}example.invalid/acme/forge.git`,
  ];

  /** Set up a workspace with a craftar.yaml that holds a single-slash credential. */
  async function wsWithForge(forgeValue: string) {
    const root = await tmpDir("craftar-gap2-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const forge = path.join(root, "forge");
    const ws = path.join(root, "ws");
    await makeForge(forge, {
      ingredients: [rule("a", "# A\n")],
      recipes: [recipe("base", ["rule/a"])],
      profiles: [profile("acme", ["base"])],
    });
    await fs.mkdir(ws);
    await fs.writeFile(path.join(ws, "craftar.yaml"), `forge: ${forgeValue}\nprofile: acme\n`);
    const home = path.join(root, "home");
    await fs.mkdir(home);
    return { root, forge, ws, home };
  }

  it("sync: exit 1, the credential message, nothing of the fake password printed", async () => {
    for (const forge of spellings) {
      const { ws, home } = await wsWithForge(forge);
      const r = runCli(["sync", "--workspace", ws], { env: { CRAFTAR_HOME: home } });
      expect(r.code, forge.replace(PW, "<pw>")).toBe(1);
      expect(r.stderr, forge.replace(PW, "<pw>")).toContain("craftar.yaml › forge holds credentials in the URL");
      expect(r.stdout + r.stderr, forge.replace(PW, "<pw>")).not.toContain(PW);
      expect(r.stdout + r.stderr, forge.replace(PW, "<pw>")).not.toContain(PW.toLowerCase());
    }
  });

  it("status: exit 1, the credential message, nothing of the fake password printed", async () => {
    for (const forge of spellings) {
      const { ws, home } = await wsWithForge(forge);
      const r = runCli(["status", "--workspace", ws], { env: { CRAFTAR_HOME: home } });
      expect(r.code, forge.replace(PW, "<pw>")).toBe(1);
      expect(r.stderr, forge.replace(PW, "<pw>")).toContain("craftar.yaml › forge holds credentials in the URL");
      expect(r.stdout + r.stderr, forge.replace(PW, "<pw>")).not.toContain(PW);
      expect(r.stdout + r.stderr, forge.replace(PW, "<pw>")).not.toContain(PW.toLowerCase());
    }
  });

  it("init --forge: exit 1, the credential message, nothing of the fake password printed", async () => {
    for (const forge of spellings) {
      const root = await tmpDir("craftar-gap2-init-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const ws = path.join(root, "ws");
      await fs.mkdir(ws);
      const home = path.join(root, "home");
      await fs.mkdir(home);
      const r = runCli(["init", "--workspace", ws, "--forge", forge, "--profile", "acme"], { env: { CRAFTAR_HOME: home } });
      expect(r.code, forge.replace(PW, "<pw>")).toBe(1);
      expect(r.stderr, forge.replace(PW, "<pw>")).toContain("--forge holds credentials in the URL");
      expect(r.stdout + r.stderr, forge.replace(PW, "<pw>")).not.toContain(PW);
      expect(r.stdout + r.stderr, forge.replace(PW, "<pw>")).not.toContain(PW.toLowerCase());
    }
  });

  it("import --write-config: exit 1, the credential message, nothing of the fake password printed", async () => {
    for (const forge of spellings) {
      const { ws, home, forge: forgeDir } = await wsWithForge(forge);
      // Set up a minimal .claude/rules file so import has something to read
      await writeFiles(ws, { ".claude/rules/a.md": "# A\n" });
      const r = runCli(["import", "--from", "claude-code", "--workspace", ws, "--forge", forgeDir, "--profile", "acme", "--write-config"], {
        env: { CRAFTAR_HOME: home },
      });
      expect(r.code, forge.replace(PW, "<pw>")).toBe(1);
      expect(r.stderr, forge.replace(PW, "<pw>")).toContain("craftar.yaml › forge holds credentials in the URL");
      expect(r.stdout + r.stderr, forge.replace(PW, "<pw>")).not.toContain(PW);
      expect(r.stdout + r.stderr, forge.replace(PW, "<pw>")).not.toContain(PW.toLowerCase());
    }
  });
});

describe("spec 39 gap 2: a forge: spelled with tab/LF/CR inside the scheme or its ://", () => {
  // Tab/LF/CR spellings — control characters that a URL parser removes.
  const spellings = [
    `https:\t//${CRED}example.invalid/acme/forge.git`,
    `https:/\n/${USER}@example.invalid/acme/forge.git`,
    `ht\ttps://${USER}@example.invalid/acme/forge.git`,
    `https:\r//${CRED}example.invalid/acme/forge.git`,
  ];

  it("sync: exit 1, the credential message, nothing of the fake password printed", async () => {
    for (const forge of spellings) {
      const root = await tmpDir("craftar-gap2-ctl-");
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      const forgeDir = path.join(root, "forge");
      const ws = path.join(root, "ws");
      await makeForge(forgeDir, {
        ingredients: [rule("a", "# A\n")],
        recipes: [recipe("base", ["rule/a"])],
        profiles: [profile("acme", ["base"])],
      });
      await fs.mkdir(ws);
      await fs.writeFile(path.join(ws, "craftar.yaml"), `forge: ${JSON.stringify(forge)}\nprofile: acme\n`);
      const home = path.join(root, "home");
      await fs.mkdir(home);
      const r = runCli(["sync", "--workspace", ws], { env: { CRAFTAR_HOME: home } });
      const label = JSON.stringify(forge).replace(PW, "<pw>").replace(USER, "<u>");
      expect(r.code, label).toBe(1);
      expect(r.stderr, label).toContain("craftar.yaml › forge holds credentials in the URL");
      expect(r.stdout + r.stderr, label).not.toContain(PW);
      expect(r.stdout + r.stderr, label).not.toContain(PW.toLowerCase());
    }
  });
});

describe("spec 39 gap 2 — the interactive init refuses the answer and does not offer it back", () => {
  // One-slash spelling for the Forge answer
  const ONE_SLASH = `https:/${CRED}example.invalid/acme/forge.git`;

  it("a one-slash spelling typed as the Forge is refused, and no question or line holds any part of it", async () => {
    const { askInit } = await import("../src/core/init-flow.js");
    const root = await tmpDir("craftar-gap2-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    await fs.mkdir(home);
    const asked: string[] = [];
    const said: string[] = [];
    const answers = [ONE_SLASH];
    const next = async (q: string) => (asked.push(q), answers.shift() ?? null);
    const io = { ask: next, confirm: next, say: (l: string) => void said.push(l) };
    const result = await askInit(path.join(root, "ws"), { addRecipes: [], removeRecipes: [], replace: false }, { doc: null, keys: [] }, io, { home, registryOff: false });
    expect(result.kind).toBe("cancelled");
    expect(said).toContain("the answer holds credentials in the URL — remove them and let git authenticate");
    const all = JSON.stringify([asked, said]);
    expect(all.includes(PW), "the password is printed or offered").toBe(false);
    expect(all.includes(USER), "the user is printed or offered").toBe(false);
  });
});
