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

for (const name of ["core", "migrators", "cli", "pi", "opencode", "dsh"]) {
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
  const entry = name === "cli" ? "dist/main.js" : "dist/index.js";
  for (const required of [entry, "README.md", "LICENSE", "package.json"]) {
    assert.ok(paths.includes(required), `${manifest.name}: missing ${required}`);
  }
  assert.ok(paths.every(path =>
    /^(dist\/.*\.js|README\.md|CHANGELOG\.md|LICENSE|package\.json)$/.test(path) ||
    (name === "dsh" && /^(cordis\.patch\.yml|locale\/[^/]+\.json|icon\.svg)$/.test(path)),
  ), `${manifest.name}: unexpected tarball files: ${paths.join(", ")}`);
  const tarball = join(artifacts, packed.filename);
  const shipped = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
  assert.equal(shipped.name, manifest.name);
  assert.equal(shipped.publishConfig.access, "public");
  assert.equal(shipped.repository.directory, `packages/${name}`);
  for (const [dependency, range] of Object.entries(shipped.dependencies ?? {})) {
    // Registry ranges only: no file:/link:/workspace: specifiers in a tarball.
    assert.match(range, /^[~^]\d+\.\d+\.\d+$/, `${dependency}: non-registry dependency ${range}`);
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
  if (name === "cli") {
    assert.equal(shipped.bin.remember, "./dist/main.js");
    assert.equal(shipped.exports, undefined);
    assert.match(execFileSync("tar", ["-xOf", tarball, "package/dist/main.js"], { encoding: "utf8" }), /^#!\/usr\/bin\/env node\n/);
    const listing = execFileSync("tar", ["-tvf", tarball], { encoding: "utf8" });
    assert.match(listing, /-rwxr-xr-x .*dist\/main\.js$/m, "dist/main.js must stay executable");
    assert.ok(shipped.dependencies["@earendil-works/pi-tui"], "pi-tui dependency missing");
  }
  if (name === "opencode") {
    assert.ok(shipped.keywords.includes("opencode-plugin"));
    assert.equal(shipped.exports["."], "./dist/index.js");
    assert.ok(shipped.peerDependencies["@opencode/plugin"]);
    assert.equal(shipped.dependencies["@opencode/plugin"], undefined);
  }
  if (name === "dsh") {
    assert.ok(shipped.keywords.includes("dsh-plugin"));
    assert.equal(shipped.private, undefined);
    assert.equal(shipped.dsh.bundle.patch, "./cordis.patch.yml");
    for (const file of ["cordis.patch.yml", "locale/en.json", "icon.svg"]) {
      assert.ok(paths.includes(file), `${manifest.name}: missing ${file}`);
    }
    for (const host of [
      "@deepseek-ai/dsh-commands", "@deepseek-ai/dsh-home-paths", "@deepseek-ai/dsh-llm",
      "@deepseek-ai/dsh-tools", "@deepseek-ai/schemastery",
    ]) {
      assert.ok(shipped.peerDependencies[host], host);
      assert.equal(shipped.dependencies[host], undefined, host);
      assert.equal(shipped.peerDependenciesMeta?.[host]?.optional, true, `${host} must be optional`);
    }
  }
  console.log(`${packed.name}@${packed.version}: ${packed.files.length} files, ${packed.size} bytes -> ${tarball}`);
}
