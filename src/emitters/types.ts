import type { Forge } from "../core/forge.js";
import type { Resolution, ResolvedIngredient } from "../core/resolve.js";
import type { Owner, Target } from "../schema/index.js";
import type { Walk } from "../core/capabilities.js";

export interface PlannedFile {
  /** Workspace-relative path, POSIX separators. */
  path: string;
  /** Final bytes to write. */
  content: Buffer;
  target: Owner;
  ingredient: string;
  /** Human-readable note surfaced by `craftar explain`. */
  note?: string;
  /** File mode (POSIX only); when set, writeFile sets this mode. */
  mode?: number;
}

/** What every helper needs; an emitter also gets its walk (`EmitContext`). */
export interface EmitBase {
  forge: Forge;
  resolution: Resolution;
  workspaceRoot: string;
  /** Read the current bytes of a workspace file, or null when it does not exist. */
  readExisting(relPath: string): Promise<Buffer | null>;
  /** Read a file inside an ingredient dir as UTF-8 text with LF line endings, sections projected and params substituted. */
  text(ing: ResolvedIngredient, file: string, owner: Owner): Promise<string>;
  /** Raw bytes of a file inside an ingredient dir (binary-safe, no substitution). */
  bytes(ing: ResolvedIngredient, file: string): Promise<Buffer>;
  warn(msg: string): void;
  /** Joins a missing declared parameter to the plan's `missingParams` (spec 34 §5.2). */
  missing(key: string, ref: string): void;
  /** A warning said once per plan, whichever targets raise it (spec 34 §5.2). */
  warnOnce(msg: string): void;
  /** Reports a rule's byte size for the AGENTS.md budget (called by the agents-md emitter). */
  reportAgentsMdRule(name: string, bytes: number, scoped: boolean): void;
  /** Records a planned text the emitter reworded because of agents-md.primary (spec 41 §4.4). */
  reportReworded(path: string): void;
  /** Records a hand-written Kiro agent resources entry to check against the plan (spec 41 §4.5). */
  reportKiroResource(agent: string, path: string): void;
  /** Reports a rules index expansion result (spec 44 §4.4). */
  reportIndex(entry: { path: string; rules: number; undescribed: string[]; misplaced?: number[] }): void;
  /** Reports a path where the placeholder was left as written (other types or not alone on line, spec 44 §4.5). */
  reportIndexLeft(path: string): void;
}

/** An emitter's context: the base, plus the ingredients the matrix says target T writes (spec 18 §3.1). */
export type EmitContext<T extends Target> = EmitBase & { aimed: Walk<T> };

export interface Emitter<T extends Target> {
  target: T;
  emit(ctx: EmitContext<T>): Promise<PlannedFile[]>;
}
