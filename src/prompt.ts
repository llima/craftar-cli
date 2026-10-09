/**
 * The readline adapter for the interactive `init` flow (spec 28 §5.2).
 * This is the only module that imports `node:readline`.
 *
 * The adapter opens a readline interface for one question and closes it with the answer.
 * Between questions there is no interface, so Ctrl-C is Node's default signal exit and
 * git can read the terminal. In a terminal, Node's keypress decoder stays attached to
 * the stream by design (it is set once by `emitKeypressEvents` and never removed).
 *
 * This module never touches `process` or `console`.
 */

import * as readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { InitIo } from "./core/init-flow.js";

/** How long `confirm` waits while discarding input already waiting (ms). */
export const DRAIN_MS = 50;

/**
 * Returns an `InitIo` backed by `node:readline/promises`.
 *
 * After `ask` or `confirm` resolves, the interface is closed (the terminal leaves raw mode
 * and the stream is paused). In a terminal, Node's keypress decoder stays attached to
 * the stream — removing it would break subsequent questions.
 */
export function readlineIo(
  input: Readable,
  output: Writable,
  opts: { terminal: boolean },
): InitIo {
  return {
    ask: (question: string) => askOne(input, output, opts.terminal, question),
    confirm: (question: string) => confirmOne(input, output, opts.terminal, question),
    say: (line: string) => { output.write(line + "\n"); },
  };
}

/** Ask one question and return the answer, or `null` on interrupt/close. */
async function askOne(
  input: Readable,
  output: Writable,
  terminal: boolean,
  question: string,
): Promise<string | null> {
  const rl = readline.createInterface({ input, output, terminal });
  let resolved = false;

  const questionPromise = rl.question(question);

  const result = await new Promise<string | null>((resolve) => {
    const done = (value: string | null): void => {
      if (resolved) return;
      resolved = true;
      rl.removeListener("SIGINT", onSigint);
      rl.removeListener("close", onClose);
      resolve(value);
    };

    const onSigint = (): void => done(null);
    const onClose = (): void => done(null);

    rl.on("SIGINT", onSigint);
    rl.on("close", onClose);

    questionPromise.then(
      (answer) => { done(answer); rl.close(); },
      () => { done(null); rl.close(); },
    );
  });

  // Suppress any unhandled rejection from the question promise
  questionPromise.catch(() => { /* swallow */ });

  return result;
}

/**
 * Discard what is already waiting on the input, then ask the question.
 * On a real terminal this drops typed-ahead lines the kernel already delivered.
 */
async function confirmOne(
  input: Readable,
  output: Writable,
  terminal: boolean,
  question: string,
): Promise<string | null> {
  const onData = (): void => { /* discard */ };
  input.on("data", onData);
  input.resume();

  await new Promise((r) => setTimeout(r, DRAIN_MS));

  input.removeListener("data", onData);
  input.pause();

  return askOne(input, output, terminal, question);
}
