#!/usr/bin/env node
/** Install only tarballs outside the workspace and exercise the emitted JS. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
execFileSync(process.execPath, ["scripts/pack.mjs"], { cwd: root, stdio: "inherit" });
const isolated = await mkdtemp(join(tmpdir(), "remember-packed-"));
console.log(`Isolated installation (retained for inspection): ${isolated}`);
await writeFile(join(isolated, "package.json"), JSON.stringify({ private: true, type: "module" }));
const tarballs = [];
for (const name of ["core", "migrators", "cli", "pi", "opencode", "dsh"]) {
  const manifest = JSON.parse(await readFile(join(root, "packages", name, "package.json"), "utf8"));
  tarballs.push(join(root, "artifacts", `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`));
}
// The CLI's TUI dependency is already installed in this workspace. Seed it into
// the isolated tree so the offline install resolves it without a registry.
const workspaceTui = await realpath(join(root, "packages/cli/node_modules/@earendil-works/pi-tui"));
await mkdir(join(isolated, "node_modules/@earendil-works"), { recursive: true });
await symlink(workspaceTui, join(isolated, "node_modules/@earendil-works/pi-tui"), "dir");
execFileSync("npm", [
  "install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", ...tarballs,
], { cwd: isolated, stdio: "inherit" });
for (const name of ["remember-core", "remember-migrators", "remember-cli", "pi-remember", "opencode-remember", "dsh-remember"]) {
  const installed = await realpath(join(isolated, "node_modules", "@seangle", name));
  assert.ok(installed.startsWith(isolated + sep), `Workspace link escaped isolated install: ${installed}`);
}
// The CLI must work from the installed bin, and browse must refuse a non-TTY.
const cliBin = join(isolated, "node_modules/.bin/remember");
const cliStore = join(isolated, "cli-workspace/.agents/memory");
await mkdir(join(cliStore, "notes"), { recursive: true });
await writeFile(join(cliStore, "remember.json"), JSON.stringify({ version: 1 }));
await writeFile(join(cliStore, "MEMORY.md"), "<!-- 2026-10-20T17:06:03Z [4f4cadfe] -->\nPacked smoke fact.\n");
const cliListing = JSON.parse(execFileSync(cliBin, ["ls", "--scope", "local", "--json", "--root", join(isolated, "cli-workspace")], { encoding: "utf8" }));
assert.deepEqual(cliListing.facts.map(fact => fact.id), ["4f4cadfe"]);
assert.match(execFileSync(cliBin, ["--version"], { encoding: "utf8" }), /^\d+\.\d+\.\d+/);
assert.throws(
  () => execFileSync(cliBin, ["browse", "--root", join(isolated, "cli-workspace")], { encoding: "utf8", stdio: "pipe" }),
  /interactive terminal/,
);
console.log("Packed CLI passed: bin, JSON listing, version, non-TTY browse guard.");

execFileSync(process.execPath, ["--test", join(root, "packages/pi/test/adapter.test.ts")], {
  cwd: isolated,
  env: { ...process.env, REMEMBER_TEST_PACKAGE_ROOT: isolated },
  stdio: "inherit",
});
execFileSync(process.execPath, ["--test", join(root, "packages/opencode/test/adapter.test.ts")], {
  cwd: isolated,
  env: { ...process.env, REMEMBER_TEST_PACKAGE_ROOT: isolated },
  stdio: "inherit",
});
// The DSH bundle needs its host packages, which DSH supplies at runtime rather
// than through the package. Link the host copy the workspace already resolves.
const hostSource = join(root, "node_modules", "@deepseek-ai");
if (existsSync(hostSource)) {
  await symlink(hostSource, join(isolated, "node_modules", "@deepseek-ai"), "dir");
  execFileSync(process.execPath, [join(root, "scripts/smoke.mjs")], {
    cwd: isolated,
    env: { ...process.env, REMEMBER_TEST_PACKAGE_ROOT: isolated },
    stdio: "inherit",
  });
} else {
  console.warn("Skipped DSH packed smoke: no @deepseek-ai host packages in the workspace");
}
console.log("Packed installation passed: all ten tools, migration, recovery, and snapshot injection.");
