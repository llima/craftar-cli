import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, scenario, writeFiles } from "./helpers/forge.js";
import { loadWorkspace, plan } from "../src/core/sync.js";

/**
 * Spec 48 §7: pin what a Forge and a workspace whose links stay inside their trees get today (cases D and K),
 * BEFORE any source change, so the containment work can prove it changes nothing for them. The file is written
 * once, with CRAFTAR_WRITE_PINS=1, and no later commit of the spec changes it.
 */

const PIN_FILE = path.resolve(__dirname, "pins/real-path-containment-off.json");

// doctor's child gets a PATH that holds only an empty directory, so no `docker` or `git` is ever started for it.
let EMPTY_DIR: string;
let NO_PROGRAMS: { PATH: string; Path: string };
beforeAll(() => {
  EMPTY_DIR = mkdtempSync(path.join(os.tmpdir(), "craftar-test-no-programs-"));
  NO_PROGRAMS = { PATH: EMPTY_DIR, Path: EMPTY_DIR };
});
afterAll(() => {
  if (EMPTY_DIR) rmSync(EMPTY_DIR, { recursive: true, force: true });
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Scenario = Awaited<ReturnType<typeof scenario>>;

/** The Forge and the workspace of the pin. Neither is a git repository, so `generated-ignored` is not in it. */
async function linkedInside(): Promise<Scenario> {
  const s = await scenario(
    {
      ingredients: [
        rule("style", "# Style\nBase text.\n"),
        { meta: { type: "rule", name: "style--acme", as: "style" }, files: { "rule.md": "# Style\nAcme text.\n" } },
        rule("linked", "placeholder, replaced by a link below\n"),
        {
          meta: { type: "skill", name: "k", layout: "dir" },
          files: { "SKILL.md": "---\nname: k\ndescription: A skill\n---\nDo it.\n" },
        },
      ],
      recipes: [recipe("base", ["rule/style"]), recipe("acme", ["rule/style--acme", "rule/linked", "skill/k"])],
      profiles: [profile("acme", ["acme"], ["claude-code", "kiro", "agents-md"]), profile("globex", ["base"])],
    },
    { config: { profile: "acme" }, files: { "harness/rules/.keep": "" } },
  );
  cleanups.push(s.cleanup);

  // Case D: a file link to a file inside the Forge, as a declared body and as a file of a directory skill.
  await writeFiles(s.forgeRoot, { "shared/linked.md": "# Linked\nA body read through a link inside the Forge.\n", "shared/note.txt": "A note.\n" });
  const linkedBody = path.join(s.forgeRoot, "ingredients/rules/linked/rule.md");
  await fs.rm(linkedBody);
  await fs.symlink(path.join(s.forgeRoot, "shared/linked.md"), linkedBody);
  await fs.symlink(path.join(s.forgeRoot, "shared/note.txt"), path.join(s.forgeRoot, "ingredients/skills/k/note.txt"));

  // Case K: a generated folder that is a link to a directory inside the workspace.
  await fs.mkdir(path.join(s.wsRoot, ".claude"), { recursive: true });
  await fs.symlink(path.join(s.wsRoot, "harness/rules"), path.join(s.wsRoot, ".claude/rules"), "junction");
  return s;
}

function normalize(value: unknown, roots: string[]): unknown {
  if (typeof value === "string") {
    let t = value;
    for (const r of roots) {
      t = t.split(r).join("<root>");
      t = t.split(r.replace(/\\/g, "/")).join("<root>");
    }
    return t.replace(/^(schema \d+, generated )\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/, "$1<timestamp>");
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, roots));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, roots)]));
  }
  return value;
}

/** Every path under `dir`, a link read as a link and never walked, with what it holds. */
async function tree(dir: string, rel = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of (await fs.readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    const abs = path.join(dir, r);
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink()) out[r] = "<link>";
    else if (st.isDirectory()) Object.assign(out, await tree(dir, r));
    else out[r] = (await fs.readFile(abs)).toString("utf8");
  }
  return out;
}

const withoutGeneratedAt = (text: string) => {
  const lock = JSON.parse(text) as Record<string, unknown>;
  delete lock.generatedAt;
  // forge.source is relative here, and forge.commit is null: this Forge is no repository.
  return lock;
};

async function observe(s: Scenario) {
  const W = ["--workspace", s.wsRoot];
  const roots = [s.root, await fs.realpath(s.root)];
  const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
  const p = await plan(ws);

  // A file link inside the workspace, to a file that holds the planned bytes: adopted, then written through.
  await fs.writeFile(path.join(s.wsRoot, "harness/agents.md"), p.files.find((f) => f.path === "AGENTS.md")!.content);
  await fs.symlink(path.join(s.wsRoot, "harness/agents.md"), path.join(s.wsRoot, "AGENTS.md"));

  const run = (args: string[]) => runCli(args, { env: NO_PROGRAMS });
  const fresh = run(["status", "--json", ...W]);
  const freshDiff = run(["diff", ...W]);
  const check = run(["sync", "--check", ...W]);
  const sync = run(["sync", ...W]);
  if (sync.code !== 0) throw new Error(`sync failed: ${sync.stderr}`);
  const synced = run(["status", "--json", ...W]);
  const doctor = run(["doctor", "--json", ...W]);
  const forgeDiff = run(["forge", "diff", "rule/style", "--json", "--forge", s.forgeRoot]);

  // The Forge moves: the file behind each link is an `update`, written through the link.
  await fs.writeFile(path.join(s.forgeRoot, "shared/linked.md"), "# Linked\nThe Forge moved.\n");
  await fs.writeFile(path.join(s.forgeRoot, "ingredients/rules/style--acme/rule.md"), "# Style\nAcme moved.\n");
  const moved = run(["status", "--json", ...W]);
  const movedDiff = run(["diff", ...W]);
  const movedSync = run(["sync", ...W]);

  const doctorChecks = (JSON.parse(doctor.stdout) as { checks: Array<{ id: string; scope: string; level: string; message: string; fix: string | null }> }).checks
    .filter((c) => c.scope === "workspace" && c.id !== "docker")
    .map((c) => ({ id: c.id, level: c.level, message: c.message, fix: c.fix }));

  return normalize(
    {
      planned: Object.fromEntries([...p.files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => [f.path, f.content.toString("utf8")])),
      planWarnings: p.warnings,
      fresh: JSON.parse(fresh.stdout),
      freshDiff: freshDiff.stdout,
      codes: { fresh: fresh.code, check: check.code, sync: sync.code, synced: synced.code, doctor: doctor.code, forgeDiff: forgeDiff.code, moved: moved.code, movedSync: movedSync.code },
      synced: JSON.parse(synced.stdout),
      doctor: doctorChecks,
      forgeDiff: JSON.parse(forgeDiff.stdout),
      moved: JSON.parse(moved.stdout),
      movedDiff: movedDiff.stdout,
      lock: withoutGeneratedAt(await fs.readFile(path.join(s.wsRoot, "craftar.lock"), "utf8")),
      tree: await tree(s.wsRoot),
    },
    roots,
  ) as Record<string, unknown> & { tree: Record<string, string>; planned: Record<string, string>; codes: Record<string, number | null> };
}

/** A file link needs a privilege on Windows that a runner may not have: there the pin has not run, and it says so. */
async function canLinkFiles(): Promise<boolean> {
  const d = mkdtempSync(path.join(os.tmpdir(), "craftar-test-link-"));
  try {
    await fs.writeFile(path.join(d, "a"), "");
    await fs.symlink(path.join(d, "a"), path.join(d, "b"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

describe("links that stay inside are unchanged (spec 48 §7)", () => {
  it("matches the pinned snapshot", { timeout: 120_000 }, async (ctx) => {
    if (!(await canLinkFiles())) return ctx.skip();
    const observed = await observe(await linkedInside());
    if (process.env.CRAFTAR_WRITE_PINS === "1") {
      await fs.writeFile(PIN_FILE, JSON.stringify(observed, null, 2) + "\n");
      return;
    }
    expect(observed).toEqual(JSON.parse(await fs.readFile(PIN_FILE, "utf8")));
  });

  it("the pin is not vacuous: what the links lead to is emitted, and the links are kept", async () => {
    const pin = JSON.parse(await fs.readFile(PIN_FILE, "utf8")) as Awaited<ReturnType<typeof observe>>;
    expect(pin.planned[".claude/rules/linked.md"]).toContain("A body read through a link inside the Forge.");
    expect(pin.planned[".claude/skills/k/note.txt"]).toBe("A note.\n");
    expect(pin.tree[".claude/rules"]).toBe("<link>");
    expect(pin.tree["AGENTS.md"]).toBe("<link>");
    // Written through both links, after the Forge moved.
    expect(pin.tree["harness/rules/linked.md"]).toContain("The Forge moved.");
    expect(pin.tree["harness/agents.md"]).toContain("Acme moved.");
    expect(Object.values(pin.codes).every((c) => c === 0 || c === 1)).toBe(true);
    expect(pin.codes.sync).toBe(0);
    expect(pin.codes.movedSync).toBe(0);
    expect(JSON.stringify(pin.forgeDiff)).toContain("style--acme");
  });
});
