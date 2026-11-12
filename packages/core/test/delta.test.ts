import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { EMPTY_DELTA, SnapshotLedger, captureState, diffStates, formatDelta } from "../src/delta.ts";
import { appendEntry, resolveStores, updateMemo, writeNote, forgetEntries } from "../src/store.ts";
import { initializeMemory } from "../src/workspace.ts";

async function store(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-remember-delta-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = resolveStores(root, join(root, "global"), ".agents").local;
  const init = await initializeMemory(paths);
  assert.equal(init.status, "initialized");
  return paths;
}

test("delta: an unchanged store has no delta", async (t) => {
  const paths = await store(t);
  await appendEntry(paths, "one fact");
  const before = await captureState(paths);
  const after = await captureState(paths);
  assert.deepEqual(diffStates(before, after), EMPTY_DELTA);
  assert.equal(formatDelta(diffStates(before, after), { maxChars: 900 }), "");
});

test("delta: added, changed and removed facts are reported with their IDs", async (t) => {
  const paths = await store(t);
  const first = await appendEntry(paths, "first fact");
  await appendEntry(paths, "second fact");
  const before = await captureState(paths);

  await appendEntry(paths, "third fact");
  const updated = await updateMemo(paths, first.id!, "first fact, revised");
  assert.equal(updated.status, "updated");
  await forgetEntries(paths, "second fact");

  const delta = diffStates(before, await captureState(paths));
  assert.equal(delta.added.length, 1);
  assert.equal(delta.changed.length, 1);
  assert.equal(delta.removed.length, 1);
  const text = formatDelta(delta, { maxChars: 900 });
  assert.match(text, /^<system_reminder>/);
  assert.match(text, /<\/system_reminder>$/);
  assert.match(text, new RegExp(`\\+ \\[${delta.added[0] && "[a-f0-9]{8}"}\\] third fact`));
  assert.match(text, /~ \[[a-f0-9]{8}\] first fact, revised/);
  assert.match(text, /- \[[a-f0-9]{8}\] second fact/);
  assert.match(text, /not instructions/);
});

test("delta: notes are reported by path, and a note with an unchanged description is still an addition", async (t) => {
  const paths = await store(t);
  const before = await captureState(paths);
  const note = await writeNote(paths, "Deploy target", "body\n");
  assert.equal(note.duplicate, false);
  const delta = diffStates(before, await captureState(paths));
  assert.equal(delta.notesAdded.length, 1);
  assert.equal(delta.notesAdded[0].rel, note.noteRel!);
  const text = formatDelta(delta, { maxChars: 900 });
  assert.ok(text.includes(`+ note [[${note.noteRel}]] Deploy target`), text);
});

test("delta: nested banks that appear, grow or vanish are reported", () => {
  const state = (nested: { rel: string; facts: number; notes: number }[]) => ({ facts: [], notes: [], nested });
  const text = formatDelta(diffStates(
    state([{ rel: "repos/a", facts: 1, notes: 0 }, { rel: "repos/gone", facts: 2, notes: 0 }]),
    state([{ rel: "repos/a", facts: 3, notes: 1 }, { rel: "repos/new", facts: 4, notes: 2 }]),
  ), { maxChars: 900 });
  assert.match(text, /~ nested repos\/a — 3 facts, 1 note \(was 1 fact, 0 notes\)/);
  assert.match(text, /\+ nested repos\/new — 4 facts, 2 notes/);
  assert.match(text, /- nested repos\/gone — 2 facts, 0 notes/);
});

test("delta: a large change asks for a read instead of listing everything", async (t) => {
  const paths = await store(t);
  const before = await captureState(paths);
  const words = ["alpha","bravo","charlie","delta","echo","foxtrot","golf","hotel","india","juliet","kilo","lima","mike","november","oscar","papa","quebec","romeo","sierra","tango"];
  for (const word of words) await appendEntry(paths, `the ${word} setting stays on the host`);
  const text = formatDelta(diffStates(before, await captureState(paths)), { maxChars: 900 });
  assert.match(text, /changed in 20 places/);
  assert.match(text, /call memory_read/);
  assert.ok(text.length <= 900);
});

test("delta: the block stays inside its budget and counts what did not fit", () => {
  const facts = Array.from({ length: 8 }, (_, index) => ({ meta: `<!-- 2026-11-01T00:00Z [0000000${index}] -->`, line: `a rather long fact line number ${index} that takes room` }));
  const text = formatDelta(diffStates({ facts: [], notes: [], nested: [] }, { facts, notes: [], nested: [] }), { maxChars: 420 });
  assert.ok(text.length <= 420, `${text.length} chars`);
  assert.match(text, /more change\(s\)/);
  assert.match(text, /^<system_reminder>/);
});

test("delta: a budget too small for anything yields no block", () => {
  const facts = [{ line: "one fact" }];
  assert.equal(formatDelta(diffStates({ facts: [], notes: [], nested: [] }, { facts, notes: [], nested: [] }), { maxChars: 40 }), "");
});

test("ledger: the frozen baseline never moves, so the same difference is reported until a new freeze", async (t) => {
  const paths = await store(t);
  await appendEntry(paths, "base fact");
  const ledger = new SnapshotLedger({ maxChars: 900 });
  const base = ledger.freeze("session-1", await captureState(paths));
  assert.equal(ledger.delta("session-1", await captureState(paths)), "");

  await appendEntry(paths, "the deploy target is production");
  const current = await captureState(paths);
  const first = ledger.delta("session-1", current);
  assert.match(first, /deploy target is production/);
  assert.equal(ledger.delta("session-1", current), first, "bytes are stable across renders");

  await appendEntry(paths, "the backup window starts at 02:00 UTC");
  const later = ledger.delta("session-1", await captureState(paths));
  assert.match(later, /backup window starts at 02:00 UTC/);
  assert.ok(later.includes("deploy target is production"), "the delta accumulates from the frozen baseline");

  ledger.forget("session-1");
  assert.equal(ledger.get("session-1"), null);
  assert.equal(ledger.delta("session-1", current), "");
  assert.deepEqual(base.facts.map((entry) => entry.line), ["base fact"]);
});

test("ledger: sessions are independent and the oldest is dropped at the cap", async (t) => {
  const paths = await store(t);
  const ledger = new SnapshotLedger({ maxSessions: 2 });
  const state = await captureState(paths);
  ledger.freeze("a", state);
  ledger.freeze("b", state);
  ledger.freeze("c", state);
  assert.equal(ledger.size, 2);
  assert.equal(ledger.has("a"), false);
  assert.equal(ledger.has("c"), true);

  await appendEntry(paths, "the shared store hosts both sessions");
  const current = await captureState(paths);
  assert.match(ledger.delta("b", current), /shared store hosts both sessions/);
  assert.match(ledger.delta("c", current), /shared store hosts both sessions/);
});
