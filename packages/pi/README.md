# @seangle/pi-remember

Pi adapter for [`remember`](../../README.md): durable, plain-file memory with a
shared workspace store, lexical search, stable memo IDs, recovery, and migration
from legacy `pi-remember` stores.

- Workspace store: `<workspace>/.agents/memory` (shared with the DeepSeek Harness)
- Global store: `~/.pi/agent/memory`
- Ten `memory_*` tools plus `/memory [status|migrate|update]`
- The snapshot rides in the `remember` system-prompt section, stable between runs

## Build and install

```sh
# from the repository root
pnpm install
node scripts/build.mjs
pi install /absolute/path/to/repo/packages/pi
```

Remove an earlier `npm:@seangle/pi-remember` package first; two extensions cannot
register the same tool names. Rebuild and run `/reload` after changing the
adapter.

## Configuration

| Variable | Default |
|---|---|
| `REMEMBER_DIR_NAME` | `.agents` |
| `REMEMBER_GLOBAL_DIR` | `~/.pi/agent/memory` |
| `REMEMBER_INJECT_CHARS_GLOBAL` | `3000` |
| `REMEMBER_INJECT_CHARS_LOCAL` | `3000` |
| `REMEMBER_AUTO_INJECT` | `1` |

## Tests

```sh
node --test packages/pi/test/*.test.ts
```

The suite stubs the host packages and maps core/migrators to their sources, so it
runs without a build or a Pi installation.
