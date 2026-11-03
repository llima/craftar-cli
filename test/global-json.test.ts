import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sdkPathsUnsafe, globalJsonFault, globalJsonMessage, GLOBAL_JSON_FIX } from "../src/core/templates.js";
import { tmpDir } from "./helpers/forge.js";

// E35 — unit tests for the global.json safety functions.

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("sdkPathsUnsafe", () => {
  describe("returns true (unsafe)", () => {
    it("parse failure — invalid JSON", () => {
      expect(sdkPathsUnsafe("{invalid}")).toBe(true);
    });

    it("top level is not an object", () => {
      expect(sdkPathsUnsafe("[]")).toBe(true);
      expect(sdkPathsUnsafe('"string"')).toBe(true);
      expect(sdkPathsUnsafe("123")).toBe(true);
      expect(sdkPathsUnsafe("null")).toBe(true);
      expect(sdkPathsUnsafe("true")).toBe(true);
    });

    it("sdk.paths exists and is not an array", () => {
      expect(sdkPathsUnsafe('{"sdk":{"paths":"/some/path"}}')).toBe(true);
      expect(sdkPathsUnsafe('{"sdk":{"paths":null}}')).toBe(true);
      expect(sdkPathsUnsafe('{"sdk":{"paths":123}}')).toBe(true);
      expect(sdkPathsUnsafe('{"sdk":{"paths":{"a":"b"}}}')).toBe(true);
    });

    it("sdk.paths is an array with a non-string element", () => {
      expect(sdkPathsUnsafe('{"sdk":{"paths":[123]}}')).toBe(true);
      expect(sdkPathsUnsafe('{"sdk":{"paths":[null]}}')).toBe(true);
      expect(sdkPathsUnsafe('{"sdk":{"paths":[true]}}')).toBe(true);
    });

    it("sdk.paths is an array with a string other than $host$", () => {
      expect(sdkPathsUnsafe('{"sdk":{"paths":["/custom/sdk"]}}')).toBe(true);
      expect(sdkPathsUnsafe('{"sdk":{"paths":["$HOST$"]}}')).toBe(true); // case-sensitive
      expect(sdkPathsUnsafe('{"sdk":{"paths":["$host$", "/other"]}}')).toBe(true);
      expect(sdkPathsUnsafe('{"sdk":{"paths":["/malicious", "$host$"]}}')).toBe(true);
    });

    it("sdk key is case-insensitive", () => {
      expect(sdkPathsUnsafe('{"SDK":{"paths":["/custom"]}}')).toBe(true);
      expect(sdkPathsUnsafe('{"Sdk":{"paths":["/custom"]}}')).toBe(true);
    });

    it("paths key is case-insensitive", () => {
      expect(sdkPathsUnsafe('{"sdk":{"Paths":["/custom"]}}')).toBe(true);
      expect(sdkPathsUnsafe('{"sdk":{"PATHS":["/custom"]}}')).toBe(true);
    });

    it("text over 1 MiB", () => {
      const large = '{"a":"' + "x".repeat(1024 * 1024 + 1) + '"}';
      expect(sdkPathsUnsafe(large)).toBe(true);
    });

    it("nesting depth over 64", () => {
      const deep = "{" + '"a":{'.repeat(65) + '""' + "}".repeat(65) + "}";
      expect(sdkPathsUnsafe(deep)).toBe(true);
    });
  });

  describe("returns false (safe)", () => {
    it("no sdk key", () => {
      expect(sdkPathsUnsafe("{}")).toBe(false);
      expect(sdkPathsUnsafe('{"version":"8.0.100"}')).toBe(false);
    });

    it("sdk is not an object", () => {
      expect(sdkPathsUnsafe('{"sdk":"string"}')).toBe(false);
      expect(sdkPathsUnsafe('{"sdk":123}')).toBe(false);
      expect(sdkPathsUnsafe('{"sdk":null}')).toBe(false);
      expect(sdkPathsUnsafe('{"sdk":[]}')).toBe(false);
    });

    it("sdk is an object but no paths key", () => {
      expect(sdkPathsUnsafe('{"sdk":{"version":"8.0.100"}}')).toBe(false);
    });

    it("sdk.paths is an empty array", () => {
      expect(sdkPathsUnsafe('{"sdk":{"paths":[]}}')).toBe(false);
    });

    it("sdk.paths is [\"$host$\"]", () => {
      expect(sdkPathsUnsafe('{"sdk":{"paths":["$host$"]}}')).toBe(false);
    });

    it("sdk.paths is [\"$host$\", \"$host$\"]", () => {
      expect(sdkPathsUnsafe('{"sdk":{"paths":["$host$","$host$"]}}')).toBe(false);
    });
  });

  describe("tolerant parsing", () => {
    it("accepts leading UTF-8 BOM", () => {
      expect(sdkPathsUnsafe("\uFEFF{}")).toBe(false);
      expect(sdkPathsUnsafe("\uFEFF" + '{"sdk":{"paths":["/bad"]}}')).toBe(true);
    });

    it("accepts // comments outside strings", () => {
      expect(sdkPathsUnsafe("// comment\n{}")).toBe(false);
      expect(sdkPathsUnsafe('{"sdk":{}// comment\n}')).toBe(false);
    });

    it("accepts /* */ comments outside strings", () => {
      expect(sdkPathsUnsafe("/* comment */{}")).toBe(false);
      expect(sdkPathsUnsafe('{"sdk":{/* inline */}}')).toBe(false);
    });

    it("accepts trailing commas in objects", () => {
      expect(sdkPathsUnsafe('{"a":1,}')).toBe(false);
      expect(sdkPathsUnsafe('{"sdk":{"version":"8.0.100",}}')).toBe(false);
    });

    it("accepts trailing commas in arrays", () => {
      expect(sdkPathsUnsafe('{"arr":[1,2,]}')).toBe(false);
      expect(sdkPathsUnsafe('{"sdk":{"paths":["$host$",]}}')).toBe(false);
    });

    it("accepts CRLF", () => {
      expect(sdkPathsUnsafe('{\r\n"a":1\r\n}')).toBe(false);
    });

    it("accepts the JSON escapes but \\u (which is refused, review round 1)", () => {
      expect(sdkPathsUnsafe('{"key":"value\\nwith\\ttabs\\"q\\" \\\\ \\/"}')).toBe(false);
      expect(sdkPathsUnsafe('{"key":"value\\u0041"}')).toBe(true);
    });
  });
});

describe("globalJsonFault", () => {
  async function makeDir() {
    const root = await tmpDir("craftar-global-json-");
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    return root;
  }

  describe("returns null (safe)", () => {
    it("no global.json anywhere", async () => {
      const root = await makeDir();
      expect(await globalJsonFault(root)).toBe(null);
    });

    it("global.json at root with safe content", async () => {
      const root = await makeDir();
      await fs.writeFile(path.join(root, "global.json"), '{"sdk":{"version":"8.0.100"}}');
      expect(await globalJsonFault(root)).toBe(null);
    });

    it("global.json at root with empty paths", async () => {
      const root = await makeDir();
      await fs.writeFile(path.join(root, "global.json"), '{"sdk":{"paths":[]}}');
      expect(await globalJsonFault(root)).toBe(null);
    });

    it("global.json at root with paths: [\"$host$\"]", async () => {
      const root = await makeDir();
      await fs.writeFile(path.join(root, "global.json"), '{"sdk":{"paths":["$host$"]}}');
      expect(await globalJsonFault(root)).toBe(null);
    });
  });

  describe("returns fault at root", () => {
    it("global.json at root with unsafe paths", async () => {
      const root = await makeDir();
      await fs.writeFile(path.join(root, "global.json"), '{"sdk":{"paths":["/custom"]}}');
      expect(await globalJsonFault(root)).toEqual({ where: "root", kind: "paths" });
    });

    it("global.json at root that does not parse", async () => {
      const root = await makeDir();
      await fs.writeFile(path.join(root, "global.json"), "{invalid}");
      expect(await globalJsonFault(root)).toEqual({ where: "root", kind: "unreadable" });
    });

    it("global.json at root is a directory", async () => {
      const root = await makeDir();
      await fs.mkdir(path.join(root, "global.json"));
      expect(await globalJsonFault(root)).toEqual({ where: "root", kind: "unreadable" });
    });
  });

  describe("returns fault above root", () => {
    it("global.json above root with unsafe paths", async () => {
      const root = await makeDir();
      const sub = path.join(root, "sub");
      await fs.mkdir(sub);
      await fs.writeFile(path.join(root, "global.json"), '{"sdk":{"paths":["/custom"]}}');
      expect(await globalJsonFault(sub)).toEqual({ where: "above", kind: "paths" });
    });

    it("global.json above root that does not parse", async () => {
      const root = await makeDir();
      const sub = path.join(root, "sub");
      await fs.mkdir(sub);
      await fs.writeFile(path.join(root, "global.json"), "{invalid}");
      expect(await globalJsonFault(sub)).toEqual({ where: "above", kind: "unreadable" });
    });
  });

  describe("first file wins", () => {
    it("safe global.json at root stops the walk even if parent has unsafe", async () => {
      const root = await makeDir();
      const sub = path.join(root, "sub");
      await fs.mkdir(sub);
      await fs.writeFile(path.join(root, "global.json"), '{"sdk":{"paths":["/bad"]}}');
      await fs.writeFile(path.join(sub, "global.json"), '{"sdk":{"version":"8.0.100"}}');
      expect(await globalJsonFault(sub)).toBe(null);
    });
  });
});

describe("globalJsonFault walks the real path too", () => {
  it("a workspace reached through a link: the real directory's parent holds an unsafe global.json, the link's does not", async () => {
    const top = await tmpDir("craftar-global-json-link-");
    cleanups.push(() => fs.rm(top, { recursive: true, force: true }));
    const realParent = path.join(top, "real");
    const real = path.join(realParent, "ws");
    const linkParent = path.join(top, "via");
    await fs.mkdir(real, { recursive: true });
    await fs.mkdir(linkParent, { recursive: true });
    await fs.writeFile(path.join(realParent, "global.json"), '{"sdk":{"paths":["x"]}}');
    const link = path.join(linkParent, "ws");
    await fs.symlink(real, link, "junction"); // a junction needs no privilege on Windows; "junction" is ignored elsewhere
    expect(await globalJsonFault(link)).toEqual({ where: "above", kind: "paths" });
  });
});

describe("sdkPathsUnsafe reads what the dotnet host reads, or refuses (review round 1)", () => {
  // rapidjson ends a `//` comment at `\n` only: here it hides the first `sdk` value's opening brace, so the host's `sdk`
  // is the second object, whose `paths` names a directory. Byte for byte the payload measured against dotnet 10.0.401.
  it("a // comment ended by a bare CR is not where the host ends it — refused", () => {
    expect(sdkPathsUnsafe('{"sdk": //\r{"paths":["$host$"]}, "w":\n{"paths":["X"]}}')).toBe(true);
  });
  it("a bare CR anywhere outside a CRLF is refused", () => {
    expect(sdkPathsUnsafe('{"sdk":\r{"version":"8.0.100"}}')).toBe(true);
  });
  it("an unterminated /* comment is refused", () => {
    expect(sdkPathsUnsafe('{"sdk":{"version":"8.0.100"}} /* ')).toBe(true);
  });
  it("a raw control character inside a string is refused", () => {
    expect(sdkPathsUnsafe('{"sdk":{"version":"8.0\u0001.100"}}')).toBe(true);
  });
  it("any \\u escape is refused, in a key or a value", () => {
    expect(sdkPathsUnsafe('{"s\\u0064k":{"version":"8.0.100"}}')).toBe(true);
    expect(sdkPathsUnsafe('{"sdk":{"version":"8.0.10\\u0030"}}')).toBe(true);
  });
  it("the word paths where the reader found no paths key — a comment, say — is refused", () => {
    expect(sdkPathsUnsafe('{"sdk":{"version":"8.0.100"} /* "paths": ["x"] */}')).toBe(true);
    expect(sdkPathsUnsafe('{"sdk":{"version":"8.0.100"}} // paths')).toBe(true);
  });
  it("duplicates: an unsafe second sdk, or an unsafe second paths inside a safe sdk", () => {
    expect(sdkPathsUnsafe('{"sdk":{"paths":["$host$"]},"sdk":{"paths":["x"]}}')).toBe(true);
    expect(sdkPathsUnsafe('{"sdk":{"paths":["$host$"],"paths":["x"]}}')).toBe(true);
  });
  it("$host$ in another case is a path, not the host", () => {
    expect(sdkPathsUnsafe('{"sdk":{"paths":["$HOST$"]}}')).toBe(true);
  });
  it("content after the root value is refused", () => {
    expect(sdkPathsUnsafe('{} {"sdk":{"paths":["x"]}}')).toBe(true);
  });
  it("(control) the safe forms still read as safe", () => {
    expect(sdkPathsUnsafe('{\r\n  "sdk": { "version": "8.0.100", "paths": ["$host$"] } // pinned\r\n}\r\n')).toBe(false);
    expect(sdkPathsUnsafe("﻿{}")).toBe(false);
  });
});

describe("globalJsonFault on what is not a plain file (review round 1)", () => {
  async function root(): Promise<string> {
    const r = await tmpDir("craftar-global-json-kind-");
    cleanups.push(() => fs.rm(r, { recursive: true, force: true }));
    return r;
  }
  it("a file over 1 MiB is unreadable, whatever it holds", async () => {
    const r = await root();
    await fs.writeFile(path.join(r, "global.json"), "{" + " ".repeat(1024 * 1024 + 1) + "}");
    expect(await globalJsonFault(r)).toEqual({ where: "root", kind: "unreadable" });
  });
  it.skipIf(process.platform === "win32")("a link to a safe file is followed and read as safe", async () => {
    const r = await root();
    await fs.writeFile(path.join(r, "safe.json"), "{}");
    await fs.symlink(path.join(r, "safe.json"), path.join(r, "global.json"));
    expect(await globalJsonFault(r)).toBeNull();
  });
  it.skipIf(process.platform === "win32")("a dangling link is unreadable", async () => {
    const r = await root();
    await fs.symlink(path.join(r, "nowhere.json"), path.join(r, "global.json"));
    expect(await globalJsonFault(r)).toEqual({ where: "root", kind: "unreadable" });
  });
  it.skipIf(process.platform === "win32")("a FIFO is unreadable, and is not opened", async () => {
    const r = await root();
    execFileSync("mkfifo", [path.join(r, "global.json")]);
    expect(await globalJsonFault(r)).toEqual({ where: "root", kind: "unreadable" });
  });
});

describe("globalJsonMessage", () => {
  it("paths at root", () => {
    expect(globalJsonMessage({ where: "root", kind: "paths" })).toBe("global.json sets sdk.paths: dotnet would load the SDK it names");
  });

  it("paths above", () => {
    expect(globalJsonMessage({ where: "above", kind: "paths" })).toBe("a global.json above the workspace sets sdk.paths: dotnet would load the SDK it names");
  });

  it("unreadable at root", () => {
    expect(globalJsonMessage({ where: "root", kind: "unreadable" })).toBe("global.json does not read as JSON: craftar cannot tell which SDK dotnet would load");
  });

  it("unreadable above", () => {
    expect(globalJsonMessage({ where: "above", kind: "unreadable" })).toBe("a global.json above the workspace does not read as JSON: craftar cannot tell which SDK dotnet would load");
  });
});

describe("GLOBAL_JSON_FIX constant", () => {
  it("has the expected value", () => {
    expect(GLOBAL_JSON_FIX).toBe("remove sdk.paths from that global.json, or run dotnet new install by hand in a repository you trust");
  });
});
