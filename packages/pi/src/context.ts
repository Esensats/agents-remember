import { homedir } from "node:os";
import { join } from "node:path";
import { resolveStores, type Scope, type StorePaths } from "@seangle/remember-core";

/**
 * Deployment policy for the Pi adapter.
 *
 * The workspace store is shared with the DeepSeek Harness (`.agents/memory`), so
 * both harnesses read and write the same facts and notes. The global store stays
 * in Pi's home: machine-wide memory is harness-owned, not a shared file.
 */
export interface RememberConfig {
  dirName: string;
  globalDir: string;
  injectCharsGlobal: number;
  injectCharsLocal: number;
  autoInject: boolean;
  /** Look for child workspaces that keep a memory bank of their own. */
  nested: boolean;
  /** Directory levels below the workspace root, defaults to 2. */
  nestedDepth: number;
  /** Budget of the nested-bank section, header included. */
  injectCharsNested: number;
  /** Budget of one `<system_reminder>` block that carries a later change. */
  deltaChars: number;
  /**
   * Create the project store on the first write instead of requiring
   * `memory_init` first. Most workspaces have no store, and a write that fails
   * there teaches the model not to try again.
   */
  autoInit: boolean;
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function falsy(value: string | undefined): boolean {
  return value !== undefined && ["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Expand a leading `~`; core's workspace resolver does the same for `root`. */
export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RememberConfig {
  const globalDir = env.REMEMBER_GLOBAL_DIR?.trim();
  return {
    dirName: env.REMEMBER_DIR_NAME?.trim() || ".agents",
    globalDir: globalDir ? expandHome(globalDir) : join(homedir(), ".pi", "agent", "memory"),
    injectCharsGlobal: intEnv(env, "REMEMBER_INJECT_CHARS_GLOBAL", 3000),
    injectCharsLocal: intEnv(env, "REMEMBER_INJECT_CHARS_LOCAL", 3000),
    autoInject: env.REMEMBER_AUTO_INJECT === undefined ? true : truthy(env.REMEMBER_AUTO_INJECT),
    nested: !falsy(env.REMEMBER_NESTED),
    nestedDepth: Math.min(8, intEnv(env, "REMEMBER_NESTED_DEPTH", 2)),
    injectCharsNested: intEnv(env, "REMEMBER_INJECT_CHARS_NESTED", 600),
    deltaChars: intEnv(env, "REMEMBER_DELTA_CHARS", 900),
    autoInit: !falsy(env.REMEMBER_AUTO_INIT),
  };
}

/** Resolve both stores for one workspace root; nothing is created by resolution. */
export function storesFor(cwd: string, config: RememberConfig): Record<Scope, StorePaths> {
  return resolveStores(cwd, config.globalDir, config.dirName);
}

/** Default legacy source for a workspace: pi-remember's own layout. */
export function legacySource(cwd: string): string {
  return join(cwd, ".pi", "memory");
}
