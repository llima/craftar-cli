// Spec 40 §6.1, §12.5: what craftar ui serves without --allow-writes, pinned BEFORE the writing half lands.
// Every test here is a control: it passes on 2f8af6b and must pass unchanged after Part C.

import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { PAGE_HTML, PAGE_JS, PAGE_CSS } from "../src/ui/page.js";
import { startUi, type UiServer } from "../src/ui/server.js";
import { eightStates, mcpWorkspace, MCP_FILES, syncOnce, type Scenario } from "./helpers/states.js";
import { HOME, get, syncRegistered } from "./helpers/ui.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { register, registryFile } from "../src/core/registry.js";
import { workspaceId } from "../src/ui/routes.js";
import { recipe } from "./helpers/forge.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await fs.rm(registryFile(HOME()), { force: true });
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends { cleanup: () => Promise<unknown> }>(s: T): T => (cleanups.push(s.cleanup), s);

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** eightStates(), registered as the first sync left it. */
async function eight() {
  const s = kept(await eightStates());
  const ws = await loadWorkspace(s.wsRoot, { home: HOME() });
  const entry = await register(HOME(), ws, await plan(ws));
  return { s, id: workspaceId(entry.path), real: entry.path };
}

/** Normalise a JSON body: replace real paths with <ROOT>, id with <ID>, registry path with <REG>, ISO times with <T>, forge key with <KEY>. */
function norm(body: unknown, roots: { wsRoot: string; real: string; id: string }): unknown {
  let json = JSON.stringify(body);
  const escape = (s: string) => s.replace(/[\\]/g, "\\\\").replace(/[.*+?^${}()|[\]]/g, "\\$&");
  json = json.replace(new RegExp(escape(roots.real), "g"), "<ROOT>");
  json = json.replace(new RegExp(escape(roots.wsRoot), "g"), "<ROOT>");
  json = json.replace(new RegExp(escape(registryFile(HOME())), "g"), "<REG>");
  json = json.replace(new RegExp(roots.id, "g"), "<ID>");
  json = json.replace(/"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z"/g, '"<T>"');
  // Windows-safe: the key is a native path, so in JSON it ends /forge (POSIX) or \\forge (win32)
  json = json.replace(/"key":"[^"]+(?:\/|\\\\)forge"/g, '"key":"<KEY>"');
  return JSON.parse(json);
}

describe("page constants by hash", () => {
  it("PAGE_HTML, PAGE_JS, PAGE_CSS have the expected sha256 and length", () => {
    expect(sha256(PAGE_HTML)).toBe("7ca17d7e9ff81e39b9184f6b3a2c7d1c4f42302410a74fdea865663459134de8");
    expect(PAGE_HTML.length).toBe(281);
    expect(sha256(PAGE_JS)).toBe("c6b89b4a9bea59c236b33a6c728b95713a3e1da854ffd045b5615a25e32ca8f4");
    expect(PAGE_JS.length).toBe(14734);
    expect(sha256(PAGE_CSS)).toBe("faf4ec748ec257d5365371438e2946e04502ae04a41e74cae3fd8be0de951360");
    expect(PAGE_CSS.length).toBe(2747);
  });
});

describe("non-GET is 405", () => {
  const TOKEN = "t".repeat(43);
  let ui: UiServer | undefined;
  afterEach(async () => { await ui?.close(); ui = undefined; });

  interface Answer { status: number; headers: http.IncomingHttpHeaders; body: string }
  function ask(u: UiServer, target: string, o: { method?: string; headers?: Record<string, string> } = {}): Promise<Answer> {
    const headers: Record<string, string> = { Host: `127.0.0.1:${u.port}`, Authorization: `Bearer ${TOKEN}`, ...o.headers };
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: u.port, path: target, method: o.method ?? "GET", headers, setHost: false, agent: false }, (res) => {
        let body = "";
        res.setEncoding("utf8").on("data", (c) => (body += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on("error", reject);
      if (o.method === "POST") req.write('{"digest":"x"}');
      req.end();
    });
  }

  it("POST, PUT, DELETE on /api/workspaces and POST on / return 405 with exact bytes", async () => {
    ui = await startUi({ home: HOME(), version: "0.0.0-test", port: 0, onError: () => {}, token: TOKEN, route: async () => ({ status: 200, body: { ok: true } }) });
    for (const [method, target] of [["POST", "/api/workspaces"], ["PUT", "/api/workspaces"], ["DELETE", "/api/workspaces"], ["POST", "/"]] as const) {
      const headers: Record<string, string> = { Origin: `http://127.0.0.1:${ui.port}`, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };
      const a = await ask(ui, target, { method, headers });
      expect(a.status).toBe(405);
      expect(a.headers.allow).toBe("GET");
      expect(a.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(a.body).toBe('{"error":"GET only"}');
    }
  });
});

describe("reading routes JSON", () => {
  it("GET /api/workspaces", async () => {
    const { s, id, real } = await eight();
    const answer = await get("/api/workspaces");
    expect(answer.status).toBe(200);
    expect(norm(answer.body, { wsRoot: s.wsRoot, real, id })).toEqual({"version":"0.0.0-test","registry":"<REG>","fetch":false,"writes":false,"workspaces":[{"id":"<ID>","name":"ws","path":"<ROOT>","profile":"acme","recipes":["base"],"stack":{},"targets":["claude-code"],"forge":{"kind":"path","source":"../forge","ref":null,"defaultBranch":null,"commit":null,"lockCommit":null,"fetched":false,"fromLocalFile":false,"key":"<KEY>"},"lastSync":"<T>","forgeMoved":null,"status":"drift","files":{"adopt":1,"collision":1,"drift":1,"new":1,"orphan":1,"orphan-drift":1,"unchanged":1,"update":1}}],"warnings":[]});
  });

  it("GET /api/workspaces/<id>", async () => {
    const { s, id, real } = await eight();
    const answer = await get(`/api/workspaces/${id}`);
    expect(answer.status).toBe(200);
    expect(norm(answer.body, { wsRoot: s.wsRoot, real, id })).toEqual({"id":"<ID>","path":"<ROOT>","profile":"acme","recipes":["base"],"targets":["claude-code"],"forge":{"kind":"path","source":"../forge","ref":null,"defaultBranch":null,"commit":null,"lockCommit":null,"fetched":false},"statuses":[{"path":".claude/rules/adopted.md","state":"adopt","target":"claude-code","ingredient":"rule/adopted"},{"path":".claude/rules/clash.md","state":"collision","target":"claude-code","ingredient":"rule/clash"},{"path":".claude/rules/edited.md","state":"drift","target":"claude-code","ingredient":"rule/edited","lock":{"path":".claude/rules/edited.md","hash":"sha256:cf4ab371ad9869241b6ee1942bcdf50611db7581d6b3e9c6847c6b0f003ee773","target":"claude-code","ingredient":"rule/edited"}},{"path":".claude/rules/fresh.md","state":"new","target":"claude-code","ingredient":"rule/fresh"},{"path":".claude/rules/gone-edited.md","state":"orphan-drift","target":"claude-code","ingredient":"rule/gone-edited","lock":{"path":".claude/rules/gone-edited.md","hash":"sha256:e97174db0e15246c338a6acdd2ca26d6ba371ee5553f8fb7136a1b98eb18b6c5","target":"claude-code","ingredient":"rule/gone-edited"}},{"path":".claude/rules/gone.md","state":"orphan","target":"claude-code","ingredient":"rule/gone","lock":{"path":".claude/rules/gone.md","hash":"sha256:179bbd94af11271d3a62e9aae6dd5527305d5950292f8639d66b30958cb8c48b","target":"claude-code","ingredient":"rule/gone"}},{"path":".claude/rules/keep.md","state":"unchanged","target":"claude-code","ingredient":"rule/keep","lock":{"path":".claude/rules/keep.md","hash":"sha256:9a75bf85a4bb172834fe5d5b052612c0dedc2859adda6afbbbeb76005c6c1195","target":"claude-code","ingredient":"rule/keep"}},{"path":".claude/rules/moved.md","state":"update","target":"claude-code","ingredient":"rule/moved","lock":{"path":".claude/rules/moved.md","hash":"sha256:69b6bbadb67faf0860df534ac0799a6d129c6041bdafe44efdaedee0c3babe4a","target":"claude-code","ingredient":"rule/moved"}}],"warnings":[],"unsetParams":[],"refused":null});
  });

  it("GET /api/workspaces/<id>/diff for drift, orphan-drift, update rows", async () => {
    const { s, id, real } = await eight();
    const R = ".claude/rules";
    expect(norm((await get(`/api/workspaces/${id}/diff?path=${encodeURIComponent(`${R}/edited.md`)}`)).body, { wsRoot: s.wsRoot, real, id })).toEqual({"path":".claude/rules/edited.md","state":"drift","from":".claude/rules/edited.md (disk, drift)","to":".claude/rules/edited.md (forge)","hidden":false,"note":null,"diff":"  # Edited\n- by hand\n+ by the forge"});
    expect(norm((await get(`/api/workspaces/${id}/diff?path=${encodeURIComponent(`${R}/gone-edited.md`)}`)).body, { wsRoot: s.wsRoot, real, id })).toEqual({"path":".claude/rules/gone-edited.md","state":"orphan-drift","from":".claude/rules/gone-edited.md (disk, orphan-drift)","to":null,"hidden":false,"note":"no longer produced by the Forge but hand-edited — kept; `craftar drift discard <path>` removes it, or delete it yourself","diff":null});
    expect(norm((await get(`/api/workspaces/${id}/diff?path=${encodeURIComponent(`${R}/moved.md`)}`)).body, { wsRoot: s.wsRoot, real, id })).toEqual({"path":".claude/rules/moved.md","state":"update","from":".claude/rules/moved.md (disk, update)","to":".claude/rules/moved.md (forge)","hidden":false,"note":null,"diff":"  # Moved\n- old line\n+ new line"});
  });

  it("GET /api/workspaces/<id>/explain for a planned path", async () => {
    const { s, id, real } = await eight();
    expect(norm((await get(`/api/workspaces/${id}/explain?path=${encodeURIComponent(".claude/rules/keep.md")}`)).body, { wsRoot: s.wsRoot, real, id })).toEqual({"path":".claude/rules/keep.md","target":"claude-code","ingredient":"rule/keep","origin":null,"via":["base"],"sections":[],"params":[],"profile":"acme","recipes":["base"],"hash":"sha256:9a75bf85a4bb172834fe5d5b052612c0dedc2859adda6afbbbeb76005c6c1195"});
  });
});

describe("orphan-drift example settings file", () => {
  it("diff route for orphan-drift .claude/settings.craftar.example.json", async () => {
    const EX = MCP_FILES[2];
    const s = kept(await mcpWorkspace());
    await syncOnce(s.wsRoot);
    await fs.writeFile(path.join(s.forgeRoot, "recipes/base.yaml"), YAML.stringify(recipe("base", ["rule/keep"])));
    await fs.appendFile(path.join(s.wsRoot, EX), "\n");
    const ws = await loadWorkspace(s.wsRoot, { home: HOME() });
    const entry = await register(HOME(), ws, await plan(ws));
    const id = workspaceId(entry.path);
    expect(norm((await get(`/api/workspaces/${id}/diff?path=${encodeURIComponent(EX)}`)).body, { wsRoot: s.wsRoot, real: entry.path, id })).toEqual({"path":".claude/settings.craftar.example.json","state":"orphan-drift","from":".claude/settings.craftar.example.json (disk, orphan-drift)","to":null,"hidden":false,"note":"no longer produced by the Forge but hand-edited — kept; `craftar drift discard <path>` removes it, or delete it yourself","diff":null});
  });
});
