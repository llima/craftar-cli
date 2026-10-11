import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCli } from "./helpers/cli.js";
import { MCP_FILES, eightStates, explained, mcpWorkspace, syncOnce, type Scenario } from "./helpers/states.js";
import { TSX_LOADER } from "./helpers/tsx-loader.js";

// Spec 35 §10.1 (and spec 36 §10.1): what the reading commands print today, pinned BEFORE their builders move
// into src/core/report.ts. Every test here is a control: it passes on the commit before the lift and after it.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

const R = ".claude/rules";
const lockOf = (name: string, hash: string) => ({ path: `${R}/${name}.md`, hash, target: "claude-code", ingredient: `rule/${name}` });
const row = (name: string, state: string, hash?: string) => ({
  path: `${R}/${name}.md`,
  state,
  target: "claude-code",
  ingredient: `rule/${name}`,
  ...(hash ? { lock: lockOf(name, hash) } : {}),
});
const H = {
  edited: "sha256:cf4ab371ad9869241b6ee1942bcdf50611db7581d6b3e9c6847c6b0f003ee773",
  goneEdited: "sha256:e97174db0e15246c338a6acdd2ca26d6ba371ee5553f8fb7136a1b98eb18b6c5",
  gone: "sha256:179bbd94af11271d3a62e9aae6dd5527305d5950292f8639d66b30958cb8c48b",
  keep: "sha256:9a75bf85a4bb172834fe5d5b052612c0dedc2859adda6afbbbeb76005c6c1195",
};

const DIFF_ALL =
  `--- ${R}/clash.md (disk, collision)\n+++ ${R}/clash.md (forge)\n  # Clash\n- disk side\n+ forge side\n` +
  `--- ${R}/edited.md (disk, drift)\n+++ ${R}/edited.md (forge)\n  # Edited\n- by hand\n+ by the forge\n` +
  `--- ${R}/fresh.md (disk, new)\n+++ ${R}/fresh.md (forge)\n+ # Fresh\n` +
  `--- ${R}/gone-edited.md (disk, orphan-drift)\n  no longer produced by the Forge but hand-edited — kept; \`craftar drift discard <path>\` removes it, or delete it yourself\n` +
  `--- ${R}/gone.md (disk, orphan)\n+++ ${R}/gone.md (forge: no longer produced — sync removes it)\n- # Gone\n` +
  `--- ${R}/moved.md (disk, update)\n+++ ${R}/moved.md (forge)\n  # Moved\n- old line\n+ new line\n`;

describe("pins — a workspace holding one file in each state", () => {
  it("status --json: the whole document, rows with their lock entry and without `planned`", async () => {
    const s = kept(await eightStates());
    const r = runCli(["status", "--json", "--workspace", s.wsRoot]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const moved = JSON.parse(r.stdout).statuses[7].lock.hash as string;
    expect(moved).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.stdout).toBe(
      JSON.stringify(
        {
          forge: { kind: "path", source: "../forge", ref: null, defaultBranch: null, commit: null, lockCommit: null, fetched: false },
          statuses: [
            row("adopted", "adopt"),
            row("clash", "collision"),
            row("edited", "drift", H.edited),
            row("fresh", "new"),
            row("gone-edited", "orphan-drift", H.goneEdited),
            row("gone", "orphan", H.gone),
            row("keep", "unchanged", H.keep),
            row("moved", "update", moved),
          ],
          warnings: [],
          unsetParams: [],
        },
        null,
        2,
      ) + "\n",
    );
  });

  it("diff: the six states sync --check refuses, byte for byte", async () => {
    const s = kept(await eightStates());
    expect(runCli(["diff", "--workspace", s.wsRoot])).toEqual({ code: 0, stdout: DIFF_ALL, stderr: "" });
  });

  it("diff <path>: one file; `./<path>` matches no row and an unchanged file prints no differences (as today)", async () => {
    const s = kept(await eightStates());
    const W = ["--workspace", s.wsRoot];
    expect(runCli(["diff", `${R}/edited.md`, ...W]).stdout).toBe(`--- ${R}/edited.md (disk, drift)\n+++ ${R}/edited.md (forge)\n  # Edited\n- by hand\n+ by the forge\n`);
    expect(runCli(["diff", `./${R}/edited.md`, ...W])).toEqual({ code: 0, stdout: "no differences\n", stderr: "" });
    expect(runCli(["diff", `${R}/keep.md`, ...W])).toEqual({ code: 0, stdout: "no differences\n", stderr: "" });
    expect(runCli(["diff", `${R}/adopted.md`, ...W])).toEqual({ code: 0, stdout: "no differences\n", stderr: "" });
  });

  it("diff keeps its paint: bold headers, dim context, red and green lines", async () => {
    const s = kept(await eightStates());
    // runCli forces NO_COLOR=1; this sibling removes it and forces colour, so the lift cannot lose DIFF_PAINT unseen.
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "1" };
    delete env.NO_COLOR;
    const r = spawnSync(process.execPath, ["--import", TSX_LOADER, path.resolve(__dirname, "../src/cli.ts"), "diff", `${R}/edited.md`, "--workspace", s.wsRoot], { encoding: "utf8", env, timeout: 25_000 });
    expect(r.stdout).toBe(
      `\u001b[1m--- ${R}/edited.md (disk, drift)\u001b[22m\n\u001b[1m+++ ${R}/edited.md (forge)\u001b[22m\n\u001b[2m  # Edited\u001b[22m\n\u001b[31m- by hand\u001b[39m\n\u001b[32m+ by the forge\u001b[39m\n`,
    );
  });

  it("drift show: the list, a drifted file with its diff, an orphan-drift as a whole-file removal", async () => {
    const s = kept(await eightStates());
    const W = ["--workspace", s.wsRoot];
    expect(runCli(["drift", "show", ...W]).stdout).toBe(
      `drift         ${R}/edited.md       rule/edited       forge: same     promote: yes\norphan-drift  ${R}/gone-edited.md  rule/gone-edited  forge: removed  promote: no (no longer produced)\n`,
    );
    expect(runCli(["drift", "show", `${R}/edited.md`, ...W]).stdout).toBe(
      `drift         ${R}/edited.md  rule/edited  forge: same  promote: yes\n--- ${R}/edited.md (disk, drift)\n+++ ${R}/edited.md (forge)\n  # Edited\n- by hand\n+ by the forge\n`,
    );
    expect(runCli(["drift", "show", `${R}/gone-edited.md`, ...W]).stdout).toBe(
      `orphan-drift  ${R}/gone-edited.md  rule/gone-edited  forge: removed  promote: no (no longer produced)\n--- ${R}/gone-edited.md (disk, orphan-drift)\n+++ ${R}/gone-edited.md (forge: no longer produced — \`craftar drift discard\` removes it)\n- # Gone edited\n- by hand\n`,
    );
  });

  it("recipes --json: the whole document", async () => {
    const s = kept(await eightStates());
    expect(runCli(["recipes", "--json", "--workspace", s.wsRoot]).stdout).toBe(
      JSON.stringify(
        {
          forge: { name: "test-forge", commit: null },
          context: { kind: "workspace", profile: "acme", recipes: ["base"] },
          recipes: [
            {
              name: "base",
              description: null,
              slot: null,
              extends: [],
              ingredients: ["rule/keep", "rule/moved", "rule/edited", "rule/fresh", "rule/clash", "rule/adopted"],
              profiles: ["acme"],
              inUse: { order: 1, by: ["profile"], extendedBy: [] },
              removedByWorkspace: false,
            },
          ],
          warnings: [],
        },
        null,
        2,
      ) + "\n",
    );
  });

  // The two long documents are pinned as snapshot files, written ONCE by this step on the commit before the lift.
  it("ingredients --json and targets --json (in a workspace, and in a directory with no craftar.yaml): the exact stdout", async () => {
    const s = kept(await eightStates());
    await expect(runCli(["ingredients", "--json", "--workspace", s.wsRoot]).stdout).toMatchFileSnapshot("./pins/ingredients.json");
    await expect(runCli(["targets", "--json", "--workspace", s.wsRoot]).stdout).toMatchFileSnapshot("./pins/targets-in-workspace.json");
    const bare = runCli(["targets", "--json"], { cwd: s.root });
    expect(bare.code).toBe(0);
    await expect(bare.stdout).toMatchFileSnapshot("./pins/targets-no-workspace.json");
  });

  it("a load warning: recipes --json and ingredients --json put it first; diff and explain print it on stderr", async () => {
    const s = kept(await eightStates());
    const W = ["--workspace", s.wsRoot];
    await fs.appendFile(path.join(s.wsRoot, "craftar.yaml"), "ref: v1\n");
    const warn = 'ref "v1" is ignored: the Forge is a path (../forge), read as its working tree';
    expect(JSON.parse(runCli(["recipes", "--json", ...W]).stdout).warnings).toEqual([warn]);
    expect(JSON.parse(runCli(["ingredients", "--json", ...W]).stdout).warnings).toEqual([warn]);
    expect(JSON.parse(runCli(["status", "--json", ...W]).stdout).warnings).toEqual([warn]);
    expect(runCli(["diff", `${R}/keep.md`, ...W])).toEqual({ code: 0, stdout: "no differences\n", stderr: `warn ${warn}\n` });
    expect(runCli(["explain", `${R}/keep.md`, ...W]).stderr).toBe(`warn ${warn}\n`);
  });
});

describe("pins — the three MCP files, hand-edited", () => {
  it("diff withholds the example file only; .mcp.json and .kiro/settings/mcp.json are printed (as today)", async () => {
    const s = kept(await mcpWorkspace());
    await syncOnce(s.wsRoot);
    for (const f of MCP_FILES) await fs.appendFile(path.join(s.wsRoot, f), "MARKER-7f3a\n");
    const body = `  {\n    "mcpServers": {\n      "tracker": {\n  … 8 unchanged lines …\n      }\n    }\n  }\n- MARKER-7f3a\n`;
    expect(runCli(["diff", "--workspace", s.wsRoot])).toEqual({
      code: 0,
      stdout:
        `--- .claude/settings.craftar.example.json (disk, drift)\n+++ .claude/settings.craftar.example.json (forge)\n  content not shown: an example file may hold a value typed by hand\n` +
        `--- .kiro/settings/mcp.json (disk, drift)\n+++ .kiro/settings/mcp.json (forge)\n${body}` +
        `--- .mcp.json (disk, drift)\n+++ .mcp.json (forge)\n${body}`,
      stderr: "",
    });
  });
});

describe("pins — explain", () => {
  const E = (s: Scenario, p: string) => runCli(["explain", p, "--workspace", s.wsRoot]);

  it("a templated rule: sections and params with their layers", async () => {
    const s = kept(await explained());
    expect(E(s, `${R}/api.md`)).toEqual({
      code: 0,
      stdout:
        `${R}/api.md\n  target      claude-code\n  ingredient  rule/api\n  via recipes stack-node\n  sections    review (profile acme)\n` +
        `  params      api.port (default), region (workspace), team (profile acme)\n  profile     acme  (recipes: base, stack-node)\n` +
        `  hash        sha256:e850fe1c8108a9d898a4557335d8b92b3fb82f57e775cc5695707e53503c891b\n`,
      stderr: "",
    });
  });

  it("an imported ingredient names its origin; AGENTS.md is no single ingredient's", async () => {
    const s = kept(await explained());
    expect(E(s, `${R}/legacy.md`).stdout).toBe(
      `${R}/legacy.md\n  target      claude-code\n  ingredient  rule/legacy  (imported from acme-portal:.claude/rules/legacy.md)\n  via recipes base\n  profile     acme  (recipes: base, stack-node)\n  hash        sha256:75d932ed7ed851a78fcf0f4bce2095b216e81ca15fb3a07ae3e4ab5f791e4e53\n`,
    );
    expect(E(s, "AGENTS.md").stdout).toBe(
      `AGENTS.md\n  target      agents-md\n  ingredient  rule/*\n  profile     acme  (recipes: base, stack-node)\n  hash        sha256:250543964c1f1014052fd845e2eb7e6e234c65303b58ead42efdfedbaaf58c50\n`,
    );
  });

  it("a path the Forge does not produce, and `./<path>` (as today: not produced)", async () => {
    const s = kept(await explained());
    expect(E(s, `${R}/nope.md`)).toEqual({ code: 1, stdout: "", stderr: `error: ${R}/nope.md is not produced by the Forge for profile acme\n` });
    expect(E(s, `./${R}/api.md`)).toEqual({ code: 1, stdout: "", stderr: `error: ./${R}/api.md is not produced by the Forge for profile acme\n` });
  });

  it(".mcp.json: tagged mcp/*, no via line", async () => {
    const s = kept(await mcpWorkspace());
    expect(E(s, ".mcp.json").stdout).toBe(
      `.mcp.json\n  target      claude-code\n  ingredient  mcp/*\n  profile     acme  (recipes: base)\n  hash        sha256:f9d72cac06720cb6197bfa28fd8c04b00014d81e657debb4fa85e5f9a13b276d\n`,
    );
  });
});
