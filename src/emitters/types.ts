import type { Forge } from "../core/forge.js";
import type { Resolution, ResolvedIngredient } from "../core/resolve.js";
import type { Target } from "../schema/index.js";

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

export interface EmitContext {
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

export interface Emitter {
  target: Target;
  emit(ctx: EmitContext): Promise<PlannedFile[]>;
}
