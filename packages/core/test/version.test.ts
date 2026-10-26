import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStores } from "../src/store.ts";
import {
  assertCurrentStoreVersion,
  ensureStoreVersion,
  readStoreVersion,
  StoreMigrationError,
  StoreMigrationRequiredError,
  VERSION_FILE,
} from "../src/migration.ts";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "remember-version-"));
}

function local(root: string) {
  return resolveStores(root, join(root, "global"), ".agents").local;
}

test("a missing store is not created by version checks", async () => {
  const root = await workspace();
  const store = local(root);
  assert.equal(await readStoreVersion(store), null);
  await ensureStoreVersion(store);
  await assertCurrentStoreVersion(store);
  await assert.rejects(readFile(join(store.dir, VERSION_FILE), "utf8"));
});

test("a mutation may create the store and its marker together", async () => {
  const root = await workspace();
  const store = local(root);
  await ensureStoreVersion(store, { create: true });
  assert.equal(await readStoreVersion(store), 1);
});

test("an empty store receives the current marker", async () => {
  const root = await workspace();
  const store = local(root);
  await mkdir(store.dir, { recursive: true });
  await ensureStoreVersion(store);
  assert.equal(await readStoreVersion(store), 1);
  assert.deepEqual(JSON.parse(await readFile(join(store.dir, VERSION_FILE), "utf8")), { version: 1 });
});

test("content without a marker requires an explicit migration", async () => {
  const root = await workspace();
  const store = local(root);
  await mkdir(store.dir, { recursive: true });
  await writeFile(store.memoryFile, "<!-- 2026-10-18T16:10:33Z [a1b2c3d4] -->\nFact.\n");
  await assert.rejects(ensureStoreVersion(store), StoreMigrationRequiredError);
  await assert.rejects(assertCurrentStoreVersion(store), StoreMigrationRequiredError);
  await assert.rejects(readFile(join(store.dir, VERSION_FILE), "utf8"));
});

test("notes alone also count as content", async () => {
  const root = await workspace();
  const store = local(root);
  await mkdir(join(store.notesDir, "nested"), { recursive: true });
  await writeFile(join(store.notesDir, "nested", "2026-10-18-a.md"), "---\ndescription: \"A\"\nmemory-id: \"a1b2c3d4\"\ncreated-date: \"2026-10-18T16:10:33.000Z\"\nlast-modified-date: \"2026-10-18T16:10:33.000Z\"\n---\nbody\n");
  await assert.rejects(ensureStoreVersion(store), StoreMigrationRequiredError);
});

test("a current marker makes every check a no-op", async () => {
  const root = await workspace();
  const store = local(root);
  await mkdir(store.dir, { recursive: true });
  await writeFile(join(store.dir, VERSION_FILE), '{"version":1}\n');
  await writeFile(store.memoryFile, "fact\n");
  await ensureStoreVersion(store);
  await assertCurrentStoreVersion(store);
  assert.equal(await readStoreVersion(store), 1);
});

test("a future version is refused, never downgraded", async () => {
  const root = await workspace();
  const store = local(root);
  await mkdir(store.dir, { recursive: true });
  await writeFile(join(store.dir, VERSION_FILE), '{"version":2}\n');
  await assert.rejects(ensureStoreVersion(store), StoreMigrationError);
  await assert.rejects(assertCurrentStoreVersion(store), StoreMigrationError);
});

test("a malformed marker is refused", async () => {
  const root = await workspace();
  const store = local(root);
  await mkdir(store.dir, { recursive: true });
  await writeFile(join(store.dir, VERSION_FILE), "not json\n");
  await assert.rejects(readStoreVersion(store), StoreMigrationError);
});
