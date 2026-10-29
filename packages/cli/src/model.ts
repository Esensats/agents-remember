import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import {
  assertCurrentStoreVersion, buildSnapshot, entryId, noteReference, parseEntries, parseMemoId,
  parseNote, readCatalogue, readMemo, readMemoryText, readNotes, readStoreVersion, resolveNotePath,
  resolveStores, searchStores, statMemory, storeHasContent,
  type MemoryEntry, type NoteMetadata, type Scope, type SearchHit, type StorePaths,
} from "@seangle/remember-core";
import type { ScopeFilter } from "./args.ts";

/** Unusable input or configuration (exit 2). "Nothing found" uses exit 1. */
export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function expandHome(input: string, home = homedir()): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return input;
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Build path layout exactly like the adapters, without creating anything. */
export function makeStore(scope: Scope, dir: string): StorePaths {
  return {
    scope,
    dir,
    memoryFile: join(dir, "MEMORY.md"),
    recoveryDir: join(dir, "recovery"),
    notesDir: join(dir, "notes"),
  };
}

/** A path that is intentionally absent: reads against it are empty, never errors. */
function absentStore(scope: Scope, root: string, dirName: string): StorePaths {
  return makeStore(scope, join(root, dirName, ".remember-absent-global"));
}

export interface GlobalCandidate {
  label: string;
  dir: string;
}

/**
 * Known machine-wide store locations, in discovery order. Harness-owned global
 * memory is deliberately not shared, so the CLI probes each and never merges.
 */
export function globalCandidates(env: NodeJS.ProcessEnv = process.env, home = homedir()): GlobalCandidate[] {
  const xdg = env.XDG_DATA_HOME?.trim();
  const dataHome = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share");
  const dshHome = env.DSH_HOME?.trim();
  const dsh = dshHome && isAbsolute(dshHome) ? dshHome : join(home, ".dsh");
  const candidates: GlobalCandidate[] = [
    { label: "pi", dir: join(home, ".pi", "agent", "memory") },
    { label: "shared", dir: join(home, ".agents", "memory") },
    { label: "opencode", dir: join(dataHome, "opencode", "memory") },
    { label: "dsh", dir: join(dsh, "memory") },
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.dir)) return false;
    seen.add(candidate.dir);
    return true;
  });
}

/** Presence probe: a marker, an index file or a notes directory is enough. */
export function storePresent(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return existsSync(join(dir, "remember.json")) || existsSync(join(dir, "MEMORY.md")) ||
    existsSync(join(dir, "notes"));
}

export interface CandidateStatus extends GlobalCandidate {
  paths: StorePaths;
  present: boolean;
}

export interface Context {
  root: string;
  dirName: string;
  local: StorePaths;
  /** Resolved global store for scoped operations, when unambiguous. */
  global: StorePaths | null;
  globalLabel: string | null;
  ambiguousGlobal: boolean;
  explicitGlobal: boolean;
  candidates: CandidateStatus[];
  /** Store record accepted by core: global falls back to an absent path. */
  stores: Record<Scope, StorePaths>;
  budgets: { global: number; local: number };
}

function canonicalRoot(cwd: string, root: string | undefined, home: string): string {
  const input = root === undefined ? cwd : root.startsWith("~") ? expandHome(root, home) : root;
  if (!input.trim()) throw new CliError("Workspace root must not be blank.");
  let canonical: string;
  try {
    canonical = realpathSync(resolve(cwd, input));
    if (!statSync(canonical).isDirectory()) throw new CliError(`Workspace root is not a directory: ${canonical}.`);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Cannot resolve workspace root ${JSON.stringify(input)}: ${errorMessage(error)}`);
  }
  return canonical;
}

/**
 * Resolve the workspace store, the global store (explicit, discovered, absent
 * or ambiguous), and the injection budgets. Reads only; nothing is created.
 */
export function createContext(
  cwd: string,
  options: { root?: string; dirName: string; globalDir?: string },
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Context {
  const root = canonicalRoot(cwd, options.root, home);
  const local = resolveStores(root, absentStore("global", root, options.dirName).dir, options.dirName).local;
  const budgets = {
    global: intFromEnv(env, "REMEMBER_INJECT_CHARS_GLOBAL", 3000),
    local: intFromEnv(env, "REMEMBER_INJECT_CHARS_LOCAL", 3000),
  };

  const sameDirectory = (left: string, right: string): boolean => resolve(left) === resolve(right);

  const explicit = options.globalDir?.trim();
  if (explicit) {
    const dir = resolve(cwd, expandHome(explicit, home));
    if (sameDirectory(dir, local.dir)) {
      throw new CliError(`--global-dir must differ from the workspace store (${local.dir}).`);
    }
    const paths = makeStore("global", dir);
    const candidate = { label: "global", dir, paths, present: storePresent(dir) };
    return {
      root, dirName: options.dirName, local,
      global: paths, globalLabel: "global", ambiguousGlobal: false, explicitGlobal: true,
      candidates: [candidate], stores: { local, global: paths }, budgets,
    };
  }

  // A workspace root equal to $HOME makes ~/.agents/memory both the local store
  // and a discovery candidate; one store must not be read twice.
  const candidates = globalCandidates(env, home)
    .filter((candidate) => !sameDirectory(candidate.dir, local.dir))
    .map((candidate) => ({
      ...candidate,
      paths: makeStore("global", candidate.dir),
      present: storePresent(candidate.dir),
    }));
  const present = candidates.filter((candidate) => candidate.present);
  const chosen = present.length === 1 ? present[0] : null;
  return {
    root, dirName: options.dirName, local,
    global: chosen?.paths ?? null, globalLabel: chosen?.label ?? null,
    ambiguousGlobal: present.length > 1, explicitGlobal: false,
    candidates,
    stores: { local, global: chosen?.paths ?? absentStore("global", root, options.dirName) },
    budgets,
  };
}

/** Scopes an operation may read; refuses to guess between several global stores. */
export function scopesFor(ctx: Context, filter: ScopeFilter): Scope[] {
  if (filter === "local") return ["local"];
  if (filter === "both") {
    if (ctx.global) return ["local", "global"];
    if (ctx.ambiguousGlobal) return ["local"];
    return ["local"];
  }
  if (ctx.global) return ["global"];
  if (ctx.ambiguousGlobal) {
    const labels = ctx.candidates.filter((candidate) => candidate.present)
      .map((candidate) => `${candidate.label} (${candidate.dir})`).join(", ");
    throw new CliError(`Several global memory stores exist: ${labels}. Choose one with --global-dir <dir>.`);
  }
  throw new CliError("No global memory store found. Pass --global-dir <dir> to select one.");
}

export function scopeLabel(ctx: Context, scope: Scope): string {
  return scope === "local" ? "local" : ctx.globalLabel ?? "global";
}

/** Duplicate of the budgets rule so summaries match what an agent would inject. */
export interface SnapshotInfo {
  globalLabel: string;
  text: string;
  chars: number;
  globalChars: number;
  localChars: number;
  globalBudget: number;
  localBudget: number;
  warnings: string[];
}

async function catalogueFor(store: StorePaths, label: string): Promise<{ text: string; warning: string | null }> {
  try {
    await assertCurrentStoreVersion(store);
  } catch (error) {
    return { text: "", warning: `${label}: ${errorMessage(error)}` };
  }
  try {
    return { text: await readCatalogue(store), warning: null };
  } catch (error) {
    return { text: "", warning: `${label}: ${errorMessage(error)}` };
  }
}

export async function snapshotFor(
  ctx: Context,
  globalPaths: StorePaths | null,
  globalLabel: string,
  wrap: boolean,
): Promise<SnapshotInfo> {
  const [global, local] = await Promise.all([
    globalPaths ? catalogueFor(globalPaths, globalLabel) : Promise.resolve({ text: "", warning: null }),
    catalogueFor(ctx.local, "local"),
  ]);
  const snapshot = buildSnapshot(global.text, local.text, basename(ctx.root), {
    maxGlobalChars: ctx.budgets.global,
    maxLocalChars: ctx.budgets.local,
    wrap,
  });
  return {
    globalLabel,
    text: snapshot.text,
    chars: snapshot.text.length,
    globalChars: snapshot.globalChars,
    localChars: snapshot.localChars,
    globalBudget: ctx.budgets.global,
    localBudget: ctx.budgets.local,
    warnings: [global.warning, local.warning].filter((warning): warning is string => warning !== null),
  };
}

export interface StoreInfo {
  label: string;
  scope: Scope;
  dir: string;
  exists: boolean;
  version: number | null;
  needsMigration: boolean;
  facts: number;
  notes: number;
  recovery: number;
  bytes: number;
  error: string | null;
}

export async function describeStore(label: string, paths: StorePaths): Promise<StoreInfo> {
  try {
    const [version, stat, hasContent] = await Promise.all([
      readStoreVersion(paths),
      statMemory(paths),
      storeHasContent(paths),
    ]);
    return {
      label, scope: paths.scope, dir: paths.dir, exists: stat.exists,
      version, needsMigration: version === null && hasContent,
      facts: stat.entries, notes: stat.notesCount, recovery: stat.recoveryCount, bytes: stat.bytes,
      error: null,
    };
  } catch (error) {
    return {
      label, scope: paths.scope, dir: paths.dir, exists: false,
      version: null, needsMigration: false, facts: 0, notes: 0, recovery: 0, bytes: 0,
      error: errorMessage(error),
    };
  }
}

export interface StoreSummary {
  workspace: string;
  dirName: string;
  local: StoreInfo;
  candidates: StoreInfo[];
  ambiguousGlobal: boolean;
  globalLabel: string | null;
  snapshots: SnapshotInfo[];
  warnings: string[];
}

function storeWarning(info: StoreInfo): string[] {
  if (info.error) return [`${info.label}: ${info.error}`];
  if (info.needsMigration) return [`${info.label}: content without remember.json — needs an explicit migration`];
  return [];
}

export async function summarize(ctx: Context, wrap = true): Promise<StoreSummary> {
  const local = await describeStore("local", ctx.local);
  const candidates = await Promise.all(ctx.candidates.map((candidate) =>
    describeStore(candidate.label, candidate.paths)));
  const present = ctx.candidates.filter((candidate) => candidate.present);
  const targets = ctx.explicitGlobal || ctx.ambiguousGlobal || !ctx.global
    ? present
    : present.filter((candidate) => candidate.label === ctx.globalLabel);
  const snapshots = await Promise.all(targets.map((candidate) =>
    snapshotFor(ctx, candidate.paths, candidate.label, wrap)));
  const warnings = [local, ...candidates].flatMap(storeWarning);
  if (ctx.ambiguousGlobal) {
    warnings.push(`several global stores found (${present.map((candidate) => candidate.label).join(", ")}); scoped commands need --global-dir`);
  }
  return {
    workspace: ctx.root, dirName: ctx.dirName, local, candidates,
    ambiguousGlobal: ctx.ambiguousGlobal, globalLabel: ctx.globalLabel,
    snapshots, warnings,
  };
}

export interface FactView {
  scope: Scope;
  id: string | null;
  created: string | null;
  line: string;
  storeLabel: string;
}

export interface NoteView {
  scope: Scope;
  id: string;
  rel: string;
  path: string;
  description: string;
  created: string;
  modified: string;
  storeLabel: string;
}

export interface MissingNoteView {
  scope: Scope;
  ref: string;
  id: string | null;
}

export interface Listing {
  workspace: string;
  scopes: Scope[];
  facts: FactView[];
  notes: NoteView[];
  missing: MissingNoteView[];
  stores: StoreInfo[];
  warnings: string[];
}

const META_TIMESTAMP = /<!--\s*([0-9T:.+Z-]+)\s+\[([a-f0-9]{8})\]/i;

export function entryTimestamp(entry: MemoryEntry): string | null {
  return META_TIMESTAMP.exec(entry.meta ?? "")?.[1] ?? null;
}

function relPath(path: string): string {
  return path.split(sep).join("/");
}

export async function loadListing(ctx: Context, filter: ScopeFilter): Promise<Listing> {
  const scopes = scopesFor(ctx, filter);
  const facts: FactView[] = [];
  const notes: NoteView[] = [];
  const missing: MissingNoteView[] = [];
  const warnings: string[] = [];
  const stores: StoreInfo[] = [];

  if (ctx.ambiguousGlobal && filter !== "local") {
    warnings.push(`several global stores found; showing local memory only (use --global-dir)`);
  }

  for (const scope of scopes) {
    const paths = ctx.stores[scope];
    const label = scopeLabel(ctx, scope);
    const info = await describeStore(label, paths);
    stores.push(info);
    warnings.push(...storeWarning(info));
    if (info.needsMigration) continue; // Never present unversioned content as current.
    try {
      const entries = parseEntries(await readMemoryText(paths));
      const records = await readNotes(paths);
      const byRel = new Map(records.map((record) => [record.rel, record]));
      for (const entry of entries) {
        if (noteReference(entry) !== null) continue;
        facts.push({
          scope, id: entryId(entry), created: entryTimestamp(entry), line: entry.line,
          storeLabel: label,
        });
      }
      for (const ref of entries.map(noteReference).filter((rel): rel is string => rel !== null)) {
        if (!byRel.has(ref)) missing.push({ scope, ref, id: entries.filter((entry) =>
          noteReference(entry) === ref).map(entryId).find((id) => id !== null) ?? null });
      }
      for (const record of records) {
        notes.push({
          scope, id: record.metadata.id, rel: record.rel, path: record.path,
          description: record.metadata.description, created: record.metadata.created,
          modified: record.metadata.modified, storeLabel: label,
        });
      }
    } catch (error) {
      warnings.push(`${label}: ${errorMessage(error)}`);
    }
  }
  return { workspace: ctx.root, scopes, facts, notes, missing, stores, warnings };
}

/** Read note bodies only for hosts that need them (browse). Keyed `scope:rel`. */
export async function loadBodies(listing: Listing): Promise<Map<string, string>> {
  const bodies = new Map<string, string>();
  await Promise.all(listing.notes.map(async (note) => {
    try {
      const parsed = parseNote(await readFile(note.path, "utf8"));
      bodies.set(`${note.scope}:${note.rel}`, (parsed?.body ?? "").replace(/\s+$/, ""));
    } catch {
      bodies.set(`${note.scope}:${note.rel}`, "");
    }
  }));
  return bodies;
}

export type ShowResult =
  | {
      kind: "note"; id: string; scope: Scope; rel: string; path: string;
      description: string; created: string; modified: string; body: string;
      storeLabel: string;
    }
  | {
      kind: "fact"; scope: Scope; id: string | null; created: string | null;
      line: string; meta: string | null; storePath: string; storeLabel: string;
    };

function requireFound<T extends { status: string }>(result: T, fallback: string): Extract<T, { status: "found" }> {
  if (result.status !== "found") {
    throw new CliError((result as unknown as { message: string }).message ?? fallback, 1);
  }
  return result as Extract<T, { status: "found" }>;
}

export async function readItem(ctx: Context, input: string, filter: ScopeFilter): Promise<ShowResult> {
  const scopes = scopesFor(ctx, filter);
  const id = parseMemoId(input);
  if (id) {
    const found = requireFound(await readMemo(ctx.stores, input, scopes), `Memo not found: ${input}.`);
    const label = scopeLabel(ctx, found.store.scope);
    if (found.noteRel && found.notePath) {
      const parsed = parseNote(found.noteText ?? "");
      const metadata: NoteMetadata | undefined = parsed?.metadata;
      return {
        kind: "note", id, scope: found.store.scope, rel: found.noteRel, path: found.notePath,
        description: metadata?.description ?? found.entry.line,
        created: metadata?.created ?? "", modified: metadata?.modified ?? "",
        body: (parsed?.body ?? found.noteText ?? "").replace(/\s+$/, ""),
        storeLabel: label,
      };
    }
    return {
      kind: "fact", scope: found.store.scope, id: entryId(found.entry),
      created: entryTimestamp(found.entry), line: found.entry.line,
      meta: found.entry.meta ?? null, storePath: found.store.memoryFile, storeLabel: label,
    };
  }

  const resolved = resolveNotePath(ctx.stores, input, scopes);
  if (resolved.status === "error") throw new CliError(resolved.message, 1);
  const text = await readFile(resolved.absPath, "utf8");
  const parsed = parseNote(text);
  if (!parsed) throw new CliError(`Note has no valid frontmatter: ${input}`, 1);
  return {
    kind: "note", id: parsed.metadata.id, scope: resolved.store.scope,
    rel: relPath(resolved.rel), path: resolved.absPath,
    description: parsed.metadata.description, created: parsed.metadata.created,
    modified: parsed.metadata.modified, body: parsed.body.replace(/\s+$/, ""),
    storeLabel: scopeLabel(ctx, resolved.store.scope),
  };
}

export interface SearchResult {
  query: string;
  scopes: Scope[];
  hits: SearchHit[];
}

export async function runSearch(ctx: Context, query: string, filter: ScopeFilter, limit: number): Promise<SearchResult> {
  const scopes = scopesFor(ctx, filter);
  const hits = await searchStores(ctx.stores, query, scopes, limit);
  return { query, scopes, hits };
}

export interface RecoveryView {
  id: string;
  scope: Scope;
  kind: "forget" | "update" | "unknown";
  timestamp: string | null;
  entries: number;
  notes: number;
  memoId: string | null;
  error: string | null;
}

export interface RecoveryResult {
  records: RecoveryView[];
  warnings: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read-only inventory of recovery records; the schema is core's public format. */
export async function readRecovery(ctx: Context, filter: ScopeFilter): Promise<RecoveryResult> {
  const scopes = scopesFor(ctx, filter);
  const records: RecoveryView[] = [];
  const warnings: string[] = [];
  for (const scope of scopes) {
    const store = ctx.stores[scope];
    if (!existsSync(store.recoveryDir)) continue;
    try {
      if (lstatSync(store.recoveryDir).isSymbolicLink()) {
        warnings.push(`${scopeLabel(ctx, scope)}: recovery directory is a symlink; not listed`);
        continue;
      }
    } catch (error) {
      warnings.push(`${scopeLabel(ctx, scope)}: ${errorMessage(error)}`);
      continue;
    }
    const files = (await readdir(store.recoveryDir)).filter((file) => file.endsWith(".json")).sort();
    for (const file of files) {
      const id = file.slice(0, -".json".length);
      const base: RecoveryView = {
        id, scope, kind: "unknown", timestamp: null, entries: 0, notes: 0, memoId: null, error: null,
      };
      try {
        const value: unknown = JSON.parse(await readFile(join(store.recoveryDir, file), "utf8"));
        if (!isObject(value)) throw new Error("record is not an object");
        const kind = value.kind === "update" ? "update" : value.kind === undefined || value.kind === "forget"
          ? "forget" : "unknown";
        records.push({
          ...base, kind,
          timestamp: typeof value.timestamp === "string" ? value.timestamp : null,
          entries: Array.isArray(value.entries) ? value.entries.length : 0,
          notes: Array.isArray(value.notes) ? value.notes.length : 0,
          memoId: typeof value.memoId === "string" ? value.memoId : null,
        });
      } catch (error) {
        records.push({ ...base, error: errorMessage(error) });
      }
    }
  }
  return { records, warnings };
}
