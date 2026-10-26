import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectMigrations, migrate, piRememberV1 } from "../src/index.ts";

const NOTE = (description: string, id: string) =>
  `---\ndescription: "${description}"\nmemory-id: "${id}"\ncreated-date: "2026-10-18T16:10:33.000Z"\nlast-modified-date: "2026-10-18T16:10:33.000Z"\n---\n## Body\n\nDetails.\n`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "remember-migrate-"));
  const source = join(root, ".pi", "memory");
  const target = join(root, ".agents", "memory");
  await mkdir(join(source, "notes"), { recursive: true });
  await mkdir(join(source, "recovery"), { recursive: true });
  await mkdir(join(source, "migrations", "v0-to-v1-x", "files"), { recursive: true });
  await writeFile(join(source, "pi-remember.json"), '{"version": 1}\n');
  await writeFile(
    join(source, "MEMORY.md"),
    "<!-- 2026-10-18T16:10:33Z [a1b2c3d4] -->\nUse pnpm.\n\n<!-- 2026-10-19T10:00:00Z [b2c3d4e5] -->\n#note [[notes/2026-10-18-old.md]] Legacy reference\n",
  );
  await writeFile(join(source, "notes", "2026-10-18-valid.md"), NOTE("Valid note", "c3d4e5f6"));
  await writeFile(join(source, "notes", "2026-10-18-invalid.md"), "no frontmatter here\n");
  await writeFile(join(source, "recovery", "abcd1234.json"), '{"kind":"forget"}\n');
  await writeFile(join(source, "migrations", "v0-to-v1-x", "manifest.json"), "{}\n");
  return { root, source, target };
}

test("detects only v1 pi-remember stores", async () => {
  const { source, target } = await fixture();
  assert.equal(await piRememberV1.detect(source), 1);
  const found = await detectMigrations(source, target);
  assert.equal(found.length, 1);
  assert.equal(found[0].migrator, "pi-remember-v1");

  const other = await mkdtemp(join(tmpdir(), "remember-none-"));
  assert.equal(await piRememberV1.detect(other), null);

  await writeFile(join(source, "pi-remember.json"), '{"version": 2}\n');
  assert.equal(await piRememberV1.detect(source), null);
});

test("a dry run plans without writing", async () => {
  const { source, target } = await fixture();
  const report = await migrate({ source, target, dryRun: true });
  assert.equal(report.facts, 1);
  assert.equal(report.notes, 1);
  assert.equal(report.wrote.length, 0);
  await assert.rejects(readdir(target));
});

test("migration copies facts and valid notes, and nothing else", async () => {
  const { source, target } = await fixture();
  const report = await migrate({ source, target });
  assert.equal(report.facts, 1);
  assert.equal(report.notes, 1);
  assert.equal(report.skipped.length, 1);
  assert.match(report.skipped[0].reason, /frontmatter/);
  assert.ok(report.warnings.some((warning) => /legacy note reference/.test(warning)));

  const marker = JSON.parse(await readFile(join(target, "remember.json"), "utf8"));
  assert.deepEqual(marker, { version: 1 });
  const memory = await readFile(join(target, "MEMORY.md"), "utf8");
  assert.match(memory, /Use pnpm/);
  assert.doesNotMatch(memory, /Legacy reference/);
  const note = await readFile(join(target, "notes", "2026-10-18-valid.md"), "utf8");
  assert.match(note, /Valid note/);
  await assert.rejects(readFile(join(target, "notes", "2026-10-18-invalid.md"), "utf8"));
  await assert.rejects(readdir(join(target, "recovery")));
  await assert.rejects(readdir(join(target, "migrations")));
});

test("an initialized target is refused", async () => {
  const { source, target } = await fixture();
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "remember.json"), '{"version":1}\n');
  await assert.rejects(migrate({ source, target }), /already initialized/);
});

test("duplicate memo IDs keep the first note and report the rest", async () => {
  const { source, target } = await fixture();
  await writeFile(join(source, "notes", "2026-10-18-second.md"), NOTE("Second note", "c3d4e5f6"));
  const report = await migrate({ source, target });
  assert.equal(report.notes, 1);
  assert.ok(report.skipped.some((item) => /duplicate memo ID/.test(item.reason)));
});

test("in-place migration writes only the marker and keeps history directories", async () => {
  const { source } = await fixture();
  const report = await migrate({ source, target: source });
  assert.equal(report.notes, 1);
  assert.match(await readFile(join(source, "remember.json"), "utf8"), /"version": 1/);
  await readFile(join(source, "recovery", "abcd1234.json"), "utf8");
  await readFile(join(source, "migrations", "v0-to-v1-x", "manifest.json"), "utf8");
  await readFile(join(source, "notes", "2026-10-18-valid.md"), "utf8");
});
