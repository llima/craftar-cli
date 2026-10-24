import { describe, expect, it } from "vitest";
import { launcherFix, launcherImportWarning, launcherWarning, LAUNCHER_OK, windowsOnlyLauncher } from "../src/core/mcp-server.js";

describe("windowsOnlyLauncher (spec 42 §3)", () => {
  it("recognises cmd + /c or /k, the command read as a file name without case or .exe", () => {
    expect(windowsOnlyLauncher({ command: "cmd", args: ["/c", "npx", "-y", "@acme/example-mcp"] })).toBe("c");
    expect(windowsOnlyLauncher({ command: "CMD.EXE", args: ["/C", "npx"] })).toBe("c");
    expect(windowsOnlyLauncher({ command: "C:\\Windows\\System32\\cmd.exe", args: ["/k", "npx"] })).toBe("k");
    expect(windowsOnlyLauncher({ command: "/usr/bin/cmd", args: ["/c"] })).toBe("c");
    expect(windowsOnlyLauncher({ command: "Cmd", args: ["/K"] })).toBe("k");
  });
  it("anything else is null", () => {
    expect(windowsOnlyLauncher({ command: "npx", args: ["-y", "@acme/example-mcp"] })).toBeNull();
    expect(windowsOnlyLauncher({ command: "cmd", args: [] })).toBeNull();
    expect(windowsOnlyLauncher({ command: "cmd" })).toBeNull();
    expect(windowsOnlyLauncher({ command: "cmd", args: ["/s", "/c"] })).toBeNull();
    expect(windowsOnlyLauncher({ command: "cmd /c npx" })).toBeNull();
    expect(windowsOnlyLauncher({ command: "cmdx", args: ["/c"] })).toBeNull();
    expect(windowsOnlyLauncher({ command: "xcmd", args: ["/c"] })).toBeNull();
    expect(windowsOnlyLauncher({ command: "cmd.exe.bak", args: ["/c"] })).toBeNull();
    expect(windowsOnlyLauncher({ command: "cmd", args: ["/cc"] })).toBeNull();
    expect(windowsOnlyLauncher({ url: "https://mcp.acme.example" })).toBeNull();
    expect(windowsOnlyLauncher(null)).toBeNull();
    expect(windowsOnlyLauncher("cmd")).toBeNull();
    expect(windowsOnlyLauncher([])).toBeNull();
    expect(windowsOnlyLauncher({ command: 1, args: ["/c"] })).toBeNull();
    expect(windowsOnlyLauncher({ command: "cmd", args: "/c" })).toBeNull();
    expect(windowsOnlyLauncher({ command: "cmd", args: [1] })).toBeNull();
  });
  it("the wordings", () => {
    expect(LAUNCHER_OK).toBe("no written MCP server is Windows-only");
    expect(launcherWarning("legacy", "c", [".mcp.json", ".kiro/settings/mcp.json"])).toBe(
      'server "legacy" starts through cmd /c \u2014 Windows only; it does not start on Linux or macOS (.mcp.json, .kiro/settings/mcp.json)',
    );
    expect(launcherFix("k")).toBe('in the Forge, write the program cmd runs as the server\'s command and drop "cmd" and "/k" (spec 42)');
    expect(launcherImportWarning("legacy", "c")).toBe('.mcp.json server "legacy" starts through cmd /c \u2014 Windows only; the ingredient keeps it as written (spec 42)');
  });
});
