import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCli } from "./helpers/cli.js";
import { tmpDir, writeFiles } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";

// Spec 50 Part C: `forge unify` on profiles that hold a section as a one-line `\n` string, and as a `|` block.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const LONG = 'name: acme\nrecipes:\n  - acme-steering\ntargets:\n  - claude-code\nsections:\n  rule/other:\n    a: "line one of a section that is long enough\\nline two of it\\n"\n';
const BLOCK = "name: acme\nrecipes:\n  - acme-steering\ntargets:\n  - claude-code\nsections:\n  rule/other:\n    a: |\n      one\n      two\n";

async function forgeWith(profileText: string, variantBody: string) {
  const root = await tmpDir("craftar-unify-rt-");
  cleanups.push(() => removeWithRetry(root));
  const forge = path.join(root, "forge");
  await writeFiles(forge, {
    "craftar.forge.yaml": "name: f\nschema: 2\n",
    "ingredients/rules/r/ingredient.yaml": "type: rule\nname: r\n",
    "ingredients/rules/r/rule.md": "shared line\nclient value beta-org here\nend\n",
    "ingredients/rules/r--acme/ingredient.yaml": "type: rule\nname: r--acme\nas: r\n",
    "ingredients/rules/r--acme/rule.md": variantBody,
    "recipes/base.yaml": "name: base\ningredients:\n  - rule/r\n",
    "recipes/acme.yaml": "name: acme-steering\ningredients:\n  - rule/r--acme\n",
    "profiles/acme/profile.yaml": profileText,
    "profiles/beta/profile.yaml": "name: beta\nrecipes:\n  - base\ntargets:\n  - claude-code\n",
  });
  const git = (...a: string[]) => execFileSync("git", ["-C", forge, "-c", "user.name=t", "-c", "user.email=t@t.invalid", ...a], { stdio: "pipe" });
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "i");
  return { forge, root };
}

async function unify(forge: string, root: string, take: string) {
  const planFile = path.join(root, "plan.yaml");
  const saved = runCli(["forge", "unify", "rule/r", "--profile", "acme", "--forge", forge, "--save-plan", planFile]);
  expect(saved.code, saved.stderr).toBe(0);
  await fs.writeFile(planFile, (await fs.readFile(planFile, "utf8")).replace("take: keep", `take: ${take}`));
  return runCli(["forge", "unify", "rule/r", "--profile", "acme", "--forge", forge, "--plan", planFile, "--no-impact"]);
}

const VALUE = "shared line\nclient value acme-org here\nend\n";
const BLOCK_BODY = "shared line\nclient value beta-org here\nan extra line only this client has\nanother line of it\nend\n";

describe.each([
  ["a long one-line string", LONG],
  ["a | block", BLOCK],
])("forge unify on a profile holding %s", (_n, text) => {
  it("take: param writes, moving only the lines it adds", async () => {
    const { forge, root } = await forgeWith(text, VALUE);
    const r = await unify(forge, root, "param");
    expect(r.code, r.stderr).toBe(0);
    const after = await fs.readFile(path.join(forge, "profiles/acme/profile.yaml"), "utf8");
    expect(after.startsWith(text)).toBe(true);
    expect(after.slice(text.length)).toMatch(/^params:\n  param\.beta_org: acme-org\n$/);
  });

  it("take: section writes, moving only the lines it adds", async () => {
    const { forge, root } = await forgeWith(text, BLOCK_BODY);
    const r = await unify(forge, root, "section");
    expect(r.code, r.stderr).toBe(0);
    const after = await fs.readFile(path.join(forge, "profiles/acme/profile.yaml"), "utf8");
    expect(after.startsWith(text)).toBe(true);
    expect(after.slice(text.length)).toContain("rule/r:");
    expect(after).toContain("an extra line only this client has");
  });
});
