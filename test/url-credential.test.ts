import { describe, expect, it } from "vitest";
import { credentialFault, urlCredentialIn } from "../src/core/remote.js";

// Spec 34 §4.3, row U — every URL example of that section, pinned as written there.
// No real credential appears here: `u:p`, `tok`, `pw` are placeholders, never a token of a known format.

const FINDING: Array<[string, string]> = [
  ["a user and a password on https", "https://u:p@idp.example.com/"],
  ["the same inside a longer leaf (§6.12)", "--url=https://u:p@idp.example.com/"],
  ["a bare user on a +https scheme", "git+https://tok@idp.example.com/x"],
  ["an http(s) URL with a user and no password — refused though it may not be a secret", "https://acme@dev.azure.com/acme/Portal"],
  ["a userinfo mixing a literal with a reference", "postgres://acme:${DB_PASS}@db.example.com/app"],
  ["a reference with a default is not a plain reference", "https://${A:-x}@host/"],
  ["no path, then text holding an @ with no terminator between", "https://a.example.com&cc=ops@example.com"],
  ["a port reference before an @", "https://host:${PORT}@x"],
  ["the second :// of a comma list", "https://a.example.com,https://u:p@b.example.com/"],
  ["the scheme compared without case", "HTTPS://user@host/"],
  ["wss with a bare user", "wss://user@host/"],
  ["ws with a bare user, no path", "ws://user@host"],
  ["http with a bare user, no path", "http://user@host"],
  ["a + scheme in mixed case", "svn+HTTP://user@host/"],
  ["an empty scheme with user:password", "://u:p@host/"],
  ["another scheme with a password", "ssh://git:pw@host/x"],
  ["a reference followed by a literal", "https://${USER}x@host/"],
  ["no terminator after the host", "https://u:p@host"],
  ["a clean URL first, a credential URL later", "x https://ok.example.com y https://u@h z"],
  ["two @ in the authority, the user part a reference", "https://${A}@b:c@host/"],
  // An empty authority: curl reads past the extra slashes, so the userinfo after them counts (every scheme but file).
  ["an empty authority, then a user and a password", "https:///u:p@idp.example.com/"],
  ["the same inside a longer leaf", "--url=https:///u:p@idp.example.com/"],
  ["four slashes", "https:////u:p@host/"],
  ["a backslash among the separators", "https://\\/u:p@host/"],
  ["an empty authority, then a bare user on https", "https:///tok@host/x"],
  ["an empty authority on another scheme, with a password", "ssh:///git:pw@host/x"],
  ["an empty authority after an empty scheme", ":///u:p@host/"],
  ["only file itself is exempt, not a scheme that holds it", "file+x:///u:p@host/"],
  ["an empty authority, a literal mixed with a reference", "https:///acme:${DB_PASS}@db.example.com/app"],
  // Refused though it is no credential: with an empty authority the first path segment is read as one (README).
  ["an empty authority and a path whose first segment reads as a userinfo", "sqlite:///a:b@c.db"],
  ["the same on https, where an @ alone is enough", "https:///ops@example.com"],
  // White space among the leading separators is read past too: a URL parser drops a tab or a newline and still reads the userinfo.
  ["a tab among the separators", "https://\t/u:p@host/"],
  ["a newline among the separators", "https://\n//u:p@host/"],
  ["a carriage return among the separators", "https://\r/u:p@host/"],
  ["a space after the slashes", "https:/// u:p@host/"],
  ["a tab and no slash before the userinfo", "https://\tu:p@host/"],
  ["a space directly after ://", "https:// u:p@host/"],
  ["a tab among the separators, then a bare user on https", "https://\t/tok@host/x"],
  ["refused though it is prose: white space after ://, then x:y@", "see :// a:b@c"],
  // A tab or a line break directly before the @ does not end the authority: a URL parser deletes them and reads the userinfo.
  ["a token followed by a line feed — a YAML block scalar", "https://tok\n@host/"],
  ["a token followed by CR LF", "https://tok\r\n@host/"],
  ["a user and a password followed by a tab", "https://u:p\t@host/"],
  ["a mixed run of tab, CR and LF before the @", "https://tok\t\r\n\n@host/"],
  ["another scheme, a password, then a line feed", "ssh://git:pw\n@host/x"],
  ["refused though it is prose: a URL with no path, then a mention on the next line", "see https://example.com\n@alice"],
  ["refused though it is no secret: a registry, then a scoped package on the next line", "https://registry.npmjs.org\n@acme/pkg"],
  ["a run before the last of two @", "https://a\n@b@host/"],
  ["the empty authority and a line feed before the @, together", "https:///tok\n@host/"],
  ["refused though it is no secret: a URL, a tab, a handle", "https://example.com\t@handle"],
  ["a tab inside the scheme does not save a password", "ht\ttps://u:p@host/"],
  // Spec 39 §4.2 (B′): a tab or a line break inside the scheme or its :// — a URL parser removes them, so the userinfo reaches the host.
  ["a tab inside the ://", "https:\t//u:p@host/"],
  ["a tab inside the scheme, a bare user", "ht\ttps://tok@host/"],
  ["a line feed inside the scheme, a bare user", "ht\ntps://tok@host/"],
  ["a line feed between the two slashes", "https:/\n/u:p@host/"],
  ["a word, a line feed, then a URL with a bare user", "see\nhttps://tok@host/"],
];

const NONE: Array<[string, string]> = [
  ["a mail address", "mailto:ops@example.com"],
  ["a package at a version", "npm:pkg@1.2.3"],
  ["an @ in the query", "https://idp.example.com?hint=a@b"],
  ["a plain URL", "https://idp.example.com/mcp"],
  ["a word", "acme"],
  ["a flag", "--org=acme"],
  ["a URL with a path", "https://dev.azure.com/acme/Portal"],
  ["a bare reference", "${ACME_TOKEN}"],
  ["the remedy: a userinfo that is one reference", "https://${IDP_TOKEN}@idp.example.com/mcp"],
  ["the remedy: user and password both references", "https://${IDP_USER}:${IDP_TOKEN}@idp.example.com/"],
  ["ssh with a user and no password", "ssh://git@git.example.com/acme/x"],
  ["a comma list whose second item is a mail address", "--allow=https://a.example.com,ops@example.com"],
  ["an empty userinfo", "https://@host"],
  ["an empty user and password", "https://:@host"],
  ["a secret in the query — passes though it is one", "https://idp.example.com/mcp?api_key=abc@def"],
  ["a password holding / — the authority ends there", "https://u:pa/ss@host/"],
  ["a password holding ?", "https://u:pa?ss@host/"],
  ["a password holding #", "https://u:pa#ss@host/"],
  ["a password holding a space", "https://u:pa ss@host/"],
  ['a password holding "', 'https://u:pa"ss@host/'],
  ["a password holding '", "https://u:pa'ss@host/"],
  ["a password holding ,", "https://u:pa,ss@host/"],
  ["a password holding ;", "https://u:pa;ss@host/"],
  ["credentials with no ://", "user:secret@host"],
  ["a user-only token on ssh", "ssh://tok@host/"],
  ["a user-only token on a scheme that only looks like https", "x-https://tok@host/"],
  ["news is not ws", "news://user@host/"],
  ["aws is not ws", "aws://user@host/"],
  ["an empty scheme with a bare user", "://user@host/"],
  ["a non-breaking space ends the authority", "https://a.example.com\u00A0x@y"],
  ["an @ in the path", "https://a.example.com/x@y"],
  ["the empty string", ""],
  ["a bare ://", "://"],
  ["a scheme and nothing else", "https://"],
  // An empty authority that hides nothing, and the one scheme where it is the norm.
  ["file with an empty authority: the rest is a path", "file:///home/u:p@x/y"],
  ["file compared without case", "FILE:///home/u:p@x/y"],
  ["an empty authority and no userinfo", "https:///idp.example.com/mcp"],
  ["an empty authority, then the remedy", "https:///${IDP_TOKEN}@idp.example.com/mcp"],
  ["an empty authority on ssh with a bare user", "ssh:///git@host/x"],
  ["an empty authority, then an @ only in the path", "https:///host/a:b@c"],
  ["slashes and nothing else", "https:////"],
  ["an empty authority with the @ deeper in the path", "unix:///run/a:b@c/x.sock"],
  ["file keeps its exemption behind a tab", "file://\t/u:p@host/"],
  ["white space and nothing after", "https:// "],
  ["white space, then a host and an @ only in the path", "https:// host/a:b@c"],
  ["a tab among the separators, then the remedy", "https://\t/${IDP_TOKEN}@host/"],
  ["two clean URLs separated by a space", "https://a.example.com https://b.example.com"],
  // What still ends the authority: a space before the @, and white space that is not directly before it.
  ["a token followed by a space — still passes, though it is a secret", "https://tok @host/"],
  ["a line feed, then a space, before the @", "https://tok\n @host/"],
  ["a space, then a line feed, before the @", "https://tok \n@host/"],
  ["a tab inside the userinfo, not before the @", "https://u\t:p@host/"],
  ["the remedy followed by a line feed", "https://${IDP_TOKEN}\n@host/"],
  ["ssh with a bare user followed by a line feed", "ssh://git\n@host/x"],
  ["prose: a URL, words, a mail address", "see https://example.com or mail ops@example.com"],
  ["two lines: a URL, then a mail address", "https://example.com\nops@example.com"],
  ["two lines, labelled", "site: https://example.com\nmail: ops@example.com"],
  ["a list with a comma and a space", "--allow=https://a.example.com, ops@example.com"],
  ["a URL with a path, then a mention", "https://example.com/docs @alice"],
  ["a URL, then a quoted mail address", 'https://example.com "ops@example.com"'],
  ["a URL with no path, a space, a mention", "see https://example.com @alice"],
  ["a markdown link, a space, a mention", "[site](https://example.com) @alice"],
  ["a registry, a space, a scoped package", "https://registry.npmjs.org @acme/pkg"],
  ["a host and a port, a space, a mention", "postgres://db.internal:5432 @replica"],
  ["a line feed and no @ after it", "https://tok\n\n\n"],
  ["ssh, a line feed, a mention — no colon before the @", "ssh://host\n@alice"],
];

describe("urlCredentialIn — row U", () => {
  for (const [label, text] of FINDING) it(`finding: ${label}`, () => expect(urlCredentialIn(text)).toBe(true));
  for (const [label, text] of NONE) it(`no finding: ${label}`, () => expect(urlCredentialIn(text)).toBe(false));

  it("is not credentialFault: the five whole-leaf examples of §4.3 go the other way", () => {
    const five = ["mailto:ops@example.com", "npm:pkg@1.2.3", "https://idp.example.com?hint=a@b", "--url=https://u:p@idp.example.com/", "git+https://tok@idp.example.com/x"];
    expect(five.map((s) => [credentialFault(s), urlCredentialIn(s)])).toEqual([
      [true, false],
      [true, false],
      [true, false],
      [false, true],
      [false, true],
    ]);
  });
  it("the removal is confined to the scheme and its :// (spec 39 §5.2): the pinned passes stay passes", () => {
    for (const text of ["https://tok\n @host/", "https://u\t:p@host/", "ssh://git\n@host/x", "https://example.com\nops@example.com", "site: https://example.com\nmail: ops@example.com", "ssh://host\n@alice"])
      expect(urlCredentialIn(text), JSON.stringify(text)).toBe(false);
  });
});
