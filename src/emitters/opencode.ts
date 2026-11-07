import type { Ingredient } from "../schema/index.js";
import type { ResolvedIngredient } from "../core/resolve.js";
import { envReferences, MCP_FILE, mcpServers, outName, ownRuleRefs, textFile } from "./shared.js";
import type { EmitBase, Emitter, PlannedFile } from "./types.js";

/** The `$schema` OpenCode's own configuration files name (spec 63 §8). */
const OPENCODE_SCHEMA = "https://opencode.ai/config.json";

/**
 * OpenCode target (spec 63): an agent to `.opencode/agents/<name>.md` with `permissions` derived from its `tools` (§6), a command
 * to `.opencode/commands/<name>.md`, and the MCP servers to `.opencode/opencode.json`, a file holding only `$schema` and
 * `mcp.servers`. Rules reach OpenCode through `agents-md` and skills through `agent-skills` (or `claude-code` for a folder skill);
 * the matrix warns for every other type. Text keeps the line endings of the file it replaces (LF when new), no BOM.
 */
export const opencode: Emitter<"opencode"> = {
  target: "opencode",
  async emit(ctx) {
    const out: PlannedFile[] = [];
    const t = "opencode";
    const refs = ownRuleRefs(ctx, t);
    const mcp: ResolvedIngredient[] = [];
    for (const ing of ctx.aimed) {
      const m = ctx.meta(ing);
      switch (m.type) {
        case "agent": {
          const name = outName(m);
          const body = refs.resolve(await ctx.text(ing, m.file, t), ing.ref);
          const lines: string[] = [];
          if (!m.description) ctx.warn(`opencode: agent "${name}" has no description, which OpenCode uses to pick a subagent; written empty`);
          lines.push(`description: ${JSON.stringify(m.description ?? "")}`);
          // A Forge agent is a Claude Code subagent; OpenCode's default `primary` would make it a top-level agent.
          lines.push(`mode: ${JSON.stringify("subagent")}`);
          if (m.model && m.model !== "inherit") {
            if (OPENCODE_MODEL.test(m.model)) lines.push(`model: ${JSON.stringify(m.model)}`);
            else ctx.warn(`opencode: agent "${name}": model is not in OpenCode's provider/model form; dropped`);
          }
          const rules = opencodePermissions(name, m.tools ?? [], ctx);
          if (rules) {
            lines.push("permissions:");
            for (const r of rules)
              lines.push(`  - action: ${JSON.stringify(r.action)}`, `    resource: ${JSON.stringify(r.resource)}`, `    effect: ${JSON.stringify(r.effect)}`);
          }
          const doc = `---\n${lines.join("\n")}\n---\n\n${body}`;
          out.push(await textFile(ctx, `.opencode/agents/${name}.md`, doc, t, ing.ref, { keepBom: false }));
          break;
        }
        case "command": {
          const name = outName(m);
          const body = refs.resolve(await ctx.text(ing, m.file, t), ing.ref);
          if (!m.description) ctx.warn(`opencode: command "${name}" has no description; written empty`);
          if (m.argumentHint) ctx.warn(`opencode: command "${name}": argument-hint has no OpenCode field; dropped`);
          if (m.allowedTools) ctx.warn(`opencode: command "${name}": allowed-tools has no OpenCode field; dropped`);
          const doc = `---\ndescription: ${JSON.stringify(m.description ?? "")}\n---\n\n${body}`;
          out.push(await textFile(ctx, `.opencode/commands/${name}.md`, doc, t, ing.ref, { keepBom: false }));
          break;
        }
        case "mcp":
          mcp.push(ing);
          break;
        default: {
          const never: never = m;
          throw new Error(`internal: ${t} has no case for ${(never as Ingredient).type}`);
        }
      }
    }
    refs.finish();
    if (mcp.length) {
      // mcpServers renders and runs credentialIn first; the reshape after it changes no value it checked.
      const rendered = mcpServers(ctx, t, MCP_FILE.opencode, mcp);
      const servers: Record<string, unknown> = Object.create(null);
      for (const [key, server] of Object.entries(rendered)) {
        const shaped = reshapeServer(key, server, ctx);
        if (!shaped) continue;
        const left: string[] = [];
        servers[key] = envReferences(shaped, "opencode", left);
        for (const name of [...new Set(left)]) ctx.warn(`opencode: MCP server "${key}": \${${name}} has no OpenCode form; left as written`);
      }
      const doc = { $schema: OPENCODE_SCHEMA, mcp: { servers } };
      out.push(await textFile(ctx, MCP_FILE.opencode, JSON.stringify(doc, null, 2) + "\n", t, "mcp/*", { keepBom: false }));
    }
    return out;
  },
};

/** OpenCode's model form: a provider, a `/`, a model (which may hold more `/`), optionally `#<variant>` (spec 63 §5). */
const OPENCODE_MODEL = /^[^\s/#]+\/[^\s#]+(#[^\s#]+)?$/;

/** The keys OpenCode defines that a Forge server may carry through its open shape, copied as they are (spec 63 §8). */
const COPIED_KEYS = ["cwd", "timeout", "disabled", "oauth"] as const;

/** Claude Code's server shape reshaped into OpenCode's `mcp.servers.<name>`; null (and a warning) when it cannot be. */
function reshapeServer(key: string, raw: unknown, ctx: EmitBase): Record<string, unknown> | null {
  const s = (raw ?? {}) as Record<string, unknown>;
  const type = s.type;
  const command = typeof s.command === "string" ? s.command : undefined;
  const url = typeof s.url === "string" ? s.url : undefined;
  let kind: "local" | "remote";
  if (type === undefined) kind = command === undefined && url !== undefined ? "remote" : "local";
  else if (type === "stdio" || type === "local") kind = "local";
  else if (type === "http" || type === "sse" || type === "remote") kind = "remote";
  else {
    ctx.warn(`opencode: MCP server "${key}": type ${JSON.stringify(type)} has no OpenCode form; skipped`);
    return null;
  }
  const out: Record<string, unknown> = { type: kind };
  const used = new Set<string>(["type", ...COPIED_KEYS]);
  if (kind === "local") {
    if (command === undefined) {
      ctx.warn(`opencode: MCP server "${key}": no command for a local server; skipped`);
      return null;
    }
    const args = Array.isArray(s.args) ? s.args : [];
    out.command = [command, ...args];
    if (isNonEmptyObject(s.env)) out.environment = s.env;
    used.add("command").add("args").add("env");
    if (url !== undefined && type === undefined) {
      ctx.warn(`opencode: MCP server "${key}": both command and url — written as a local server, url dropped`);
      used.add("url");
    }
  } else {
    if (url === undefined) {
      ctx.warn(`opencode: MCP server "${key}": no url for a remote server; skipped`);
      return null;
    }
    out.url = url;
    if (isNonEmptyObject(s.headers)) out.headers = s.headers;
    used.add("url").add("headers");
    if (type === "sse") ctx.warn(`opencode: MCP server "${key}": an sse server was not measured against OpenCode, which speaks Streamable HTTP`);
  }
  for (const k of COPIED_KEYS) if (s[k] !== undefined) out[k] = s[k];
  for (const k of Object.keys(s)) if (!used.has(k)) ctx.warn(`opencode: MCP server "${key}": key ${JSON.stringify(k)} has no OpenCode field; dropped`);
  return out;
}

function isNonEmptyObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0;
}

/* ------------------------------------------------------------------ */
/* Permissions (spec 63 §6, O2, O3)                                    */

interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "ask" | "deny";
}

/** How a scope (`Tool(<scope>)`) becomes a resource: a path, a shell command, a WebFetch domain, a skill id, or none taken. */
type ScopeKind = "path" | "command" | "domain" | "id" | "none";

/** The one table of a Forge tool's OpenCode action (spec 63 §6), keyed by the tool's name without case. */
const OPENCODE_ACTIONS: Record<string, { action: string; scope: ScopeKind }> = {
  read: { action: "read", scope: "path" },
  write: { action: "edit", scope: "path" },
  edit: { action: "edit", scope: "path" },
  multiedit: { action: "edit", scope: "path" },
  notebookedit: { action: "edit", scope: "path" },
  glob: { action: "glob", scope: "none" },
  ls: { action: "glob", scope: "none" },
  grep: { action: "grep", scope: "none" },
  bash: { action: "shell", scope: "command" },
  webfetch: { action: "webfetch", scope: "domain" },
  websearch: { action: "websearch", scope: "none" },
  task: { action: "subagent", scope: "none" },
  agent: { action: "subagent", scope: "none" },
  skill: { action: "skill", scope: "id" },
  askuserquestion: { action: "question", scope: "none" },
};

/** The actions that read or write files, after any of which reading outside the project is asked about (rule 4). */
const FILE_ACTIONS = new Set(["read", "edit", "glob", "grep"]);

/** An MCP server or tool name written as it is until OpenCode's normalisation is measured (spec 63 Q3). */
const MCP_NAME = /^[A-Za-z0-9_]+$/;

/**
 * The one derivation of an agent's `permissions` from its `tools` (spec 63 §6): null for no tools or `*` (the base policy);
 * otherwise `deny *` first, one `allow` per mapped tool in the Forge's order (a duplicate written once at its first place), the
 * `.env` rules after each `allow read`, and `external_directory` asked last when a file action is allowed. A tool or a scope
 * the table cannot translate gets no rule and one warning, so it stays denied: never looser than the Forge asked.
 */
function opencodePermissions(agent: string, tools: readonly string[], ctx: EmitBase): PermissionRule[] | null {
  if (tools.length === 0 || tools.some((x) => x.trim() === "*")) return null;
  const rules: PermissionRule[] = [{ action: "*", resource: "*", effect: "deny" }];
  const seen = new Set<string>();
  let fileAction = false;
  for (const raw of tools) {
    const tool = raw.trim();
    const m = /^([^(]*)\((.*)\)$/s.exec(tool);
    const name = (m ? m[1] : tool).trim();
    const scope = m ? m[2] : undefined;
    let action: string;
    let resource: string | null;
    if (name.startsWith("mcp__")) {
      const rest = name.slice("mcp__".length);
      const cut = rest.indexOf("__");
      const server = cut < 0 ? rest : rest.slice(0, cut);
      const fn = cut < 0 ? null : rest.slice(cut + 2);
      if (scope !== undefined || !MCP_NAME.test(server) || (fn !== null && !MCP_NAME.test(fn))) {
        ctx.warn(`opencode: agent "${agent}": tool "${tool}" has no OpenCode permission; no rule written`);
        continue;
      }
      action = fn === null ? `${server}_*` : `${server}_${fn}`;
      resource = "*";
    } else {
      const row = OPENCODE_ACTIONS[name.toLowerCase()];
      if (!row) {
        ctx.warn(`opencode: agent "${agent}": tool "${tool}" has no OpenCode permission; no rule written`);
        continue;
      }
      action = row.action;
      resource = scope === undefined ? "*" : scopeResource(row.scope, scope);
      if (resource === null) {
        ctx.warn(`opencode: agent "${agent}": tool "${tool}": its scope cannot be translated; no rule written`);
        continue;
      }
    }
    const k = `${action}\u0000${resource}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rules.push({ action, resource, effect: "allow" });
    if (FILE_ACTIONS.has(action)) fileAction = true;
    if (action === "read") {
      // A later `allow read` would override the base policy's `.env` rules (the last match wins): restore them, never looser.
      if (resource === "*") {
        rules.push({ action: "read", resource: "*.env", effect: "ask" }, { action: "read", resource: "*.env.*", effect: "ask" }, { action: "read", resource: "*.env.example", effect: "allow" });
      } else {
        rules.push({ action: "read", resource: "*.env", effect: "deny" }, { action: "read", resource: "*.env.*", effect: "deny" });
      }
    }
  }
  if (fileAction) rules.push({ action: "external_directory", resource: "*", effect: "ask" });
  return rules;
}

/** A scope as OpenCode's resource, or null when it cannot be translated (spec 63 §6). */
function scopeResource(kind: ScopeKind, scope: string): string | null {
  const s = scope.trim();
  if (s === "") return null;
  switch (kind) {
    case "none":
      return null;
    case "id":
      return s;
    case "command":
      return s.endsWith(":*") ? `${s.slice(0, -2)} *` : s;
    case "domain": {
      const m = /^domain:([A-Za-z0-9.-]+)$/.exec(s);
      return m ? `https://${m[1]}/*` : null;
    }
    case "path": {
      if (s.startsWith("//")) return s.slice(1);
      if (s.startsWith("~/")) return s;
      if (s.startsWith("./")) return s.slice(2) || null;
      if (s.startsWith("/")) return s.slice(1) || null;
      if (s.startsWith("~") || s.startsWith("../") || s === ".." || s.includes("/../") || s.startsWith("\\")) return null;
      return s;
    }
  }
}
