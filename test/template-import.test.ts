import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { citedKeys, infer, readBase, renderMap, renderedFingerprint } from "../src/core/template-import.js";
import { fingerprintDir } from "../src/core/fingerprint.js";
import { listFiles } from "../src/core/forge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const one = (t: string, s: string, holes: string[], map: Record<string, unknown> = {}) =>
  infer(new Map([["rule.md", t + "\n"]]), new Map([["rule.md", s + "\n"]]), new Set(holes), map);
const tag = (r: ReturnType<typeof infer>) => ("values" in r ? r.values : r.fallback);

describe("infer — spec 10 §6.3 examples", () => {
  it("E1, E2: one and two holes", () => {
    expect(tag(one("Deploy `{{deploy.api}}` first.", "Deploy `initech-api` first.", ["deploy.api"]))).toEqual({ "deploy.api": "initech-api" });
    expect(tag(one("Deploy `{{deploy.api}}` and `{{deploy.web}}` together.", "Deploy `initech-api` and `initech-web` together.", ["deploy.api", "deploy.web"]))).toEqual({
      "deploy.api": "initech-api",
      "deploy.web": "initech-web",
    });
  });

  it("E3, E5: more than one split is ambiguous (F6)", () => {
    expect(tag(one("use {{a}} and {{b}}", "use x and y and z", ["a", "b"]))).toBe("F6");
    expect(tag(one("{{a}} {{b}}", "x y z", ["a", "b"]))).toBe("F6");
  });

  it("E4: adjacent holes are ambiguous whatever the source (F4)", () => {
    const r = one("{{a}}{{b}}", "xy", ["a", "b"]);
    expect(tag(r)).toBe("F4");
    expect("reason" in r && r.reason).toBe("inference ambiguous: {{a}}{{b}} are adjacent on line 1 of rule.md");
  });

  it("E6, E7: one key across lines takes one value", () => {
    const t = "Build `{{k}}`.\nDeploy `{{k}}`.";
    expect(tag(infer(new Map([["rule.md", t]]), new Map([["rule.md", "Build `initech-api`.\nDeploy `initech-api`."]]), new Set(["k"]), {}))).toEqual({ k: "initech-api" });
    expect(tag(infer(new Map([["rule.md", t]]), new Map([["rule.md", "Build `initech-api`.\nDeploy `umbrella-api`."]]), new Set(["k"]), {}))).toBe("F5");
  });

  it("E8, E9, E13: a changed literal, a line count, braces", () => {
    expect(tag(one("Deploy `{{k}}` first.", "Ship `initech-api` first.", ["k"]))).toBe("F5");
    expect(tag(infer(new Map([["r", "Port {{p}}.\n"]]), new Map([["r", "Port 80\n81.\n"]]), new Set(["p"]), {}))).toBe("F5");
    expect(tag(one("cfg {{k}} end", "cfg {x} end", ["k"]))).toBe("F7");
  });

  it("E10: an empty value is not a solution (F7 names it)", () => {
    const r = one("Deploy `{{k}}` first.", "Deploy `` first.", ["k"]);
    expect(tag(r)).toBe("F7");
    expect("reason" in r && r.reason).toBe('k would be "", which a parameter cannot carry');
  });

  it("E11, E12: an Angular pipe and an undeclared placeholder are literal text", () => {
    expect(tag(one("Labels read {{ 'Save' | localize }} on {{host}}.", "Labels read {{ 'Save' | localize }} on acme.dev.", ["host"]))).toEqual({ host: "acme.dev" });
    expect(tag(one("Hi {{title}} on {{host}}.", "Hi {{title}} on acme.dev.", ["host"]))).toEqual({ host: "acme.dev" });
  });

  it("E14: a repeated key makes the split unique", () => {
    expect(tag(one("{{a}}-{{a}}", "x-y-x-y", ["a"]))).toEqual({ a: "x-y" });
  });

  it("a fixed key renders with the map before matching", () => {
    expect(tag(one("{{host}}: {{k}}", "acme.dev: initech-api", ["k"], { host: "acme.dev" }))).toEqual({ k: "initech-api" });
    expect(tag(one("{{host}}: {{k}}", "other.dev: initech-api", ["k"], { host: "acme.dev" }))).toBe("F5");
  });

  it("edge whitespace is refused (F7)", () => {
    expect(tag(one("a {{k}}|", "a  x|", ["k"]))).toBe("F7");
  });
});

describe("renderedFingerprint — identity with fingerprintDir (spec 10 AC 1, 2)", () => {
  const GOLDEN = path.resolve(__dirname, "golden");
  const reader = {
    readText: (abs: string) => fs.readFile(abs, "utf8"),
    readBytes: (abs: string) => fs.readFile(abs),
    list: (dir: string) => listFiles(dir),
  };

  it("equals fingerprintDir for every ingredient with nothing declared and nothing set", async () => {
    for (const forge of ["forge-unify", "forge-param", "import-acme-portal-expected"]) {
      const root = path.join(GOLDEN, forge, "ingredients");
      for (const type of await fs.readdir(root)) {
        for (const name of await fs.readdir(path.join(root, type))) {
          const dir = path.join(root, type, name);
          expect(renderedFingerprint(await readBase(dir, reader), {}), dir).toBe(await fingerprintDir(dir));
        }
      }
    }
  });

  it("renders a declared default and cites its keys", async () => {
    const dir = path.join(GOLDEN, "forge-param-expected/ingredients/rules/deploy");
    const base = await readBase(dir, reader);
    expect([...citedKeys(base.texts)].sort()).toEqual(["deploy.api", "deploy.web"]);
    const map = renderMap(base.meta, { "deploy.api": "acme-api" }, {});
    expect(map["deploy.api"]).toBe("acme-api");
    expect(map["deploy.web"]).toBe("globex-web");
    expect(renderedFingerprint(base, map)).not.toBe(renderedFingerprint(base, {}));
  });
});
