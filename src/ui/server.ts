import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { errorText } from "../core/schema-fault.js";
import { PAGE_CSS, PAGE_HTML, PAGE_JS } from "./page.js";
import { parseWriteBody, route as defaultRoute, routePattern, WRITE_PATTERNS, type RouteAnswer, type RouteDeps, type RouteRequest } from "./routes.js";

/**
 * The loopback server of `craftar ui` (spec 36 §4.5, §7; spec 40 §6.3) — the one file under `src/` that imports `node:http`.
 * It never prints and never exits: what the terminal must see goes through `opts.onError`.
 *
 * Every request passes the same checks, in this order, and the order is the contract (spec 36 §7.2, spec 40 §6.3):
 * method → length of the target → `Host` → `Origin` and `Sec-Fetch-Site` → the route (a static one answers
 * here; an unknown path is 404; without `allowWrites` a write pattern is 404) → the run token → (for POST)
 * `Content-Type` → the body → the queue of one → `route()`.
 */

export const MAX_TARGET_BYTES = 2048;
export const MAX_BODY_BYTES = 4096;
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface UiOptions {
  home: string;
  version: string;
  /** 0 asks the system for a free port. */
  port: number;
  /** One line for the terminal: `ui: <route pattern>: <first line of the message>`. */
  onError: (line: string) => void;
  /** Whether `--allow-writes` was passed. Absent or false means read-only. */
  allowWrites?: boolean;
  /** Test seam; absent, 32 random bytes as base64url. */
  token?: string;
  /** Test seam; absent, the data routes. */
  route?: (req: RouteRequest, deps: RouteDeps) => Promise<RouteAnswer>;
}
export interface UiServer {
  /** `http://127.0.0.1:<port>/#<token>` — the token travels in the fragment, which a browser never sends. */
  url: string;
  port: number;
  address: AddressInfo;
  close(): Promise<void>;
}

/** The names this server answers to. `localhost` is not one: it may resolve elsewhere, and a rebound name could read as it. */
const names = (port: number): string[] => (port === 80 ? ["127.0.0.1", "127.0.0.1:80"] : [`127.0.0.1:${port}`]);

export const hostAllowed = (header: string | undefined, port: number): boolean => header !== undefined && names(port).includes(header);
/** Absent is allowed: a browser sends no `Origin` on a navigation or a same-origin GET. `null` is not. */
export const originAllowed = (header: string | undefined, port: number): boolean =>
  header === undefined || names(port).some((n) => header === `http://${n}`);
export const siteAllowed = (header: string | undefined): boolean => header === undefined || header === "same-origin" || header === "none";

const STATIC: Record<string, readonly [type: string, body: string]> = {
  "/": ["text/html; charset=utf-8", PAGE_HTML],
  "/app.js": ["text/javascript; charset=utf-8", PAGE_JS],
  "/app.css": ["text/css; charset=utf-8", PAGE_CSS],
};

/**
 * A header as sent, once — read from `headersDistinct`, because Node keeps only the first `Host` or `Authorization`
 * of a request that gives two. Given twice, it reads as one value no allowed spelling equals, whichever came first.
 */
const one = (req: http.IncomingMessage, name: string): string | undefined => {
  const values = req.headersDistinct[name];
  return values === undefined ? undefined : values.length === 1 ? values[0] : values.join(", ");
};

/** Starts listening; rejects with the bind error, its `code` kept. */
export function startUi(opts: UiOptions): Promise<UiServer> {
  const token = opts.token ?? randomBytes(32).toString("base64url");
  const want = Buffer.from(`Bearer ${token}`, "utf8");
  const run = opts.route ?? defaultRoute;
  const allowWrites = opts.allowWrites === true;
  const deps: RouteDeps = { home: opts.home, version: opts.version, allowWrites };

  // One data request at a time: each loads a Forge and plans a workspace.
  let queue: Promise<void> = Promise.resolve();
  let port = opts.port;
  let closed = false;

  const server = http.createServer((req, res) => {
    const send = (status: number, type: string, body: string, extra: Record<string, string> = {}): void => {
      res.writeHead(status, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        ...extra,
      });
      res.end(body);
    };
    const json = (status: number, body: unknown, extra: Record<string, string> = {}): void =>
      send(status, "application/json; charset=utf-8", JSON.stringify(body), extra);
    // Every refusal is the same bytes: which check refused is not said.
    const forbidden = (): void => json(403, { error: "forbidden" });

    const enqueue = (request: RouteRequest, pattern: string): void => {
      // One request's failure must neither end the process nor stop the queue (see the catch at the end).
      queue = queue.then(async () => {
        // Work still queued when the server closed is dropped: its connection is gone, and nothing should keep loading.
        if (closed) return;
        try {
          const answer = await run(request, deps);
          json(answer.status, answer.body);
        } catch (e) {
          // The pattern, never the request's text; the browser learns nothing of the message.
          opts.onError(`ui: ${pattern}: ${errorText(e).split("\n")[0]}`);
          json(500, { error: "internal error" });
        }
      }).catch(() => {
        // Only the catch above can throw: a failing `onError`, or an answer that can no longer be written. Nothing
        // more can be said then; the connection is closed rather than left unanswered, and the queue goes on.
        res.destroy();
      });
    };

    const method = req.method;
    if (method !== "GET" && method !== "POST") {
      return json(405, { error: allowWrites ? "GET or POST only" : "GET only" }, { Allow: allowWrites ? "GET, POST" : "GET" });
    }
    if (method === "POST" && !allowWrites) {
      return json(405, { error: "GET only" }, { Allow: "GET" });
    }

    const target = req.url ?? "/";
    if (Buffer.byteLength(target, "utf8") > MAX_TARGET_BYTES) return json(414, { error: "request too long" });

    if (!hostAllowed(one(req, "host"), port)) return forbidden();

    // A POST needs Origin present and exact; a GET may omit it (a navigation or a same-origin fetch sends none).
    const origin = one(req, "origin");
    const site = one(req, "sec-fetch-site");
    if (method === "GET") {
      if (!originAllowed(origin, port) || !siteAllowed(site)) return forbidden();
    } else {
      if (origin === undefined || !names(port).some((n) => origin === `http://${n}`)) return forbidden();
      if (site !== "same-origin") return forbidden();
    }

    // The path is split from the query by hand: no URL is built from the request.
    const q = target.indexOf("?");
    const path = q === -1 ? target : target.slice(0, q);

    const page = Object.hasOwn(STATIC, path) ? STATIC[path] : undefined;
    if (page) {
      if (method === "POST") return json(405, { error: "GET only" }, { Allow: "GET" });
      return send(200, page[0], page[1], path === "/" ? { "Content-Security-Policy": CSP } : {});
    }

    const pattern = routePattern(path);
    const isWritePattern = pattern !== null && (WRITE_PATTERNS as readonly string[]).includes(pattern);
    if (pattern === null || (!allowWrites && isWritePattern)) return json(404, { error: "not found" });

    if (method === "POST" && !isWritePattern) return json(405, { error: "GET only" }, { Allow: "GET" });
    if (method === "GET" && isWritePattern) return json(405, { error: "POST only" }, { Allow: "POST" });

    // The token: in the Authorization header and nowhere else, compared in constant time.
    const got = Buffer.from(one(req, "authorization") ?? "", "utf8");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return forbidden();

    if (method === "POST") {
      const contentType = (one(req, "content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        return json(415, { error: "Content-Type must be application/json" });
      }

      // The body is counted as it arrives: Content-Length is not trusted.
      const action = pattern === "/api/workspaces/<id>/sync" ? "sync" : "discard";
      const chunks: Buffer[] = [];
      let bytes = 0;
      let bodyRejected = false;

      req.on("data", (chunk: Buffer) => {
        if (bodyRejected) return;
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          bodyRejected = true;
          json(413, { error: "body too large" }, { Connection: "close" });
          res.once("finish", () => req.destroy());
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        if (bodyRejected || closed) return;
        const text = Buffer.concat(chunks).toString("utf8");
        const body = parseWriteBody(action, text);
        if (body === null) {
          json(400, { error: "bad request" });
          return;
        }
        enqueue({ path, query: q === -1 ? "" : target.slice(q + 1), method: "POST", body }, pattern);
      });

      // A client that goes away mid-body: nothing to answer, and no unhandled error.
      req.on("error", () => {});
      return;
    }

    enqueue({ path, query: q === -1 ? "" : target.slice(q + 1), method: "GET" }, pattern);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // The literal address: no option, flag or variable changes where this listens.
    server.listen(opts.port, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      port = address.port;
      resolve({
        url: `http://127.0.0.1:${port}/#${token}`,
        port,
        address,
        close: () =>
          new Promise<void>((done) => {
            closed = true;
            server.close(() => done());
            // A browser's keep-alive connection, or a route still running, would hold the listener open; that route's answer is abandoned.
            server.closeAllConnections();
          }),
      });
    });
  });
}
