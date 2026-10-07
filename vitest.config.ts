import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"], setupFiles: ["test/setup/craftar-home.ts"], testTimeout: 30000 } });
