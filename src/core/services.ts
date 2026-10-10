/**
 * Service planning (spec 31 §4.1, §5.3): the files `sync` writes for service ingredients.
 * These are not a target's: they are planned by one function, called once after the target loop.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import YAML from "yaml";
import type { EmitBase, PlannedFile } from "../emitters/types.js";
import { outName } from "../emitters/shared.js";
import { findSecrets } from "./secrets.js";
import { isUtf8, hashNormalized, stripBom, toLf } from "./text.js";
import {
  normalizeDeclared,
  COMPOSE_MAPS,
  ComposeFragmentShape,
  ComposeStackShape,
  ComposePsRowSchema,
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
  // 1. Parse YAML
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return { ok: false, reason: `not valid YAML after rendering — ${msg}` };
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
    if (issue.message === "a __proto__ key is not allowed") {
      return { ok: false, reason: "a __proto__ key is not allowed" };
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

/* ------------------------------------------------------------------ */
/* Services core functions                                              */
/* ------------------------------------------------------------------ */

/** Minimum Docker Compose version required (spec 31 §4.6). */
export const MIN_COMPOSE = "2.20.0";

/**
 * Compute the project name for a workspace (spec 31 §4.5).
 *
 * Format: `craftar-<slug>-<hash>`:
 * - `<slug>` is the workspace directory's basename, lowercased, every character
 *   outside `[a-z0-9_-]` replaced by `-`, cut at 40.
 * - `<hash>` is the first 8 hex digits of the SHA-256 of the workspace's real path.
 *
 * The caller is responsible for passing the real path (via fs.realpath).
 */
export function projectName(realRoot: string): string {
  const basename = path.basename(realRoot);
  // Lowercase, replace non-slug chars with -, cut at 40
  let slug = basename.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 40);
  // If slug is empty or all dashes, use empty slug
  if (/^-*$/.test(slug)) {
    slug = "";
  }
  // Hash the real path string
  const hash = createHash("sha256").update(realRoot).digest("hex").slice(0, 8);
  return slug ? `craftar-${slug}-${hash}` : `craftar--${hash}`;
}

/** Pending file reason for recordedServices. */
export type PendingReason = "missing" | "edited" | "unrecorded";

/** A pending file that blocks `up`. */
export interface PendingFile {
  path: string;
  reason: PendingReason;
}

/** A declared service from a recorded fragment. */
export interface RecordedService {
  name: string;
  ingredient: string;
}

/** Result of recordedServices. */
export interface RecordedServicesResult {
  stack: boolean;
  services: RecordedService[];
  pending: PendingFile[];
  warnings: string[];
}

/**
 * Read the recorded services from the lock and the workspace files (spec 31 step 31d).
 *
 * "Recorded under `.craftar/`" means entries with `target === "services"`.
 * `edited` = on disk and `hashNormalized(bytes) !== entry.hash`.
 *
 * The declared services come from parsing each recorded fragment on disk through
 * `ComposeFragmentShape`. Which recorded file is a fragment: the paths the recorded
 * stack's `include:` lists (parse `.craftar/compose.yaml` when it is recorded, present
 * and unedited). When the stack is missing, edited or unrecorded, `services` is `[]`
 * and the pending list says why.
 *
 * A fragment that does not parse adds a warning and no service.
 *
 * IMPORTANT: This function checks ALL entries in lock order and lists ALL pending
 * entries, not just the first one. This is required for `services status` to show
 * all issues at once.
 */
export async function recordedServices(root: string, lock: Lock): Promise<RecordedServicesResult> {
  const services: RecordedService[] = [];
  const pending: PendingFile[] = [];
  const warnings: string[] = [];

  // Get all lock entries owned by "services", preserving lock order
  const serviceEntries = lock.files.filter(
    (e): e is LockEntryV3 => "target" in e && e.target === "services"
  );

  if (serviceEntries.length === 0) {
    // No services recorded — a schema 1 or 2 lock has no services entry
    return { stack: false, services: [], pending: [], warnings: [] };
  }

  // Find the stack entry
  const stackEntry = serviceEntries.find((e) => e.path === ".craftar/compose.yaml");

  // If the lock has service entries but not the stack, it was a collision
  if (!stackEntry) {
    pending.push({ path: ".craftar/compose.yaml", reason: "unrecorded" });
    // Still check all other entries in lock order
    for (const entry of serviceEntries) {
      const filePath = path.join(root, entry.path);
      let fileBytes: Buffer;
      try {
        fileBytes = await fs.readFile(filePath);
      } catch {
        pending.push({ path: entry.path, reason: "missing" });
        continue;
      }
      const fileHash = hashNormalized(fileBytes);
      if (fileHash !== entry.hash) {
        pending.push({ path: entry.path, reason: "edited" });
      }
    }
    return { stack: false, services: [], pending, warnings };
  }

  // Check the stack file on disk
  const stackPath = path.join(root, ".craftar/compose.yaml");
  let stackBytes: Buffer;
  try {
    stackBytes = await fs.readFile(stackPath);
  } catch {
    pending.push({ path: ".craftar/compose.yaml", reason: "missing" });
    // Still check all other entries in lock order
    for (const entry of serviceEntries) {
      if (entry.path === ".craftar/compose.yaml") continue;
      const filePath = path.join(root, entry.path);
      let fileBytes: Buffer;
      try {
        fileBytes = await fs.readFile(filePath);
      } catch {
        pending.push({ path: entry.path, reason: "missing" });
        continue;
      }
      const fileHash = hashNormalized(fileBytes);
      if (fileHash !== entry.hash) {
        pending.push({ path: entry.path, reason: "edited" });
      }
    }
    return { stack: false, services: [], pending, warnings };
  }

  const stackHash = hashNormalized(stackBytes);
  if (stackHash !== stackEntry.hash) {
    pending.push({ path: ".craftar/compose.yaml", reason: "edited" });
    // Still check all other entries in lock order
    for (const entry of serviceEntries) {
      if (entry.path === ".craftar/compose.yaml") continue;
      const filePath = path.join(root, entry.path);
      let fileBytes: Buffer;
      try {
        fileBytes = await fs.readFile(filePath);
      } catch {
        pending.push({ path: entry.path, reason: "missing" });
        continue;
      }
      const fileHash = hashNormalized(fileBytes);
      if (fileHash !== entry.hash) {
        pending.push({ path: entry.path, reason: "edited" });
      }
    }
    return { stack: false, services: [], pending, warnings };
  }

  // Stack is recorded, present and unedited — parse it for includes using ComposeStackShape
  let stackContent: unknown;
  try {
    stackContent = YAML.parse(stackBytes.toString("utf8"));
  } catch {
    pending.push({ path: ".craftar/compose.yaml", reason: "edited" });
    // Still check all other entries in lock order
    for (const entry of serviceEntries) {
      if (entry.path === ".craftar/compose.yaml") continue;
      const filePath = path.join(root, entry.path);
      let fileBytes: Buffer;
      try {
        fileBytes = await fs.readFile(filePath);
      } catch {
        pending.push({ path: entry.path, reason: "missing" });
        continue;
      }
      const fileHash = hashNormalized(fileBytes);
      if (fileHash !== entry.hash) {
        pending.push({ path: entry.path, reason: "edited" });
      }
    }
    return { stack: false, services: [], pending, warnings };
  }

  // Parse through ComposeStackShape to avoid casts
  const stackParsed = ComposeStackShape.safeParse(stackContent);
  const includes: string[] = [];
  if (stackParsed.success && stackParsed.data.include) {
    for (const inc of stackParsed.data.include) {
      // Paths in the stack are relative to .craftar/
      includes.push(path.posix.join(".craftar", inc.path));
    }
  }

  // Check each recorded entry in lock order
  for (const entry of serviceEntries) {
    // Skip the stack itself (already processed)
    if (entry.path === ".craftar/compose.yaml") {
      continue;
    }

    const filePath = path.join(root, entry.path);
    let fileBytes: Buffer;
    try {
      fileBytes = await fs.readFile(filePath);
    } catch {
      pending.push({ path: entry.path, reason: "missing" });
      continue;
    }

    const fileHash = hashNormalized(fileBytes);
    if (fileHash !== entry.hash) {
      pending.push({ path: entry.path, reason: "edited" });
      continue;
    }

    // If this is a fragment (in the includes list), parse it for service names
    if (includes.includes(entry.path)) {
      const fragmentText = fileBytes.toString("utf8");
      const parseResult = parseFragment(fragmentText);
      if (!parseResult.ok) {
        warnings.push(`${entry.path}: cannot be read as a Compose fragment`);
        continue;
      }

      // Add each service name from this fragment
      for (const name of Object.keys(parseResult.fragment.services!)) {
        services.push({ name, ingredient: entry.ingredient });
      }
    }
  }

  return { stack: true, services, pending, warnings };
}

/**
 * Whether the stack can be used by `up` (spec 31 §4.2) and whether `down` should use `-f` (spec 31 §4.3).
 * Returns true when the stack is recorded and no file is pending.
 */
export function canUseStack(recorded: RecordedServicesResult): boolean {
  return recorded.stack && recorded.pending.length === 0;
}

/**
 * Build the argv for docker compose (pure function).
 *
 * @param kind - The compose command: "up", "down", or "ps"
 * @param opts - Options for the command
 * @returns The argv array (without "docker" at the front)
 * @throws If a service name starts with "-"
 */
export function composeArgv(
  kind: "up" | "down" | "ps",
  opts: {
    project: string;
    stack: string | null;
    envFile: string | null;
    wait?: boolean;
    volumes?: boolean;
    services?: string[];
  },
): string[] {
  const argv = ["compose", "-p", opts.project];

  if (opts.stack !== null) {
    argv.push("-f", opts.stack);
  }

  if (opts.envFile !== null) {
    argv.push("--env-file", opts.envFile);
  }

  if (kind === "up") {
    argv.push("up", "-d");
    if (opts.wait) {
      argv.push("--wait");
    }
    // Service names come last
    if (opts.services && opts.services.length > 0) {
      for (const svc of opts.services) {
        if (svc.startsWith("-")) {
          throw new Error(`service name "${svc}" starts with "-"`);
        }
        argv.push(svc);
      }
    }
  } else if (kind === "down") {
    argv.push("down");
    if (opts.volumes) {
      argv.push("--volumes");
    }
  } else if (kind === "ps") {
    argv.push("ps", "--all", "--format", "json");
  }

  return argv;
}

/** Parsed port from a ps row. */
export interface ParsedPort {
  host: number;
  container: number;
  protocol: string;
}

/** Parsed container from readPs. */
export interface PsContainer {
  name: string;
  service: string;
  state: string;
  health: string | null;
  ports: ParsedPort[];
}

/** Result of readPs: the parsed containers and the count of rows that failed to parse. */
export interface ReadPsResult {
  containers: PsContainer[];
  unread: number;
}

/**
 * Parse the output of docker compose ps --format json.
 *
 * The output can be:
 * - A JSON array of rows
 * - One JSON object per line (older Compose versions)
 * - Empty (no containers)
 *
 * Returns `{ containers, unread }` where `unread` is the count of rows that did not
 * match ComposePsRowSchema. Throws on unparseable output (not valid JSON).
 */
export function readPs(stdout: string): PsContainer[] {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    return [];
  }

  let rows: unknown[];

  // Try parsing as a JSON array first
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      rows = parsed;
    } else {
      // Single object (one-line output for one container)
      rows = [parsed];
    }
  } catch {
    // Try one object per line — throws if any line is invalid JSON
    rows = trimmed.split("\n").map((line) => JSON.parse(line));
  }

  const containers: PsContainer[] = [];
  for (const row of rows) {
    const parsed = ComposePsRowSchema.safeParse(row);
    if (!parsed.success) continue;
    const r = parsed.data;

    const ports: ParsedPort[] = [];
    if (r.Publishers) {
      for (const pub of r.Publishers) {
        if (pub.PublishedPort > 0) {
          ports.push({
            host: pub.PublishedPort,
            container: pub.TargetPort,
            protocol: pub.Protocol,
          });
        }
      }
    }

    containers.push({
      name: r.Name,
      service: r.Service,
      state: r.State,
      health: r.Health === "" || r.Health === undefined ? null : r.Health,
      ports,
    });
  }

  return containers;
}

/** Result of dockerVersion. */
export interface DockerVersionResult {
  available: boolean;
  compose: string | null;
  /** True when Compose is present but below MIN_COMPOSE; always present when available is true. */
  belowFloor: boolean;
  reason: "no docker" | "no compose plugin" | "too old" | null;
}

/** Type for the runner function. */
export type DockerRunner = (
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/**
 * Check Docker and Compose availability (spec 31 §4.6).
 *
 * Runs `docker compose version --short` and parses the output.
 *
 * Returns `{ available: true, ... }` when Docker is present (may still lack Compose).
 * Returns `{ available: false, ... }` when Docker itself is missing.
 */
export async function dockerVersion(run: DockerRunner): Promise<DockerVersionResult> {
  try {
    const result = await run("docker", ["compose", "version", "--short"], {});

    if (result.code !== 0) {
      return { available: true, compose: null, belowFloor: false, reason: "no compose plugin" };
    }

    // Parse the version from stdout (e.g., "v2.24.5" or "2.24.5-desktop.1")
    const versionStr = result.stdout.trim().replace(/^v/, "");
    const version = versionStr.split("-")[0]; // Strip any suffix like "-desktop.1"

    // Check if it meets the minimum
    if (compareVersions(version, MIN_COMPOSE) < 0) {
      return { available: true, compose: versionStr, belowFloor: true, reason: "too old" };
    }

    return { available: true, compose: versionStr, belowFloor: false, reason: null };
  } catch (e) {
    // ENOENT means docker is not found
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
      return { available: false, compose: null, belowFloor: false, reason: "no docker" };
    }
    // Other errors — treat as docker missing
    return { available: false, compose: null, belowFloor: false, reason: "no docker" };
  }
}

/**
 * Compare two version strings numerically per segment.
 * Returns < 0 if a < b, 0 if equal, > 0 if a > b.
 * Handles versions like "2.9.0" vs "2.20.0" correctly.
 */
export function compareVersions(a: string, b: string): number {
  const aParts = a.split(".").map(Number);
  const bParts = b.split(".").map(Number);
  const maxLen = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < maxLen; i++) {
    const aNum = aParts[i] ?? 0;
    const bNum = bParts[i] ?? 0;
    if (aNum < bNum) return -1;
    if (aNum > bNum) return 1;
  }

  return 0;
}

/**
 * The real Docker runner: executes a command via execFile.
 * Used by CLI; tests inject a mock runner.
 */
export const dockerRunner: DockerRunner = (file, args, opts) => {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...opts, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        // Propagate ENOENT as a thrown error so dockerVersion can detect it
        reject(error);
        return;
      }
      // For other errors (non-zero exit), resolve with the exit code from error.code (a number)
      // or fall back to 1. Note: error.code can be a string like "ENOENT" or a number like 1.
      const exitCode = error
        ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? (error as NodeJS.ErrnoException & { code?: number }).code
            : 1)
        : 0;
      resolve({
        code: exitCode ?? 1,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      });
    });
  });
};
