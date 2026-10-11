import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listFiles } from "../src/core/forge.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, tmpDir, type ForgeSpec, type WorkspaceSpec } from "./helpers/forge.js";
import { forgeAt, mcp } from "./helpers/integrations.js";

// Spec 34 §9 — the credential refusal on every surface a plan error reaches, without the value; and the
// commands that read the Forge as written print at schema 4 what they print at 3.

const GHP = "ghp_" + "x".repeat(36); // assembled at runtime on purpose
const MESSAGE =
  "mcp/idp: the value rendered into server.headers.Authorization looks like a credential (github-token) — a generated file is committed, so a secret cannot come from a param; have the server read it from the environment";
const SERVER = { type: "http", url: "https://idp.example.com/mcp", headers: { Authorization: "Bearer {{token}}" } };
/** `token` declared; the value comes from where `where` says. */
const refusing = (where: "profile" | "none"): ForgeSpec => ({
  ingredients: [rule("workflow", "# Workflow\n"), mcp("idp", SERVER, { params: { token: { default: "public" } } }), rule("extra", "# Extra\n")],
  recipes: [recipe("base", ["rule/workflow", "mcp/idp"]), recipe("extra", ["rule/extra"])],
  profiles: [profile("acme", ["base"], ["claude-code", "kiro"], where === "profile" ? { params: { token: GHP } } : {})],
});
type Run = { code: number | null; stdout: string; stderr: string };
const clean = (r: Run) => !r.stdout.includes(GHP) && !r.stderr.includes(GHP);
const REFUSED = [1, "", `error: ${MESSAGE}\n`];

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function at(schema: number, spec: ForgeSpec, ws: WorkspaceSpec = { config: { profile: "acme" } }) {
  const s = await forgeAt(schema, spec, ws);
  cleanups.push(s.cleanup);
  return { ...s, env: { CRAFTAR_HOME: path.join(s.root, "home") } };
}
/** Give the Forge's profile the token, as a hand edit of `profile.yaml` would. */
const setToken = (forgeRoot: string) =>
  fs.writeFile(path.join(forgeRoot, "profiles/acme/profile.yaml"), YAML.stringify(profile("acme", ["base"], ["claude-code", "kiro"], { params: { token: GHP } })));

describe("the credential refusal, on every surface", () => {
  for (const args of [["sync"], ["status"], ["diff"], ["sync", "--check"], ["sync", "--dry-run"], ["ls"], ["explain", ".mcp.json"]]) {
    it(`1. ${args.join(" ")} exits 1 with the one line, and writes nothing`, async () => {
      const s = await at(4, refusing("profile"));
      const r = runCli([...args, "--workspace", s.wsRoot], { env: s.env });
      expect([r.code, r.stdout, r.stderr]).toEqual(REFUSED);
      expect(await listFiles(s.wsRoot)).toEqual(["craftar.yaml"]);
    });
  }

  it("2. status --json and diff --exit-code exit 1 with the same line and print nothing else", async () => {
    const s = await at(4, refusing("profile"));
    for (const args of [["status", "--json"], ["diff", "--exit-code"]]) {
      const r = runCli([...args, "--workspace", s.wsRoot], { env: s.env });
      expect([r.code, r.stdout, r.stderr], args.join(" ")).toEqual(REFUSED);
    }
  });

  it("3. add recipe and remove recipe refuse before they write", async () => {
    const s = await at(4, refusing("profile"));
    const yaml = path.join(s.wsRoot, "craftar.yaml");
    const before = await fs.readFile(yaml, "utf8");
    const add = runCli(["add", "recipe", "extra", "--workspace", s.wsRoot], { env: s.env });
    expect([add.code, add.stdout, add.stderr]).toEqual(REFUSED);
    expect(await fs.readFile(yaml, "utf8")).toBe(before);

    // `remove recipe`: a first `add` made while the profile had no token, then the token set.
    const t = await at(4, refusing("none"));
    expect(runCli(["add", "recipe", "extra", "--workspace", t.wsRoot], { env: t.env }).code).toBe(0);
    const added = await fs.readFile(path.join(t.wsRoot, "craftar.yaml"), "utf8");
    await setToken(t.forgeRoot);
    const remove = runCli(["remove", "recipe", "extra", "--workspace", t.wsRoot], { env: t.env });
    expect([remove.code, remove.stdout, remove.stderr]).toEqual(REFUSED);
    expect(await fs.readFile(path.join(t.wsRoot, "craftar.yaml"), "utf8")).toBe(added);
    expect([add, remove].every(clean)).toBe(true);
  });

  it("4. init refuses before it writes", async () => {
    const s = await at(4, refusing("profile"));
    const d = await tmpDir("craftar-server-init-");
    cleanups.push(() => fs.rm(d, { recursive: true, force: true }));
    const r = runCli(["init", "--forge", s.forgeRoot, "--profile", "acme", "--workspace", d], { env: s.env });
    expect([r.code, r.stdout, r.stderr]).toEqual(REFUSED);
    expect(await listFiles(d)).toEqual([]);
  });

  it("5. doctor reports it as one error under plan", async () => {
    const s = await at(4, refusing("profile"));
    const r = runCli(["doctor", "--workspace", s.wsRoot, "--json"], { env: s.env });
    expect(r.code).toBe(1);
    const checks: Array<{ id: string }> = JSON.parse(r.stdout).checks;
    expect(checks.filter((c) => c.id === "plan")).toEqual([{ id: "plan", scope: "workspace", level: "error", message: MESSAGE, fix: null }]);
    expect(clean(r)).toBe(true);
    const text = runCli(["doctor", "--workspace", s.wsRoot], { env: s.env });
    expect(text.code).toBe(1);
    expect(clean(text)).toBe(true);
  });

  it("6. craftar workspaces and forge impact show error; 7. a planned file is shown, a refused value never is", { timeout: 60_000 }, async () => {
    const s = await at(4, refusing("none"));
    expect(runCli(["sync", "--workspace", s.wsRoot], { env: s.env }).code).toBe(0);
    // 7: before the token is set, the planned file is what diff and the workspace hold — `Bearer public`.
    expect(JSON.parse(await fs.readFile(path.join(s.wsRoot, ".mcp.json"), "utf8")).mcpServers.idp.headers.Authorization).toBe("Bearer public");
    await fs.rm(path.join(s.wsRoot, ".mcp.json"));
    const shown = runCli(["diff", "--workspace", s.wsRoot], { env: s.env });
    expect(shown.code).toBe(0);
    expect(shown.stdout.split("\n")).toContain('+         "Authorization": "Bearer public"');

    await setToken(s.forgeRoot);
    const ws = runCli(["workspaces", "--json"], { env: s.env });
    const jw = JSON.parse(ws.stdout);
    expect(jw.workspaces.map((w: { status: string }) => w.status)).toEqual(["error"]);
    const impact = runCli(["forge", "impact", "--forge", s.forgeRoot, "--json"], { env: s.env });
    const ji = JSON.parse(impact.stdout);
    expect(ji.workspaces.map((w: { state: string; error: string | null }) => [w.state, w.error])).toEqual([["error", MESSAGE]]);
    const texts = [runCli(["workspaces"], { env: s.env }), runCli(["forge", "impact", "--forge", s.forgeRoot], { env: s.env }), runCli(["diff", "--workspace", s.wsRoot], { env: s.env })];
    expect([ws, impact, ...texts].every(clean)).toBe(true);
    expect([texts[2].code, texts[2].stdout, texts[2].stderr]).toEqual(REFUSED);
  });

  it("8. the value in craftar.local.yaml is refused the same way", async () => {
    const s = await at(4, refusing("none"), { config: { profile: "acme" }, local: { overrides: { params: { token: GHP } } } });
    const r = runCli(["sync", "--workspace", s.wsRoot], { env: s.env });
    expect([r.code, r.stdout, r.stderr]).toEqual(REFUSED);
    expect((await listFiles(s.wsRoot)).sort()).toEqual(["craftar.local.yaml", "craftar.yaml"]);
  });

  it("(control) the same Forge at schema 3 syncs, and writes the braces", async () => {
    const s = await at(3, refusing("profile"));
    const r = runCli(["sync", "--workspace", s.wsRoot], { env: s.env });
    expect([r.code, r.stderr]).toEqual([0, ""]);
    expect(JSON.parse(await fs.readFile(path.join(s.wsRoot, ".mcp.json"), "utf8")).mcpServers.idp.headers.Authorization).toBe("Bearer {{token}}");
  });
});

describe("read-only commands print at schema 4 what they print at 3", () => {
  const T = (): ForgeSpec => {
    const spec = refusing("none");
    return { ...spec, ingredients: [...spec.ingredients!, mcp("idp--acme", { type: "http", url: "https://other.example.com/mcp" }, { as: "idp" })] };
  };
  /** The same command on the schema 3 and the schema 4 Forge, each Forge's and workspace's path replaced. */
  async function both(args: (s: { forgeRoot: string; wsRoot: string }) => string[]): Promise<[Run, Run]> {
    const out: Run[] = [];
    for (const schema of [3, 4]) {
      const s = await at(schema, T());
      const r = runCli(args(s), { env: s.env });
      const norm = (text: string) => text.replaceAll(s.forgeRoot, "<FORGE>").replaceAll(s.wsRoot, "<WS>");
      out.push({ code: r.code, stdout: norm(r.stdout), stderr: norm(r.stderr) });
    }
    return [out[0], out[1]];
  }
  const same = async (label: string, args: (s: { forgeRoot: string; wsRoot: string }) => string[]) => {
    const [three, four] = await both(args);
    expect(three.code, `${label}: ${three.stderr}`).toBe(0);
    expect(three.stdout.length, label).toBeGreaterThan(0);
    expect(four, label).toEqual(three);
  };

  // One `it` per command: each runs the CLI twice, and a test that spawns ten processes can outrun its timeout on a loaded machine.
  const SAME: Array<[string, (s: { forgeRoot: string; wsRoot: string }) => string[]]> = [
    ["9. recipes", (s) => ["recipes", "--forge", s.forgeRoot]],
    ["9. recipes --profile --json", (s) => ["recipes", "--forge", s.forgeRoot, "--profile", "acme", "--json"]],
    ["9. ingredients", (s) => ["ingredients", "--forge", s.forgeRoot]],
    ["9. ingredients --json", (s) => ["ingredients", "--forge", s.forgeRoot, "--json"]],
    ["9. targets --json", (s) => ["targets", "--workspace", s.wsRoot, "--json"]],
    ["10. forge variants", (s) => ["forge", "variants", "--forge", s.forgeRoot]],
    ["10. forge variants --json", (s) => ["forge", "variants", "--forge", s.forgeRoot, "--json"]],
    ["10. forge diff", (s) => ["forge", "diff", "mcp/idp", "--against", "acme", "--forge", s.forgeRoot]],
    ["10. forge diff --json", (s) => ["forge", "diff", "mcp/idp", "--against", "acme", "--forge", s.forgeRoot, "--json"]],
    ["11. ls", (s) => ["ls", "--workspace", s.wsRoot]],
    ["11. explain of a rule", (s) => ["explain", ".claude/rules/workflow.md", "--workspace", s.wsRoot]],
  ];
  for (const [label, args] of SAME) it(label, () => same(label, args));

  it("10. forge diff prints no server at all: a difference in server is metadata, at 3 and at 4", async () => {
    const [three, four] = await both((s) => ["forge", "diff", "mcp/idp", "--against", "acme", "--forge", s.forgeRoot]);
    expect([three.stdout, four.stdout]).toEqual(["mcp/idp  base ↔ acme — meta only\n", "mcp/idp  base ↔ acme — meta only\n"]);
  });

  it("12. explain .mcp.json differs in one line only, the hash of the planned file", async () => {
    const [three, four] = await both((s) => ["explain", ".mcp.json", "--workspace", s.wsRoot]);
    expect([three.code, four.code]).toEqual([0, 0]);
    const split = (text: string) => ({ hash: text.split("\n").filter((l) => l.startsWith("  hash ")), rest: text.split("\n").filter((l) => !l.startsWith("  hash ")) });
    const [a, b] = [split(three.stdout), split(four.stdout)];
    expect([a.hash.length, b.hash.length]).toEqual([1, 1]);
    expect(b.rest).toEqual(a.rest);
    expect(b.hash).not.toEqual(a.hash);
  });
});

describe("README", () => {
  it("the README names the gate, the refusal and the kinds the code uses", async () => {
    const readme = await fs.readFile(path.resolve(__dirname, "../README.md"), "utf8");
    for (const s of ["schema: 4", "url-credentials", "high-entropy-value", "not declared in the ingredient's params — left verbatim", "craftar.local.yaml"]) expect(readme, s).toContain(s);
    expect(readme).not.toMatch(/expands? `?\$\{NAME\}`? in (url|headers|args)/i);
  });
});
