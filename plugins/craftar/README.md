# Craftar plugin for Claude Code

Lets the agent read the state of a [Craftar](https://craftar.dev) workspace, a directory with a `craftar.yaml`: what the next `craftar sync` would do, where a generated file comes from, what the Forge offers and what is off. It holds a `/craftar` skill and the `craftar` MCP server, which serves seven reading tools.

The plugin never writes. For a change, the agent gives you the command to run in your terminal. To use the writing tools of `craftar mcp`, register the server by hand: see *Craftar inside the AI coder* in the [CLI's README](https://github.com/llima/craftar-cli#craftar-inside-the-ai-coder).

## Install

Install `craftar` first. The plugin starts the `craftar` you installed and installs nothing itself:

```bash
npm install -g craftar
```

It needs Node 22 or later and `craftar` 0.40.1 or later. An older one, from 0.29.0, connects, but its `doctor` tool can run a repository's code: a `global.json` at the workspace root can make `dotnet --version` load an SDK the repository ships. The plugin cannot check the version, so keep `craftar` up to date. If `craftar` or `node` comes from asdf, volta or mise, read *If `craftar` comes from a version manager* below first.

Then, in Claude Code:

```text
/plugin marketplace add llima/craftar-cli
/plugin install craftar@craftar
```

## When the server reads as failed

- **The project has no `craftar.yaml`.** The server refuses to start. No tool is offered and nothing is written, so this is harmless: the plugin simply has nothing to answer about there.
- **The session was opened in a subfolder of a workspace.** The server is pointed at that subfolder, which has no `craftar.yaml`, and nothing walks up. Harmless for the same reason; open the session at the workspace root.
- **`craftar` is not installed, or is older than 0.29.0.** Install or update it.
- **mise refused a project file you have not trusted.** See *If `craftar` comes from a version manager*.

A Forge or a `craftar.lock` newer than the installed `craftar` is refused until `craftar` is updated.

## If `craftar` comes from a version manager

The plugin starts the `craftar` found on `PATH`. When that is a version manager's shim, the shim runs first and reads the project's files, so **a project can choose what runs**, with your rights, when the server starts and before any tool is called:

- **asdf** runs what a `.tool-versions` names with `path:` in the project, or with an absolute `path:` in a directory above it.
- **volta** runs the `node_modules/.bin/craftar` beside a `package.json`, in the project or in a directory above it, that lists `craftar` in `dependencies` or `devDependencies`.
- **mise** refused each untrusted `.mise.toml` and `.tool-versions` measured, so the server read as failed; a `.node-version` or `.nvmrc` naming a `path:` ran nothing and the server started. After `mise trust`, that project's file applies.

Measured through their shims on Linux with asdf 0.20.2, volta 2.0.2 and mise 2026.10.25, with `craftar` installed by each; other tools, versions and modes (such as `mise activate`) were not, and neither was a `craftar` installed elsewhere that starts their `node` shim: assume it can. This happens outside `craftar`, which never gets a say, and the plugin cannot tell how `craftar` was installed.

Claude Code starts the server only after you accept a project's trust dialog (see *Before and after you trust a project*), so a shim reads a project's files from then on, and whenever you type `claude mcp list` there.

If you use asdf or volta, or mise with a project's file trusted, either have a `craftar` and a `node` installed outside them come first on `PATH`, or enable the plugin only in projects whose files you trust.

## Before and after you trust a project

Measured on 2026-11-05 on Linux, with Claude Code 2.1.318, `craftar` 0.64.0 and this plugin at 0.1.1 loaded with `--plugin-dir` from a checkout, one new project per check:

- **Before.** While a project's trust dialog waited two minutes for an answer, Claude Code did not start the server; it started it within a second of the answer.
- **After.** Once you trust a project, the `env` block of its `.claude/settings.json` reaches the server: a `NODE_OPTIONS` there made the server's `node` load the project's code, and a `PATH` there made Claude Code start the project's own `craftar` in place of yours. That is the same reach a trusted project's hooks already have, so trust a project only when you trust its files.
- **`claude mcp list`**, typed in a folder you never trusted, started the server, without the project's `env`.

Not measured: whether Claude Code asks before the first tool call in its default permission mode (the session measured ran in auto mode), a plugin installed from the marketplace, macOS and native Windows.

## What to know before enabling it everywhere

- The plugin starts the `craftar` found on `PATH` in every project it is enabled for.
- A tool result can carry what the reading commands print, the Forge's profile names included, and it goes wherever Claude Code sends its context.
- A tool, when you permit it, reads a directory that a repository's `craftar.yaml` names, including a repository you have just cloned.
- Once you trust a project, its `.claude/settings.json` can choose what runs as the server: see *Before and after you trust a project*.

If you treat any of that as sensitive, enable the plugin per project rather than for every project.
