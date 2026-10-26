#!/usr/bin/env node
/** Produce and inspect the exact tarballs to test and publish. No network. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts = join(root, "artifacts");
await mkdir(artifacts, { recursive: true });
execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: root, stdio: "inherit" });

for (const name of ["core", "migrators", "pi"]) {
  const cwd = join(root, "packages", name);
  const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
  assert.notEqual(manifest.private, true, manifest.name);
  // Already built above; avoid rebuilding all packages for each tarball.
  const output = execFileSync("npm", [
    "pack", "--ignore-scripts", "--json", "--pack-destination", artifacts,
  ], { cwd, encoding: "utf8" });
  const [packed] = JSON.parse(output);
  assert.equal(packed.name, manifest.name);
  assert.equal(packed.version, manifest.version);
  const paths = packed.files.map(file => file.path);
  for (const required of ["dist/index.js", "README.md", "LICENSE", "package.json"]) {
    assert.ok(paths.includes(required), `${manifest.name}: missing ${required}`);
  }
  assert.ok(paths.every(path => /^(dist\/.*\.js|README\.md|CHANGELOG\.md|LICENSE|package\.json)$/.test(path)),
    `${manifest.name}: unexpected tarball files: ${paths.join(", ")}`);
  const tarball = join(artifacts, packed.filename);
  const shipped = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
  assert.equal(shipped.name, manifest.name);
  assert.equal(shipped.publishConfig.access, "public");
  assert.equal(shipped.repository.directory, `packages/${name}`);
  for (const [dependency, range] of Object.entries(shipped.dependencies ?? {})) {
    assert.match(range, /^\^\d+\.\d+\.\d+$/, `${dependency}: non-registry dependency ${range}`);
  }
  if (name === "pi") {
    assert.ok(shipped.keywords.includes("pi-package"));
    assert.ok(paths.includes("CHANGELOG.md"));
    for (const entry of shipped.pi.extensions) assert.ok(paths.includes(entry.replace(/^\.\//, "")));
    for (const host of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "typebox"]) {
      assert.ok(shipped.peerDependencies[host], host);
      assert.equal(shipped.dependencies[host], undefined, host);
    }
  }
  console.log(`${packed.name}@${packed.version}: ${packed.files.length} files, ${packed.size} bytes -> ${tarball}`);
}
