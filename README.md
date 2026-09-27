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
| `craftar import --from claude-code --forge <dir> --profile <name> [--workspace .] [--write-config]` | Reads `.claude/{rules,agents,commands,skills,scripts,hooks}`, `.mcp.json` and, when present, `.kiro/steering` (for inclusion modes and hand-written steering). Creates ingredients, recipes (`base`, one `stack-*` per scoped rule, `<profile>-steering`) and a profile, or updates them. An ingredient already in the Forge is reused when the base, **rendered** for this profile (its declared defaults, the profile's `params`, the workspace's `overrides.params`), equals the workspace file; failing that, when a unique, proved assignment of the base's declared `{{keys}}` reproduces it, the values are **inferred** into the profile's `params` (one value per key per run; never a change another ingredient would feel). Anything else becomes a `<name>--<profile>` variant that emits under the original name, with the reason, so the workspace still round-trips while you decide what to unify. A shared recipe is never widened for one client: a profile whose ingredients differ from `base` or a `stack-*` gets its own `<recipe>--<profile>`. An existing profile is merged in place (`params`, the recipes import owns, missing `targets`; every other field and comment kept), as is a recipe the profile owns; `--write-config` merges an existing `craftar.yaml` (`forge`, `profile`, `targets`). The report adds `rendered`, `inferred`, `param <key>: <old> → <new>` and `profile … created|edited|unchanged` lines. It refuses, with the Forge untouched, a Forge that does not load, a profile or recipe or `craftar.yaml` that does not round-trip through the YAML writer, a misplaced profile, a recipe whose file and `name` disagree, a workspace override that does not parse, a literal `{{key}}` the profile would render, and changing a recipe or variant another profile uses. Ingredients holding a secret-like value (tokens, private keys, high-entropy MCP `env`/`args` values) are rejected and listed by location — the value is never printed. A UTF-16 file with a byte-order mark is decoded for the scan; UTF-16 without one is not detected. An ingredient that would not load back into the Forge (a name that is not slug-like, a non-string MCP `env` value) refuses the import, naming its source; so does an ingredient already in the Forge whose `ingredient.yaml` has an unknown key or a YAML syntax error, naming that file. Every read and check runs before the first write, so an import that fails leaves the Forge untouched and says so. |
| `craftar status` | Classifies every file the Forge would produce: `new`, `update`, `unchanged`, `adopt`, `drift`, `collision`, `orphan`, `orphan-drift`. `--json` for tooling. |
| `craftar sync` | Writes the plan and `craftar.lock`. `--dry-run` shows without writing. `--check` exits 1 when anything is out of sync (CI). `--overwrite-drift` regenerates hand-edited files (explicit, never default). |
| `craftar diff [path]` | Line diff between disk and what the Forge would generate. |
| `craftar explain <path>` | Which ingredient, recipe chain, target and origin produced a file. |
| `craftar ls` | Recipes and ingredients resolved for this workspace. |
| `craftar forge variants [--forge <dir> \| --workspace <dir>] [--json]` | Lists ingredients that have variants, nearest first, with the profile each came from, its distance to the base and its hunks counted by suggested class (`[1 evolution · 2 block]`), then any variant whose base is missing from the Forge. Read-only; exits 0 either way. `--json` prints `{groups, orphans}`; each variant carries `classes: {evolution, value, block}`, which add up to `distance.hunks`. |
| `craftar forge diff <type/name> [--against <profile>] [--forge <dir> \| --workspace <dir>] [--json]` | Shows the differences between a base ingredient and each of its variants: a header carrying the same distance `forge variants` reports, then hunk by hunk, each with a suggested class and reason — `evolution` (one side is newer text), `value` (an identifier-like token swapped in shared prose, with a suggested `param.<slug>`) or `block` (lines only one side has) — then the files that exist on only one side. A suggestion never decides anything. Read-only. `--json` prints an array of `{ref, profile, distance, diff}`; each hunk carries `suggestion: {class, reason, tokens?}` next to its `kind`. |
| `craftar forge unify <type/name> --profile <p> (--take base\|variant \| --plan <file> \| --save-plan <file>) [--forge <dir> \| --workspace <dir>] [--json]` | Resolves one variant back into its base, hunk by hunk. `--save-plan` writes a reviewable plan with every decision set to `keep`, each hunk annotated with its suggested class (which `--plan` ignores) and, for a `value` hunk, a pre-filled `params` list (`token` → suggested `key`), and writes nothing else; it refuses a path that resolves inside the Forge (after `..` segments and symlinks) and a path that already exists, so it never overwrites a Forge file or a plan you already edited. A hunk set to `take: param` turns each listed token into `{{key}}` in the base, declares the base's text as the key's default in the base's `ingredient.yaml` and writes the variant's text into the variant profile's `profile.yaml` `params` — only after proving that both the base's and the variant's text render back exactly, and only when the same plan resolves the variant; it refuses (with the Forge untouched) a key another layer, profile or ingredient already uses, a variant another profile also uses, a whitespace-only difference, and a YAML file that would not round-trip unchanged. `--plan` applies an edited plan, refusing when it is not for this exact ingredient/profile or either side's fingerprint moved since it was saved. `--take base\|variant` resolves every decision to that side. Writes the merged base and, once every difference is resolved, removes the variant and rewrites every recipe reference to it (`ingredients`) to name the base. It never deletes a recipe and never edits an `extends`; it edits a profile only to write the values of a `take: param` extraction into the variant's own profile, and otherwise never: a `<recipe>--<profile>` left identical to `<recipe>` is reported as a warning, to be removed by hand after repointing the lists that name it — unify does not, because a workspace or an `extends` chain may also name `<recipe>` and the recipe order or param precedence would change. Unify cannot reach workspaces, so a removed variant is reported as a warning for any `craftar.yaml` that disables it in `overrides.ingredients.disable`. Every recipe rewrite is checked before the first write, so one that cannot land (a reference behind a YAML alias) is refused with the Forge untouched; a failure after writing began (an I/O error, a locked file) names the paths already touched and the `git checkout` / `git clean` commands that undo them. `ingredient.yaml` is never merged: when the two sides' metadata differs (beyond `name`, `as` and `origin`), the variant stays unresolved and the differing fields are named — edit it by hand, or `--take base` to discard the variant, metadata included. Requires a clean git checkout in the Forge with at least one commit (`--save-plan` excepted) — the Forge has no lock, so git is the undo. It also refuses when any path it would overwrite or delete (the base, the variant, the recipe files it rewrites, the profile a parameter extraction edits) is ignored, untracked, modified, or flagged skip-worktree or assume-unchanged in the index, since git could not restore it. `--json` prints `{base, profile, resolved, written, removed, unresolved, variantRemoved, recipes: {rewritten, identicalToSibling}, metaDiffers, params, profileEdited, warnings}` for `--take`/`--plan` (every key always present, `[]` when empty), or `{base, profile, plan, unresolved}` for `--save-plan`. |

All commands take `--workspace <dir>` (default: current directory); the `forge` commands also take `--forge <dir>` as an alternative to it.

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
params:                              # optional: {{deploy.api}} in the body renders "acme-portal-api" unless a stronger layer sets it
  deploy.api: { default: acme-portal-api, description: The API repository }
```

The keys above are the whole vocabulary (`params` declares the ingredient's own parameters: each `default` is a string, number or boolean, and fills only this ingredient's placeholders): an `ingredient.yaml` with a key the schema does not declare (a typo such as `incluson`, or a field no command reads) fails to load, and the error names the file and every unknown key at once. The one exception is an MCP server, which is the tool's own configuration: `command`, `args`, `url`, `env` and `type` are checked, and every other key is kept and emitted as it is, in the order the Forge holds it.

`ingredient.yaml` (mcp):

```yaml
type: mcp
name: acme-docs
targets: "*"
tags: []
server:
  type: http
  url: https://mcp.acme.dev/docs
  headers: { X-Team: acme }          # not declared by Craftar: passed through to both MCP files
  timeout: 30
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

Layer precedence, weakest → strongest: the ingredient's declared defaults (scoped to that ingredient) → recipe defaults → profile → `craftar.yaml` → `craftar.local.yaml` (personal, git-ignored). Bodies may use `{{param}}` placeholders; a placeholder with no value in any layer is left untouched and reported as a warning by `status` and `sync` (Angular's `{{ 'X' | localize }}` does not look like a placeholder and passes silently). Between layers, objects merge key by key while arrays and scalars from the stronger layer replace the weaker one — `targets: [kiro]` in `craftar.local.yaml` means exactly `[kiro]`. Omit a key in `craftar.local.yaml` to inherit it — an empty list there means empty.

## Targets

**claude-code** — emits `.claude/rules|agents|commands|skills|scripts|hooks` and `.mcp.json` verbatim from the Forge (frontmatter kept byte-for-byte). Each MCP server is written exactly as the Forge holds it, undeclared keys included, in its own key order. Existing files keep their line endings and BOM; new files are LF without a BOM. Steering is Kiro-only (its `targets` default to `[kiro]`); one aimed at `claude-code` explicitly (`targets: "*"` or a list naming it) is skipped with a warning.

**kiro** — reproduces, then extends, the hand-written `sync-steering.ps1` script it replaces:
steering = `inclusion` frontmatter + `GENERATED` banner + rule body, with `.claude/rules/` rewritten to `.kiro/steering/`, UTF-8 without BOM, CRLF. On top of what the script did, it also generates `.kiro/agents/*.json` (tools mapped to Kiro names, `resources` bound to the agent's stack rule + `repo-discovery`, or `**/*.md` for generic agents), `.kiro/steering/commands/*.md`, `.kiro/skills/*/SKILL.md` and `.kiro/settings/mcp.json`. `.kiro/settings/mcp.json` receives each MCP server exactly as the Forge holds it, in its own key order — including keys Kiro may not use (`type` always went through). The banner text is a parameter (`kiro.banner`) so existing workspaces can adopt without a rewrite. Scripts and hooks have no Kiro equivalent: they are skipped with a warning.

**agents-md** — one `AGENTS.md` with the always-on rules concatenated and the scoped rules listed, for tools that read the open standard (Codex, Cursor, Warp, Copilot, Kimi…). Every other ingredient type aimed at `agents-md` — including through the default `targets: "*"` — has no `AGENTS.md` equivalent: it is skipped with a warning — one line per type, naming every skipped ingredient. The file keeps the line endings and BOM of the one it replaces; a new one is LF without a BOM.

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

## Upgrading

### to 0.6.1

- **`import` refuses a recipe whose file and `name` disagree** (`recipes/shared.yaml` declaring `name: base`, or `recipes/base.yaml` declaring another name). 0.6.0 wrote a second `base` next to it, and the Forge then loaded only one of the two. Rename the file to match and re-run.
- **A key a run already relied on no longer makes a later line ambiguous.** Import renders it at its current value when inferring the other keys, so a source 0.6.0 turned into a variant can now be reused.

### to 0.6.0

- **Re-import is template-aware.** A workspace whose text an extracted base renders (through its defaults or the profile's `params`) is reused instead of becoming a variant, and a new client's values are inferred into its profile.
- **A second client no longer widens `base`.** A profile whose ingredients differ from a shared recipe gets its own `<recipe>--<profile>`. Profiles that already resolve a widened `base` keep it until their next re-import.
- **An existing profile, owned recipe and `craftar.yaml` are edited in place.** Their comments and every other field survive, but the lists import computes are set to this workspace's: an owned recipe's `ingredients`, the import-owned entries of the profile's `recipes` (`base`, `stack-*`, their `--<profile>` recipes and `<profile>-steering`) and `craftar.yaml`'s `forge`, `profile` and `targets`. A file that does not round-trip through the YAML writer is refused (reformat it and re-run). The `created` count no longer lists an existing profile.
- **A profile value can change on re-import.** When a workspace shows another value for a key its profile sets, the profile is updated and the report says `param <key>: <old> → <new>` — every workspace on that profile renders it at its next sync.
- **`import` now loads an existing Forge first**, and refuses one that does not load.

### to 0.5.0

- **A Forge edited by `forge unify` with `take: param` needs 0.5.0 everywhere.** The base's `ingredient.yaml` gains `params`, which `craftar` 0.4.0 and older refuse as an unknown key. Upgrade every workspace that syncs that Forge.
- **`import` is not template-aware yet.** Re-importing a workspace into a Forge whose base now holds `{{key}}` creates a new variant of it and rewrites the profile's `profile.yaml` without the extracted `params`. Avoid re-importing over an extracted base until 0.6.0.
- **`{{constructor}}`, `{{toString}}` and `{{__proto__}}` stay literal.** `substitute` used to resolve them to built-in JavaScript members; a body holding one now keeps it verbatim (and `status` warns that it has no value).

### to 0.3.0

- **Unknown `ingredient.yaml` keys are refused.** A Forge with a key the schema does not declare stops loading; the error names the file and every unknown key. Rename or remove the key and commit the Forge (`forge unify` refuses paths git does not hold), then re-run. MCP `server` keys are the exception: they pass through.
- **MCP files may show `update`.** `.mcp.json` and `.kiro/settings/mcp.json` now carry every key of a server as the Forge holds it (`headers`, `timeout`, `disabled`…) in its own key order. Workspaces whose servers have undeclared keys, or keys stored out of `command`/`args`/`url`/`env`/`type` order, see `update` on those files once; an unlocked `.mcp.json` that read `collision` because of undeclared keys or `type` first now adopts.
- **Saved `forge unify` plans may go stale.** Fingerprints now hash validated metadata, so a hand-written `ingredient.yaml` that omits defaulted fields fingerprints differently. `--plan` refuses a stale plan; re-run `--save-plan`.
- **`import` is stricter and reuses more.** An ingredient that would not load back (a non-string MCP `env` value, a name that is not slug-like) refuses the import, naming its source, and so does an existing Forge ingredient with an unknown key or a YAML syntax error (0.2.4 made a variant or an error naming no file). A re-import may now reuse an ingredient where it used to create a variant.

## Releases

Merging a pull request that bumps the version in `package.json`, `package-lock.json` and
`src/cli.ts` starts a release: when that merge's CI run is green, `.github/workflows/release.yml`
checks that the three files agree and that the version is not on npm yet, dry-runs the package,
and waits for a maintainer to approve the `npm` environment. After approval it publishes
`craftar@<version>` with npm trusted publishing and provenance — no npm token is stored in the
repository — and creates the `v<version>` tag and a GitHub Release. A merge that does not change
the version publishes nothing.

## License

MIT
