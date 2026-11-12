import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildSnapshot, middleTruncate } from "../src/inject.ts";

test("middleTruncate passes through short text", () => {
  assert.equal(middleTruncate("abc", 10), "abc");
});

test("middleTruncate keeps head and tail, drops middle", () => {
  const text = "a".repeat(1000);
  const out = middleTruncate(text, 100);
  assert.ok(out.length < 200);
  assert.match(out, /truncated 900 chars/);
  assert.ok(out.startsWith("a"));
  assert.ok(out.endsWith("a"));
});

test("buildSnapshot empty when no memory", () => {
  const s = buildSnapshot("", "", "proj", { maxGlobalChars: 3000, maxLocalChars: 3000 });
  assert.equal(s.text, "");
});

test("buildSnapshot includes both scopes and stable bytes", () => {
  const opts = { maxGlobalChars: 3000, maxLocalChars: 3000 };
  const g = "#fact Global line";
  const l = "#fact Local line";
  const a = buildSnapshot(g, l, "proj", opts);
  const b = buildSnapshot(g, l, "proj", opts);
  assert.equal(a.text, b.text); // byte-stable
  assert.match(a.text, /## Global memory/);
  assert.match(a.text, /## Project memory \(proj\)/);
  assert.match(a.text, /#fact Local line/);
});

test("buildSnapshot wrap:false keeps the body without the outer tag", () => {
  const opts = { maxGlobalChars: 3000, maxLocalChars: 3000 };
  const wrapped = buildSnapshot("#fact Global line", "#fact Local line", "proj", opts);
  const bare = buildSnapshot("#fact Global line", "#fact Local line", "proj", { ...opts, wrap: false });
  assert.equal(bare.text, wrapped.text.replace(/^<remember>\n\n/, "").replace(/\n\n<\/remember>$/, ""));
  assert.doesNotMatch(bare.text, /<\/?remember>/);
  assert.match(bare.text, /## Project memory \(proj\)/);
});

test("buildSnapshot wrap:false still reports character counts", () => {
  const bare = buildSnapshot("global facts", "local facts", "proj", {
    maxGlobalChars: 3000, maxLocalChars: 3000, wrap: false,
  });
  assert.equal(bare.globalChars, "global facts".length);
  assert.equal(bare.localChars, "local facts".length);
});

const nestedScan = (stores: { rel: string; facts: number; notes: number }[] = [], truncated = false) => ({
  stores: stores.map((store) => ({
    root: `/w/${store.rel}`,
    memoryFile: `/w/${store.rel}/.agents/memory/MEMORY.md`,
    bytes: 100,
    ...store,
  })),
  visited: 18,
  truncated,
  ms: 3,
});

test("buildSnapshot without nested banks keeps today's bytes exactly", () => {
  const opts = { maxGlobalChars: 3000, maxLocalChars: 3000 };
  const plain = buildSnapshot("global fact", "local fact", "proj", opts);
  assert.equal(buildSnapshot("global fact", "local fact", "proj", opts, nestedScan()).text, plain.text);
  assert.equal(plain.nestedChars, 0);
  assert.doesNotMatch(plain.text, /Nested workspace memory/);
});

test("buildSnapshot appends the nested section last and counts its characters", () => {
  const scan = nestedScan([{ rel: "repos/petri", facts: 2, notes: 0 }]);
  const snapshot = buildSnapshot("#fact Global line", "#fact Local line", "proj", {
    maxGlobalChars: 3000, maxLocalChars: 3000,
  }, scan);
  assert.match(snapshot.text, /## Project memory \(proj\)/);
  assert.match(snapshot.text, /## Nested workspace memory/);
  assert.ok(snapshot.text.indexOf("Nested workspace memory") > snapshot.text.indexOf("Project memory"));
  assert.ok(snapshot.text.endsWith("</remember>"));
  assert.ok(snapshot.nestedChars > 0);
  assert.equal(snapshot.text, buildSnapshot("#fact Global line", "#fact Local line", "proj", {
    maxGlobalChars: 3000, maxLocalChars: 3000,
  }, nestedScan([{ rel: "repos/petri", facts: 2, notes: 0 }])).text, "same scan, same bytes");
});

test("buildSnapshot injects a nested section even when both scopes are empty", () => {
  const snapshot = buildSnapshot("", "", "proj", { maxGlobalChars: 3000, maxLocalChars: 3000 },
    nestedScan([{ rel: "repos/a", facts: 1, notes: 0 }]));
  assert.match(snapshot.text, /- repos\/a — 1 fact, 0 notes/);
  assert.doesNotMatch(snapshot.text, /## Project memory/);
});

test("buildSnapshot honors maxNestedChars and wrap:false", () => {
  const scan = nestedScan(Array.from({ length: 8 }, (_, index) => ({ rel: `repos/repository-${index}`, facts: 2, notes: 1 })));
  const snapshot = buildSnapshot("g", "l", "proj", {
    maxGlobalChars: 3000, maxLocalChars: 3000, maxNestedChars: 300, wrap: false,
  }, scan);
  assert.doesNotMatch(snapshot.text, /<\/?remember>/);
  assert.ok(snapshot.nestedChars <= 300);
  assert.match(snapshot.text, /more \(memory_status\)/);
});
