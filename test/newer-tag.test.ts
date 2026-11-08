import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { defaultGit, ensureTree, newerTag, parseLsRemote, type GitRunner } from "../src/core/remote.js";
import { profile, recipe, rule, tmpDir } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";
import { runCli } from "./helpers/cli.js";
import { git, remoteForge, type RemoteForge } from "./helpers/remote.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

/** `ls-remote` output for the given tags, every tag on its own commit. */
function lsRemote(tags: string[], heads: string[] = ["main"]): ReturnType<typeof parseLsRemote> {
  const lines = ["ref: refs/heads/main\tHEAD", ...heads.map((h) => `${A}\trefs/heads/${h}`), ...tags.map((t) => `${B}\trefs/tags/${t}`)];
  return parseLsRemote(lines.join("\n"));
}

describe("newerTag: the highest vX.Y.Z tag above a vX.Y.Z ref (no pre-release, any major)", () => {
  it("names the highest strictly greater tag, compared by number, not by text", () => {
    const refs = lsRemote(["v0.2.66", "v0.2.67", "v0.2.9", "v0.10.0", "v0.2.100"]);
    expect(newerTag(refs, "v0.2.66")).toBe("v0.10.0");
    expect(newerTag(lsRemote(["v0.2.66", "v0.2.67", "v0.2.100"]), "v0.2.66")).toBe("v0.2.100");
  });

  it("counts a higher major", () => {
    expect(newerTag(lsRemote(["v0.2.66", "v1.0.0"]), "v0.2.66")).toBe("v1.0.0");
  });

  it("is null when the ref is the highest, or the only, vX.Y.Z tag", () => {
    expect(newerTag(lsRemote(["v0.2.66", "v0.2.65", "v0.1.0"]), "v0.2.66")).toBeNull();
    expect(newerTag(lsRemote(["v0.2.66"]), "v0.2.66")).toBeNull();
  });

  it("ignores pre-release tags, tags with no v, leading zeros and any other shape", () => {
    const refs = lsRemote(["v0.2.66", "v0.2.67-rc.1", "v0.3.0+build", "0.9.0", "v0.02.70", "v0.3", "release-9", "V0.9.0", "v0.2.68x"]);
    expect(newerTag(refs, "v0.2.66")).toBeNull();
  });

  it("is null for a ref that is not vX.Y.Z", () => {
    const refs = lsRemote(["0.2.66", "0.2.67", "v0.2.67-rc.1", "v0.2.68", "stable"]);
    expect(newerTag(refs, "0.2.66")).toBeNull();
    expect(newerTag(refs, "v0.2.67-rc.1")).toBeNull();
    expect(newerTag(refs, "stable")).toBeNull();
    expect(newerTag(refs, null)).toBeNull();
    expect(newerTag(refs, A)).toBeNull();
  });

  it("is null for a vX.Y.Z ref that names a branch, not a tag", () => {
    const refs = lsRemote(["v0.2.67"], ["main", "v0.2.66"]);
    expect(newerTag(refs, "v0.2.66")).toBeNull();
    expect(newerTag(refs, "refs/heads/v0.2.66")).toBeNull();
  });

  it("reads a tag ref spelled refs/tags/vX.Y.Z", () => {
    expect(newerTag(lsRemote(["v0.2.66", "v0.2.67"]), "refs/tags/v0.2.66")).toBe("v0.2.67");
  });

  it("reads an annotated tag (its ^{} line) and CRLF ls-remote output", () => {
    const out = [`ref: refs/heads/main\tHEAD`, `${A}\trefs/heads/main`, `${B}\trefs/tags/v0.2.66`, `${C}\trefs/tags/v0.2.67`, `${A}\trefs/tags/v0.2.67^{}`].join("\r\n");
    expect(newerTag(parseLsRemote(out), "v0.2.66")).toBe("v0.2.67");
  });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const SPEC = { ingredients: [rule("a", "# A\n")], recipes: [recipe("base", ["rule/a"])], profiles: [profile("acme", ["base"])] };

async function tagged(): Promise<{ r: RemoteForge; home: string }> {
  const r = await remoteForge(SPEC);
  const home = await tmpDir("craftar-home-");
  cleanups.push(r.cleanup, () => removeWithRetry(home));
  git(r.src, "tag", "v0.2.66");
  await r.commit({ "README.md": "next\n" });
  git(r.src, "tag", "-a", "v0.2.67", "-m", "v0.2.67");
  git(r.src, "push", "-q", "origin", "v0.2.66", "v0.2.67");
  return { r, home };
}

describe("ensureTree carries newerTag (no network beyond the fetch it already makes)", () => {
  it("from ls-remote when it fetches, and from the cache offline, with no remote call", async () => {
    const { r, home } = await tagged();
    const fetched = await ensureTree(r.url, "v0.2.66", { home });
    expect([fetched.fetched, fetched.newerTag]).toEqual([true, "v0.2.67"]);
    const remoteCalls: string[][] = [];
    const counting: GitRunner = (args, opts) => {
      if (opts?.remote) remoteCalls.push(args);
      return defaultGit(args, opts);
    };
    const offline = await ensureTree(r.url, "v0.2.66", { home, offline: true, git: counting });
    expect([offline.fetched, offline.newerTag, remoteCalls]).toEqual([false, "v0.2.67", []]);
  });

  it("is null on the latest tag, a branch and the default branch", async () => {
    const { r, home } = await tagged();
    expect((await ensureTree(r.url, "v0.2.67", { home })).newerTag).toBeNull();
    expect((await ensureTree(r.url, "main", { home })).newerTag).toBeNull();
    expect((await ensureTree(r.url, null, { home })).newerTag).toBeNull();
  });

  it("offline, it knows only the tags of the last fetch", async () => {
    const { r, home } = await tagged();
    expect((await ensureTree(r.url, "v0.2.67", { home })).newerTag).toBeNull();
    git(r.src, "tag", "v0.3.0");
    git(r.src, "push", "-q", "origin", "v0.3.0");
    expect((await ensureTree(r.url, "v0.2.67", { home, offline: true })).newerTag).toBeNull();
    expect((await ensureTree(r.url, "v0.2.67", { home })).newerTag).toBe("v0.3.0");
  });
});

describe("craftar status: forge.newerTag and its informative line", () => {
  async function ws(r: RemoteForge, home: string, extra: string) {
    const dir = await tmpDir("craftar-newer-ws-");
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, "craftar.yaml"), `forge: ${r.url}\nprofile: acme\n${extra}`);
    return (args: string[]) => runCli([...args, "--workspace", dir], { env: { CRAFTAR_HOME: home } });
  }

  it("names the newer tag as the last key of forge and on the line after the forge line", async () => {
    const { r, home } = await tagged();
    const run = await ws(r, home, "ref: v0.2.66\n");
    const j = run(["status", "--json"]);
    expect(j.code).toBe(0);
    const forge = JSON.parse(j.stdout).forge;
    expect(Object.keys(forge).at(-1)).toBe("newerTag");
    expect([forge.fetched, forge.newerTag]).toEqual([true, "v0.2.67"]);
    const t = run(["status"]);
    expect(t.code).toBe(0);
    expect(t.stdout.split("\n")[2]).toBe("  newer tag on the Forge: v0.2.67 (ref is v0.2.66); set ref in craftar.yaml to move");
  });

  it("offline: the tags of the cache, said as of the last fetch; the exit code does not change", async () => {
    const { r, home } = await tagged();
    const run = await ws(r, home, "ref: v0.2.66\n");
    expect(run(["status"]).code).toBe(0);
    const j = JSON.parse(run(["status", "--json", "--offline"]).stdout).forge;
    expect([j.fetched, j.newerTag]).toEqual([false, "v0.2.67"]);
    const t = run(["status", "--offline"]);
    expect(t.code).toBe(0);
    expect(t.stdout.split("\n")[2]).toMatch(/^ {2}newer tag on the Forge: v0\.2\.67 \(ref is v0\.2\.66, as of the last fetch \d{4}-\d\d-\d\dT[\d:.]+Z\); set ref in craftar\.yaml to move$/);
  });

  it("the latest tag: newerTag null and no line; sync prints no such line", async () => {
    const { r, home } = await tagged();
    const latest = await ws(r, home, "ref: v0.2.67\n");
    expect(JSON.parse(latest(["status", "--json"]).stdout).forge.newerTag).toBeNull();
    expect(latest(["status"]).stdout).not.toContain("newer tag");
    const older = await ws(r, home, "ref: v0.2.66\n");
    const s = older(["sync"]);
    expect(s.code).toBe(0);
    expect(s.stdout).not.toContain("newer tag");
  });
});
