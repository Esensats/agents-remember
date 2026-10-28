import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, test } from "node:test";

// The adapter, core and migrators run unchanged against real temporary files.
// Unless testing an isolated tarball installation, core and migrators are
// mapped to their sources so no build is needed.
const packageRoot = process.env.REMEMBER_TEST_PACKAGE_ROOT;
const coreSource = new URL("../../core/src/index.ts", import.meta.url).href;
const migratorsSource = new URL("../../migrators/src/index.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!packageRoot && specifier === "@seangle/remember-core") return { url: coreSource, shortCircuit: true };
    if (!packageRoot && specifier === "@seangle/remember-migrators") return { url: migratorsSource, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
after(() => hooks.deregister());

const adapterUrl = packageRoot
  ? pathToFileURL(join(packageRoot, "node_modules/@seangle/opencode-remember/dist/index.js")).href
  : new URL("../src/index.ts", import.meta.url).href;
const adapter = (await import(adapterUrl)).default;

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: string[];
  [key: string]: unknown;
}

interface ToolContent {
  type: string;
  text: string;
}

interface ToolResult {
  content?: string | ToolContent[];
  metadata?: Record<string, unknown>;
}

interface RegisteredTool {
  name: string;
  description: string;
  input: JsonSchema;
  execute: (input: Record<string, unknown>, context: { sessionID: string; signal: AbortSignal }) => Promise<ToolResult>;
}

type ContextHook = (event: { sessionID: string; system: { type: "text"; text: string }[] }) => Promise<void> | void;

interface CommandDefinition {
  name: string;
  description?: string;
  execute: (input: { sessionID: string; prompt: { text: string } }) => Promise<void>;
}

function fakeHost(defaultDirectory: string, options: Record<string, unknown> = {}) {
  const tools = new Map<string, RegisteredTool>();
  const synthetics: string[] = [];
  const sessions = new Map<string, string>([["ses_test", defaultDirectory]]);
  let contextHook: ContextHook | undefined;
  let command: CommandDefinition | undefined;

  const ctx = {
    options,
    location: { directory: defaultDirectory },
    tool: {
      async transform(callback: (editor: unknown) => void) {
        callback({
          add(tool: RegisteredTool & { options?: { namespace?: string } }) {
            const name = tool.options?.namespace ? `${tool.options.namespace}_${tool.name}` : tool.name;
            tools.set(name, { ...tool, name });
          },
          namespace() {},
          get() { return undefined; },
          list() { return []; },
          remove() {},
          update() {},
        });
        return { dispose() {} };
      },
    },
    command: {
      async transform(callback: (editor: unknown) => void) {
        callback({ add(definition: CommandDefinition) { command = definition; } });
        return { dispose() {} };
      },
    },
    session: {
      async get({ sessionID }: { sessionID: string }) {
        const directory = sessions.get(sessionID);
        if (!directory) throw new Error(`unknown session ${sessionID}`);
        return { id: sessionID, location: { directory } };
      },
      async hook(name: string, callback: ContextHook) {
        if (name === "context") contextHook = callback;
        return { dispose() {} };
      },
      async synthetic({ text }: { sessionID: string; text: string }) {
        synthetics.push(text);
      },
    },
  };

  return {
    ctx,
    tools,
    synthetics,
    sessions,
    get command() { return command; },
    async call(name: string, input: Record<string, unknown> = {}, sessionID = "ses_test"): Promise<ToolResult> {
      const tool = tools.get(name);
      assert.ok(tool, `tool ${name} is registered`);
      return tool.execute(input, { sessionID, signal: new AbortController().signal });
    },
    async inject(sessionID = "ses_test") {
      assert.ok(contextHook, "context hook is registered");
      const system: { type: "text"; text: string }[] = [];
      await contextHook({ sessionID, system });
      return system;
    },
  };
}

function textOf(result: ToolResult): string {
  if (typeof result.content === "string") return result.content;
  return (result.content ?? []).map((block) => block.text).join("\n");
}

function success(result: ToolResult): string {
  assert.notEqual(result.metadata?.isError, true, textOf(result));
  return textOf(result);
}

function failure(result: ToolResult, pattern: RegExp): string {
  assert.equal(result.metadata?.isError, true, textOf(result));
  assert.match(textOf(result), pattern);
  return textOf(result);
}

function memoId(result: ToolResult): string {
  const match = success(result).match(/Memo ID: ([a-f0-9]{8})/i);
  assert.ok(match, textOf(result));
  return match[1];
}

const memoryDir = (root: string) => join(root, ".agents", "memory");
const memoryFile = (root: string) => join(memoryDir(root), "MEMORY.md");

let workdirs: string[] = [];

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencode-remember-"));
  workdirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(workdirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const toolNames = [
  "memory_init", "memory_write", "memory_store", "memory_update", "memory_read",
  "memory_search", "memory_forget", "memory_restore", "memory_status", "memory_migrate",
];

describe("tool registration", () => {
  test("registers the ten memory tools with plain JSON schemas", async () => {
    const root = await workspace();
    const host = fakeHost(root);
    await adapter.setup(host.ctx);

    assert.deepEqual([...host.tools.keys()].sort(), [...toolNames].sort());
    for (const name of toolNames) {
      const schema = host.tools.get(name)!.input;
      assert.equal(schema.type, "object", name);
      assert.equal(schema.additionalProperties, false, name);
      assert.equal(typeof host.tools.get(name)!.description, "string", name);
    }
    assert.deepEqual(host.tools.get("memory_write")!.input.required, ["content"]);
    assert.deepEqual(host.tools.get("memory_read")!.input.required, undefined);
    assert.deepEqual(host.tools.get("memory_search")!.input.required, ["query"]);
  });

  test("registers the /memory command", async () => {
    const root = await workspace();
    const host = fakeHost(root);
    await adapter.setup(host.ctx);
    assert.equal(host.command?.name, "memory");
  });
});

describe("facts", () => {
  test("writes a fact, marks the store, and reports a memo ID", async () => {
    const root = await workspace();
    const host = fakeHost(root);
    await adapter.setup(host.ctx);

    failure(await host.call("memory_write", { content: "before init" }), /not initialized/);
    assert.equal(existsSync(memoryFile(root)), false);

    success(await host.call("memory_init"));
    const result = await host.call("memory_write", { content: "Prefers tabs over spaces." });
    assert.match(success(result), /Saved to local memory/);
    memoId(result);
    assert.match(await readFile(memoryFile(root), "utf8"), /Prefers tabs over spaces\./);
    assert.match(await readFile(join(memoryDir(root), "remember.json"), "utf8"), /"version": 1/);
  });

  test("rejects duplicate and oversized facts", async () => {
    const root = await workspace();
    const host = fakeHost(root);
    await adapter.setup(host.ctx);
    await host.call("memory_init");
    await host.call("memory_write", { content: "One durable fact." });

    assert.match(success(await host.call("memory_write", { content: "One durable fact." })), /Duplicate/);
    failure(await host.call("memory_write", { content: "x".repeat(301) }), /too long/);
  });

  test("searches, updates and restores a fact", async () => {
    const root = await workspace();
    const host = fakeHost(root);
    await adapter.setup(host.ctx);
    await host.call("memory_init");
    const id = memoId(await host.call("memory_write", { content: "Deploys happen on Fridays." }));

    const hits = success(await host.call("memory_search", { query: "Deploys" }));
    assert.match(hits, /Fridays/);

    const updated = success(await host.call("memory_update", { id, content: "Deploys happen on Thursdays." }));
    const recovery = updated.match(/Recovery ID: ([a-f0-9-]+)/i);
    assert.ok(recovery, updated);
    assert.match(await readFile(memoryFile(root), "utf8"), /Thursdays/);

    success(await host.call("memory_restore", { recoveryId: recovery[1] }));
    assert.match(await readFile(memoryFile(root), "utf8"), /Fridays/);
  });

  test("keeps global and local scopes separate", async () => {
    const root = await workspace();
    const host = fakeHost(root, { globalDir: join(root, "global-memory") });
    await adapter.setup(host.ctx);
    await host.call("memory_init");

    success(await host.call("memory_write", { content: "Local fact.", scope: "local" }));
    success(await host.call("memory_write", { content: "Global fact.", scope: "global" }));

    assert.match(await readFile(memoryFile(root), "utf8"), /Local fact/);
    assert.doesNotMatch(await readFile(memoryFile(root), "utf8"), /Global fact/);
    assert.match(await readFile(join(root, "global-memory", "MEMORY.md"), "utf8"), /Global fact/);

    const localOnly = success(await host.call("memory_read", { scope: "local" }));
    assert.match(localOnly, /Local fact/);
    assert.doesNotMatch(localOnly, /Global fact/);
  });
});

describe("notes", () => {
  test("stores, reads and forgets a note", async () => {
    const root = await workspace();
    const host = fakeHost(root);
    await adapter.setup(host.ctx);
    await host.call("memory_init");

    const stored = success(await host.call("memory_store", {
      title: "Release process",
      content: "Tag, build, publish.",
      slug: "release-process",
    }));
    const id = stored.match(/Memo ID: ([a-f0-9]{8})/i)![1];
    const rel = stored.match(/Stored note: (notes\/[^\s]+\.md)/)![1];

    const notePath = join(memoryDir(root), rel);
    assert.match(await readFile(notePath, "utf8"), /Tag, build, publish\./);

    assert.match(success(await host.call("memory_read", { id })), /Tag, build, publish\./);
    assert.match(success(await host.call("memory_read", { path: rel })), /Tag, build, publish\./);
    assert.match(success(await host.call("memory_search", { query: "publish" })), /release-process/);

    const forgotten = success(await host.call("memory_forget", { text: "Release process" }));
    assert.equal(existsSync(notePath), false);
    const recovery = forgotten.match(/Recovery id: (\S+)/)![1];
    success(await host.call("memory_restore", { recoveryId: recovery }));
    assert.equal(existsSync(notePath), true);
  });
});

describe("workspace resolution", () => {
  test("follows the session directory, including moves", async () => {
    const first = await workspace();
    const second = await workspace();
    const host = fakeHost(first);
    await adapter.setup(host.ctx);
    await host.call("memory_init");
    await host.call("memory_write", { content: "Belongs to the first workspace." });

    host.sessions.set("ses_test", second);
    await host.call("memory_init");
    await host.call("memory_write", { content: "Belongs to the second workspace." });

    assert.match(await readFile(memoryFile(first), "utf8"), /first workspace/);
    assert.doesNotMatch(await readFile(memoryFile(first), "utf8"), /second workspace/);
    assert.match(await readFile(memoryFile(second), "utf8"), /second workspace/);
  });

  test("accepts an explicit root for another workspace", async () => {
    const cwd = await workspace();
    const other = await workspace();
    const host = fakeHost(cwd);
    await adapter.setup(host.ctx);
    await host.call("memory_init", { root: other });
    success(await host.call("memory_write", { content: "Other workspace fact.", root: other }));
    assert.match(await readFile(memoryFile(other), "utf8"), /Other workspace fact/);
    assert.equal(existsSync(memoryFile(cwd)), false);
  });
});

describe("injection", () => {
  test("adds one stable snapshot per request and refreshes after a write", async () => {
    const root = await workspace();
    const host = fakeHost(root);
    await adapter.setup(host.ctx);
    await host.call("memory_init");
    await host.call("memory_write", { content: "The build uses pnpm." });

    const first = await host.inject();
    const second = await host.inject();
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(first[0].text, second[0].text);
    assert.match(first[0].text, /^<remember>/);
    assert.match(first[0].text, /The build uses pnpm\./);

    await host.call("memory_write", { content: "Tests run with node --test." });
    const refreshed = await host.inject();
    assert.equal(refreshed.length, 1);
    assert.match(refreshed[0].text, /Tests run with node --test\./);
    assert.notEqual(refreshed[0].text, first[0].text);
  });

  test("injects nothing before local memory is initialized", async () => {
    const root = await workspace();
    const host = fakeHost(root);
    await adapter.setup(host.ctx);
    assert.deepEqual(await host.inject(), []);
  });

  test("honors autoInject: false", async () => {
    const root = await workspace();
    const host = fakeHost(root, { autoInject: false });
    await adapter.setup(host.ctx);
    await host.call("memory_init");
    await host.call("memory_write", { content: "Not injected." });
    assert.deepEqual(await host.inject(), []);
  });

  test("offers a legacy migration once per session", async () => {
    const root = await workspace();
    await mkdir(join(root, ".pi", "memory"), { recursive: true });
    await writeFile(join(root, ".pi", "memory", "pi-remember.json"), '{\n  "version": 1\n}\n');
    await writeFile(join(root, ".pi", "memory", "MEMORY.md"), "\n<!-- 2026-10-20T10:00:00Z [aaaaaaaa] -->\nLegacy fact.\n");

    const host = fakeHost(root);
    await adapter.setup(host.ctx);

    const first = await host.inject();
    assert.equal(first.length, 1);
    assert.match(first[0].text, /<remember-migration>/);
    assert.deepEqual(await host.inject(), []);

    const otherSession = await host.inject("ses_other");
    assert.equal(otherSession.length, 0, "unknown sessions fail closed");
  });
});

describe("migrate and status", () => {
  test("migrates a legacy store and reports status", async () => {
    const root = await workspace();
    await mkdir(join(root, ".pi", "memory"), { recursive: true });
    await writeFile(join(root, ".pi", "memory", "pi-remember.json"), '{\n  "version": 1\n}\n');
    await writeFile(join(root, ".pi", "memory", "MEMORY.md"), "\n<!-- 2026-10-20T10:00:00Z [aaaaaaaa] -->\nLegacy fact.\n");

    const host = fakeHost(root);
    await adapter.setup(host.ctx);

    const dry = success(await host.call("memory_migrate", { dryRun: true }));
    assert.match(dry, /Dry run/);
    assert.equal(existsSync(memoryFile(root)), false);

    assert.match(success(await host.call("memory_migrate")), /1 fact/);
    assert.match(await readFile(memoryFile(root), "utf8"), /Legacy fact/);

    const status = success(await host.call("memory_status"));
    assert.match(status, /local: .*1 facts/);
  });

  test("/memory status and /memory migrate reply without a model turn", async () => {
    const root = await workspace();
    const host = fakeHost(root);
    await adapter.setup(host.ctx);
    await host.call("memory_init");
    await host.call("memory_write", { content: "Something durable." });

    await host.command!.execute({ sessionID: "ses_test", prompt: { text: "" } });
    assert.match(host.synthetics.at(-1)!, /local: .*1 facts/);

    await host.command!.execute({ sessionID: "ses_test", prompt: { text: "migrate" } });
    assert.match(host.synthetics.at(-1)!, /No legacy memory store/);

    await host.command!.execute({ sessionID: "ses_test", prompt: { text: "bogus" } });
    assert.match(host.synthetics.at(-1)!, /Usage: \/memory/);
  });
});
