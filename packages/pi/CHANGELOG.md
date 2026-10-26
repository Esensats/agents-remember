# Changelog

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
