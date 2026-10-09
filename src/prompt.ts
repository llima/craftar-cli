/**
 * The readline adapter for the interactive `init` flow (spec 28 §5.2).
 * This is the only module that imports `node:readline`.
 *
 * The adapter opens a `readline` interface for one question and closes it with the answer.
 * Between questions there is no interface, so Ctrl-C is Node's default signal exit and git
 * can read the terminal. The adapter listens for SIGINT and a `close` it did not ask for,
 * and resolves `null` for both.
 *
 * This module never touches `process` or `console`.
 */

import * as readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { InitIo } from "./core/init-flow.js";

/**
 * How long `confirm` waits while discarding input already waiting (ms).
 * 50 ms is enough to drain typed-ahead lines the kernel already delivered.
 */
export const DRAIN_MS = 50;

/**
 * Returns an `InitIo` backed by `node:readline/promises`.
 *
 * - `ask(question)`: create one interface, resolve with the line typed, or `null` on SIGINT / close.
 * - `confirm(question)`: discard what is already waiting on the input, then `ask`.
 * - `say(line)`: write the line to output with a newline.
 *
 * After `ask` or `confirm` resolves, the input stream has no `data`, `end`, `keypress` or
 * `readable` listener left that the adapter or its interface added, and the interface's
 * `close` has fired.
 *
 * @param input  The input stream (stdin in production)
 * @param output The output stream (stdout in production)
 * @param opts   Whether to treat the streams as a terminal (`terminal: true` for SIGINT)
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

/**
 * Snapshot the listeners on an input stream before creating a readline interface,
 * so we can remove only the ones the interface added.
 */
function snapshotListeners(input: Readable): Map<string, Function[]> {
  const events = ["data", "end", "keypress", "readable"] as const;
  const snapshot = new Map<string, Function[]>();
  for (const event of events) {
    snapshot.set(event, [...input.listeners(event)]);
  }
  return snapshot;
}

/**
 * Remove from the input stream all listeners for the tracked events that were not
 * in the snapshot. This cleans up what the readline interface added.
 */
function removeAddedListeners(input: Readable, before: Map<string, Function[]>): void {
  for (const [event, oldListeners] of before.entries()) {
    const current = input.listeners(event);
    for (const listener of current) {
      if (!oldListeners.includes(listener)) {
        input.removeListener(event, listener as (...args: unknown[]) => void);
      }
    }
  }
}

/**
 * Ask one question and return the answer, or `null` on interrupt/close.
 * After resolution, the interface is closed and all listeners are removed.
 */
async function askOne(
  input: Readable,
  output: Writable,
  terminal: boolean,
  question: string,
): Promise<string | null> {
  // Snapshot listeners before creating the interface
  const listenersBefore = snapshotListeners(input);

  const rl = readline.createInterface({ input, output, terminal });

  // Track whether we resolved ourselves (so we know if the close was ours or external)
  let resolved = false;

  // The question promise: we race it against SIGINT and close
  const questionPromise = rl.question(question);

  // Create the race
  const result = await new Promise<string | null>((resolve) => {
    // SIGINT handler (only fires with terminal: true when user presses Ctrl-C)
    const onSigint = (): void => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    };
    rl.on("SIGINT", onSigint);

    // Close handler: fires when the input ends or rl.close() is called
    // If we didn't resolve ourselves, the close was external (input ended)
    const onClose = (): void => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    };
    rl.on("close", onClose);

    // The question itself
    questionPromise.then(
      (answer) => {
        if (!resolved) {
          resolved = true;
          resolve(answer);
        }
      },
      (err: Error & { code?: string }) => {
        // The question might reject with AbortError on Ctrl-C without a SIGINT listener.
        // We have a SIGINT listener so this shouldn't happen, but handle it anyway.
        if (!resolved) {
          resolved = true;
          // AbortError (ABORT_ERR) means interrupted
          if (err.code === "ABORT_ERR") {
            resolve(null);
          } else {
            // Unexpected error; still resolve null to not throw
            resolve(null);
          }
        }
      },
    );
  });

  // Always close the interface after we resolve
  rl.close();

  // Remove all listeners the interface added (readline doesn't fully clean up)
  removeAddedListeners(input, listenersBefore);

  // Suppress any unhandled rejection from the question promise
  // (it may reject after we already resolved via SIGINT or close)
  questionPromise.catch(() => { /* swallow */ });

  return result;
}

/**
 * Discard what is already waiting on the input, then ask the question.
 *
 * Discarding typed-ahead lines is best-effort: it attaches a throwaway `data` listener,
 * resumes the stream, waits DRAIN_MS, then removes the listener and pauses.
 *
 * On a real terminal this drops typed-ahead lines the kernel already delivered.
 * If a by-hand run shows this unreliable (§13 item 36), the confirmation loses its
 * default on that platform and must be typed.
 *
 * On a stream that has ended, skip the wait's result and let `ask` resolve `null`.
 */
async function confirmOne(
  input: Readable,
  output: Writable,
  terminal: boolean,
  question: string,
): Promise<string | null> {
  // Track if the stream ended during discard
  let ended = false;

  // Throwaway data listener to consume waiting input
  const onData = (): void => { /* discard */ };
  const onEnd = (): void => { ended = true; };

  input.on("data", onData);
  input.on("end", onEnd);
  input.resume();

  // Wait DRAIN_MS
  await new Promise((r) => setTimeout(r, DRAIN_MS));

  // Remove the listeners and pause
  input.removeListener("data", onData);
  input.removeListener("end", onEnd);
  input.pause();

  // If the stream ended during discard, let ask resolve null
  // (ask will detect the closed stream)
  if (ended) {
    // The stream has ended; ask will return null
  }

  return askOne(input, output, terminal, question);
}
