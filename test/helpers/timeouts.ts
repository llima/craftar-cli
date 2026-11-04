// An explicit limit never cuts below vitest's win32 default (vitest.config.ts).
export const WIN32_TEST_TIMEOUT = 180_000;
export function atLeastWin32(ms: number): number { return process.platform === "win32" ? Math.max(ms, WIN32_TEST_TIMEOUT) : ms; }
