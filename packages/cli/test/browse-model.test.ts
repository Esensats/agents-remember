import assert from "node:assert/strict";
import { test } from "node:test";
import { createExplorerData, createExplorerState, currentFilter, cycleScope, move, moveTo, selectedItem, setQuery, visibleItems } from "../src/browse/model.ts";
import { createContext, loadBodies, loadListing } from "../src/model.ts";
import { NOTE_DESCRIPTION, NOTE_ID, NOTE_REL, makeFixture } from "./fixtures.ts";

async function data() {
  const fixture = await makeFixture();
  const ctx = createContext(fixture.root, { dirName: ".agents" }, fixture.env, fixture.home);
  const listing = await loadListing(ctx, "both");
  return createExplorerData(listing, await loadBodies(listing), ".agents");
}

test("items: facts first per scope, then notes", async () => {
  const explorer = await data();
  assert.deepEqual(explorer.items.map((item) => item.kind), ["fact", "fact", "note", "fact"]);
  assert.deepEqual(explorer.items.map((item) => item.scope), ["local", "local", "local", "global"]);
  assert.equal(explorer.items[2].title, NOTE_DESCRIPTION);
  assert.equal(explorer.items[2].id, NOTE_ID);
  assert.equal(explorer.items[2].rel, NOTE_REL);
  assert.match(explorer.items[2].body, /## Layout/);
  assert.equal(explorer.items[0].rel, null);
  assert.ok(explorer.items[0].haystack.includes("proxy"));
});

test("scope filters cycle over available scopes", async () => {
  const explorer = await data();
  let state = createExplorerState(explorer);
  assert.deepEqual(state.filters, ["both", "local", "global"]);
  assert.equal(currentFilter(state), "both");
  assert.equal(visibleItems(state).length, 4);
  state = cycleScope(state);
  assert.equal(currentFilter(state), "local");
  assert.equal(visibleItems(state).length, 3);
  state = cycleScope(state);
  assert.equal(currentFilter(state), "global");
  assert.equal(visibleItems(state).length, 1);
  state = cycleScope(state);
  assert.equal(currentFilter(state), "both");
});

test("a local-only store has no scope cycle", async () => {
  const explorer = await data();
  const local = { ...explorer, scopes: ["local" as const] };
  const state = createExplorerState(local, "local");
  assert.deepEqual(state.filters, ["local"]);
  assert.equal(currentFilter(cycleScope(state)), "local");
});

test("filter is case-insensitive, multi-token and searches note bodies", async () => {
  const explorer = await data();
  let state = createExplorerState(explorer);
  state = setQuery(state, "PROXY");
  assert.equal(visibleItems(state).length, 1);
  assert.equal(visibleItems(state)[0].id, "4f4cadfe");
  state = setQuery(state, "long-form knowledge");
  assert.equal(visibleItems(state).length, 1);
  assert.equal(visibleItems(state)[0].kind, "note");
  state = setQuery(state, "proxy missing");
  assert.equal(visibleItems(state).length, 0);
});

test("navigation clamps and never loses the selection on filter changes", async () => {
  const explorer = await data();
  let state = createExplorerState(explorer);
  state = move(state, 10);
  assert.equal(state.selected, 3);
  state = move(state, 1);
  assert.equal(state.selected, 3);
  state = move(state, -2);
  assert.equal(state.selected, 1);
  assert.equal(selectedItem(state)?.id, "d786d59b");
  state = moveTo(state, -5);
  assert.equal(state.selected, 0);
  state = setQuery(state, "zzz");
  assert.equal(state.selected, 0);
  assert.equal(selectedItem(state), null);
});

test("initial scope may be a scope or both", async () => {
  const explorer = await data();
  assert.equal(currentFilter(createExplorerState(explorer, "local")), "local");
  assert.equal(currentFilter(createExplorerState(explorer, "global")), "global");
  assert.equal(currentFilter(createExplorerState(explorer, "both")), "both");
  // An unavailable preference falls back to the first available filter.
  const localOnly = { ...explorer, scopes: ["local" as const] };
  assert.equal(currentFilter(createExplorerState(localOnly, "global")), "local");
});

test("keys stay stable when the same note is reloaded", async () => {
  const explorer = await data();
  const again = await data();
  const first = explorer.items[2].key;
  assert.equal(again.items[2].key, first);
});
