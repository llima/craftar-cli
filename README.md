# Craftar

Craft, sync and convert AI-coding workspace harnesses — rules, agents, commands, skills, MCP servers — across every client workspace you maintain and every AI coder each team uses.

> Status: **phase 0 prototype**. `import`, `sync`, `status`, `diff`, `explain`, `ls` work end-to-end for the `claude-code` and `kiro` targets and are validated byte-for-byte against a real workspace (see *Oracle*). Everything else in the spec (profiles with IDP/PM-tool integrations, local services, templates, `craftar ui`, `craftar mcp`) is not built yet.

## The idea in one paragraph

You write the harness **once**, in a central repository called the **Forge**, as small reusable **ingredients** (a rule, an agent, a command, a skill, an MCP server). **Recipes** bundle ingredients (`base`, `stack-backend-api`, `stack-frontend-angular`…). A **profile** describes a client: which recipes, which targets (Claude Code, Kiro, AGENTS.md…), and the parameters that differ per client. A workspace holds a tiny `craftar.yaml` pointing at the Forge and a profile; `craftar sync` generates `.claude/`, `.kiro/`, `AGENTS.md`… from it and records what it wrote in `craftar.lock`. Generated files are never edited by hand again — you edit the Forge and sync everywhere.

## Install

```bash
npx craftar --help         # run without installing
npm install -g craftar     # or install the craftar command
```

Requires Node ≥ 22.

### From source

```bash
npm install
npm run build          # → dist/
node bin/craftar.js --help
# or during development
npx tsx src/cli.ts --help
```

## Quick start: bring an existing workspace into a Forge

```bash
# 1. Import the harness of a Claude Code workspace into a (new or existing) Forge
craftar import --from claude-code \
  --workspace C:/Projects/acme-portal-workspace \
  --forge     C:/Projects/forge \
  --profile   acme-portal \
  --write-config          # writes craftar.yaml into the workspace

# 2. See what sync would do. On a freshly imported workspace everything is "adopt":
#    the files already on disk are exactly what the Forge produces, so they just become managed.
craftar status --workspace C:/Projects/acme-portal-workspace

# 3. Generate + lock
craftar sync --workspace C:/Projects/acme-portal-workspace
```

From then on, change a rule in `forge/ingredients/rules/<name>/rule.md`, run `craftar sync` in each workspace (or `craftar sync --check` in CI) and every target is regenerated.

## Commands

| Command | What it does |
|---|---|
| `craftar import --from claude-code --forge <dir> --profile <name> [--workspace .] [--write-config]` | Reads `.claude/{rules,agents,commands,skills,scripts,hooks}`, `.mcp.json` and, when present, `.kiro/steering` (for inclusion modes and hand-written steering). Creates ingredients, recipes (`base`, one `stack-*` per scoped rule, `<profile>-steering`) and a profile. Identical ingredients already in the Forge are reused; differing ones become `<name>--<profile>` variants that emit under the original name, so the workspace still round-trips while you decide what to unify. Ingredients holding a secret-like value in UTF-8 text (tokens, private keys, high-entropy MCP `env`/`args` values) are rejected and listed by location — the value is never printed. UTF-16 files are not scanned yet. |
| `craftar status` | Classifies every file the Forge would produce: `new`, `update`, `unchanged`, `adopt`, `drift`, `collision`, `orphan`, `orphan-drift`. `--json` for tooling. |
| `craftar sync` | Writes the plan and `craftar.lock`. `--dry-run` shows without writing. `--check` exits 1 when anything is out of sync (CI). `--overwrite-drift` regenerates hand-edited files (explicit, never default). |
| `craftar diff [path]` | Line diff between disk and what the Forge would generate. |
| `craftar explain <path>` | Which ingredient, recipe chain, target and origin produced a file. |
| `craftar ls` | Recipes and ingredients resolved for this workspace. |

All commands take `--workspace <dir>` (default: current directory).

## Forge layout

```
forge/
├── craftar.forge.yaml
├── ingredients/
│   ├── rules/<name>/{ingredient.yaml, rule.md}
│   ├── agents/<name>/{ingredient.yaml, agent.md}
│   ├── commands/<name>/{ingredient.yaml, command.md}
│   ├── skills/<name>/{ingredient.yaml, SKILL.md, …}
│   ├── scripts/<name>/{ingredient.yaml, <file>}
│   ├── hooks/<name>/{ingredient.yaml, <file>}
│   ├── mcp/<name>/ingredient.yaml           # server definition
│   └── steerings/<name>/{ingredient.yaml, steering.md}   # Kiro-only, no Claude counterpart
├── recipes/<name>.yaml
└── profiles/<name>/profile.yaml
```

`ingredient.yaml` (rule):

```yaml
type: rule
name: frontend-angular
inclusion: fileMatch                 # always | fileMatch | manual | auto  (Kiro steering modes)
fileMatchPattern: projects/acme-portal-front/**
targets: "*"                         # or [claude-code, kiro]
tags: []
origin: { workspace: acme-portal-workspace, path: .claude/rules/frontend-angular.md }
```

Recipe:

```yaml
name: stack-frontend-angular
extends: []
slot: frontend                       # optional: two recipes on one slot cannot coexist
ingredients: [rule/frontend-angular, agent/frontend-reviewer]
params: { angularVersion: { default: "20" } }
```

Workspace `craftar.yaml`:

```yaml
forge: ../forge                      # path today; git URL later
profile: acme-portal
targets: [claude-code, kiro]         # optional, overrides the profile
recipes: { add: [], remove: [] }
overrides:
  params: { }
  ingredients: { disable: [] }
```

Layer precedence, weakest → strongest: recipe defaults → profile → `craftar.yaml` → `craftar.local.yaml` (personal, git-ignored). Bodies may use `{{param}}` placeholders; a placeholder with no value in any layer is left untouched and reported as a warning by `status` and `sync` (Angular's `{{ 'X' | localize }}` does not look like a placeholder and passes silently). Between layers, objects merge key by key while arrays and scalars from the stronger layer replace the weaker one — `targets: [kiro]` in `craftar.local.yaml` means exactly `[kiro]`. Omit a key in `craftar.local.yaml` to inherit it — an empty list there means empty.

## Targets

**claude-code** — emits `.claude/rules|agents|commands|skills|scripts|hooks` and `.mcp.json` verbatim from the Forge (frontmatter kept byte-for-byte). Existing files keep their line endings and BOM; new files are LF without a BOM.

**kiro** — reproduces, then extends, the hand-written `sync-steering.ps1` script it replaces:
steering = `inclusion` frontmatter + `GENERATED` banner + rule body, with `.claude/rules/` rewritten to `.kiro/steering/`, UTF-8 without BOM, CRLF. On top of what the script did, it also generates `.kiro/agents/*.json` (tools mapped to Kiro names, `resources` bound to the agent's stack rule + `repo-discovery`, or `**/*.md` for generic agents), `.kiro/steering/commands/*.md`, `.kiro/skills/*/SKILL.md` and `.kiro/settings/mcp.json`. The banner text is a parameter (`kiro.banner`) so existing workspaces can adopt without a rewrite. Scripts and hooks have no Kiro equivalent: they are skipped with a warning.

**agents-md** — one `AGENTS.md` with the always-on rules concatenated and the scoped rules listed, for tools that read the open standard (Codex, Cursor, Warp, Copilot, Kimi…).

Conversion of hooks/subagents to other tools is out of scope here: the plan is to delegate that to [rulesync](https://github.com/dyoshikawa/rulesync) rather than reimplement it.

## Design rules learned from the previous generator

These come straight from workspaces that removed an earlier generator, and the code enforces them:

1. **Only files in `craftar.lock` are ever written or removed.** A file that exists but was never generated is a *collision*: reported, never touched. A managed file that was hand-edited is *drift*: reported, never overwritten unless `--overwrite-drift`.
2. **Hashes are EOL- and BOM-normalized.** A CRLF checkout on Windows does not read as a hand edit. (`sha256` over LF/no-BOM text.)
3. **Orphans are removed.** When an ingredient leaves a recipe, its generated files disappear in every target — no stale steering loading into Kiro sessions.
4. **No hand-kept mirrors.** Kiro agents, commands and skills are generated from the same ingredients as their Claude counterparts.
5. **Reuse, don't clobber.** Importing a second workspace into the same Forge reuses identical ingredients and creates explicit `--<profile>` variants for the ones that differ, listing them so a human unifies or parameterizes.

## Tests

`npm test` runs two layers that need nothing outside the repository, on any OS:

- **Unit tests** build a Forge and a workspace in a temp dir (`test/helpers/forge.ts`) and cover
  resolution, every file state, apply, each emitter, the importer, the secret guard and the CLI
  exit codes.
- **Golden workspaces** — `test/golden/acme-portal` and `test/golden/acme-web`, synthetic — run
  the oracle script end to end: import → every file `adopt`, sync byte-identical (a CRLF file and a
  BOM file included), second sync a no-op, Forge edits, drift, orphans, variants.
  `test/golden/**` is `-text` in `.gitattributes`, so line endings survive checkout. The golden
  `.kiro/` is a snapshot of the emitter's output: after an intended emitter change, regenerate it
  with `npx tsx test/helpers/regen-golden.ts` and review the diff.

CI runs typecheck, build and tests on Linux and Windows with Node 22 and 24. The oracle below is
skipped there — a green CI is not evidence against a real workspace.

## Oracle

`test/oracle.test.ts` imports a real client workspace (a private fixture, never committed) and asserts that `craftar sync` reproduces its 13 generated steering files, 5 hand-written steering files, 3 Kiro agent JSONs and every `.claude/*` file **byte for byte**, that a second sync is a no-op, that a Forge edit flows to both targets, that a hand edit becomes drift and survives, that orphans are removed, and that unrelated files are left alone.

The fixture is not in this repository. Point the suite at a workspace of your own:
set `CRAFTAR_ORACLE_FIXTURE` to its path, or drop a single workspace directory into
`fixtures/`. Without it the oracle suite is skipped and the remaining tests still run.

```bash
npm test
```

Copy a workspace with `.claude/` and `.kiro/` into `fixtures/` (keep `local-stack/` and `projects/` out).

## Roadmap (from the functional spec)

Phase 0 (this): schema, import, sync/status/diff/explain, claude-code + kiro + agents-md targets, lock, drift, orphans.
Next: `craftar init` from a profile; profile-driven integrations (PM tool → MCP, IDP → MCP); `service` ingredients with compose fragments (`craftar services up`); `dotnet new` template registration; rulesync bridge for Codex/Kimi/Cursor specifics; remote Forge (git URL + ref); `craftar docs validate`; GitHub Action and Azure Pipelines task around `sync --check`; `craftar ui`; `craftar mcp` + Claude Code / Agent Plugin packaging.

## Releases

Every change reaches `main` through a pull request that bumps the version in `package.json`,
`package-lock.json` and `src/cli.ts`. When that merge's CI run is green,
`.github/workflows/release.yml` checks that the three files agree and that the version is not on
npm yet, dry-runs the package, and waits for a maintainer to approve the `npm` environment. After
approval it publishes `craftar@<version>` with npm trusted publishing and provenance — no npm token
is stored in the repository — and creates the `v<version>` tag and a GitHub Release. A merge that
does not change the version publishes nothing.

## License

MIT
