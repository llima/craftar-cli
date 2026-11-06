/**
 * Spec 61 §8, slice 2: the in-house TOML writer (`src/core/toml.ts`). craftar only writes TOML and never reads a user's, so the writer
 * covers the shapes Codex's agent files need — basic and multi-line basic strings, string arrays, one flat table — and nothing else.
 * Bytes are pinned against hand-written expectations, and every output is parsed back by a real TOML reader (`smol-toml`, a
 * devDependency only) to the value it was given.
 */
import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { tomlDocument, tomlKey, tomlMultiline, tomlString } from "../src/core/toml.js";

describe("tomlString — a basic string", () => {
  it.each([
    ["plain", "plain", '"plain"'],
    ["a quote", 'say "hi"', '"say \\"hi\\""'],
    ["a backslash", "C:\\path", '"C:\\\\path"'],
    ["a line feed", "a\nb", '"a\\nb"'],
    ["a carriage return", "a\r\nb", '"a\\r\\nb"'],
    ["a tab", "a\tb", '"a\\tb"'],
    ["a control character", "a\u0001b\u007fc", '"a\\u0001b\\u007Fc"'],
    ["non-ASCII", "café — ok", '"café — ok"'],
    ["empty", "", '""'],
  ])("%s", (_name, value, expected) => {
    const text = tomlString(value);
    expect(text).toBe(expected);
    expect(parse(`k = ${text}\n`).k).toBe(value);
  });
});

describe("tomlMultiline — a multi-line basic string", () => {
  const roundTrip = (value: string) => {
    const text = tomlMultiline(value);
    expect(parse(`k = ${text}\n`).k).toBe(value);
    return text;
  };

  it("opens with a line feed the reader trims, so the value starts at the next line", () => {
    expect(roundTrip("Line one.\nLine two.\n")).toBe('"""\nLine one.\nLine two.\n"""');
  });

  it("an empty body", () => {
    expect(roundTrip("")).toBe('"""\n"""');
  });

  it("a body with no trailing newline", () => {
    expect(roundTrip("no newline")).toBe('"""\nno newline"""');
  });

  it("a run of three or more quotes is broken, and a quote just before the closing delimiter is escaped", () => {
    const text = roundTrip('a """ b """" c "');
    expect(text).not.toMatch(/[^\\]"""[^\n]/);
    expect(text.endsWith('\\""""')).toBe(true);
  });

  it("a body ending in a backslash and a quote", () => {
    expect(roundTrip('a\\"')).toBe('"""\na\\\\\\""""');
  });

  it("a line ending in a backslash is not read as a line continuation", () => {
    expect(roundTrip("path\\\nnext\n")).toBe('"""\npath\\\\\nnext\n"""');
  });

  it("control characters are escaped; tab and line feed stay literal; a lone carriage return is escaped", () => {
    expect(roundTrip("a\tb\u0000c\rd\n")).toBe('"""\na\tb\\u0000c\\rd\n"""');
  });

  it("CRLF in the source keeps its value (a reader may read CRLF as a newline, so it is written escaped)", () => {
    roundTrip("one\r\ntwo\r\n");
  });
});

describe("tomlKey", () => {
  it("a bare key stays bare; any other is quoted", () => {
    expect(tomlKey("developer_instructions")).toBe("developer_instructions");
    expect(tomlKey("model-name")).toBe("model-name");
    expect(tomlKey("a.b")).toBe('"a.b"');
    expect(tomlKey("")).toBe('""');
  });
});

describe("tomlDocument — one flat table", () => {
  it("writes the keys in the order given, LF, with a final newline, and reads back to the same object", () => {
    const text = tomlDocument([
      ["name", "reviewer"],
      ["description", 'Reviews "everything"'],
      ["tags", ["a", "b\"c"]],
      ["developer_instructions", { multiline: "Review the diff.\nBe brief.\n" }],
    ]);
    expect(text).toBe(
      'name = "reviewer"\n' +
        'description = "Reviews \\"everything\\""\n' +
        'tags = ["a", "b\\"c"]\n' +
        'developer_instructions = """\nReview the diff.\nBe brief.\n"""\n',
    );
    expect(parse(text)).toEqual({ name: "reviewer", description: 'Reviews "everything"', tags: ["a", 'b"c'], developer_instructions: "Review the diff.\nBe brief.\n" });
  });

  it("an empty array", () => {
    const text = tomlDocument([["tags", []]]);
    expect(text).toBe("tags = []\n");
    expect(parse(text)).toEqual({ tags: [] });
  });

  it("refuses a key given twice", () => {
    expect(() => tomlDocument([["name", "a"], ["name", "b"]])).toThrow(/name is given twice/);
  });
});
