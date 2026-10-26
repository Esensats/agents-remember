#!/usr/bin/env node
/**
 * Zero-dependency build: strip TypeScript types with Node's own transformer and
 * rewrite relative `.ts` specifiers to `.js`.
 *
 * Why not tsc: the host runtimes load plugin code from `node_modules`, where
 * Node refuses to strip types. The engine stays authored in TypeScript, but what
 * ships is plain ESM JavaScript. `strip` mode erases annotations only, so the
 * source must avoid enums, namespaces, and parameter properties.
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packagesDir = join(root, "packages");

/** Rewrite `from "./x.ts"` and `export … from "../y.ts"` to the emitted `.js`. */
function rewriteSpecifiers(code) {
  return code.replace(/(\bfrom\s*["'])(\.{1,2}\/[^"']*)\.ts(["'])/g, "$1$2.js$3");
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

async function buildPackage(name) {
  const src = join(packagesDir, name, "src");
  const dist = join(packagesDir, name, "dist");
  let files = [];
  try {
    for await (const file of walk(src)) files.push(file);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (files.length === 0) return;
  await rm(dist, { recursive: true, force: true });
  for (const file of files) {
    const target = join(dist, relative(src, file)).replace(/\.ts$/, ".js");
    const source = await readFile(file, "utf8");
    const code = rewriteSpecifiers(stripTypeScriptTypes(source, { mode: "strip" }));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, code);
  }
  console.log(`built ${name}: ${files.length} file(s)`);
}

const names = (await readdir(packagesDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const name of names) await buildPackage(name);
