import { describe, expect, it } from "vitest";
import { byHand, cloneArgs, profileRepos } from "../src/core/repos.js";

// Spec 37 §5.1 — the one reader of `profile.repos`. Every refusal names the index and the key, never a value:
// each refused value below carries MARK, and no message may hold it.

const MARK = "zq" + "mark";
const P = (repos: unknown[]) => ({ name: "acme", repos }) as never;
const fault = (repos: unknown[]): string => {
  try {
    profileRepos(P(repos));
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
};
const OK_URL = "https://git.example.com/acme/a.git";
const NAME_RULE = `name is not a repository name — letters, digits, ".", "_" and "-", starting with a letter or a digit`;
const URL_CHAR = "url holds a character a git URL here may not — letters, digits and . _ ~ : / @ + -";
const URL_KIND = "url is not an https or ssh git URL";
const URL_CRED = "url holds credentials — remove them and let git authenticate";
const PATH_PLAIN = "path is not a relative path of plain names";
const REF_RULE = "ref is not a branch or tag name";

describe("profileRepos — the entries, in order, path defaulted", () => {
  it("no entry: []", () => {
    expect(profileRepos(P([]))).toEqual([]);
  });
  it("entries in the profile's order; path defaults to name; ref null when absent", () => {
    expect(
      profileRepos(
        P([
          { name: "portal-api", url: "https://git.example.com/acme/portal-api.git" },
          { name: "portal-web", url: "git@git.example.com:acme/portal-web.git", path: "apps/portal-web", ref: "release" },
          { name: "docs", url: "ssh://git@git.example.com:22/acme/docs.git", ref: "v1.2" },
        ]),
      ),
    ).toEqual([
      { name: "portal-api", url: "https://git.example.com/acme/portal-api.git", path: "portal-api", ref: null },
      { name: "portal-web", url: "git@git.example.com:acme/portal-web.git", path: "apps/portal-web", ref: "release" },
      { name: "docs", url: "ssh://git@git.example.com:22/acme/docs.git", path: "docs", ref: "v1.2" },
    ]);
  });
});

describe("profileRepos — name", () => {
  it("missing, and not a string", () => {
    expect(fault([{ url: OK_URL }])).toBe("profile acme: repos[0]: name is missing");
    expect(fault([{ name: 7, url: OK_URL }])).toBe(`profile acme: repos[0]: ${NAME_RULE}`);
  });
  for (const bad of [`-${MARK}`, `.${MARK}`, `${MARK}.`, `${MARK} x`, `${MARK}/x`, `${MARK}é`, `_${MARK}`, ""])
    it(`not a repository name: ${JSON.stringify(bad)}`, () => {
      const m = fault([{ name: bad, url: OK_URL }]);
      expect(m).toBe(`profile acme: repos[0]: ${NAME_RULE}`);
      if (bad.includes(MARK)) expect(m.includes(MARK)).toBe(false);
    });
  for (const dev of ["con", "PRN", "Aux", "nul", "com1", "COM9", "lpt1", "LPT9", "nul.txt", "con.tar.gz"])
    it(`a device name on Windows: ${dev}`, () => {
      expect(fault([{ name: dev, url: OK_URL }])).toBe("profile acme: repos[0]: name is a device name on Windows");
    });
  it("com0 and lpt10 are not device names", () => {
    expect(profileRepos(P([{ name: "com0", url: OK_URL }, { name: "lpt10", url: OK_URL }])).map((e) => e.name)).toEqual(["com0", "lpt10"]);
  });
  it("repeated in another letter case names the earlier index", () => {
    expect(fault([{ name: "api", url: OK_URL }, { name: "web", url: OK_URL }, { name: "API", url: OK_URL, path: "other" }])).toBe(
      "profile acme: repos[2]: name repeats repos[0]",
    );
  });
});

describe("profileRepos — url", () => {
  it("missing", () => {
    expect(fault([{ name: "a" }])).toBe("profile acme: repos[0]: url is missing");
  });
  const charCases: Array<[string, string]> = [
    ["whitespace", `https://git.example.com/${MARK} x.git`],
    ["a tab", `https://git.example.com/${MARK}\tx.git`],
    ["a control character", `https://git.example.com/${MARK}\u0001.git`],
    ["an ANSI escape", `https://git.example.com/${MARK}\u001b[31m.git`],
    ["a semicolon", `https://git.example.com/${MARK};x.git`],
    ["$(", `https://git.example.com/$(${MARK}).git`],
    ["a backtick", `https://git.example.com/\`${MARK}\`.git`],
    ["a pipe", `https://git.example.com/${MARK}|x.git`],
    ["an ampersand", `https://git.example.com/${MARK}&x.git`],
    ["a double quote", `https://git.example.com/"${MARK}".git`],
    ["a single quote", `https://git.example.com/'${MARK}'.git`],
    ["a percent", `https://git.example.com/%${MARK}%.git`],
    ["an equals sign", `a=b@${MARK}:x:~/y`],
    ["a backslash", `https:\\\\${MARK}\\x.git`],
    ["a non-ASCII look-alike", `https://git.exampІe.com/${MARK}.git`],
  ];
  for (const [what, url] of charCases)
    it(`a character a git URL here may not hold: ${what}`, () => {
      const m = fault([{ name: "a", url }]);
      expect(m).toBe(`profile acme: repos[0]: ${URL_CHAR}`);
      expect(m.includes(MARK)).toBe(false);
    });
  const kindCases: Array<[string, unknown]> = [
    ["not a string", 42],
    ["a local path", `/srv/${MARK}/a.git`],
    ["a relative path", `../${MARK}/a.git`],
    ["file://", `file:///srv/${MARK}/a.git`],
    ["git://", `git://git.example.com/${MARK}.git`],
    ["http://", `http://git.example.com/${MARK}.git`],
    ["ext::", `ext::sh+-c+${MARK}`],
    ["an empty authority", `https:///${MARK}.git`],
    ["one slash after the scheme", `https:/git.example.com/${MARK}.git`],
    ["a user that starts with - (scheme form)", `ssh://-oProxyCommand+${MARK}@git.example.com/x.git`],
    ["a host that starts with - (scheme form)", `ssh://git@-${MARK}.example.com/x.git`],
    ["a host that starts with - (https)", `https://-${MARK}.example.com/x.git`],
    ["a user that starts with - (SCP form)", `-oProxyCommand+${MARK}@git.example.com:x.git`],
    ["a host that starts with - (SCP form)", `git@-${MARK}.example.com:x.git`],
    ["a path that starts with - after the SCP colon", `git@git.example.com:-${MARK}.git`],
    ["the SCP form with no user, which classifyForge reads as a path", `git.example.com:${MARK}/e.git`],
  ];
  for (const [what, url] of kindCases)
    it(`not an https or ssh git URL: ${what}`, () => {
      const m = fault([{ name: "a", url }]);
      expect(m).toBe(`profile acme: repos[0]: ${URL_KIND}`);
      expect(m.includes(MARK)).toBe(false);
    });
  for (const [what, url] of [
    ["a user and a password on https", `https://u:${MARK}@git.example.com/x.git`],
    ["a bare user on https", `https://${MARK}@git.example.com/x.git`],
    ["a password on ssh", `ssh://git:${MARK}@git.example.com/x.git`],
  ] as const)
    it(`credentials: ${what}`, () => {
      const m = fault([{ name: "a", url }]);
      expect(m).toBe(`profile acme: repos[0]: ${URL_CRED}`);
      expect(m.includes(MARK)).toBe(false);
    });
  it("accepted: https, ssh with a user and a port, the SCP form, ~ in a path", () => {
    const urls = [
      "https://git.example.com/acme/a.git",
      "ssh://git@git.example.com/acme/b.git",
      "ssh://git@git.example.com:2222/acme/c.git",
      "git@git.example.com:acme/d.git",
      "ssh://git@git.example.com/~acme/f.git",
    ];
    expect(profileRepos(P(urls.map((url, i) => ({ name: `r${i}`, url })))).map((e) => e.url)).toEqual(urls);
  });
});

describe("profileRepos — path", () => {
  for (const bad of [`/${MARK}`, `${MARK}/`, `${MARK}//x`, `../${MARK}`, `${MARK}/../x`, `.${MARK}`, `x/.${MARK}`, `${MARK}\\x`, `C:${MARK}`, `${MARK}~1`, `x/${MARK}.`, `x/con`, `x/NUL.txt`, `-${MARK}`, ""])
    it(`not a relative path of plain names: ${JSON.stringify(bad)}`, () => {
      const m = fault([{ name: "a", url: OK_URL, path: bad }]);
      expect(m).toBe(`profile acme: repos[0]: ${PATH_PLAIN}`);
      if (bad.includes(MARK)) expect(m.includes(MARK)).toBe(false);
    });
  it("not a string", () => {
    expect(fault([{ name: "a", url: OK_URL, path: 3 }])).toBe(`profile acme: repos[0]: ${PATH_PLAIN}`);
  });
  for (const reserved of ["AGENTS.md", "agents.md", "craftar.yaml", "CRAFTAR.YAML", "craftar.local.yaml", "craftar.lock", "craftar.lock/x"])
    it(`a place craftar writes: ${reserved}`, () => {
      expect(fault([{ name: "a", url: OK_URL, path: reserved }])).toBe("profile acme: repos[0]: path is a place craftar writes");
    });
  it("the rules run on name when path is absent, and the message says so", () => {
    expect(fault([{ name: "craftar.yaml", url: OK_URL }])).toBe("profile acme: repos[0]: path (from name) is a place craftar writes");
    expect(fault([{ name: "Agents.MD", url: OK_URL }])).toBe("profile acme: repos[0]: path (from name) is a place craftar writes");
  });
  it("two destinations that are equal, or nest, in any letter case, collide with the earlier index", () => {
    expect(fault([{ name: "apps", url: OK_URL }, { name: "web", url: OK_URL, path: "apps/web" }])).toBe("profile acme: repos[1]: path collides with repos[0]");
    expect(fault([{ name: "web", url: OK_URL, path: "Apps/Web" }, { name: "apps", url: OK_URL }])).toBe("profile acme: repos[1]: path (from name) collides with repos[0]");
    expect(fault([{ name: "a", url: OK_URL, path: "x/y" }, { name: "b", url: OK_URL, path: "X/Y" }])).toBe("profile acme: repos[1]: path collides with repos[0]");
  });
  it("siblings that share a prefix do not collide", () => {
    expect(profileRepos(P([{ name: "app", url: OK_URL }, { name: "apps", url: OK_URL }, { name: "w", url: OK_URL, path: "app-web/x" }])).length).toBe(3);
  });
});

describe("profileRepos — ref", () => {
  for (const bad of [`-${MARK}`, `.${MARK}`, `${MARK} x`, `${MARK};x`, `${MARK}~1`, `${MARK}^`, `${MARK}:x`, `${MARK}@{1}`, `\`${MARK}\``, ""])
    it(`not a branch or tag name: ${JSON.stringify(bad)}`, () => {
      const m = fault([{ name: "a", url: OK_URL, ref: bad }]);
      expect(m).toBe(`profile acme: repos[0]: ${REF_RULE}`);
      if (bad.includes(MARK)) expect(m.includes(MARK)).toBe(false);
    });
  it("a 40- and a 64-character hexadecimal commit id is not a ref; 39 and 41 are names", () => {
    expect(fault([{ name: "a", url: OK_URL, ref: "a".repeat(40) }])).toBe(`profile acme: repos[0]: ${REF_RULE}`);
    expect(fault([{ name: "a", url: OK_URL, ref: "0123456789ABCDEF".repeat(4) }])).toBe(`profile acme: repos[0]: ${REF_RULE}`);
    expect(profileRepos(P([{ name: "a", url: OK_URL, ref: "a".repeat(39) }, { name: "b", url: OK_URL, ref: "a".repeat(41) }])).length).toBe(2);
  });
  it("not a string", () => {
    expect(fault([{ name: "a", url: OK_URL, ref: 1 }])).toBe(`profile acme: repos[0]: ${REF_RULE}`);
  });
  it("accepted: release, v1.2, feature/x, a+b", () => {
    expect(profileRepos(P(["release", "v1.2", "feature/x", "a+b"].map((ref, i) => ({ name: `r${i}`, url: OK_URL, ref })))).map((e) => e.ref)).toEqual(["release", "v1.2", "feature/x", "a+b"]);
  });
});

describe("profileRepos — any other key", () => {
  it("a key shaped like a name is named", () => {
    expect(fault([{ name: "a", url: OK_URL, depth: 1 }])).toBe("profile acme: repos[0]: depth is not a key of a repository entry — name, url, path, ref");
  });
  it("a key not shaped like a name is named by its position, never printed", () => {
    const key = `https://u:${MARK}@x`;
    const m = fault([{ name: "a", url: OK_URL, [key]: 1 }]);
    expect(m).toBe("profile acme: repos[0]: key #3 (not shown: not shaped like a name) is not a key of a repository entry — name, url, path, ref");
    expect(m.includes(MARK)).toBe(false);
  });
  it("the index named is the entry's", () => {
    expect(fault([{ name: "a", url: OK_URL }, { name: "b", url: OK_URL, Ref: "x" }])).toBe("profile acme: repos[1]: Ref is not a key of a repository entry — name, url, path, ref");
  });
});

describe("cloneArgs and byHand", () => {
  const plain = { name: "portal-api", url: "https://git.example.com/acme/portal-api.git", path: "portal-api", ref: null };
  const refd = { name: "portal-web", url: "git@git.example.com:acme/portal-web.git", path: "apps/portal-web", ref: "release" };
  it("the argument array after the program; -- right before the URL", () => {
    expect(cloneArgs(plain)).toEqual(["clone", "--no-recurse-submodules", "--", plain.url, "portal-api"]);
    expect(cloneArgs(refd)).toEqual(["clone", "--no-recurse-submodules", "--branch=release", "--", refd.url, "apps/portal-web"]);
    for (const a of [cloneArgs(plain), cloneArgs(refd)]) expect(a[a.indexOf("--") + 1]).toBe(a.at(-2));
  });
  it("byHand: git and the same arguments, the URL and the destination in double quotes", () => {
    expect(byHand(refd)).toBe('git clone --no-recurse-submodules --branch=release -- "git@git.example.com:acme/portal-web.git" "apps/portal-web"');
    expect(byHand(plain)).toBe('git clone --no-recurse-submodules -- "https://git.example.com/acme/portal-api.git" "portal-api"');
    expect(byHand({ ...plain, path: "1.10", ref: "v1.2" })).toBe('git clone --no-recurse-submodules --branch=v1.2 -- "https://git.example.com/acme/portal-api.git" "1.10"');
  });
});
