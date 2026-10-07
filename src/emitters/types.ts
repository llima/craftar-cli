import type { Forge } from "../core/forge.js";
import type { Resolution, ResolvedIngredient } from "../core/resolve.js";
import type { Target } from "../schema/index.js";
import type { Walk } from "../core/capabilities.js";

export interface PlannedFile {
  /** Workspace-relative path, POSIX separators. */
  path: string;
  /** Final bytes to write. */
  content: Buffer;
  target: Target;
  ingredient: string;
  /** Human-readable note surfaced by `craftar explain`. */
  note?: string;
}

/** What every helper needs; an emitter also gets its walk (`EmitContext`). */
export interface EmitBase {
  forge: Forge;
  resolution: Resolution;
  workspaceRoot: string;
  /** Read the current bytes of a workspace file, or null when it does not exist. */
  readExisting(relPath: string): Promise<Buffer | null>;
  /** Read a file inside an ingredient dir as UTF-8 text with LF line endings and params substituted. */
  text(ing: ResolvedIngredient, file: string): Promise<string>;
  /** Raw bytes of a file inside an ingredient dir (binary-safe, no substitution). */
  bytes(ing: ResolvedIngredient, file: string): Promise<Buffer>;
  warn(msg: string): void;
}

/** An emitter's context: the base, plus the ingredients the matrix says target T writes (spec 18 §3.1). */
export type EmitContext<T extends Target> = EmitBase & { aimed: Walk<T> };

export interface Emitter<T extends Target> {
  target: T;
  emit(ctx: EmitContext<T>): Promise<PlannedFile[]>;
}
