# @seangle/remember-core

Host-agnostic plain-file memory engine for coding agents. This is the shared
engine behind [agents-remember](https://github.com/Esensats/agents-remember);
Pi users should install
[@seangle/pi-remember](https://www.npmjs.com/package/@seangle/pi-remember).

- Facts in `MEMORY.md`; detailed notes in Markdown with validated frontmatter.
- Stable memo IDs, lexical search, derived catalogues, and bounded snapshots.
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

Mutations are not protected by a general cross-process writer lock. Avoid
concurrent writers to the same store. Memory is agent-writable data, not trusted
instructions; do not store secrets.

## License

Apache-2.0. Copyright 2026 Esensats.
