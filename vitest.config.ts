import { defineConfig } from "vitest/config";
// maxWorkers: with no cap vitest starts one worker per core (27 on a 32-core machine) and each
// worker of cli.test.ts grows past 3 GB; on 2026-10-08 that exhausted the machine's RAM (123 GB).
// testTimeout: on Windows CI, tests that take 1–25 s normally ran 61–138 s during 3–5 minute bursts in which every
// file running at that moment slowed 2–20x (measured over 44 windows-latest jobs, 2026-11-04); 180 s absorbs the
// worst seen (137.7 s); the 35-minute job limit stays the backstop.
// hookTimeout: 30 s on Windows only. An afterEach that removes three git-used directories through removeWithRetry
// can pass vitest's 10 s default there (seen in three ci runs, 2026-11-02). Elsewhere the default stays.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], setupFiles: ["test/setup/craftar-home.ts"], testTimeout: process.platform === "win32" ? 180000 : 30000, hookTimeout: process.platform === "win32" ? 30000 : 10000, maxWorkers: 6 } });
