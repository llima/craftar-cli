import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The file URL of tsx's public entry point, resolved through Node's resolver from the repository
 * (so it follows whatever tsx's `exports["."]` names instead of hardcoding a file inside the
 * package). Absolute, so `node --import <it>` works from a cwd outside the repository.
 */
export const TSX_LOADER = pathToFileURL(createRequire(path.join(REPO, "package.json")).resolve("tsx")).href;
