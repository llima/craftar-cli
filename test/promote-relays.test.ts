import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// E10.7: forge promote's three relays of a caught error go through errorText, which words a raw zod error without the
// value it read (schema-fault.ts). No input the command reads today raises a raw zod error there — every loader throws
// SchemaError — so this guards the spelling, as test/schema-fault.test.ts guards its own.

const src = (rel: string) => fs.readFile(path.join(import.meta.dirname, "..", rel), "utf8");

describe("forge promote's relays", () => {
  it("word a caught error through errorText", async () => {
    const cli = await src("src/cli.ts");
    const promote = await src("src/core/promote.ts");
    expect(promote).toContain('const firstLine = (e: unknown) => errorText(e).split("\\n")[0];');
    expect(cli).toContain("warnings.push(`the registry could not be read (${errorText(e)}) — no workspace was checked`);");
    expect(cli).toMatch(/impactAfter = await planAll\(impactEntries, await loadForge\(f\.root\)\);\n\s+\} catch \(e\) \{\n\s+const message = errorText\(e\);/);
    expect(cli).not.toContain("warnings.push(`the registry could not be read (${e instanceof Error ? e.message : String(e)})");
  });
});
