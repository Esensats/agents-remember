#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  CliError, createContext, loadBodies, loadListing, readItem, readRecovery, runSearch,
  snapshotFor, summarize,
} from "./model.ts";
import { parseArgs, UsageError } from "./args.ts";
import {
  createStyle, listingJson, recoveryJson, renderListing, renderRecovery, renderSearch,
  renderShow, renderSnapshot, renderSummary, searchJson, showJson, snapshotJson, summaryJson,
} from "./render.ts";
import { createExplorerData } from "./browse/model.ts";

const HELP = `remember — explore agents-remember plain-file memory

Usage
  remember [command] [options]
  remember [options]              same as: remember summary

Commands
  summary              store locations, counts, versions and injected snapshot sizes
  ls                   list facts and notes in the selected scopes
  show <id|path>       read one memo by eight-character ID or note path
  search <query>       lexical search across facts and note bodies
  snapshot             print exactly what an agent would inject
  recovery             list recoverable deletions and updates
  browse               interactive explorer (alternate screen)
  help, version

Read-only: this CLI never creates, edits or deletes memory. Deletions stay
recoverable because they are never performed here.

Options
  --scope <global|local|both>   initial scope (default: both)
  --root <dir>                  workspace root (default: current directory)
  --dir-name <name>             per-workspace store directory (default: .agents)
  --global-dir <dir>            explicit global store, e.g. ~/.pi/agent/memory
  --limit <n>                   search hits (default: 20)
  --json                        machine-readable output
  --no-color                    disable ANSI styling (also NO_COLOR)
  --no-wrap                     omit the <remember> wrapper in snapshot
  --stats                       print snapshot sizes to stderr

Environment
  REMEMBER_DIR_NAME, REMEMBER_GLOBAL_DIR,
  REMEMBER_INJECT_CHARS_GLOBAL, REMEMBER_INJECT_CHARS_LOCAL

Store locations
  local   <root>/<dir-name>/memory             (.agents/memory by default)
  global  discovered from ~/.pi/agent/memory, ~/.agents/memory,
          $XDG_DATA_HOME/opencode/memory and $DSH_HOME/memory, or --global-dir

Examples
  npx @seangle/remember-cli
  remember ls --json | jq -r '.notes[] | "\(.id)  \(.description)"'
  remember show 7f3a9c21
  remember search "proxy docker" --limit 5
  remember snapshot --stats
  remember browse --root ~/dev/my-project
`;

function version(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) process.stderr.write(`remember: warning: ${warning}\n`);
}

function formatSizes(info: { globalChars: number; localChars: number; globalBudget: number; localBudget: number }): string {
  return `global ${info.globalChars}/${info.globalBudget}, local ${info.localChars}/${info.localBudget}`;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const color = args.color && !process.env.NO_COLOR && process.stdout.isTTY === true;
  const style = createStyle(color);

  if (args.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.command === "version") {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  const ctx = createContext(process.cwd(), args, process.env);
  if (ctx.ambiguousGlobal && (args.command === "show" || args.command === "search" || args.command === "browse")) {
    printWarnings(["several global stores found; using local memory only (pass --global-dir)"]);
  }

  if (args.command === "summary") {
    const summary = await summarize(ctx, args.wrap);
    if (args.json) printJson(summaryJson(summary));
    else process.stdout.write(`${renderSummary(summary, style)}\n`);
    printWarnings(summary.warnings);
    return 0;
  }

  if (args.command === "ls") {
    const listing = await loadListing(ctx, args.scope);
    if (args.json) printJson(listingJson(listing));
    else process.stdout.write(`${renderListing(listing, style)}\n`);
    printWarnings(listing.warnings);
    return listing.facts.length + listing.notes.length + listing.missing.length > 0 ? 0 : 1;
  }

  if (args.command === "show") {
    const item = await readItem(ctx, args.positional[0], args.scope);
    if (args.json) printJson(showJson(item));
    else process.stdout.write(`${renderShow(item, style)}\n`);
    return 0;
  }

  if (args.command === "search") {
    const result = await runSearch(ctx, args.positional.join(" "), args.scope, args.limit);
    if (args.json) printJson(searchJson(result));
    else process.stdout.write(`${renderSearch(result, style)}\n`);
    return result.hits.length > 0 ? 0 : 1;
  }

  if (args.command === "snapshot") {
    if (args.scope !== "local" && ctx.ambiguousGlobal) {
      throw new CliError("Several global stores exist; choose one with --global-dir before rendering a snapshot.");
    }
    if (args.scope === "global" && !ctx.global) {
      throw new CliError("No global memory store found. Pass --global-dir <dir>.");
    }
    const useGlobal = args.scope === "global" || (args.scope === "both" && ctx.global !== null);
    const info = await snapshotFor(ctx, useGlobal ? ctx.global : null, ctx.globalLabel ?? "none", args.wrap);
    if (args.json) printJson(snapshotJson(info));
    else process.stdout.write(`${renderSnapshot(info, style)}\n`);
    printWarnings(info.warnings);
    if (args.stats) process.stderr.write(`remember: ${info.chars} chars (${formatSizes(info)})\n`);
    return info.text.length > 0 ? 0 : 1;
  }

  if (args.command === "recovery") {
    const result = await readRecovery(ctx, args.scope);
    if (args.json) printJson(recoveryJson(result));
    else process.stdout.write(`${renderRecovery(result, style)}\n`);
    printWarnings(result.warnings);
    return result.records.length > 0 ? 0 : 1;
  }

  if (args.command === "browse") {
    const listing = await loadListing(ctx, args.scope);
    const data = createExplorerData(listing, await loadBodies(listing), args.dirName);
    const reload = async (): Promise<typeof data> => {
      const next = await loadListing(ctx, args.scope);
      return createExplorerData(next, await loadBodies(next), args.dirName);
    };
    // Loaded lazily so ls/show/search stay dependency-light and pipe-friendly.
    const { runExplorer } = await import("./browse/view.ts");
    await runExplorer(data, { color, initialScope: args.scope, reload });
    return 0;
  }

  throw new CliError(`Unhandled command: ${args.command}`);
}

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  if (error instanceof UsageError || error instanceof CliError) {
    process.stderr.write(`remember: ${error.message}\n`);
    process.exitCode = error.exitCode;
    return;
  }
  process.stderr.write(`remember: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 2;
});
