# Changelog

## 0.5.0

### Changed

- The tool descriptions, their parameter notes and the system-prompt guidelines
  are shared with the other adapters (`@seangle/remember-core` `text.ts`) and
  shortened: about 1,080 fewer input tokens per request, a 35% cut of the memory
  tool pack, with no lost capability.
- The guidelines now say when to write, instead of only when not to. The pack's
  only write rule used to be "use memory_write sparingly … when in doubt, do not
  write"; it is replaced by a trigger (a corrected assumption, a convention, a
  working command, a decision with its reason, a quirk that cost a detour) and a
  quality bar that keeps repository statements and session state out.
- The `## Nested workspace memory` header states the trigger and the exact call.
  Pi also announces a child bank just in time: a tool call that touches a path
  inside one appends a single `<system_reminder>` naming the bank, once per
  session, and the notice disappears after `memory_read({root})` reads it.
- A workspace with no store gets a one-paragraph cue in the `remember` section,
  naming `memory_write` and `memory_store`. An unreadable store never gets it.

### Added

- `REMEMBER_AUTO_INIT` (default `1`): the first write creates the local store, so
  a tentative write no longer fails in a workspace that was never initialized.
  Set it to `0` to require `memory_init` again.

### Fixed

- Reading memory no longer fails in an uninitialized workspace. A default
  `memory_read` or `memory_search` used to return "Local memory is not
  initialized" — hiding global memory and every earlier fact — while another
  guideline said not to initialize merely to make a search succeed.
- `memory_status` says "the first write creates it" instead of pointing at
  `memory_init` when auto-initialization is on.

## 0.4.0

### Changed

- The `remember` section is written once per session and held byte-identical. A
  later change is a `<system_reminder>` context message at the end of the request
  instead of a new system prompt, so the provider's prefix cache survives every
  memory write. A new session, a compaction, or a workspace change takes a fresh
  baseline; more than 12 simultaneous changes render as one line asking for a
  read of the store.
- The migration notice rides with that reminder, so it no longer changes the
  section when it appears or disappears.
- Child workspaces with a bank of their own are listed under
  `## Nested workspace memory` (path and counts only). The discovery walk is
  depth-limited, cached for 30 s, and never runs a subprocess or a synchronous
  filesystem call.
- `memory_status` reports the nested banks and the directories scanned.
- Requires `@seangle/remember-core@^0.2.0` and
  `@seangle/remember-migrators@^0.2.0`.

### Added

- `REMEMBER_NESTED`, `REMEMBER_NESTED_DEPTH`, `REMEMBER_INJECT_CHARS_NESTED`,
  and `REMEMBER_DELTA_CHARS`.

## 0.3.1

### Fixed

- Automatically create `recovery/.gitignore` with `*` before writing recovery
  artifacts, keeping their contents out of version control by default.
- Preserve existing recovery ignore rules and reject unsafe symlinked paths.
- Require `@seangle/remember-core@^0.1.1` and
  `@seangle/remember-migrators@^0.1.1` so new installs receive the fix.

## 0.3.0

Breaking replacement of the standalone 0.2.0 implementation, now maintained in
[Esensats/agents-remember](https://github.com/Esensats/agents-remember).
The npm name and install command are unchanged.

### Changed

- Shared host-independent `@seangle/remember-core@0.1.0` and explicit
  `@seangle/remember-migrators@0.1.0` dependencies.
- Workspace memory defaults to `.agents/memory`, shared with compatible adapters,
  instead of `.pi/memory`. Global memory remains Pi-owned.
- Published plain ESM JavaScript instead of runtime TypeScript.
- Snapshot rebuilt before each run in Pi's named `remember` prompt section;
  unchanged bytes remain stable and external changes appear on the next run.
- Environment configuration uses `REMEMBER_*`. In particular,
  `PI_REMEMBER_DIR` becomes `REMEMBER_GLOBAL_DIR`.
- New timestamps use minute-precision UTC; existing valid timestamps are retained.

### Migration

- New `memory_migrate` tool and `/memory migrate` command.
- Migration is explicit, supports recognized legacy version-1 stores, preserves
  current fact/note IDs and paths, and reports skipped invalid/duplicate content.
- Local migration leaves the legacy source intact and refuses existing targets.
- Global legacy stores require explicit in-place migration with source and target
  set to the global directory.
- Old recovery history and migration artifacts are not converted. They remain
  at the source; in-place adoption leaves old files present but does not promise
  compatibility. Back up stores and stop all writers before migrating.
- Populated unmarked stores are refused, not silently adopted. Upgrade pre-v1
  formats with the legacy 0.2.0 implementation first.

### Removed

- Opt-in automatic exit-summary model calls and `PI_REMEMBER_EXIT_SUMMARY*`
  configuration. `/memory update` remains available for explicit review.

See [README.md](README.md) for upgrade instructions and concurrency limits.

## 0.2.0 and earlier

Standalone implementation and historical changes:
[Esensats/pi-remember](https://github.com/Esensats/pi-remember).
