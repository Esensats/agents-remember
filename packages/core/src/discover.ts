import { opendir, open, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseEntries } from "./store.ts";

/**
 * Discovery of nested workspaces that keep their own memory bank.
 *
 * A session in a monorepo or a folder of repositories must be able to learn
 * that a child directory has a bank of its own. The walk that finds them runs
 * inside prompt injection, so it is bounded on every axis and cached: depth,
 * visited directories, wall-clock budget, entries per directory, and stores
 * reported. It also never follows a symlink, never runs a subprocess, and never
 * calls a synchronous filesystem function.
 */

/** Names never descended into: build output, dependency trees, and scratch space. */
const SKIPPED = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor", "venv", "__pycache__",
  "coverage", "temp", "tmp",
]);

export interface NestedScanOptions {
  /** Workspace configuration directory, for example `.agents`. */
  dirName: string;
  /** Levels below the scanned root to look at. 2 reaches `repos/<repo>`. */
  depth?: number;
  /** Directories probed at most. */
  maxDirectories?: number;
  /** Banks reported at most. */
  maxStores?: number;
  /** Wall-clock budget for one walk; a reached budget returns a partial result. */
  budgetMs?: number;
  /** Bytes of `MEMORY.md` read for the fact count. */
  maxMemoryBytes?: number;
  /** How long a finished walk stays valid. 0 disables the cache. */
  cacheTtlMs?: number;
  /** Extra directory names to skip, on top of the fixed list. */
  skip?: readonly string[];
  /** Stops the walk; a partial result is returned, never an error. */
  signal?: AbortSignal;
  /** Clock, for tests. */
  now?: () => number;
}

export interface NestedStore {
  /** Absolute child workspace root. */
  root: string;
  /** Path relative to the scanned root, with `/` separators. */
  rel: string;
  /** Absolute `MEMORY.md` path. */
  memoryFile: string;
  facts: number;
  notes: number;
  bytes: number;
}

export interface NestedScan {
  /** Banks found, sorted by `rel`. */
  stores: NestedStore[];
  /** Directories probed. */
  visited: number;
  /** A depth, directory, store or budget limit was reached. */
  truncated: boolean;
  /** Wall time of the walk. Diagnostics only: never part of injected bytes. */
  ms: number;
}

const DEFAULT_DEPTH = 2;
const DEFAULT_MAX_DIRECTORIES = 256;
const DEFAULT_MAX_STORES = 8;
const DEFAULT_BUDGET_MS = 50;
const DEFAULT_MAX_MEMORY_BYTES = 128 * 1024;
const DEFAULT_CACHE_TTL_MS = 30_000;
const MAX_ENTRIES_PER_DIRECTORY = 256;
const CACHE_KEYS = 64;

const emptyScan = (): NestedScan => ({ stores: [], visited: 0, truncated: false, ms: 0 });

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/** Read at most `cap` bytes: a hostile bank must not be able to cost a full read. */
async function readCapped(path: string, size: number, cap: number): Promise<string> {
  if (size <= cap) {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  }
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(cap);
    const { bytesRead } = await handle.read(buffer, 0, cap, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function countNotes(notesDir: string): Promise<number> {
  try {
    const entries = await readdir(notesDir, { recursive: true });
    return entries.filter((entry) => entry.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

async function summarise(child: string, rel: string, dirName: string, maxMemoryBytes: number): Promise<NestedStore | null> {
  const memoryFile = join(child, dirName, "memory", "MEMORY.md");
  let info;
  try {
    info = await stat(memoryFile);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (!info.isFile()) return null;
  const text = await readCapped(memoryFile, info.size, maxMemoryBytes);
  return {
    root: child,
    rel,
    memoryFile,
    facts: parseEntries(text).length,
    notes: await countNotes(join(child, dirName, "memory", "notes")),
    bytes: info.size,
  };
}

async function walk(root: string, options: Required<Pick<NestedScanOptions,
  "dirName" | "depth" | "maxDirectories" | "maxStores" | "budgetMs" | "maxMemoryBytes">> & {
    skip: ReadonlySet<string>;
    signal?: AbortSignal;
    now: () => number;
  }): Promise<NestedScan> {
  const started = options.now();
  const stores: NestedStore[] = [];
  const seen = new Set<string>();
  let visited = 0;
  let truncated = false;

  const stop = () => {
    if (truncated) return true;
    if (options.signal?.aborted === true) {
      truncated = true;
      return true;
    }
    if (options.now() - started > options.budgetMs) {
      truncated = true;
      return true;
    }
    return false;
  };

  async function descend(directory: string, level: number): Promise<void> {
    if (stop() || level > options.depth) return;
    let handle;
    try {
      handle = await opendir(directory);
    } catch {
      return;
    }
    const names: string[] = [];
    try {
      for await (const entry of handle) {
        // A symlinked directory is neither probed nor followed: it can leave
        // the tree or loop back into it.
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (entry.name.startsWith(".") || options.skip.has(entry.name)) continue;
        names.push(entry.name);
        if (names.length > MAX_ENTRIES_PER_DIRECTORY) {
          truncated = true;
          break;
        }
      }
    } catch {
      // An unreadable directory contributes nothing; the walk continues.
    }
    names.sort();
    for (const name of names) {
      if (stop()) return;
      if (visited >= options.maxDirectories) {
        truncated = true;
        return;
      }
      visited++;
      const child = join(directory, name);
      const rel = relative(root, child).split(sep).join("/");
      let found: NestedStore | null = null;
      try {
        found = await summarise(child, rel, options.dirName, options.maxMemoryBytes);
      } catch {
        found = null;
      }
      if (found !== null) {
        // A bank is a leaf: the child's own subdirectories belong to it.
        if (!seen.has(found.memoryFile) && stores.length < options.maxStores) {
          seen.add(found.memoryFile);
          stores.push(found);
        } else if (stores.length >= options.maxStores) {
          truncated = true;
        }
        continue;
      }
      await descend(child, level + 1);
    }
  }

  await descend(root, 1);
  stores.sort((a, b) => a.rel.localeCompare(b.rel));
  return { stores, visited, truncated, ms: Math.max(0, options.now() - started) };
}

interface CacheEntry {
  at: number;
  key: string;
  promise: Promise<NestedScan>;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(root: string, options: NestedScanOptions): string {
  return [
    root, options.dirName, options.depth ?? DEFAULT_DEPTH,
    options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES, options.maxStores ?? DEFAULT_MAX_STORES,
    options.budgetMs ?? DEFAULT_BUDGET_MS, options.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES,
  ].join("\0");
}

/** Drop the cached walk of one root, or of every root. */
export function invalidateNestedScan(root?: string): void {
  if (root === undefined) {
    cache.clear();
    return;
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${root}\0`)) cache.delete(key);
  }
}

/**
 * Find child workspaces with an initialized bank. Never creates, writes, or
 * throws: a failure is an empty scan, and a reached limit is a partial one.
 */
export function discoverNestedStores(
  root: string,
  options: NestedScanOptions,
): Promise<NestedScan> {
  const now = options.now ?? Date.now;
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const useCache = ttl > 0;
  const key = cacheKey(root, options);

  if (useCache) {
    const hit = cache.get(key);
    if (hit !== undefined && now() - hit.at < ttl) {
      cache.delete(key);
      cache.set(key, hit); // Most recently used last.
      return hit.promise;
    }
    cache.delete(key);
  }

  const scan = walk(root, {
    dirName: options.dirName,
    depth: options.depth ?? DEFAULT_DEPTH,
    maxDirectories: options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES,
    maxStores: options.maxStores ?? DEFAULT_MAX_STORES,
    budgetMs: options.budgetMs ?? DEFAULT_BUDGET_MS,
    maxMemoryBytes: options.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES,
    skip: new Set([...SKIPPED, ...(options.skip ?? []), options.dirName]),
    signal: options.signal,
    now,
  }).catch(() => emptyScan());

  if (!useCache) return scan;
  cache.set(key, { at: now(), key, promise: scan });
  while (cache.size > CACHE_KEYS) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
  return scan;
}

export interface NestedFormatOptions {
  /** Whole section, header included, is capped at this many characters. */
  maxChars: number;
  /** Store lines at most in the section. */
  maxStores?: number;
}

/** `52 facts, 1 note`, in the shared one-word-for-one-thing form. */
export function describeCounts(facts: number, notes: number): string {
  return `${facts} ${facts === 1 ? "fact" : "facts"}, ${notes} ${notes === 1 ? "note" : "notes"}`;
}

/**
 * The injected block for nested banks: a two-line header and one line per
 * workspace. Whole lines are kept; the last one counts what did not fit, so a
 * path is never cut in half. Same scan => same bytes.
 */
export function formatNestedStores(
  scan: NestedScan,
  options: NestedFormatOptions,
): string {
  const stores = scan.stores.slice(0, options.maxStores ?? scan.stores.length);
  if (stores.length === 0) return "";
  const header = "## Nested workspace memory (not included above; read one with memory_read{root})" +
    (scan.truncated ? " [scan incomplete]" : "");
  const lines = stores.map((store) => `- ${store.rel} — ${describeCounts(store.facts, store.notes)}`);
  const more = (omitted: number) => `- +${omitted} more (memory_status)`;
  const render = (kept: number) => {
    const omitted = lines.length - kept;
    const tail = omitted > 0 ? `\n${more(omitted)}` : "";
    return `${header}\n${lines.slice(0, kept).join("\n")}${tail}`;
  };

  // Whole lines only: a path must never be cut in half. The count of what did
  // not fit is itself a line, so its room is reserved before choosing.
  let kept = 0;
  for (let candidate = 1; candidate <= lines.length; candidate++) {
    if (render(candidate).length <= options.maxChars) kept = candidate;
    else break;
  }
  if (kept === 0) {
    const only = `${header}\n${more(lines.length)}`;
    return only.length <= options.maxChars ? only : "";
  }
  return render(kept);
}
