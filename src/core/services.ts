/**
 * Service ingredients — planning (spec 31 §4.1, §5.3) and the read-only core of `craftar services`.
 * Planning: the files `sync` writes for service ingredients, called once after the target loop.
 * Services core: recordedServices, upRefusal, downArgv, and the Compose/Docker helpers.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import type { EmitBase, PlannedFile } from "../emitters/types.js";
import { outName } from "../emitters/shared.js";
import { findSecrets } from "./secrets.js";
import { isUtf8, hashNormalized, stripBom, toLf } from "./text.js";
import { parseYamlText, yamlFault } from "./yaml-read.js";
import {
  normalizeDeclared,
  COMPOSE_MAPS,
  ComposeFragmentShape,
  ComposeStackShape,
  ComposePsRow,
  NO_PROTO_KEY,
  type ComposeFragment,
  type Ingredient,
  type Lock,
  type LockEntryV3,
} from "../schema/index.js";

/** Whether a path is listed in the binary array. */
function isBinary(meta: Extract<Ingredient, { type: "service" }>, file: string): boolean {
  const normalized = normalizeDeclared(file);
  return meta.binary.some((b) => normalizeDeclared(b) === normalized);
}

/** Whether a path is listed in the executable array. */
function isExecutable(meta: Extract<Ingredient, { type: "service" }>, file: string): boolean {
  const normalized = normalizeDeclared(file);
  return meta.executable.some((e) => normalizeDeclared(e) === normalized);
}

/** Assert that the given bytes are valid UTF-8 text (no NUL). Throws with a contextual message. */
function assertText(ref: string, file: string, bytes: Buffer, hint: string): void {
  if (!isUtf8(bytes) || bytes.includes(0)) {
    throw new Error(`${ref} ${file}: ${hint}`);
  }
}

/**
 * Parse a Compose fragment from YAML text.
 *
 * Returns `{ ok: true, fragment }` on success, or `{ ok: false, reason }` on failure.
 * The reason does NOT include a `<ref> <compose>: ` prefix — the caller adds it.
 *
 * Checks:
 * 1. Valid YAML
 * 2. Must be a YAML mapping (not null, array, scalar)
 * 3. Must not declare top-level `name`
 * 4. Must not declare `include`
 * 5. Each of services/volumes/networks/configs/secrets must be a mapping (via ComposeFragmentShape)
 * 6. __proto__ keys are refused (via noProtoKey in the schema)
 * 7. Must declare at least one service
 */
export function parseFragment(text: string): { ok: true; fragment: ComposeFragment } | { ok: false; reason: string } {
  // 1. Parse YAML — through parseYamlText so the error never includes the source line
  //    Compose honours merge keys (<<: *anchor), so parse with merge: true to see what Compose sees.
  let parsed: unknown;
  try {
    parsed = parseYamlText("fragment", text, { merge: true });
  } catch (e) {
    return { ok: false, reason: `not valid YAML after rendering — ${yamlFault(e)}` };
  }

  // 2. Must be a mapping
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "a fragment must be a YAML mapping" };
  }

  const obj = parsed as Record<string, unknown>;

  // 3. Must not declare top-level name
  if (Object.hasOwn(obj, "name")) {
    return { ok: false, reason: "a fragment must not declare a top-level name — the project name is craftar's" };
  }

  // 4. Must not declare include
  if (Object.hasOwn(obj, "include")) {
    return { ok: false, reason: "a fragment must not declare include — every file of the stack is in craftar.lock" };
  }

  // 5 & 6. Validate shape through ComposeFragmentShape (catches __proto__ and non-mapping maps)
  const result = ComposeFragmentShape.safeParse(obj);
  if (!result.success) {
    const issue = result.error.issues[0];
    // The failing map is in issue.path[0]
    const failingMap = issue.path[0];
    // Check if it's a __proto__ issue (recognised by the message noProtoKey raises)
    if (issue.message === NO_PROTO_KEY) {
      return { ok: false, reason: NO_PROTO_KEY };
    }
    // Otherwise it's a shape issue (e.g., volumes: [])
    return { ok: false, reason: `${failingMap} must be a mapping` };
  }

  const fragment = result.data;

  // 7. Must declare at least one service
  if (!fragment.services || Object.keys(fragment.services).length === 0) {
    return { ok: false, reason: "a fragment must declare at least one service" };
  }

  return { ok: true, fragment };
}

/**
 * Plans the service files: `.craftar/compose.yaml`, `.craftar/.gitattributes`,
 * and each service's fragment and files under `.craftar/services/<outName>/`.
 *
 * Called by `plan()` once after the target loop (spec 31 §5.3, choice 24).
 * Reads the resolution's `service` ingredients directly — the single declared
 * exception to "a planned file comes from `ctx.aimed`".
 */
export async function planServices(base: EmitBase): Promise<PlannedFile[]> {
  const { resolution, warn } = base;

  // Get service ingredients from resolution (not through the walk — this is the declared exception)
  const services = resolution.ingredients.filter(
    (ing): ing is typeof ing & { meta: Extract<Ingredient, { type: "service" }> } => ing.meta.type === "service",
  );

  if (services.length === 0) return [];

  const files: PlannedFile[] = [];

  // Track declared keys for conflict detection across fragments
  const declaredKeys = new Map<string, Map<string, string>>(); // map name -> key -> ingredient ref
  for (const mapName of COMPOSE_MAPS) {
    declaredKeys.set(mapName, new Map());
  }

  // Track published host ports for warning (per ingredient, then across)
  const publishedPorts = new Map<string, string>(); // port -> ingredient ref

  // Process each service
  for (const ing of services) {
    const meta = ing.meta;
    const name = outName(meta);
    const fragmentPath = meta.compose;

    // Read and validate the fragment bytes first (for UTF-8 check)
    const fragmentBytes = await base.bytes(ing, fragmentPath);
    assertText(ing.ref, fragmentPath, fragmentBytes, "the fragment is not UTF-8 text");

    // Render the fragment through ctx.text (sections, params)
    const fragmentText = await base.text(ing, fragmentPath);
    const fragmentContent = Buffer.from(toLf(stripBom(fragmentText)), "utf8");

    // Parse the rendered fragment through parseFragment
    const parseResult = parseFragment(fragmentText);
    if (!parseResult.ok) {
      throw new Error(`${ing.ref} ${fragmentPath}: ${parseResult.reason}`);
    }
    const fragment = parseResult.fragment;

    // Check for duplicate keys in services, volumes, networks, configs, secrets
    for (const mapName of COMPOSE_MAPS) {
      const mapValue = fragment[mapName as keyof ComposeFragment];
      if (mapValue && typeof mapValue === "object" && !Array.isArray(mapValue)) {
        const existing = declaredKeys.get(mapName)!;
        for (const key of Object.keys(mapValue)) {
          const prev = existing.get(key);
          if (prev) {
            throw new Error(`${prev} and ${ing.ref} both declare ${mapName}.${key} — Compose would keep one silently`);
          }
          existing.set(key, ing.ref);
        }
      }
    }

    // Check for duplicate published host ports and warn (across different ingredients only)
    // fragment.services is guaranteed to exist and be non-empty by parseFragment
    const svcMap = fragment.services!;
    for (const svcDef of Object.values(svcMap)) {
      if (svcDef && typeof svcDef === "object" && !Array.isArray(svcDef)) {
        const ports = (svcDef as Record<string, unknown>).ports;
        if (Array.isArray(ports)) {
          for (const port of ports) {
            const hostPort = extractHostPort(port);
            if (hostPort && !hostPort.includes("$")) {
              const prev = publishedPorts.get(hostPort);
              // Only warn for different ingredients (same ingredient = Compose's own error)
              if (prev && prev !== ing.ref) {
                warn(`${prev} and ${ing.ref} both publish host port ${hostPort}`);
              } else if (!prev) {
                publishedPorts.set(hostPort, ing.ref);
              }
            }
          }
        }
      }
    }

    // Check for secrets in the rendered fragment
    const findings = findSecrets(fragmentText);
    for (const f of findings) {
      warn(`${ing.ref} ${fragmentPath}: holds a secret-like value (${f.kind}) at line ${f.line}`);
    }

    // Add the fragment file
    files.push({
      path: path.posix.join(".craftar/services", name, fragmentPath),
      content: fragmentContent,
      target: "services",
      ingredient: ing.ref,
    });

    // Process each file in the files list
    for (const file of meta.files) {
      const filePath = path.posix.join(".craftar/services", name, file);

      if (isBinary(meta, file)) {
        // Binary: copy as bytes
        const bytes = await base.bytes(ing, file);
        files.push({
          path: filePath,
          content: bytes,
          target: "services",
          ingredient: ing.ref,
        });
      } else {
        // Text: validate UTF-8, render, check for secrets
        const bytes = await base.bytes(ing, file);
        assertText(ing.ref, file, bytes, "not UTF-8 text — list it under binary in ingredient.yaml");

        const text = await base.text(ing, file);
        const content = Buffer.from(toLf(stripBom(text)), "utf8");

        // Check for secrets
        const findings = findSecrets(text);
        for (const f of findings) {
          warn(`${ing.ref} ${file}: holds a secret-like value (${f.kind}) at line ${f.line}`);
        }

        files.push({
          path: filePath,
          content,
          target: "services",
          ingredient: ing.ref,
          ...(isExecutable(meta, file) ? { mode: 0o755 } : {}),
        });
      }
    }
  }

  // Generate the stack file
  const stackLines = [
    "# Generated by craftar from the Forge — do not edit; change the service ingredient and run `craftar sync`.",
    "include:",
  ];
  for (const ing of services) {
    const name = outName(ing.meta);
    const fragmentPath = ing.meta.compose;
    stackLines.push(`  - path: ${path.posix.join("services", name, fragmentPath)}`);
  }
  const stackContent = Buffer.from(stackLines.join("\n") + "\n", "utf8");

  files.push({
    path: ".craftar/compose.yaml",
    content: stackContent,
    target: "services",
    ingredient: "service/*",
  });

  // Generate .gitattributes
  files.push({
    path: ".craftar/.gitattributes",
    content: Buffer.from("* -text\n", "utf8"),
    target: "services",
    ingredient: "service/*",
  });

  return files;
}

/**
 * Extract the host port from a port mapping.
 * Handles short syntax ("8080:80", "127.0.0.1:8080:80", "8080:80/tcp")
 * and long syntax ({ published: "8080", target: "80" }).
 */
function extractHostPort(port: unknown): string | null {
  if (typeof port === "string") {
    // Short syntax: [IP:][HOST:]CONTAINER[/PROTOCOL]
    const noProto = port.replace(/\/\w+$/, "");
    const parts = noProto.split(":");
    if (parts.length === 2) {
      // HOST:CONTAINER
      return parts[0];
    } else if (parts.length === 3) {
      // IP:HOST:CONTAINER
      return parts[1];
    }
    // Just CONTAINER, no host port
    return null;
  }
  if (port !== null && typeof port === "object" && !Array.isArray(port)) {
    const obj = port as Record<string, unknown>;
    if (Object.hasOwn(obj, "published")) {
      const published = obj.published;
      return typeof published === "string" || typeof published === "number" ? String(published) : null;
    }
  }
  return null;
}

/** The first Compose with `include` (spec 31 §4.6). */
export const MIN_COMPOSE = "2.20.0";
const STACK = ".craftar/compose.yaml";
const DOCKER_FIX = `install Docker with the Compose plugin ${MIN_COMPOSE} or later`;

/**
 * The paths the planned stack includes — `.craftar/services/<name>/<compose>` for each service.
 * Returns the workspace-relative POSIX paths (spec 31 §4.7: services-env scans only the planned fragments).
 * Returns empty array for a stack that is not a valid craftar stack (invalid YAML, no includes, or an
 * include path that is absolute or has a `..` segment).
 */
export function fragmentPaths(stackText: string): string[] {
  let doc: unknown;
  try {
    doc = parseYamlText("stack", stackText);
  } catch {
    return []; // invalid YAML
  }
  const parsed = ComposeStackShape.safeParse(doc);
  if (!parsed.success) return [];
  // Refuse an include path that is absolute or has a .. segment — not a craftar stack
  for (const inc of parsed.data.include) {
    const p = inc.path;
    if (/^\/|^[A-Za-z]:/.test(p)) return []; // absolute
    if (p.split("/").includes("..")) return []; // .. segment
  }
  return parsed.data.include.map((inc) => path.posix.join(".craftar", inc.path));
}

/** `craftar-<slug>-<hash>` (spec 31 §4.5): computed from the workspace's real path, never stored. */
export function projectName(realRoot: string): string {
  const slug = path.basename(realRoot).toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 40);
  const hash = createHash("sha256").update(realRoot).digest("hex").slice(0, 8);
  return /^-*$/.test(slug) ? `craftar--${hash}` : `craftar-${slug}-${hash}`;
}

export type PendingReason = "missing" | "edited" | "unrecorded";
export interface PendingFile { path: string; reason: PendingReason }
export interface RecordedService { name: string; ingredient: string }
export interface Recorded {
  /** How many lock entries `services` owns. */
  entries: number;
  /** The lock records `.craftar/compose.yaml` — whatever is on disk. */
  stack: boolean;
  services: RecordedService[];
  pending: PendingFile[];
  warnings: string[];
}

/**
 * What the lock records under `.craftar/`, checked against the disk: every recorded file that is missing or
 * whose normalized hash differs is pending, and so is a file the stack includes that the lock does not record.
 * It reads the lock and the workspace only — no Forge, no plan, no Docker — and writes nothing.
 */
export async function recordedServices(root: string, lock: Lock | null): Promise<Recorded> {
  const all: readonly LockEntryV3[] = lock?.files ?? [];
  const entries = all.filter((e) => e.target === "services");
  const out: Recorded = { entries: entries.length, stack: entries.some((e) => e.path === STACK), services: [], pending: [], warnings: [] };
  if (entries.length === 0) return out;
  if (!out.stack) out.pending.push({ path: STACK, reason: "unrecorded" });
  const intact = new Map<string, Buffer>();
  for (const e of entries) {
    const bytes = await fs.readFile(path.join(root, e.path)).catch(() => null);
    if (bytes === null) out.pending.push({ path: e.path, reason: "missing" });
    else if (hashNormalized(bytes) !== e.hash) out.pending.push({ path: e.path, reason: "edited" });
    else intact.set(e.path, bytes);
  }
  const stack = intact.get(STACK);
  if (stack === undefined) return out;
  // Read include list through fragmentPaths (spec 31 §4.7: fragment reading is one place)
  let includes: string[];
  try {
    includes = fragmentPaths(stack.toString("utf8"));
  } catch {
    throw new Error(`${STACK}: recorded by craftar.lock but not a craftar stack`);
  }
  if (includes.length === 0) throw new Error(`${STACK}: recorded by craftar.lock but not a craftar stack`);
  for (const rel of includes) {
    const entry = entries.find((e) => e.path === rel);
    if (!entry) {
      // The fragment was a collision at the last sync: a user's file, never handed to Compose.
      out.pending.push({ path: rel, reason: "unrecorded" });
      continue;
    }
    const bytes = intact.get(rel);
    if (bytes === undefined) continue; // already pending
    const f = parseFragment(bytes.toString("utf8"));
    if (!f.ok) out.warnings.push(`${rel}: cannot be read as a Compose fragment`);
    else for (const name of Object.keys(f.fragment.services ?? {})) out.services.push({ name, ingredient: entry.ingredient });
  }
  return out;
}

/** The one test `up` (refuse) and `down` (pass `-f` or not) share (spec 31 §4.2, §4.3). */
export function canUseStack(r: Recorded): boolean {
  return r.stack && r.pending.length === 0;
}

/**
 * The argv for `docker compose down`. Pure function for testability.
 * @param project The project name (always passed with -p)
 * @param r The recorded services state, or null if the lock could not be read
 * @param d Docker version info
 * @param stackPath The stack file path (e.g. /workspace/.craftar/compose.yaml)
 * @param envFile The .env file path, or null if it does not exist
 * @param volumes Whether to pass --volumes
 */
export function downArgv(
  project: string,
  r: Recorded | null,
  d: DockerInfo,
  stackPath: string,
  envFile: string | null,
  volumes: boolean,
): string[] {
  // Pass -f only when: r is not null AND canUseStack AND Compose is new enough
  const useStack = r !== null && canUseStack(r) && !d.belowFloor;
  const argv = ["compose", "-p", project];
  if (useStack) {
    argv.push("-f", stackPath);
    if (envFile !== null) argv.push("--env-file", envFile);
  }
  argv.push("down");
  if (volumes) argv.push("--volumes");
  return argv;
}

/** One line per pending file, with the fix its reason calls for (spec 31 §4.2 step 2, §16.1). */
export function pendingLine(p: PendingFile): string {
  switch (p.reason) {
    case "missing":
      return `${p.path} — missing — run craftar sync`;
    case "edited":
      return `${p.path} — edited — run craftar sync --overwrite-drift to regenerate it, or delete it if craftar status calls it orphan-drift`;
    case "unrecorded":
      return `${p.path} is not craftar's — run craftar status`;
  }
}

/** Why `services up` will not run, before Docker is looked for; empty when it may (spec 31 §4.2 steps 1–2). */
export function upRefusal(r: Recorded, names: string[]): string[] {
  const dash = names.find((n) => n.startsWith("-"));
  if (dash !== undefined) return [`service name ${JSON.stringify(dash)} starts with "-" — refused`];
  if (r.entries === 0) return ["no services in this workspace — craftar sync writes them when a recipe brings a service ingredient"];
  return r.pending.map(pendingLine);
}

/** `docker compose` arguments, as an array for `execFile` / `spawn` — never a shell line. */
export function composeArgv(
  kind: "up" | "down" | "ps",
  o: { project: string; stack: string | null; envFile: string | null; wait?: boolean; volumes?: boolean; services?: string[] },
): string[] {
  const argv = ["compose", "-p", o.project];
  if (o.stack !== null) argv.push("-f", o.stack);
  if (o.envFile !== null) argv.push("--env-file", o.envFile);
  if (kind === "ps") return [...argv, "ps", "--all", "--format", "json"];
  if (kind === "down") return [...argv, "down", ...(o.volumes ? ["--volumes"] : [])];
  const names = o.services ?? [];
  const dash = names.find((n) => n.startsWith("-"));
  if (dash !== undefined) throw new Error(`service name ${JSON.stringify(dash)} starts with "-" — refused`);
  return [...argv, "up", "-d", ...(o.wait ? ["--wait"] : []), ...names];
}

export interface Port { host: number; container: number; protocol: string }
export interface PsContainer { service: string; state: string; health: string | null; ports: Port[] }

/**
 * `docker compose ps --format json`: a JSON array, or one object per line, or nothing. A row that is not a
 * `ComposePsRow` is counted in `unread`, never dropped unseen; output that is neither form throws.
 */
export function readPs(stdout: string): { containers: PsContainer[]; unread: number } {
  const text = stdout.trim();
  if (text === "") return { containers: [], unread: 0 };
  let rows: unknown[];
  try {
    const whole: unknown = text.startsWith("[") ? JSON.parse(text) : text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as unknown);
    if (!Array.isArray(whole)) throw new Error("not an array");
    rows = whole;
  } catch {
    throw new Error("docker compose ps: output not understood");
  }
  const containers: PsContainer[] = [];
  let unread = 0;
  for (const row of rows) {
    const r = ComposePsRow.safeParse(row);
    if (!r.success) {
      unread++;
      continue;
    }
    const ports: Port[] = [];
    for (const p of r.data.Publishers ?? []) {
      // An unpublished port has PublishedPort 0; IPv4 and IPv6 publishers repeat one triple.
      if (p.PublishedPort > 0 && !ports.some((x) => x.host === p.PublishedPort && x.container === p.TargetPort && x.protocol === p.Protocol))
        ports.push({ host: p.PublishedPort, container: p.TargetPort, protocol: p.Protocol });
    }
    containers.push({ service: r.data.Service, state: r.data.State, health: r.data.Health ? r.data.Health : null, ports });
  }
  return { containers, unread };
}

export interface DockerInfo {
  /** `docker compose` answered with a version. */
  available: boolean;
  compose: string | null;
  belowFloor: boolean;
  reason: "no docker" | "no compose plugin" | "too old" | null;
}
export type DockerRunner = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Numeric, segment by segment: 2.9.0 is older than 2.20.0. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** `docker compose version --short` (spec 31 §4.6). The runner rejects when `docker` cannot be started. */
export async function dockerVersion(run: DockerRunner): Promise<DockerInfo> {
  let r: { code: number; stdout: string };
  try {
    r = await run("docker", ["compose", "version", "--short"]);
  } catch {
    return { available: false, compose: null, belowFloor: false, reason: "no docker" };
  }
  const m = /^v?(\d+(?:\.\d+)*)/.exec(r.stdout.trim());
  if (r.code !== 0 || m === null) return { available: false, compose: null, belowFloor: false, reason: "no compose plugin" };
  const compose = m[1]; // just the numeric version, no suffix like "-desktop.1"
  const belowFloor = compareVersions(compose, MIN_COMPOSE) < 0;
  return { available: true, compose, belowFloor, reason: belowFloor ? "too old" : null };
}

/** The message and fix for a Docker that cannot serve the command; null when it can. `down` and `status` do not need the floor. */
export function dockerFinding(d: DockerInfo, needFloor: boolean): { message: string; fix: string } | null {
  if (d.reason === "no docker") return { message: "docker not found", fix: DOCKER_FIX };
  if (d.reason === "no compose plugin") return { message: "the docker compose plugin is missing", fix: DOCKER_FIX };
  if (d.reason === "too old" && needFloor) return { message: `Docker Compose ${d.compose} is older than ${MIN_COMPOSE}`, fix: "upgrade Docker Compose" };
  return null;
}

/** The line and fix for a Docker that cannot serve the command; null when it can. `down` and `status` do not need the floor. */
export function dockerFault(d: DockerInfo, needFloor: boolean): string | null {
  const finding = dockerFinding(d, needFloor);
  return finding ? `${finding.message} — ${finding.fix}` : null;
}

/** Runs `docker` with an argument array and no shell; resolves with the exit code, rejects when it cannot start. */
export const dockerRunner: DockerRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) return resolve({ code: 0, stdout, stderr });
      // A numeric code is the child's exit code; anything else (ENOENT, EACCES, a signal) means it did not run to an exit.
      if (typeof error.code === "number") return resolve({ code: error.code, stdout, stderr });
      reject(error);
    });
  });

export interface ServiceRow { name: string; ingredient: string | null; state: string; health: string | null; ports: Port[] }
/** `services status --json` (spec 31 §4.4): a tooling contract, keys in this order. */
export interface ServicesStatus {
  workspace: string;
  project: string;
  composeFile: string | null;
  docker: { available: boolean; compose: string | null };
  services: ServiceRow[];
  pending: PendingFile[];
  warnings: string[];
}

/** The report of `services status`. `ps` is null when Docker was not asked or did not answer; `psFault` says why. Pure. */
export function statusReport(realRoot: string, r: Recorded, d: DockerInfo, ps: { containers: PsContainer[]; unread: number } | null, psFault: string | null): ServicesStatus {
  const services: ServiceRow[] = [];
  const rows = ps?.containers ?? [];
  for (const s of r.services) {
    const mine = rows.filter((c) => c.service === s.name);
    if (mine.length === 0) services.push({ name: s.name, ingredient: s.ingredient, state: "not created", health: null, ports: [] });
    for (const c of mine) services.push({ name: s.name, ingredient: s.ingredient, state: c.state, health: c.health, ports: c.ports });
  }
  // A container of the project whose service no recorded fragment declares.
  for (const c of rows) {
    if (!r.services.some((s) => s.name === c.service)) services.push({ name: c.service, ingredient: null, state: c.state, health: c.health, ports: c.ports });
  }
  const warnings = [...r.warnings];
  if (psFault !== null) warnings.push(psFault);
  if (ps !== null && ps.unread > 0) warnings.push(`docker compose ps: ${ps.unread} row(s) not understood`);
  return {
    workspace: realRoot,
    project: projectName(realRoot),
    composeFile: r.stack ? STACK : null,
    docker: { available: d.available, compose: d.compose },
    services,
    pending: r.pending,
    warnings,
  };
}
