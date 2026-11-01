import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import {
  appendEntry, forgetEntries, readCatalogue, resolveStores, restoreEntry, statMemory, updateMemo,
  type StorePaths,
} from "../src/store.ts";
import { initializeMemory } from "../src/workspace.ts";

type RecoveryKind = "update" | "forget";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "remember-recovery-ignore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stores = resolveStores(root, join(root, "global"), ".agents");
  return { root, stores, store: stores.local };
}

async function createRecovery(store: StorePaths, id: string, kind: RecoveryKind): Promise<string> {
  if (kind === "update") {
    const result = await updateMemo(store, id, "Updated fact");
    assert.equal(result.status, "updated");
    if (result.status === "updated") return result.recoveryId;
  } else {
    const result = await forgetEntries(store, id);
    assert.ok(result.recoveryId);
    return result.recoveryId;
  }
  throw new Error("Expected a recovery record");
}

for (const scope of ["local", "global"] as const) {
  for (const kind of ["update", "forget"] as const) {
    for (const existing of [false, true]) {
      test(`${scope} ${kind} creates a recovery ignore rule in a ${existing ? "preexisting" : "new"} directory`, async t => {
        const { stores } = await fixture(t);
        const store = stores[scope];
        const fact = await appendEntry(store, "Original fact");
        if (existing) {
          await mkdir(store.recoveryDir);
          await writeFile(join(store.recoveryDir, "deadbeef.json"), "Existing opaque history\n");
        }
        const recoveryId = await createRecovery(store, fact.id!, kind);
        const ignoreFile = join(store.recoveryDir, ".gitignore");
        assert.equal(await readFile(ignoreFile, "utf8"), "*\n");
        assert.equal((await statMemory(store)).recoveryCount, existing ? 2 : 1);
        assert.equal((await restoreEntry(stores, recoveryId, undefined, [scope]))?.status, "restored");
        assert.equal(await readFile(ignoreFile, "utf8"), "*\n", "restore leaves the rule in place");
        if (existing) assert.equal(await readFile(join(store.recoveryDir, "deadbeef.json"), "utf8"), "Existing opaque history\n");
      });
    }
  }
}

test("initialization, reads, unchanged updates and unmatched deletions leave recovery lazy", async t => {
  const { stores, store } = await fixture(t);
  assert.equal((await initializeMemory(store)).status, "initialized");
  await readCatalogue(store);
  await statMemory(store);
  assert.equal(await restoreEntry(stores, "deadbeef"), null);
  const fact = await appendEntry(store, "Same fact");
  assert.equal((await updateMemo(store, fact.id!, "Same fact")).status, "unchanged");
  assert.equal((await forgetEntries(store, "No matching fact")).recoveryId, null);
  await assert.rejects(lstat(store.recoveryDir), { code: "ENOENT" });

  await mkdir(store.recoveryDir);
  await readCatalogue(store);
  await statMemory(store);
  assert.equal(await restoreEntry(stores, "deadbeef"), null);
  assert.equal((await updateMemo(store, fact.id!, "Same fact")).status, "unchanged");
  assert.equal((await forgetEntries(store, "No matching fact")).recoveryId, null);
  assert.deepEqual(await readdir(store.recoveryDir), [], "reads/no-ops do not backfill the rule");
});

for (const kind of ["update", "forget"] as const) {
  test(`${kind} preserves existing recovery ignore rules and permissions`, async t => {
    const { store } = await fixture(t);
    const fact = await appendEntry(store, "Original fact");
    await mkdir(store.recoveryDir);
    const ignoreFile = join(store.recoveryDir, ".gitignore");
    const custom = "# Deliberately shared history\r\n*.tmp\r\n";
    await writeFile(ignoreFile, custom);
    await chmod(ignoreFile, 0o400);
    const before = await lstat(ignoreFile);
    await createRecovery(store, fact.id!, kind);
    assert.equal(await readFile(ignoreFile, "utf8"), custom);
    const after = await lstat(ignoreFile);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.mode, before.mode);
  });

  for (const target of ["file symlink", "dangling symlink", "directory"] as const) {
    test(`${kind} refuses a recovery .gitignore ${target} before changing memory`, async t => {
      const { root, store } = await fixture(t);
      const fact = await appendEntry(store, "Original fact");
      const original = await readFile(store.memoryFile);
      await mkdir(store.recoveryDir);
      const ignoreFile = join(store.recoveryDir, ".gitignore");
      const outside = join(root, "outside-ignore");
      if (target === "directory") {
        await mkdir(ignoreFile);
      } else {
        if (target === "file symlink") await writeFile(outside, "External rules stay untouched\n");
        await symlink(outside, ignoreFile);
      }
      await assert.rejects(createRecovery(store, fact.id!, kind), /symlink|regular file/);
      assert.deepEqual(await readFile(store.memoryFile), original);
      assert.deepEqual(await readdir(store.recoveryDir), [".gitignore"]);
      if (target === "file symlink") assert.equal(await readFile(outside, "utf8"), "External rules stay untouched\n");
      if (target === "dangling symlink") await assert.rejects(lstat(outside), { code: "ENOENT" });
    });
  }
}

test("a missing recovery ignore rule is recreated on the next recovery write", async t => {
  const { store } = await fixture(t);
  const fact = await appendEntry(store, "Original fact");
  await createRecovery(store, fact.id!, "update");
  const ignoreFile = join(store.recoveryDir, ".gitignore");
  await rm(ignoreFile);
  await createRecovery(store, fact.id!, "forget");
  assert.equal(await readFile(ignoreFile, "utf8"), "*\n");
});

test("Git ignores recovery records and the ignore file itself, but not the memory index", async t => {
  const { root, store } = await fixture(t);
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.ifError(result.error);
    return result;
  };
  assert.equal(git("init", "--quiet").status, 0);
  const fact = await appendEntry(store, "Original fact");
  const recoveryId = await createRecovery(store, fact.id!, "update");
  for (const file of [".gitignore", `${recoveryId}.json`]) {
    assert.equal(git("check-ignore", "--quiet", "--", relative(root, join(store.recoveryDir, file))).status, 0);
  }
  assert.equal(git("check-ignore", "--quiet", "--", relative(root, store.memoryFile)).status, 1);
});
