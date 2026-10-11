import { afterEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { profile, recipe, rule, scenario } from "./helpers/forge.js";
import { MAX_LINE_BYTES, serve } from "../src/mcp.js";
import { pinOf, type McpContext } from "../src/core/mcp-protocol.js";
import { readWorkspaceConfig } from "../src/core/sync.js";

// Spec 35 §4.3 (one line per message, one call at a time, the 1 MiB cap) — the stdio adapter, without a process.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Feed `chunks` (strings or buffers, as they would arrive), end the input, and return every line written. */
async function run(chunks: Array<string | Buffer>, over: Partial<McpContext> = {}): Promise<any[]> {
  const s = await scenario({ ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] }, { config: { profile: "acme" } });
  cleanups.push(s.cleanup);
  const ctx: McpContext = { root: s.wsRoot, fetch: false, home: process.env.CRAFTAR_HOME!, version: "9.9.9", registryOff: false, env: {}, pin: pinOf(await readWorkspaceConfig(s.wsRoot)), ...over };
  const input = new PassThrough();
  const output = new PassThrough();
  const written: Buffer[] = [];
  output.on("data", (c: Buffer) => written.push(c));
  const done = serve(input, output, ctx);
  for (const c of chunks) input.write(c);
  input.end();
  await done;
  const text = Buffer.concat(written).toString("utf8");
  if (text !== "" && !text.endsWith("\n")) throw new Error("the output does not end with a newline");
  return text === "" ? [] : text.slice(0, -1).split("\n").map((l) => JSON.parse(l));
}
const ping = (id: number | string) => JSON.stringify({ jsonrpc: "2.0", id, method: "ping" });
const pong = (id: number | string) => ({ jsonrpc: "2.0", id, result: {} });
const INIT = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } });

describe("craftar mcp — lines in, lines out", () => {
  it("the cap is 1 MiB", () => {
    expect(MAX_LINE_BYTES).toBe(1048576);
  });

  it("answers each line in order, whatever the chunking: several lines in one chunk, one line across chunks, CRLF, a last line with no newline", async () => {
    expect(await run([`${ping(1)}\n${ping(2)}\n`])).toEqual([pong(1), pong(2)]);
    const p = ping(3);
    expect(await run([p.slice(0, 5), p.slice(5, 20), `${p.slice(20)}\n`])).toEqual([pong(3)]);
    expect(await run([`${ping(4)}\r\n${ping(5)}\r\n`])).toEqual([pong(4), pong(5)]);
    expect(await run([`${ping(6)}\n${ping(7)}`])).toEqual([pong(6), pong(7)]);
    expect(await run([])).toEqual([]);
  });

  it("a multi-byte character split across two chunks is decoded whole", async () => {
    const line = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "é—ç", method: "ping" }) + "\n", "utf8");
    const cut = line.indexOf(Buffer.from("—", "utf8")) + 1;
    expect(await run([line.subarray(0, cut), line.subarray(cut)])).toEqual([pong("é—ç")]);
  });

  it("blank lines and lines that are not JSON write nothing, and the next line is answered", async () => {
    expect(await run([`\n\r\n{ not json\n[1,2]\n${ping(1)}\n`])).toEqual([pong(1)]);
  });

  it("a notification writes nothing; every answer is one line of compact JSON", async () => {
    const lines = await run([`${INIT}\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "diff", arguments: { path: ".claude/rules/keep.md" } } })}\n`]);
    expect(lines.map((l) => l.id)).toEqual([0, 1]);
    // the diff of a new file holds a line break inside the JSON string: it is escaped, the message stays one line
    expect(lines[1].result.structuredContent.files[0].diff).toBe("+ # Keep");
  });

  it("a line longer than 1 MiB is discarded whole — in one chunk or many — and the lines around it are answered", async () => {
    const big = `{"jsonrpc":"2.0","id":99,"method":"ping","pad":"${"x".repeat(MAX_LINE_BYTES)}"}`;
    expect(await run([`${ping(1)}\n${big}\n${ping(2)}\n`])).toEqual([pong(1), pong(2)]);
    const pieces: string[] = [];
    for (let i = 0; i < big.length; i += 65536) pieces.push(big.slice(i, i + 65536));
    expect(await run([`${ping(1)}\n`, ...pieces, `\n${ping(2)}\n`])).toEqual([pong(1), pong(2)]);
    expect(await run([big])).toEqual([]);
  });

  it("a line of exactly 1 MiB is answered", async () => {
    const head = '{"jsonrpc":"2.0","id":7,"method":"ping","pad":"';
    const line = `${head}${"x".repeat(MAX_LINE_BYTES - head.length - 2)}"}`;
    expect(Buffer.byteLength(line)).toBe(MAX_LINE_BYTES);
    expect(await run([`${line}\n`])).toEqual([pong(7)]);
  });

  it("one call at a time: a second request is not started before the first was answered", async () => {
    const events: string[] = [];
    let n = 0;
    const readConfig = async (root: string) => {
      const mine = ++n;
      events.push(`start ${mine}`);
      await new Promise((r) => setTimeout(r, mine === 1 ? 60 : 0));
      const merged = await readWorkspaceConfig(root);
      events.push(`end ${mine}`);
      return merged;
    };
    const call = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "targets" } });
    const lines = await run([`${INIT}\n${call(1)}\n${call(2)}\n`], { readConfig });
    expect(events).toEqual(["start 1", "end 1", "start 2", "end 2"]);
    expect(lines.map((l) => l.id)).toEqual([0, 1, 2]);
  });

  it("the input ending during a call: the answer is still written before serve resolves", async () => {
    const readConfig = async (root: string) => (await new Promise((r) => setTimeout(r, 40)), readWorkspaceConfig(root));
    const lines = await run([`${INIT}\n${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status" } })}\n`], { readConfig });
    expect(lines.map((l) => l.id)).toEqual([0, 1]);
    expect(lines[1].result.structuredContent.statuses).toHaveLength(1);
  });

  it("an input that fails or closes without ending still resolves, with the answers already owed written", async () => {
    const s = await scenario({ ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] }, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    const ctx: McpContext = { root: s.wsRoot, fetch: false, home: process.env.CRAFTAR_HOME!, version: "9.9.9", registryOff: false, env: {}, pin: pinOf(await readWorkspaceConfig(s.wsRoot)) };
    for (const how of ["error", "close"] as const) {
      const input = new PassThrough();
      const output = new PassThrough();
      let text = "";
      output.on("data", (c: Buffer) => (text += c.toString("utf8")));
      const done = serve(input, output, ctx);
      input.write(`${ping(1)}\n`);
      await new Promise((r) => setImmediate(r));
      // a pipe that resets (EIO), or one destroyed with no `end`: neither may throw or leave serve pending
      input.destroy(how === "error" ? new Error("EIO") : undefined);
      await done;
      expect(text, how).toBe(JSON.stringify(pong(1)) + "\n");
    }
  });

  it("an output that throws on write does not stop the queue: serve still resolves", async () => {
    const s = await scenario({ ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] }, { config: { profile: "acme" } });
    cleanups.push(s.cleanup);
    const ctx: McpContext = { root: s.wsRoot, fetch: false, home: process.env.CRAFTAR_HOME!, version: "9.9.9", registryOff: false, env: {}, pin: pinOf(await readWorkspaceConfig(s.wsRoot)) };
    const input = new PassThrough();
    const written: string[] = [];
    let n = 0;
    const output = { write: (x: string) => { if (++n === 1) throw new Error("EPIPE"); written.push(x); return true; } } as unknown as NodeJS.WritableStream;
    const done = serve(input, output, ctx);
    input.end(`${ping(1)}\n${ping(2)}\n`);
    await done;
    expect(written).toEqual([JSON.stringify(pong(2)) + "\n"]);
  });
});
