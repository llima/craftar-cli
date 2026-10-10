import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { runCli } from "./helpers/cli.js";
import { profile, recipe, rule, type ForgeSpec, type WorkspaceSpec } from "./helpers/forge.js";
import { ado, forgeAt, mcp, PM, sync, STORIES_ACME } from "./helpers/integrations.js";

// Spec 33 §4.3, §4.4, §4.5, §9.2 — an integration that cannot be honoured fails where an unknown recipe does.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function at(schema: number, spec: ForgeSpec, ws: WorkspaceSpec = { config: { profile: "acme" } }) {
  const s = await forgeAt(schema, spec, ws);
  cleanups.push(s.cleanup);
  return s;
}

const NO_RECIPE = 'recipe "pm-jira" not found (referenced by integrations.pm of profile acme)';
const MALFORMED = "profile acme: integrations.pm is not a mapping";

describe("NO_RECIPE — kind with no recipe", () => {
  const block = { pm: { kind: "jira", org: "acme" } };

  it("1. the five resolving commands exit 1 with the error", async () => {
    const { wsRoot } = await at(3, ado({}, block));
    const env = { CRAFTAR_HOME: path.join(path.dirname(wsRoot), "home") };

    for (const args of [["sync"], ["status"], ["diff"], ["ls"], ["explain", ".claude/rules/where.md"]]) {
      const r = runCli([...args, "--workspace", wsRoot], { env });
      expect([r.code, r.stdout, r.stderr], args.join(" ")).toEqual([1, "", `error: ${NO_RECIPE}\n`]);
    }

    // After sync: neither .claude nor craftar.lock exists
    expect(await fs.access(path.join(wsRoot, ".claude")).then(() => true, () => false)).toBe(false);
    expect(await fs.access(path.join(wsRoot, "craftar.lock")).then(() => true, () => false)).toBe(false);
  });

  it("2. recipes marks nothing in use and warns", async () => {
    const { wsRoot } = await at(3, ado({}, block));
    const env = { CRAFTAR_HOME: path.join(path.dirname(wsRoot), "home") };

    const r = runCli(["recipes", "--workspace", wsRoot], { env });
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")).toContain(
      `  warn cannot resolve this workspace (profile acme): ${NO_RECIPE} — nothing is marked as in use`,
    );
    expect(r.stdout.split("\n").filter((l) => l.startsWith("  warn"))).toHaveLength(1);

    const rj = runCli(["recipes", "--workspace", wsRoot, "--json"], { env });
    expect(rj.code).toBe(0);
    const j = JSON.parse(rj.stdout);
    expect(j.context).toBeNull();
    for (const rec of j.recipes) expect(rec.inUse).toBeNull();
    expect(j.warnings).toEqual([
      `cannot resolve this workspace (profile acme): ${NO_RECIPE} — nothing is marked as in use`,
    ]);
  });

  it("3. doctor reports it under plan", async () => {
    const { wsRoot } = await at(3, ado({}, block));
    const env = { CRAFTAR_HOME: path.join(path.dirname(wsRoot), "home") };

    const r = runCli(["doctor", "--workspace", wsRoot, "--json"], { env });
    expect(r.code).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j.checks.filter((c: { id: string }) => c.id === "plan")).toEqual([
      { id: "plan", scope: "workspace", level: "error", message: NO_RECIPE, fix: null },
    ]);
  });

  it("4. workspaces and forge impact show error", async () => {
    // Start from the valid Forge, sync to register, then break it
    const { forgeRoot, wsRoot, root } = await at(3, ado());
    const env = { CRAFTAR_HOME: path.join(root, "home") };

    // Sync to register
    const syncR = runCli(["sync", "--workspace", wsRoot], { env });
    expect(syncR.code, syncR.stderr).toBe(0);

    // Break the profile by writing the bad block
    const profilePath = path.join(forgeRoot, "profiles/acme/profile.yaml");
    const profileContent = YAML.parse(await fs.readFile(profilePath, "utf8"));
    profileContent.integrations = block;
    await fs.writeFile(profilePath, YAML.stringify(profileContent));

    // workspaces --json
    const wsR = runCli(["workspaces", "--json"], { env });
    expect(wsR.code, wsR.stderr).toBe(0);
    const wsJ = JSON.parse(wsR.stdout);
    expect(wsJ.workspaces.length).toBe(1);
    expect(wsJ.workspaces[0].status).toBe("error");

    // forge impact --json
    const impR = runCli(["forge", "impact", "--forge", forgeRoot, "--json"], { env });
    expect(impR.code, impR.stderr).toBe(0);
    const impJ = JSON.parse(impR.stdout);
    expect(impJ.workspaces[0].state).toBe("error");
    expect(impJ.workspaces[0].error).toBe(NO_RECIPE);
  });
});

describe("MALFORMED — slot is not a mapping", () => {
  const block = { pm: "x" };

  it("1. the five resolving commands exit 1 with the error", async () => {
    const { wsRoot } = await at(3, ado({}, block));
    const env = { CRAFTAR_HOME: path.join(path.dirname(wsRoot), "home") };

    for (const args of [["sync"], ["status"], ["diff"], ["ls"], ["explain", ".claude/rules/where.md"]]) {
      const r = runCli([...args, "--workspace", wsRoot], { env });
      expect([r.code, r.stdout, r.stderr], args.join(" ")).toEqual([1, "", `error: ${MALFORMED}\n`]);
    }

    // After sync: neither .claude nor craftar.lock exists
    expect(await fs.access(path.join(wsRoot, ".claude")).then(() => true, () => false)).toBe(false);
    expect(await fs.access(path.join(wsRoot, "craftar.lock")).then(() => true, () => false)).toBe(false);
  });

  it("2. recipes marks nothing in use and warns", async () => {
    const { wsRoot } = await at(3, ado({}, block));
    const env = { CRAFTAR_HOME: path.join(path.dirname(wsRoot), "home") };

    const r = runCli(["recipes", "--workspace", wsRoot], { env });
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")).toContain(
      `  warn cannot resolve this workspace (profile acme): ${MALFORMED} — nothing is marked as in use`,
    );
    expect(r.stdout.split("\n").filter((l) => l.startsWith("  warn"))).toHaveLength(1);

    const rj = runCli(["recipes", "--workspace", wsRoot, "--json"], { env });
    expect(rj.code).toBe(0);
    const j = JSON.parse(rj.stdout);
    expect(j.context).toBeNull();
    for (const rec of j.recipes) expect(rec.inUse).toBeNull();
    expect(j.warnings).toEqual([
      `cannot resolve this workspace (profile acme): ${MALFORMED} — nothing is marked as in use`,
    ]);
  });

  it("3. doctor reports it under plan", async () => {
    const { wsRoot } = await at(3, ado({}, block));
    const env = { CRAFTAR_HOME: path.join(path.dirname(wsRoot), "home") };

    const r = runCli(["doctor", "--workspace", wsRoot, "--json"], { env });
    expect(r.code).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j.checks.filter((c: { id: string }) => c.id === "plan")).toEqual([
      { id: "plan", scope: "workspace", level: "error", message: MALFORMED, fix: null },
    ]);
  });

  it("4. workspaces and forge impact show error", async () => {
    // Start from the valid Forge, sync to register, then break it
    const { forgeRoot, wsRoot, root } = await at(3, ado());
    const env = { CRAFTAR_HOME: path.join(root, "home") };

    // Sync to register
    const syncR = runCli(["sync", "--workspace", wsRoot], { env });
    expect(syncR.code, syncR.stderr).toBe(0);

    // Break the profile by writing the bad block
    const profilePath = path.join(forgeRoot, "profiles/acme/profile.yaml");
    const profileContent = YAML.parse(await fs.readFile(profilePath, "utf8"));
    profileContent.integrations = block;
    await fs.writeFile(profilePath, YAML.stringify(profileContent));

    // workspaces --json
    const wsR = runCli(["workspaces", "--json"], { env });
    expect(wsR.code, wsR.stderr).toBe(0);
    const wsJ = JSON.parse(wsR.stdout);
    expect(wsJ.workspaces.length).toBe(1);
    expect(wsJ.workspaces[0].status).toBe("error");

    // forge impact --json
    const impR = runCli(["forge", "impact", "--forge", forgeRoot, "--json"], { env });
    expect(impR.code, impR.stderr).toBe(0);
    const impJ = JSON.parse(impR.stdout);
    expect(impJ.workspaces[0].state).toBe("error");
    expect(impJ.workspaces[0].error).toBe(MALFORMED);
  });
});

describe("Valid schema 3 Forge — key sets and lock unchanged", () => {
  it("5. status --json and forge impact --json keep the key sets", async () => {
    // Scenario 1: integrations block selects the recipe
    const { forgeRoot: f1, wsRoot: ws1, root: r1 } = await at(3, ado());
    const env1 = { CRAFTAR_HOME: path.join(r1, "home") };
    const sync1 = runCli(["sync", "--workspace", ws1], { env: env1 });
    expect(sync1.code, sync1.stderr).toBe(0);

    // Scenario 2: the recipe listed by hand at schema 2
    const { forgeRoot: f2, wsRoot: ws2, root: r2 } = await at(
      2,
      ado({}, PM, { recipes: ["base", "pm-azure-devops"], params: { "integrations.pm.org": "acme", "integrations.pm.project": "Platform" } }),
    );
    const env2 = { CRAFTAR_HOME: path.join(r2, "home") };
    const sync2 = runCli(["sync", "--workspace", ws2], { env: env2 });
    expect(sync2.code, sync2.stderr).toBe(0);

    // status --json keys
    const st1 = JSON.parse(runCli(["status", "--workspace", ws1, "--json"], { env: env1 }).stdout);
    const st2 = JSON.parse(runCli(["status", "--workspace", ws2, "--json"], { env: env2 }).stdout);

    expect(Object.keys(st1)).toEqual(["forge", "statuses", "warnings", "unsetParams"]);
    expect(Object.keys(st2)).toEqual(["forge", "statuses", "warnings", "unsetParams"]);
    expect(Object.keys(st1.forge)).toEqual(["kind", "source", "ref", "defaultBranch", "commit", "lockCommit", "fetched"]);
    expect(Object.keys(st2.forge)).toEqual(["kind", "source", "ref", "defaultBranch", "commit", "lockCommit", "fetched"]);

    // The two scenarios' statuses.map should be equal
    const map1 = st1.statuses.map((x: { path: string; state: string }) => [x.path, x.state, Object.keys(x)]);
    const map2 = st2.statuses.map((x: { path: string; state: string }) => [x.path, x.state, Object.keys(x)]);
    expect(map1).toEqual(map2);

    // forge impact --json keys
    const imp1 = JSON.parse(runCli(["forge", "impact", "--forge", f1, "--json"], { env: env1 }).stdout);
    const imp2 = JSON.parse(runCli(["forge", "impact", "--forge", f2, "--json"], { env: env2 }).stdout);

    expect(Object.keys(imp1)).toEqual(["forge", "registry", "workspaces"]);
    expect(Object.keys(imp2)).toEqual(["forge", "registry", "workspaces"]);
    expect(Object.keys(imp1.workspaces[0])).toEqual(["path", "profile", "match", "via", "ref", "state", "counts", "error"]);
    expect(Object.keys(imp2.workspaces[0])).toEqual(["path", "profile", "match", "via", "ref", "state", "counts", "error"]);
  });

  it("6. the lock records the integration recipe among the resolved ones, with no new key", async () => {
    // Scenario 1: integrations block selects the recipe
    const { wsRoot: ws1, root: r1 } = await at(3, ado());
    const env1 = { CRAFTAR_HOME: path.join(r1, "home") };
    const sync1 = runCli(["sync", "--workspace", ws1], { env: env1 });
    expect(sync1.code, sync1.stderr).toBe(0);

    // Scenario 2: the recipe listed by hand at schema 2
    const { wsRoot: ws2, root: r2 } = await at(
      2,
      ado({}, PM, { recipes: ["base", "pm-azure-devops"], params: { "integrations.pm.org": "acme", "integrations.pm.project": "Platform" } }),
    );
    const env2 = { CRAFTAR_HOME: path.join(r2, "home") };
    const sync2 = runCli(["sync", "--workspace", ws2], { env: env2 });
    expect(sync2.code, sync2.stderr).toBe(0);

    const lock1 = JSON.parse(await fs.readFile(path.join(ws1, "craftar.lock"), "utf8"));
    const lock2 = JSON.parse(await fs.readFile(path.join(ws2, "craftar.lock"), "utf8"));

    expect(Object.keys(lock1)).toEqual(Object.keys(lock2));
    expect(lock1.recipes).toEqual(["base", "pm-azure-devops"]);
    expect(lock2.recipes).toEqual(["base", "pm-azure-devops"]);
  });

  it("7. a non-scalar value is warned by sync, recipes and doctor", async () => {
    const block = { pm: { ...PM.pm, labels: ["a"] } };
    const W = "profile acme: integrations.pm.labels is not a scalar — not available as a param";

    const { wsRoot, root } = await at(3, ado({}, block));
    const env = { CRAFTAR_HOME: path.join(root, "home") };

    // sync exits 0 and warns
    const syncR = runCli(["sync", "--workspace", wsRoot], { env });
    expect(syncR.code, syncR.stderr).toBe(0);
    expect(syncR.stdout.split("\n")).toContain(`  warn ${W}`);

    // recipes --json
    const recR = runCli(["recipes", "--workspace", wsRoot, "--json"], { env });
    expect(recR.code).toBe(0);
    const recJ = JSON.parse(recR.stdout);
    expect(recJ.warnings).toEqual([W]);

    // doctor --json
    const docR = runCli(["doctor", "--workspace", wsRoot, "--json"], { env });
    expect(docR.code).toBe(0);
    const docJ = JSON.parse(docR.stdout);
    expect(docJ.checks.filter((c: { id: string }) => c.id === "plan")).toEqual([
      { id: "plan", scope: "workspace", level: "warn", message: W, fix: null },
    ]);
  });

  it("8. init needs nothing new", async () => {
    const { forgeRoot, root } = await at(3, ado());
    const env = { CRAFTAR_HOME: path.join(root, "home") };

    const d = path.join(root, "new-ws");
    await fs.mkdir(d);

    const r = runCli(["init", "--forge", forgeRoot, "--profile", "acme", "--workspace", d], { env });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("recipes base → pm-azure-devops");

    const ruleContent = await fs.readFile(path.join(d, ".claude/rules/stories-azure-devops.md"), "utf8");
    expect(ruleContent).toBe(STORIES_ACME);
  });

  it("9. doctor prints for a healthy schema 3 workspace what it prints for the hand-listed schema 2 one", async () => {
    // Scenario 1: integrations block selects the recipe
    const { wsRoot: ws1, root: r1 } = await at(3, ado());
    const env1 = { CRAFTAR_HOME: path.join(r1, "home") };
    const sync1 = runCli(["sync", "--workspace", ws1], { env: env1 });
    expect(sync1.code, sync1.stderr).toBe(0);

    // Scenario 2: the recipe listed by hand at schema 2
    const { wsRoot: ws2, root: r2 } = await at(
      2,
      ado({}, PM, { recipes: ["base", "pm-azure-devops"], params: { "integrations.pm.org": "acme", "integrations.pm.project": "Platform" } }),
    );
    const env2 = { CRAFTAR_HOME: path.join(r2, "home") };
    const sync2 = runCli(["sync", "--workspace", ws2], { env: env2 });
    expect(sync2.code, sync2.stderr).toBe(0);

    const doc1 = JSON.parse(runCli(["doctor", "--workspace", ws1, "--json"], { env: env1 }).stdout);
    const doc2 = JSON.parse(runCli(["doctor", "--workspace", ws2, "--json"], { env: env2 }).stdout);

    // Normalize by replacing temp roots with <root>
    type Check = { id: string; scope: string; level: string; message: string; fix: string | null };
    const normalize = (checks: Check[], root: string) =>
      checks.map((c) => [c.id, c.scope, c.level, c.message.replaceAll(root, "<root>"), c.fix?.replaceAll(root, "<root>") ?? null]);

    const checks1 = normalize(doc1.checks, r1);
    const checks2 = normalize(doc2.checks, r2);

    expect(checks1).toEqual(checks2);
  });
});

it("import --help says what a schema 3 Forge changes", () => {
  const r = runCli(["import", "--help"]);
  expect(r.code).toBe(0);
  expect(r.stdout.replace(/\s+/g, " ")).toContain(
    "reusing a templated base when it renders the workspace text or infers it into params or sections; in a schema 3 Forge, what the profile's integrations block provides is left to its recipe and reported",
  );
});
