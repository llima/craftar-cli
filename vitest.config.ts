import { defineConfig } from "vitest/config";
// maxWorkers: with no cap vitest starts one worker per core (27 on a 32-core machine) and each
// worker of cli.test.ts grows past 3 GB; on 2026-10-08 that exhausted the machine's RAM (123 GB).
export default defineConfig({ test: { include: ["test/**/*.test.ts"], setupFiles: ["test/setup/craftar-home.ts"], testTimeout: 30000, maxWorkers: 6 } });
