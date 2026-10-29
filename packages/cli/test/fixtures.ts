import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FACT_ONE = "Widgets pipeline needs the local proxy on port 8899.";
export const FACT_TWO = "Docker builds use the mirror in ~/.config/docker.";
export const NOTE_ID = "9b08e818";
export const NOTE_REL = "notes/2026-10-26-explorer-design.md";
export const NOTE_DESCRIPTION = "Explorer design for the remember CLI";

const MARKER = `${JSON.stringify({ version: 1 }, null, 2)}\n`;

export const INDEX = [
  "<!-- 2026-10-20T17:06:03Z [4f4cadfe] -->",
  FACT_ONE,
  "<!-- 2026-10-26T09:39Z [d786d59b] -->",
  FACT_TWO,
  "<!-- 2026-10-26T11:00Z [deadbeef] -->",
  "#note [[notes/missing-note.md]] A reference whose file was deleted",
  "",
].join("\n");

export const NOTE_TEXT = [
  "---",
  `description: "${NOTE_DESCRIPTION}"`,
  `memory-id: "${NOTE_ID}"`,
  'created-date: "2026-10-26T09:39Z"',
  'last-modified-date: "2026-10-26T10:12Z"',
  "---",
  "## Layout",
  "",
  "Facts stay in MEMORY.md; notes carry long-form knowledge.",
  "",
].join("\n");

export async function writeStore(dir: string, options: { marker?: boolean; index?: string; notes?: string[] } = {}): Promise<string> {
  await mkdir(join(dir, "notes"), { recursive: true });
  await mkdir(join(dir, "recovery"), { recursive: true });
  if (options.marker !== false) await writeFile(join(dir, "remember.json"), MARKER);
  await writeFile(join(dir, "MEMORY.md"), options.index ?? INDEX);
  if (options.notes === undefined) {
    await writeFile(join(dir, NOTE_REL), NOTE_TEXT);
  } else {
    for (const name of options.notes) {
      await writeFile(join(dir, "notes", name), NOTE_TEXT.replace(NOTE_ID, "1a2b3c4d"));
    }
  }
  return dir;
}

export interface Fixture {
  root: string;
  home: string;
  local: string;
  global: string;
  env: NodeJS.ProcessEnv;
}

/** Isolated workspace + home; only the Pi global store exists. */
export async function makeFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "remember-cli-"));
  const root = join(base, "workspace");
  const home = join(base, "home");
  const local = await writeStore(join(root, ".agents", "memory"));
  const global = await writeStore(join(home, ".pi", "agent", "memory"), {
    index: "<!-- 2026-10-19T01:16:00.343Z [60e142d9] -->\nGlobal fact about the machine.\n",
    notes: [],
  });
  // A recoverable deletion record, written in core's public shape.
  await writeFile(join(local, "recovery", "1a2b3c4d.json"), JSON.stringify({
    id: "1a2b3c4d", scope: "local", timestamp: "2026-10-26T10:20Z", kind: "forget",
    entries: [{ line: "An old fact" }], notes: [],
  }, null, 2));
  return {
    root, home, local, global,
    env: {
      XDG_DATA_HOME: join(home, "xdg"),
      DSH_HOME: join(home, "dsh"),
    },
  };
}
