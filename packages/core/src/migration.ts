import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StorePaths } from "./store.ts";

/**
 * The only store format this engine reads and writes. Anything older is a
 * migration source, not something core silently upgrades: explicit migrators
 * (see `@seangle/remember-migrators`) own that decision.
 */
export const CURRENT_VERSION = 1;

/** Version marker filename. Kept tiny and human-readable. */
export const VERSION_FILE = "remember.json";

const MARKER_TEXT = JSON.stringify({ version: CURRENT_VERSION }, null, 2) + "\n";

export class StoreMigrationError extends Error {
  constructor(message: string) { super(message); this.name = "StoreMigrationError"; }
}

/** The store holds memory but carries no marker: migration must be explicit. */
export class StoreMigrationRequiredError extends StoreMigrationError {
  readonly storeDir: string;
  constructor(storeDir: string) {
    super(`Memory store at ${JSON.stringify(storeDir)} has content but no ${VERSION_FILE}; migrate it explicitly before use.`);
    this.name = "StoreMigrationRequiredError";
    this.storeDir = storeDir;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function missing(error: unknown): boolean {
  return object(error) && error.code === "ENOENT";
}

async function rootOf(store: Pick<StorePaths, "dir">): Promise<string | null> {
  try {
    const root = await realpath(store.dir);
    if (!(await lstat(root)).isDirectory()) throw new StoreMigrationError(`Memory store is not a directory: ${JSON.stringify(store.dir)}`);
    return root;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/** Read the marker version, or `null` when the store or marker is absent. */
export async function readStoreVersion(store: Pick<StorePaths, "dir">): Promise<number | null> {
  const root = await rootOf(store);
  if (root === null) return null;
  let text: string;
  try {
    text = await readFile(join(root, VERSION_FILE), "utf8");
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    throw new StoreMigrationError(`Malformed ${VERSION_FILE}: expected {"version": number}.`);
  }
  if (!object(value) || typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 0) {
    throw new StoreMigrationError(`Invalid store version in ${VERSION_FILE}; expected a nonnegative safe integer.`);
  }
  if (value.version > CURRENT_VERSION) {
    throw new StoreMigrationError(`Future store version ${value.version}; this engine supports version ${CURRENT_VERSION}.`);
  }
  return value.version;
}

/** Whether the store holds anything worth migrating (facts or notes). */
export async function storeHasContent(store: Pick<StorePaths, "dir" | "memoryFile" | "notesDir">): Promise<boolean> {
  try {
    if ((await lstat(store.memoryFile)).size > 0) return true;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  try {
    const entries = await readdir(store.notesDir, { recursive: true, withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name.endsWith(".md"));
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

/** Write the current marker atomically. Migrators call this on a fresh target. */
export async function writeStoreVersion(store: Pick<StorePaths, "dir">): Promise<void> {
  await mkdir(store.dir, { recursive: true });
  const root = await realpath(store.dir);
  const temporary = join(root, `.${VERSION_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, MARKER_TEXT, { flag: "wx", mode: 0o600 });
    await rename(temporary, join(root, VERSION_FILE));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Read-only guard for context assembly: never inject an unversioned store. */
export async function assertCurrentStoreVersion(store: StorePaths): Promise<void> {
  const version = await readStoreVersion(store);
  if (version === CURRENT_VERSION) return;
  if (version === null) {
    if (await storeHasContent(store)) throw new StoreMigrationRequiredError(store.dir);
    return;
  }
  throw new StoreMigrationError(`Unsupported store version ${version} at ${JSON.stringify(store.dir)}.`);
}

/**
 * Create the marker for an empty store; refuse to adopt one that already has
 * content. Mutations pass `create` so a brand-new store is marked *before* the
 * first byte is written; reads never create anything.
 */
export async function ensureStoreVersion(store: StorePaths, options: { create?: boolean } = {}): Promise<void> {
  const root = await rootOf(store);
  if (root === null) {
    if (!options.create) return;
    await mkdir(store.dir, { recursive: true });
  }
  const version = await readStoreVersion(store);
  if (version === CURRENT_VERSION) return;
  if (version !== null) {
    throw new StoreMigrationError(`Unsupported store version ${version} at ${JSON.stringify(store.dir)}.`);
  }
  if (await storeHasContent(store)) throw new StoreMigrationRequiredError(store.dir);
  await writeStoreVersion(store);
}
