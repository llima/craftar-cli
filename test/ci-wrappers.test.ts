import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { makeForge, makeWorkspace, profile, recipe, rule } from "./helpers/forge.js";
import { removeWithRetry } from "./helpers/fs.js";

// Spec 46 §10. No test here reaches a registry, a real runner or a remote host: the program runs against a stub
// craftar.js, or against this checkout's dist/ and a path Forge. Each safety property is also run on a copy of the
// text with that property removed, and the copy must be caught: a check that catches nothing proves nothing.

const REPO = path.resolve(__dirname, "..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");
const GITHUB = "ci/github/action.yml";
const AZURE = "ci/azure/check.yml";
const DELIMITER = "CRAFTAR_CI";

interface Step { uses?: string; run?: string; bash?: string; task?: string; env?: Record<string, string>; with?: Record<string, unknown>; name?: string; id?: string }
const githubSteps = (text: string): Step[] => (YAML.parse(text) as { runs: { steps: Step[] } }).runs.steps;
const azureSteps = (text: string): Step[] => (YAML.parse(text) as { steps: Step[] }).steps;

/** The text between the heredoc's opening line and its delimiter; "" when the shape is not there. */
function programIn(body: string | undefined): string {
  const open = `node --input-type=module - <<'${DELIMITER}'\n`;
  if (!body?.startsWith(open)) return "";
  const end = body.lastIndexOf(`\n${DELIMITER}`);
  return end < 0 ? "" : `${body.slice(open.length, end)}\n`;
}
const scriptSteps = (text: string, azure: boolean): Step[] => (azure ? azureSteps(text) : githubSteps(text)).filter((s) => (azure ? s.bash : s.run) !== undefined);
const bodyOf = (s: Step, azure: boolean): string => (azure ? s.bash : s.run) as string;
const program = (text: string, azure: boolean): string => programIn(bodyOf(scriptSteps(text, azure)[1], azure));

/** Tests 1 to 4 as one pure function over the texts, so that a planted defect can be shown to be caught. */
function staticFaults(github: string, azure: string, release: string): string[] {
  const faults: string[] = [];
  const pin = /actions\/setup-node@([0-9a-f]{40})/.exec(release)?.[1];
  const gh = scriptSteps(github, false);
  const az = scriptSteps(azure, true);

  const [pg, pa] = [programIn(gh[1]?.run), programIn(az[1]?.bash)];
  if (!pg || !pa) faults.push("no program block");
  if (pg !== pa) faults.push("programs differ");

  for (const s of githubSteps(github)) {
    if (s.uses === undefined) continue;
    if (!/@[0-9a-f]{40}$/.test(s.uses)) faults.push("uses without a full SHA");
    else if (s.uses !== `actions/setup-node@${pin}`) faults.push("uses differs from release.yml's pin");
  }

  for (const s of gh) if (s.run!.includes("${{")) faults.push("expression in run");
  for (const s of az) {
    if (s.bash!.includes("${{")) faults.push("expression in bash");
    if (s.bash!.includes("$(")) faults.push("macro in bash");
    if (/##vso\[/i.test(s.bash!)) faults.push("literal vso command in bash");
  }
  if (pg.includes("$(")) faults.push("macro in program");
  if (/process\.exit\(/.test(pg)) faults.push("process.exit in program");

  for (const word of ["--overwrite-drift", "pull_request_target", "latest", "@main"]) {
    if (github.includes(word) || azure.includes(word)) faults.push(`forbidden ${word}`);
  }

  const setup = githubSteps(github).find((s) => s.uses?.startsWith("actions/setup-node@"));
  if (setup?.with?.["package-manager-cache"] !== false) faults.push("setup-node cache on");

  for (const [steps, isAzure] of [[gh, false], [az, true]] as const) {
    const install = steps[0] ? bodyOf(steps[0], isAzure) : "";
    const [cd, own, npm] = [install.indexOf("cd \""), install.indexOf("package.json"), install.indexOf("npm install")];
    if (cd < 0 || own < cd || npm < own) faults.push("install not in the temporary directory");
    if (!install.includes("--ignore-scripts")) faults.push("install runs scripts");
    if (!install.includes('"craftar@$CRAFTAR_CI_VERSION"')) faults.push("install not exact");
    if (!install.includes("^[0-9]+\\.[0-9]+\\.[0-9]+$")) faults.push("version not checked");
    if (steps[0]?.env && Object.keys(steps[0].env).some((k) => /TOKEN|ORIGIN/.test(k))) faults.push("token in the install step");
    if (steps[1]?.env?.CRAFTAR_CI_TOKEN === undefined) faults.push("no token variable on the check");
  }

  if ((YAML.parse(github) as Record<string, unknown>).permissions !== undefined) faults.push("permissions declared");
  return faults;
}

function mutate(text: string, from: string, to: string): string {
  expect(text, `the text to replace is gone: ${from}`).toContain(from);
  return text.split(from).join(to);
}

// ---- running the program ----

type Vendor = "github" | "azure";
interface Canned { code?: number; stdout?: string; stderr?: string }
interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  result: string | undefined;
  summary: string;
  calls: Array<{ args: string[]; cwd: string; env: Record<string, string | undefined> }>;
  temp: string;
  checkout: string;
  root: string;
}

const STUB = `const fs = require("fs"), path = require("path");
const dir = path.resolve(__dirname, "..");
const canned = JSON.parse(fs.readFileSync(path.join(dir, "stub.json"), "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd(), env: process.env }) + "\\n");
const a = canned[args[0]] || {};
if (a.stdout) process.stdout.write(a.stdout);
if (a.stderr) process.stderr.write(a.stderr);
process.exitCode = a.code === undefined ? 0 : a.code;
`;

const scratch: string[] = [];
afterAll(async () => {
  for (const d of scratch) await removeWithRetry(d);
});
function newBase(): string {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "craftar-ci-")));
  scratch.push(base);
  return base;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(GITHUB_|RUNNER_|TF_BUILD$|AGENT_|CRAFTAR_CI_|GIT_CONFIG)/i.test(k)) delete env[k];
  return env;
}

interface RunOptions {
  stub?: boolean;
  check?: Canned;
  status?: Canned;
  env?: Record<string, string>;
  temp?: "absent";
  summaryUnwritable?: boolean;
  localYaml?: boolean;
  absoluteWs?: boolean;
}

function runProgram(source: string, vendor: Vendor, o: RunOptions = {}): Run {
  const base = newBase();
  const temp = path.join(base, "temp");
  const checkout = path.join(base, "checkout");
  mkdirSync(checkout);
  const outFile = path.join(base, "output");
  const summaryFile = path.join(base, "summary");
  if (o.summaryUnwritable) mkdirSync(summaryFile);
  const bin = path.join(temp, "craftar-cli", "node_modules", "craftar", "bin");
  if (o.temp !== "absent") {
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(temp, "craftar-cli", "package.json"), "{}\n");
    if (o.stub !== false) {
      writeFileSync(path.join(bin, "craftar.js"), STUB);
      writeFileSync(path.join(bin, "..", "stub.json"), JSON.stringify({ sync: o.check ?? { code: 0, stdout: "workspace in sync\n" }, status: o.status ?? {} }));
    }
  }
  if (o.localYaml) writeFileSync(path.join(checkout, "craftar.local.yaml"), "forge: ../elsewhere\n");
  const vendorEnv = vendor === "azure" ? { TF_BUILD: "True", AGENT_TEMPDIRECTORY: temp } : { RUNNER_TEMP: temp, GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: summaryFile };
  const r = spawnSync(process.execPath, ["--input-type=module", "-"], {
    input: source,
    cwd: checkout,
    encoding: "utf8",
    env: { ...cleanEnv(), ...vendorEnv, ...(o.absoluteWs ? { CRAFTAR_CI_WORKSPACE: path.join(checkout, "ws") } : {}), ...o.env },
    maxBuffer: 1 << 26,
  });
  const callsFile = path.join(bin, "..", "calls.jsonl");
  const calls = existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Run["calls"][number]) : [];
  const lineResult = /^##vso\[task\.setvariable variable=result;isOutput=true\](.*)$/m.exec(r.stdout)?.[1]?.trim();
  const fileResult = existsSync(outFile) ? /^result=(.*)$/m.exec(readFileSync(outFile, "utf8"))?.[1] : undefined;
  let summary = "";
  if (vendor === "github" && !o.summaryUnwritable && existsSync(summaryFile)) summary = readFileSync(summaryFile, "utf8");
  const upload = /^##vso\[task\.uploadsummary\](.*)$/m.exec(r.stdout)?.[1]?.trim();
  if (vendor === "azure" && upload && existsSync(upload)) summary = readFileSync(upload, "utf8");
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, result: vendor === "azure" ? lineResult : fileResult, summary, calls, temp, checkout, root: checkout };
}

const statusJson = (rows: Array<{ path: string; state: string }>, unsetParams: unknown[] = []): Canned => ({ code: 0, stdout: JSON.stringify({ statuses: rows, unsetParams }) });
const DRIFT: Canned = { code: 1, stdout: "drift .claude/rules/a.md\n" };
const same = (a: string, b: string): boolean => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
const SYNC = (root: string): string[] => ["sync", "--check", "--workspace", root];
const STATUS = (root: string): string[] => ["status", "--json", "--offline", "--workspace", root];

/** Fake credentials assembled at run time: a fixed value that looks like nothing the secret scanners name. */
const TOKEN = ["fake", "forge", "credential", "value"].join("-");
const ORIGIN = "https://git.acme.test";
const b64 = (user: string): string => Buffer.from(`${user}:${TOKEN}`).toString("base64");

function inSyncFaults(source: string, vendor: Vendor): string[] {
  const r = runProgram(source, vendor);
  const faults: string[] = [];
  if (r.code !== 0) faults.push(`exit ${r.code}`);
  if (r.result !== "in-sync") faults.push(`result ${r.result}`);
  if (r.calls.length !== 1) faults.push(`${r.calls.length} calls`);
  else {
    if (JSON.stringify(r.calls[0].args) !== JSON.stringify(SYNC(r.root))) faults.push(`args ${r.calls[0].args.join(" ")}`);
    if (!same(r.calls[0].cwd, r.temp)) faults.push("the check did not run in the temporary directory");
    if (r.calls[0].env.NO_COLOR !== "1") faults.push("colour on");
    if (!same(r.calls[0].env.CRAFTAR_HOME ?? "", path.join(r.temp, "craftar-home"))) faults.push("home outside the job");
  }
  if (!r.summary.includes("### craftar sync --check: in-sync")) faults.push("no summary");
  return faults;
}

function outOfSyncFaults(source: string, vendor: Vendor): string[] {
  const r = runProgram(source, vendor, { check: DRIFT, status: statusJson([{ path: ".claude/rules/a.md", state: "drift" }, { path: "b.md", state: "unchanged" }, { path: "c.md", state: "adopt" }]) });
  const faults: string[] = [];
  if (r.code !== 1) faults.push(`exit ${r.code}`);
  if (r.result !== "out-of-sync") faults.push(`result ${r.result}`);
  if (JSON.stringify(r.calls.map((c) => c.args)) !== JSON.stringify([SYNC(r.root), STATUS(r.root)])) faults.push("calls differ");
  if (r.calls.some((c) => !same(c.cwd, r.temp))) faults.push("a call ran outside the temporary directory");
  const line = vendor === "azure" ? "##vso[task.logissue type=error;sourcepath=.claude/rules/a.md]craftar: drift" : "::error file=.claude/rules/a.md::craftar: drift";
  if (!r.stdout.split("\n").includes(line)) faults.push("no annotation");
  if (!r.summary.includes("| `.claude/rules/a.md` | drift |")) faults.push("no row");
  if (r.summary.includes("b.md") || r.summary.includes("c.md")) faults.push("a row for a file in sync");
  return faults;
}

function tokenFaults(source: string, vendor: Vendor): string[] {
  const r = runProgram(source, vendor, {
    check: DRIFT,
    status: statusJson([{ path: "a.md", state: "drift" }]),
    env: { CRAFTAR_CI_ORIGIN: ORIGIN, CRAFTAR_CI_TOKEN: TOKEN, CRAFTAR_CI_TOKEN_USER: "acme-user", GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c", GIT_CONFIG_KEY_1: "d.e", GIT_CONFIG_VALUE_1: "f" },
  });
  const faults: string[] = [];
  if (r.calls.length !== 2) return [`${r.calls.length} calls`];
  const [check, status] = r.calls;
  const basic = b64("acme-user");
  if (check.env.GIT_CONFIG_COUNT !== "4") faults.push("count not appended");
  if (check.env.GIT_CONFIG_KEY_0 !== "a.b" || check.env.GIT_CONFIG_VALUE_1 !== "f") faults.push("existing entries changed");
  if (check.env.GIT_CONFIG_KEY_2 !== `http.${ORIGIN}/.extraheader`) faults.push("header key");
  if (check.env.GIT_CONFIG_VALUE_2 !== `Authorization: Basic ${basic}`) faults.push("header value");
  if (check.env.GIT_CONFIG_KEY_3 !== "http.followRedirects" || check.env.GIT_CONFIG_VALUE_3 !== "false") faults.push("redirects on");
  for (const [name, c] of [["check", check], ["status", status]] as const) {
    if (c.env.CRAFTAR_CI_TOKEN !== undefined) faults.push(`${name} sees the token`);
    if (c.args.join(" ").includes(TOKEN) || c.args.join(" ").includes(basic)) faults.push(`${name} has it in an argument`);
  }
  if (status.env.GIT_CONFIG_COUNT !== "2") faults.push("status sees the count");
  if (JSON.stringify(status.env).includes(basic)) faults.push("status sees the header");
  for (const [name, text] of [["stdout", r.stdout], ["stderr", r.stderr], ["summary", r.summary]] as const) if (text.includes(TOKEN)) faults.push(`token in ${name}`);
  const mask = vendor === "azure" ? `##vso[task.setsecret]${basic}` : `::add-mask::${basic}`;
  if (!r.stdout.split("\n").includes(mask)) faults.push("no mask");
  if (r.stdout.split("\n").filter((l) => l.includes(basic)).length !== 1 || r.summary.includes(basic)) faults.push("Base64 printed beyond the mask");
  return faults;
}

const HOSTILE = [
  "##vso[task.setvariable variable=EVIL]x",
  "##VSO[task.setvariable variable=EVIL2]x",
  "in the middle ##vso[task.complete result=Succeeded]x",
  "##[error]x",
  "::add-mask::x",
  "  ::error::x",
].join("\n");
const HOSTILE_PATH = "a%b:c,d;e]f\ng.md";

function hostileFaults(source: string, vendor: Vendor): string[] {
  const r = runProgram(source, vendor, {
    check: { code: 1, stdout: `${HOSTILE}\n`, stderr: `${HOSTILE}\n` },
    status: statusJson([{ path: HOSTILE_PATH, state: "drift" }]),
  });
  const faults: string[] = [];
  for (const s of ["##vso[task.setvariable variable=EVIL]", "##VSO[task.setvariable variable=EVIL2]", "##vso[task.complete", "##[error]"]) if (r.stdout.includes(s)) faults.push(`intact: ${s}`);
  if (/^\s*::add-mask::x/m.test(r.stdout)) faults.push("intact: add-mask");
  if (/^\s*::error::x/m.test(r.stdout)) faults.push("intact: error");
  const annotation = vendor === "azure" ? "##vso[task.logissue type=error;sourcepath=a%25b:c,d%3Be%5Df%0Ag.md]craftar: drift" : "::error file=a%25b%3Ac%2Cd;e]f%0Ag.md::craftar: drift";
  if (!r.stdout.split("\n").includes(annotation)) faults.push("path not escaped");
  return faults;
}

const VENDORS: Vendor[] = ["github", "azure"];
const textOf = (vendor: Vendor): string => program(read(vendor === "azure" ? AZURE : GITHUB), vendor === "azure");
const anno = (r: Run): string[] => r.stdout.split("\n").filter((l) => l.startsWith("::error") || l.startsWith("##vso[task.logissue"));

describe("the wrapper files (spec 46 §10, 1 to 4)", () => {
  const texts = () => [read(GITHUB), read(AZURE), read(".github/workflows/release.yml")] as const;

  it("both parse, hold one program byte for byte, and break none of the rules", () => {
    const [gh, az, release] = texts();
    expect(staticFaults(gh, az, release)).toEqual([]);
    expect(program(gh, false).length).toBeGreaterThan(1000);
    expect(program(gh, false)).toBe(program(az, true));
  });

  it("the action is a composite with the inputs the spec names, and the template names Azure's parameters", () => {
    const [gh, az] = texts();
    const action = YAML.parse(gh) as { inputs: Record<string, { required?: boolean; default?: string }>; outputs: Record<string, { value: string }>; runs: { using: string } };
    expect(action.runs.using).toBe("composite");
    expect(Object.keys(action.inputs)).toEqual(["version", "workspace", "forge-origin", "forge-token", "forge-token-user", "node-version"]);
    expect(action.inputs.version.required).toBe(true);
    expect(action.inputs.version.default).toBeUndefined();
    expect(action.inputs["forge-token-user"].default).toBe("x-access-token");
    expect(action.outputs.result.value).toBe("${{ steps.check.outputs.result }}");
    const template = YAML.parse(az) as { parameters: Array<{ name: string; default?: string }>; steps: Step[] };
    expect(template.parameters.map((p) => p.name)).toEqual(["version", "workspace", "forgeOrigin", "forgeToken", "forgeTokenUser", "nodeVersion", "stepName"]);
    expect(template.parameters[0].default).toBeUndefined();
    expect(template.steps[0].task).toBe("UseNode@1");
  });

  it("git keeps the files' line endings", () => {
    expect(read(".gitattributes").split(/\r?\n/)).toContain("ci/** -text");
    expect(read(GITHUB)).not.toContain("\r");
    expect(read(AZURE)).not.toContain("\r");
  });

  const planted: Array<[string, "gh" | "az", string, string, string]> = [
    ["one line more in one program", "gh", "const env = process.env;", "const env = process.env;\n        // x", "programs differ"],
    ["a uses by tag", "gh", "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020", "actions/setup-node@v7", "uses without a full SHA"],
    ["another SHA", "gh", "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020", `actions/setup-node@${"a".repeat(40)}`, "uses differs from release.yml's pin"],
    ["an input inside run", "gh", 'cd "$RUNNER_TEMP/craftar-cli"', 'cd "$RUNNER_TEMP/craftar-cli" # ${{ inputs.version }}', "expression in run"],
    ["a parameter inside bash", "az", 'cd "$AGENT_TEMPDIRECTORY/craftar-cli"', 'cd "$AGENT_TEMPDIRECTORY/craftar-cli" # ${{ parameters.version }}', "expression in bash"],
    ["a macro inside bash", "az", 'cd "$AGENT_TEMPDIRECTORY/craftar-cli"', 'cd "$(pwd)"', "macro in bash"],
    ["a literal vso command", "az", '"##""vso[task', '"##vso[task', "literal vso command in bash"],
    ["--overwrite-drift", "gh", "--no-fund", "--no-fund --overwrite-drift", "forbidden --overwrite-drift"],
    ["latest", "gh", "x.y.z", "latest", "forbidden latest"],
    ["@main", "az", "x.y.z", "@main", "forbidden @main"],
    ["an install that stays in the checkout", "gh", '&& cd "$RUNNER_TEMP/craftar-cli"', "", "install not in the temporary directory"],
    ["an install that runs scripts", "az", "--ignore-scripts ", "", "install runs scripts"],
    ["setup-node's cache on", "gh", "package-manager-cache: false", "package-manager-cache: true", "setup-node cache on"],
    ["a token in the install step", "gh", 'env: { CRAFTAR_CI_VERSION: "${{ inputs.version }}" }', 'env: { CRAFTAR_CI_VERSION: "${{ inputs.version }}", CRAFTAR_CI_TOKEN: "${{ inputs.forge-token }}" }', "token in the install step"],
    ["a version that is not checked", "gh", "^[0-9]+\\.[0-9]+\\.[0-9]+$", "", "version not checked"],
    ["process.exit", "gh", "process.exitCode = 1;", "process.exit(1);", "process.exit in program"],
  ];
  it.each(planted)("catches %s", (_name, file, from, to, fault) => {
    const [gh, az, release] = texts();
    const faults = file === "gh" ? staticFaults(mutate(gh, from, to), az, release) : staticFaults(gh, mutate(az, from, to), release);
    expect(faults).toContain(fault);
  });
  it("catches a macro in the program", () => {
    const [gh, az, release] = texts();
    const from = "const env = process.env;";
    expect(staticFaults(mutate(gh, from, "const env = process.env; // $(x)"), mutate(az, from, "const env = process.env; // $(x)"), release)).toContain("macro in program");
  });
});

describe.each(VENDORS)("the program under %s (spec 46 §10, 5)", (vendor) => {
  const names = vendor === "azure" ? { o: "forgeOrigin", t: "forgeToken" } : { o: "forge-origin", t: "forge-token" };

  it("in sync: exit 0, one call, outside the checkout", () => expect(inSyncFaults(textOf(vendor), vendor)).toEqual([]));
  it("out of sync: exit 1, the two calls, one annotation, one row", () => expect(outOfSyncFaults(textOf(vendor), vendor)).toEqual([]));

  it("a status that cannot be read: error, and the check's own lines stay", () => {
    const r = runProgram(textOf(vendor), vendor, { check: { code: 1, stderr: "error: why it failed\n" }, status: { code: 1, stdout: "not json" } });
    expect([r.code, r.result]).toEqual([1, "error"]);
    expect(r.stdout).toContain("error: why it failed");
    expect(r.calls.map((c) => c.args)).toEqual([SYNC(r.root), STATUS(r.root)]);
  });

  it("a status with no file and no parameter: error (the budget's case)", () => {
    const r = runProgram(textOf(vendor), vendor, { check: { code: 1 }, status: statusJson([{ path: "a.md", state: "unchanged" }]) });
    expect([r.code, r.result]).toEqual([1, "error"]);
    expect(anno(r)).toEqual([]);
  });

  it("an unset declared parameter with no file: out-of-sync", () => {
    const r = runProgram(textOf(vendor), vendor, { check: { code: 1 }, status: statusJson([], [{ key: "k" }]) });
    expect([r.code, r.result]).toEqual([1, "out-of-sync"]);
  });

  it("a missing craftar.js: node starts, the status path reads error", () => {
    const r = runProgram(textOf(vendor), vendor, { stub: false });
    expect([r.code, r.result]).toEqual([1, "error"]);
    expect(r.calls).toEqual([]);
  });

  it("a temporary directory that does not exist: the child cannot start, said in words, error", () => {
    const r = runProgram(textOf(vendor), vendor, { temp: "absent" });
    expect([r.code, r.result]).toEqual([1, "error"]);
    expect(r.stdout).toContain("could not run craftar");
  });

  const refusals: Array<[string, Record<string, string>, boolean, string]> = [
    ["http origin", { CRAFTAR_CI_ORIGIN: "http://git.acme.test", CRAFTAR_CI_TOKEN: TOKEN }, false, `${names.o} must be https://<host>[:port]`],
    ["upper-case origin", { CRAFTAR_CI_ORIGIN: "https://GIT.acme.test", CRAFTAR_CI_TOKEN: TOKEN }, false, `${names.o} must be https://<host>[:port]`],
    ["origin with a path", { CRAFTAR_CI_ORIGIN: `${ORIGIN}/org`, CRAFTAR_CI_TOKEN: TOKEN }, false, `${names.o} must be https://<host>[:port]`],
    ["origin with credentials", { CRAFTAR_CI_ORIGIN: "https://u:p@git.acme.test", CRAFTAR_CI_TOKEN: TOKEN }, false, `${names.o} must be https://<host>[:port]`],
    ["origin with no token", { CRAFTAR_CI_ORIGIN: ORIGIN }, false, `${names.o} was given with no ${names.t}`],
    ["token with no origin", { CRAFTAR_CI_TOKEN: TOKEN }, false, `${names.t} needs ${names.o}`],
    ["craftar.local.yaml", {}, true, "craftar.local.yaml is in the checkout"],
  ];
  it.each(refusals)("refuses: %s", (_n, env, localYaml, words) => {
    const r = runProgram(textOf(vendor), vendor, { env, localYaml });
    expect([r.code, r.result]).toEqual([1, "error"]);
    expect(r.calls).toEqual([]);
    expect(r.stdout).toContain(words);
    expect(anno(r)).toHaveLength(1);
    expect(r.stdout).not.toContain(TOKEN);
    expect(r.summary).toContain(words);
  });

  it.each([["relative", false], ["absolute", true]] as const)("a %s workspace: the annotation reads ws/a.md, the argument is absolute", (_n, absoluteWs) => {
    const r = runProgram(textOf(vendor), vendor, { check: DRIFT, status: statusJson([{ path: "a.md", state: "drift" }]), ...(absoluteWs ? { absoluteWs } : { env: { CRAFTAR_CI_WORKSPACE: "ws" } }) });
    expect(r.calls[0].args).toEqual(SYNC(path.join(r.checkout, "ws")));
    expect(anno(r)[0]).toContain(vendor === "azure" ? "sourcepath=ws/a.md]" : "file=ws/a.md::");
  });

  it("at most ten annotations, every file in the summary", () => {
    const rows = Array.from({ length: 13 }, (_, i) => ({ path: `f${i}.md`, state: "new" }));
    const r = runProgram(textOf(vendor), vendor, { check: DRIFT, status: statusJson(rows) });
    expect(anno(r)).toHaveLength(10);
    for (const row of rows) expect(r.summary).toContain(`| \`${row.path}\` | new |`);
  });

  it("a child's output with no final newline: the annotation still starts its line", () => {
    const r = runProgram(textOf(vendor), vendor, { check: { code: 1, stdout: "no newline" }, status: statusJson([{ path: "a.md", state: "drift" }]) });
    expect(anno(r)).toHaveLength(1);
    expect(r.stdout.split("\n")).toContain("no newline");
  });

  it("the summary holds a path and a state, never the check's lines", () => {
    const r = runProgram(textOf(vendor), vendor, { check: { code: 1, stdout: "a warning that names a value\n" }, status: statusJson([{ path: "a|b`c.md", state: "drift" }]) });
    expect(r.summary).not.toContain("a warning that names a value");
    expect(r.summary).toContain("| `a?b?c.md` | drift |");
  });
});

describe("what only one vendor does (spec 46 §10, 5)", () => {
  it("an unwritable summary on GitHub changes nothing: in sync exits 0, out of sync exits 1", () => {
    const ok = runProgram(textOf("github"), "github", { summaryUnwritable: true });
    expect([ok.code, ok.result]).toEqual([0, "in-sync"]);
    expect(ok.stdout).toContain("the summary could not be written");
    const bad = runProgram(textOf("github"), "github", { summaryUnwritable: true, check: DRIFT, status: statusJson([{ path: "a.md", state: "drift" }]) });
    expect([bad.code, bad.result]).toEqual([1, "out-of-sync"]);
    expect(anno(bad)).toHaveLength(1);
  });

  it("an undefined macro as the token on Azure: refused as a fork's run, with an origin", () => {
    const r = runProgram(textOf("azure"), "azure", { env: { CRAFTAR_CI_ORIGIN: ORIGIN, CRAFTAR_CI_TOKEN: "$(Forge.Token)" } });
    expect([r.code, r.result]).toEqual([1, "error"]);
    expect(r.stdout).toContain("forgeOrigin was given with no forgeToken");
    expect(r.calls).toEqual([]);
  });

  it("the same macro with no origin reads as a token with no origin", () => {
    const r = runProgram(textOf("azure"), "azure", { env: { CRAFTAR_CI_TOKEN: "$(Forge.Token)" } });
    expect(r.stdout).toContain("forgeToken needs forgeOrigin");
    expect(r.result).toBe("error");
  });

  it("the default user: x-access-token on GitHub, empty on Azure, with the variable unset", () => {
    const env = { CRAFTAR_CI_ORIGIN: ORIGIN, CRAFTAR_CI_TOKEN: TOKEN };
    expect(runProgram(textOf("github"), "github", { env }).calls[0].env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${b64("x-access-token")}`);
    expect(runProgram(textOf("azure"), "azure", { env }).calls[0].env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${b64("")}`);
  });
});

describe.each(VENDORS)("the token and hostile text under %s (spec 46 §10, 6 and 7)", (vendor) => {
  it("the header reaches the check alone, appended; the status sees none of it", () => expect(tokenFaults(textOf(vendor), vendor)).toEqual([]));
  it("hostile text from the check and a hostile path leave no command intact", () => expect(hostileFaults(textOf(vendor), vendor)).toEqual([]));

  const removedSafety: Array<[string, string, string, (s: string, v: Vendor) => string[]]> = [
    ["the status also on exit 0", "if (check.status !== 0) {", "if (true) {", inSyncFaults],
    ["the checkout as working directory", "{ cwd: temp, env: e,", "{ cwd: process.cwd(), env: e,", inSyncFaults],
    ["--offline on the check", 'craftar(["sync", "--check"], checkEnv)', 'craftar(["sync", "--check", "--offline"], checkEnv)', inSyncFaults],
    ["colour left on", 'NO_COLOR: "1", ', "", inSyncFaults],
    ["a verdict that ignores the exit code", "return check.status === 0 ? 0 : 1;", "return 0;", outOfSyncFaults],
    ["the token left in the environment", "delete childEnv.CRAFTAR_CI_TOKEN;", "", tokenFaults],
    ["the count replaced, not appended", "const n = Number(env.GIT_CONFIG_COUNT || 0);", "const n = 0;", tokenFaults],
    ["redirects left on", '`GIT_CONFIG_VALUE_${n + 1}`]: "false"', '`GIT_CONFIG_VALUE_${n + 1}`]: "true"', tokenFaults],
    ["the Base64 not masked", "console.log(azure ? `${VSO}task.setsecret]${basic}` : `::add-mask::${basic}`);", "", tokenFaults],
    ["the status given the check's environment", 'craftar(["status", "--json", "--offline"], childEnv)', 'craftar(["status", "--json", "--offline"], checkEnv)', tokenFaults],
    ["neuter as identity", 'const neuter = (t) => t.replace(/##(vso)?\\[/gi, (m) => m.slice(0, -1) + " [").replace(/^(\\s*)::/gm, "$1: :");', "const neuter = (t) => t;", hostileFaults],
    ["prop as identity", 'const prop = (s) => azure ? esc(s).replace(/;/g, "%3B").replace(/\\]/g, "%5D") : esc(s).replace(/:/g, "%3A").replace(/,/g, "%2C");', "const prop = (s) => s;", hostileFaults],
  ];
  it.each(removedSafety)("catches %s", (_name, from, to, faults) => {
    expect(faults(mutate(textOf(vendor), from, to), vendor)).not.toEqual([]);
  });
});

describe("a large output through a pipe (spec 46 §10, 8)", () => {
  it.each(VENDORS)("under %s the last annotation and the result arrive", (vendor) => {
    const stdout = `${"x".repeat(200)}\n`.repeat(10_000);
    const r = runProgram(textOf(vendor), vendor, { check: { code: 1, stdout }, status: statusJson([{ path: "last.md", state: "drift" }]) });
    expect(r.stdout.length).toBeGreaterThan(stdout.length);
    expect(anno(r)).toHaveLength(1);
    expect(r.result).toBe("out-of-sync");
    expect(r.code).toBe(1);
  });
});

describe.skipIf(process.platform === "win32")("the steps as bash runs them (spec 46 §4; off Windows)", () => {
  const steps = (vendor: Vendor): Step[] => scriptSteps(read(vendor === "azure" ? AZURE : GITHUB), vendor === "azure");
  it.each(VENDORS)("under %s the heredoc gives node the program, and the exit comes back", (vendor) => {
    const base = newBase();
    const temp = path.join(base, "temp");
    const bin = path.join(temp, "craftar-cli", "node_modules", "craftar", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "craftar.js"), STUB);
    writeFileSync(path.join(bin, "..", "stub.json"), JSON.stringify({ sync: { code: 1 }, status: statusJson([{ path: "a.md", state: "drift" }]) }));
    const out = path.join(base, "output");
    const vendorEnv = vendor === "azure" ? { TF_BUILD: "True", AGENT_TEMPDIRECTORY: temp } : { RUNNER_TEMP: temp, GITHUB_OUTPUT: out };
    const r = spawnSync("bash", ["-e", "-c", bodyOf(steps(vendor)[1], vendor === "azure")], { cwd: base, encoding: "utf8", env: { ...cleanEnv(), ...vendorEnv } });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("a.md");
  });

  it.each(VENDORS)("under %s a version that is not exact stops before npm", (vendor) => {
    for (const bad of ["latest", "^1.0.0", "1.0", "1.0.0-beta", "1.0.0; touch x", ""]) {
      const r = spawnSync("bash", ["-e", "-c", bodyOf(steps(vendor)[0], vendor === "azure")], { encoding: "utf8", env: { ...cleanEnv(), PATH: "/nonexistent:/usr/bin:/bin", CRAFTAR_CI_VERSION: bad } });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("craftar: version must be exact, x.y.z");
    }
  });
});

const BUILT = existsSync(path.join(REPO, "dist", "cli.js"));
describe.skipIf(!BUILT)("a real round on a path Forge, through dist/ (spec 46 §10, 9; skipped with no build)", () => {
  it.each(VENDORS)("under %s: in sync, then a hand edit", async (vendor) => {
    const base = newBase();
    const forge = path.join(base, "forge");
    const checkout = path.join(base, "checkout");
    const temp = path.join(base, "temp");
    await makeForge(forge, { ingredients: [rule("a", "# rule a\n")], recipes: [recipe("r", ["rule/a"])], profiles: [profile("acme", ["r"])] });
    await makeWorkspace(checkout, forge, { config: { profile: "acme" } });
    const parent = path.join(temp, "craftar-cli", "node_modules");
    mkdirSync(parent, { recursive: true });
    symlinkSync(REPO, path.join(parent, "craftar"), "junction");
    scratch.unshift(path.join(parent, "craftar")); // the link goes first, never through it
    const bin = path.join(REPO, "bin", "craftar.js");
    const env = { ...cleanEnv(), CRAFTAR_HOME: path.join(base, "home"), CRAFTAR_NO_REGISTRY: "1" };
    expect(spawnSync(process.execPath, [bin, "sync", "--workspace", checkout], { env, encoding: "utf8" }).status).toBe(0);

    const out = path.join(base, "output");
    const vendorEnv = vendor === "azure" ? { TF_BUILD: "True", AGENT_TEMPDIRECTORY: temp } : { RUNNER_TEMP: temp, GITHUB_OUTPUT: out };
    const go = () => spawnSync(process.execPath, ["--input-type=module", "-"], { input: textOf(vendor), cwd: checkout, encoding: "utf8", env: { ...cleanEnv(), ...vendorEnv } });

    const inSync = go();
    expect(inSync.stdout).toContain("workspace in sync");
    expect(inSync.status).toBe(0);

    await fs.appendFile(path.join(checkout, ".claude", "rules", "a.md"), "edited by hand\n");
    const edited = go();
    expect(edited.status).toBe(1);
    const line = vendor === "azure" ? "##vso[task.logissue type=error;sourcepath=.claude/rules/a.md]craftar: drift" : "::error file=.claude/rules/a.md::craftar: drift";
    expect(edited.stdout.split("\n")).toContain(line);
    expect(vendor === "azure" ? edited.stdout : readFileSync(out, "utf8")).toContain(vendor === "azure" ? "isOutput=true]out-of-sync" : "result=out-of-sync");
  });
});
