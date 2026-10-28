import { homedir } from "node:os";
import { join } from "node:path";
import { resolveStores, type Scope, type StorePaths } from "@seangle/remember-core";

/**
 * Deployment policy for the OpenCode adapter.
 *
 * The workspace store is shared with the other harnesses (`.agents/memory`), so
 * knowledge learned in one is visible in the others. The global store stays
 * harness-owned under OpenCode's data directory, like Pi's `~/.pi/agent/memory`.
 */
export interface RememberConfig {
  dirName: string;
  globalDir: string;
  injectCharsGlobal: number;
  injectCharsLocal: number;
  autoInject: boolean;
}

/** OpenCode's per-user data directory; XDG overrides follow the host's own rule. */
export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg && xdg.startsWith("/") ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode");
}

/** Expand a leading `~`; core's workspace resolver does the same for `root`. */
export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

function stringOption(options: Record<string, unknown>, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function intOption(options: Record<string, unknown>, name: string, fallback: number): number {
  const value = options[name];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Read plugin options from `opencode.json(c)`. A blank `globalDir` keeps the
 * default, so an omitted option and an empty one behave the same.
 */
export function loadConfig(options: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): RememberConfig {
  const globalDir = stringOption(options, "globalDir");
  return {
    dirName: stringOption(options, "dirName") ?? ".agents",
    globalDir: globalDir ? expandHome(globalDir) : join(dataDirectory(env), "memory"),
    injectCharsGlobal: intOption(options, "injectCharsGlobal", 3000),
    injectCharsLocal: intOption(options, "injectCharsLocal", 3000),
    autoInject: options.autoInject === undefined ? true : options.autoInject !== false,
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
