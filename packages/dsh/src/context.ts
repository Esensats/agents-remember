import { homedir } from "node:os";
import { join } from "node:path";
import { resolveStores, type Scope, type StorePaths } from "@seangle/remember-core";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

/** Snapshot source tag, used to find our own message when reconciling a resume. */
export const SNAPSHOT_KIND = "remember";

export interface RememberConfig {
  dirName: string;
  globalDir: string;
  injectCharsGlobal: number;
  injectCharsLocal: number;
  autoInject: boolean;
}

/** Expand `~` without importing the host's shell helpers. */
function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

/** The global store lives beside the harness home unless the profile overrides it. */
export function globalDirectory(config: RememberConfig): string {
  return config.globalDir.trim() ? expandHome(config.globalDir.trim()) : join(resolveDshHome(), "memory");
}

/** Resolve both stores for one workspace root; nothing is created by resolution. */
export function storesFor(cwd: string, config: RememberConfig): Record<Scope, StorePaths> {
  return resolveStores(cwd, globalDirectory(config), config.dirName);
}
