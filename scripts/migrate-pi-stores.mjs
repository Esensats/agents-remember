#!/usr/bin/env node
/**
 * Migrate legacy pi-remember stores into the shared workspace stores.
 *
 * Usage:
 *   node scripts/migrate-pi-stores.mjs [--apply] <workspace>...
 *
 * Dry run unless `--apply` is given: prints the plan for each workspace and
 * writes nothing. A workspace is skipped when it has no `.pi/memory` or when
 * `.agents/memory/remember.json` already exists; existing targets are never
 * merged. Run `npm run build` first: this imports the built migrators.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { detectMigrations, migrate } from "../packages/migrators/dist/index.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const roots = [...new Set(args.filter((arg) => !arg.startsWith("--")).map((root) => resolve(root)))];

if (roots.length === 0) {
  console.error("usage: node scripts/migrate-pi-stores.mjs [--apply] <workspace>...");
  process.exit(2);
}

let failures = 0;
let migrated = 0;

for (const root of roots) {
  const source = resolve(root, ".pi", "memory");
  const target = resolve(root, ".agents", "memory");
  if (!existsSync(source)) {
    console.log(`SKIP ${root}: no ${source}`);
    continue;
  }
  if (existsSync(resolve(target, "remember.json"))) {
    console.log(`SKIP ${root}: ${target} is already initialized`);
    continue;
  }
  const [detection] = await detectMigrations(source, target);
  if (!detection) {
    console.log(`SKIP ${root}: no migrator recognizes ${source}`);
    continue;
  }
  try {
    const report = await migrate({ source, target, dryRun: !apply });
    migrated += report.dryRun ? 0 : 1;
    console.log(`${report.dryRun ? "DRY " : "DONE"} ${root}: ${report.facts} fact(s), ${report.notes} note(s)`);
    for (const item of report.skipped) console.log(`  skipped ${item.rel}: ${item.reason}`);
    for (const warning of report.warnings) console.log(`  warning ${warning}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${root}: ${error.message}`);
  }
}

console.log(`\n${apply ? `Migrated ${migrated} workspace(s)` : "Dry run"}; ${failures} failure(s).`);
process.exit(failures > 0 ? 1 : 0);
