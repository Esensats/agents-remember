# @seangle/pi-remember

Durable, plain-file memory for the [Pi coding agent](https://pi.dev/): curated
facts, Markdown notes, lexical search, stable memo IDs, recovery, and a
byte-stable session snapshot. Save knowledge that was expensive to obtain and
will matter again—not transcripts, todos, or temporary debugging state.

This is the Pi adapter for
[agents-remember](https://github.com/Esensats/agents-remember). Starting with
**0.3.0**, it replaces the standalone implementation while retaining the same
npm package name. The unscoped `pi-remember` package is unrelated.

## Install

```sh
pi install npm:@seangle/pi-remember
```

Restart Pi or run `/reload`. Requires Node.js **>=22.15** and Pi host APIs tested
with **`@earendil-works/pi-coding-agent@1.4.0`**. Published code is compiled ESM
JavaScript; users do not need a build step. Host SDK packages are peer dependencies
provided by Pi, not bundled copies.

If you already install this npm package, use:

```sh
pi update npm:@seangle/pi-remember
```

A pinned version stays pinned; change its installation specification to upgrade.
Remove any manually installed or local-path copy first so two extensions do not
register the same `memory_*` tools. Keep memory stores: they live separately.
**Read the migration section before upgrading from 0.2.x.**

## Stores and context

| Scope | Default path |
|---|---|
| Local | `<workspace>/.agents/memory`—shared with compatible agent adapters |
| Global | `~/.pi/agent/memory`—Pi-owned |

Facts live in `MEMORY.md`; notes live in `notes/<date>-<slug>.md` with validated
`description`, `memory-id`, `created-date`, and `last-modified-date` frontmatter.
The `remember.json` marker records store format version 1. Updates and deletions
produce recovery records for conflict-aware undo.

Facts and a derived note catalogue enter the named `remember` system-prompt
section. Note bodies remain on disk until read or searched. The snapshot is
rebuilt before each run; Pi patches the transcript only when its bytes change.
Each scope has a default 3,000-character budget, with middle truncation for large
stores. Read/search before assuming the snapshot is complete.

Memory is agent-writable background data, **not trusted instructions**. Do not
store secrets. Add `.agents/memory/` to a workspace's `.gitignore` if memory should
remain private; recovery records can contain removed information too.

## Tools and command

| Tool | Purpose | Default scope |
|---|---|---|
| `memory_init` | Explicitly initialize local memory in an existing workspace | local |
| `memory_write` | Append one durable fact, at most 300 characters | local |
| `memory_store` | Store a Markdown note; `title` means its short description | local |
| `memory_read` | Read facts/catalogue, filter, or fetch a memo by ID/path | both |
| `memory_search` | Ranked lexical search over facts and note bodies | both |
| `memory_update` | Replace one memo's content, preserving identity and path | local |
| `memory_forget` | Recoverably remove matches by text/description/path/metadata | local |
| `memory_restore` | Undo a deletion or update with its recovery ID | both |
| `memory_status` | Inspect paths, counts, configuration, and snapshot size | both |
| `memory_migrate` | Explicitly migrate a supported legacy store | explicit paths or local defaults |

Local reads and writes require an initialized store. Global memory needs no
explicit initialization. Optional `root` selects another existing workspace's
local memory for that call; it does not change the session workspace or global
memory. A memo ID identifies knowledge; a recovery ID identifies an undo record.
Read before updating and preserve unrelated content.

Search is lexical, with exact tokens, field weighting, phrase/coverage boosts,
and one hit per note. No embeddings, database, model calls, or persistent search
index are involved. Tool output is bounded and truncation is reported.

- `/memory` or `/memory status`: show status without starting an agent turn.
- `/memory migrate`: migrate the current workspace's recognized legacy store.
- `/memory update`: ask the current agent to review durable knowledge, using a
  follow-up turn rather than interrupting ongoing work. This can incur normal
  model usage; it is not an automatic exit summarizer.

## Upgrading from 0.2.x

**0.3.0 is a breaking release.** The extension keeps its npm name but now uses
shared core/migrator packages and a different local-store location.

1. Back up important stores and stop other memory writers.
2. Upgrade the extension and rename any configured environment variables below.
3. For each workspace, inspect `memory_migrate({dryRun: true})`. With user
   approval, run `/memory migrate` or `memory_migrate({})`.
4. Review skipped files/warnings and verify facts/notes before relying on the new
   store. Do not delete the source just because migration completed.

The supported source is a legacy **version-1** store with `pi-remember.json`.
If you still have an older/unmarked legacy format, first upgrade it with the
legacy 0.2.0 extension. The new adapter does not silently adopt populated,
unmarked stores or automatically convert old formats on reads.

### Workspace memory

Migration copies current facts and valid notes from `.pi/memory` to
`.agents/memory`, preserving memo IDs and note paths and leaving the source
intact. Invalid notes and duplicate IDs are skipped and reported. Existing
target stores are refused, not merged.

**Recovery history and old migration backups are not copied.** Keep the source
if you need them. Do not mix old and new writers: the separate local stores will
diverge, and legacy writers do not understand the new format marker.

### Global memory

The global path stays `~/.pi/agent/memory`, but an existing legacy store still
needs an explicit, one-time in-place migration. `/memory migrate` handles local
memory, not global memory. Use explicit tool arguments (adjust paths if configured):

```js
memory_migrate({
  source: '~/.pi/agent/memory',
  target: '~/.pi/agent/memory',
  dryRun: true,
})
// Only after approval and reviewing the plan:
memory_migrate({
  source: '~/.pi/agent/memory',
  target: '~/.pi/agent/memory',
})
```

A recognized in-place store receives only `remember.json`; its existing files
are left in place. Old recovery files are not converted or guaranteed compatible
with the new engine. Do not use the old extension against this store afterward.

### Other changes

- `PI_REMEMBER_DIR` becomes `REMEMBER_GLOBAL_DIR`.
- `PI_REMEMBER_INJECT_CHARS_GLOBAL` and `_LOCAL` become
  `REMEMBER_INJECT_CHARS_GLOBAL` and `_LOCAL`.
- The old opt-in `PI_REMEMBER_EXIT_SUMMARY*` feature is **not included**. Use
  `/memory update` for an explicit review instead.
- New timestamps use UTC minute precision; existing valid timestamps remain
  readable and are preserved.

## Configuration

| Variable | Default |
|---|---|
| `REMEMBER_DIR_NAME` | `.agents` (workspace configuration directory, not a store path) |
| `REMEMBER_GLOBAL_DIR` | `~/.pi/agent/memory` |
| `REMEMBER_INJECT_CHARS_GLOBAL` | `3000` |
| `REMEMBER_INJECT_CHARS_LOCAL` | `3000` |
| `REMEMBER_AUTO_INJECT` | `1` |

Budgets must be positive integers; invalid/nonpositive values fall back to the
default. Set `REMEMBER_AUTO_INJECT=0` to disable injection, not the tools.
Configuration loads when the extension loads; restart or `/reload` after changes.

## Concurrency and safety

Pi's mutation queues serialize cooperating operations within one process, not
across Pi/DSH processes or editors. Avoid simultaneous writes to a shared store,
including during migration. Path checks are not a sandbox against hostile
concurrent filesystem changes. Stored paths, credentials, or remembered facts
never grant permission for remote access.

## Local development

```sh
git clone git@github.com:Esensats/agents-remember.git
cd agents-remember
pnpm install
npm run check
npm run test:packed
pi install ./packages/pi
```

Remove an existing npm installation before installing the local path. Local
packages load in place; rebuild with `npm run build` and run `/reload` after edits.
Tests use temporary stores, not live memory. `test:packed` additionally installs
only release tarballs outside the monorepo and reruns the adapter integration
suite against emitted JavaScript.

## License

Apache-2.0. Copyright 2026 Esensats.
