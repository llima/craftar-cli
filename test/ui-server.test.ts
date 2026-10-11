import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { CSP, hostAllowed, originAllowed, siteAllowed, startUi, type UiOptions, type UiServer } from "../src/ui/server.js";

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
    expect(seen).toEqual([[{ path: "/api/workspaces/0123456789abcdef/diff", query: "path=a%2Fb&path=c" }, "0.0.0-test"]]);
  });

  it("a route that throws is 500 `internal error`; the message goes to onError once, with the pattern and nothing of the request", async () => {
    const u = await start({ route: async () => { throw new Error("SENTINEL-CAUSE first line\nSENTINEL-SECOND"); } });
    const a = await ask(u, "/api/workspaces/0123456789abcdef/diff?path=SENTINEL-QUERY", { headers: { "X-Acme": "SENTINEL-HEADER" } });
    expect([a.status, a.body]).toEqual([500, '{"error":"internal error"}']);
    expect(errors).toEqual(["ui: /api/workspaces/<id>/diff: SENTINEL-CAUSE first line"]);
    // the server stays up
    expect((await ask(u, "/")).status).toBe(200);
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
