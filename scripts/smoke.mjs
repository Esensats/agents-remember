import { mkdtemp, mkdir, writeFile, readFile, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Test the emitted bundle from either the workspace or an isolated tarball install.
const packageRoot = process.env.REMEMBER_TEST_PACKAGE_ROOT;
const entry = packageRoot
  ? pathToFileURL(join(packageRoot, "node_modules/@seangle/dsh-remember/dist/index.js")).href
  : new URL("../packages/dsh/dist/index.js", import.meta.url).href;
const { apply } = await import(entry);

let failures = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const base = await mkdtemp(join(tmpdir(), "remember-"));
const workspace = join(base, "proj");
const other = join(base, "other");
const globalDir = join(base, "global");
await mkdir(workspace, { recursive: true });
await mkdir(other, { recursive: true });

const tools = new Map();
const commands = new Map();
let preStep;
const ctx = {
  tools: { register(tool) { tools.set(tool.name, tool); } },
  commands: { register(command) { commands.set(command.name, command); } },
  on(event, fn) { if (event === "agent/pre-step") preStep = fn; },
  workingDirectory: { async ensure() { return workspace; } },
};
apply(ctx, { dirName: ".agents", globalDir, injectCharsGlobal: 3000, injectCharsLocal: 3000, autoInject: true });
const exec = { agent: {}, signal: new AbortController().signal };
const call = (name, args) => tools.get(name).execute(args, exec);

check("ten tools", tools.size === 10, [...tools.keys()].join(","));
check("/memory command registered", commands.has("memory"));

// uninitialized local read fails with guidance
const uninit = await call("memory_read", { scope: "local" });
check("uninitialized local rejected", /not initialized/.test(uninit.text), uninit.text.slice(0, 80));

const init = await call("memory_init", {});
check("init creates store", /Initialized local memory/.test(init.text), init.text);
const init2 = await call("memory_init", {});
check("init is idempotent", /already initialized/.test(init2.text));

const w1 = await call("memory_write", { content: "Prefer pnpm over npm for installs." });
const id1 = /Memo ID: ([a-f0-9]{8})/.exec(w1.text)?.[1];
check("write returns id", !!id1, w1.text);
const w2 = await call("memory_write", { content: "Prefer pnpm over npm for installs." });
check("duplicate rejected", /Duplicate/.test(w2.text), w2.text);
const long = await call("memory_write", { content: "x".repeat(301) });
check("overlong fact rejected", /too long/.test(long.text));

const store = await call("memory_store", { title: "Release process notes", content: "## Steps\n\nTag, build, publish.", slug: "release-process" });
const noteId = /Memo ID: ([a-f0-9]{8})/.exec(store.text)?.[1];
check("note stored", !!noteId && /notes\/\d{4}-\d{2}-\d{2}-release-process\.md/.test(store.text), store.text);
const dupNote = await call("memory_store", { title: "Release process notes", content: "other" });
check("duplicate note rejected", /Already indexed/.test(dupNote.text));

const catalogue = await call("memory_read", {});
check("catalogue has fact and note index", /pnpm/.test(catalogue.text) && /Release process notes/.test(catalogue.text));
const byId = await call("memory_read", { id: noteId });
check("read by id returns body", /Tag, build, publish/.test(byId.text));
const byPath = await call("memory_read", { path: "notes/" + store.text.match(/notes\/(\S+\.md)/)[1] });
check("read by path", /Tag, build, publish/.test(byPath.text));

const search = await call("memory_search", { query: "release process" });
check("search finds note", search.text.includes(`[id=${noteId}]`), search.text);

const upd = await call("memory_update", { id: id1, content: "Prefer pnpm for installs; it is faster." });
const rec1 = /Recovery ID: ([a-f0-9]{8})/.exec(upd.text)?.[1];
check("update returns recovery id", !!rec1, upd.text);
const unchanged = await call("memory_update", { id: id1, content: "Prefer pnpm for installs; it is faster." });
check("identical update is no-op", /unchanged/.test(unchanged.text));

const forgot = await call("memory_forget", { text: "Release process notes" });
const rec2 = /Recovery id: ([a-f0-9]{8})/.exec(forgot.text)?.[1];
check("forget removes note", /Removed 1/.test(forgot.text), forgot.text);
const gone = await call("memory_read", { path: "notes/" + store.text.match(/notes\/(\S+\.md)/)[1], scope: "local" });
check("note file gone", /not found|No note|error/i.test(gone.text) || !/Tag, build/.test(gone.text), gone.text.slice(0, 80));

const restored = await call("memory_restore", { recoveryId: rec2 });
check("restore brings note back", /Restored/.test(restored.text), restored.text);
const back = await call("memory_read", { id: noteId });
check("restored note readable", /Tag, build, publish/.test(back.text));

const status = await call("memory_status", {});
check("status reports counts", /facts/.test(status.text) && /notes/.test(status.text), status.text.split("\n")[1]);

// workspace isolation + root parameter
const otherInit = await call("memory_init", { root: other });
check("init other workspace", /Initialized/.test(otherInit.text), otherInit.text);
const otherWrite = await call("memory_write", { root: other, content: "Other workspace fact." });
check("write with root", /Saved to local/.test(otherWrite.text));

// injection
let surface = [{ type: "user/message", data: { source: { kind: "user" } } }];
const agent = { session: { surface: { nodes: [0] }, eventAt: () => surface[0] } };
const user = { role: "user", content: [{ type: "text", text: "hi" }] };
const inject = (step) => preStep({ agent, messages: [user], step, signal: exec.signal },
  async () => ({ kind: "accept", messages: [user] }));
const out1 = await inject(1);
check("step 1 injects snapshot", out1.messages.length === 2, `messages=${out1.messages.length}`);
check("snapshot uses <remember>", out1.messages[1]?.content?.[0]?.text?.startsWith("<remember>"), out1.messages[1]?.content?.[0]?.text?.slice(0, 40));
surface = [{ type: "user/message", data: { source: out1.messages[1].source } }];
const out2 = await inject(1);
check("same store deduped", out2.messages.length === 1);
const outMid = await inject(2);
check("mid-turn step does not inject", outMid.messages.length === 1);
// compaction shadows the surface: the next step lost the snapshot and restores it
surface = [{ type: "user/message", data: { source: { kind: "user" } } }];
const outCompacted = await inject(2);
check("compaction restores snapshot mid-turn", outCompacted.messages.length === 2, `messages=${outCompacted.messages.length}`);
check("restored snapshot keeps <remember>", outCompacted.messages[1]?.content?.[0]?.text?.startsWith("<remember>"));

// migration marker created
await access(join(workspace, ".agents/memory/remember.json"));
check("store marker present", join(workspace, ".agents/memory/remember.json"));

// ---- global scope on a brand-new store ----
const globalWrite = await call("memory_write", { content: "Global smoke fact.", scope: "global" });
check("global write creates its store", /Saved to global/.test(globalWrite.text), globalWrite.text.split("\n")[0]);
check("global marker written first", await readFile(join(globalDir, "remember.json"), "utf8").then((text) => /"version": 1/.test(text)).catch(() => false));

// ---- migration gateway ----
const legacyWorkspace = join(base, "legacy");
const legacyStore = join(legacyWorkspace, ".pi", "memory");
await mkdir(join(legacyStore, "notes"), { recursive: true });
await mkdir(join(legacyStore, "recovery"), { recursive: true });
await writeFile(join(legacyStore, "pi-remember.json"), '{"version": 1}\n');
await writeFile(join(legacyStore, "MEMORY.md"), "<!-- 2026-10-18T16:10:33Z [deadbeef] -->\nLegacy fact.\n");
await writeFile(join(legacyStore, "notes", "2026-10-18-legacy.md"),
  '---\ndescription: "Legacy note"\nmemory-id: "feedface"\ncreated-date: "2026-10-18T16:10:33.000Z"\nlast-modified-date: "2026-10-18T16:10:33.000Z"\n---\nBody\n');
await writeFile(join(legacyStore, "recovery", "abcd1234.json"), '{"kind":"forget"}\n');

const legacyExec = { agent: {}, signal: exec.signal };
ctx.workingDirectory.ensure = async () => legacyWorkspace;
const dry = await tools.get("memory_migrate").execute({ dryRun: true }, legacyExec);
check("migrate dry run reports", /Dry run.*1 fact.*1 note/.test(dry.text), dry.text.split("\n")[0]);
await assertRejects(join(legacyWorkspace, ".agents", "memory", "remember.json"));

const real = await tools.get("memory_migrate").execute({}, legacyExec);
check("migrate writes target", /Migrated from/.test(real.text), real.text.split("\n")[0]);
const migratedMarker = JSON.parse(await readFile(join(legacyWorkspace, ".agents/memory/remember.json"), "utf8"));
check("target marker is remember.json", migratedMarker.version === 1);
const migratedFacts = await readFile(join(legacyWorkspace, ".agents/memory/MEMORY.md"), "utf8");
check("legacy fact copied", /Legacy fact/.test(migratedFacts));
const recoveryEntries = await readdir(join(legacyWorkspace, ".agents/memory"));
check("recovery not copied", !recoveryEntries.includes("recovery"), recoveryEntries.join(","));

// /memory migrate on a second legacy workspace
const secondWorkspace = join(base, "second");
const secondStore = join(secondWorkspace, ".pi", "memory");
await mkdir(secondStore, { recursive: true });
await writeFile(join(secondStore, "pi-remember.json"), '{"version": 1}\n');
await writeFile(join(secondStore, "MEMORY.md"), "<!-- 2026-10-18T16:10:33Z [cafebabe] -->\nSecond fact.\n");
ctx.workingDirectory.ensure = async () => secondWorkspace;
const result = await commands.get("memory").handler({ agent: {}, rawInput: "migrate", signal: exec.signal, attachments: [] });
check("/memory migrate works", result.kind === "success" && /Second|Migrated/.test(result.text), JSON.stringify(result).slice(0, 120));
const statusResult = await commands.get("memory").handler({ agent: {}, rawInput: "status", signal: exec.signal, attachments: [] });
check("/memory status works", statusResult.kind === "success" && /facts/.test(statusResult.text));

// migration notice injection
const thirdWorkspace = join(base, "third");
const thirdLegacy = join(thirdWorkspace, ".pi", "memory");
await mkdir(thirdLegacy, { recursive: true });
await writeFile(join(thirdLegacy, "pi-remember.json"), '{"version": 1}\n');
await writeFile(join(thirdLegacy, "MEMORY.md"), "<!-- 2026-10-18T16:10:33Z [abad1dea] -->\nNotice fact.\n");
ctx.workingDirectory.ensure = async () => thirdWorkspace;
let surface3 = [{ type: "user/message", data: { source: { kind: "user" } } }];
const agent3 = { session: { surface: { nodes: [0] }, eventAt: () => surface3[0] } };
const notice = await preStep({ agent: agent3, messages: [user], step: 1, signal: exec.signal },
  async () => ({ kind: "accept", messages: [user] }));
check("migration notice injected", /remember-migration/.test(notice.messages[1]?.content?.[0]?.text ?? ""), notice.messages[1]?.content?.[0]?.text?.slice(0, 60));

// in-place store: copied tree missing only the marker
const inPlaceWorkspace = join(base, "inplace");
const inPlaceStore = join(inPlaceWorkspace, ".agents", "memory");
await mkdir(inPlaceStore, { recursive: true });
await writeFile(join(inPlaceStore, "pi-remember.json"), '{"version": 1}\n');
await writeFile(join(inPlaceStore, "MEMORY.md"), "<!-- 2026-10-18T16:10:33Z [0123abcd] -->\nIn-place fact.\n");
ctx.workingDirectory.ensure = async () => inPlaceWorkspace;
const inPlace = await tools.get("memory_migrate").execute({}, { agent: {}, signal: exec.signal });
check("in-place migration detected", /in place|0 facts, 0 notes/.test(inPlace.text) || /fact/.test(inPlace.text), inPlace.text.split("\n")[0]);
check("in-place marker written", await readFile(join(inPlaceStore, "remember.json"), "utf8").then((text) => /"version": 1/.test(text)).catch(() => false));
check("in-place fact intact", /In-place fact/.test(await readFile(join(inPlaceStore, "MEMORY.md"), "utf8")));

async function assertRejects(path) {
  try { await readFile(path); check(`expected missing ${path}`, false); }
  catch { check(`nothing written to ${path}`, true); }
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
