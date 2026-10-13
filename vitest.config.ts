import { defineConfig } from "vitest/config";
// maxWorkers: with no cap vitest starts one worker per core (27 on a 32-core machine) and each
// worker of cli.test.ts grows past 3 GB; on 2026-10-08 that exhausted the machine's RAM (123 GB).
// testTimeout: 60 s on Windows only. A CLI child costs about three times what it costs on Linux there, and
// the CI runners now and then run one test at 2.5 times its usual time: tests that normally take 12–17 s
// passed 30 s three times in two days (2026-10-12 and 13) and passed when run again. Elsewhere 30 s stays.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], setupFiles: ["test/setup/craftar-home.ts"], testTimeout: process.platform === "win32" ? 60000 : 30000, maxWorkers: 6 } });
