import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadForge } from "../src/core/forge.js";
import { resolve } from "../src/core/resolve.js";
import {
  SCHEMA_LEVELS,
  TARGET_STATES,
  derivedName,
  rulesReachNoFile,
  setupForgeFiles,
  setupSchema,
  showsSetupHint,
} from "../src/core/setup.js";
import { TARGETS, WorkspaceConfigSchema } from "../src/schema/index.js";
import { tmpDir } from "./helpers/forge.js";

// Spec 62 §3, §4.5, §4.6, §5.1, §5.2 — the pure part of `craftar setup`. Nothing here writes outside a temp directory.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("setupSchema (§3, R5)", () => {
  it("is the lowest level the targets need", () => {
    expect(setupSchema(["claude-code"])).toBe(1);
    expect(setupSchema(["claude-code", "kiro", "agents-md"])).toBe(1);
    expect(setupSchema(["kiro", "cursor"])).toBe(15);
    expect(setupSchema(["codex"])).toBe(16);
    expect(setupSchema(["claude-code", "opencode"])).toBe(18);
  });
  it("never answers 17, whatever the targets", () => {
    for (const t of TARGETS) expect(setupSchema([t])).not.toBe(17);
  });
});

describe("setupForgeFiles (§5.1, §5.2)", () => {
  it("writes the exact skeleton and starter bytes", () => {
    const files = setupForgeFiles({ name: "acme-forge", profile: "acme", targets: ["claude-code"], starter: true });
    const by = new Map(files.map((f) => [f.path, f.text]));
    expect([...by.keys()]).toEqual([
      "craftar.forge.yaml",
      "README.md",
      "ingredients/rules/project-conventions/ingredient.yaml",
      "ingredients/rules/project-conventions/rule.md",
      "profiles/acme/profile.yaml",
      "recipes/base.yaml",
    ]);
    expect(by.get("craftar.forge.yaml")).toBe(
      "name: acme-forge\nschema: 1\ndescription: Craftar Forge — shared harness ingredients, recipes and client profiles.\n",
    );
    expect(by.get("profiles/acme/profile.yaml")).toBe("name: acme\nrecipes:\n  - base\ntargets:\n  - claude-code\n");
    expect(by.get("recipes/base.yaml")).toBe("name: base\ningredients: [rule/project-conventions]\n");
    expect(by.get("ingredients/rules/project-conventions/ingredient.yaml")).toBe(
      "type: rule\nname: project-conventions\ndescription: Project conventions — the first rule of this Forge; edit or replace it.\n",
    );
    const rule = by.get("ingredients/rules/project-conventions/rule.md")!;
    expect(rule).toContain("ingredients/rules/project-conventions/rule.md");
    expect(rule).toContain("craftar sync");
    for (const f of files) {
      expect(f.text.includes("\r"), f.path).toBe(false);
      expect(f.text.charCodeAt(0) === 0xfeff, f.path).toBe(false);
      expect(f.text.endsWith("\n"), f.path).toBe(true);
    }
  });

  it("writes the skeleton alone under --no-starter, with .gitkeep in the empty folders", () => {
    const files = setupForgeFiles({ name: "f", profile: "acme", targets: ["kiro", "opencode"], starter: false });
    const by = new Map(files.map((f) => [f.path, f.text]));
    expect([...by.keys()]).toEqual(["craftar.forge.yaml", "README.md", "ingredients/.gitkeep", "profiles/acme/profile.yaml", "recipes/.gitkeep"]);
    expect(by.get("profiles/acme/profile.yaml")).toBe("name: acme\nrecipes: []\ntargets:\n  - kiro\n  - opencode\n");
    expect(by.get("craftar.forge.yaml")).toContain("schema: 18\n");
    expect(by.get("ingredients/.gitkeep")).toBe("");
  });

  it("README lists every schema level of the CLI README's Compatibility table", async () => {
    const readme = await fs.readFile(path.join(__dirname, "..", "README.md"), "utf8");
    const rows = [...readme.matchAll(/^\| `(\d+)` \| (.+?) \| [^|]+ \|$/gm)].map((m) => Number(m[1]));
    expect(rows.length).toBeGreaterThan(10);
    expect(SCHEMA_LEVELS.map((l) => l.level)).toEqual(rows.filter((n) => n >= 2));
    const text = setupForgeFiles({ name: "f", profile: "acme", targets: ["claude-code"], starter: true }).find((f) => f.path === "README.md")!.text;
    for (const l of SCHEMA_LEVELS) expect(text).toContain(`| ${l.level} |`);
  });

  it("the files load as a Forge and the profile resolves the starter rule", async () => {
    for (const starter of [true, false]) {
      const root = await fs.realpath(await tmpDir("craftar-setup-core-"));
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      for (const f of setupForgeFiles({ name: "acme-forge", profile: "acme", targets: ["claude-code", "kiro"], starter })) {
        await fs.mkdir(path.dirname(path.join(root, f.path)), { recursive: true });
        await fs.writeFile(path.join(root, f.path), f.text);
      }
      const forge = await loadForge(root);
      expect(forge.manifest.name).toBe("acme-forge");
      const res = resolve(forge, WorkspaceConfigSchema.parse({ forge: root, profile: "acme" }));
      expect(res.ingredients.map((i) => i.ref)).toEqual(starter ? ["rule/project-conventions"] : []);
    }
  });
});

describe("derivedName (§4.5 Q3)", () => {
  it("reduces a directory's base name to the profile-name grammar", () => {
    expect(derivedName("/x/acme-forge")).toBe("acme-forge");
    expect(derivedName("/x/My Forge")).toBe("my-forge");
    expect(derivedName("/x/__Acme__ Team!!")).toBe("acme-team");
    expect(derivedName("/x/---")).toBe("forge");
    expect(derivedName("C:\\work\\Acme")).toBe("acme");
  });
});

describe("rulesReachNoFile (S12)", () => {
  it("is true only when every target writes no rule file", () => {
    expect(rulesReachNoFile(["codex"])).toBe(true);
    expect(rulesReachNoFile(["opencode"])).toBe(true);
    expect(rulesReachNoFile(["codex", "agent-skills", "opencode"])).toBe(true);
    expect(rulesReachNoFile(["codex", "agents-md"])).toBe(false);
    expect(rulesReachNoFile(["claude-code"])).toBe(false);
    expect(rulesReachNoFile(["cursor"])).toBe(false);
  });
});

describe("TARGET_STATES (§4.5)", () => {
  it("labels opencode as the README tags it and every other target working", async () => {
    const readme = await fs.readFile(path.join(__dirname, "..", "README.md"), "utf8");
    expect(readme).toMatch(/^\*\*opencode\*\* \(`mvp`/m);
    for (const t of TARGETS) expect(TARGET_STATES[t]).toBe(t === "opencode" ? "mvp" : "working");
  });
});

describe("showsSetupHint (§4.6)", () => {
  it("shows only in a terminal, with no registered workspace and a registry that reads", () => {
    expect(showsSetupHint(true, "absent")).toBe(true);
    expect(showsSetupHint(true, "empty")).toBe(true);
    expect(showsSetupHint(true, "registered")).toBe(false);
    expect(showsSetupHint(true, "unreadable")).toBe(false);
    expect(showsSetupHint(false, "absent")).toBe(false);
  });
});

describe("proveSetupForge (S10)", () => {
  it("refuses a Forge that does not plan, naming the Forge directory and never the scratch one, and leaves no scratch behind", async () => {
    const { proveSetupForge } = await import("../src/core/setup-write.js");
    const os = await import("node:os");
    const before = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("craftar-setup-proof-"));
    const files = setupForgeFiles({ name: "f", profile: "acme", targets: ["claude-code"], starter: false }).map((f) =>
      f.path === "profiles/acme/profile.yaml" ? { ...f, text: "name: acme\nrecipes:\n  - missing\ntargets:\n  - claude-code\n" } : f,
    );
    const err = await proveSetupForge(files, "acme", "/the/forge").then(
      () => null,
      (e: Error) => e.message,
    );
    expect(err).toMatch(/^setup: the new Forge would not load and plan — /);
    expect(err).toContain("missing");
    expect(err).not.toMatch(/craftar-setup-proof-/);
    expect((await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("craftar-setup-proof-"))).toEqual(before);
  });
});
