/**
 * The deliberate delta of doctor's `hook-command` check (the install-test feedback of 2026-11-09), filtered by id out of the
 * off pins whose doctor child runs with a PATH of one empty directory: there every program a hook names is "not on PATH",
 * so the line depends on that PATH, not on what the pin proves. test/doctor-hook-command.test.ts proves the check itself.
 */
export const HOOK_COMMAND = "hook-command";

export function withoutHookCommand<T extends { id: string }>(checks: T[]): T[] {
  return checks.filter((c) => c.id !== HOOK_COMMAND);
}
