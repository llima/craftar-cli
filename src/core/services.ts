/**
 * Service planning (spec 31 §4.1, §5.3): the files `sync` writes for service ingredients.
 * These are not a target's: they are planned by one function, called once after the target loop.
 */
import YAML from "yaml";
import type { EmitBase, PlannedFile } from "../emitters/types.js";
import { outName } from "../emitters/shared.js";
import { findSecrets } from "./secrets.js";
import { isUtf8, stripBom, toLf } from "./text.js";
import { normalizeDeclared, type Ingredient } from "../schema/index.js";

/** Shape of a Compose fragment: must be a mapping with services, volumes, networks, configs, secrets as mappings. */
interface ComposeFragment {
  services?: Record<string, unknown>;
  volumes?: Record<string, unknown>;
  networks?: Record<string, unknown>;
  configs?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  name?: unknown;
  include?: unknown;
  [key: string]: unknown;
}

/** Normalizes a service path for comparisons. */
const norm = (p: string) => normalizeDeclared(p);

/** Whether a path is listed in the binary array. */
function isBinary(meta: Extract<Ingredient, { type: "service" }>, file: string): boolean {
  const normalized = norm(file);
  return meta.binary.some((b) => norm(b) === normalized);
}

/** Whether a path is listed in the executable array. */
function isExecutable(meta: Extract<Ingredient, { type: "service" }>, file: string): boolean {
  const normalized = norm(file);
  return meta.executable.some((e) => norm(e) === normalized);
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
  for (const mapName of ["services", "volumes", "networks", "configs", "secrets"]) {
    declaredKeys.set(mapName, new Map());
  }

  // Track published host ports for warning
  const publishedPorts = new Map<string, string>(); // port -> ingredient ref

  // Process each service
  for (const ing of services) {
    const meta = ing.meta;
    const name = outName(meta);
    const fragmentPath = meta.compose;

    // Read and validate the fragment bytes first (for UTF-8 check)
    const fragmentBytes = await base.bytes(ing, fragmentPath);
    if (!isUtf8(fragmentBytes)) {
      throw new Error(`${ing.ref} ${fragmentPath}: not UTF-8 text — list it under binary in ingredient.yaml`);
    }
    if (fragmentBytes.includes(0)) {
      throw new Error(`${ing.ref} ${fragmentPath}: not UTF-8 text — list it under binary in ingredient.yaml`);
    }

    // Render the fragment through ctx.text (sections, params)
    const fragmentText = await base.text(ing, fragmentPath);
    const fragmentContent = Buffer.from(toLf(stripBom(fragmentText)), "utf8");

    // Parse the rendered fragment to validate and check for conflicts
    let parsed: ComposeFragment;
    try {
      parsed = YAML.parse(fragmentText);
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
      throw new Error(`${ing.ref} ${fragmentPath}: not valid YAML after rendering — ${msg}`);
    }

    // Validate fragment shape
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${ing.ref} ${fragmentPath}: a fragment must be a YAML mapping`);
    }
    if (Object.hasOwn(parsed, "name")) {
      throw new Error(`${ing.ref} ${fragmentPath}: a fragment must not declare a top-level name — the project name is craftar's`);
    }
    if (Object.hasOwn(parsed, "include")) {
      throw new Error(`${ing.ref} ${fragmentPath}: a fragment must not declare include — every file of the stack is in craftar.lock`);
    }
    if (!parsed.services || typeof parsed.services !== "object" || Object.keys(parsed.services).length === 0) {
      throw new Error(`${ing.ref} ${fragmentPath}: a fragment must declare at least one service`);
    }

    // Check for duplicate keys in services, volumes, networks, configs, secrets
    for (const mapName of ["services", "volumes", "networks", "configs", "secrets"] as const) {
      const mapValue = parsed[mapName];
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

    // Check for duplicate published host ports and warn
    if (parsed.services && typeof parsed.services === "object") {
      for (const [_svcName, svcDef] of Object.entries(parsed.services)) {
        if (svcDef && typeof svcDef === "object" && !Array.isArray(svcDef)) {
          const ports = (svcDef as Record<string, unknown>).ports;
          if (Array.isArray(ports)) {
            for (const port of ports) {
              const hostPort = extractHostPort(port);
              if (hostPort && !hostPort.includes("$")) {
                const prev = publishedPorts.get(hostPort);
                if (prev) {
                  warn(`${prev} and ${ing.ref} both publish host port ${hostPort}`);
                } else {
                  publishedPorts.set(hostPort, ing.ref);
                }
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
      path: `.craftar/services/${name}/${fragmentPath}`,
      content: fragmentContent,
      target: "services",
      ingredient: ing.ref,
    });

    // Process each file in the files list
    for (const file of meta.files) {
      const filePath = `.craftar/services/${name}/${file}`;

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
        if (!isUtf8(bytes)) {
          throw new Error(`${ing.ref} ${file}: not UTF-8 text — list it under binary in ingredient.yaml`);
        }
        if (bytes.includes(0)) {
          throw new Error(`${ing.ref} ${file}: not UTF-8 text — list it under binary in ingredient.yaml`);
        }

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
    stackLines.push(`  - path: services/${name}/${fragmentPath}`);
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
