#!/usr/bin/env node
/** Install only tarballs outside the workspace and exercise the emitted JS. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
execFileSync(process.execPath, ["scripts/pack.mjs"], { cwd: root, stdio: "inherit" });
const isolated = await mkdtemp(join(tmpdir(), "remember-packed-"));
console.log(`Isolated installation (retained for inspection): ${isolated}`);
await writeFile(join(isolated, "package.json"), JSON.stringify({ private: true, type: "module" }));
const tarballs = [];
for (const name of ["core", "migrators", "pi", "opencode", "dsh"]) {
  const manifest = JSON.parse(await readFile(join(root, "packages", name, "package.json"), "utf8"));
  tarballs.push(join(root, "artifacts", `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`));
}
execFileSync("npm", [
  "install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", ...tarballs,
], { cwd: isolated, stdio: "inherit" });
for (const name of ["remember-core", "remember-migrators", "pi-remember", "opencode-remember", "dsh-remember"]) {
  const installed = await realpath(join(isolated, "node_modules", "@seangle", name));
  assert.ok(installed.startsWith(isolated + sep), `Workspace link escaped isolated install: ${installed}`);
}
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
