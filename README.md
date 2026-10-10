# Craftar

Craft, sync and convert AI-coding workspace harnesses — rules, agents, commands, skills, MCP servers — across every client workspace you maintain and every AI coder each team uses.

> Status: **phase 1 in progress** — phase 0, the foundations, is done. `import`, `sync`, `status`, `diff`, `explain`, `ls` work end-to-end for the `claude-code` and `kiro` targets and are validated byte-for-byte against a real workspace (see *Oracle*). The Forge commands `forge variants`, `forge diff` (with a suggested class per hunk) and `forge unify` (`--take base|variant`, `take: param` to turn a value into a `{{key}}` parameter, and `take: section` to turn a client block into a section) also work, covered by the unit and golden suites rather than the oracle, and `import` is render-aware: importing into an existing Forge reuses a base whose render equals the workspace file, and edits an existing profile and the recipes it owns in place. Ingredient bodies can hold client-specific **sections** (`<!-- craftar:section <name> -->` … `<!-- /craftar:section -->`), overridden by a profile's `sections` and a workspace's `overrides.sections`; import infers each client's content and `forge unify` can extract a section from a variant, and a Forge that uses them declares `schema: 2` (see *Forge layout*). The read-only catalogue — `recipes`, `ingredients` and `targets` with the capability matrix — works too, and a workspace can name its Forge by git URL with an optional `ref`, read from a per-machine cache, with a lock that records the ref, commit, recipes and targets it was generated from (see *Remote Forge*). `add recipe` / `remove recipe` change a workspace's recipe choice in `craftar.yaml`, refusing an edit that would not resolve. A writing `sync` records each workspace in a per-machine registry, and `craftar workspaces` lists them all with their status (see *Workspace registry*). `craftar forge impact` lists the workspaces registered on this machine that read a Forge (by path, by a git remote of the clone, or through another clone of the same remote) with what their next sync would do against it, and `forge unify` plans them before and after its writes, names the ones its warnings concern, and with `--prune-recipes` deletes a recipe left identical to its sibling once every one of them plans the same. `craftar doctor` reports, one line per finding, what is off on this machine and in this workspace. `craftar cache prune` removes the cache entries and trees nothing uses. An MCP ingredient can declare `authEnv`, the environment variables its server needs (names only, never a value), and `craftar doctor` checks them; with `claude-code`, `sync` writes an example file listing them. Everything else in the spec (profiles with IDP/PM-tool integrations, local services, `dotnet new` project templates, `craftar ui`, `craftar mcp`) is not built yet.

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

## Quick start: start an empty workspace from a Forge

```bash
# In a terminal, craftar init asks for what the flags do not give:
# the Forge, the profile, then the recipes and the targets to keep or adjust.
cd C:/Projects/acme-portal-workspace
craftar init

# Or pass everything for scripts and CI:
craftar init --workspace C:/Projects/acme-portal-workspace \
  --forge   C:/Projects/forge \
  --profile acme-portal
```

The workspace follows the profile's recipes and targets; `--add-recipe` / `--remove-recipe` adjust the recipes, and `--targets` writes the targets into `craftar.yaml`. When the directory already holds a harness, files equal to the Forge's are adopted and different ones are left as they are and reported — `craftar import` (below) brings them into the Forge.

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
#    (A JSON file that differs only in whitespace is also "adopt"; the first sync rewrites it.)
craftar status --workspace C:/Projects/acme-portal-workspace

# 3. Generate + lock
craftar sync --workspace C:/Projects/acme-portal-workspace
```

From then on, change a rule in `forge/ingredients/rules/<name>/rule.md`, run `craftar sync` in each workspace (or `craftar sync --check` in CI) and every target is regenerated.

## Commands

| Command | What it does |
|---|---|
| `craftar init [--forge <dir\|url>] [--profile <name>] [--ref <ref>] [--targets <a,b>] [--add-recipe <name>]... [--remove-recipe <name>]... [--replace] [--no-sync] [--offline] [--workspace .]` | Starts a workspace: writes a `craftar.yaml` holding `forge` (a directory as the path from the workspace, POSIX; a URL as given), `ref` (a remote Forge only), `profile`, `recipes` (only the lists the recipe flags leave non-empty) and `targets` (only with `--targets`; otherwise the workspace follows the profile's), then runs the first `sync` — which also registers the workspace. **In a terminal** (stdin and stdout both a TTY), `--forge` and `--profile` are optional: what is missing is asked for — the Forge (offering the one last synced on this machine, from the registry), a remote Forge's ref, the profile (from the Forge's list), then the recipes and the targets the profile gives, to keep or adjust; a flag given is never asked for. One confirmation before anything is written, showing what the first sync would do. Ctrl-C, the end of input, or `no` at the confirmation: nothing written, exit 1 (`init cancelled — nothing written`). The run ends with an `again craftar init …` line: the same run as flags, for CI. Off a terminal (a pipe, CI), a missing flag is refused, exit 1, naming the flag; where the terminal does not report a TTY, the flags are required. With both flags given nothing is asked, in a terminal or not. The file is written only once the configuration loads (a remote Forge is fetched as `sync` fetches it; `--offline` reads the cache), resolves and plans, and the sync applies that same plan. `--remove-recipe` and `--add-recipe` go through `remove recipe` / `add recipe`'s core (removes first, then adds; `--replace` swaps a slot holder); a call whose every name changes nothing prints its reasons as a `note`. `--workspace` is created when missing. Files already on disk and not in a lock are adopted when equal to the plan and skipped as a `collision` otherwise, never overwritten, with one warning pointing at `craftar import`. `--no-sync` writes `craftar.yaml` only and prints what the first `sync` would do. When a declared parameter a file cites has no value (see `sync`), `craftar.yaml` is still written — the workspace's `overrides.params` is a place for the value — but the first `sync` is not run: the refusal is printed (`error: N declared parameter(s) have no value — craftar.yaml written, sync not run`, with `then run craftar sync` in its fix line), exit 1; in a terminal the confirmation says `first sync: refused — …` and asks only `Write craftar.yaml`; `--no-sync` prints `next sync: refused — …` and exits 0. Refused, with nothing written and no directory created: an existing `craftar.yaml`; a `--workspace` that is a file, or under one; credentials in `--forge` (the value is never printed); `--ref` with a directory Forge; an unknown target; a recipe both added and removed, or any refusal of `add recipe` / `remove recipe`; a `craftar.local.yaml` that sets `forge` or `profile`, or a key a given flag would write (`ref`, `recipes`, `targets`) — its value would replace the flag's; a Forge, profile or plan that does not load. |
| `craftar import --from claude-code --forge <dir> --profile <name> [--workspace .] [--write-config] [--report <file.md>]` | Reads `.claude/{rules,agents,commands,skills,scripts,hooks}`, `.mcp.json` and, when present, `.kiro/steering` (for inclusion modes and hand-written steering). Creates ingredients, recipes (`base`, one `stack-*` per scoped rule, `<profile>-steering`) and a profile, or updates them. An ingredient already in the Forge is reused when the base, **rendered** for this profile (its declared defaults, the profile's `params`, the workspace's `overrides.params`), equals the workspace file; failing that, when a unique, proved assignment of the base's declared `{{keys}}` reproduces it, the values are **inferred** into the profile's `params` (one value per key per run; never a change another ingredient would feel). A base with section markers is rendered with the profile's `sections` and the workspace's `overrides.sections` first; when the workspace file differs from it only inside sections, the unique content that reproduces the file byte for byte is **inferred** into the profile's `sections` (tried after params, never combined with them; the report counts lines and never prints the content). An import that writes a section value, or compares a workspace file against a base holding markers, sets `schema: 2` in `craftar.forge.yaml`. A reused base takes the place its `<name>--<profile>` variant held: the profile moves to the shared recipe when that orders the base there, and an owned recipe gets the base in the variant's slot, so the rule order (and `AGENTS.md`) stays as it was. Anything else becomes a `<name>--<profile>` variant that emits under the original name, with the reason, so the workspace still round-trips while you decide what to unify. A shared recipe is never widened for one client: a profile whose ingredients differ from `base` or a `stack-*` gets its own `<recipe>--<profile>`. An existing profile is merged in place (`params`, `sections`, the recipes import owns, missing `targets`; every other field and comment kept, and an empty `{}` / `[]` it does not change stays on its line), as is a recipe the profile owns; `--write-config` merges an existing `craftar.yaml` (`forge`, `profile`, `targets`). The report adds `rendered` (with `sections <names>` when a section value filled the render), `inferred`, `sectioned`, `param <key>: <old> → <new>`, `section <key> <name>: <old> → <new>`, `forge craftar.forge.yaml edited (schema: 2)` and `profile … created\|edited\|unchanged` lines. It refuses, with the Forge untouched, a Forge that does not load, a profile or recipe or `craftar.yaml` that does not round-trip through the YAML writer, a misplaced profile, a recipe import writes whose file and `name` disagree, a workspace override that does not parse, a literal `{{key}}` the profile would render, changing a recipe or variant another profile uses, a workspace file holding a section marker at column 0 (sync would not reproduce it: indent it), a Forge base with malformed section markers, and a `craftar.forge.yaml` it needs to bump to `schema: 2` that does not round-trip (set it by hand). Ingredients holding a secret-like value (tokens, private keys, high-entropy MCP `env`/`args` values) are rejected and listed by location — the value is never printed. `authEnv` is never inferred; a variant import rewrites keeps the one it declares, a new variant takes its base's, and a declaration a profile loses is reported. A UTF-16 file with a byte-order mark is decoded for the scan; UTF-16 without one is not detected. An ingredient that would not load back into the Forge (a name that is not slug-like, a non-string MCP `env` value) refuses the import, naming its source; so does an ingredient already in the Forge whose `ingredient.yaml` has an unknown key or a YAML syntax error, naming that file. Every read and check runs before the first write, so an import that fails leaves the Forge untouched and says so. `--report <file.md>` also writes a Markdown report, after the Forge is written: what was created, reused, made a variant or rejected, the import's warnings, and the Kiro side — *Kiro collisions*, every `.kiro/` file that differs from what `sync` would generate for the imported profile (`status`' `collision` state against no lock, so a difference of line endings, BOM or JSON formatting is not one), each with its ingredient and the line counts of the two sides, a rule's steering mirror that outgrew its rule marked `steering bigger than the rule`; and *Unsourced Kiro files*, the files under `.kiro/steering/`, `.kiro/agents/`, `.kiro/skills/` and `.kiro/settings/mcp.json` that the plan for the imported profile does not write — listed, never imported. The report holds **paths and line counts, never content** (a `.kiro/` mirror is not scanned for secrets), and names an inferred parameter's key, not its value; a warning, a rejection reason or the `not computed` line is written with every parameter and section value this run accepted, replaced or inferred as `"…"`, and a variant is named against its base, without its reason — the summary on the terminal keeps them. It describes the profile as imported: of the workspace's own `craftar.yaml` and `craftar.local.yaml` only `overrides.params` and `overrides.sections` are read (as import reads them to decide a reuse) — not its `forge`, `profile`, `targets` or recipes — and `craftar.lock` is not read. The path may be inside the workspace; it is refused, before anything is imported, when it resolves inside the Forge (through symlinks and `..`), when a file already exists there, or when a component of it cannot be resolved. If the Kiro side cannot be computed, its sections read `not computed: …`, the same is an import warning, and the import still exits 0. The report is written after the summary, which then ends with `report <file.md>`; if that write fails the import has still succeeded and the Forge is written, and the command says so and exits 1. Without `--report` none of this is computed. |
| `craftar status` | With a remote Forge, the header's second line names it — `forge <url> @ <ref \| <branch> (default branch)> <commit>`, plus `· lock <commit>` when the Forge moved since the last sync — and `--json` carries `forge: {kind, source, ref, defaultBranch, commit, lockCommit, fetched}` for every Forge. Classifies every file the Forge would produce: `new`, `update`, `unchanged`, `adopt`, `drift`, `collision`, `orphan`, `orphan-drift`. A `.json` file not yet in `craftar.lock` that parses to the planned value with its keys in the same order (it differs only in whitespace, escapes, number spelling or duplicate keys) is `adopt`, and the first `sync` rewrites it with the planned bytes — by design. For `claude-code`'s `.mcp.json` that is two-space JSON keeping the file's BOM and line endings; Kiro's JSON files become CRLF without a BOM, like every Kiro text file. A different key order is a `collision` — except for integer-like keys, which `JSON.parse` reorders. A locked JSON file reformatted by hand is `drift`, not `adopt`. `--json` for tooling: `{forge, statuses, warnings, unsetParams}`. Exits 0 whenever it prints its listing, with one exception: when a declared parameter a file cites has no value (see `sync`) it prints the listing, then the refusal on stderr, and exits 1 — `--json` still prints the whole object, with `unsetParams: [{key, declaredBy, citedBy}]` (`[]` when there is none). Exits 1 on malformed section markers and on a section marker in an ingredient the workspace resolves while `craftar.forge.yaml` declares `schema: 1` (or none), naming the Forge file and line, and when a rendered file would still hold a marker line, naming the ingredient, file and rendered line — as do `sync`, `diff`, `explain` and `ls`. Warns about a section value that names no ingredient, or no marker of an ingredient the workspace resolves, and about marker lines in an emitted file not every target renders as text (copied as they are). |
| `craftar sync` | Renders sections (no rendered body holds a marker; an emitted file not every target renders as text keeps its markers, with a warning), then writes the plan and `craftar.lock` (schema 2: the Forge's source, requested `ref` and commit, the resolved recipes and targets — rewritten only when that content changes). With a remote Forge it fetches first and exits 1 when the fetch fails, `--dry-run` and `--check` included. `--dry-run` shows without writing. `--check` exits 1 when anything is out of sync (CI). `--overwrite-drift` regenerates hand-edited files (explicit, never default). A writing `sync` (not `--dry-run`, not `--check`) also records the workspace in `$CRAFTAR_HOME/registry.json` (see *Workspace registry*); a registry it cannot write is a warning, never a failed `sync`. **Refuses when a declared parameter has no value**: a key an ingredient declares under `params` with no `default`, that a file the plan writes cites as `{{key}}`, and that no layer sets (recipe default, profile `params`, `overrides.params` in `craftar.yaml` or `craftar.local.yaml`). The plan's warnings print, then one block on stderr — `error: N declared parameter(s) have no value — nothing written`, one line per key with the ingredients that declare it and the ones that cite it, and the fix — and `sync` exits 1 with nothing written: no file, no lock, no registry entry; `--dry-run` exits 1 the same way, and `--check` prints its listing, then the block, and exits 1 even when every file is `unchanged`. A `{{key}}` no ingredient declares (an Angular `{{ 'X' \| localize }}`, a stray placeholder) is still left verbatim with a warning, and an empty string is a value. |
| `craftar diff [path] [--exit-code]` | Line diff between disk and what the Forge would generate, for every file `sync --check` refuses: `update`, `drift`, `collision`, `new`, an `orphan` (shown as the removal of the whole file — the next `sync` deletes it) and an `orphan-drift` (a header and one line: `sync` keeps it). For `.claude/settings.craftar.example.json`, when it has drifted or collides, `diff` prints the headers and `content not shown: an example file may hold a value typed by hand`. `[path]` limits it to the one file whose workspace-relative path, as `status` prints it, equals it. Exits 0 by default, differences or not. `--exit-code` exits 1 when there are differences — exactly when `sync --check` would — and makes a `[path]` that names no file craftar manages an error (exit 1, nothing on stdout); without the flag such a path prints `no differences`. With a remote Forge, `--exit-code` also exits 1 when the fetch fails, as `sync --check` does; plain `diff` reads the cached copy with a warning. When a declared parameter a file cites has no value (see `sync`), the refusal is printed on stderr after the diff: plain `diff` still exits 0, `--exit-code` with no `[path]` exits 1 even with `no differences` — as `sync --check` does — and with a `[path]` its exit code answers for that file only. |
| `craftar explain <path>` | Which ingredient, recipe chain, target and origin produced a file and, for an ingredient with sections, which layer filled each one: `sections    flavors (profile globex), extra (default)` (`default`, `profile <p>` or `workspace`). For an ingredient whose files cite parameters, each cited key with the layer that filled it for this ingredient: `params      org (profile globex), port (default), root (unset)` — `default` (the ingredient's own), `recipe <name>`, `profile <p>`, `workspace` (either workspace file) or `unset`. `AGENTS.md` gets neither line: it is not one ingredient. |
| `craftar ls` | Recipes and ingredients resolved for this workspace. |
| `craftar workspaces [--fetch] [--json]` | Every workspace a writing `sync` registered on this machine, sorted by path: name, path, profile, stack (`slot=recipe`), targets, the Forge, the last sync, and a status computed now — `up to date`, `outdated` (`new`, `update` or `orphan` pending), `drift` (a `drift`, `orphan-drift` or `collision`), `no lock`, `missing` (directory or `craftar.yaml` gone) or `error` (it no longer loads, plans or reads its lock, or its `sync` would refuse for a declared parameter with no value — the reason is one of the row's warnings: `sync refused: declared parameter(s) with no value: <keys>`), plus `forge moved` when the Forge's commit differs from the lock's. Read without the network: a remote Forge comes from the cache; `--fetch` fetches first. Each row's warnings print after the table, prefixed with its path. Times are UTC. Writes nothing. Exits 0 whenever the table prints. Takes no `--workspace`. `--json` is a contract: `{registry, fetch, workspaces, warnings}`. |
| `craftar doctor [--workspace <dir>] [--fetch] [--strict] [--json]` | Checks this machine — Node ≥ 22, `git`, `$CRAFTAR_HOME`, the registry (entries whose workspace is gone), the Forge cache (its size, entries nothing names, a fetch that never completed) — and, when run inside one (the current directory, or `--workspace`), this workspace: the configuration and its Forge (cached, fetched or pinned), whether the workspace sits inside its Forge, the plan's warnings, declared parameters with no value, the `${NAME}` variables a written MCP server expects and this environment lacks — `mcp-env` reads `authEnv` next to `${NAME}` (names only, never values) — the lock, `status`, and registration. One line per finding — `ok`, `warn` or `error` — each problem with the command that fixes it; each cause is reported once. A declared parameter with no value is an `error` when a file the plan writes cites it (`sync` refuses that workspace) and a `warn` when nothing cites it. It only reports: nothing is written to a workspace, a lock or the registry, and the Forge cache is used as every reader uses it (`.used` stamps, a rebuilt tree; under `--fetch`, a fetch and the cleanup of trees unused for 14 days). Read without the network; `--fetch` fetches a remote Forge first. Exits 1 on an `error`, or on a `warn` under `--strict`; an explicit `--workspace` without `craftar.yaml` exits 1, while the current directory without one runs the machine checks only. `--json` is a contract: `{version, workspace, fetch, strict, checks: [{id, scope, level, message, fix}], summary}`. |
| `craftar cache prune [--dry-run] [--workspace <dir>] [--json]` | Removes the Forge cache entries nothing uses — no registered workspace (`missing` ones included until `craftar workspaces prune`) and not the current workspace — entries whose first fetch never completed (even when named), and trees unused for 14 days. Whole entries are kept with a warning when the registry is off or unreadable, or the current `craftar.yaml` does not read. Deletes by default; `--dry-run` shows. Never touches a workspace, a lock or the registry; no network. One removing prune at a time per `$CRAFTAR_HOME` (`forges/prune.lock`). An explicit `--workspace` without `craftar.yaml` exits 1. `--json` is a contract: `{home, dryRun, removed: [{path, kind, reason, bytes}], kept: [{path, reason, namedBy}], freedBytes, warnings}`. |
| `craftar workspaces forget <dir>` / `craftar workspaces prune` | `forget` removes one entry (the directory is not touched; an unregistered path exits 1); `prune` removes every `missing` entry and never an `error` one. Nothing else removes an entry. |
| `craftar recipes [--forge <dir> [--profile <name>] \| --workspace <dir>] [--json]` | Every recipe of the Forge, sorted by name: slot, the parents it extends, the ingredients it lists itself and the profiles that reach it. In a workspace (or with `--forge <dir> --profile <name>`) each recipe says whether it is in use and why — `profile`, `workspace` (`recipes.add`), `extends <child>` — and a recipe `recipes.remove` names reads `removed by this workspace`. A context that does not resolve (two recipes on one slot, an unknown recipe, a cycle) still lists everything, marks nothing and warns. Read-only: it resolves, never plans. `--json` is a contract: `{forge, context, recipes, warnings}`. |
| `craftar ingredients [--recipe <name>] [--type <type>] [--forge <dir> [--profile <name>] \| --workspace <dir>] [--json]` | Every ingredient of the Forge, grouped by type: output name, targets, the recipes that list it, and whether the context uses it or the workspace disables it; a reference a recipe makes to an ingredient the Forge does not hold is listed under `missing`, never dropped. `--recipe <name>` lists what choosing that recipe brings, with the parents it extends, parents first; two of them on one slot is a warning. `--type` keeps one type. Read-only. `--json` is a contract: `{forge, context, recipe, ingredients, missing, warnings}`. |
| `craftar targets [--workspace <dir>] [--json]` | The capability matrix (see *Targets*): what each target does with each ingredient type, the paths it writes and what changes. Needs no Forge; inside a workspace it marks the targets in use, and when that workspace does not load or resolve it prints the matrix unmarked with a warning. An explicit `--workspace <dir>` without a `craftar.yaml` exits 1; the current directory without one just prints the matrix unmarked. `--json` is a contract: `{ingredientTypes, targets, warnings}`. |
| `craftar add recipe <name...> [--replace] [--workspace <dir>] [--offline]` | Adds recipes to the workspace's choice: deletes each from `craftar.yaml`'s `recipes.remove` when it is there, and appends it to `recipes.add` when the workspace does not resolve it yet. A recipe that would share a `slot` with another resolved one is refused, naming the holder; `--replace` removes every other holder in the same edit, as `remove recipe` would. Names apply in order, all or nothing, and the edit is written only once the workspace resolves and plans with it. Writes `craftar.yaml` only — in place, keeping its comments and style (a document the YAML writer does not reproduce byte for byte, such as `{ add: [] }` with inner spaces or a column-aligned comment, is refused: reformat it by hand) — and never syncs: it prints the net edit, the new recipe order and what the next `sync` would do (`next sync: 1 new, 1 orphan — run \`craftar sync\``), or `nothing to change`. When the edited workspace has a declared parameter with no value that a file cites (see `sync`), the edit is still made and the line reads `next sync: refused — 1 declared parameter(s) have no value (org)`, exit 0. Refused when `craftar.local.yaml` sets `recipes` (its lists would replace the edited ones). |
| `craftar remove recipe <name...> [--workspace <dir>] [--offline]` | Removes recipes from the workspace's choice: deletes each from `recipes.add`, and appends a profile recipe to `recipes.remove`. A recipe another one still brings in through `extends` is refused, naming the top-level recipe to remove instead. A name the Forge does not hold is accepted only to clean it out of `recipes.add` or `recipes.remove`. Same output, refusals and all-or-nothing rule as `add recipe`. |
| `craftar forge variants [--forge <dir> \| --workspace <dir>] [--json]` | Lists ingredients that have variants, nearest first, with the profile each came from, its distance to the base and its hunks counted by suggested class (`[1 evolution · 2 block]`), then any variant whose base is missing from the Forge. Read-only; exits 0 either way. `--json` prints `{groups, orphans}`; each variant carries `classes: {evolution, value, block}`, which add up to `distance.hunks`. |
| `craftar forge impact [--forge <dir> \| --workspace <dir>] [--json]` | Lists every workspace registered on this machine that reads this Forge — by its path, by a git remote of this clone, or through another clone of the same remote — with what its next `sync` would do against the Forge as it is now: a header, then one line per workspace sorted by path (`unchanged`, the next-sync counts, `missing` or `error: <message>` — a workspace whose `sync` would refuse for a declared parameter with no value is `error: sync refused: declared parameter(s) with no value: <keys>`; ` · after push (<remote>)` for a remote match, ` · after push and pull (<dir>)` for a clone match; `, pins <ref>` when the workspace pins a `ref`). When no registered workspace reads this Forge, the short header (`craftar forge impact — <forge>`) then one line: `no registered workspace reads this Forge on this machine`; when the registry is off, the short header then one line: `the registry is off (CRAFTAR_NO_REGISTRY)`; when the registry cannot be read, exits 1. A workspace whose Forge is remote is refused with the same message as `forge unify`. A remote URL holding credentials is not matched — one warning per remote, `remote <name> of <dir> holds credentials in its URL — not matched` (the URL is never printed). Read-only; no fetch. `--json` is a contract: `{forge, registry, workspaces: [{path, profile, match, via, ref, state, counts, error}]}` (every key always present). |
| `craftar forge diff <type/name> [--against <profile>] [--forge <dir> \| --workspace <dir>] [--json]` | Shows the differences between a base ingredient and each of its variants: a header carrying the same distance `forge variants` reports, then hunk by hunk, each with a suggested class and reason — `evolution` (one side is newer text), `value` (an identifier-like token swapped in shared prose, with a suggested `param.<slug>`) or `block` (lines only one side has) — then the files that exist on only one side. A suggestion never decides anything. It compares the raw Forge text, section marker lines included, so a base with markers shows them as hunks against a variant that has none. Read-only. `--json` prints an array of `{ref, profile, distance, diff}`; each hunk carries `suggestion: {class, reason, tokens?}` next to its `kind`. |
| `craftar forge unify <type/name> --profile <p> (--take base\|variant \| --plan <file> \| --save-plan <file>) [--no-impact] [--prune-recipes] [--forge <dir> \| --workspace <dir>] [--json]` | Resolves one variant back into its base, hunk by hunk. `--save-plan` writes a reviewable plan with every decision set to `keep`, each hunk annotated with its suggested class (which `--plan` ignores) and, for a `value` hunk, a pre-filled `params` list (`token` → suggested `key`); on a `block` hunk, a pre-filled `section: { name }` from the Markdown heading above (or `section-<n>`); and on a hunk touching a section the base already has, that section's name. It refuses a path that resolves inside the Forge (after `..` segments and symlinks) and a path that already exists, so it never overwrites a Forge file or a plan you already edited; it writes nothing else. A hunk set to `take: param` turns each listed token into `{{key}}` in the base, declares the base's text as the key's default in the base's `ingredient.yaml` and writes the variant's text into the variant profile's `profile.yaml` `params` — only after proving that both the base's and the variant's text render back exactly, and only when the same plan resolves the variant; it refuses (with the Forge untouched) a key another layer, profile or ingredient already uses, a variant another profile also uses, a whitespace-only difference, and a YAML file that would not round-trip unchanged. A hunk set to `take: section` (with `section: { name, lines? }`) wraps the base's lines in section markers as the default and writes the variant's lines into the variant profile's `sections` — consecutive hunks with one name form one section, `lines: "<from>-<to>"` widens it over equal base lines, and hunks inside a section the base already has only write the profile value; it is proved (both sides render back exactly) and needs the same plan to resolve the variant; `take: param` and `take: section` may share a plan, never a hunk. It refuses (Forge untouched) a `take: param` or `take: section` on a file no target emits, a variant that holds markers, a profile that already sets that section (another profile for a new section, or the variant's profile with other content), a span that cuts a hunk or crosses another section, a span that covers a hunk outside the run (including `take: base` on a hunk inside a section the plan fills), a hunk mixing lines inside and outside an existing section, and a span reaching a missing final newline; when it adds a section to a Forge still at `schema: 1` it sets `schema: 2` in `craftar.forge.yaml` in place (refused if the file does not round-trip). `--plan` applies an edited plan, refusing when it is not for this exact ingredient/profile or either side's fingerprint moved since it was saved. `--take base\|variant` resolves every decision to that side. Writes the merged base and, once every difference is resolved, removes the variant and rewrites every recipe reference to it (`ingredients`) to name the base. It never edits an `extends`, and deletes a recipe or repoints a profile's recipe list only under `--prune-recipes`; otherwise it edits a profile only to write the values of a `take: param` or `take: section` extraction into the variant's own profile. A `<recipe>--<profile>` left identical to `<recipe>` is reported as a warning unless pruned; `--prune-recipes` deletes such a recipe and repoints every profile that names it — the candidates are found in a dry pass, their profile files join the git check, and pruning is refused when another recipe's `extends` names the candidate, when the registry is off or unreadable, when the registry did not check every workspace (no registered workspace, a missing entry, one whose configuration did not load), when a registered workspace's plan throws, when a workspace's `recipes.add` or `recipes.remove` names the suffixed recipe, when a profile's recipe list cannot be edited in place (a YAML document that does not round-trip), or when the Forge no longer loads when the prune reloads it; each remaining candidate is deleted and its profiles repointed only when every registered workspace plans the same files (the same paths and the same bytes) with and without it — any difference refuses that one candidate, and the Forge stays as `unify` left it. `--prune-recipes` with `--no-impact` is refused before anything is read. `unify` plans every registered workspace of the Forge before its writes and again after them, and reports one `impact:` line per workspace — `no effect`, `1 file changes — <path>` / `<n> files change — <paths>`, `missing` or `error: <message>` (each line carries the same ` · after push (<remote>)` / ` · after push and pull (<dir>)` / `, pins <ref>` suffix as `forge impact`) — replacing the `next: run craftar status …` hint when at least one workspace was checked; an unreadable registry is one warning. The three warnings — a removed variant a workspace may name in `overrides.ingredients.disable`, a new parameter a workspace's `overrides.params` now overrides, a new section a workspace's `overrides.sections` now fills — now name the concerned workspaces with the file that holds the entry, vanish when the registry proves none is concerned, or keep their previous text with a reason in parentheses (the registry could not check N workspaces, no workspace registered, registry off, registry unreadable). `--no-impact` skips both impact passes and restores the previous warning text (the identical-to-sibling warning keeps its new ending). Every recipe rewrite is checked before the first write, so one that cannot land (a reference behind a YAML alias) is refused with the Forge untouched; a failure after writing began (an I/O error, a locked file) names the paths already touched and the `git checkout` / `git clean` commands that undo them. A merge never adds, removes or changes a section marker other than the sections the plan declares; a plan or `--take variant` that would is refused before the first write — take `base` for the marker lines, or `take: section` to fill the section; the citation checks of `take: param` also read the profiles' section values, which can cite `{{key}}`. `ingredient.yaml` is never merged: when the two sides' metadata differs (beyond `name`, `as` and `origin`), the variant stays unresolved and the differing fields are named — edit it by hand, or `--take base` to discard the variant, metadata included. Requires a clean git checkout in the Forge with at least one commit (`--save-plan` excepted) — the Forge has no lock, so git is the undo. It also refuses when any path it would overwrite or delete (the base, the variant, the recipe files it rewrites, the profile a parameter or section extraction edits, the profiles `--prune-recipes` repoints, `craftar.forge.yaml` when it is bumped) is ignored, untracked, modified, or flagged skip-worktree or assume-unchanged in the index, since git could not restore it. `--json` prints `{base, profile, resolved, written, removed, unresolved, variantRemoved, recipes: {rewritten, identicalToSibling, pruned, kept}, metaDiffers, params, profileEdited, sections, manifestEdited, impact, warnings}` for `--take`/`--plan` (every key always present, `[]` when empty), or `{base, profile, plan, unresolved}` for `--save-plan`. |

All commands but `workspaces` take `--workspace <dir>` (default: current directory); the `forge` commands, `recipes` and `ingredients` also take `--forge <dir>` as an alternative to it — a directory: a URL there is refused — and `targets` needs no Forge. With a remote Forge (see *Remote Forge*), `status`, `sync`, `diff`, `explain`, `ls`, `recipes`, `ingredients`, `add recipe`, `remove recipe`, `forge variants` and `forge diff` fetch first and take `--offline` to use the cached copy; `targets` never fetches; `forge unify` refuses a workspace whose Forge is remote — clone it and pass `--forge <dir>`; `import --write-config` keeps a remote `forge:` and sets only `profile` and `targets`.

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

An ingredient's `as` and a script's or hook's `files` entries become part of the paths `sync` writes, so one that climbs out of its folder with `..` (`as: ../x`, `files: [../x.sh]`) fails the Forge load. A leading `/` anchors nothing (`/../x` is refused too). A spelling that stays inside (`./run.sh`, `a/../run.sh`) is kept as written.

`craftar.forge.yaml`:

```yaml
name: forge
schema: 2          # 1 (the default) or 2; 2 is required as soon as a body holds a section marker
description: Craftar Forge — shared harness ingredients, recipes and client profiles.
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
authEnv: [ACME_DOCS_TOKEN]           # names only, never a value
targets: "*"
tags: []
server:
  type: http
  url: https://mcp.acme.dev/docs
  headers: { X-Team: acme }          # not declared by Craftar: passed through to both MCP files
  timeout: 30
```

`authEnv` names the environment variables the server needs — names only, never a value. It is a declaration: the server is emitted exactly as written (how the server receives the variable is yours to write: a `${NAME}` reference where the tool expands one, or nothing at all for a server that inherits the environment — Craftar never expands it). An item that is a token of a known format fails the load.

**Sections.** A body (its **body files**: the `file` of a rule, agent, command or steering — `rule.md` etc. by default; `SKILL.md` of a file-layout skill; every `.md`, `.txt`, `.json`, `.yaml` or `.yml` file of a dir-layout skill; the text files listed in `files` of a script or hook — a body file stays inside the ingredient directory; one declared outside it, or behind a symlinked directory, or spelled differently from the file on disk (letter case, on a case-insensitive file system), fails `sync`, `status`, `diff`, `explain` and `ls`, naming it) can hold blocks a profile or a workspace replaces. A file no target emits (a `notes.md` beside `rule.md`) is ignored — for sections and for `{{param}}` citations alike; a file a target emits but does not render as text is copied (see below). A block sits between two marker lines, and its content is the default:

```markdown
Dispatch reviewers after every commit.

<!-- craftar:section flavors -->
| Repo | Reviewer |
|---|---|
| `acme-api` | backend-reviewer |
<!-- /craftar:section -->

Never edit what a reviewer reads.
```

A marker is a whole line starting at column 0, with single spaces (trailing spaces or tabs are tolerated). Sections do not nest, a name is declared once per ingredient, and a line that looks almost like a marker is an error. An indented marker is plain text — indent it to show the syntax in a rule. The parser is line-based and not Markdown-aware, so a column-0 marker inside a fenced block is still a marker. Markers are read only in body files; in a file a target emits but does not render as text (a skill's `.sh`, an image) they are copied as they are, with a warning; in a file no target emits they are ignored. Agent and command frontmatter lives in `ingredient.yaml` and is never expanded; a rule's or skill's frontmatter is part of its body file, so a column-0 marker there is read like any other. A Forge whose bodies hold a marker must declare `schema: 2` in `craftar.forge.yaml`, so that craftar 0.6.2 and older refuse it instead of emitting the markers; `import` sets it when it relies on markers. A section can also be extracted from a variant with `forge unify` (`take: section`), not only added by hand and re-imported.

Profile `profile.yaml`, with section values keyed by `<type>/<name>` (the output name: a variant's values are its base's), then by section name:

```yaml
name: globex
recipes: [base]
targets: [claude-code, kiro]
params: {}
sections:
  rule/review-posture:
    flavors: |
      | Repo | Reviewer |
      |---|---|
      | `globex-api` | backend-reviewer |
  rule/repo-discovery:
    desktop-client: ""               # empty: the section renders nothing for globex
```

A value is a string. It replaces the section's lines; a value without a final newline gets one, and `""` empties the section. The blank lines around the markers stay when a section is emptied, so put a separating blank line inside the section when an emptied section should leave none extra. A value may cite `{{param}}`: sections are expanded before params are substituted.

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
forge: ../forge # a path, or a git URL (see Remote Forge)
ref: v1.4.0 # optional, with a git URL: a branch, a tag or a full SHA
profile: acme-portal
targets: [claude-code, kiro] # optional, overrides the profile
recipes: {add: [], remove: []} # edited by craftar add recipe / remove recipe
overrides:
  params: {}
  sections: {} # same shape as the profile's sections
  ingredients: {disable: []}
```

Layer precedence, weakest → strongest: the ingredient's declared defaults (scoped to that ingredient) → recipe defaults → profile → `craftar.yaml` → `craftar.local.yaml` (personal, git-ignored). Bodies may use `{{param}}` placeholders; a placeholder in a file no target emits is never rendered, and only body files count as a citation for `forge unify` and `import`; a placeholder with no value in any layer is left untouched and reported as a warning by `status` and `sync` (Angular's `{{ 'X' | localize }}` does not look like a placeholder and passes silently). When the key is one an ingredient **declares** under `params` with no `default`, that is also an error: `sync` refuses and writes nothing (see `sync` in *Commands*). Between layers, objects merge key by key while arrays and scalars from the stronger layer replace the weaker one — `targets: [kiro]` in `craftar.local.yaml` means exactly `[kiro]`. Omit a key in `craftar.local.yaml` to inherit it — an empty list there means empty.

Sections layer the same way, weakest → strongest: the body's default → the profile's `sections` → `craftar.yaml`'s `overrides.sections` → `craftar.local.yaml`'s, merged per section, so a workspace that sets one section of an ingredient keeps the profile's others. There is no recipe layer for sections.

## Targets

`craftar targets` prints this matrix from `src/core/capabilities.ts`; a test plans one ingredient of every type for each target and fails when a cell and its emitter disagree. **native** — written in the tool's own place for that type, as the Forge holds it (for `mcp`, judged on the server file); **converted** — written in another form (frontmatter or a banner added, references rewritten, another container format, or folded into a shared file); **unsupported** — not written: `sync` warns and names an ingredient aimed at that target.

| type | `claude-code` | `kiro` | `agents-md` |
|---|---|---|---|
| `rule` | native | converted | converted |
| `agent` | native | converted | unsupported |
| `command` | native | converted | unsupported |
| `skill` | native | converted | unsupported |
| `mcp` | native | native | unsupported |
| `script` | native | unsupported | unsupported |
| `steering` | unsupported | native | unsupported |
| `hook` | native | unsupported | unsupported |

**claude-code** — emits `.claude/rules|agents|commands|skills|scripts|hooks` and `.mcp.json` verbatim from the Forge (frontmatter kept byte-for-byte). Each MCP server is written exactly as the Forge holds it, undeclared keys included, in its own key order. When a written MCP ingredient declares `authEnv`, sync also writes `.claude/settings.craftar.example.json` — `env` with each declared name and an empty value — for the developer to copy into their own, untracked `.claude/settings.json`; a hand-maintained `.claude/settings.example.json` is never touched; `kiro` and `agents-md` write no counterpart. Existing files keep their line endings and BOM; new files are LF without a BOM. Steering is Kiro-only (its `targets` default to `[kiro]`); one aimed at `claude-code` explicitly (`targets: "*"` or a list naming it) is skipped with a warning.

**kiro** — reproduces, then extends, the hand-written `sync-steering.ps1` script it replaces:
steering = `inclusion` frontmatter + `GENERATED` banner + rule body, with `.claude/rules/` rewritten to `.kiro/steering/` — except a reference to a rule kiro does not write, which follows that rule: kept as `.claude/rules/<x>.md` when `claude-code` writes it, `AGENTS.md (rule: <x>)` when only `AGENTS.md` holds it, otherwise `<x> (rule not in this workspace)` with a warning; an unknown name is still rewritten and is reported. A reference inside a link's text follows the same rules (in a link kept for `claude-code`, only those references move), and a link whose target reads "rule not in this workspace" and whose text is exactly its own path becomes `<x> (rule not in this workspace)` (backticks kept); an unknown name keeps its link. Files are UTF-8 without BOM, CRLF. The same applies to agent prompts and descriptions, command bodies and descriptions, and skill text files; a `steering` ingredient is emitted as written. On top of what the script did, it also generates `.kiro/agents/*.json` (tools mapped to Kiro names, `resources` bound to the agent's stack rule + `repo-discovery`, or `**/*.md` for generic agents), `.kiro/steering/commands/*.md`, `.kiro/skills/*/SKILL.md` and `.kiro/settings/mcp.json`. `.kiro/settings/mcp.json` receives each MCP server exactly as the Forge holds it, in its own key order — including keys Kiro may not use (`type` always went through). The banner text is a parameter (`kiro.banner`) so existing workspaces can adopt without a rewrite. Scripts and hooks have no Kiro equivalent: they are skipped with a warning.

**agents-md** — one `AGENTS.md` with the always-on rules concatenated and the scoped rules after them — each listed at the file a target of the workspace writes for it (`.claude/rules/<name>.md` when `claude-code` writes it, else `.kiro/steering/<name>.md` when `kiro` does), or, when no target writes it, embedded in full under a `> Scoped rule — <scope>` line, for tools that read the open standard (Codex, Cursor, Warp, Copilot, Kimi…). A `.claude/rules/<x>.md` reference inside a body follows the rule it names: it is kept when `claude-code` writes that rule, becomes `.kiro/steering/<x>.md` when only `kiro` writes that file (from the rule or from a `steering` ingredient of that name), becomes `AGENTS.md (rule: <x>)` when the rule's text is in this file, and otherwise becomes `<x> (rule not in this workspace)` with a warning (an unknown name is left as written when `claude-code` is a target); a reference inside a link's text is resolved the same way, and a link whose target reads "rule not in this workspace" and whose text is exactly its own path becomes `<x> (rule not in this workspace)` (backticks kept); without `claude-code`, the warning also names references to other `.claude/` files, which are left as written. Every other ingredient type aimed at `agents-md` — including through the default `targets: "*"` — has no `AGENTS.md` equivalent: it is skipped with a warning — one line per type, naming every skipped ingredient. The file keeps the line endings and BOM of the one it replaces; a new one is LF without a BOM.

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

## Remote Forge

`forge:` may be a git URL — `https://…`, `ssh://…`, `file://…`, or the SCP-like `git@host:org/forge.git` (any SSH user) — with an optional `ref`: a branch (followed: its tip at each fetch), a tag or a full 40-hex SHA (fixed); `refs/heads/<x>` / `refs/tags/<x>` when a name is both; no `ref` follows the remote's default branch. Abbreviated SHAs are refused. A `ref` next to a path `forge:` is ignored, with a warning.

- **The cache.** Each machine keeps one copy per URL in `$CRAFTAR_HOME/forges/` (`~/.craftar` by default): a bare repository and one tree per resolved commit, never written by Craftar, shared by every workspace on the machine. Each tree holds the commit's bytes on every platform: the host's `core.autocrlf`, `core.eol` and global attributes file do not apply to it; the Forge's own `.gitattributes` does. Trees unused for 14 days are removed after a fetch. `craftar cache prune` removes whole entries nothing uses and old trees on demand (see *Commands*). The cache and the workspace registry (below) are the two places, both under `$CRAFTAR_HOME`, where Craftar writes outside a workspace and a Forge on its own.
- **The network.** `sync` (with `--check` and `--dry-run`) and `diff --exit-code` fetch first and exit 1 when they cannot; `status`, `diff`, `explain`, `ls`, `recipes`, `ingredients`, `add recipe`, `remove recipe`, `forge variants` and `forge diff` fall back to the cached copy with a warning; `--offline` uses the cached copy on purpose; with no cached copy every one of them exits 1. `targets` never fetches: it reads the cached copy, and without one prints the matrix unmarked, with a warning. A full SHA already cached is not fetched again.
- **Authentication belongs to git** (credential helper, SSH agent). A URL holding credentials (`https://user:token@…`, a password in any scheme) is refused in `craftar.yaml` and `craftar.local.yaml`, naming the file and never the value. In CI, configure git (e.g. a credential helper or an SSH deploy key), never a token in `forge:`; without a terminal, git does not prompt.
- **Writing into the Forge** stays local: `import` and `forge unify` need a clone passed as `--forge <dir>`; Craftar never pushes. After importing into the clone, push it for `sync` to see the import.
- **`craftar.local.yaml`** may override `forge:` (a local clone while you work on the Forge); every planning command then warns not to commit `craftar.lock` or the generated files.

## Workspace registry

A writing `sync` records the workspace in `$CRAFTAR_HOME/registry.json` (`~/.craftar` by default): its real path, profile, the Forge it used and where that Forge lives, the resolved recipes and targets, and when `sync` last ran there. It is an index, not the memory — `craftar.lock` stays that, and nothing in a workspace changes because of it. `craftar workspaces` prints it as a table with every status computed on the spot — `up to date`, `outdated`, `drift`, `no lock`, `missing` or `error` — read without the network (a remote Forge from the cache; `--fetch` fetches first); `forget` and `prune` remove entries, and a workspace that is gone stays listed as `missing` until you prune it.

- **`CRAFTAR_NO_REGISTRY`** — read the name as "no registry", the way `NO_COLOR` means "no colour". Set to any non-empty value, it turns the registry off: `sync` neither reads nor writes it, and `craftar workspaces` exits 1. An empty value counts as unset. Set it on CI runners and throwaway checkouts, whose directories would only pile up as `missing`.
- **A registry that cannot be written** (an unwritable `$CRAFTAR_HOME`, a busy lock after 60 s, a file this craftar cannot read) leaves `sync`'s files, lock and exit code as they would be, and adds one warning. Craftar never overwrites a registry it cannot read: repair or remove it yourself.
- The registry is per machine: paths are native and absolute, and SSH and HTTPS spellings of one remote are two Forges in it, as they are two cache entries.
- **`craftar init` reads it for the Forge it offers** when it asks: the Forge of the most recent `sync` on this machine, skipping a directory that is gone. The questions never write it — the first `sync` registers the new workspace as any `sync` does. With `CRAFTAR_NO_REGISTRY` set, or a registry it cannot read, no Forge is offered and the question is asked without a default.
- **The registry also tells a Forge its workspaces**: `forge impact` and `forge unify` read it (never write it); a workspace synced on CI, another machine or under `CRAFTAR_NO_REGISTRY` is not known to them, which is why `--prune-recipes` says so.

## Roadmap (from the functional spec)

Phase 0 — foundations (done): schema, import, sync/status/diff/explain, claude-code + kiro + agents-md targets, lock, drift, orphans; `forge variants`, `forge diff` and `forge unify` (`take: param`, `take: section`); sections.

Phase 1 — client profile (in progress). Shipped: the read-only catalogue (`recipes`, `ingredients`, `targets` with the capability matrix); remote Forge (git URL + `ref`, a per-machine cache, the schema 2 lock) and `craftar cache prune`; the workspace registry and `craftar workspaces`; `craftar add recipe` / `remove recipe`; `craftar init` with flags; `craftar doctor`; `craftar forge impact` and `forge unify --prune-recipes`; an interactive `craftar init` (choose the Forge and the profile). Next: cloning a profile's repositories at init; profile-driven integrations (PM tool → MCP, IDP → MCP).

Later: `service` ingredients with compose fragments (`craftar services up`); `dotnet new` template registration; rulesync bridge for Codex/Kimi/Cursor specifics; `craftar docs validate`; GitHub Action and Azure Pipelines task around `sync --check`; `craftar ui`; `craftar mcp` + Claude Code / Agent Plugin packaging.

## Upgrading

### to 0.21.0

- **`craftar import --report <file.md>` is new** and additive: without the flag, `import` reads, writes and prints what it did before. Nothing to do.
- **No byte change**: no emitter, no import decision and no lock changed. No workspace sees `update`.

### to 0.20.0

- **A declared parameter with no value now stops `sync`.** If an ingredient declares a key under `params` with no `default`, a file cites `{{key}}`, and no layer sets it, `craftar sync`, `sync --check`, `status` and `diff --exit-code` exit 1 and `sync` writes nothing. Before, the file was written with `{{key}}` in it and a warning. Run `craftar doctor` to list the keys; set each in the profile's `params` or in `overrides.params`. A `{{key}}` no ingredient declares is left verbatim with its warning, as before.
- **`craftar doctor` reports such a key as `error`** (it was `warn`), so its exit code is 1 without `--strict`. A declared key no file cites stays a `warn`.
- **`craftar workspaces` and `craftar forge impact` show such a workspace as `error`, with the reason.** Neither `--json` gains a key or a value.
- **`craftar init`** on such a profile writes `craftar.yaml`, runs no sync and exits 1; `init --no-sync`, `add recipe` and `remove recipe` exit 0 and say `next sync: refused — …`.
- **`status --json` gains `unsetParams`** (always present, after `warnings`); `craftar explain` gains a `params` line.
- **No byte change**: no emitter and no lock changed. No workspace sees `update`.

### to 0.19.0

- **A Forge that declares `authEnv` needs this version** — an older craftar refuses the unknown key, naming the file.
- **`craftar targets` lists one more path for `claude-code · mcp`**: `.claude/settings.craftar.example.json` next to `.mcp.json`.

### to 0.18.0

- **In a terminal, `craftar init` with `--forge` or `--profile` missing asks instead of failing.** Off a terminal (stdin or stdout is not a TTY) it still exits 1 on stderr, but the line changed: commander's `required option '--profile <name>' not specified` became `--profile is required when craftar init does not run in a terminal — pass it, or run craftar init in a terminal to be asked` (and the `--forge` / both forms). A script matching the old text must match the new.
- **The check moved.** An existing `craftar.yaml`, a `--workspace` that is a file and a bad flag value are now reported before the missing flag.
- **`craftar init --workspace <dir>` under a path that is a file** is refused with `cannot use <path> as a workspace: it is not a directory` instead of a raw `ENOTDIR` error.
- **No byte change**: no emitter, `plan`, `status`, `sync` or lock changed. No workspace sees `update`.

### to 0.17.4

- **A change confined to bytes that are not valid UTF-8 is now seen.** The content hash decoded every file as UTF-8, which folds each invalid byte into the same replacement character, so two files differing only there hashed the same: `sync` reported a raw-copied file (a script or hook outside the text extensions, a binary in a skill directory) `unchanged` after its Forge copy changed and never wrote it, `forge variants` called such a pair identical, and `forge diff` showed no hunk. A file that is not valid UTF-8 is now hashed as its bytes, with line endings and a leading UTF-8 BOM normalized as for any other file; valid UTF-8 hashes exactly as before.
- **No generated file changes; `craftar.lock` does, once, for a workspace holding such a file.** Its lock entry was written with the old hash. While the file equals what the Forge produces, `status` and `sync --check` read it `unchanged`, and the next writing `sync` rewrites that entry's `hash` (and the lock's `generatedAt`) and nothing else. A workspace whose generated files and files on disk are all valid UTF-8 sees no change at all.
- **Until that sync, a file that differs from the Forge reads `drift` whenever the old lock cannot say who changed it.** The old hash recorded such a file without its invalid bytes. So when the Forge's copy still matches the lock under the old hash and the workspace file differs from it — the Forge changed only in those bytes (the very change 0.17.3 never delivered), the file was hand-edited there, or an editor re-saved it as UTF-8 — craftar cannot tell a Forge change from a hand edit: the file reads `drift`, `sync --check` fails and the file is kept until `sync --overwrite-drift` takes the Forge's bytes. A Forge change the old hash could record still reads `update`, and a file that left the Forge `orphan`, as in 0.17.3.
- **A file restored by hand to bytes that are not valid UTF-8 reads `drift`, where it read `unchanged`.** A text file saved in a legacy encoding is emitted with replacement characters (the limit below); a workspace copy put back to the original bytes equalled the generated one under the old hash, so 0.17.3 called it `unchanged`. It differs, and now reads `drift`: kept, reported by `sync --check`, overwritten only by `sync --overwrite-drift`. Two cases are as in 0.17.3, because a lock entry does not say which hash wrote it: when the Forge then changes that file in a way the old hash could record, such a copy reads `update` and is rewritten; and once the file leaves the Forge, it reads `orphan` and is removed.
- **A workspace file not yet in the lock that equals the Forge's copy only under the old hash reads `collision`, where it read `adopt`** and was then rewritten: a text file (`.md`, `.ps1`, `.sh`…) that is not valid UTF-8 is still emitted with replacement characters — a known limit, unchanged — so the two copies do differ. A `.json` file is the exception, as before: one that parses to the planned value is still adopted and rewritten.
- **Fingerprints of ingredients holding a file that is not valid UTF-8 move**: a `forge unify` plan saved for one before 0.17.4 is refused as stale — save it again.
- **`forge diff` and `forge variants` report a difference in a file that is not valid UTF-8 as one hunk of kind `binary`**, with no lines and no line position, counted as a `block`; in `--json` it is a hunk whose `kind` is `binary` and whose `a.lines` and `b.lines` are empty — a new `kind` value beside `block` and `inline`. A pair that differs only in line endings or a BOM has no hunk, as for any other file. `forge unify` still refuses to merge such a file, as before.
- **A `__proto__` key is refused instead of dropped.** In a profile's `params`, `integrations` or `repos`, a recipe's or an ingredient's `params`, or a workspace's `overrides.params` (the top-level keys of each), a key named `__proto__` used to vanish with no message; the file now fails to load with `a __proto__ key is not allowed`, and `craftar import` refuses such a `craftar.yaml` the same way. An MCP `server` keeps such a key, as before.

### to 0.17.3

- **`sync` no longer writes or removes anything outside the workspace through a `..` path.** An ingredient whose `as`, or a script or hook whose `files` entry, climbs out of its folder with `..` used to be written where the path led — outside its own folder (`.claude/scripts/`, `.claude/rules/`, `.kiro/steering/`…), or outside the workspace — and a `craftar.lock` entry holding such a path was removed there once it became an orphan. Now a Forge holding one fails to load (`as must not climb out of its folder with a .. segment`, `a files entry must not climb out of the ingredient directory with a .. segment`), and a lock holding one is refused (`craftar.lock: entry <path> is outside the workspace`): fix the ingredient, or remove the entry from the lock and delete the stray file by hand. `craftar import` never wrote such a spelling.
- **No generated byte changes**: a spelling that does not climb out (`./run.sh`, `/run.sh`, `a/../run.sh`, an `as` with a `/`) keeps the path it had. No workspace sees `update`.

### to 0.17.2

- **Documentation only**: the README status reads phase 1 (phase 0, the foundations, done). No emitter, `plan`, `status`, `sync` or lock changed. No workspace sees `update`.

### to 0.17.1

- **`forge unify --prune-recipes` no longer exits 1 when the Forge stops loading between the recipe cascade's reload and the prune's own reload** (something else edited the Forge during the run): every candidate is kept with the reload's message (`the Forge no longer loads when the prune reloads it: …`). A Forge that `unify`'s own writes leave unloadable still fails `unify` through the recipe cascade's reload, naming the paths written and the `git` commands that restore them. No emitter, `plan`, `status`, `sync` or lock changed. No workspace sees `update`.

### to 0.17.0

- **New command `craftar cache prune`**: removes the Forge cache entries nothing uses, entries whose first fetch never completed, and trees unused for 14 days. Its `--json` output is a tooling contract.
- **`craftar doctor`'s `cache` fix is now `craftar cache prune`** (it was "remove `<dir>` by hand (craftar cache prune is planned)"): a value change of `fix` in `doctor --json`. A `~removing-*` directory under `forges/` (an interrupted prune's leftover) is no longer reported or counted as an entry.
- **A process waiting on a cache entry's lock re-creates the entry** when another process removed it meanwhile, instead of failing with `ENOENT`.
- **No byte change**: no emitter, `plan`, `status`, `sync` or lock changed. No workspace sees `update`.

### to 0.16.0

- **New command `craftar forge impact`**: lists every workspace registered on this machine that reads a Forge with what its next sync would do against it. Its `--json` output is a tooling contract.
- **`forge unify` plans the registered workspaces of the Forge before and after writing**: `impact:` lines replace the `next:` hint when at least one workspace was checked; `--no-impact` restores the previous output except the identical-to-sibling warning's new ending; the three "unify cannot reach workspaces" warnings name the concerned workspaces, vanish when none is concerned and every workspace was checked, or gain the reason in parentheses.
- **`forge unify --json` gains `impact` and `recipes.pruned` / `recipes.kept`** (additive; always present).
- **New flag `--prune-recipes`**: deletes a recipe left identical to its sibling and repoints the profiles that name it, only when every registered workspace plans the same files.
- **No byte change**: no emitter, `plan`, `status`, `sync` or lock changed. No workspace sees `update`. A prune changes `craftar.lock`'s `recipes` at the next `sync` of a workspace on that profile, and that workspace's registry entry (`recipes`, `stack`) with it.

### to 0.15.0

- **New command `craftar doctor`**: reports, one line per finding, what is off on this machine and in this workspace. Its `--json` output is a tooling contract, like `status --json`.
- **No byte change**: no emitter, `plan` output, `status` or lock changed. No workspace sees `update`.

### to 0.14.0

- **New command `craftar init`**: writes `craftar.yaml` in a workspace that has none, then runs the first `sync`. It never edits an existing `craftar.yaml`.
- **A missing `craftar.yaml`** is now reported with `craftar init --workspace "<dir>" --forge <dir> --profile <name>` first and `craftar import … --write-config` second, by every command that reads the workspace. Only the message changes; the exit code does not.
- **No byte change**: no emitter, `plan`, `status`, `sync` or lock changed. No workspace sees `update`.

### to 0.13.0

- **New commands `craftar add recipe` and `craftar remove recipe`**: they edit `recipes.add` / `recipes.remove` in `craftar.yaml` and nothing else; they never sync.
- **A `recipes.add` name the Forge does not hold** now fails every resolving command with `recipe "<x>" not found (referenced by craftar.yaml recipes.add)` instead of `… (referenced by profile <name>)`, and `recipes` / `ingredients` show that text in their warnings (`--json` included). Only the message changes; the exit code does not.
- **No byte change**: no emitter, `plan`, `status`, `sync` or lock changed. No workspace sees `update`.

### to 0.12.0

- **A writing `sync` now writes outside the workspace**: `$CRAFTAR_HOME/registry.json` (`~/.craftar` by default) gains or updates the workspace's entry. On CI runners and throwaway checkouts set `CRAFTAR_NO_REGISTRY=1`. A registry that cannot be written is a warning; the exit code of `sync` does not change.
- **New command `craftar workspaces`** (with `forget` and `prune`). Its `--json` output is a tooling contract, like `status --json`.
- **No byte change**: no emitter, `plan`, `status` or lock changed. No workspace sees `update`.

### to 0.11.0

- **`craftar.lock` is schema 2**, written by the next `sync` of every workspace, path Forge or remote: it adds `forge.ref`, `recipes` and `targets`. **Once a schema 2 lock is committed, every craftar up to 0.10.1 stops on it** (a zod error on `schema`) until upgraded — upgrade the whole team, and CI, before committing it. This craftar reads schema 1 and 2, and refuses a later one by name.
- **The lock is rewritten only when its content changes** (`generatedAt` is when it last did): a `sync` that changes nothing no longer touches it. The first `sync` after upgrading rewrites it once.
- **A `user@host:path` value of `forge:` is a URL** now (any SSH user, not only `git@`); before, it was read as a relative path.
- A `forge:` value holding credentials is refused; a `ref` next to a path `forge:` is ignored with a warning; `forge:` from `craftar.local.yaml` adds a do-not-commit warning.
- `status --json` gains a `forge` key (additive). `diff`, `explain`, `ls`, `forge variants` and `forge diff` print warnings about loading the workspace on stderr. A missing path Forge reads `Forge not found at <path>`.

### to 0.10.0

- **`craftar diff` shows orphans.** A file the Forge no longer produces is printed as the removal of the whole file (`+++ <path> (forge: no longer produced — sync removes it)`), and a hand-edited one as a header and one line, since `sync` keeps it. Output changes only in a workspace that has an `orphan` or an `orphan-drift` — one whose only pending change was an orphan used to print `no differences`; elsewhere it is byte for byte 0.9.0's.
- **`craftar diff --exit-code`** exits 1 when there are differences — exactly when `sync --check` would — and refuses a `[path]` that names no file craftar manages. Without the flag `diff` still exits 0.
- **No byte change**: no emitter, `plan`, `status` or `sync` changed. No workspace sees `update`.

### to 0.9.0

- **Three new read-only commands**: `craftar recipes`, `craftar ingredients` and `craftar targets`. They write nothing — no generated file, no lock, no Forge file.
- **No byte change**: no emitter changed, and `craftar ls` prints what it printed before. No workspace sees `update`.
- Their `--json` output is a tooling contract, like `status --json`: removing or renaming a key, changing a value's type, or adding a capability state will be announced here.

### to 0.8.6

- **A rule reference inside the text of a Markdown link is now resolved like any other**, in `AGENTS.md` and in the kiro files. Before, the text of a link that `AGENTS.md` or kiro rewrote was copied as the Forge held it, or blanket-rewritten to `.kiro/steering/`.
  - A link whose target reads "rule not in this workspace" and whose text is exactly its own path — `[.claude/rules/x.md](.claude/rules/x.md)`, backticks or not — becomes `x (rule not in this workspace)`, backticks kept. Any other text keeps the link's usual wording, with its references resolved.
  - In a link kiro keeps for `claude-code`, only the references in the text move; the rest of the text stays as written.
- **No byte change** for the `.kiro/` files of a workspace whose kiro texts cite only rules kiro writes or names that are no rule, nor for an `AGENTS.md` written with `claude-code` whose links cite only rules `claude-code` writes or names that are neither a rule nor a `steering` file kiro writes — a workspace `craftar import` produced keeps its `.kiro/` bytes, and its `AGENTS.md` bytes unless a link's text names one of its hand-written steering files. An `AGENTS.md` written without `claude-code` updates wherever a link's text holds a `.claude/rules/<x>.md` reference, known rule or not. In a kiro file, a link's text that cites an unknown name now adds an entry to the `kiro:` warning; its bytes do not change, except in a link kept for `claude-code`, where that name moves to `.kiro/steering/`.
- An affected workspace shows `AGENTS.md` or the `.kiro/` files as `update`, and `craftar sync --check` exits 1 until it syncs.

### to 0.8.5

- **The kiro target stops turning a reference to a rule it does not write into a `.kiro/steering/` path that does not exist.** Only files under `.kiro/` change; no other generated file and no lock field.
  - **No byte change:** a workspace in which every rule a kiro text cites is one kiro writes, and whose hand-written commands cite no `.claude/rules/` path in their `description`. Every workspace `craftar import` produced is in this case. A cited unknown name now adds a warning.
  - **A cited rule kiro does not write:** the reference goes back to `.claude/rules/<x>.md` when `claude-code` writes the rule, becomes `AGENTS.md (rule: <x>)` when only `AGENTS.md` holds it, or else `<x> (rule not in this workspace)`.
  - **A command written by hand in the Forge (no raw frontmatter):** its `description` is now resolved like its body, and that includes the directory rewrite.
- **At most one `kiro:` warning about rule references per plan.** It names every reference reworded to "rule not in this workspace", and every unknown name, which is still rewritten to `.kiro/steering/`. It never changes an exit code.
- An affected workspace shows those `.kiro/` files as `update`, and `craftar sync --check` exits 1 until it syncs.
- An agent's `resources` do not change.

### to 0.8.4

- **A `.claude/rules/<x>.md` reference inside a rule body that goes into `AGENTS.md` is resolved by the rule it names.** Only `AGENTS.md` changes; no other generated file and no lock field.
  - **No change, no warning:** a workspace whose cited rules are all written by `claude-code` — every workspace `craftar import` produced — and one whose bodies cite no `.claude/rules/` path and, without `claude-code`, no other `.claude/` path either. Without `claude-code`, a body citing other `.claude/` files keeps its bytes but gets the warning.
  - **No `claude-code`:** each reference moves. It becomes `.kiro/steering/<x>.md` (kiro writes it), `AGENTS.md (rule: <x>)` (its text is in the file) or `<x> (rule not in this workspace)`.
  - **With `claude-code`:** only a reference to a rule `claude-code` does not write, or to a `steering` ingredient `kiro` writes, moves. An unknown name is left as written.
- **At most one warning per `AGENTS.md`** names every reference turned into `<x> (rule not in this workspace)` (a reference made to point at `.kiro/steering/` or into `AGENTS.md` is not reported). Without `claude-code`, it also names references to other `.claude/` files (agents, commands, skills, scripts, hooks), which are left as written. It repeats on every run until the body, the cited rule's `targets` or the workspace's targets change, and it never changes an exit code.
- An affected workspace shows `AGENTS.md` as `update`, and `craftar sync --check` exits 1 until it syncs.
- The kiro emitter still rewrites every `.claude/rules/` to `.kiro/steering/`; 0.8.5 addresses it in part — see *to 0.8.5*.

### to 0.8.3

- **`AGENTS.md` lists a scoped rule (`fileMatch`, `manual`, `auto`) only at a file a target of the workspace really writes, and embeds it when none does.** Only `AGENTS.md` changes; no other generated file and no lock field.
  - A workspace with `claude-code` whose scoped rules keep the default `targets` — every workspace `craftar import` produced — sees **no change**, and neither does one with no scoped rule aimed at `agents-md`.
  - With `kiro` and `agents-md` but no `claude-code`, each scoped line moves from `.claude/rules/` to `.kiro/steering/`.
  - With `agents-md` alone, each scoped line becomes the embedded rule, and the file grows.
  - A scoped rule whose own `targets` exclude `claude-code` moves to `.kiro/steering/`, or is embedded when no file-writing target of the workspace admits it.
- An affected workspace shows `AGENTS.md` as `update`, and `craftar sync --check` exits 1 until it syncs. To keep a scoped rule's text out of `AGENTS.md`, take `agents-md` out of that rule's `targets`.
- References to `.claude/rules/…` inside a rule body are emitted as the Forge holds them. In a workspace without `claude-code` such a reference points at no file; a later release (0.8.4) addresses it.

### to 0.8.2

- **A file no target emits (e.g. notes beside `rule.md`) is no longer read for sections or `{{param}}` citations** — a malformed marker there no longer fails `sync`/`status`/`diff`/`explain`/`ls`/`import` or trips the `schema: 1` gate, and a `{{key}}` there no longer makes `unify`/`import` refuse. No emitted byte changes.
- **`take: param` and `take: section` on such a file are now refused** (`… is not emitted by any target`). 0.8.1 accepted both there, so a plan saved under 0.8.1 that extracts from such a file no longer applies. A Forge that already ran such a `take: section` under 0.8.1 has markers in that file and a value in the profile's `sections`; 0.8.2 ignores those markers and warns on every `sync` and `status` that the profile sets a section with no such marker — delete the value from the profile, or move the section into the body file. A `take: param` run under 0.8.1 on such a file left a default in `ingredient.yaml` and a value in the profile's `params`; both are inert now — remove them by hand.

### to 0.8.1

- **No behaviour change.** This is a documentation and test-only release.
- **The README now states that adopting a JSON file rewrites it on the first sync** — by design. `claude-code`'s `.mcp.json` becomes two-space JSON and keeps its BOM and line endings; Kiro's JSON files become CRLF without a BOM. Only differences `JSON.parse` erases are adopted; a different key order is a `collision`.
- **Test-only CI fix**: the test suite no longer reads `.git/` in its Forge snapshots, and its test repositories turn git's automatic maintenance off (`maintenance.auto`, `gc.auto`), ending a flake where that background maintenance raced the snapshots.

### to 0.8.0

- **`forge unify` can write `sections` into a profile and set `schema: 2` in `craftar.forge.yaml`.** craftar 0.6.2 and older then refuse that Forge, as after an import that relies on markers.
- **A plan that uses `take: section` is refused by craftar 0.7.x**, which does not know the value; a plan saved by 0.8.0 with every decision still `keep` loads in 0.7.x.
- **U1's advice now ends `take base for the marker lines, or take: section to fill the section`.**

### to 0.7.0

- **A Forge with section markers declares `schema: 2`.** 0.7.0 refuses to sync a workspace that resolves a marked body while `craftar.forge.yaml` says `schema: 1` (or nothing), and `import` sets `schema: 2` itself when it writes a section value or compares a workspace file with a marked base. craftar 0.6.2 and older refuse a `schema: 2` Forge at load, so upgrade every workspace that uses the Forge before its first marker, and when you add markers by hand, set `schema: 2` in the same commit — an older CLI syncing a `schema: 1` Forge with markers writes the marker lines into every target.
- **`sections` and `overrides.sections` are validated.** A key of the wrong shape (`review-posture.flavors` instead of `rule/review-posture: { flavors: … }`) or a value that is not a string fails the load. A key naming no ingredient, or a section that an ingredient the workspace resolves does not declare, is a warning.
- **`import` may refuse more, and write more.** It refuses a workspace file holding a section marker at column 0, a Forge base with malformed markers, and a `craftar.forge.yaml` it cannot bump in place. It may write `sections` into a profile and bump the manifest.
- **Recipe and profile bytes can differ from 0.6.2's on re-import.** A re-import that swaps a profile's `<name>--<profile>` variant for its base — in any Forge, with markers or not — now keeps the base in the variant's place: the profile moves to the shared recipe when that orders the base where the variant was (`profile.yaml` `recipes`), otherwise its owned recipe gets the base in the variant's slot (`recipes/<recipe>--<profile>.yaml`). 0.6.2 appended the base, so `AGENTS.md` changed order at the next sync; 0.7.0 keeps it.
- **An in-place profile edit keeps untouched empty fields.** 0.6.2 rewrote an untouched `params: {}` (or `targets: []`) as a block on every import that edited `profile.yaml`; 0.7.0 leaves it on its line and switches only the collection it fills. A profile 0.6.2 already rewrote stays as it is.
- **`forge unify` refuses a merge that changes section markers** — take `base` for the marker lines.

### to 0.6.1

- **`import` refuses a recipe it writes whose file and `name` disagree.** With `recipes/shared.yaml` declaring `name: base`, 0.6.0 wrote a second `base` next to it and the Forge then loaded only one of the two; with `recipes/base.yaml` declaring another name, it read that recipe as `base`. Rename the file after the `name` it declares and re-run. In a Forge with no manifest yet, a recipe that does not load refuses the import too, even one import does not write, and a profile that does not load now names its file.
- **A key a run already relied on renders at its current value.** Import no longer infers it again, so a line that was ambiguous only through it can now be reused.
- **Some sources 0.6.0 reused become variants.** A profile value is no longer set when it would move a Forge ingredient whose workspace copy was skipped or rejected for a secret, nor over a default an earlier ingredient of the run rendered with (0.6.0 set it; when another earlier ingredient rendered the key at a different default, that one changed at the next `sync`).

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
