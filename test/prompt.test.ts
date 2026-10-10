import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { readlineIo, DRAIN_MS } from "../src/prompt.js";

/**
 * Tests for the readline adapter (spec 28 §4.4, §5.2, §9.2).
 *
 * Tests 1–6 use `{ terminal: false }` so the output holds no echo and no escape code.
 * Test 7 uses `{ terminal: true }` and asserts only what it names.
 */

function createStreams(): { input: PassThrough; output: PassThrough; collected: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let buf = "";
  output.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
  return { input, output, collected: () => buf };
}

/** Promisified setImmediate. */
function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("readlineIo", () => {
  it("a line answers", async () => {
    const { input, output, collected } = createStreams();
    const io = readlineIo(input, output, { terminal: false });
    const p = io.ask("Forge: ");
    input.write("../forge\n");
    const result = await p;
    expect(result).toBe("../forge");
    expect(collected()).toBe("Forge: ");
  });

  it("two questions, two interfaces", async () => {
    const { input, output, collected } = createStreams();
    const io = readlineIo(input, output, { terminal: false });

    // Record listener count before
    const countBefore = input.listenerCount("data") + input.listenerCount("end") + input.listenerCount("readable");
    expect(countBefore).toBe(0);

    // First question
    const p1 = io.ask("Q1: ");
    input.write("a\n");
    const r1 = await p1;

    // After the first resolves and one setImmediate
    await immediate();
    const countBetween = input.listenerCount("data") + input.listenerCount("end") + input.listenerCount("readable");
    expect(countBetween).toBe(0);

    // Second question
    const p2 = io.ask("Q2: ");
    input.write("b\n");
    const r2 = await p2;

    expect(r1).toBe("a");
    expect(r2).toBe("b");
    expect(collected()).toBe("Q1: Q2: ");
  });

  it("the end of the stream resolves null", async () => {
    const { input, output } = createStreams();
    const io = readlineIo(input, output, { terminal: false });
    const p = io.ask("Q: ");
    input.end();
    const result = await p;
    expect(result).toBe(null);
  });

  it("an input already ended", { timeout: 2000 }, async () => {
    const { input, output } = createStreams();
    input.end(); // End before creating the io
    const io = readlineIo(input, output, { terminal: false });
    const result = await io.ask("Q: ");
    expect(result).toBe(null);
  });

  it("say", () => {
    const { input, output, collected } = createStreams();
    const io = readlineIo(input, output, { terminal: false });
    io.say("hello");
    expect(collected()).toBe("hello\n");
  });

  it("confirm ignores a line written before it is called", async () => {
    const { input, output } = createStreams();
    const io = readlineIo(input, output, { terminal: false });

    // Write a line before confirm is called
    input.write("yes\n");
    await immediate();

    // Call confirm
    const p = io.confirm("Write [yes]: ");

    // Wait DRAIN_MS + 30 ms
    await new Promise((r) => setTimeout(r, DRAIN_MS + 30));

    // Write the real answer
    input.write("no\n");
    const result = await p;
    expect(result).toBe("no");

    // --- CONTROL (same test file): M2 measured that ask() DOES see the early line ---
    // If M2 measured that `ask` does NOT see the early line, this control would be vacuous.
    // M2 says YES: a pre-written line answers the question.
    const { input: input2, output: output2 } = createStreams();
    const io2 = readlineIo(input2, output2, { terminal: false });

    // Write a line before ask is called (same as M2)
    input2.write("yes\n");
    await immediate();

    // Call ask (not confirm)
    const result2 = await io2.ask("Write [yes]: ");
    // M2: the pre-written line DOES answer the question
    expect(result2).toBe("yes");
  });

  it("an interrupt resolves null", { timeout: 2000 }, async () => {
    const { input, output } = createStreams();
    const io = readlineIo(input, output, { terminal: true }); // terminal: true for SIGINT

    const p = io.ask("Q: ");
    // Write Ctrl-C
    input.write("\x03");
    const result = await p;
    expect(result).toBe(null);
  });

  it("terminal: two questions, two answers", { timeout: 3000 }, async () => {
    const { input, output } = createStreams();
    const io = readlineIo(input, output, { terminal: true });

    const p1 = io.ask("Q1: ");
    input.write("a\r");
    expect(await p1).toBe("a");

    const p2 = io.ask("Q2: ");
    input.write("b\r");
    expect(await p2).toBe("b");
  });

  it("terminal: a question after an interrupt still works", { timeout: 3000 }, async () => {
    const { input, output } = createStreams();
    const io = readlineIo(input, output, { terminal: true });

    const p1 = io.ask("Q1: ");
    input.write("\x03");
    expect(await p1).toBe(null);

    const p2 = io.ask("Q2: ");
    input.write("c\r");
    expect(await p2).toBe("c");
  });

  it("terminal: confirm ignores typed-ahead input", { timeout: 3000 }, async () => {
    const { input, output } = createStreams();
    const io = readlineIo(input, output, { terminal: true });

    // First, answer a question
    const p1 = io.ask("Q1: ");
    input.write("a\r");
    expect(await p1).toBe("a");

    // Write a stray line before confirm is called
    input.write("x\r");
    await immediate();

    // Call confirm
    const p2 = io.confirm("Write [yes]: ");

    // Wait DRAIN_MS + 30 ms
    await new Promise((r) => setTimeout(r, DRAIN_MS + 30));

    // Write the real answer
    input.write("yes\r");
    expect(await p2).toBe("yes");
  });

  it("no unhandled rejection", async () => {
    const spy = vi.fn();
    process.once("unhandledRejection", spy);

    try {
      // Test 3's sequence: the end of the stream resolves null
      {
        const { input, output } = createStreams();
        const io = readlineIo(input, output, { terminal: false });
        const p = io.ask("Q: ");
        input.end();
        await p;
      }
      await immediate();
      await immediate();

      // Test 7's sequence: an interrupt resolves null
      {
        const { input, output } = createStreams();
        const io = readlineIo(input, output, { terminal: true });
        const p = io.ask("Q: ");
        input.write("\x03");
        await p;
      }
      await immediate();
      await immediate();

      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", spy);
    }
  });

  it("the one importer", () => {
    // Read every .ts under src/ and assert that only src/prompt.ts imports node:readline
    const srcDir = path.resolve(__dirname, "..", "src");
    const files: string[] = [];

    function walk(dir: string): void {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (entry.endsWith(".ts")) {
          files.push(full);
        }
      }
    }
    walk(srcDir);

    const readlineImporters: string[] = [];
    const promptFile = path.join(srcDir, "prompt.ts");
    let promptHasProcess = false;
    let promptHasConsole = false;

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      if (/from "node:readline/.test(content)) {
        // Convert to POSIX relative path from repo root
        const rel = path.relative(path.resolve(__dirname, ".."), file).replace(/\\/g, "/");
        readlineImporters.push(rel);
      }
      if (file === promptFile) {
        promptHasProcess = /\bprocess\./.test(content);
        promptHasConsole = /\bconsole\./.test(content);
      }
    }

    readlineImporters.sort();
    expect(readlineImporters).toEqual(["src/prompt.ts"]);
    expect(promptHasProcess).toBe(false);
    expect(promptHasConsole).toBe(false);
  });

  it("terminal: interface is closed after an interrupt (raw mode left)", { timeout: 2000 }, async () => {
    const { input, output } = createStreams();
    // Cast to any: a fake TTY for the test — readline's setRawMode is called only when isTTY is true
    const calls: boolean[] = [];
    (input as any).isTTY = true;
    (input as any).setRawMode = (v: boolean) => { calls.push(v); return input; };

    const io = readlineIo(input, output, { terminal: true });
    const p = io.ask("Q: ");
    input.write("\x03");
    expect(await p).toBe(null);
    expect(calls).toEqual([true, false]);
  });

  it("terminal: interface is closed after an answer (raw mode left)", { timeout: 2000 }, async () => {
    const { input, output } = createStreams();
    // Cast to any: a fake TTY for the test — readline's setRawMode is called only when isTTY is true
    const calls: boolean[] = [];
    (input as any).isTTY = true;
    (input as any).setRawMode = (v: boolean) => { calls.push(v); return input; };

    const io = readlineIo(input, output, { terminal: true });
    const p = io.ask("Q: ");
    input.write("a\r");
    expect(await p).toBe("a");
    expect(calls).toEqual([true, false]);
  });
});

describe("readlineIo — the input ends before the confirmation (review round 1)", () => {
  it("an input that ended while nothing was asked: confirm resolves null", { timeout: 2000 }, async () => {
    const { input, output } = createStreams();
    const io = readlineIo(input, output, { terminal: false });
    input.end();
    expect(await io.confirm("Write [yes]: ")).toBe(null);
  });

  it("an input that ends during the discard: confirm resolves null", { timeout: 2000 }, async () => {
    const { input, output } = createStreams();
    const io = readlineIo(input, output, { terminal: false });
    const p = io.confirm("Write [yes]: ");
    input.end();
    expect(await p).toBe(null);
  });
});
