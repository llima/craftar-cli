import { catalogueContext, listIngredients, listRecipes, withLoadWarnings } from "../core/catalogue.js";
import { renderDiff } from "../core/diff.js";
import { oneLine } from "../core/doctor.js";
import { isMissing, listWorkspaces, readRegistry, type WorkspaceRow } from "../core/registry.js";
import { credentialFault, CREDENTIAL_HIDDEN, refHoldsCredentials } from "../core/remote.js";
import { EXAMPLE_CONTENT_HIDDEN, diffReport, explainFile, statusReport } from "../core/report.js";
import type { Lock } from "../schema/index.js";
import { loadWorkspace, plan, readLock, status, type FileStatus, type Plan, type Workspace } from "../core/sync.js";
import { hashNormalized } from "../core/text.js";

/**
 * The data routes of `craftar ui` (spec 36 §4.4, §5.2), as one function with no HTTP in it: a path and a query
 * in, a status and a document out. It reads only, never reaches the network (`mode: "no-fetch"`), and a request
 * names a workspace by its id and a file by a string compared with `status()`'s rows — the request's text is
 * never joined into a path and never relayed in an answer.
 */

export interface RouteRequest {
  /** The request target's path, without the query. */
  path: string;
  /** The raw query string, without `?`; "" when there is none. */
  query: string;
}
export interface RouteAnswer {
  status: 200 | 400 | 404 | 409;
  body: unknown;
}
export interface RouteDeps {
  home: string;
  version: string;
}

export const NOT_FOUND = { error: "not found" };
export const PATH_REQUIRED = { error: "path is required, once" };
export const MISSING = "the directory or its craftar.yaml is gone — craftar workspaces prune";

/** A workspace's id in a URL: 16 hex characters of the hash of its registered path — the path itself never travels. */
export const workspaceId = (registeredPath: string): string => hashNormalized(registeredPath).slice("sha256:".length, "sha256:".length + 16);

/** Why a workspace cannot be shown, in one line — the wording `doctor` uses, so the table and a 409 agree. */
export function routeReason(e: unknown): string {
  return e instanceof Error ? oneLine(e) : String(e).split("\n")[0];
}

/** The route a path names, as its pattern — what the one stderr line of a 500 prints, never the request's text. */
export function routePattern(path: string): string | null {
  if (path === "/api/workspaces") return path;
  const m = /^\/api\/workspaces\/[0-9a-f]{16}(\/(diff|explain|recipes|ingredients))?$/.exec(path);
  return m ? `/api/workspaces/<id>${m[1] ?? ""}` : null;
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
  if (pattern === "/api/workspaces") {
    const t = await listWorkspaces(deps.home, { fetch: false, reason: routeReason });
    const rows = t.rows.map(servedRow);
    return {
      status: 200,
      body: { version: deps.version, registry: t.registry, fetch: false, workspaces: rows, warnings: t.warnings },
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
    ws = await loadWorkspace(entry.path, { mode: "no-fetch", home: deps.home });
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
    return { status: 409, body: { error: routeReason(e), warnings: ws?.warnings ?? [] } };
  }
  if (what === undefined) {
    return {
      status: 200,
      body: { id, path: entry.path, profile: ws.config.profile, recipes: p.resolution.recipes, targets: p.resolution.targets, ...statusReport(ws, p, lock, st) },
    };
  }
  if (what === "explain") {
    // Never `notProduced`'s message: it quotes the path asked.
    const explained = explainFile(ws, p, wanted);
    return explained ? { status: 200, body: explained } : { status: 404, body: NOT_FOUND };
  }
  // The row whose path is the string asked, character for character: nothing is opened that status() did not name.
  const row = st.find((s) => s.path === wanted);
  if (!row) return { status: 404, body: NOT_FOUND };
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
