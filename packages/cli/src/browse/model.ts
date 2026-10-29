import { join } from "node:path";
import type { Scope } from "@seangle/remember-core";
import type { ScopeFilter } from "../args.ts";

export interface ExplorerItem {
  /** Stable identity across reloads: scope + kind + id/rel. */
  key: string;
  kind: "fact" | "note";
  scope: Scope;
  id: string | null;
  title: string;
  subtitle: string;
  /** Store-relative note path; null for facts. */
  rel: string | null;
  /** Markdown body for notes; empty for facts. */
  body: string;
  meta: string | null;
  path: string;
  created: string | null;
  modified: string | null;
  storeLabel: string;
  haystack: string;
}

export interface ExplorerData {
  workspace: string;
  dirName: string;
  items: ExplorerItem[];
  /** Scopes that actually have a store, in display order. */
  scopes: Scope[];
  warnings: string[];
}

export interface ListingLike {
  workspace: string;
  scopes: Scope[];
  facts: { scope: Scope; id: string | null; created: string | null; line: string; storeLabel: string }[];
  notes: {
    scope: Scope; id: string; rel: string; path: string; description: string;
    created: string; modified: string; storeLabel: string;
  }[];
  stores: { scope: Scope; label: string; dir: string; exists: boolean }[];
  warnings: string[];
}

export function noteKey(scope: Scope, rel: string): string {
  return `${scope}:note:${rel}`;
}

export function factKey(scope: Scope, index: number): string {
  return `${scope}:fact:${index}`;
}

/** Facts first per scope, then notes; scope order is preserved. */
export function createExplorerData(
  listing: ListingLike,
  bodies: Map<string, string>,
  dirName = "",
): ExplorerData {
  const items: ExplorerItem[] = [];
  const memoryFiles = new Map(listing.stores.map((store) => [store.scope, join(store.dir, "MEMORY.md")]));
  for (const scope of listing.scopes) {
    listing.facts.filter((fact) => fact.scope === scope).forEach((fact, index) => {
      const subtitle = `${fact.storeLabel} · fact${fact.created ? ` · ${fact.created}` : ""}`;
      items.push({
        key: factKey(scope, index), kind: "fact", scope, id: fact.id,
        title: fact.line, subtitle, rel: null, body: "", meta: fact.created,
        path: memoryFiles.get(scope) ?? "", created: fact.created, modified: null, storeLabel: fact.storeLabel,
        haystack: [fact.line, fact.id ?? "", fact.created ?? ""].join("\n").toLowerCase(),
      });
    });
    for (const note of listing.notes.filter((entry) => entry.scope === scope)) {
      const body = bodies.get(`${note.scope}:${note.rel}`) ?? "";
      items.push({
        key: noteKey(scope, note.rel), kind: "note", scope, id: note.id,
        title: note.description, subtitle: `${note.storeLabel} · ${note.rel}`, rel: note.rel,
        body, meta: null, path: note.path, created: note.created, modified: note.modified,
        storeLabel: note.storeLabel,
        haystack: [note.description, note.rel, note.id, body].join("\n").toLowerCase(),
      });
    }
  }
  const scopes = [...new Set(listing.scopes)];
  return { workspace: listing.workspace, dirName, items, scopes, warnings: listing.warnings };
}

export interface ExplorerState {
  data: ExplorerData;
  /** Available filter positions, in cycle order. */
  filters: ScopeFilter[];
  filterIndex: number;
  query: string;
  selected: number;
}

function availableFilters(data: ExplorerData): ScopeFilter[] {
  const filters: ScopeFilter[] = [];
  if (data.scopes.length > 1) filters.push("both");
  for (const scope of data.scopes) filters.push(scope);
  return filters.length > 0 ? filters : ["local"];
}

export function currentFilter(state: ExplorerState): ScopeFilter {
  return state.filters[state.filterIndex] ?? state.filters[0];
}

export function createExplorerState(data: ExplorerData, preferred: ScopeFilter = "both"): ExplorerState {
  const filters = availableFilters(data);
  const index = filters.indexOf(preferred);
  const state: ExplorerState = {
    data, filters, filterIndex: index === -1 ? 0 : index, query: "", selected: 0,
  };
  return state;
}

/** Every whitespace-separated token must appear (case-insensitive substring). */
export function matches(item: ExplorerItem, query: string, filter: ScopeFilter): boolean {
  if (filter !== "both" && item.scope !== filter) return false;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((token) => item.haystack.includes(token));
}

export function visibleItems(state: ExplorerState): ExplorerItem[] {
  const filter = currentFilter(state);
  return state.data.items.filter((item) => matches(item, state.query, filter));
}

export function setQuery(state: ExplorerState, query: string): ExplorerState {
  const selected = Math.min(state.selected, Math.max(0, visibleItems({ ...state, query }).length - 1));
  return { ...state, query, selected };
}

export function cycleScope(state: ExplorerState): ExplorerState {
  const filterIndex = (state.filterIndex + 1) % state.filters.length;
  const next = { ...state, filterIndex };
  return { ...next, selected: Math.min(state.selected, Math.max(0, visibleItems(next).length - 1)) };
}

export function move(state: ExplorerState, delta: number): ExplorerState {
  const count = visibleItems(state).length;
  if (count === 0) return state;
  const selected = Math.max(0, Math.min(count - 1, state.selected + delta));
  return selected === state.selected ? state : { ...state, selected };
}

export function moveTo(state: ExplorerState, index: number): ExplorerState {
  const count = visibleItems(state).length;
  if (count === 0) return state;
  return { ...state, selected: Math.max(0, Math.min(count - 1, index)) };
}

export function selectedItem(state: ExplorerState): ExplorerItem | null {
  return visibleItems(state)[state.selected] ?? null;
}
