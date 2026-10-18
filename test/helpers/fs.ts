import { promises as fs } from "node:fs";

/**
 * Removes a file or a directory for a test's cleanup, retrying a busy one: Windows can report EBUSY on a copy of
 * node a test has just run (a lingering handle, or a scan). Node retries only with `recursive: true` (harmless on a
 * file); its backoff is linear, so 6 × 200 ms waits at most 4.2 s — inside vitest's 10 s hook timeout, twice. An
 * error that outlasts the retries still throws.
 */
export const removeWithRetry = (p: string): Promise<void> => fs.rm(p, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
