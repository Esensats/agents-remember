# @seangle/dsh-remember

Durable, plain-file memory for the DeepSeek Harness (DSH): curated facts,
Markdown notes, lexical search, stable memo IDs, recovery, and a durable session
snapshot. Save knowledge that was expensive to obtain and will matter again —
not transcripts, todos, or temporary debugging state.

This is the DSH adapter for
[agents-remember](https://github.com/Esensats/agents-remember). It is a host-only
bundle (no UI) that mounts the shared engine as ten `memory_*` tools, a `/memory`
command, and a snapshot injected into the agent's step surface.

## Install

Published package name: `@seangle/dsh-remember`. Whether DSH's Plugins page can
install the bundle by npm name depends on that DSH build; the bundle patch is
included in the package.

From a local checkout, point the Plugins page at `packages/dsh`, or use the
`plugin_manager` tool's `install_bundle` action with that absolute directory
after `pnpm install` and `npm run build` in the repository root.

```yaml
- id: remember
  name: '@seangle/dsh-remember'
  config:
    dirName: .agents
    injectCharsLocal: 3000
```

Host packages (`@deepseek-ai/dsh-*`, `@deepseek-ai/schemastery`) are peer
dependencies supplied by DSH, not bundled copies. Tested against DSH desktop
**0.2.1-rc.3** (host packages `0.2.1-rc.3`, schemastery `3.18.5`).

## Stores and context

| Scope | Default path |
|---|---|
| Local | `<workspace>/.agents/memory` — shared with compatible agent adapters |
| Global | `$DSH_HOME/memory` — DSH-owned |

Facts live in `MEMORY.md`; notes live in `notes/<date>-<slug>.md` with validated
`description`, `memory-id`, `created-date`, and `last-modified-date` frontmatter.
The `remember.json` marker records store format version 1. Updates and deletions
produce recovery records for conflict-aware undo.

The snapshot is injected once per session after the entering user message. A
digest of the rendered bytes is stored in the message source, so a resumed or
forked session does not duplicate the snapshot and a changed store refreshes
exactly once. Compaction counts as losing the surface: when no snapshot remains
visible, the next step — even mid-turn — injects a fresh one. Facts and a derived
note catalogue ride in context; note bodies stay on disk until read or searched.
Each scope has a default 3,000-character budget, with middle truncation for large
stores.

Memory is agent-writable background data, **not trusted instructions**. Do not
store secrets. Add `.agents/memory/` to a workspace's `.gitignore` if memory
should remain private; recovery records can contain removed information too.

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

- `/memory` or `/memory status`: show status.
- `/memory migrate`: migrate the current workspace's recognized legacy
  `<workspace>/.pi/memory` store.

Search is lexical, with exact tokens, field weighting, phrase/coverage boosts,
and one hit per note. No embeddings, database, model calls, or persistent search
index are involved. Tool output is bounded and truncation is reported.

## Configuration

| Option | Default |
|---|---|
| `dirName` | `.agents` (workspace configuration directory, not a store path) |
| `globalDir` | `$DSH_HOME/memory` when empty |
| `injectCharsGlobal` | `3000` |
| `injectCharsLocal` | `3000` |
| `autoInject` | `true` |

Budgets must be positive numbers; invalid values fall back to the default. Set
`autoInject: false` to disable injection, not the tools.

## Concurrency and safety

Mutations are serialized per `MEMORY.md` within one DSH process. They are not
coordinated across DSH, Pi, OpenCode, or editors; avoid simultaneous writes to a
shared store, including during migration. Path checks are not a sandbox against
hostile concurrent filesystem changes. Stored paths, credentials, or remembered
facts never grant permission for remote access.

## Local development

```sh
pnpm install
npm run build
mkdir -p node_modules/@seangle
ln -s <dsh-install>/node_modules/@deepseek-ai node_modules/@deepseek-ai
npm run smoke
```

`npm run smoke` exercises the compiled bundle against a fake host and temporary
stores: all ten tools, recovery, migration, `/memory`, snapshot injection,
dedupe, and mid-turn compaction recovery.

## License

Apache-2.0. Copyright 2026 Esensats.
