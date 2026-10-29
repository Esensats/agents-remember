# @seangle/remember-cli

Human-facing explorer for [`agents-remember`](../../README.md) plain-file
memory. The adapters give agents tools; this gives **you** the same stores as a
list, a search, and an interactive browser — from one small command.

Read-only by design: it never creates, edits, or deletes memory. A deletion made
by an agent stays recoverable, and nothing here can bypass that.

## Install

```sh
npx @seangle/remember-cli            # try it, no install
npm i -g @seangle/remember-cli       # daily driver → `remember`
pnpm dlx @seangle/remember-cli ls    # or bunx / dlx
```

Requires Node.js **>= 22.15**. Zero native builds, no postinstall.
Always use the scoped package name: `npx remember` resolves to an unrelated
package.

## Commands

```sh
remember                         # stores, counts, versions, snapshot sizes
remember ls                      # facts and notes
remember show <id|path>          # one memo: eight-char ID or notes/… path
remember search "proxy docker"   # lexical search, note bodies included
remember snapshot --stats        # exactly what an agent would inject
remember recovery                # recoverable deletions and updates
remember browse                  # interactive explorer
```

`ls`, `search`, `recovery`, `snapshot` exit `1` when nothing was found, `2` on a
usage or store error, `0` otherwise.

Common options:

| Option | Meaning |
|--------|---------|
| `--scope global\|local\|both` | Which store to read (default `both`) |
| `--root <dir>` | Workspace root instead of the current directory |
| `--dir-name <name>` | Per-workspace store directory (default `.agents`) |
| `--global-dir <dir>` | Explicit global store, e.g. `~/.pi/agent/memory` |
| `--limit <n>` | Search hits (default `20`) |
| `--json` | Machine-readable output |
| `--no-color` | Plain output (`NO_COLOR` works too) |
| `--no-wrap` | Omit the `<remember>` wrapper in `snapshot` |
| `--stats` | Print snapshot sizes to stderr |

## Where it reads

| Scope | Path |
|-------|------|
| local | `<root>/<dir-name>/memory` — `.agents/memory` by default |
| global | discovered, or `--global-dir` |

Global discovery probes the harness-owned stores and never merges them:

- `~/.pi/agent/memory` (Pi)
- `~/.agents/memory` (shared convention)
- `$XDG_DATA_HOME/opencode/memory` (OpenCode)
- `$DSH_HOME/memory` (DSH)

One match is used automatically. Several matches are reported and scoped
commands then need `--global-dir`; `summary` still shows all of them with their
own snapshot sizes. Existing but unmarked stores are reported as *needs
migration* instead of being silently rendered.

Environment: `REMEMBER_DIR_NAME`, `REMEMBER_GLOBAL_DIR`,
`REMEMBER_INJECT_CHARS_GLOBAL`, `REMEMBER_INJECT_CHARS_LOCAL`.

## Browse

`remember browse` opens an alternate-screen explorer. The left column lists
facts (`▸ id title`) and notes; the right column renders the selected note as
Markdown, including frontmatter-derived metadata.

| Key | Action |
|-----|--------|
| `↑` `↓`, `ctrl+p` `ctrl+n` | Move selection |
| `pageUp` `pageDown`, `home` `end` | Move by page / to the ends |
| type | Filter on title, ID, path and note body (all words must match) |
| `tab` | Cycle scope (`both` → `local` → `global`) |
| `enter` | Open the source file in `$PAGER` (`less -R` fallback) |
| `ctrl+g` | Open the source file in `$VISUAL`/`$EDITOR`, then reload |
| `esc` | Clear the filter; a second `esc` quits |
| `ctrl+c` | Quit |

The terminal is restored on quit, on `ctrl+c`, on `SIGTERM`/`SIGHUP`, and — as a
last resort — from a process-exit handler. `browse` refuses to start when
stdin/stdout is not a TTY; use `ls --json` in scripts.

## JSON

`--json` is stable and grep-friendly:

```sh
remember ls --json | jq -r '.notes[] | "\(.id)  \(.description)"'
remember show 7f3a9c21 --json | jq -r .body
remember search "proxy" --json | jq -r '.hits[] | "\(.score) \(.file)"'
```

`summary` reports `local`, `globals`, per-store `facts`/`notes`/`recovery`,
`version`, `needsMigration`, and one snapshot entry per discovered global store
with `chars`, `globalChars` and `localChars`.

## Relationship to `/memory`

Inside Pi, `/memory status|migrate|update` stays the agent-side command. The CLI
complements it: `snapshot` shows the injected block byte-for-byte,
`recovery` explains what an agent could restore, and `browse` is the reading
surface neither harness has.

## Development

```sh
pnpm install
node ../../scripts/build.mjs        # or npm run build in this package
node --test test/*.test.ts          # unit tests, no TTY required
node dist/main.js browse            # from a workspace with a store
```

The interactive layer lives in `src/browse/` (`model.ts` is pure and testable,
`view.ts` mounts `@earendil-works/pi-tui` on a `ProcessTerminal`). The same view
can later be mounted inside Pi via `ctx.ui.custom()` without a second
implementation.
