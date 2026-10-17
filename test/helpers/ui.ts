import { apply, loadWorkspace, plan, readLock, status } from "../../src/core/sync.js";
import { register } from "../../src/core/registry.js";
import { route, workspaceId, type RouteAnswer } from "../../src/ui/routes.js";

export const HOME = () => process.env.CRAFTAR_HOME!;

/** A writing sync through the core, then the registration a `craftar sync` makes: the workspace is in the registry. */
export async function syncRegistered(wsRoot: string): Promise<{ id: string; path: string }> {
  const ws = await loadWorkspace(wsRoot, { home: HOME() });
  const p = await plan(ws);
  await apply(ws, p, await status(ws, p, await readLock(ws.root)), {});
  const entry = await register(HOME(), ws, p);
  return { id: workspaceId(entry.path), path: entry.path };
}

/** `GET <target>` through route(), with no socket: `target` is a path with an optional `?query`. */
export function get(target: string): Promise<RouteAnswer> {
  const q = target.indexOf("?");
  return route({ path: q === -1 ? target : target.slice(0, q), query: q === -1 ? "" : target.slice(q + 1) }, { home: HOME(), version: "0.0.0-test" });
}
