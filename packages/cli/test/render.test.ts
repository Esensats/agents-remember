import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, loadListing, readItem, readRecovery, runSearch, snapshotFor, summarize } from "../src/model.ts";
import {
  createStyle, listingJson, recoveryJson, renderListing, renderRecovery, renderSearch, renderShow,
  renderSnapshot, renderSummary, searchJson, showJson, snapshotJson, summaryJson, withCommas,
} from "../src/render.ts";
import { FACT_ONE, NOTE_DESCRIPTION, NOTE_ID, makeFixture } from "./fixtures.ts";

const plain = createStyle(false);

test("thousands separators are locale independent", () => {
  assert.equal(withCommas(0), "0");
  assert.equal(withCommas(999), "999");
  assert.equal(withCommas(3000), "3,000");
  assert.equal(withCommas(1234567), "1,234,567");
});

test("summary renders stores, versions and snapshot sizes", async () => {
  const fixture = await makeFixture();
  const ctx = createContext(fixture.root, { dirName: ".agents" }, fixture.env, fixture.home);
  const summary = await summarize(ctx, false);
  const text = renderSummary(summary, plain);
  assert.match(text, /^remember /);
  assert.match(text, /local\s+/);
  assert.match(text, /3 facts · 1 note · 1 recovery file · v1/);
  assert.match(text, /global/);
  assert.match(text, /\bpi\b/);
  assert.match(text, /snapshot \(pi \+ local\)/);
  assert.match(text, /global \d+\/3,000/);
  assert.doesNotMatch(text, /\x1b\[/);
});

test("style adds ANSI only when colour is enabled", async () => {
  const fixture = await makeFixture();
  const ctx = createContext(fixture.root, { dirName: ".agents" }, fixture.env, fixture.home);
  const summary = await summarize(ctx, false);
  assert.match(renderSummary(summary, createStyle(true)), /\x1b\[/);
});

test("listing groups facts, notes and dangling references", async () => {
  const fixture = await makeFixture();
  const ctx = createContext(fixture.root, { dirName: ".agents" }, fixture.env, fixture.home);
  const text = renderListing(await loadListing(ctx, "local"), plain);
  assert.match(text, /facts \(2\)/);
  assert.ok(text.includes(FACT_ONE));
  assert.match(text, /notes \(1\)/);
  assert.ok(text.includes(NOTE_DESCRIPTION));
  assert.match(text, /missing notes \(1\)/);
  assert.match(text, /notes\/missing-note\.md/);
  assert.doesNotMatch(text, /\x1b\[/);
});

test("show renders a note body and a fact line", async () => {
  const fixture = await makeFixture();
  const ctx = createContext(fixture.root, { dirName: ".agents" }, fixture.env, fixture.home);
  const note = renderShow(await readItem(ctx, NOTE_ID, "local"), plain);
  assert.match(note, new RegExp(`^note ${NOTE_ID} \\[local\\]`));
  assert.match(note, /## Layout/);
  const fact = renderShow(await readItem(ctx, "4f4cadfe", "local"), plain);
  assert.match(fact, /^fact 4f4cadfe \[local\]/);
  assert.ok(fact.includes(FACT_ONE));
});

test("search output and empty results", async () => {
  const fixture = await makeFixture();
  const ctx = createContext(fixture.root, { dirName: ".agents" }, fixture.env, fixture.home);
  const hits = renderSearch(await runSearch(ctx, "proxy", "local", 10), plain);
  assert.match(hits, /1 hit for "proxy"/);
  assert.match(hits, /4f4cadfe/);
  const empty = renderSearch(await runSearch(ctx, "zzz-no-such-term", "local", 10), plain);
  assert.match(empty, /^no hits/);
});

test("snapshot prints the block verbatim, recovery lists records", async () => {
  const fixture = await makeFixture();
  const ctx = createContext(fixture.root, { dirName: ".agents" }, fixture.env, fixture.home);
  const snapshot = await snapshotFor(ctx, ctx.global, "pi", false);
  assert.equal(renderSnapshot(snapshot, plain), snapshot.text);
  const recovery = renderRecovery(await readRecovery(ctx, "local"), plain);
  assert.match(recovery, /recovery \(1\)/);
  assert.match(recovery, /1a2b3c4d\s+forget/);
});

test("JSON projections are stable and serializable", async () => {
  const fixture = await makeFixture();
  const ctx = createContext(fixture.root, { dirName: ".agents" }, fixture.env, fixture.home);
  const listing = await loadListing(ctx, "local");
  const summary = summaryJson(await summarize(ctx, false)) as Record<string, unknown>;
  assert.equal(typeof summary.workspace, "string");
  assert.ok(Array.isArray(summary.globals));
  const facts = (listingJson(listing) as { facts: { id: string }[] }).facts;
  assert.deepEqual(facts.map((fact) => fact.id), ["4f4cadfe", "d786d59b"]);
  const show = showJson(await readItem(ctx, NOTE_ID, "local")) as { kind: string; body: string };
  assert.equal(show.kind, "note");
  assert.match(show.body, /Layout/);
  const search = searchJson(await runSearch(ctx, "proxy", "local", 5)) as { hits: { id: string }[] };
  assert.equal(search.hits[0].id, "4f4cadfe");
  const snapshot = snapshotJson(await snapshotFor(ctx, ctx.global, "pi", true)) as { text: string };
  assert.match(snapshot.text, /^<remember>/);
  const recovery = recoveryJson(await readRecovery(ctx, "local")) as { records: { id: string }[] };
  assert.equal(recovery.records[0].id, "1a2b3c4d");
  for (const value of [summary, listingJson(listing), show, search, snapshot, recovery]) {
    assert.doesNotThrow(() => JSON.stringify(value));
  }
});
