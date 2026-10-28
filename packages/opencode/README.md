# @seangle/opencode-remember

Durable, plain-file memory for [OpenCode](https://opencode.ai/): curated facts,
Markdown notes, lexical search, stable memo IDs, recovery, and a per-request
session snapshot. Save knowledge that was expensive to obtain and will matter
again — not transcripts, todos, or temporary debugging state.

This is the OpenCode adapter for
[agents-remember](https://github.com/Esensats/agents-remember). It registers a
server plugin: ten `memory_*` tools, a `/memory` command, and a system-prompt
snapshot. No host SDK is imported at runtime; the adapter maps the engine onto
OpenCode's plugin API and uses only Node built-ins.

## Install

Add the plugin to `opencode.json(c)` and reload OpenCode (`/reload`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@seangle/opencode-remember",
      "options": {
        "dirName": ".agents",
        "injectCharsLocal": 3000,
      },
    },
  ],
}
```

A local checkout works the same way with an absolute directory:

```jsonc
{
  "plugins": [
    { "package": "/absolute/path/to/agents-remember/packages/opencode" },
  ],
}
```

Run `pnpm install` and `npm run build` in the repository first; local packages
load their compiled `dist/`. Requires Node.js **>=22.15** and OpenCode **>=2.2**
(the `@opencode/plugin` peer dependency supplies types only).

## Stores and context

| Scope | Default path |
|---|---|
| Local | `<workspace>/.agents/memory` — shared with compatible agent adapters |
| Global | `$XDG_DATA_HOME/opencode/memory` (`~/.local/share/opencode/memory`) — OpenCode-owned |

Facts live in `MEMORY.md`; notes live in `notes/<date>-<slug>.md` with validated
`description`, `memory-id`, `created-date`, and `last-modified-date` frontmatter.
The `remember.json` marker records store format version 1. Updates and deletions
produce recovery records for conflict-aware undo.

The snapshot is appended to the model request's system prompt on **every** model
call. OpenCode assembles that prompt per request and never persists it, so there
is no duplicate-block bookkeeping: the bytes are identical while the store is
unchanged (keeping prefix caches valid), a write is visible on the next step, and
compaction cannot drop the snapshot. Facts and a derived note catalogue ride in
context; note bodies stay on disk until read or searched. Each scope has a
default 3,000-character budget, with middle truncation for large stores.

The workspace is the **session's** directory, not the plugin's load location, so
`session_move` and worktrees resolve to their own local store.

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

The tools are registered under the `memory` namespace, so the effective tool
names stay `memory_*` while Code Mode reaches them as `tools.memory.init`,
`tools.memory.write`, and so on.

Search is lexical, with exact tokens, field weighting, phrase/coverage boosts,
and one hit per note. No embeddings, database, model calls, or persistent search
index are involved. Tool output is bounded and truncation is reported.

- `/memory` or `/memory status`: show status without starting an agent turn.
- `/memory migrate`: migrate the current workspace's recognized legacy store
  (`<workspace>/.pi/memory`) without starting an agent turn.

Tool failures are reported as text the model can read; the adapter never throws
across the plugin boundary.

## Configuration

Plugin options in `opencode.json(c)`:

| Option | Default |
|---|---|
| `dirName` | `.agents` (workspace configuration directory, not a store path) |
| `globalDir` | `$XDG_DATA_HOME/opencode/memory` |
| `injectCharsGlobal` | `3000` |
| `injectCharsLocal` | `3000` |
| `autoInject` | `true` |

Budgets must be positive numbers; invalid values fall back to the default. Set
`autoInject: false` to disable injection, not the tools. Configuration is read
when the plugin loads; OpenCode reloads plugins after a config save.

## Concurrency and safety

The adapter serializes mutations per `MEMORY.md` within one plugin process. It
does not coordinate with other OpenCode processes, Pi, or DSH; avoid simultaneous
writes to a shared store, including during migration. Path checks are not a
sandbox against hostile concurrent filesystem changes. Stored paths, credentials,
or remembered facts never grant permission for remote access.

## Local development

```sh
git clone git@github.com:Esensats/agents-remember.git
cd agents-remember
pnpm install
npm run check
npm run test:packed
```

Point `plugins` at `packages/opencode` in a project's `.opencode/opencode.json`
while developing. Local packages load in place; rebuild with `npm run build` and
run `/reload` after edits. Tests use temporary stores, not live memory.

## License

Apache-2.0. Copyright 2026 Esensats.
