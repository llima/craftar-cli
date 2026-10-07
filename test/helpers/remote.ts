import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { makeForge, tmpDir, writeFiles, type ForgeSpec } from "./forge.js";

/** A fake but stable identity, so `git commit` never depends on the host's ambient config. */
export function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "craftar-test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "craftar-test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv() }).trim();
}

export interface RemoteForge {
  root: string;
  /** The working clone commits are made in and pushed from. */
  src: string;
  /** The bare repository the URL names. */
  bare: string;
  url: string;
  /** Write files into `src`, commit and push to the bare's `main`; returns the new commit. */
  commit(files: Record<string, string>, message?: string): Promise<string>;
  cleanup(): Promise<void>;
}

/** A remote Forge for tests: a bare repository on disk, named by a `file://` URL. No network. */
export async function remoteForge(spec: ForgeSpec): Promise<RemoteForge> {
  const root = await tmpDir("craftar-remote-");
  const src = path.join(root, "src");
  const bare = path.join(root, "forge.git");
  await makeForge(src, spec);
  execFileSync("git", ["init", "-q", "-b", "main", src], { env: gitEnv() });
  git(src, "config", "maintenance.auto", "false");
  git(src, "config", "gc.auto", "0");
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "init");
  execFileSync("git", ["clone", "-q", "--bare", src, bare], { env: gitEnv() });
  git(src, "remote", "add", "origin", bare);
  return {
    root,
    src,
    bare,
    url: pathToFileURL(bare).href,
    async commit(files, message = "change") {
      await writeFiles(src, files);
      git(src, "add", "-A");
      git(src, "commit", "-q", "-m", message);
      git(src, "push", "-q", "origin", "main");
      return git(src, "rev-parse", "HEAD");
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}
