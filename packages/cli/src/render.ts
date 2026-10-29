import type { Scope } from "@seangle/remember-core";
import type {
  Listing, RecoveryResult, SearchResult, ShowResult, SnapshotInfo, StoreInfo, StoreSummary,
} from "./model.ts";

const ANSI = {
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  dim: (text: string) => `\x1b[2m${text}\x1b[22m`,
  accent: (text: string) => `\x1b[36m${text}\x1b[39m`,
  warn: (text: string) => `\x1b[33m${text}\x1b[39m`,
  error: (text: string) => `\x1b[31m${text}\x1b[39m`,
  heading: (text: string) => `\x1b[35m${text}\x1b[39m`,
  selected: (text: string) => `\x1b[1;7m${text}\x1b[27;22m`,
};

const PLAIN = {
  bold: (text: string) => text,
  dim: (text: string) => text,
  accent: (text: string) => text,
  warn: (text: string) => text,
  error: (text: string) => text,
  heading: (text: string) => text,
  selected: (text: string) => text,
};

export type Style = typeof PLAIN;

export function createStyle(color: boolean): Style {
  return color ? ANSI : PLAIN;
}

/** Thousands separators without depending on the process locale. */
export function withCommas(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function storeStatus(info: StoreInfo): string {
  if (info.error) return `error: ${info.error}`;
  if (info.needsMigration) return "needs migration (content without remember.json)";
  if (!info.exists) return "no memory yet";
  const version = info.version === null ? "unversioned" : `v${info.version}`;
  return `${countLabel(info.facts, "fact")} · ${countLabel(info.notes, "note")} · ${countLabel(info.recovery, "recovery file")} · ${version}`;
}

export function renderSummary(summary: StoreSummary, style: Style): string {
  const lines: string[] = [];
  lines.push(`${style.bold("remember")} ${style.dim(`· ${summary.workspace} (${summary.dirName})`)}`);
  lines.push("");
  lines.push(`${style.heading("local")}  ${style.dim(summary.local.dir)}`);
  lines.push(`       ${storeStatus(summary.local)}`);

  const candidates = summary.candidates;
  const width = Math.max(0, ...candidates.map((candidate) => candidate.label.length));
  lines.push("");
  lines.push(style.heading("global"));
  if (candidates.length === 0) {
    lines.push(style.dim("  (no global store configured)"));
  } else {
    for (const candidate of candidates) {
      const chosen = candidate.label === summary.globalLabel ? style.accent("*") : " ";
      lines.push(`  ${chosen} ${style.bold(pad(candidate.label, width))}  ${style.dim(candidate.dir)}`);
      lines.push(`    ${" ".repeat(width)}  ${storeStatus(candidate)}`);
    }
  }
  if (summary.ambiguousGlobal) {
    lines.push(style.warn("  several global stores matched; pass --global-dir to pick one"));
  }

  if (summary.snapshots.length > 0) {
    lines.push("");
    for (const snapshot of summary.snapshots) {
      lines.push(snapshotLine(snapshot, style));
    }
  }
  const warnings = summary.warnings.filter((warning) => !warning.includes("several global stores"));
  if (warnings.length > 0) {
    lines.push("");
    for (const warning of warnings) lines.push(style.warn(`! ${warning}`));
  }
  return lines.join("\n");
}

function snapshotLine(snapshot: SnapshotInfo, style: Style): string {
  const sizes = `global ${withCommas(snapshot.globalChars)}/${withCommas(snapshot.globalBudget)}, ` +
    `local ${withCommas(snapshot.localChars)}/${withCommas(snapshot.localBudget)}`;
  const total = snapshot.chars === 0 ? style.dim("empty") : `${withCommas(snapshot.chars)} chars`;
  return `${style.heading("snapshot")} (${snapshot.globalLabel} + local)  ${total} — ${style.dim(sizes)}`;
}

export function renderListing(listing: Listing, style: Style): string {
  const lines: string[] = [];
  lines.push(`${style.bold("workspace")} ${listing.workspace} · scopes ${listing.scopes.join(", ")}`);
  for (const store of listing.stores) {
    lines.push(`  ${style.bold(pad(store.label, 8))} ${store.dir} — ${storeStatus(store)}`);
  }
  for (const warning of listing.warnings) lines.push(style.warn(`! ${warning}`));

  if (listing.facts.length > 0) {
    lines.push("");
    lines.push(style.heading(`facts (${listing.facts.length})`));
    for (const fact of listing.facts) {
      const id = fact.id ?? "—";
      const created = fact.created ?? "";
      lines.push(`  ${style.accent(pad(id, 8))} ${style.dim(pad(created, 20))} ${fact.line}`);
    }
  }
  if (listing.notes.length > 0) {
    lines.push("");
    lines.push(style.heading(`notes (${listing.notes.length})`));
    for (const note of listing.notes) {
      lines.push(`  ${style.accent(pad(note.id, 8))} ${style.dim(pad(note.created, 20))} ${note.description}`);
      lines.push(`  ${" ".repeat(8)} ${style.dim(pad(note.modified, 20))} ${style.dim(note.rel)}`);
    }
  }
  if (listing.missing.length > 0) {
    lines.push("");
    lines.push(style.heading(`missing notes (${listing.missing.length})`));
    for (const item of listing.missing) {
      lines.push(`  ${style.warn(pad(item.id ?? "—", 8))} ${item.scope} ${item.ref}`);
    }
  }
  if (listing.facts.length === 0 && listing.notes.length === 0 && listing.missing.length === 0) {
    lines.push("");
    lines.push(style.dim("no facts or notes in the selected scopes"));
  }
  return lines.join("\n");
}

export function renderShow(result: ShowResult, style: Style): string {
  const lines: string[] = [];
  if (result.kind === "note") {
    lines.push(`${style.heading("note")} ${style.accent(result.id)} ${style.dim(`[${result.storeLabel}]`)}`);
    lines.push(style.bold(result.description));
    lines.push(style.dim(result.rel));
    lines.push(style.dim(`created ${result.created} · modified ${result.modified}`));
    lines.push("");
    lines.push(result.body.trim());
  } else {
    lines.push(`${style.heading("fact")} ${style.accent(result.id ?? "—")} ${style.dim(`[${result.storeLabel}]`)}`);
    lines.push(result.line);
    lines.push(style.dim(`${result.created ?? "unknown"} · ${result.storePath}`));
    if (result.meta) lines.push(style.dim(result.meta));
  }
  return lines.join("\n");
}

export function renderSearch(result: SearchResult, style: Style): string {
  const scopes = result.scopes.join(", ");
  if (result.hits.length === 0) {
    return `${style.dim("no hits")} for ${JSON.stringify(result.query)} (${scopes})`;
  }
  const width = Math.max(...result.hits.map((hit) => hit.file.length));
  const lines = [`${style.heading(`${result.hits.length} hit${result.hits.length === 1 ? "" : "s"}`)} for ${JSON.stringify(result.query)} (${scopes})`];
  for (const hit of result.hits) {
    const score = hit.score.toFixed(1);
    const id = hit.id ?? "—";
    lines.push(`  ${style.bold(pad(hit.scope, 6))} ${style.dim(pad(hit.file, width))}  ${style.accent(pad(score, 5))}  ${id}  ${hit.line}`);
  }
  return lines.join("\n");
}

export function renderRecovery(result: RecoveryResult, style: Style): string {
  if (result.records.length === 0) {
    return [style.dim("no recovery records"), ...result.warnings.map((warning) => style.warn(`! ${warning}`))].join("\n");
  }
  const lines = [style.heading(`recovery (${result.records.length})`)];
  for (const record of result.records) {
    if (record.error) {
      lines.push(`  ${style.error(record.id)}  ${record.scope}  unreadable: ${record.error}`);
      continue;
    }
    const detail = record.kind === "update"
      ? `memo ${record.memoId ?? "?"}`
      : `${countLabel(record.entries, "entry", "entries")}, ${countLabel(record.notes, "note")}`;
    lines.push(`  ${style.accent(record.id)}  ${style.bold(pad(record.kind, 6))}  ${style.dim(pad(record.scope, 6))}  ${record.timestamp ?? "unknown"}  ${detail}`);
  }
  for (const warning of result.warnings) lines.push(style.warn(`! ${warning}`));
  return lines.join("\n");
}

export function renderSnapshot(snapshot: SnapshotInfo, style: Style): string {
  if (!snapshot.text) return style.dim("(the injected snapshot is empty)");
  return snapshot.text;
}

// ---------------------------------------------------------------------------
// JSON projections: stable shapes for scripts and tests.
// ---------------------------------------------------------------------------

export interface JsonStore {
  label: string;
  scope: Scope;
  path: string;
  exists: boolean;
  version: number | null;
  needsMigration: boolean;
  facts: number;
  notes: number;
  recovery: number;
  bytes: number;
  error: string | null;
}

function storeJson(store: StoreInfo): JsonStore {
  return {
    label: store.label, scope: store.scope, path: store.dir, exists: store.exists,
    version: store.version, needsMigration: store.needsMigration,
    facts: store.facts, notes: store.notes, recovery: store.recovery, bytes: store.bytes,
    error: store.error,
  };
}

export function summaryJson(summary: StoreSummary): unknown {
  return {
    workspace: summary.workspace,
    dirName: summary.dirName,
    local: storeJson(summary.local),
    globals: summary.candidates.map(storeJson),
    ambiguousGlobal: summary.ambiguousGlobal,
    globalLabel: summary.globalLabel,
    snapshots: summary.snapshots.map((snapshot) => ({
      global: snapshot.globalLabel,
      chars: snapshot.chars,
      globalChars: snapshot.globalChars,
      localChars: snapshot.localChars,
      globalBudget: snapshot.globalBudget,
      localBudget: snapshot.localBudget,
    })),
    warnings: summary.warnings,
  };
}

export function listingJson(listing: Listing): unknown {
  return {
    workspace: listing.workspace,
    scopes: listing.scopes,
    stores: listing.stores.map(storeJson),
    facts: listing.facts.map((fact) => ({
      scope: fact.scope, id: fact.id, created: fact.created, line: fact.line,
    })),
    notes: listing.notes.map((note) => ({
      scope: note.scope, id: note.id, rel: note.rel, path: note.path,
      description: note.description, created: note.created, modified: note.modified,
    })),
    missing: listing.missing,
    warnings: listing.warnings,
  };
}

export function showJson(result: ShowResult): unknown {
  return result;
}

export function searchJson(result: SearchResult): unknown {
  return {
    query: result.query,
    scopes: result.scopes,
    hits: result.hits.map((hit) => ({
      scope: hit.scope, file: hit.file, line: hit.line, meta: hit.meta ?? null,
      id: hit.id ?? null, score: hit.score, matchLines: hit.matchLines,
    })),
  };
}

export function snapshotJson(snapshot: SnapshotInfo): unknown {
  return {
    text: snapshot.text,
    chars: snapshot.chars,
    global: snapshot.globalLabel,
    globalChars: snapshot.globalChars,
    localChars: snapshot.localChars,
    globalBudget: snapshot.globalBudget,
    localBudget: snapshot.localBudget,
    warnings: snapshot.warnings,
  };
}

export function recoveryJson(result: RecoveryResult): unknown {
  return {
    records: result.records.map((record) => ({
      id: record.id, scope: record.scope, kind: record.kind, timestamp: record.timestamp,
      entries: record.entries, notes: record.notes, memoId: record.memoId, error: record.error,
    })),
    warnings: result.warnings,
  };
}
