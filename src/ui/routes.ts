import { catalogueContext, listIngredients, listRecipes, withLoadWarnings } from "../core/catalogue.js";
import { renderDiff } from "../core/diff.js";
import { oneLine } from "../core/doctor.js";
import { isMissing, listWorkspaces, readRegistry, type WorkspaceRow } from "../core/registry.js";
import { credentialFault, CREDENTIAL_HIDDEN, refHoldsCredentials } from "../core/remote.js";
import { EXAMPLE_CONTENT_HIDDEN, diffReport, explainFile, orphanDriftBody, statusReport } from "../core/report.js";
import { statusDigest, syncToolResult, syncWorkspace } from "../core/write-actions.js";
import { EXAMPLE_SETTINGS } from "../emitters/shared.js";
import type { Lock } from "../schema/index.js";
import { loadWorkspace, plan, readLock, status, unsetDeclared, unsetSummary, type FileStatus, type Plan, type Workspace } from "../core/sync.js";
import { hashNormalized } from "../core/text.js";

/**
 * The data routes of `craftar ui` (spec 36 §4.4, §5.2), as one function with no HTTP in it: a path and a query
 * in, a status and a document out. It reads only, never reaches the network (`mode: "no-fetch"`), and a request
 * names a workspace by its id and a file by a string compared with `status()`'s rows — the request's text is
 * never joined into a path and never relayed in an answer.
 */

export interface WriteBody {
  digest: string;
  path?: string;
}

export interface RouteRequest {
  /** The request target's path, without the query. */
  path: string;
  /** The raw query string, without `?`; "" when there is none. */
  query: string;
  /** The HTTP method. */
  method: "GET" | "POST";
  /** The parsed body, for write routes. */
  body?: WriteBody;
}
export interface RouteAnswer {
  status: 200 | 400 | 404 | 409;
  body: unknown;
}
export interface RouteDeps {
  home: string;
  version: string;
  /** Whether `--allow-writes` was passed. Absent or false means no writes. */
  allowWrites?: boolean;
}

export const NOT_FOUND = { error: "not found" };
export const PATH_REQUIRED = { error: "path is required, once" };
export const MISSING = "the directory or its craftar.yaml is gone — craftar workspaces prune";

/** The two write route patterns (spec 40 §6.2). */
export const WRITE_PATTERNS = ["/api/workspaces/<id>/sync", "/api/workspaces/<id>/discard"] as const;

/** 409 for a remote Forge (spec 40 §6.4 step 2). */
export const REMOTE_FORGE = "writes from the page need a path Forge — run craftar sync";

/** 409 when the digest does not match (spec 40 §6.4 step 4). */
export const STALE_DIGEST = "the workspace changed since the page showed it — refresh";

/** 409 when the path is not a drift or orphan-drift file, or is the example settings file (spec 40 §6.4 step 5). */
export const NOT_HAND_EDITED = "not a hand-edited file";

/** A workspace's id in a URL: 16 hex characters of the hash of its registered path — the path itself never travels. */
export const workspaceId = (registeredPath: string): string => hashNormalized(registeredPath).slice("sha256:".length, "sha256:".length + 16);

/** Why a workspace cannot be shown, in one line — the wording `doctor` uses, so the table and a 409 agree. */
export function routeReason(e: unknown): string {
  return e instanceof Error ? oneLine(e) : String(e).split("\n")[0];
}

/** The route a path names, as its pattern — what the one stderr line of a 500 prints, never the request's text. */
export function routePattern(path: string): string | null {
  if (path === "/api/workspaces") return path;
  const m = /^\/api\/workspaces\/[0-9a-f]{16}(\/(diff|explain|recipes|ingredients|sync|discard))?$/.exec(path);
  return m ? `/api/workspaces/<id>${m[1] ?? ""}` : null;
}

/**
 * A write route's body, checked strictly: `digest` 64 lowercase hex; `path` a string, required for discard and
 * refused for sync; no other key. Null when it does not read.
 */
export function parseWriteBody(action: "sync" | "discard", text: string): WriteBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  const allowed = action === "sync" ? ["digest"] : ["digest", "path"];
  if (Object.keys(obj).some((k) => !allowed.includes(k))) return null;

  if (typeof obj.digest !== "string" || !/^[0-9a-f]{64}$/.test(obj.digest)) return null;

  if (action === "sync") {
    if ("path" in obj) return null;
    return { digest: obj.digest };
  } else {
    if (!("path" in obj) || typeof obj.path !== "string") return null;
    return { digest: obj.digest, path: obj.path };
  }
}

/** The query's `path`, given exactly once and decoded once (`+` is not a space) — or null. */
function onePath(query: string): string | null {
  const given = query.split("&").filter((kv) => kv === "path" || kv.startsWith("path="));
  if (given.length !== 1) return null;
  try {
    return decodeURIComponent(given[0].slice("path=".length));
  } catch {
    return null;
  }
}

/**
 * A row of the table as the page is given it: its id, and — whatever the core answered — never a Forge URL that
 * `credentialFault` flags. Since 0.28.1 the core gives the label itself for a `missing` or an `error` row; this
 * is the page's own check, a second line: the label is the core's (`CREDENTIAL_HIDDEN`), and the key goes with it.
 * A recorded `ref` that `refHoldsCredentials` flags is given the same label (`CREDENTIAL_HIDDEN`).
 */
export function servedRow(r: WorkspaceRow): WorkspaceRow & { id: string } {
  const row = { id: workspaceId(r.path), ...r };
  if (credentialFault(r.forge.source)) row.forge = { ...r.forge, source: CREDENTIAL_HIDDEN, key: null };
  if (r.forge.ref !== null && refHoldsCredentials(r.forge.ref)) row.forge = { ...row.forge, ref: CREDENTIAL_HIDDEN };
  return row;
}

export async function route(req: RouteRequest, deps: RouteDeps): Promise<RouteAnswer> {
  const pattern = routePattern(req.path);
  if (pattern === null) return { status: 404, body: NOT_FOUND };

  const method = req.method;
  const isWritePattern = (WRITE_PATTERNS as readonly string[]).includes(pattern);

  // A POST to a reading route, a GET to a write route, or any POST without allowWrites → 404 (the server refuses earlier with 405)
  if (method === "POST" && !isWritePattern) return { status: 404, body: NOT_FOUND };
  if (method === "GET" && isWritePattern) return { status: 404, body: NOT_FOUND };
  if (method === "POST" && !deps.allowWrites) return { status: 404, body: NOT_FOUND };

  if (isWritePattern && !req.body) return { status: 400, body: { error: "bad request" } };

  if (pattern === "/api/workspaces") {
    const t = await listWorkspaces(deps.home, { fetch: false, reason: routeReason });
    const rows = t.rows.map(servedRow);
    return {
      status: 200,
      body: { version: deps.version, registry: t.registry, fetch: false, writes: deps.allowWrites === true, workspaces: rows, warnings: t.warnings },
    };
  }

  const [, , , id, what] = req.path.split("/");

  // Decided from the request alone, before the registry is read.
  let wanted = "";
  if (what === "diff" || what === "explain") {
    const given = onePath(req.query);
    if (given === null) return { status: 400, body: PATH_REQUIRED };
    wanted = given;
  }

  // A registry that does not read is not this workspace's fault: it propagates, and the server answers 500.
  const entry = (await readRegistry(deps.home)).workspaces.find((e) => workspaceId(e.path) === id);
  if (!entry) return { status: 404, body: NOT_FOUND };
  if (await isMissing(entry)) return { status: 409, body: { error: MISSING, warnings: [] } };

  // What cannot be loaded, planned or read is this workspace's state: 409, in one line. A failure past that point is ours: 500.
  let ws: Workspace | undefined;
  let p: Plan;
  let lock: Lock | null;
  let st: FileStatus[];
  try {
    // For write patterns, refuse a remote Forge before anything is fetched (spec 40 §6.4 step 2).
    ws = await loadWorkspace(entry.path, {
      mode: "no-fetch",
      home: deps.home,
      ...(isWritePattern ? { refuseRemote: () => REMOTE_FORGE } : {}),
    });
    if (what === "recipes" || what === "ingredients") {
      // The catalogue resolves and never plans; it does not read the lock either.
      const context = catalogueContext(ws.forge, { kind: "workspace", config: ws.config });
      const listing = what === "recipes" ? listRecipes(ws.forge, context) : listIngredients(ws.forge, context);
      return { status: 200, body: withLoadWarnings(listing, ws.warnings) };
    }
    p = await plan(ws);
    lock = await readLock(ws.root);
    st = await status(ws, p, lock);
  } catch (e) {
    // A refuseRemote throw returns the exact REMOTE_FORGE message (spec 40 §6.4 step 2).
    if (e instanceof Error && e.message === REMOTE_FORGE) {
      return { status: 409, body: { error: REMOTE_FORGE, warnings: [] } };
    }
    return { status: 409, body: { error: routeReason(e), warnings: ws?.warnings ?? [] } };
  }

  // Write routes: digest → (discard) path → unset → sync → answer (spec 40 §6.4).
  if (isWritePattern) {
    const body = req.body!;
    const action = what as "sync" | "discard";

    const currentDigest = await statusDigest(ws, st);
    if (currentDigest !== body.digest) {
      return { status: 409, body: { error: STALE_DIGEST, warnings: [] } };
    }

    let row: FileStatus | undefined;
    if (action === "discard") {
      row = st.find((s) => s.path === body.path);
      if (!row || (row.state !== "drift" && row.state !== "orphan-drift") || row.path === EXAMPLE_SETTINGS) {
        return { status: 409, body: { error: NOT_HAND_EDITED, warnings: [] } };
      }
    }

    const unset = unsetDeclared(p);
    if (unset.length) {
      return { status: 409, body: { error: unsetSummary(unset), warnings: [] } };
    }

    const outcome = await syncWorkspace(ws, p, st, lock, {
      home: deps.home,
      registryOff: false,
      ...(action === "discard" && row ? { overwritePaths: new Set([row.path]) } : {}),
    });

    return { status: 200, body: syncToolResult(ws, p, st, outcome, false, action === "discard" && row ? row.path : undefined) };
  }

  if (what === undefined) {
    const report = statusReport(ws, p, lock, st);
    const base = {
      id,
      path: entry.path,
      profile: ws.config.profile,
      recipes: p.resolution.recipes,
      targets: p.resolution.targets,
      ...report,
      refused: report.unsetParams.length ? unsetSummary(report.unsetParams) : null,
    };
    if (deps.allowWrites) {
      return {
        status: 200,
        body: { ...base, digest: await statusDigest(ws, st) },
      };
    }
    return { status: 200, body: base };
  }
  if (what === "explain") {
    // Never `notProduced`'s message: it quotes the path asked.
    const explained = explainFile(ws, p, wanted);
    return explained ? { status: 200, body: explained } : { status: 404, body: NOT_FOUND };
  }
  // The row whose path is the string asked, character for character: nothing is opened that status() did not name.
  const row = st.find((s) => s.path === wanted);
  if (!row) return { status: 404, body: NOT_FOUND };

  // For orphan-drift, under allowWrites, return the file's body as a diff (spec 40 §6.5)
  if (row.state === "orphan-drift" && deps.allowWrites) {
    const { body: fileBody, note } = await orphanDriftBody(ws.root, row);
    const from = `${row.path} (disk, ${row.state})`;
    const to = `${row.path} (forge: no longer produced — discard removes it)`;
    return {
      status: 200,
      body: {
        path: row.path,
        state: row.state,
        from,
        to,
        hidden: note !== null,
        note,
        diff: fileBody === null ? null : renderDiff(fileBody, ""),
      },
    };
  }

  const [d] = await diffReport(ws, [row], { withholdMcp: false });
  if (!d) return { status: 200, body: { path: row.path, state: row.state, from: null, to: null, hidden: false, note: null, diff: null } };
  const from = `${row.path} (disk, ${row.state})`;
  const to = row.state === "orphan-drift" ? null : row.state === "orphan" ? `${row.path} (forge: no longer produced — sync removes it)` : `${row.path} (forge)`;
  return {
    status: 200,
    body: {
      path: row.path,
      state: row.state,
      from,
      to,
      hidden: d.note === EXAMPLE_CONTENT_HIDDEN,
      note: d.note,
      diff: d.note === null ? renderDiff(d.disk ?? "", d.forge ?? "") : null,
    },
  };
}
