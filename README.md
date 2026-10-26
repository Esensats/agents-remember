# remember

Portable plain-file memory for coding agents: facts, notes, stable memo IDs,
lexical search, and a byte-stable session snapshot — with a host-agnostic core
and one adapter per harness.

The design is lifted from [`pi-remember`](https://github.com/Esensats/pi-remember):
curated knowledge that was expensive to obtain, not transcripts and not todos.
The difference is packaging: the engine no longer knows which agent is calling.

## Layout

```
packages/core/       @seangle/remember-core       engine, no host SDK imports
packages/migrators/  @seangle/remember-migrators  migration strategies, also host-free
packages/dsh/        @seangle/dsh-remember        DeepSeek Harness bundle
```

Planned: `packages/pi` or an equivalent adapter in the Pi repository, consuming
the published core. Keeping Pi's adapter in its own repository preserves that
package's release history; the core is the shared dependency either way.

### Core

| Module | Responsibility |
|---|---|
| `store.ts` | paths, facts, memo IDs, append/update/forget/restore, recovery, notes |
| `notes.ts` | the four-field frontmatter subset, bounded header reads |
| `search.ts` | query-local lexical ranking (no index, no embeddings, no model call) |
| `inject.ts` | byte-stable, middle-truncated snapshot block |
| `workspace.ts` | root validation, store resolution, initialization |
| `migration.ts` | `remember.json` version marker; refuses unmarked content instead of adopting it |

Nothing in `core` imports a coding-agent SDK, and nothing writes outside the
directories it is handed.

### Store

```
<workspace>/.agents/memory/
  MEMORY.md                         # one-line facts with <!-- 2026-10-23T03:09Z [8hex] --> comments
  notes/<YYYY-MM-DD>-<slug>.md      # frontmatter: description, memory-id, created-date, last-modified-date (minute-precision ISO)
  remember.json                     # {"version": 1} store marker
  recovery/<8hex>.json              # undo records for updates and deletions
```

`dirName` is configurable; `.agents` is the DSH default. A store with content but
no `remember.json` is never adopted silently: core reports it as needing an
explicit migration.

Timestamps are UTC ISO 8601 truncated to the minute (`2026-10-23T03:09Z`).
Stores written earlier may contain seconds or fractional seconds; those values
remain readable and are preserved, while every new stamp is minute precision.

## Migration

Legacy stores are converted by strategies in `packages/migrators`, never by core:

```ts
interface MemoryMigrator {
  id: string;
  detect(source: string): Promise<number | null>;   // cheap, read-only
  plan(source: string, target: string): Promise<MigrationPlan>;  // validates everything first
  apply(plan: MigrationPlan, options?: { dryRun?: boolean }): Promise<MigrationReport>;
}
```

`pi-remember-v1` is the only strategy today. It copies **current knowledge only**:
`MEMORY.md` facts (dropping legacy `#note` reference lines, which the catalogue
derives again) and valid `notes/**/*.md` files with their frontmatter. `recovery/`,
`migrations/`, and any other history directories are left behind. Invalid notes
and duplicate memo IDs are skipped and reported rather than guessed at.

`apply` stages the whole store in a sibling directory and renames it into place,
so a failed migration leaves either the complete target or nothing. An existing
target is refused, never merged. When source and target are the same directory
(a copied `.pi/memory` missing only the marker), the strategy writes just
`remember.json` and touches no content.


## Parity with pi-remember

| Capability | State |
|---|---|
| Facts (`memory_write`, ≤300 chars, duplicate + cross-scope warning) | yes |
| Notes (`memory_store`, four-field frontmatter, slug rules, date prefix) | yes |
| Catalogue reads, ID reads, path reads, substring filter | yes |
| Ranked lexical search with matching-passage counts | yes |
| In-place update with preserved identity and recovery ID | yes |
| Forget with recoverable snapshots | yes |
| Restore / undo, refusing later edits | yes |
| Status: paths, counts, bytes, recoveries, snapshot size | yes |
| Version marker, refusal to adopt unmarked stores | yes |
| `root` per call for another workspace | yes |
| Byte-stable snapshot, 20/80 middle truncation, budgets | yes |
| Legacy store migration (`memory_migrate`, `/memory migrate`) | yes, via `packages/migrators` |
| `/memory` slash command | `status` and `migrate` |
| Exit summary | **never implemented** (excluded by request) |
| Old recovery records and migration artifacts | not migrated, not a compatibility goal |

Model-facing behavior is at parity; what differs is only the host seam. Pi's
`/memory` command is a Pi UI affordance, and the exit summary is deliberately
absent rather than ported.

## Build

No TypeScript toolchain and no dependencies. The build uses Node's own type
stripping (`node:module.stripTypeScriptTypes`) and rewrites `.ts` specifiers to
`.js`, because runtime hosts load plugins from `node_modules` where Node refuses
to strip types.

```sh
npm run build     # or: node scripts/build.mjs
npm test          # 191 tests: core + migrators
```

Output lands in each package's `dist/`. `dist/` is gitignored; build before
installing the bundle.

## DSH adapter

`@seangle/dsh-remember` is a host-only bundle (no UI):

- **Injection** — on `agent/pre-step`, render the snapshot from the workspace and
  global stores and splice it after the entering user message. A digest of the
  rendered bytes is stored in the message source, so a resumed session does not
  duplicate the snapshot and a changed store refreshes exactly once.
- **Tools** — `memory_init`, `memory_write`, `memory_store`, `memory_read`,
  `memory_search`, `memory_update`, `memory_forget`, `memory_restore`,
  `memory_status`, `memory_migrate`.
- **Migration** — when a legacy store exists and the target has no marker, the
  first turn carries a `<remember-migration>` notice asking the model to obtain
  consent; `/memory migrate` performs it directly. Nothing is written without
  consent.
- **Command** — `/memory [status|migrate]`.
- **Config** — `dirName` (`.agents`), `globalDir` (`$DSH_HOME/memory` when empty),
  `injectCharsGlobal`, `injectCharsLocal`, `autoInject`.

```yaml
- id: remember
  name: '@seangle/dsh-remember'
  config:
    dirName: .agents
    injectCharsLocal: 3000
```

Install from the Plugins page by pointing at `packages/dsh`, or with the
`plugin_manager` tool's `install_bundle` action targeting that absolute
directory. The bundle declares `@seangle/remember-core` and
`@seangle/remember-migrators` as `file:` dependencies, so all three packages must
stay side by side.

### Model experience

The snapshot is injected once per session, not on every turn. Facts and note
descriptions ride in context; note bodies stay on disk until a `memory_read` or
`memory_search`. Every write returns the memo ID and, for updates and deletions,
a recovery ID.

Compaction counts as losing the snapshot: DSH replaces the visible surface with a
summary, so the next step — even mid-turn — injects a fresh snapshot. Deduplication
reads the surface, not a side table, which is what makes that automatic.

Injected memory is framed as background knowledge, never instructions: memory is
agent-writable, so treating it as authority would turn it into a prompt-injection
channel.

## Status

- 191 tests pass (185 core, 6 migrators).
- Adapter smoke suite passes end to end against a fake host: all ten tools,
  duplicate handling, update → forget → restore round-trip, workspace isolation,
  step-1 injection, digest deduplication, no mid-turn refresh, mid-turn restore
  after a surface-replacing compaction.
- The smoke script needs the host's packages resolvable. For local development:

  ```sh
  mkdir -p node_modules/@seangle
  ln -s <dsh-install>/node_modules/@deepseek-ai node_modules/@deepseek-ai
  ln -s ../../packages/core node_modules/@seangle/remember-core
  npm run build && npm run smoke
  ```

- Not yet verified inside a live DSH profile; installation and UI checks are the
  next step. `dist/` must be built before installing the bundle.

## License

Apache-2.0, same as pi-remember.
