import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { truncateTail, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  appendEntry,
  assertCurrentStoreVersion,
  buildSnapshot,
  entryId,
  ensureStoreVersion,
  findSimilar,
  forgetEntries,
  initializeMemory,
  parseEntries,
  readCatalogue,
  readMemo,
  resolveNotePath,
  resolveWorkspaceStores,
  restoreEntry,
  searchStores,
  statMemory,
  updateMemo,
  validNoteSlug,
  workspaceAccessError,
  writeNote,
  type MemoryEntry,
  type Scope,
  type Snapshot,
  type StorePaths,
} from "@seangle/remember-core";
import { detectMigrations, migrate, type MigrationReport } from "@seangle/remember-migrators";
import { Type } from "typebox";
import { expandHome, legacySource, storesFor, type RememberConfig } from "./context.ts";

const READ_CAP = { maxBytes: 20_000, maxLines: 400 };
const NOTE_CAP = { maxBytes: 30_000, maxLines: 600 };
const MAX_FACT = 300;
const MAX_DESCRIPTION = 300;

export interface ToolExec {
  cwd: string;
  signal?: AbortSignal;
}

export interface ToolContext {
  config: RememberConfig;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

type MutationQueue = <T>(path: string, operation: () => Promise<T>) => Promise<T>;

const ROOT_PARAMETER = Type.Optional(Type.String({
  minLength: 1,
  description: "Workspace directory for local memory (not its .agents directory). Defaults to the session working directory; accepts absolute, relative-to-cwd, and ~/ paths. Ignored for global-only operations.",
}));

const SCOPE_WRITE = Type.Optional(StringEnum(["local", "global"] as const, {
  description: "local = this workspace; global = user/machine facts. Defaults to local.",
}));

const SCOPE_READ = Type.Optional(StringEnum(["local", "global", "both"] as const, {
  description: "Which stores to read. Defaults to both.",
}));

const WORKSPACE_GUIDANCE =
  " Optional root selects another workspace's local memory; global memory is unchanged. Local memory requires memory_init first.";

function resolveScopes(param: string | undefined): Scope[] {
  if (param === "global") return ["global"];
  if (param === "local") return ["local"];
  return ["global", "local"];
}

function formatTruncated(t: ReturnType<typeof truncateTail>): string {
  return t.truncated ? `${t.content}\n[truncated: showing ${t.outputLines}/${t.totalLines} lines]` : t.content;
}

function formatEntry(entry: MemoryEntry): string {
  const id = entryId(entry);
  return `${id ? `[id=${id}] ` : ""}${entry.line}`;
}

function restoreHint(recoveryId: string, scope: Scope, root?: string): string {
  const args = { recoveryId, scope, ...(scope === "local" && root !== undefined ? { root } : {}) };
  return `Undo with memory_restore(${JSON.stringify(args)}).`;
}

function failure(message: string): ToolResult {
  return { text: message, isError: true };
}

/**
 * Find a legacy store this workspace could migrate. Prefers `.pi/memory`, and
 * also recognizes an in-place store (a copied tree missing only the marker).
 */
export async function detectForWorkspace(cwd: string, config: RememberConfig) {
  const target = join(cwd, config.dirName, "memory");
  const source = legacySource(cwd);
  const candidates = await detectMigrations(source, target);
  if (candidates.length > 0) return candidates[0];
  const inPlace = await detectMigrations(target, target);
  return inPlace[0] ?? null;
}

export function formatReport(report: MigrationReport & { plan?: { source: string; target: string; inPlace: boolean } }): string {
  const lines = [
    `${report.dryRun ? "Dry run" : "Migrated"} ${report.plan?.inPlace ? "in place" : `from ${report.source} to ${report.target}`}: ${report.facts} fact(s), ${report.notes} note(s).`,
  ];
  if (report.wrote.length > 0) lines.push(`Wrote: ${report.wrote.join(", ")}`);
  if (report.skipped.length > 0) lines.push(`Skipped:\n${report.skipped.map((item) => `- ${item.rel}: ${item.reason}`).join("\n")}`);
  if (report.warnings.length > 0) lines.push(`Warnings:\n${report.warnings.map((warning) => `- ${warning}`).join("\n")}`);
  return lines.join("\n");
}

export async function statusText(stores: Record<Scope, StorePaths>, config: RememberConfig, cwd: string): Promise<string> {
  const lines: string[] = [];
  for (const scope of ["global", "local"] as const) {
    const stat = await statMemory(stores[scope]);
    lines.push(stat.exists
      ? `${scope}: ${stat.path} — ${stat.entries} facts, ${stat.notesCount} notes, ${stat.bytes} bytes, ${stat.recoveryCount} recovery file(s)`
      : `${scope}: ${stat.path} — no memory yet${scope === "local" ? "; run memory_init first" : ""}`);
  }
  const snapshot = await snapshotFor(stores, config, basename(cwd));
  lines.push(`injected snapshot (current session: ${cwd}): ${snapshot.text.length} chars (global ${snapshot.globalChars}, local ${snapshot.localChars})`);
  lines.push(`config: dirName=${config.dirName}, autoInject=${config.autoInject ? "on" : "off"}, snapshot budgets global/local ${config.injectCharsGlobal}/${config.injectCharsLocal}`);
  return lines.join("\n");
}

/** Build the snapshot from both stores; never throws on a missing or invalid store. */
export async function snapshotFor(
  stores: Record<Scope, StorePaths>,
  config: RememberConfig,
  projectName: string,
): Promise<Snapshot> {
  const read = async (store: StorePaths) => {
    try {
      await assertCurrentStoreVersion(store);
      return await readCatalogue(store);
    } catch {
      return "";
    }
  };
  const [globalText, localText] = await Promise.all([read(stores.global), read(stores.local)]);
  return buildSnapshot(globalText, localText, projectName, {
    maxGlobalChars: config.injectCharsGlobal,
    maxLocalChars: config.injectCharsLocal,
    // Pi wraps a named system-prompt section in <remember> itself.
    wrap: false,
  });
}

/** Map the model-facing tools onto the host-agnostic engine. */
export function toolSpecs(ctx: ToolContext) {
  const queue: MutationQueue = (path, operation) => withFileMutationQueue(path, operation);
  const memoryDir = join("<workspace>", ctx.config.dirName, "memory");

  /** Resolve stores for one call without changing the session's injected memory. */
  const targetStores = (root: string | undefined, scopes: Scope[], exec: ToolExec) =>
    scopes.includes("local")
      ? resolveWorkspaceStores(exec.cwd, ctx.config.globalDir, ctx.config.dirName, root)
      : { status: "resolved" as const, root: exec.cwd, stores: storesFor(exec.cwd, ctx.config) };

  /** Validate after acquiring the queue, mark a new store, then run the mutation. */
  const mutate = async <T>(
    stores: Record<Scope, StorePaths>,
    scope: Scope,
    operation: () => Promise<T>,
    requireInit = true,
  ): Promise<{ status: "ok"; value: T } | { status: "error"; message: string }> => {
    return queue(stores[scope].memoryFile, async () => {
      const error = workspaceAccessError(stores, [scope], requireInit);
      if (error) return { status: "error" as const, message: error };
      try {
        // Mark a brand-new store before the first write, otherwise the
        // post-write check sees content without a marker and refuses it.
        await ensureStoreVersion(stores[scope], { create: true });
      } catch (cause) {
        return { status: "error" as const, message: String(cause) };
      }
      const value = await operation();
      await ensureStoreVersion(stores[scope]);
      return { status: "ok" as const, value };
    });
  };

  /** Reads of other workspaces validate and migrate lazily; missing stores stay missing. */
  const prepareReads = async (stores: Record<Scope, StorePaths>, scopes: Scope[]): Promise<string | null> => {
    for (const scope of scopes) {
      const error = workspaceAccessError(stores, [scope]);
      if (error) return error;
      try {
        await queue(stores[scope].memoryFile, () => assertCurrentStoreVersion(stores[scope]));
      } catch (cause) {
        return String(cause);
      }
    }
    return null;
  };

  /** Similar entries in the other scope of this call, not another workspace. */
  const similarInOtherScope = async (stores: Record<Scope, StorePaths>, store: StorePaths, content: string) => {
    const other = store.scope === "local" ? stores.global : stores.local;
    try {
      return findSimilar(parseEntries(await readCatalogue(other)), content);
    } catch {
      return [];
    }
  };

  const similarWarning = (similar: MemoryEntry[], scope: Scope): string =>
    similar.length > 0
      ? `\nNote: similar entry in ${scope === "local" ? "global" : "local"} memory: ${similar[0].line}\nKeep knowledge in ONE scope — memory_forget the copy that does not belong.`
      : "";

  return [
    {
      name: "memory_init",
      label: "Memory Init",
      description:
        `Explicitly initialize local memory in an existing workspace. Optional root defaults to the session working directory. Creates ${memoryDir}/MEMORY.md only if missing; never overwrites existing memory or creates the workspace itself. Global memory needs no initialization.`,
      promptSnippet: "Initialize local memory in an existing workspace",
      promptGuidelines: [
        "Use root to access local memory in another workspace. Initialize it with memory_init only when you intend to create a memory store there; do not initialize merely to make a search succeed.",
      ],
      parameters: Type.Object({ root: ROOT_PARAMETER }),
      async execute(args: { root?: string }, exec: ToolExec): Promise<ToolResult> {
        const target = targetStores(args.root, ["local"], exec);
        if (target.status === "error") return failure(target.message);
        const store = target.stores.local;
        const mutation = await mutate(target.stores, "local", () => initializeMemory(store), false);
        if (mutation.status === "error") return failure(mutation.message);
        const result = mutation.value;
        if (result.status === "error") return failure(result.message);
        return {
          text: result.status === "initialized"
            ? `Initialized local memory: ${store.memoryFile}`
            : `Local memory already initialized: ${store.memoryFile}. Existing content preserved.`,
        };
      },
    },
    {
      name: "memory_write",
      label: "Memory Write",
      description:
        `Append exactly ONE concise, durable fact to memory. Default scope 'local' (this workspace, ${ctx.config.dirName}/memory/MEMORY.md). ` +
        "Use scope 'global' ONLY for machine/user-wide facts (identity, OS, global tool preferences). " +
        "Store only knowledge that was expensive to obtain and will plausibly matter in a FUTURE session: stable preferences, decisions, lessons, environment quirks. " +
        "NEVER store temporary session state: current task, todos, in-progress work, debugging state, 'user asked me to X'. " +
        "One line only, max 300 chars. For longer content use memory_store, which writes a standalone note." +
        WORKSPACE_GUIDANCE,
      promptSnippet: "Persist one durable fact to memory (project-local or global)",
      promptGuidelines: [
        "Use memory_write sparingly — only for facts a future session will plausibly need. When in doubt, don't write.",
        "global scope is reserved for facts about the user or the machine; facts about specific software, repos, or configs stay local to the workdir where they were learned.",
        "Do not record session state (what you're doing now, todos, next steps) — pi's own session files persist that.",
        "Keep MEMORY.md for one-line facts only. Notes carry their own metadata; their descriptions are automatically included in session context.",
        "Use memory_search to recall stored knowledge before re-deriving it or asking the user.",
      ],
      parameters: Type.Object({
        content: Type.String({ description: "Single fact to remember (one line, max 300 chars)." }),
        scope: SCOPE_WRITE,
        root: ROOT_PARAMETER,
      }),
      async execute(args: { content: string; scope?: Scope; root?: string }, exec: ToolExec): Promise<ToolResult> {
        if (args.content.length > MAX_FACT) {
          return failure(`Entry too long for the index (${args.content.length} chars, max ${MAX_FACT}). Use memory_store for detailed knowledge — it writes a notes file and keeps MEMORY.md lean.`);
        }
        const scope = args.scope ?? "local";
        const target = targetStores(args.root, [scope], exec);
        if (target.status === "error") return failure(target.message);
        const store = target.stores[scope];
        const mutation = await mutate(target.stores, scope, () => appendEntry(store, args.content));
        if (mutation.status === "error") return failure(mutation.message);
        const result = mutation.value;
        if (result.duplicate) {
          return { text: `Duplicate — already in ${scope} memory:\n${(result.existing ?? []).map((entry) => `- ${formatEntry(entry)}`).join("\n")}` };
        }
        if (!result.line) return { text: "Empty content — nothing saved." };
        const similar = await similarInOtherScope(target.stores, store, result.line);
        return { text: `Saved to ${scope} memory (${store.memoryFile}). Memo ID: ${result.id}.${similarWarning(similar, scope)}` };
      },
    },
    {
      name: "memory_store",
      label: "Memory Store Note",
      description:
        "Store detailed knowledge as a standalone Markdown note with description, ID and timestamps in frontmatter. " +
        "Only note descriptions/IDs/paths enter context; bodies are read on demand via memory_read. " +
        "Filenames always prepend the UTC date; no Markdown heading is added. Default scope 'local'. " +
        "Existing/duplicate entries are returned without creating or overwriting a note; use memory_update to revise an indexed memo." +
        WORKSPACE_GUIDANCE,
      promptSnippet: "Store detailed knowledge as a dated, self-describing note",
      promptGuidelines: [
        "Use memory_store instead of memory_write whenever knowledge needs more than one line. MEMORY.md holds only short facts; notes are discovered from frontmatter.",
        "When recalling, prefer memory_search to find notes, then memory_read(path=...) to fetch the full note.",
      ],
      parameters: Type.Object({
        title: Type.String({ description: "Short note description stored in frontmatter and injected into context (max 300 chars). Not a heading." }),
        content: Type.String({ description: "Markdown body only; no frontmatter. Include your own heading if useful." }),
        slug: Type.Optional(Type.String({
          minLength: 1,
          maxLength: 80,
          description: "Concise filename slug: letters/digits separated by hyphens, no date/path/extension. UTC date is prepended.",
        })),
        scope: SCOPE_WRITE,
        root: ROOT_PARAMETER,
      }),
      async execute(args: { title: string; content: string; slug?: string; scope?: Scope; root?: string }, exec: ToolExec): Promise<ToolResult> {
        if (!args.title.trim() || /[\x00-\x1f\x7f]/.test(args.title)) return failure("Description must be a nonempty single line.");
        if (!args.content.trim()) return failure("Empty note body — nothing saved.");
        if (args.slug !== undefined && !validNoteSlug(args.slug)) return failure("Invalid slug: use 1–80 letters/digits separated by hyphens, without date, path or extension.");
        if (args.title.length > MAX_DESCRIPTION) return failure(`Title too long (${args.title.length} chars, max ${MAX_DESCRIPTION}).`);
        const scope = args.scope ?? "local";
        const target = targetStores(args.root, [scope], exec);
        if (target.status === "error") return failure(target.message);
        const store = target.stores[scope];
        const mutation = await mutate(target.stores, scope, () => writeNote(store, args.title, args.content, args.slug));
        if (mutation.status === "error") return failure(mutation.message);
        const result = mutation.value;
        if (result.duplicate) {
          return { text: `Already indexed in ${scope} memory; no note created or overwritten:\n${(result.existing ?? []).map((entry) => `- ${formatEntry(entry)}`).join("\n")}\nRead the existing memo and use memory_update to revise it.` };
        }
        const similar = await similarInOtherScope(target.stores, store, result.indexLine);
        return {
          text: `Stored note: ${result.noteRel}\nMemory file: ${store.memoryFile}\nMemo ID: ${result.id}\nDescription: ${result.indexLine}\nMetadata is stored in the note, not duplicated in MEMORY.md.${similarWarning(similar, scope)}`,
        };
      },
    },
    {
      name: "memory_update",
      label: "Memory Update",
      description:
        "Update ONE existing memo by its exact eight-character metadata ID, preserving ID, creation date, note path and description. " +
        "Default scope 'local'. Read the memo first. For facts, content replaces the fact (one line, max 300 chars); " +
        "for notes, content replaces the full Markdown body excluding frontmatter. Blank content is rejected; identical content is a no-op. " +
        "Actual changes return a recovery ID for memory_restore." +
        WORKSPACE_GUIDANCE,
      promptSnippet: "Revise one memo in place by its ID",
      parameters: Type.Object({
        id: Type.String({ pattern: "^[a-fA-F0-9]{8}$", description: "Exact memo ID from index metadata or a tool result (not a recovery ID)." }),
        content: Type.String({ description: "Replacement fact or full Markdown note body; omit frontmatter." }),
        scope: SCOPE_WRITE,
        root: ROOT_PARAMETER,
      }),
      async execute(args: { id: string; content: string; scope?: Scope; root?: string }, exec: ToolExec): Promise<ToolResult> {
        const scope = args.scope ?? "local";
        const target = targetStores(args.root, [scope], exec);
        if (target.status === "error") return failure(target.message);
        const store = target.stores[scope];
        const mutation = await mutate(target.stores, scope, () => updateMemo(store, args.id, args.content, queue));
        if (mutation.status === "error") return failure(mutation.message);
        const result = mutation.value;
        if (result.status === "error") return failure(result.message);
        return {
          text: result.status === "unchanged"
            ? `Memo ${args.id} unchanged; nothing written.`
            : `Updated memo ${args.id} in ${scope} memory (${store.dir}). ID, creation date and note reference preserved; note last-modified-date updated.\nRecovery ID: ${result.recoveryId}\n${restoreHint(result.recoveryId, scope, args.root)}`,
        };
      },
    },
    {
      name: "memory_read",
      label: "Memory Read",
      description:
        "Read memory contents. Default: one-line facts plus a derived note catalogue for scope 'both' (global + local). " +
        "Optional query filters index entries (case-insensitive substring). Optional path reads an existing note file. " +
        "Optional id retrieves exactly one indexed memo, including note contents. Do not combine id with query/path. " +
        "Ambiguous IDs/paths require an explicit scope; no guessing." +
        WORKSPACE_GUIDANCE,
      promptSnippet: "Read memory facts, the note catalogue, or one memo by ID/path",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ pattern: "^[a-fA-F0-9]{8}$", description: "Exact memo ID; returns the index entry and linked note contents." })),
        query: Type.Optional(Type.String({ description: "Case-insensitive substring filter over catalogue lines." })),
        path: Type.Optional(Type.String({ description: "Note path to read, e.g. 'notes/2026-08-27-foo.md'." })),
        scope: SCOPE_READ,
        root: ROOT_PARAMETER,
      }),
      async execute(args: { id?: string; query?: string; path?: string; scope?: string; root?: string }, exec: ToolExec): Promise<ToolResult> {
        const scopes = resolveScopes(args.scope);
        const target = targetStores(args.root, scopes, exec);
        if (target.status === "error") return failure(target.message);
        const preparationError = await prepareReads(target.stores, scopes);
        if (preparationError) return failure(preparationError);

        if (args.id !== undefined) {
          if (args.query !== undefined || args.path !== undefined) return failure("Specify id alone, or use query/path without id.");
          const memo = await readMemo(target.stores, args.id, scopes);
          if (memo.status === "error") return failure(memo.message);
          const out = `## ${memo.store.scope} memo ${args.id} — ${memo.store.memoryFile}\n\n${memo.entry.meta ?? ""}\n${memo.entry.line}` +
            (memo.noteText !== undefined ? `\n\n## Note: ${memo.noteRel}\n\n${memo.noteText}` : "");
          return { text: formatTruncated(truncateTail(out, NOTE_CAP)) };
        }

        if (args.path !== undefined) {
          const resolved = resolveNotePath(target.stores, args.path, scopes);
          if (resolved.status === "error") return failure(resolved.message);
          const text = await readFile(resolved.absPath, "utf8");
          return { text: formatTruncated(truncateTail(`## ${resolved.store.scope} note: ${resolved.rel}\n\n${text}`, NOTE_CAP)) };
        }

        const sections: string[] = [];
        for (const scope of scopes) {
          const store = target.stores[scope];
          const text = await readCatalogue(store);
          let body = text;
          if (args.query) {
            const q = args.query.toLowerCase();
            body = parseEntries(text)
              .filter((entry) => entry.line.toLowerCase().includes(q) || (entry.meta ?? "").toLowerCase().includes(q))
              .map((entry) => `${entry.meta ? `${entry.meta}\n` : ""}${entry.line}`)
              .join("\n");
          }
          const label = scope === "local" ? `local (${basename(target.root)})` : "global";
          sections.push(`## ${label} memory — ${store.memoryFile}${existsSync(store.memoryFile) ? "" : " (missing)"}\n\n${body.trim() || "(empty)"}`);
        }
        return { text: formatTruncated(truncateTail(sections.join("\n\n"), READ_CAP)) };
      },
    },
    {
      name: "memory_search",
      label: "Memory Search",
      description:
        "Search facts and note bodies with weighted lexical ranking, exact tokens, phrase/coverage boosts and matching-passage counts. Descriptions and tags weigh more; one result per note. Default scope 'both'." +
        WORKSPACE_GUIDANCE,
      promptSnippet: "Search memory facts and note bodies",
      parameters: Type.Object({
        query: Type.String({ description: "Search terms." }),
        scope: SCOPE_READ,
        root: ROOT_PARAMETER,
      }),
      async execute(args: { query: string; scope?: string; root?: string }, exec: ToolExec): Promise<ToolResult> {
        const scopes = resolveScopes(args.scope);
        const target = targetStores(args.root, scopes, exec);
        if (target.status === "error") return failure(target.message);
        const preparationError = await prepareReads(target.stores, scopes);
        if (preparationError) return failure(preparationError);
        const hits = await searchStores(target.stores, args.query, scopes, 20);
        if (hits.length === 0) return { text: "No matches in memory." };
        const lines = hits.map((hit) =>
          `[${hit.scope}/${hit.file}] ${hit.id ? `[id=${hit.id}] ` : ""}${hit.line}${hit.matchLines > 1 ? ` (+${hit.matchLines - 1} more matching lines)` : ""}`,
        );
        return { text: formatTruncated(truncateTail(lines.join("\n"), READ_CAP)) };
      },
    },
    {
      name: "memory_forget",
      label: "Memory Forget",
      description:
        "Delete facts or notes whose description, path or metadata contains the given text (case-insensitive); note bodies are not matched. Removes note files with recoverable snapshots. Returns a recovery ID for memory_restore. Default scope 'local'." +
        WORKSPACE_GUIDANCE,
      promptSnippet: "Forget facts or notes matching a string (recoverable)",
      parameters: Type.Object({
        text: Type.String({ description: "Text that identifies entries to delete." }),
        scope: SCOPE_WRITE,
        root: ROOT_PARAMETER,
      }),
      async execute(args: { text: string; scope?: Scope; root?: string }, exec: ToolExec): Promise<ToolResult> {
        const scope = args.scope ?? "local";
        const target = targetStores(args.root, [scope], exec);
        if (target.status === "error") return failure(target.message);
        const store = target.stores[scope];
        const mutation = await mutate(target.stores, scope, () => forgetEntries(store, args.text, queue));
        if (mutation.status === "error") return failure(mutation.message);
        const result = mutation.value;
        if (result.recoveryId === null) return { text: `No entries matching "${args.text}" in ${scope} memory.` };
        return { text: `Removed ${result.removed.length} entr(y/ies) from ${scope} memory (${store.memoryFile}). Recovery id: ${result.recoveryId}\n${restoreHint(result.recoveryId, scope, args.root)}` };
      },
    },
    {
      name: "memory_restore",
      label: "Memory Restore",
      description:
        "Restore entries deleted by memory_forget or undo a memory_update using its recovery ID. Refuses to overwrite later edits; conflicts retain the recovery record. Default scope 'both'; use the same root as the original change." +
        WORKSPACE_GUIDANCE,
      promptSnippet: "Undo a forget or update with its recovery ID",
      parameters: Type.Object({
        recoveryId: Type.String({ description: "Recovery id returned by memory_forget or memory_update." }),
        scope: SCOPE_READ,
        root: ROOT_PARAMETER,
      }),
      async execute(args: { recoveryId: string; scope?: string; root?: string }, exec: ToolExec): Promise<ToolResult> {
        const scopes = resolveScopes(args.scope);
        const target = targetStores(args.root, scopes, exec);
        if (target.status === "error") return failure(target.message);
        const result = await restoreEntry(
          target.stores,
          args.recoveryId,
          queue,
          scopes,
          (store) => workspaceAccessError(target.stores, [store.scope]),
          ensureStoreVersion,
        );
        if (!result) return { text: `No recovery record found for id ${args.recoveryId}.` };
        if (result.status === "error") return failure(result.message);
        return {
          text: `Restored ${result.entries.length} entr(y/ies) to ${result.scope} memory:\n${result.entries.map((entry) => `- ${entry.line}`).join("\n")}`,
        };
      },
    },
    {
      name: "memory_status",
      label: "Memory Status",
      description:
        "Show memory file locations, sizes, entry counts, and current session's injected snapshot size. Optional root selects another existing workspace. Works before memory_init and never creates files.",
      promptSnippet: "Show memory store locations, counts, and snapshot size",
      parameters: Type.Object({ root: ROOT_PARAMETER }),
      async execute(args: { root?: string }, exec: ToolExec): Promise<ToolResult> {
        const target = targetStores(args.root, ["local"], exec);
        if (target.status === "error") return failure(target.message);
        return { text: await statusText(target.stores, ctx.config, target.root) };
      },
    },
    {
      name: "memory_migrate",
      label: "Memory Migrate",
      description:
        "Migrate a legacy plain-file memory store into this workspace's shared store. Detects a pi-remember v1 store at <workspace>/.pi/memory (or an in-place copy missing only the marker). " +
        "Copies current facts and notes only; recovery records, migration backups and other history are left behind. " +
        "Never overwrites an initialized target. Use dryRun first when unsure, and ask the user before migrating.",
      promptSnippet: "Migrate a legacy pi-remember store into this workspace",
      parameters: Type.Object({
        source: Type.Optional(Type.String({ description: "Legacy store directory. Defaults to <workspace>/.pi/memory." })),
        target: Type.Optional(Type.String({ description: `Destination store directory. Defaults to <workspace>/${ctx.config.dirName}/memory.` })),
        dryRun: Type.Optional(Type.Boolean({ description: "Plan and report without writing anything." })),
        root: ROOT_PARAMETER,
      }),
      async execute(args: { source?: string; target?: string; dryRun?: boolean; root?: string }, exec: ToolExec): Promise<ToolResult> {
        const cwd = args.root?.trim() ? resolve(exec.cwd, expandHome(args.root.trim())) : exec.cwd;
        const explicit = Boolean(args.source?.trim() || args.target?.trim());
        let source = args.source?.trim() ? resolve(cwd, expandHome(args.source.trim())) : legacySource(cwd);
        let target = args.target?.trim() ? resolve(cwd, expandHome(args.target.trim())) : join(cwd, ctx.config.dirName, "memory");
        if (!explicit) {
          const detection = await detectForWorkspace(cwd, ctx.config);
          if (!detection) return { text: `No legacy memory store found for ${cwd} (looked for ${legacySource(cwd)} and an in-place marker in ${target}).` };
          source = detection.source;
          target = detection.target;
        }
        try {
          const report = await migrate({ source, target, dryRun: args.dryRun === true });
          return { text: formatReport(report) };
        } catch (error) {
          return failure(`Migration refused: ${(error as Error).message}`);
        }
      },
    },
  ];
}
