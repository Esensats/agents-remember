import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs, UsageError } from "../src/args.ts";

test("defaults: summary, both scopes, .agents", () => {
  const args = parseArgs([], {});
  assert.equal(args.command, "summary");
  assert.equal(args.scope, "both");
  assert.equal(args.dirName, ".agents");
  assert.equal(args.limit, 20);
  assert.equal(args.json, false);
  assert.equal(args.color, true);
  assert.equal(args.wrap, true);
});

test("command and positional arguments", () => {
  const args = parseArgs(["search", "proxy", "docker", "--limit=3"]);
  assert.equal(args.command, "search");
  assert.deepEqual(args.positional, ["proxy", "docker"]);
  assert.equal(args.limit, 3);
});

test("flags before and after the command", () => {
  const args = parseArgs(["--root", "~/dev/x", "ls", "--scope", "local", "--json"]);
  assert.equal(args.command, "ls");
  assert.equal(args.root, "~/dev/x");
  assert.equal(args.scope, "local");
  assert.equal(args.json, true);
});

test("env supplies dir name and global directory", () => {
  const args = parseArgs([], { REMEMBER_DIR_NAME: ".remember" });
  assert.equal(args.dirName, ".remember");
});

test("-- terminates flag parsing", () => {
  const args = parseArgs(["search", "--", "--not-a-flag"]);
  assert.deepEqual(args.positional, ["--not-a-flag"]);
});

test("help and version win over a command", () => {
  assert.equal(parseArgs(["ls", "--help"]).command, "help");
  assert.equal(parseArgs(["ls", "-V"]).command, "version");
});

test("rejects bad input", () => {
  assert.throws(() => parseArgs(["nope"]), UsageError);
  assert.throws(() => parseArgs(["--scope", "everything"]), UsageError);
  assert.throws(() => parseArgs(["--limit", "0"]), UsageError);
  assert.throws(() => parseArgs(["--limit", "many"]), UsageError);
  assert.throws(() => parseArgs(["--root"]), UsageError);
  assert.throws(() => parseArgs(["--unknown"]), UsageError);
  assert.throws(() => parseArgs(["show"]), UsageError);
  assert.throws(() => parseArgs(["search"]), UsageError);
  assert.throws(() => parseArgs(["--dir-name", "a/b"]), UsageError);
});
