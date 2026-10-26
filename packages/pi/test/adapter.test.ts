import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

// Host packages are substituted; the adapter, core, migrators and snapshot
// builder all run unchanged against real temporary files. Core and migrators
// are mapped to their sources unless testing an isolated tarball installation.
const hostSource = `
  export const queueCalls = [];
  const tails = new Map();
  export async function withFileMutationQueue(path, operation) {
    queueCalls.push(path);
    const previous = tails.get(path) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    tails.set(path, result);
    try { return await result; }
    finally { if (tails.get(path) === result) tails.delete(path); }
  }
  // These tests deliberately stay below the output caps.
  export function truncateTail(content) {
    const lines = content.split("\\n").length;
    return { content, truncated: false, outputLines: lines, totalLines: lines };
  }
`;
const optionalKey = Symbol.for("pi-remember-adapter-test.optional");
const schemaSource = `
  const optional = Symbol.for("pi-remember-adapter-test.optional");
  export const Type = {
    String: (options = {}) => ({ type: "string", ...options }),
    Boolean: (options = {}) => ({ type: "boolean", ...options }),
    Optional: (schema) => ({ ...schema, [optional]: true }),
    Object: (properties) => ({ type: "object", properties,
      required: Object.keys(properties).filter(key => !properties[key][optional]) }),
  };
`;
const stubSources = new Map([
  ["@earendil-works/pi-coding-agent", hostSource],
  ["typebox", schemaSource],
  ["@earendil-works/pi-ai", "export const StringEnum = values => ({ type: 'string', enum: [...values] });"],
]);
const stubUrls = new Map([...stubSources].map(([name, source]) => [
  name, `data:text/javascript,${encodeURIComponent(source)}`,
]));
const packageRoot = process.env.REMEMBER_TEST_PACKAGE_ROOT;
const adapterBase = packageRoot
  ? pathToFileURL(join(packageRoot, "node_modules/@seangle/pi-remember/dist/"))
  : new URL("../src/", import.meta.url);
const coreSource = new URL("../../core/src/index.ts", import.meta.url).href;
const migratorsSource = new URL("../../migrators/src/index.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!packageRoot && specifier === "@seangle/remember-core") return { url: coreSource, shortCircuit: true };
    if (!packageRoot && specifier === "@seangle/remember-migrators") return { url: migratorsSource, shortCircuit: true };
    const url = stubUrls.get(specifier);
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});
after(() => hooks.deregister());

interface Schema {
  type?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: string[];
  properties?: Record<string, Schema>;
  required?: string[];
  [optionalKey]?: boolean;
}

interface ToolResult {
  content: { type: string; text: string }[];
  details: unknown;
  isError?: boolean;
}

interface Tool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Schema;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: undefined,
    ctx: FakeContext,
  ) => Promise<ToolResult>;
}

interface FakeContext {
  cwd: string;
  hasUI: true;
  ui: { notify(message: string, level: string): void };
}

interface Command {
  description?: string;
  getArgumentCompletions?: (prefix: string) => { value: string; label: string; description: string }[] | null;
  handler: (args: string, ctx: FakeContext) => Promise<void>;
}

type EventHandler = (event: Record<string, unknown>, ctx: FakeContext) => Promise<unknown>;

const toolNames = [
  "memory_init", "memory_write", "memory_store", "memory_update", "memory_read",
  "memory_search", "memory_forget", "memory_restore", "memory_status", "memory_migrate",
];

const memoryDir = (root: string) => join(root, ".agents", "memory");
const memoryFile = (root: string) => join(memoryDir(root), "MEMORY.md");

function textOf(result: ToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

function success(result: ToolResult): string {
  assert.notEqual(result.isError, true, textOf(result));
  return textOf(result);
}

function failure(result: ToolResult, pattern: RegExp): string {
  assert.equal(result.isError, true, textOf(result));
  assert.match(textOf(result), pattern);
  return textOf(result);
}

function memoId(result: ToolResult): string {
  const match = success(result).match(/Memo ID: ([a-f0-9]{8})/i);
  assert.ok(match, textOf(result));
  return match[1];
}

function recoveryId(result: ToolResult): string {
  const match = success(result).match(/Recovery id: ([a-f0-9]{8})/i);
  assert.ok(match, textOf(result));
  return match[1];
}

function notePath(result: ToolResult): string {
  const match = success(result).match(/Stored note: (notes\/[^\n]+)/);
  assert.ok(match, textOf(result));
  return match[1];
}

const validNoteFrontmatter = (description: string, id: string) => [
  "---",
  `description: ${description}`,
  `memory-id: ${id}`,
  "created-date: 2026-10-20T10:00Z",
  "last-modified-date: 2026-10-20T10:00Z",
  "---",
  "",
  "",
].join("\n");

let fixtureNumber = 0;

async function fixture(t: TestContext, options: {
  env?: Record<string, string>;
  before?: (paths: { cwd: string; other: string; globalDir: string }) => Promise<void>;
} = {}) {
  const base = await mkdtemp(join(tmpdir(), "pi-remember-adapter-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = join(base, "workspace");
  const other = join(base, "other");
  const globalDir = join(base, "global");
  await Promise.all([cwd, other].map((root) => mkdir(root)));
  if (options.before) await options.before({ cwd, other, globalDir });

  const environment = {
    REMEMBER_GLOBAL_DIR: globalDir,
    REMEMBER_INJECT_CHARS_GLOBAL: "20000",
    REMEMBER_INJECT_CHARS_LOCAL: "20000",
    ...options.env,
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  const tools = new Map<string, Tool>();
  const events = new Map<string, EventHandler>();
  const commands = new Map<string, Command>();
  const sent: { content: string; options: unknown }[] = [];
  const notifications: { message: string; level: string }[] = [];
  const fake = {
    registerTool(tool: Tool) {
      assert.ok(!tools.has(tool.name), `duplicate tool registration: ${tool.name}`);
      tools.set(tool.name, tool);
    },
    on(name: string, handler: EventHandler) {
      assert.ok(!events.has(name), `duplicate event registration: ${name}`);
      events.set(name, handler);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    sendUserMessage(content: string, sendOptions: unknown) {
      sent.push({ content, options: sendOptions });
    },
  };
  try {
    Object.assign(process.env, environment);
    // Each fixture gets fresh module-level config and session state. The factory
    // reads the environment, so it must run while the fixture env is in place.
    const extension = (await import(new URL(`index.${packageRoot ? "js" : "ts"}?fixture=${++fixtureNumber}`, adapterBase).href)).default;
    extension(fake);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const ctx: FakeContext = {
    cwd,
    hasUI: true,
    ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
  };
  const signal = new AbortController().signal;

  async function call(name: string, params: Record<string, unknown> = {}) {
    const tool = tools.get(name);
    assert.ok(tool, `tool registered: ${name}`);
    return tool.execute("test-call", params, signal, undefined, ctx);
  }

  const start = () => events.get("session_start")!({ type: "session_start" }, ctx);

  async function prompt() {
    const event: Record<string, unknown> = {
      type: "before_agent_start",
      systemPrompt: "",
      systemPromptOptions: { sections: {} },
      messageType: "user",
      prompt: "",
    };
    await events.get("before_agent_start")!(event, ctx);
    return (event.systemPromptOptions as { sections: Record<string, string> }).sections;
  }

  const command = (args: string) => commands.get("memory")!.handler(args, ctx);

  return { base, cwd, other, globalDir, tools, events, commands, sent, notifications, ctx, call, start, prompt, command };
}

describe("adapter registration", () => {
  test("registers ten tools, the memory command, and object schemas", async (t) => {
    const f = await fixture(t);
    assert.deepEqual([...f.tools.keys()].sort(), [...toolNames].sort());
    assert.ok(f.commands.has("memory"));
    for (const tool of f.tools.values()) {
      assert.equal(tool.parameters.type, "object", tool.name);
      assert.ok(tool.parameters.properties, tool.name);
    }
    assert.deepEqual(f.tools.get("memory_write")!.parameters.required, ["content"]);
    assert.deepEqual(f.tools.get("memory_read")!.parameters.required, []);
    assert.match(f.tools.get("memory_migrate")!.description, /\.pi\/memory/);
  });

  test("config defaults and environment overrides", async () => {
    const { loadConfig } = await import(new URL(`context.${packageRoot ? "js" : "ts"}`, adapterBase).href);
    const defaults = loadConfig({});
    assert.equal(defaults.dirName, ".agents");
    assert.ok(defaults.globalDir.endsWith(join(".pi", "agent", "memory")));
    assert.equal(defaults.injectCharsGlobal, 3000);
    assert.equal(defaults.injectCharsLocal, 3000);
    assert.equal(defaults.autoInject, true);

    const overridden = loadConfig({
      REMEMBER_DIR_NAME: ".shared",
      REMEMBER_GLOBAL_DIR: "~/custom/memory",
      REMEMBER_INJECT_CHARS_GLOBAL: "120",
      REMEMBER_INJECT_CHARS_LOCAL: "0",
      REMEMBER_AUTO_INJECT: "0",
    });
    assert.equal(overridden.dirName, ".shared");
    assert.ok(overridden.globalDir.endsWith(join("custom", "memory")));
    assert.equal(overridden.injectCharsGlobal, 120);
    assert.equal(overridden.injectCharsLocal, 3000, "invalid budget falls back");
    assert.equal(overridden.autoInject, false);
  });
});

describe("memory lifecycle", () => {
  test("init, facts, notes, reads, updates, forget, restore, status", async (t) => {
    const f = await fixture(t);

    const uninitialized = await f.call("memory_read", { scope: "local" });
    assert.equal(uninitialized.isError, true);
    assert.match(textOf(uninitialized), /not initialized/);

    const init = await f.call("memory_init", {});
    assert.match(success(init), new RegExp(`Initialized local memory: ${memoryFile(f.cwd).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(success(await f.call("memory_init", {})), /already initialized/);

    const write = await f.call("memory_write", { content: "Prefer pnpm over npm for installs." });
    const factId = memoId(write);
    assert.match(await readFile(memoryFile(f.cwd), "utf8"), /Prefer pnpm over npm for installs\./);

    assert.match(success(await f.call("memory_write", { content: "Prefer pnpm over npm for installs." })), /Duplicate/);
    failure(await f.call("memory_write", { content: "x".repeat(301) }), /too long/);
    assert.match(success(await f.call("memory_write", { content: "   " })), /nothing saved/);

    const stored = await f.call("memory_store", {
      title: "Release process notes",
      content: "## Steps\n\nTag, build, publish.",
      slug: "release-process",
    });
    const noteId = memoId(stored);
    const rel = notePath(stored);
    assert.match(rel, /^notes\/\d{4}-\d{2}-\d{2}-release-process\.md$/);
    assert.match(success(await f.call("memory_store", { title: "Release process notes", content: "other" })), /Already indexed/);
    failure(await f.call("memory_store", { title: "Bad slug", content: "body", slug: "no/slashes" }), /Invalid slug/);
    failure(await f.call("memory_store", { title: " ", content: "body" }), /nonempty single line/);

    const catalogue = success(await f.call("memory_read", {}));
    assert.match(catalogue, /Prefer pnpm over npm/);
    assert.match(catalogue, /Release process notes/);
    assert.match(success(await f.call("memory_read", { query: "pnpm" })), /Prefer pnpm over npm/);

    const byId = success(await f.call("memory_read", { id: noteId }));
    assert.match(byId, /Tag, build, publish/);
    const byPath = success(await f.call("memory_read", { path: rel }));
    assert.match(byPath, /Tag, build, publish/);
    failure(await f.call("memory_read", { id: noteId, path: rel }), /Specify id alone/);

    const hit = success(await f.call("memory_search", { query: "release process" }));
    assert.match(hit, new RegExp(`\\[id=${noteId}\\]`));
    assert.match(success(await f.call("memory_search", { query: "unfindable-term-xyz" })), /No matches/);

    const updated = await f.call("memory_update", { id: factId, content: "Prefer pnpm for installs; it is faster." });
    const updateRecovery = recoveryId(updated);
    assert.match(success(await f.call("memory_update", { id: factId, content: "Prefer pnpm for installs; it is faster." })), /unchanged/);

    const forgot = await f.call("memory_forget", { text: "Release process notes" });
    const forgetRecovery = recoveryId(forgot);
    assert.match(success(forgot), /Removed 1/);
    assert.equal(existsSync(join(memoryDir(f.cwd), rel)), false);
    assert.match(success(await f.call("memory_restore", { recoveryId: forgetRecovery })), /Restored 1/);
    assert.match(success(await f.call("memory_read", { id: noteId })), /Tag, build, publish/);

    const undone = await f.call("memory_restore", { recoveryId: updateRecovery });
    assert.match(success(undone), /Restored 1/);
    assert.match(await readFile(memoryFile(f.cwd), "utf8"), /Prefer pnpm over npm for installs\./);

    const status = success(await f.call("memory_status", {}));
    assert.match(status, /local: .*facts/);
    assert.match(status, /global: .*no memory yet/);
    assert.match(status, /injected snapshot/);
    assert.match(status, /config: dirName=\.agents/);

    assert.match(success(await f.call("memory_read", { query: "nothing-matches-this" })), /\(empty\)|$|/);
  });

  test("global scope and per-call root isolation", async (t) => {
    const f = await fixture(t);

    // Global-only reads work before any local store exists.
    assert.match(success(await f.call("memory_read", { scope: "global" })), /global/);
    const globalWrite = await f.call("memory_write", { content: "Machine-wide fact.", scope: "global" });
    assert.match(success(globalWrite), /Saved to global memory/);
    assert.match(await readFile(join(f.globalDir, "MEMORY.md"), "utf8"), /Machine-wide fact/);
    assert.equal(existsSync(memoryFile(f.cwd)), false, "global write must not touch the local store");

    const otherInit = await f.call("memory_init", { root: f.other });
    assert.match(success(otherInit), /Initialized local memory/);
    assert.match(success(otherInit), new RegExp(f.other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const otherWrite = await f.call("memory_write", { root: f.other, content: "Other workspace fact." });
    assert.match(success(otherWrite), /Other workspace fact|Saved/);
    assert.match(await readFile(memoryFile(f.other), "utf8"), /Other workspace fact/);
    assert.equal(existsSync(memoryFile(f.cwd)), false, "root must not redirect the session store");

    // Read from the other workspace and confirm both scopes are visible.
    const both = success(await f.call("memory_read", { root: f.other }));
    assert.match(both, /global/);
    assert.match(both, /Other workspace fact/);
    assert.match(both, /Machine-wide fact/);

    failure(await f.call("memory_write", { root: join(f.base, "missing"), content: "nope" }), /Cannot resolve workspace root/);
    failure(await f.call("memory_init", { root: "~nobody/workspace" }), /Unsupported workspace root/);
  });
});

describe("prompt injection", () => {
  test("injects the snapshot as a section without a nested tag, stable between runs", async (t) => {
    const f = await fixture(t);
    assert.deepEqual(await f.prompt(), {}, "nothing to inject before memory exists");

    await f.start();
    await f.call("memory_init", {});
    await f.call("memory_write", { content: "Injected fact." });
    await f.call("memory_store", { title: "Injected note", content: "body" });

    const first = await f.prompt();
    assert.ok(first.remember, "snapshot section must be present");
    assert.match(first.remember, /Injected fact\./);
    assert.match(first.remember, /Injected note/);
    assert.doesNotMatch(first.remember, /<\/?remember>/, "Pi wraps the section itself");

    const second = await f.prompt();
    assert.equal(second.remember, first.remember, "snapshot bytes stay stable between runs");

    await f.call("memory_write", { content: "Deploys run from CI only." });
    const third = await f.prompt();
    assert.notEqual(third.remember, first.remember);
    assert.match(third.remember, /Deploys run from CI only\./);
  });

  test("autoInject off leaves the prompt untouched", async (t) => {
    const f = await fixture(t, { env: { REMEMBER_AUTO_INJECT: "0" } });
    await f.start();
    await f.call("memory_init", {});
    await f.call("memory_write", { content: "Hidden fact." });
    assert.deepEqual(await f.prompt(), {});
  });

  test("notifies when a local store cannot be adopted and never injects it", async (t) => {
    const f = await fixture(t, {
      before: async ({ cwd }) => {
        await mkdir(memoryDir(cwd), { recursive: true });
        await writeFile(memoryFile(cwd), "Unmarked fact that must not be adopted.\n");
      },
    });
    await f.start();
    assert.equal(f.notifications.length, 1);
    assert.match(f.notifications[0].message, /local memory unavailable/);
    assert.deepEqual(await f.prompt(), {});
    assert.match(success(await f.call("memory_status", {})), /facts/);
  });
});

describe("legacy stores", () => {
  test("detects, migrates, and then injects a pi-remember store", async (t) => {
    const legacy = join(".pi", "memory");
    const f = await fixture(t, {
      before: async ({ cwd }) => {
        await mkdir(join(cwd, legacy, "notes"), { recursive: true });
        await writeFile(join(cwd, legacy, "pi-remember.json"), '{\n  "version": 1\n}\n');
        await writeFile(join(cwd, legacy, "MEMORY.md"), "\n<!-- 2026-10-20T10:00:00Z [aaaaaaaa] -->\nLegacy fact.\n");
        await writeFile(
          join(cwd, legacy, "notes", "2026-10-20-legacy-note.md"),
          `${validNoteFrontmatter("Legacy note", "bbbbbbbb")}Body of legacy note.\n`,
        );
      },
    });

    await f.start();
    const first = await f.prompt();
    assert.match(first.remember, /<remember-migration>/);
    assert.match(first.remember, /\.pi\/memory/);
    assert.doesNotMatch(first.remember, /Legacy fact/, "unmigrated stores are not injected");

    const dry = success(await f.call("memory_migrate", { dryRun: true }));
    assert.match(dry, /Dry run/);
    assert.equal(existsSync(memoryFile(f.cwd)), false, "dry run must not write");

    await f.command("migrate");
    assert.equal(f.notifications.length, 1);
    assert.match(f.notifications[0].message, /Migrated.*1 fact\(s\), 1 note\(s\)/);
    assert.match(await readFile(memoryFile(f.cwd), "utf8"), /Legacy fact\./);
    assert.match(await readFile(join(memoryDir(f.cwd), "notes", "2026-10-20-legacy-note.md"), "utf8"), /Body of legacy note/);
    assert.match(await readFile(join(f.cwd, legacy, "MEMORY.md"), "utf8"), /Legacy fact\./, "source is left intact");

    const second = await f.prompt();
    assert.doesNotMatch(second.remember, /<remember-migration>/, "notice is shown once per session");
    assert.match(second.remember, /Legacy fact\./);
    assert.match(second.remember, /Legacy note/);
  });

  test("adopts a copied legacy tree in place, marker only", async (t) => {
    const f = await fixture(t, {
      before: async ({ cwd }) => {
        await mkdir(memoryDir(cwd), { recursive: true });
        await writeFile(join(cwd, ".agents", "memory", "pi-remember.json"), '{\n  "version": 1\n}\n');
        await writeFile(memoryFile(cwd), "\n<!-- 2026-10-20T10:00:00Z [aaaaaaaa] -->\nCopied fact.\n");
      },
    });

    await f.start();
    // The copied tree has pi-remember's marker but not remember.json, so it is
    // not injectable yet; session_start reports that instead of adopting it.
    assert.equal(f.notifications.length, 1);
    assert.match(f.notifications[0].message, /local memory unavailable/);
    const first = await f.prompt();
    assert.match(first.remember, /<remember-migration>/, "in-place copy is offered, not silently adopted");
    assert.doesNotMatch(first.remember, /Copied fact/);

    const report = success(await f.call("memory_migrate", {}));
    assert.match(report, /Migrated in place/);
    assert.equal(existsSync(join(memoryDir(f.cwd), "remember.json")), true);
    assert.match(await readFile(memoryFile(f.cwd), "utf8"), /Copied fact\./);

    const second = await f.prompt();
    assert.doesNotMatch(second.remember, /<remember-migration>/);
    assert.match(second.remember, /Copied fact\./);
  });

  test("memory_migrate refuses an already initialized target and reports missing sources", async (t) => {
    const f = await fixture(t);
    await f.call("memory_init", {});
    assert.match(
      success(await f.call("memory_write", { content: "Existing fact." })),
      /Saved/,
    );
    assert.match(success(await f.call("memory_migrate", {})), /No legacy memory store found/);
    failure(await f.call("memory_migrate", { source: join(f.base, "absent"), target: memoryDir(f.cwd) }), /Migration refused/);
  });
});

describe("command", () => {
  test("status, update, and usage", async (t) => {
    const f = await fixture(t);
    await f.command("status");
    assert.equal(f.notifications.length, 1);
    assert.match(f.notifications[0].message, /config: dirName=\.agents/);
    assert.equal(f.notifications[0].level, "info");

    await f.command("");
    assert.equal(f.notifications.length, 2);

    await f.command("update");
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].content, /incremental memory reminder/);
    assert.deepEqual(f.sent[0].options, { deliverAs: "followUp" });

    await f.command("bogus");
    assert.equal(f.notifications.at(-1)!.level, "warning");
    assert.match(f.notifications.at(-1)!.message, /Usage: \/memory/);

    const completions = f.commands.get("memory")!.getArgumentCompletions!("");
    assert.deepEqual(completions!.map((item) => item.value), ["status", "migrate", "update"]);
    assert.deepEqual(f.commands.get("memory")!.getArgumentCompletions!("m")!.map((item) => item.value), ["migrate"]);
    assert.equal(f.commands.get("memory")!.getArgumentCompletions!("zzz"), null);
  });

  test("uses the current workspace name in status", async (t) => {
    const f = await fixture(t);
    await f.command("");
    assert.match(f.notifications[0].message, new RegExp(basename(f.cwd)));
  });
});
