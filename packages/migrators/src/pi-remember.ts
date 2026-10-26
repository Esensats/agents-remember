import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  parseEntries,
  parseNote,
  serializeEntries,
  writeStoreVersion,
  CURRENT_VERSION,
  type MemoryEntry,
} from "@seangle/remember-core";
import { MigrationError, type MemoryMigrator, type MigrationPlan, type MigrationReport, type PlannedNote, type SkippedItem } from "./types.ts";

const SOURCE_MARKER = "pi-remember.json";
const NOTE_REFERENCE = /^\s*#note\b/;

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readMarker(source: string): Promise<number | null> {
  try {
    if (!(await lstat(source)).isDirectory()) return null;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  let text: string;
  try {
    text = await readFile(join(source, SOURCE_MARKER), "utf8");
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  try {
    const value = JSON.parse(text);
    return typeof value?.version === "number" ? value.version : null;
  } catch {
    return null;
  }
}

/** Recursively list note files, refusing symlinked directories and files. */
async function listNotes(root: string): Promise<{ rel: string; text: string }[]> {
  const found: { rel: string; text: string }[] = [];
  async function walk(rel: string): Promise<void> {
    const dir = join(root, rel);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(childRel); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      found.push({ rel: childRel, text: await readFile(join(root, childRel), "utf8") });
    }
  }
  await walk("notes");
  return found;
}

/**
 * pi-remember v1 → remember v1.
 *
 * Both formats share MEMORY.md and frontmatter notes; the migration is a
 * selective copy of current knowledge. Recovery records, migration backups and
 * any other state are deliberately left behind: they describe history, not
 * memory.
 */
export const piRememberV1: MemoryMigrator = {
  id: "pi-remember-v1",
  description: "pi-remember v1 store (MEMORY.md facts + notes/ with frontmatter)",

  async detect(source) {
    const version = await readMarker(source);
    return version === CURRENT_VERSION ? version : null;
  },

  async plan(source, target) {
    const version = await readMarker(source);
    if (version === null) throw new MigrationError(`No pi-remember v1 store at ${JSON.stringify(source)}.`);
    if (version !== CURRENT_VERSION) throw new MigrationError(`Unsupported pi-remember store version ${version}; expected ${CURRENT_VERSION}.`);

    const sourcePath = resolve(source);
    const targetPath = resolve(target);
    const inPlace = sourcePath === targetPath;
    if (!inPlace) {
      try {
        await lstat(join(targetPath, "remember.json"));
        throw new MigrationError(`Target already initialized at ${JSON.stringify(targetPath)}.`);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }

    const skipped: SkippedItem[] = [];
    const warnings: string[] = [];

    let facts: MemoryEntry[] = [];
    try {
      facts = parseEntries(await readFile(join(sourcePath, "MEMORY.md"), "utf8"));
    } catch (error) {
      if (!missing(error)) throw error;
      warnings.push("Source has no MEMORY.md; migrating notes only.");
    }
    const references = facts.filter((entry) => NOTE_REFERENCE.test(entry.line));
    if (references.length > 0) {
      warnings.push(`Dropped ${references.length} legacy note reference line(s) from MEMORY.md; the catalogue is derived from notes.`);
    }
    const currentFacts = facts.filter((entry) => !NOTE_REFERENCE.test(entry.line));

    const notes: PlannedNote[] = [];
    const ids = new Set<string>();
    for (const note of await listNotes(sourcePath)) {
      let parsed;
      try {
        parsed = parseNote(note.text);
      } catch (error) {
        skipped.push({ rel: note.rel, reason: (error as Error).message });
        continue;
      }
      if (!parsed) {
        skipped.push({ rel: note.rel, reason: "no frontmatter" });
        continue;
      }
      if (ids.has(parsed.metadata.id)) {
        skipped.push({ rel: note.rel, reason: `duplicate memo ID ${parsed.metadata.id}` });
        continue;
      }
      ids.add(parsed.metadata.id);
      notes.push({ rel: note.rel, text: note.text, id: parsed.metadata.id, description: parsed.metadata.description });
    }

    return {
      migrator: this.id,
      source: sourcePath,
      target: targetPath,
      inPlace,
      facts: currentFacts.length,
      memoryText: currentFacts.length > 0 ? serializeEntries(currentFacts) : "",
      notes,
      skipped,
      warnings,
    };
  },

  async apply(plan, options = {}) {
    const base: Omit<MigrationReport, "wrote"> = {
      ok: true,
      migrator: this.id,
      source: plan.source,
      target: plan.target,
      dryRun: options.dryRun === true,
      facts: plan.facts,
      notes: plan.notes.length,
      skipped: plan.skipped,
      warnings: plan.warnings,
    };
    if (options.dryRun) return { ...base, wrote: [] };

    if (plan.inPlace) {
      await writeStoreVersion({ dir: plan.target });
      return { ...base, wrote: ["remember.json"] };
    }

    const parent = dirname(plan.target);
    await mkdir(parent, { recursive: true });
    const staging = join(parent, `.${basename(plan.target)}.migrating-${randomUUID()}`);
    const wrote: string[] = [];
    try {
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await writeStoreVersion({ dir: staging });
      wrote.push("remember.json");
      if (plan.memoryText) {
        await writeFile(join(staging, "MEMORY.md"), plan.memoryText, { flag: "wx", mode: 0o600 });
        wrote.push("MEMORY.md");
      }
      for (const note of plan.notes) {
        const path = join(staging, note.rel);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, note.text, { flag: "wx", mode: 0o600 });
        wrote.push(note.rel);
      }
      await rename(staging, plan.target);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      const code = (error as { code?: string }).code;
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        throw new MigrationError(`Target appeared while migrating: ${JSON.stringify(plan.target)}. Nothing was overwritten.`);
      }
      throw error;
    }
    return { ...base, wrote };
  },
};
