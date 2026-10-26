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
