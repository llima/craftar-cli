# Craftar plugin for Claude Code

Lets the agent read the state of a [Craftar](https://craftar.dev) workspace, a directory with a `craftar.yaml`: what the next `craftar sync` would do, where a generated file comes from, what the Forge offers and what is off. It holds a `/craftar` skill and the `craftar` MCP server, which serves seven reading tools.

The plugin never writes. For a change, the agent gives you the command to run in your terminal. To use the writing tools of `craftar mcp`, register the server by hand: see *Craftar inside the AI coder* in the [CLI's README](https://github.com/llima/craftar-cli#craftar-inside-the-ai-coder).

## Install

Install `craftar` first. The plugin starts the `craftar` you installed and installs nothing itself:

```bash
npm install -g craftar
```

It needs Node 22 or later and `craftar` 0.40.1 or later. An older one, from 0.29.0, connects, but its `doctor` tool can run a repository's code: a `global.json` at the workspace root can make `dotnet --version` load an SDK the repository ships. The plugin cannot check the version, so keep `craftar` up to date.

Then, in Claude Code:

```text
/plugin marketplace add llima/craftar-cli
/plugin install craftar@craftar
```

## When the server reads as failed

- **The project has no `craftar.yaml`.** The server refuses to start. No tool is offered and nothing is written, so this is harmless: the plugin simply has nothing to answer about there.
- **The session was opened in a subfolder of a workspace.** The server is pointed at that subfolder, which has no `craftar.yaml`, and nothing walks up. Harmless for the same reason; open the session at the workspace root.
- **`craftar` is not installed, or is older than 0.29.0.** Install or update it.

A Forge or a `craftar.lock` newer than the installed `craftar` is refused until `craftar` is updated.

## What to know before enabling it everywhere

- The plugin starts the `craftar` found on `PATH` in every project it is enabled for.
- A tool result can carry what the reading commands print, the Forge's profile names included, and it goes wherever Claude Code sends its context.
- A tool, when you permit it, reads a directory that a repository's `craftar.yaml` names, including a repository you have just cloned.

If you treat any of that as sensitive, enable the plugin per project rather than for every project.
