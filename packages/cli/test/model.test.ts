import assert from "node:assert/strict";
import { test } from "node:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  CliError, createContext, globalCandidates, loadBodies, loadListing, readItem, readRecovery,
  runSearch, scopesFor, snapshotFor, summarize,
} from "../src/model.ts";
import { FACT_ONE, NOTE_ID, NOTE_REL, makeFixture, writeStore } from "./fixtures.ts";

test("single discovered global store is selected", async () => {
  const fixture = await makeFixture();
  const ctx = createContext(fixture.root, { dirName: ".agents" }, fixture.env, fixture.home);
  assert.equal(ctx.globalLabel, "pi");
  assert.equal(ctx.global?.dir, fixture.global);
  assert.equal(ctx.ambiguousGlobal, false);
  assert.deepEqual(scopesFor(ctx, "both"), ["local", "global"]);
});

test("several global stores are ambiguous until --global-dir picks one", async () => {
  const fixture = await makeFixture();
  await writeStore(join(fixture.home, ".agents", "memory"), { notes: [] });
  const ctx = createContext(fixture.root, { dirName: ".agents" }, fixture.env, fixture.home);
  assert.equal(ctx.ambiguousGlobal, true);
  assert.equal(ctx.global, null);
  assert.deepEqual(scopesFor(ctx, "both"), ["local"]);
  assert.throws(() => scopesFor(ctx, "global"), /--global-dir/);

  const explicit = createContext(
    fixture.root,
    { dirName: ".agents", globalDir: join(fixture.home, ".pi", "agent", "memory") },
    fixture.env, fixture.home,
  );
  assert.equal(explicit.globalLabel, "global");
  assert.equal(explicit.ambiguousGlobal, false);
  assert.equal(explicit.global?.dir, join(fixture.home, ".pi", "agent", "memory"));
});

test("a global candidate equal to the workspace store is not counted twice", async () => {
  const fixture = await makeFixture();
  // Root == home: ~/.agents/memory is the local store and also a candidate.
  await writeStore(join(fixture.home, ".agents", "memory"), {
    index: "<!-- 2026-10-20T17:06:03Z [aaaa1111] -->\nHome fact.\n", notes: [],
  });
  const ctx = createContext(fixture.home, { dirName: ".agents" }, fixture.env, fixture.home);
  assert.ok(!ctx.candidates.some((candidate) => candidate.dir === ctx.local.dir));
  assert.equal(ctx.local.dir, join(fixture.home, ".agents", "memory"));
  assert.equal(ctx.globalLabel, "pi");
  const summary = await summarize(ctx, false);
  assert.equal(summary.local.facts, 1);
});

test("an explicit global store may not alias the workspace store", async () => {
  const fixture = await makeFixture();
  assert.throws(
    () => createContext(fixture.root, { dirName: ".agents", globalDir: fixture.local }, fixture.env, fixture.home),
    /must differ from the workspace store/,
  );
});

test("listing separates facts, notes and dangling references", async () => {
  const fixture = await makeFixture();
  const ctx = createContext(fixture.root, { dirName: ".agents" }, fixture.env, fixture.home);
  const listing = await loadListing(ctx, "local");
  assert.deepEqual(listing.facts.map((fact) => fact.id), ["4f4cadfe", "d786d59b"]);
  assert.equal(listing.facts[0].line, FACT_ONE);
  assert.equal(listing.notes.length, 1);
  assert.equal(listing.notes[0].id, NOTE_ID);
  assert.equal(listing.notes[0].rel, NOTE_REL);
  assert.deepEqual(listing.missing.map((item) => item.ref), ["notes/missing-note.md"]);
  assert.deepEqual(listing.missing[0].id, "deadbeef");
  assert.equal(listing.warnings.length, 0);
});

test("bodies are read only on request", async () => {
  const fixture = await makeFixture();
  const ctx = createContext(fixture.root, { dirName: ".agents" }, fixture.env, fixture.home);
  const listing = await loadListing(ctx, "local");
  const bodies = await loadBodies(listing);
  assert.match(bodies.get(`local:${NOTE_REL}`) ?? "", /## Layout/);
});

test("a store with content but no marker is reported, not listed", async () => {
  const fixture = await makeFixture();
  await rm(join(fixture.local, "remember.json"));
  await writeStore(fixture.local, { marker: false, notes: ["explorer.md"] });
  const ctx = createContext(fixture.root, { dirName: ".agents" }, fixture.env, fixture.home);
  const listing = await loadListing(ctx, "local");
  assert.equal(listing.facts.length, 0);
  assert.ok(listing.warnings.some((warning) => /migration/.test(warning)));
  const summary = await summarize(ctx, false);
  assert.equal(summary.local.needsMigration, true);
});

test("show resolves ids, note paths and reports misses with exit 1", async () => {
  const fixture = await makeFixture();
  const ctx = createContext(fixture.root, { dirName: ".agents" }, fixture.env, fixture.home);

  const note = await readItem(ctx, NOTE_ID, "local");
  assert.equal(note.kind, "note");
  if (note.kind === "note") {
    assert.equal(note.rel, NOTE_REL);
    assert.match(note.body, /long-form knowledge/);
  }

  const fact = await readItem(ctx, "4f4cadfe", "local");
  assert.equal(fact.kind, "fact");
  if (fact.kind === "fact") assert.equal(fact.line, FACT_ONE);

  const byPath = await readItem(ctx, NOTE_REL, "local");
  assert.equal(byPath.kind, "note");
  if (byPath.kind === "note") assert.equal(byPath.id, NOTE_ID);

  await assert.rejects(() => readItem(ctx, "deadbeef", "local"), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 1);
    return true;
  });
});

test("search matches fact text and note bodies", async () => {
  const fixture = await makeFixture();
  const ctx = createContext(fixture.root, { dirName: ".agents" }, fixture.env, fixture.home);
  const result = await runSearch(ctx, "long-form", "local", 10);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].file, NOTE_REL);
  const proxy = await runSearch(ctx, "proxy", "local", 10);
  assert.ok(proxy.hits.some((hit) => hit.id === "4f4cadfe"));
  assert.equal((await runSearch(ctx, "nothing-matches-this", "local", 10)).hits.length, 0);
});

test("snapshot respects scopes, budgets and the optional wrapper", async () => {
  const fixture = await makeFixture();
  const ctx = createContext(fixture.root, { dirName: ".agents" }, fixture.env, fixture.home);

  const both = await snapshotFor(ctx, ctx.global, "pi", false);
  assert.ok(both.chars > 0);
  assert.ok(both.globalChars > 0);
  assert.ok(both.localChars > 0);
  assert.ok(!both.text.includes("<remember>"));
  assert.match(both.text, /## Global memory/);
  assert.match(both.text, /## Project memory \(workspace\)/);

  const wrapped = await snapshotFor(ctx, ctx.global, "pi", true);
  assert.match(wrapped.text, /^<remember>/);

  const localOnly = await snapshotFor(ctx, null, "none", false);
  assert.equal(localOnly.globalChars, 0);
  assert.doesNotMatch(localOnly.text, /## Global memory/);
});

test("summary reports counts and per-candidate snapshots", async () => {
  const fixture = await makeFixture();
  const ctx = createContext(fixture.root, { dirName: ".agents" }, fixture.env, fixture.home);
  const summary = await summarize(ctx, false);
  assert.equal(summary.local.facts, 3);
  assert.equal(summary.local.notes, 1);
  assert.equal(summary.local.recovery, 1);
  assert.equal(summary.candidates.find((candidate) => candidate.label === "pi")?.facts, 1);
  assert.equal(summary.snapshots.length, 1);
  assert.equal(summary.snapshots[0].globalLabel, "pi");
});

test("recovery records are listed with their kind and size", async () => {
  const fixture = await makeFixture();
  const ctx = createContext(fixture.root, { dirName: ".agents" }, fixture.env, fixture.home);
  const result = await readRecovery(ctx, "local");
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, "1a2b3c4d");
  assert.equal(result.records[0].kind, "forget");
  assert.equal(result.records[0].entries, 1);
  assert.equal(result.records[0].error, null);
});

test("candidate discovery is stable and ignores unrelated paths", () => {
  const candidates = globalCandidates({}, "/home/test");
  assert.deepEqual(candidates.map((candidate) => candidate.label), ["pi", "shared", "opencode", "dsh"]);
  const xdg = globalCandidates({ XDG_DATA_HOME: "/data", DSH_HOME: "/dsh" }, "/home/test");
  assert.equal(xdg.find((candidate) => candidate.label === "opencode")?.dir, "/data/opencode/memory");
  assert.equal(xdg.find((candidate) => candidate.label === "dsh")?.dir, "/dsh/memory");
});
