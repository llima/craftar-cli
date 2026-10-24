import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registryFile } from "../src/core/registry.js";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, scenario } from "./helpers/forge.js";
import { TSX_LOADER } from "./helpers/tsx-loader.js";

// Spec 36 §4.1–§4.3, §4.6, §10.4 — the `ui` command: what it refuses before the bind, the three lines it
// prints once, and how it stops. Every run binds port 0.

const REPO = path.resolve(__dirname, "..");
const VERSION: string = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).version;
const HOME = () => process.env.CRAFTAR_HOME!;
const HINT = "  the address works for this run only, on this machine — Ctrl-C stops it";

interface Started {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  /** Resolves when stdout holds `n` newlines; rejects when the process ends first. */
  firstLines: (n: number) => Promise<string[]>;
  exit: Promise<number | null>;
}

const children: ChildProcess[] = [];
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  for (const c of cleanups.splice(0)) await c();
  await fs.rm(registryFile(HOME()), { force: true });
});

function startUiCli(args: string[], env: NodeJS.ProcessEnv = {}): Started {
  const child = spawn(process.execPath, ["--import", TSX_LOADER, path.join(REPO, "src/cli.ts"), "ui", ...args], {
    cwd: REPO,
    env: { ...process.env, ...env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  let err = "";
  const waiting: Array<() => void> = [];
  child.stdout!.setEncoding("utf8").on("data", (c: string) => {
    out += c;
    for (const w of waiting.splice(0)) w();
  });
  child.stderr!.setEncoding("utf8").on("data", (c: string) => (err += c));
  const exit = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  const firstLines = (n: number): Promise<string[]> =>
    new Promise((resolve, reject) => {
      const check = (): void => {
        const lines = out.split("\n");
        if (lines.length > n) resolve(lines.slice(0, n));
        else waiting.push(check);
      };
      void exit.then((code) => reject(new Error(`craftar ui ended (${code}) before printing ${n} lines: ${JSON.stringify(out)} ${JSON.stringify(err)}`)));
      check();
    });
  return { child, stdout: () => out, stderr: () => err, firstLines, exit };
}

interface Answer {
  status: number;
  type: string;
  body: string;
}

function request(port: number, target: string, opts: { token?: string; method?: string; agent?: http.Agent } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: target, method: opts.method ?? "GET", agent: opts.agent, headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {} },
      (res) => {
        let body = "";
        res.setEncoding("utf8").on("data", (c: string) => (body += c)).on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const OPEN = /^  open  http:\/\/127\.0\.0\.1:(\d+)\/#([A-Za-z0-9_-]{43})$/;

describe("craftar ui — refused before the bind (spec 36 §4.2)", () => {
  it("1. --port takes a whole number from 0 to 65535, in digits", () => {
    for (const v of ["abc", "-1", "70000", "0x10", "1e3", "80.0", "+80"])
      expect(runCli(["ui", `--port=${v}`]), v).toEqual({ code: 1, stdout: "", stderr: "error: --port takes a whole number from 0 to 65535\n" });
  });

  it("2. the registry is off", () => {
    expect(runCli(["ui", "--port", "0"], { env: { CRAFTAR_NO_REGISTRY: "1" } })).toEqual({
      code: 1,
      stdout: "",
      stderr: "error: the workspace registry is off (CRAFTAR_NO_REGISTRY is set)\n",
    });
  });

  it("3. a registry that is not JSON: its file is named, nothing of it is quoted", async () => {
    await fs.mkdir(HOME(), { recursive: true });
    await fs.writeFile(registryFile(HOME()), "{ SENTINEL-REG");
    expect(runCli(["ui", "--port", "0"])).toEqual({ code: 1, stdout: "", stderr: `error: cannot read ${registryFile(HOME())}: not valid JSON\n` });
  });

  it("4. a registry of a later schema", async () => {
    await fs.mkdir(HOME(), { recursive: true });
    await fs.writeFile(registryFile(HOME()), '{"schema": 99, "workspaces": []}');
    expect(runCli(["ui", "--port", "0"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "error: registry.json declares schema 99, which this craftar does not read — upgrade craftar\n",
    });
  });

  it("5. a taken port: one line, and no address on stdout", async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => taken.close(resolve)));
    const p = (taken.address() as net.AddressInfo).port;
    expect(runCli(["ui", "--port", String(p)])).toEqual({
      code: 1,
      stdout: "",
      stderr: `error: port ${p} is in use on 127.0.0.1 — pass --port <other>, or --port 0 for a free one\n`,
    });
  });
});

describe("craftar ui — started (spec 36 §4.3, §4.6)", () => {
  it("6. --port 0, an empty registry: the three lines, data behind the token, the page without it", async () => {
    const ui = startUiCli(["--port", "0"]);
    const lines = await ui.firstLines(3);
    expect(lines[0]).toBe(`craftar ui — craftar ${VERSION} · read-only · 0 registered`);
    expect(lines[1]).toMatch(OPEN);
    expect(lines[2]).toBe(HINT);
    const [, port, token] = OPEN.exec(lines[1])!;
    const data = await request(Number(port), "/api/workspaces", { token });
    expect(data.status).toBe(200);
    expect(JSON.parse(data.body)).toEqual({ version: VERSION, registry: registryFile(HOME()), fetch: false, writes: false, workspaces: [], warnings: [] });
    expect((await request(Number(port), "/api/workspaces")).status).toBe(403);
    const page = await request(Number(port), "/");
    expect([page.status, page.type]).toEqual([200, "text/html; charset=utf-8"]);
  });

  it.skipIf(process.platform === "win32")("6b. SIGTERM with a keep-alive connection open: `stopped`, exit 0, nothing on stderr, the token printed once", async () => {
    const ui = startUiCli(["--port", "0"]);
    const lines = await ui.firstLines(3);
    const [, port, token] = OPEN.exec(lines[1])!;
    const agent = new http.Agent({ keepAlive: true });
    cleanups.push(async () => agent.destroy());
    expect((await request(Number(port), "/api/workspaces", { token, agent })).status).toBe(200);
    ui.child.kill("SIGTERM");
    expect(await ui.exit).toBe(0);
    expect(ui.stdout().endsWith("stopped\n")).toBe(true);
    expect(ui.stderr()).toBe("");
    expect(ui.stdout().split(token).length - 1).toBe(1);
  });

  it("7 and 8. a registered workspace is counted and listed; nothing is printed per request", async () => {
    const s = await scenario(
      { ingredients: [rule("keep", "# Keep\n")], recipes: [recipe("base", ["rule/keep"])], profiles: [profile("acme", ["base"])] },
      { config: { profile: "acme" } },
    );
    cleanups.push(s.cleanup);
    expect(runCli(["sync", "--workspace", s.wsRoot]).code).toBe(0);
    const ui = startUiCli(["--port", "0"]);
    const lines = await ui.firstLines(3);
    expect(lines[0]).toBe(`craftar ui — craftar ${VERSION} · read-only · 1 registered`);
    const [, portText, token] = OPEN.exec(lines[1])!;
    const port = Number(portText);
    const table = await request(port, "/api/workspaces", { token });
    expect(table.status).toBe(200);
    expect(JSON.parse(table.body).workspaces.map((w: { status: string }) => w.status)).toEqual(["up-to-date"]);
    const statuses = [
      (await request(port, "/", {})).status,
      (await request(port, "/api/workspaces")).status,
      (await request(port, "/nowhere", { token })).status,
      (await request(port, "/api/workspaces", { token, method: "POST" })).status,
    ];
    expect(statuses).toEqual([200, 403, 404, 405]);
    expect(ui.stdout()).toBe(`${lines.join("\n")}\n`);
    expect(ui.stderr()).toBe("");
  });

  it("10. --help: the port, the description, and none of the options the spec refuses", () => {
    const help = runCli(["ui", "--help"]).stdout;
    expect(help).toContain("--port <n>");
    expect(help.replace(/\s+/g, " ")).toContain(
      "A local dashboard: the table of `craftar workspaces` and, for one workspace, its file states, a file's diff and explanation, and its Forge's recipes and ingredients — in a browser, on 127.0.0.1 only, behind an address that works for this run. Reads only — writes no workspace, lock, registry or Forge — and reaches no network; Ctrl-C stops it",
    );
    for (const refused of ["--host", "--fetch", "--open", "--json", "--workspace"]) expect(help, refused).not.toContain(refused);
  });
});
