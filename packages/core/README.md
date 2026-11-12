# @seangle/remember-core

Host-agnostic plain-file memory engine for coding agents. This is the shared
engine behind [agents-remember](https://github.com/Esensats/agents-remember);
Pi users should install
[@seangle/pi-remember](https://www.npmjs.com/package/@seangle/pi-remember).

- Facts in `MEMORY.md`; detailed notes in Markdown with validated frontmatter.
- Stable memo IDs, lexical search, derived catalogues, and bounded snapshots.
- Bounded, cached discovery of child workspaces that keep a bank of their own.
- A frozen per-session baseline plus `<system_reminder>` deltas, so an injected
  snapshot never rewrites the head of a conversation.
- In-place updates, recoverable deletion, and conflict-aware undo.
- Explicit workspace initialization and store-version guards.
- No host SDK imports, runtime dependencies, database, embeddings, or model calls.

## Install

```sh
npm install @seangle/remember-core
```

Requires Node.js >=22.15. Published code is plain ESM JavaScript.

Adapters supply store paths, configuration, mutation serialization, and UI.
The engine does not select a harness-specific global directory or migrate
legacy stores automatically. See the
[architecture and store documentation](https://github.com/Esensats/agents-remember#core)
and the [source API](https://github.com/Esensats/agents-remember/tree/main/packages/core/src).

A populated store requires `remember.json` with `{"version":1}`. Use
`@seangle/remember-migrators` for supported legacy stores; do not mark
unvalidated content as current by hand.

`discoverNestedStores()` finds child workspaces under a root, bounded by depth,
directory count, wall-clock budget, and store count; it never follows a symlink,
runs a subprocess, or calls a synchronous filesystem function, and a finished
walk is cached for 30 s. `buildSnapshot()` lists what it found after the two
scopes.

`SnapshotLedger` holds one frozen snapshot per session. Render the frozen text
for as long as the session lasts and append what `delta()` returns for a later
change: the system prompt stays byte-identical and the provider's prefix cache
survives writes. `captureState()` and `stateFromCatalogue()` build the diffable
state from a catalogue that is already read.

Mutations are not protected by a general cross-process writer lock. Avoid
concurrent writers to the same store. Memory is agent-writable data, not trusted
instructions; do not store secrets.

Before writing recovery, the engine creates `recovery/.gitignore` containing
`*` if missing, without overwriting existing rules. Reads, initialization, and
no-op mutations leave recovery untouched. Recovery can retain removed content;
ignoring it does not untrack committed records or remove them from Git history.

## License

Apache-2.0. Copyright 2026 Esensats.
