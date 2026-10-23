import { afterEach, describe, expect, it } from "vitest";
import { acmePrimary } from "./helpers/agents-md-primary.js";
import { loadWorkspace, plan } from "../src/core/sync.js";
import { reservedKey } from "../src/core/extract.js";
import type { Scenario } from "./helpers/forge.js";

/**
 * Spec 41 §11.2: Unit tests for agents-md.primary resolution logic.
 */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const kept = <T extends Scenario>(s: T): T => (cleanups.push(s.cleanup), s);

describe("Resolution.primary (spec 41 §4.1)", () => {
  it("schema 5, no key → primary false, no agents-md.primary warning", async () => {
    const s = kept(await acmePrimary({ schema: 5 }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    expect(p.resolution.primary).toBe(false);
    const primaryWarnings = p.warnings.filter((w) => w.includes("agents-md.primary"));
    expect(primaryWarnings).toEqual([]);
  });

  it("schema 5, agents-md.primary: true → primary true, no warning", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": true } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    expect(p.resolution.primary).toBe(true);
    const primaryWarnings = p.warnings.filter((w) => w.includes("agents-md.primary"));
    expect(primaryWarnings).toEqual([]);
  });

  it("schema 4, agents-md.primary: true → primary false, warning about schema", async () => {
    const s = kept(await acmePrimary({ schema: 4, params: { "agents-md.primary": true } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    expect(p.resolution.primary).toBe(false);
    const primaryWarnings = p.warnings.filter((w) => w.includes("agents-md.primary"));
    expect(primaryWarnings).toHaveLength(1);
    expect(primaryWarnings[0]).toContain("needs a Forge at schema: 5 — the mode is off");
  });

  it("schema 4, agents-md.primary: 'yes' → primary false, no warning", async () => {
    // Any non-true value below the gate produces no warning
    const s = kept(await acmePrimary({ schema: 4, params: { "agents-md.primary": "yes" } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    expect(p.resolution.primary).toBe(false);
    const primaryWarnings = p.warnings.filter((w) => w.includes("agents-md.primary"));
    expect(primaryWarnings).toEqual([]);
  });

  it("schema 5, agents-md.primary: 'true' (string) → primary false, type warning", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": "true" } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    expect(p.resolution.primary).toBe(false);
    const primaryWarnings = p.warnings.filter((w) => w.includes("agents-md.primary"));
    expect(primaryWarnings).toHaveLength(1);
    expect(primaryWarnings[0]).toContain("must be true or false — the mode is off");
  });

  it("schema 5, agents-md.primary: true, targets without agents-md → primary false, no-effect warning", async () => {
    const s = kept(
      await acmePrimary({
        schema: 5,
        params: { "agents-md.primary": true },
        wsConfig: { targets: ["claude-code", "kiro"] },
      }),
    );
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    expect(p.resolution.primary).toBe(false);
    const primaryWarnings = p.warnings.filter((w) => w.includes("agents-md.primary"));
    expect(primaryWarnings).toHaveLength(1);
    expect(primaryWarnings[0]).toContain("has no effect without the agents-md target");
  });

  it("schema 5, agents-md.primary: false → primary false, no warning", async () => {
    const s = kept(await acmePrimary({ schema: 5, params: { "agents-md.primary": false } }));
    const ws = await loadWorkspace(s.wsRoot, { home: process.env.CRAFTAR_HOME });
    const p = await plan(ws);
    expect(p.resolution.primary).toBe(false);
    const primaryWarnings = p.warnings.filter((w) => w.includes("agents-md.primary"));
    expect(primaryWarnings).toEqual([]);
  });
});

describe("reservedKey with agents-md.primary (spec 41 §4.1)", () => {
  it("agents-md.primary is reserved at schema 1", () => {
    expect(reservedKey("agents-md.primary", 1)).toBe(true);
  });

  it("agents-md.primary is reserved at schema 5", () => {
    expect(reservedKey("agents-md.primary", 5)).toBe(true);
  });
});
