import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { errorText } from "../core/schema-fault.js";
import { PAGE_CSS, PAGE_HTML, PAGE_JS } from "./page.js";
import { route as defaultRoute, routePattern, type RouteAnswer, type RouteDeps, type RouteRequest } from "./routes.js";

/**
 * The loopback server of `craftar ui` (spec 36 §4.5, §7) — the one file under `src/` that imports `node:http`.
 * It never prints and never exits: what the terminal must see goes through `opts.onError`.
 *
 * Every request passes the same checks, in this order, and the order is the contract (§7.2):
 * method → length of the target → `Host` → `Origin` and `Sec-Fetch-Site` → the route (a static one answers
 * here; an unknown path is 404) → the run token → the queue of one → `route()`.
 */

export const MAX_TARGET_BYTES = 2048;
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface UiOptions {
  home: string;
  version: string;
  /** 0 asks the system for a free port. */
  port: number;
  /** One line for the terminal: `ui: <route pattern>: <first line of the message>`. */
  onError: (line: string) => void;
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

    if (req.method !== "GET") return json(405, { error: "GET only" }, { Allow: "GET" });
    const target = req.url ?? "/";
    if (Buffer.byteLength(target, "utf8") > MAX_TARGET_BYTES) return json(414, { error: "request too long" });
    if (!hostAllowed(one(req, "host"), port)) return forbidden();
    if (!originAllowed(one(req, "origin"), port) || !siteAllowed(one(req, "sec-fetch-site"))) return forbidden();

    // The path is split from the query by hand: no URL is built from the request.
    const q = target.indexOf("?");
    const path = q === -1 ? target : target.slice(0, q);
    const page = Object.hasOwn(STATIC, path) ? STATIC[path] : undefined;
    if (page) return send(200, page[0], page[1], path === "/" ? { "Content-Security-Policy": CSP } : {});
    const pattern = routePattern(path);
    if (pattern === null) return json(404, { error: "not found" });

    // The token: in the Authorization header and nowhere else, compared in constant time.
    const got = Buffer.from(one(req, "authorization") ?? "", "utf8");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return forbidden();

    // A rejection must not poison the queue: every later request would wait for its timeout.
    queue = queue.then(async () => {
      // Work still queued when the server closed is dropped: its connection is gone, and nothing should keep loading.
      if (closed) return;
      try {
        const answer = await run({ path, query: q === -1 ? "" : target.slice(q + 1) }, { home: opts.home, version: opts.version });
        json(answer.status, answer.body);
      } catch (e) {
        // The pattern, never the request's text; the browser learns nothing of the message.
        opts.onError(`ui: ${pattern}: ${errorText(e).split("\n")[0]}`);
        json(500, { error: "internal error" });
      }
    }).catch(() => {});
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
