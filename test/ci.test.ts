import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

const REPO = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

describe("CI contract", () => {
  const ci = YAML.parse(read(".github/workflows/ci.yml"));
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));

  it("tests on Linux and Windows — the CRLF lesson lives on Windows", () => {
    expect(ci.jobs.test.strategy.matrix.os).toEqual(["ubuntu-latest", "windows-latest"]);
  });

  it("tests the engines floor and the current Node, and declares nothing older", () => {
    expect(ci.jobs.test.strategy.matrix.node).toEqual([22, 24]);
    expect(pkg.engines.node).toBe(">=22");
    expect(lock.packages[""].engines.node).toBe(">=22");
  });

  it("runs install, typecheck, build and test", () => {
    const runs = ci.jobs.test.steps.map((s: { run?: string }) => s.run).filter(Boolean);
    expect(runs).toEqual(expect.arrayContaining(["npm ci", "npm run typecheck", "npm run build", "npm test"]));
  });

  it("is read-only", () => {
    expect(ci.permissions).toEqual({ contents: "read" });
  });

  it("bounds the job so a hang doesn't burn the runner", () => {
    expect(ci.jobs.test["timeout-minutes"]).toBe(15);
  });
});
