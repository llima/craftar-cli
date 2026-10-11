import { handleLine, type McpContext, type McpState } from "./core/mcp-protocol.js";

/*
 * The stdio transport of `craftar mcp` (spec 35 §4.3): one JSON-RPC message per line in, one per line out. The
 * only place that knows the wire — the protocol itself is `src/core/mcp-protocol.ts`. It splits lines itself
 * (the cap needs it, and `node:readline` stays `src/prompt.ts`'s alone), touches neither `process` nor `console`,
 * and writes nothing but answers.
 */

/** A line longer than this is discarded whole: one line cannot hold the server's memory. */
export const MAX_LINE_BYTES = 1024 * 1024;

/**
 * Lines in, lines out, one call at a time: a line is not handled before the previous one was answered.
 * Resolves when `input` has ended and the last answer was written.
 */
export function serve(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, ctx: McpContext): Promise<void> {
  const state: McpState = { initialized: false };
  let queue: Promise<void> = Promise.resolve();
  // The bytes of the line being read: decoded only once it is whole, so a character split across chunks survives.
  let parts: Buffer[] = [];
  let size = 0;
  // Inside a line that already passed the cap: its bytes are dropped up to the newline, never buffered.
  let skipping = false;

  const line = (bytes: Buffer) => {
    const end = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d ? bytes.length - 1 : bytes.length;
    if (end === 0) return;
    const text = bytes.toString("utf8", 0, end);
    queue = queue.then(async () => {
      // A tool that fails is an answer; anything else that throws drops the line, and the server reads on.
      const answer = await handleLine(text, ctx, state).catch(() => null);
      if (answer !== null) output.write(answer + "\n");
    });
  };

  const feed = (chunk: Buffer) => {
    let from = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, from);
      const piece = chunk.subarray(from, newline === -1 ? chunk.length : newline);
      if (!skipping) {
        if (size + piece.length > MAX_LINE_BYTES) {
          skipping = true;
          parts = [];
          size = 0;
        } else {
          parts.push(piece);
          size += piece.length;
        }
      }
      if (newline === -1) return;
      if (!skipping) line(Buffer.concat(parts));
      skipping = false;
      parts = [];
      size = 0;
      from = newline + 1;
    }
  };

  return new Promise((resolve) => {
    input.on("data", (chunk: Buffer | string) => feed(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk));
    input.on("end", () => {
      // A last line with no newline is still a line
      if (!skipping && size > 0) line(Buffer.concat(parts));
      void queue.then(resolve);
    });
  });
}
