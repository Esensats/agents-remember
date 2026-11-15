import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { discoverNestedStores, formatNestedStores, invalidateNestedScan } from "../src/discover.ts";

async function root(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-remember-discover-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Create `<workspace>/.agents/memory/MEMORY.md` with `facts` fact lines. */
async function bank(workspace: string, facts: string[] = [], notes: string[] = []): Promise<void> {
  const memory = join(workspace, ".agents", "memory");
  await mkdir(memory, { recursive: true });
  await writeFile(join(memory, "MEMORY.md"), facts.map((fact) => `${fact}\n`).join(""));
  await writeFile(join(memory, "remember.json"), JSON.stringify({ version: 1 }) + "\n");
  if (notes.length > 0) {
    await mkdir(join(memory, "notes"), { recursive: true });
    for (const note of notes) await writeFile(join(memory, "notes", note), "# note\n");
  }
}

const scan = (at: string, options: { cacheTtlMs?: number; now?: () => number } = {}) =>
  discoverNestedStores(at, { dirName: ".agents", cacheTtlMs: 0, ...options });

test("discover: finds children and grandchildren with an initialized bank", async (t) => {
  const at = await root(t);
  await bank(join(at, "one"), ["fact one"]);
  await mkdir(join(at, "repos"), { recursive: true });
  await bank(join(at, "repos", "two"), ["a", "b"], ["2026-11-01-x.md"]);

  const found = await scan(at);
  assert.deepEqual(found.stores.map((store) => store.rel), ["one", "repos/two"]);
  assert.deepEqual(found.stores.map((store) => [store.facts, store.notes]), [[1, 0], [2, 1]]);
  assert.equal(found.truncated, false);
  assert.equal(found.visited, 3);
  assert.equal(found.stores[0].memoryFile, join(at, "one", ".agents", "memory", "MEMORY.md"));
});

test("discover: the session's own bank is not a result", async (t) => {
  const at = await root(t);
  await bank(at, ["own fact"]);
  await bank(join(at, "child"), ["child fact"]);
  const found = await scan(at);
  assert.deepEqual(found.stores.map((store) => store.rel), ["child"]);
});

test("discover: depth 1 does not see a grandchild, depth 2 does", async (t) => {
  const at = await root(t);
  await mkdir(join(at, "repos", "deep"), { recursive: true });
  await bank(join(at, "repos", "deep"));
  assert.deepEqual((await discoverNestedStores(at, { dirName: ".agents", depth: 1, cacheTtlMs: 0 })).stores, []);
  assert.deepEqual((await discoverNestedStores(at, { dirName: ".agents", depth: 2, cacheTtlMs: 0 }))
    .stores.map((store) => store.rel), ["repos/deep"]);
});

test("discover: a bank is a leaf, so its own sub-banks are not separate results", async (t) => {
  const at = await root(t);
  await bank(join(at, "outer"));
  await bank(join(at, "outer", "inner"));
  assert.deepEqual((await scan(at)).stores.map((store) => store.rel), ["outer"]);
});

test("discover: skip list, dot directories, and a custom skip name", async (t) => {
  const at = await root(t);
  for (const name of ["node_modules", "dist", "vendor", ".hidden", "scratch"]) {
    await bank(join(at, name), ["hidden fact"]);
  }
  const found = await discoverNestedStores(at, { dirName: ".agents", skip: ["scratch"], cacheTtlMs: 0 });
  assert.deepEqual(found.stores, []);
});

test("discover: a directory with content but no MEMORY.md is not a bank", async (t) => {
  const at = await root(t);
  await mkdir(join(at, "marked", ".agents", "memory"), { recursive: true });
  await writeFile(join(at, "marked", ".agents", "memory", "remember.json"), "{\"version\":1}\n");
  assert.deepEqual((await scan(at)).stores, []);
});

test("discover: symlinked directories are neither followed nor probed", async (t) => {
  const at = await root(t);
  const outside = await root(t);
  await bank(outside);
  await symlink(outside, join(at, "link"));
  await symlink(join(at, "loop"), join(at, "loop")).catch(() => undefined);
  const found = await scan(at);
  assert.deepEqual(found.stores, []);
});

test("discover: deterministic order and byte-stable multiset across calls", async (t) => {
  const at = await root(t);
  for (const name of ["zulu", "alpha", "mike"]) await bank(join(at, name));
  const first = await scan(at);
  const second = await scan(at);
  assert.deepEqual(first.stores.map((store) => store.rel), ["alpha", "mike", "zulu"]);
  assert.deepEqual(second.stores, first.stores);
  assert.equal(second.visited, first.visited);
  assert.equal(second.truncated, first.truncated);
});

test("discover: maxStores and maxDirectories bound the walk and report truncation", async (t) => {
  const at = await root(t);
  for (const name of ["a", "b", "c"]) await bank(join(at, name));
  const limited = await discoverNestedStores(at, { dirName: ".agents", maxStores: 2, cacheTtlMs: 0 });
  assert.equal(limited.stores.length, 2);
  assert.equal(limited.truncated, true);

  const narrow = await discoverNestedStores(at, { dirName: ".agents", maxDirectories: 1, cacheTtlMs: 0 });
  assert.equal(narrow.visited, 1);
  assert.equal(narrow.truncated, true);
});

test("discover: a reached time budget returns a partial scan, not an error", async (t) => {
  const at = await root(t);
  for (const name of ["a", "b", "c"]) await bank(join(at, name));
  let clock = 0;
  const limited = await discoverNestedStores(at, {
    dirName: ".agents", budgetMs: 1, now: () => (clock += 10), cacheTtlMs: 0,
  });
  assert.equal(limited.truncated, true);
  assert.ok(limited.visited <= 3);
});

test("discover: an aborted signal stops the walk without throwing", async (t) => {
  const at = await root(t);
  for (const name of ["a", "b"]) await bank(join(at, name));
  const controller = new AbortController();
  controller.abort();
  const found = await discoverNestedStores(at, { dirName: ".agents", signal: controller.signal, cacheTtlMs: 0 });
  assert.deepEqual(found.stores, []);
});

test("discover: a root that is missing or is a file gives an empty scan", async (t) => {
  const at = await root(t);
  assert.deepEqual((await scan(join(at, "missing"))).stores, []);
  await writeFile(join(at, "file"), "not a directory\n");
  assert.deepEqual((await scan(join(at, "file"))).stores, []);
});

test("discover: a large MEMORY.md is read up to the byte cap only", async (t) => {
  const at = await root(t);
  await bank(join(at, "big"), Array.from({ length: 5000 }, (_, index) => `fact ${index}`));
  const capped = await discoverNestedStores(at, { dirName: ".agents", maxMemoryBytes: 200, cacheTtlMs: 0 });
  assert.equal(capped.stores.length, 1);
  assert.ok(capped.stores[0].facts < 5000);
  const full = await discoverNestedStores(at, { dirName: ".agents", maxMemoryBytes: 1024 * 1024, cacheTtlMs: 0 });
  assert.equal(full.stores[0].facts, 5000);
});

test("discover: the cache serves the same result inside the TTL and rescans after it", async (t) => {
  const at = await root(t);
  await bank(join(at, "first"));
  let clock = 1_000;
  const options = { dirName: ".agents", cacheTtlMs: 30_000, now: () => clock };
  const before = await discoverNestedStores(at, options);
  assert.deepEqual(before.stores.map((store) => store.rel), ["first"]);

  await bank(join(at, "second"));
  clock += 10_000;
  const cached = await discoverNestedStores(at, options);
  assert.equal(cached, before, "one walk is shared inside the TTL");

  clock += 30_000;
  const rescanned = await discoverNestedStores(at, options);
  assert.deepEqual(rescanned.stores.map((store) => store.rel), ["first", "second"]);

  invalidateNestedScan(at);
  clock += 1;
  const afterInvalidation = await discoverNestedStores(at, options);
  assert.notEqual(afterInvalidation, rescanned);
});

test("discover: concurrent callers share one walk", async (t) => {
  const at = await root(t);
  await bank(join(at, "one"));
  const options = { dirName: ".agents", cacheTtlMs: 30_000 };
  const [a, b] = await Promise.all([
    discoverNestedStores(at, options),
    discoverNestedStores(at, options),
  ]);
  assert.equal(a, b);
});

test("discover: reading never creates a file", async (t) => {
  const at = await root(t);
  await bank(join(at, "one"));
  const before = await readdir(at, { recursive: true });
  await scan(at);
  assert.deepEqual(await readdir(at, { recursive: true }), before);
});

test("format: empty scan renders nothing", () => {
  assert.equal(formatNestedStores({ stores: [], visited: 3, truncated: false, ms: 1 }, { maxChars: 600 }), "");
});

test("format: one line per bank under a header that says when to read one", () => {
  const text = formatNestedStores({
    stores: [
      { root: "/w/repos/a", rel: "repos/a", memoryFile: "/w/repos/a/.agents/memory/MEMORY.md", facts: 52, notes: 23, bytes: 6825 },
      { root: "/w/repos/b", rel: "repos/b", memoryFile: "/w/repos/b/.agents/memory/MEMORY.md", facts: 1, notes: 0, bytes: 30 },
    ],
    visited: 18,
    truncated: false,
    ms: 3,
  }, { maxChars: 600 });
  assert.match(text, /^## Nested workspace memory/);
  // The header is an instruction, not a syntax note: it names the trigger and
  // the exact call. Every adapter registers the same tool names, so one example
  // serves all hosts.
  assert.match(text, /read its bank with memory_read\(\{root: "<path>"\}\)/);
  assert.match(text, /- repos\/a — 52 facts, 23 notes/);
  assert.match(text, /- repos\/b — 1 fact, 0 notes/);
  assert.doesNotMatch(text, /ms/);
});

test("format: whole lines only, and the omitted count is reported", () => {
  const stores = Array.from({ length: 8 }, (_, index) => ({
    root: `/w/repos/repository-${index}`,
    rel: `repos/repository-${index}`,
    memoryFile: `/w/repos/repository-${index}/.agents/memory/MEMORY.md`,
    facts: 3,
    notes: 1,
    bytes: 100,
  }));
  // The header is an instruction now, so a realistic budget is larger; what the
  // test guards is that a path is never cut in half and the rest is counted.
  const text = formatNestedStores({ stores, visited: 20, truncated: false, ms: 4 }, { maxChars: 420 });
  assert.ok(text.length <= 420);
  for (const line of text.split("\n").slice(2)) {
    assert.match(line, /^- /, "no line is cut in half");
  }
  assert.match(text, /\+[1-9]\d* more \(memory_status\)$/);
});

test("format: truncation is named, and an unusable budget renders nothing", () => {
  const stores = [{
    root: "/w/a", rel: "a", memoryFile: "/w/a/.agents/memory/MEMORY.md", facts: 2, notes: 0, bytes: 40,
  }];
  const text = formatNestedStores({ stores, visited: 5, truncated: true, ms: 50 }, { maxChars: 600 });
  assert.match(text, /\[scan incomplete\]/);
  assert.equal(formatNestedStores({ stores, visited: 5, truncated: false, ms: 1 }, { maxChars: 10 }), "");
});

test("format: maxStores limits the listed lines", () => {
  const stores = ["a", "b", "c"].map((rel) => ({
    root: `/w/${rel}`, rel, memoryFile: `/w/${rel}/.agents/memory/MEMORY.md`, facts: 1, notes: 0, bytes: 10,
  }));
  const text = formatNestedStores({ stores, visited: 3, truncated: false, ms: 1 }, { maxChars: 600, maxStores: 2 });
  assert.equal(text.split("\n").filter((line) => line.startsWith("- ")).length, 2);
});
