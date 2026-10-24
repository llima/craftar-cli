import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { CSP, hostAllowed, MAX_BODY_BYTES, MAX_DRAIN_BYTES, originAllowed, siteAllowed, startUi, type UiOptions, type UiServer } from "../src/ui/server.js";

// Spec 36 §7.2, §7.4, §7.5, §10.3 — the checks every request passes, on a real loopback socket (port 0).

const TOKEN = "t".repeat(43);
const errors: string[] = [];
let ui: UiServer | undefined;
afterEach(async () => {
  await ui?.close();
  ui = undefined;
  errors.length = 0;
});
const OK = { status: 200 as const, body: { ok: true } };
async function start(over: Partial<UiOptions> = {}) {
  ui = await startUi({ home: process.env.CRAFTAR_HOME!, version: "0.0.0-test", port: 0, onError: (l) => errors.push(l), token: TOKEN, route: async () => OK, ...over });
  return ui;
}
interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}
/** One request with exactly the headers given (fetch cannot forge Host or Origin). `host: null` sends none. */
function ask(u: UiServer, target: string, o: { method?: string; headers?: Record<string, string>; host?: string | null; auth?: boolean } = {}): Promise<Answer> {
  const headers: Record<string, string> = { ...(o.host === null ? {} : { Host: o.host ?? `127.0.0.1:${u.port}` }), ...(o.auth === false ? {} : { Authorization: `Bearer ${TOKEN}` }), ...o.headers };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: u.port, path: target, method: o.method ?? "GET", headers, setHost: false, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (c) => (body += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}
const FORBIDDEN = '{"error":"forbidden"}';
const DATA = "/api/workspaces";
const EVERY = ["/", "/app.js", "/app.css", DATA];

describe("the pure checks", () => {
  it("Host: exactly 127.0.0.1:<port>; the bare form for port 80 only; never localhost", () => {
    expect(hostAllowed("127.0.0.1:4747", 4747)).toBe(true);
    for (const h of [undefined, "", "127.0.0.1", "127.0.0.1:4748", "localhost:4747", "LOCALHOST:4747", "[::1]:4747", "evil.example.com", "evil.example.com:4747", "127.0.0.1:4747.evil.example.com", " 127.0.0.1:4747", "127.0.0.1:04747"]) expect(hostAllowed(h, 4747), String(h)).toBe(false);
    expect([hostAllowed("127.0.0.1", 80), hostAllowed("127.0.0.1:80", 80), hostAllowed("localhost", 80), hostAllowed("127.0.0.1:8080", 80)]).toEqual([true, true, false, false]);
  });

  it("Origin: absent, or exactly http://127.0.0.1:<port>; null is refused", () => {
    expect([originAllowed(undefined, 4747), originAllowed("http://127.0.0.1:4747", 4747)]).toEqual([true, true]);
    for (const o of ["null", "", "http://localhost:4747", "https://127.0.0.1:4747", "http://127.0.0.1", "http://127.0.0.1:4748", "http://evil.example.com", "http://127.0.0.1:4747/"]) expect(originAllowed(o, 4747), o).toBe(false);
    expect([originAllowed("http://127.0.0.1", 80), originAllowed("http://127.0.0.1:80", 80)]).toEqual([true, true]);
  });

  it("Sec-Fetch-Site: absent, same-origin or none", () => {
    expect([undefined, "same-origin", "none"].map(siteAllowed)).toEqual([true, true, true]);
    expect(["cross-site", "same-site", "", "NONE", "acme"].map(siteAllowed)).toEqual([false, false, false, false, false]);
  });
});

describe("the socket and the token", () => {
  it("binds 127.0.0.1, IPv4, and says the port it got; the URL carries the token in the fragment only", async () => {
    const u = await start();
    expect([u.address.address, u.address.family, u.address.port]).toEqual(["127.0.0.1", "IPv4", u.port]);
    expect(u.port).toBeGreaterThan(0);
    expect(u.url).toBe(`http://127.0.0.1:${u.port}/#${TOKEN}`);
  });

  it("a generated token is 43 base64url characters and differs between runs", async () => {
    const a = await startUi({ home: process.env.CRAFTAR_HOME!, version: "0", port: 0, onError: () => {} });
    const b = await startUi({ home: process.env.CRAFTAR_HOME!, version: "0", port: 0, onError: () => {} });
    try {
      const [ta, tb] = [a.url.split("#")[1], b.url.split("#")[1]];
      expect(ta).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(ta).not.toBe(tb);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("a taken port rejects with EADDRINUSE and gives no server", async () => {
    const u = await start();
    await expect(startUi({ home: "", version: "0", port: u.port, onError: () => {} })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("a data route needs the token, in the Authorization header only", async () => {
    const u = await start();
    expect(await ask(u, DATA)).toMatchObject({ status: 200, body: '{"ok":true}' });
    const no = async (o: Parameters<typeof ask>[2], target = DATA) => {
      const a = await ask(u, target, o);
      expect([a.status, a.body], JSON.stringify([target, o])).toEqual([403, FORBIDDEN]);
    };
    await no({ auth: false });
    await no({ auth: false, headers: { Authorization: `Bearer ${"x".repeat(43)}` } }); // wrong, same length
    await no({ auth: false, headers: { Authorization: `Bearer ${TOKEN}x` } }); // wrong length
    await no({ auth: false, headers: { Authorization: `Bearer ${TOKEN.slice(1)}` } });
    await no({ auth: false, headers: { Authorization: TOKEN } }); // no scheme
    await no({ auth: false, headers: { Authorization: `bearer ${TOKEN}` } });
    await no({ auth: false, headers: { Authorization: `Basic ${TOKEN}` } });
    await no({ auth: false }, `${DATA}?token=${TOKEN}`);
    await no({ auth: false, headers: { Cookie: `token=${TOKEN}` } });
    await no({ auth: false, headers: { "X-Token": TOKEN } });
  });

  it("the static routes need no token, and carry nothing of this machine", async () => {
    const u = await start();
    const page = await ask(u, "/", { auth: false });
    expect([page.status, page.headers["content-type"], page.headers["content-security-policy"]]).toEqual([200, "text/html; charset=utf-8", CSP]);
    expect((await ask(u, "/app.js", { auth: false })).headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect((await ask(u, "/app.css", { auth: false })).headers["content-type"]).toBe("text/css; charset=utf-8");
    for (const t of ["/", "/app.js", "/app.css"]) {
      const a = await ask(u, t, { auth: false });
      expect(a.status).toBe(200);
      expect(a.body).not.toContain(TOKEN);
      expect(a.body).not.toContain(process.env.CRAFTAR_HOME!);
    }
  });
});

describe("Host, Origin and Sec-Fetch-Site, on every route, with the right token", () => {
  it("a foreign Host is 403 everywhere", async () => {
    const u = await start();
    for (const host of ["evil.example.com", `evil.example.com:${u.port}`, `127.0.0.1:${u.port + 1}`, `localhost:${u.port}`, "127.0.0.1"])
      for (const t of EVERY) {
        const a = await ask(u, t, { host });
        expect([a.status, a.body], `${host} ${t}`).toEqual([403, FORBIDDEN]);
      }
  });

  it("no Host: 403 over HTTP/1.0, and no data over HTTP/1.1 (the status is Node's own)", async () => {
    const u = await start();
    const raw = (text: string) =>
      new Promise<string>((resolve) => {
        const s = net.connect(u.port, "127.0.0.1", () => s.write(text));
        let out = "";
        s.setEncoding("utf8").on("data", (c) => (out += c)).on("close", () => resolve(out));
      });
    const old = await raw(`GET ${DATA} HTTP/1.0\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`);
    expect(old.split("\r\n")[0]).toMatch(/ 403 /);
    expect(old).toContain(FORBIDDEN);
    const modern = await raw(`GET ${DATA} HTTP/1.1\r\nAuthorization: Bearer ${TOKEN}\r\nConnection: close\r\n\r\n`);
    expect(modern.split("\r\n")[0]).toBe("HTTP/1.1 400 Bad Request"); // Node's own answer, measured on 20, 22 and 24
    expect(modern).not.toContain('{"ok":true}');
  });

  it("a foreign Origin, Origin: null, and a cross-site or same-site fetch are 403 everywhere; our own origin and none pass", async () => {
    const u = await start();
    const own = `http://127.0.0.1:${u.port}`;
    for (const headers of [{ Origin: "http://evil.example.com" }, { Origin: `http://localhost:${u.port}` }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, { "Sec-Fetch-Site": "acme" }, { Origin: own, "Sec-Fetch-Site": "cross-site" }])
      for (const t of EVERY) {
        const a = await ask(u, t, { headers });
        expect([a.status, a.body], `${JSON.stringify(headers)} ${t}`).toEqual([403, FORBIDDEN]);
      }
    for (const headers of [{ Origin: own }, { "Sec-Fetch-Site": "same-origin" }, { "Sec-Fetch-Site": "none" }, { Origin: own, "Sec-Fetch-Site": "same-origin" }])
      for (const t of EVERY) expect((await ask(u, t, { headers })).status, `${JSON.stringify(headers)} ${t}`).toBe(200);
  });
});

describe("methods, length, headers, unknown paths", () => {
  it("anything but GET is 405 with Allow: GET, before the Host check; no answer carries a CORS header", async () => {
    const u = await start();
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH", "HEAD"]) {
      const a = await ask(u, DATA, { method, host: "evil.example.com", headers: { Origin: "http://evil.example.com", "Access-Control-Request-Method": "GET" } });
      expect([a.status, a.headers.allow], method).toEqual([405, "GET"]);
      if (method !== "HEAD") expect(a.body).toBe('{"error":"GET only"}');
      expect(Object.keys(a.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    }
    for (const t of EVERY) expect(Object.keys((await ask(u, t, { headers: { Origin: `http://127.0.0.1:${u.port}` } })).headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
  });

  it("a target over 2048 bytes is 414; exactly 2048 passes the check", async () => {
    const u = await start();
    const at = (n: number) => `${DATA}?${"x".repeat(n - DATA.length - 1)}`;
    expect(at(2048)).toHaveLength(2048);
    expect((await ask(u, at(2048))).status).toBe(200);
    expect(await ask(u, at(2049))).toMatchObject({ status: 414, body: '{"error":"request too long"}' });
  });

  it("an unknown path is 404 without asking for the token; /favicon.ico too", async () => {
    const u = await start();
    for (const t of ["/favicon.ico", "/api", "/api/nope", "/index.html", "/app.js/", "//", "/api/workspaces/SENTINEL"]) {
      const a = await ask(u, t, { auth: false });
      expect([a.status, a.body], t).toEqual([404, '{"error":"not found"}']);
    }
  });

  it("every answer the handler writes carries no-store, nosniff and no-referrer; the CSP is on / only", async () => {
    const u = await start();
    const answers = [await ask(u, "/"), await ask(u, "/app.js"), await ask(u, DATA), await ask(u, DATA, { auth: false }), await ask(u, "/nope"), await ask(u, DATA, { method: "POST" }), await ask(u, "/", { host: "evil.example.com" })];
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 403, 404, 405, 403]);
    for (const a of answers) expect([a.headers["cache-control"], a.headers["x-content-type-options"], a.headers["referrer-policy"]]).toEqual(["no-store", "nosniff", "no-referrer"]);
    expect(answers.map((a) => a.headers["content-security-policy"] !== undefined)).toEqual([true, false, false, false, false, false, false]);
    expect(CSP).toBe("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    expect((await ask(u, DATA)).headers["content-type"]).toBe("application/json; charset=utf-8");
  });
});

describe("the route seam", () => {
  it("the route gets the path and the raw query, and its answer is served as JSON", async () => {
    const seen: unknown[] = [];
    const u = await start({ route: async (req, deps) => (seen.push([req, deps.version]), { status: 409, body: { error: "x", warnings: [] } }) });
    const a = await ask(u, "/api/workspaces/0123456789abcdef/diff?path=a%2Fb&path=c");
    expect([a.status, a.body]).toEqual([409, '{"error":"x","warnings":[]}']);
    expect(seen).toEqual([[{ path: "/api/workspaces/0123456789abcdef/diff", query: "path=a%2Fb&path=c", method: "GET" }, "0.0.0-test"]]);
  });

  it("a route that throws is 500 `internal error`; the message goes to onError once, with the pattern and nothing of the request", async () => {
    const u = await start({ route: async () => { throw new Error("SENTINEL-CAUSE first line\nSENTINEL-SECOND"); } });
    const a = await ask(u, "/api/workspaces/0123456789abcdef/diff?path=SENTINEL-QUERY", { headers: { "X-Acme": "SENTINEL-HEADER" } });
    expect([a.status, a.body]).toEqual([500, '{"error":"internal error"}']);
    expect(errors).toEqual(["ui: /api/workspaces/<id>/diff: SENTINEL-CAUSE first line"]);
    // the server stays up
    expect((await ask(u, "/")).status).toBe(200);
  });

  it("a failure while answering a failure closes that connection, and the queue goes on", async () => {
    let calls = 0;
    const u = await start({
      route: async () => { if (++calls === 1) throw new Error("route throws"); return OK; },
      onError: () => { throw new Error("the terminal is gone"); },
    });
    const url = `http://127.0.0.1:${u.port}${DATA}`;
    const headers = { Authorization: `Bearer ${TOKEN}` };
    await expect(fetch(url, { headers, signal: AbortSignal.timeout(3000) })).rejects.not.toMatchObject({ name: "TimeoutError" });
    expect((await ask(u, DATA)).status).toBe(200);
  });

  it("one at a time: a second data request starts after the first ended", async () => {
    const events: string[] = [];
    let n = 0;
    const u = await start({
      route: async () => {
        const mine = ++n;
        events.push(`start ${mine}`);
        await new Promise((r) => setTimeout(r, mine === 1 ? 80 : 0));
        events.push(`end ${mine}`);
        return OK;
      },
    });
    const [a, b] = await Promise.all([ask(u, DATA), new Promise<Answer>((r) => setTimeout(() => r(ask(u, DATA)), 15))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(events).toEqual(["start 1", "end 1", "start 2", "end 2"]);
  });

  it("close() resolves with a keep-alive connection open and a route still running, and the listener is gone", async () => {
    let release = () => {};
    const u = await start({ route: () => new Promise((r) => (release = () => r(OK))) });
    const agent = new http.Agent({ keepAlive: true });
    await new Promise<void>((resolve) => http.get({ host: "127.0.0.1", port: u.port, path: "/", headers: { Host: `127.0.0.1:${u.port}` }, setHost: false, agent }, (res) => res.resume().on("end", resolve)));
    const hanging = ask(u, DATA).catch((e: NodeJS.ErrnoException) => e.code);
    await new Promise((r) => setTimeout(r, 30));
    await u.close();
    ui = undefined;
    expect(await hanging).toBe("ECONNRESET");
    release();
    agent.destroy();
    await expect(new Promise((resolve, reject) => net.connect(u.port, "127.0.0.1").on("connect", resolve).on("error", (e: NodeJS.ErrnoException) => reject(e.code)))).rejects.toBe("ECONNREFUSED");
  });

  it("the token is in no answer body or header of any route, and in no onError line", async () => {
    const u = await start({ route: async (req) => { if (req.path.endsWith("explain")) throw new Error("boom"); return OK; } });
    const all = [await ask(u, "/"), await ask(u, "/app.js"), await ask(u, "/app.css"), await ask(u, DATA), await ask(u, "/api/workspaces/0123456789abcdef/explain?path=x"), await ask(u, DATA, { auth: false }), await ask(u, "/nope"), await ask(u, DATA, { method: "POST" })];
    for (const a of all) expect(JSON.stringify([a.body, a.headers])).not.toContain(TOKEN);
    expect(errors.join("\n")).not.toContain(TOKEN);
    expect(errors).toHaveLength(1);
  });
});

describe("one importer", () => {
  it("no file under src/ but src/ui/server.ts imports node:http, node:https, node:http2 or node:net", () => {
    const SRC = path.resolve(__dirname, "../src");
    const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\\/g, "/"));
    const hits = files.filter((f) => /from\s+"(node:)?(http|https|http2|net)"|import\(\s*"(node:)?(http|https|http2|net)"\s*\)|require\(\s*"(node:)?(http|https|http2|net)"\s*\)/.test(readFileSync(path.join(SRC, f), "utf8")));
    expect(hits).toEqual(["ui/server.ts"]);
  });
});

describe("review: a header given twice, and what close() leaves behind", () => {
  const raw = (port: number, text: string) =>
    new Promise<string>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write(text));
      let out = "";
      s.setEncoding("utf8").on("data", (c) => (out += c)).on("close", () => resolve(out));
    });

  it("Host, Origin, Sec-Fetch-Site or Authorization given twice is 403, whichever value comes first", async () => {
    const u = await start();
    const good = { Host: `127.0.0.1:${u.port}`, Authorization: `Bearer ${TOKEN}` };
    const twice: Array<[string, string, string]> = [
      ["Host", good.Host, "evil.example.com"],
      ["Authorization", good.Authorization, "Bearer wrong"],
      ["Origin", `http://127.0.0.1:${u.port}`, "http://evil.example.com"],
      ["Sec-Fetch-Site", "same-origin", "cross-site"],
    ];
    for (const [name, right, wrong] of twice)
      for (const pair of [[right, wrong], [wrong, right]]) {
        const headers = Object.entries({ ...good, [name]: undefined })
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join("");
        const answer = await raw(u.port, `GET ${DATA} HTTP/1.1\r\n${headers}${name}: ${pair[0]}\r\n${name}: ${pair[1]}\r\nConnection: close\r\n\r\n`);
        expect(answer.split("\r\n")[0], `${name}: ${pair[0] === right ? "right first" : "wrong first"}`).toBe("HTTP/1.1 403 Forbidden");
        expect(answer).toContain(FORBIDDEN);
      }
    // (control) each header once: data
    expect((await raw(u.port, `GET ${DATA} HTTP/1.1\r\nHost: ${good.Host}\r\nAuthorization: ${good.Authorization}\r\nConnection: close\r\n\r\n`)).split("\r\n")[0]).toBe("HTTP/1.1 200 OK");
  });

  it("a data request still queued when close() is called never reaches the route", async () => {
    let started = 0;
    let release: () => void = () => {};
    const first = new Promise<void>((resolve) => (release = resolve));
    const u = await start({
      route: async () => {
        started++;
        await first;
        return OK;
      },
    });
    const asked = [1, 2, 3].map(() => ask(u, DATA).catch(() => null));
    while (started === 0) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 50)); // the two others are accepted and queued
    await u.close();
    release();
    await Promise.all(asked);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toBe(1);
  });
});

// Spec 40 §6.3 — POST under --allow-writes
describe("--allow-writes (spec 40 §6.3)", () => {
  const SYNC_PATH = "/api/workspaces/0123456789abcdef/sync";
  const DISCARD_PATH = "/api/workspaces/0123456789abcdef/discard";
  const DIFF_PATH = "/api/workspaces/0123456789abcdef/diff?path=x";
  const VALID_DIGEST = "a".repeat(64);
  const VALID_SYNC_BODY = JSON.stringify({ digest: VALID_DIGEST });
  const VALID_DISCARD_BODY = JSON.stringify({ digest: VALID_DIGEST, path: ".claude/rules/x.md" });

  interface RecordedRequest {
    path: string;
    query: string;
    method: string;
    body?: { digest: string; path?: string };
    startedAt: number;
    endedAt?: number;
  }
  const calls: RecordedRequest[] = [];

  async function startWithWrites(routeDelay = 0, over: Partial<UiOptions> = {}) {
    calls.length = 0;
    return start({
      allowWrites: true,
      route: async (req) => {
        const rec: RecordedRequest = { path: req.path, query: req.query, method: req.method ?? "GET", body: req.body, startedAt: Date.now() };
        calls.push(rec);
        if (routeDelay > 0) await new Promise((r) => setTimeout(r, routeDelay));
        rec.endedAt = Date.now();
        return { status: 200, body: { ok: true } };
      },
      ...over,
    });
  }

  /** Send a POST request with the given body and headers. */
  function postAsk(
    u: UiServer,
    target: string,
    body: string,
    o: { headers?: Record<string, string>; host?: string | null; auth?: boolean; origin?: string | null; site?: string | null; contentType?: string | null } = {}
  ): Promise<Answer> {
    const headers: Record<string, string> = {
      ...(o.host === null ? {} : { Host: o.host ?? `127.0.0.1:${u.port}` }),
      ...(o.auth === false ? {} : { Authorization: `Bearer ${TOKEN}` }),
      ...(o.origin === null ? {} : { Origin: o.origin ?? `http://127.0.0.1:${u.port}` }),
      ...(o.site === null ? {} : { "Sec-Fetch-Site": o.site ?? "same-origin" }),
      ...(o.contentType === null ? {} : { "Content-Type": o.contentType ?? "application/json" }),
      ...o.headers,
    };
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: u.port, path: target, method: "POST", headers, setHost: false, agent: false }, (res) => {
        let bodyData = "";
        res.setEncoding("utf8").on("data", (c) => (bodyData += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: bodyData }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  // Case 1: Without the flag, a valid-looking POST to /sync → 405, and GET to /sync without token → 404
  it("without the flag, POST to /sync → 405 GET only, GET to /sync without token → 404", async () => {
    const u = await start(); // no allowWrites
    // POST should return 405 with today's body
    const postAnswer = await postAsk(u, SYNC_PATH, VALID_SYNC_BODY);
    expect([postAnswer.status, postAnswer.headers.allow, postAnswer.body]).toEqual([405, "GET", '{"error":"GET only"}']);
    // GET to /sync without token → 404 (write pattern treated as null, so 404 before token check)
    const getAnswer = await ask(u, SYNC_PATH, { auth: false });
    expect([getAnswer.status, getAnswer.body]).toEqual([404, '{"error":"not found"}']);
  });

  // Case 2: With the flag, the valid POST reaches the route once with method: "POST" and body { digest }
  it("valid POST reaches the route once with method POST and body", async () => {
    const u = await startWithWrites();
    const a = await postAsk(u, SYNC_PATH, VALID_SYNC_BODY);
    expect(a.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ digest: VALID_DIGEST });
  });

  // Case 3: POST without Origin, with foreign Origin, with Origin: null, without Sec-Fetch-Site, with same-site, with none → each 403
  it("POST without Origin, foreign Origin, null, or wrong Sec-Fetch-Site → 403, same as plain 403", async () => {
    const u = await startWithWrites();
    // Get a reference 403 body and headers (GET without token)
    const ref403 = await ask(u, DATA, { auth: false });
    expect(ref403.status).toBe(403);

    const cases: Array<{ origin?: string | null; site?: string | null; label: string }> = [
      { origin: null, label: "no Origin" },
      { origin: "http://evil.example", label: "foreign Origin" },
      { origin: "null", label: "Origin: null" },
      { site: null, label: "no Sec-Fetch-Site" },
      { site: "same-site", label: "Sec-Fetch-Site: same-site" },
      { site: "none", label: "Sec-Fetch-Site: none" },
    ];

    for (const c of cases) {
      const a = await postAsk(u, SYNC_PATH, VALID_SYNC_BODY, { origin: c.origin, site: c.site });
      expect([a.status, a.body], c.label).toEqual([ref403.status, ref403.body]);
      // Also check specific headers match
      expect(a.headers["content-type"], c.label).toBe(ref403.headers["content-type"]);
    }
    expect(calls).toHaveLength(0);
  });

  // Case 4: Content-Type text/plain → 415; application/json; charset=utf-8 → reaches route
  it("Content-Type text/plain → 415; application/json; charset=utf-8 → reaches route", async () => {
    const u = await startWithWrites();
    const textPlain = await postAsk(u, SYNC_PATH, VALID_SYNC_BODY, { contentType: "text/plain" });
    expect([textPlain.status, textPlain.body]).toEqual([415, '{"error":"Content-Type must be application/json"}']);
    expect(calls).toHaveLength(0);

    const withCharset = await postAsk(u, SYNC_PATH, VALID_SYNC_BODY, { contentType: "application/json; charset=utf-8" });
    expect(withCharset.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  // Case 5: Body of 4097 bytes → 413; exactly 4096 bytes → reaches parsing (400 or route); Content-Length lies
  it("body over 4096 bytes → 413 with body received by client; exactly 4096 → parsing; Content-Length lie → never accepted", async () => {
    const u = await startWithWrites();

    // 4097 bytes in one write → client receives 413 and body
    const big1 = JSON.stringify({ digest: VALID_DIGEST }) + " ".repeat(4097 - JSON.stringify({ digest: VALID_DIGEST }).length);
    expect(Buffer.byteLength(big1)).toBe(4097);
    const big1Ans = await postAsk(u, SYNC_PATH, big1);
    expect([big1Ans.status, big1Ans.body]).toEqual([413, '{"error":"body too large"}']);
    expect(calls).toHaveLength(0);

    // 64 KiB in 16 writes of 4 KiB each → client receives 413 and body
    const chunk = "x".repeat(4096);
    const big64K = await new Promise<Answer>((resolve, reject) => {
      const headers: Record<string, string> = {
        Host: `127.0.0.1:${u.port}`,
        Authorization: `Bearer ${TOKEN}`,
        Origin: `http://127.0.0.1:${u.port}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      };
      const req = http.request({ host: "127.0.0.1", port: u.port, path: SYNC_PATH, method: "POST", headers, setHost: false, agent: false }, (res) => {
        let bodyData = "";
        res.setEncoding("utf8").on("data", (c) => (bodyData += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: bodyData }));
      });
      req.on("error", (e) => resolve({ status: 0, headers: {}, body: String(e) }));
      // Send 16 writes of 4 KiB each
      for (let i = 0; i < 16; i++) req.write(chunk);
      req.end();
    });
    expect([big64K.status, big64K.body]).toEqual([413, '{"error":"body too large"}']);
    expect(calls).toHaveLength(0);

    // Exactly 4096 bytes of valid JSON (pad the digest object with spaces) → reaches parsing
    const exact4096 = JSON.stringify({ digest: VALID_DIGEST }) + " ".repeat(4096 - JSON.stringify({ digest: VALID_DIGEST }).length);
    expect(Buffer.byteLength(exact4096)).toBe(4096);
    // This is valid JSON that parseWriteBody will accept
    const exact = await postAsk(u, SYNC_PATH, exact4096);
    expect(exact.status).toBe(200); // reaches the route
    expect(calls).toHaveLength(1);

    // Content-Length says 10 but sends 5000 bytes → never accepted as ≤ 4096
    calls.length = 0;
    const lying = await new Promise<Answer>((resolve, reject) => {
      const headers: Record<string, string> = {
        Host: `127.0.0.1:${u.port}`,
        Authorization: `Bearer ${TOKEN}`,
        Origin: `http://127.0.0.1:${u.port}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        "Content-Length": "10",
      };
      const req = http.request({ host: "127.0.0.1", port: u.port, path: SYNC_PATH, method: "POST", headers, setHost: false, agent: false }, (res) => {
        let bodyData = "";
        res.setEncoding("utf8").on("data", (c) => (bodyData += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: bodyData }));
      });
      req.on("error", (e) => resolve({ status: 0, headers: {}, body: String(e) }));
      // Send 5000 bytes
      req.write("x".repeat(5000));
      req.end();
    });
    // Either 413 or connection error or 400 (bad json), route never called
    expect(calls).toHaveLength(0);
    expect(lying.status === 413 || lying.status === 0 || lying.status === 400).toBe(true);
  });

  // Case 5b: Body of MAX_DRAIN_BYTES + 4096 bytes → client gets 413 or connection error (past drain cap)
  it("body of MAX_DRAIN_BYTES + 4096 bytes → 413 or connection error; server still answers next request", async () => {
    const u = await startWithWrites();

    // Send MAX_DRAIN_BYTES + 4096 bytes in 64 KiB chunks
    const chunkSize = 64 * 1024;
    const totalBytes = MAX_DRAIN_BYTES + 4096;
    const numChunks = Math.ceil(totalBytes / chunkSize);
    const chunk = Buffer.alloc(chunkSize, "x");
    const lastChunkSize = totalBytes % chunkSize || chunkSize;
    const lastChunk = Buffer.alloc(lastChunkSize, "x");

    const hugeBody = await new Promise<Answer>((resolve) => {
      const headers: Record<string, string> = {
        Host: `127.0.0.1:${u.port}`,
        Authorization: `Bearer ${TOKEN}`,
        Origin: `http://127.0.0.1:${u.port}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      };
      const req = http.request({ host: "127.0.0.1", port: u.port, path: SYNC_PATH, method: "POST", headers, setHost: false, agent: false }, (res) => {
        let bodyData = "";
        res.setEncoding("utf8").on("data", (c) => (bodyData += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: bodyData }));
      });
      req.on("error", (e) => resolve({ status: 0, headers: {}, body: String(e) }));
      for (let i = 0; i < numChunks - 1; i++) req.write(chunk);
      req.write(lastChunk);
      req.end();
    });

    // Either 413 with body, or connection error (acceptable past drain cap)
    expect(hugeBody.status === 413 || hugeBody.status === 0).toBe(true);
    if (hugeBody.status === 413) {
      expect(hugeBody.body).toBe('{"error":"body too large"}');
    }
    expect(calls).toHaveLength(0);

    // Server still answers a valid request after the huge one
    const validAfter = await postAsk(u, SYNC_PATH, VALID_SYNC_BODY);
    expect(validAfter.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  // Case 5c: 64 KiB body with setImmediate delays between writes → 413 with body
  it("64 KiB body with setImmediate delays between writes → 413 with body", async () => {
    const u = await startWithWrites();

    const chunk = "x".repeat(4096);
    const delayedBody = await new Promise<Answer>((resolve) => {
      const headers: Record<string, string> = {
        Host: `127.0.0.1:${u.port}`,
        Authorization: `Bearer ${TOKEN}`,
        Origin: `http://127.0.0.1:${u.port}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      };
      const req = http.request({ host: "127.0.0.1", port: u.port, path: SYNC_PATH, method: "POST", headers, setHost: false, agent: false }, (res) => {
        let bodyData = "";
        res.setEncoding("utf8").on("data", (c) => (bodyData += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: bodyData }));
      });
      req.on("error", (e) => resolve({ status: 0, headers: {}, body: String(e) }));
      // Send 16 writes of 4 KiB each with setImmediate delays
      let i = 0;
      const sendNext = (): void => {
        if (i < 16) {
          req.write(chunk);
          i++;
          setImmediate(sendNext);
        } else {
          req.end();
        }
      };
      sendNext();
    });

    expect([delayedBody.status, delayedBody.body]).toEqual([413, '{"error":"body too large"}']);
    expect(calls).toHaveLength(0);
  });

  // Case 6: Bad body shapes → 400
  it('{"digest":"<64a>","x":1} → 400; not JSON → 400; discard without path → 400', async () => {
    const u = await startWithWrites();

    // Extra key
    const extraKey = await postAsk(u, SYNC_PATH, JSON.stringify({ digest: VALID_DIGEST, x: 1 }));
    expect([extraKey.status, extraKey.body]).toEqual([400, '{"error":"bad request"}']);

    // Not JSON
    const notJson = await postAsk(u, SYNC_PATH, "not json");
    expect([notJson.status, notJson.body]).toEqual([400, '{"error":"bad request"}']);

    // discard without path
    const noPath = await postAsk(u, DISCARD_PATH, JSON.stringify({ digest: VALID_DIGEST }));
    expect([noPath.status, noPath.body]).toEqual([400, '{"error":"bad request"}']);

    expect(calls).toHaveLength(0);
  });

  // Case 7: GET on /discard → 405 Allow: POST; POST on /diff → 405 Allow: GET; POST on / → 405 Allow: GET; PUT → 405 Allow: GET, POST
  it("GET on /discard → 405 Allow: POST; POST on /diff → 405 Allow: GET; POST on / → 405 Allow: GET; PUT → 405 Allow: GET, POST", async () => {
    const u = await startWithWrites();

    // GET on write pattern → 405 Allow: POST
    const getDiscard = await ask(u, DISCARD_PATH.split("?")[0]);
    expect([getDiscard.status, getDiscard.headers.allow, getDiscard.body]).toEqual([405, "POST", '{"error":"POST only"}']);

    // POST on reading pattern → 405 Allow: GET
    const postDiff = await postAsk(u, DIFF_PATH, VALID_SYNC_BODY);
    expect([postDiff.status, postDiff.headers.allow, postDiff.body]).toEqual([405, "GET", '{"error":"GET only"}']);

    // POST on static route → 405 Allow: GET
    const postRoot = await postAsk(u, "/", VALID_SYNC_BODY);
    expect([postRoot.status, postRoot.headers.allow, postRoot.body]).toEqual([405, "GET", '{"error":"GET only"}']);

    // PUT → 405 Allow: GET, POST
    const put = await new Promise<Answer>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: u.port, path: DATA, method: "PUT", headers: { Host: `127.0.0.1:${u.port}` }, setHost: false, agent: false }, (res) => {
        let body = "";
        res.setEncoding("utf8").on("data", (c) => (body += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    });
    expect([put.status, put.headers.allow, put.body]).toEqual([405, "GET, POST", '{"error":"GET or POST only"}']);
  });

  // Case 8: The token: valid POST without Authorization → 403, route not called
  it("valid POST without Authorization → 403, route not called", async () => {
    const u = await startWithWrites();
    const a = await postAsk(u, SYNC_PATH, VALID_SYNC_BODY, { auth: false });
    expect([a.status, a.body]).toEqual([403, FORBIDDEN]);
    expect(calls).toHaveLength(0);
  });

  // Case 9: Queue: a slow write route and a GET sent right after — GET starts only after the write ends
  it("queue: a slow write and a GET right after — GET starts only after write ends", async () => {
    const u = await startWithWrites(200); // 200ms delay
    const events: string[] = [];

    // Start POST (slow)
    const postPromise = postAsk(u, SYNC_PATH, VALID_SYNC_BODY).then((a) => {
      events.push("post done");
      return a;
    });

    // Wait a bit then send GET
    await new Promise((r) => setTimeout(r, 20));
    const getPromise = ask(u, DATA).then((a) => {
      events.push("get done");
      return a;
    });

    const [postAnswer, getAnswer] = await Promise.all([postPromise, getPromise]);
    expect(postAnswer.status).toBe(200);
    expect(getAnswer.status).toBe(200);

    // Check order: POST started first, ended first, then GET started and ended
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("POST");
    expect(calls[1].method).toBe("GET");
    expect(calls[0].endedAt!).toBeLessThanOrEqual(calls[1].startedAt);
    expect(events).toEqual(["post done", "get done"]);
  });

  // Case 10: A throwing route seam on /sync → 500 and one onError line
  it("throwing route on /sync → 500 and one onError line", async () => {
    const u = await start({
      allowWrites: true,
      route: async (req) => {
        if (req.path.includes("sync")) throw new Error("SENTINEL-ERROR first line\nsecond line");
        return OK;
      },
    });
    const a = await postAsk(u, SYNC_PATH, VALID_SYNC_BODY);
    expect([a.status, a.body]).toEqual([500, '{"error":"internal error"}']);
    expect(errors).toEqual(["ui: /api/workspaces/<id>/sync: SENTINEL-ERROR first line"]);
  });
});

// Spec 40 §6.5 — the served /app.js depends on allowWrites
describe("/app.js served based on allowWrites", () => {
  it("with allowWrites: true, /app.js equals pageJs(true)", async () => {
    // Import dynamically to avoid issues, since we need the actual compiled module
    const { PAGE_JS, pageJs } = await import("../src/ui/page.js");
    ui = await startUi({ home: process.env.CRAFTAR_HOME!, version: "0.0.0-test", port: 0, onError: (l) => errors.push(l), token: TOKEN, allowWrites: true, route: async () => OK });
    const a = await ask(ui, "/app.js", { auth: false });
    expect(a.status).toBe(200);
    expect(a.body).toBe(pageJs(true));
    expect(a.body).not.toBe(PAGE_JS);
  });

  it("without allowWrites, /app.js equals PAGE_JS (pageJs(false))", async () => {
    const { PAGE_JS, pageJs } = await import("../src/ui/page.js");
    ui = await startUi({ home: process.env.CRAFTAR_HOME!, version: "0.0.0-test", port: 0, onError: (l) => errors.push(l), token: TOKEN, route: async () => OK });
    const a = await ask(ui, "/app.js", { auth: false });
    expect(a.status).toBe(200);
    expect(a.body).toBe(PAGE_JS);
    expect(a.body).toBe(pageJs(false));
  });
});