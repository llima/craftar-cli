import { spawn } from "node:child_process";
import path from "node:path";
import { TSX_LOADER } from "./tsx-loader.js";

const REPO = path.resolve(__dirname, "../..");

/** `craftar mcp …` from source, as a live child: write one request per line, read one answer per line. */
export function startMcp(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const child = spawn(process.execPath, ["--import", TSX_LOADER, path.join(REPO, "src/cli.ts"), "mcp", ...args], {
    cwd: opts.cwd ?? REPO,
    env: { ...process.env, ...opts.env, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  let pending = "";
  const waiting: Array<(line: string) => void> = [];
  const lines: string[] = [];
  child.stdout.setEncoding("utf8").on("data", (c: string) => {
    out += c;
    pending += c;
    for (let nl = pending.indexOf("\n"); nl !== -1; nl = pending.indexOf("\n")) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      lines.push(line);
      waiting.shift()?.(line);
    }
  });
  child.stderr.setEncoding("utf8").on("data", (c: string) => (err += c));
  const exit = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  let id = 0;
  return {
    /** Write a request and wait for the next line of stdout, parsed. */
    request(method: string, params?: unknown): Promise<any> {
      const answer = new Promise<string>((resolve) => waiting.push(resolve));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params === undefined ? {} : { params }) }) + "\n");
      return answer.then((l) => JSON.parse(l));
    },
    /** `tools/call`, answered with the tool's result. */
    async tool(name: string, args?: Record<string, unknown>): Promise<any> {
      return (await this.request("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) })).result;
    },
    /** Write a raw line; nothing is awaited. */
    write: (line: string) => void child.stdin.write(line + "\n"),
    /** Close stdin and wait for the exit. */
    async end() {
      child.stdin.end();
      const code = await exit;
      return { code, stdout: out, stderr: err, lines };
    },
    kill: () => void child.kill(),
    exit,
  };
}
