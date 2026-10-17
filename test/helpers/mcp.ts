import { readWorkspaceConfig } from "../../src/core/sync.js";
import { handleLine, pinOf, type McpContext, type McpState } from "../../src/core/mcp-protocol.js";

export interface ToolAnswer {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: any;
}

/** An in-process server bound to `root`, pinned as `craftar mcp` pins at launch. `initialize` is already answered. */
export async function session(root: string, over: Partial<McpContext> = {}) {
  const ctx: McpContext = {
    root,
    fetch: false,
    home: process.env.CRAFTAR_HOME!,
    version: "0.0.0-test",
    registryOff: false,
    env: {},
    pin: pinOf(await readWorkspaceConfig(root)),
    ...over,
  };
  const state: McpState = { initialized: false };
  let id = 0;
  /** One raw line in, the parsed answer out (null when the server writes nothing). */
  const send = async (line: string): Promise<any> => {
    const out = await handleLine(line, ctx, state);
    if (out !== null && out.includes("\n")) throw new Error("an answer is one line");
    return out === null ? null : JSON.parse(out);
  };
  const request = (method: string, params?: unknown) => send(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params === undefined ? {} : { params }) }));
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  /** `tools/call`: the tool's result, or the JSON-RPC error object under `rpcError`. */
  const tool = async (name: string, args?: Record<string, unknown>): Promise<ToolAnswer & { rpcError?: { code: number; message: string } }> => {
    const a = await request("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) });
    return a.error ? { content: [], rpcError: a.error } : a.result;
  };
  return { ctx, state, send, request, tool };
}
