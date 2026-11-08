/**
 * `craftar setup`'s interactive mode (spec 62 §4.5): the questions a command line does not answer, over `InitIo`, and the one
 * confirmation before anything is written. No `process`, no `console`, no `readline` — `src/cli.ts` and `src/prompt.ts` hold them.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { TARGETS, type Target } from "../schema/index.js";
import { yesNo, type InitIo } from "./init-flow.js";
import { STARTER_REACHES_NO_FILE, TARGET_STATES, defaultForgeDir, derivedName, rulesReachNoFile, setupForgeFiles } from "./setup.js";
import { checkSetupFlags, checkSetupPlaces, holdsClaude } from "./setup-write.js";

/** What the flags gave; a key left `undefined` is asked. */
export interface SetupGiven {
  forgeDir?: string;
  name?: string;
  profile?: string;
  targets?: string[];
  starter?: boolean;
  git: boolean;
  workspaces: string[];
  import?: boolean;
  sync: boolean;
}

/** The run the answers describe — everything `runSetup` needs, absolute paths. */
export interface SetupAnswers {
  forgeAbs: string;
  name: string;
  profile: string;
  targets: Target[];
  starter: boolean;
  git: boolean;
  workspaces: string[];
  import: boolean;
}

export interface SetupFlowContext {
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
}

export type SetupAskResult = { kind: "cancelled" } | { kind: "answered"; answers: SetupAnswers };

/** A yes/no question with a default; `null` when the input ended (cancel). */
async function askYesNo(io: InitIo, question: string, dflt: boolean): Promise<boolean | null> {
  for (;;) {
    const a = await io.ask(question);
    if (a === null) return null;
    if (a.trim() === "") return dflt;
    const yn = yesNo(a);
    if (yn !== null) return yn;
    io.say("answer yes or no");
  }
}

/** A text question with a default, re-asked while `check` throws (its message said); `null` when the input ended. */
async function askChecked(io: InitIo, question: string, dflt: string, check: (v: string) => Promise<void> | void): Promise<string | null> {
  for (;;) {
    const a = await io.ask(question);
    if (a === null) return null;
    const v = a.trim() === "" ? dflt : a.trim();
    try {
      await check(v);
      return v;
    } catch (e) {
      io.say(e instanceof Error ? e.message : String(e));
    }
  }
}

/**
 * §4.5's questions, in this order: an import of the current directory when it holds `.claude/`; where the Forge lives; its name;
 * the first profile's name; the workspaces (each holding `.claude/` offered the import while none was taken); then, unless a
 * workspace is imported, the targets and the starter. A question whose flag was given is not asked. Every answer is checked as
 * the flags are (S1–S5, S7, S9, S11), and a refused answer is asked again with the refusal's words.
 */
export async function askSetup(given: SetupGiven, io: InitIo, ctx: SetupFlowContext): Promise<SetupAskResult> {
  const cancelled: SetupAskResult = { kind: "cancelled" };
  const workspaces = given.workspaces.map((w) => path.resolve(ctx.cwd, w));
  let importWs: string | null = null;
  if (given.import === true) {
    for (const w of workspaces) if (await holdsClaude(w)) importWs ??= w;
  }

  // Q1: the current directory holds .claude/.
  if (given.import === undefined && workspaces.length === 0 && (await holdsClaude(ctx.cwd)) && !(await hasConfig(ctx.cwd))) {
    const yes = await askYesNo(io, "This directory holds a Claude Code harness. Create a Forge from it (import) [yes]: ", true);
    if (yes === null) return cancelled;
    if (yes) {
      workspaces.push(ctx.cwd);
      importWs = ctx.cwd;
    }
  }

  // Q2: where the Forge lives (S2–S4 against the workspaces known so far).
  const forgeDir =
    given.forgeDir ??
    (await askChecked(io, `Where should the new Forge live [${defaultForgeDir(ctx.cwd)}]: `, defaultForgeDir(ctx.cwd), async (v) => {
      checkSetupFlags({ forgeDir: v, profile: "x", workspaces: [] }, ctx.platform);
      await checkSetupPlaces(path.resolve(ctx.cwd, v), workspaces, ctx.home, ctx.platform);
    }));
  if (forgeDir === null) return cancelled;
  const forgeAbs = path.resolve(ctx.cwd, forgeDir);

  // Q3: the Forge's name.
  const name =
    given.name ??
    (await askChecked(io, `Forge name [${derivedName(forgeAbs)}]: `, derivedName(forgeAbs), (v) =>
      checkSetupFlags({ forgeDir, name: v, profile: "x", workspaces: [] }, ctx.platform),
    ));
  if (name === null) return cancelled;

  // Q4: the first profile's name.
  const profile =
    given.profile ??
    (await askChecked(io, `First profile's name [${derivedName(ctx.cwd)}]: `, derivedName(ctx.cwd), (v) =>
      checkSetupFlags({ forgeDir, profile: v, workspaces: [] }, ctx.platform),
    ));
  if (profile === null) return cancelled;

  // Q7 (asked before the targets, since an imported workspace decides them): the workspaces.
  if (given.workspaces.length === 0) {
    const inside = isInside(ctx.cwd, forgeAbs);
    if (!workspaces.includes(ctx.cwd) && !inside && !(await hasConfig(ctx.cwd))) {
      const yes = await askYesNo(io, `Start a workspace in ${ctx.cwd} [yes]: `, true);
      if (yes === null) return cancelled;
      if (yes) {
        const imp = await offerImport(io, ctx.cwd, importWs);
        if (imp === null) return cancelled;
        workspaces.push(ctx.cwd);
        if (imp) importWs = ctx.cwd;
      }
    }
    for (;;) {
      const more = await askChecked(io, "Another workspace directory (empty to finish): ", "", async (v) => {
        if (v === "") return;
        const abs = path.resolve(ctx.cwd, v);
        if (workspaces.includes(abs)) throw new Error(`${abs} is already in the list`);
        await checkSetupPlaces(forgeAbs, [abs], ctx.home, ctx.platform);
      });
      if (more === null) return cancelled;
      if (more === "") break;
      const abs = path.resolve(ctx.cwd, more);
      const imp = await offerImport(io, abs, importWs);
      if (imp === null) return cancelled;
      workspaces.push(abs);
      if (imp) importWs = abs;
    }
  }

  // Q5, Q6: targets and the starter, unless a workspace fills the Forge by import.
  let targets: Target[] = ["claude-code"];
  let starter = false;
  if (importWs === null) {
    if (given.targets !== undefined) {
      targets = given.targets as Target[];
    } else {
      const list = TARGETS.map((t) => `${t} (${TARGET_STATES[t]})`).join(", ");
      const answer = await askChecked(io, `Targets — ${list}, separated by commas [claude-code]: `, "claude-code", (v) =>
        checkSetupFlags({ forgeDir, profile, targets: splitList(v), workspaces: [] }, ctx.platform),
      );
      if (answer === null) return cancelled;
      targets = splitList(answer) as Target[];
    }
    if (given.starter !== undefined) {
      starter = given.starter;
    } else {
      const yes = await askYesNo(io, "Add a starter rule so the first sync writes a file [yes]: ", true);
      if (yes === null) return cancelled;
      starter = yes;
    }
  }

  return { kind: "answered", answers: { forgeAbs, name, profile, targets, starter, git: given.git, workspaces, import: importWs !== null } };
}

/** S8 in the flow: a directory holding `.claude/` is offered the import while no workspace was imported yet. */
async function offerImport(io: InitIo, dir: string, importWs: string | null): Promise<boolean | null> {
  if (importWs !== null || !(await holdsClaude(dir))) return false;
  return askYesNo(io, `${dir} holds .claude/. Import it into the Forge [yes]: `, true);
}

/**
 * §4.5 step 8: what will be written, then one question. `[yes]`, `y`, `yes` confirm; `n`, `no` or an ended input cancel;
 * anything else is asked again.
 */
export async function confirmSetup(a: SetupAnswers, io: InitIo, opts: { sync: boolean }): Promise<"confirmed" | "cancelled"> {
  io.say(`craftar setup — about to create the Forge ${a.name} at ${a.forgeAbs}`);
  if (a.import) {
    io.say(`  craftar.forge.yaml, README.md, then import ${a.workspaces.find((w) => w) ?? ""} as profile ${a.profile}`);
  } else {
    for (const f of setupForgeFiles({ name: a.name, profile: a.profile, targets: a.targets, starter: a.starter })) io.say(`  + ${f.path}`);
    if (a.starter && rulesReachNoFile(a.targets)) io.say(`  note ${STARTER_REACHES_NO_FILE}`);
  }
  io.say(a.git ? "  git: one initial commit, no remote" : "  git: none");
  for (const w of a.workspaces) io.say(`  workspace ${w}${opts.sync ? " (craftar.yaml and the first sync)" : " (craftar.yaml)"}`);
  const n = a.workspaces.length;
  const what = [a.git ? "Create the Forge, commit it" : "Create the Forge", n > 0 ? `start ${n} workspace${n === 1 ? "" : "s"}` : null].filter(Boolean).join(" and ");
  for (;;) {
    const answer = await io.confirm(`${what} [yes]: `);
    if (answer === null) return "cancelled";
    if (answer.trim() === "") return "confirmed";
    const yn = yesNo(answer);
    if (yn === true) return "confirmed";
    if (yn === false) return "cancelled";
    io.say("answer yes or no");
  }
}

/** The `again` line: the same run as flags, for CI (§4.5). */
export function setupAgainLine(a: SetupAnswers, cwd: string, opts: { sync: boolean }): string {
  const q = (s: string) => (/^[\w./-]+$/.test(s) ? s : JSON.stringify(s));
  const rel = (abs: string) => {
    const r = path.relative(cwd, abs);
    return r === "" ? "." : r;
  };
  const parts = ["  again craftar setup", `--forge-dir ${q(rel(a.forgeAbs))}`, `--name ${q(a.name)}`, `--profile ${q(a.profile)}`];
  if (!a.import) {
    parts.push(`--targets ${a.targets.join(",")}`);
    if (!a.starter) parts.push("--no-starter");
  }
  if (!a.git) parts.push("--no-git");
  for (const w of a.workspaces) parts.push(`--workspace ${q(rel(w))}`);
  if (a.workspaces.length > 0) parts.push(a.import ? "--import" : "--no-import");
  if (!opts.sync) parts.push("--no-sync");
  return parts.join(" ");
}

function splitList(v: string): string[] {
  return v.split(",").map((t) => t.trim()).filter((t) => t !== "");
}

function isInside(child: string, parent: string): boolean {
  const r = path.relative(parent, child);
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
}

async function hasConfig(dir: string): Promise<boolean> {
  return fs.lstat(path.join(dir, "craftar.yaml")).then(
    () => true,
    () => false,
  );
}
