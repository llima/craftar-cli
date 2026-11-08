/**
 * `craftar setup`'s interactive mode (spec 62 §4.5): the questions a command line does not answer, over `InitIo`, and the one
 * confirmation before anything is written. No `process`, no `console`, no `readline` — `src/cli.ts` and `src/prompt.ts` hold them.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { TARGETS, type Target } from "../schema/index.js";
import { yesNo, type InitIo } from "./init-flow.js";
import { STARTER_REACHES_NO_FILE, TARGET_STATES, defaultForgeDir, derivedName, rulesReachNoFile, setupForgeFiles, shellQuote } from "./setup.js";
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
  /** The workspace whose `.claude/` fills the Forge (§4.4), or null for the starter or skeleton branch. */
  importWs: string | null;
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
  const workspaces: string[] = [];
  // The import decision (§4.4, S8, S9): one workspace imported, or the import declined for all — never a mix.
  let importWs: string | null = null;
  let declined = given.import === false;

  /** A workspace holding `.claude/` asked about the import; "refused" when another one was imported already (S9). */
  const decide = async (dir: string): Promise<"ok" | "refused" | null> => {
    if (!(await holdsClaude(dir))) return "ok";
    if (importWs !== null) {
      io.say(`setup imports one workspace — ${importWs} is imported; start ${dir} afterwards with craftar import and craftar init`);
      return "refused";
    }
    if (declined) return "ok";
    if (given.import === true) {
      importWs = dir;
      return "ok";
    }
    const yes = await askYesNo(io, `${dir} holds .claude/. Import it into the Forge [yes]: `, true);
    if (yes === null) return null;
    if (yes) importWs = dir;
    else declined = true;
    return "ok";
  };

  // The workspaces the flags gave go through the same decision, so the flags form's S8 never reaches a confirmed run.
  for (const w of given.workspaces) {
    const abs = path.resolve(ctx.cwd, w);
    const d = await decide(abs);
    if (d === null) return cancelled;
    if (d === "refused") return cancelled;
    workspaces.push(abs);
  }

  // Q1: the current directory holds .claude/.
  if (given.import === undefined && given.workspaces.length === 0 && (await holdsClaude(ctx.cwd)) && !(await hasConfig(ctx.cwd))) {
    const yes = await askYesNo(io, "This directory holds a Claude Code harness. Create a Forge from it (import) [yes]: ", true);
    if (yes === null) return cancelled;
    if (yes) {
      workspaces.push(ctx.cwd);
      importWs = ctx.cwd;
    } else {
      declined = true;
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

  // Q7 (asked before the targets, since an imported workspace decides them): the workspaces, each checked (S2, S7, S9).
  if (given.workspaces.length === 0) {
    if (!workspaces.includes(ctx.cwd)) {
      // The current directory is offered only when it could be one (S2, S7); otherwise the reason is said.
      const place = await checkSetupPlaces(forgeAbs, [ctx.cwd], ctx.home, ctx.platform).then(
        () => null,
        (e: Error) => e.message,
      );
      if (place !== null) {
        io.say(`not offering ${ctx.cwd} as a workspace: ${place}`);
      } else {
        const yes = await askYesNo(io, `Start a workspace in ${ctx.cwd} [yes]: `, true);
        if (yes === null) return cancelled;
        if (yes) {
          const d = await decide(ctx.cwd);
          if (d === null) return cancelled;
          if (d === "ok") workspaces.push(ctx.cwd);
        }
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
      const d = await decide(abs);
      if (d === null) return cancelled;
      if (d === "ok") workspaces.push(abs);
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

  return { kind: "answered", answers: { forgeAbs, name, profile, targets, starter, git: given.git, workspaces, importWs } };
}

/**
 * §4.5 step 8: what will be written, then one question. `[yes]`, `y`, `yes` confirm; `n`, `no` or an ended input cancel;
 * anything else is asked again.
 */
export async function confirmSetup(a: SetupAnswers, io: InitIo, opts: { sync: boolean }): Promise<"confirmed" | "cancelled"> {
  io.say(`craftar setup — about to create the Forge ${a.name} at ${a.forgeAbs}`);
  if (a.importWs !== null) {
    io.say(`  craftar.forge.yaml, README.md, then import ${a.importWs} as profile ${a.profile}`);
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

/** The `again` line: the same run as flags, for CI (§4.5); every value quoted by `shellQuote` for the platform's shell. */
export function setupAgainLine(a: SetupAnswers, cwd: string, opts: { sync: boolean; platform: NodeJS.Platform }): string {
  const q = (s: string) => shellQuote(s, opts.platform);
  const rel = (abs: string) => {
    const r = path.relative(cwd, abs);
    return r === "" ? "." : r;
  };
  const parts = ["  again craftar setup", `--forge-dir ${q(rel(a.forgeAbs))}`, `--name ${q(a.name)}`, `--profile ${q(a.profile)}`];
  if (a.importWs === null) {
    parts.push(`--targets ${a.targets.join(",")}`);
    if (!a.starter) parts.push("--no-starter");
  }
  if (!a.git) parts.push("--no-git");
  for (const w of a.workspaces) parts.push(`--workspace ${q(rel(w))}`);
  if (a.importWs !== null) parts.push("--import");
  else if (a.workspaces.length > 0) parts.push("--no-import");
  if (!opts.sync) parts.push("--no-sync");
  return parts.join(" ");
}
function splitList(v: string): string[] {
  return v.split(",").map((t) => t.trim()).filter((t) => t !== "");
}

async function hasConfig(dir: string): Promise<boolean> {
  return fs.lstat(path.join(dir, "craftar.yaml")).then(
    () => true,
    () => false,
  );
}
