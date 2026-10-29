import type { Scope } from "@seangle/remember-core";

export type ScopeFilter = Scope | "both";
export type CommandName =
  | "summary"
  | "ls"
  | "show"
  | "search"
  | "snapshot"
  | "recovery"
  | "browse"
  | "help"
  | "version";

/** Bad invocation or unusable configuration. Distinct from "nothing found". */
export class UsageError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface CliArgs {
  command: CommandName;
  positional: string[];
  scope: ScopeFilter;
  root: string | undefined;
  globalDir: string | undefined;
  dirName: string;
  json: boolean;
  color: boolean;
  limit: number;
  wrap: boolean;
  stats: boolean;
}

const COMMANDS = new Set<CommandName>([
  "summary", "ls", "show", "search", "snapshot", "recovery", "browse", "help", "version",
]);

/** Commands that take a positional argument. */
const REQUIRED_POSITIONAL: Partial<Record<CommandName, string>> = {
  show: "<id|path>",
  search: "<query>",
};

function isScope(value: string): value is ScopeFilter {
  return value === "global" || value === "local" || value === "both";
}

function value(argv: string[], index: number, flag: string): { value: string; next: number } {
  const arg = argv[index];
  const inline = arg.indexOf("=");
  if (inline !== -1) {
    const raw = arg.slice(inline + 1);
    if (!raw) throw new UsageError(`${flag} needs a value.`);
    return { value: raw, next: index + 1 };
  }
  const raw = argv[index + 1];
  if (raw === undefined || raw.startsWith("-")) throw new UsageError(`${flag} needs a value.`);
  return { value: raw, next: index + 2 };
}

/**
 * Parse argv without a dependency. Flags are accepted before or after the
 * subcommand; `--` ends flag parsing so a query may start with a dash.
 */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const positional: string[] = [];
  let scope: ScopeFilter = "both";
  let root: string | undefined;
  let globalDir: string | undefined;
  let dirName = env.REMEMBER_DIR_NAME?.trim() || ".agents";
  let json = false;
  let color = true;
  let limit = 20;
  let wrap = true;
  let stats = false;
  let helpFlag = false;
  let versionFlag = false;
  let flagsDone = false;

  for (let index = 0; index < argv.length;) {
    const arg = argv[index];
    if (flagsDone || !arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      index += 1;
      continue;
    }
    if (arg === "--") {
      flagsDone = true;
      index += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") { helpFlag = true; index += 1; continue; }
    if (arg === "-V" || arg === "--version") { versionFlag = true; index += 1; continue; }
    if (arg === "--json") { json = true; index += 1; continue; }
    if (arg === "--no-color") { color = false; index += 1; continue; }
    if (arg === "--no-wrap") { wrap = false; index += 1; continue; }
    if (arg === "--stats") { stats = true; index += 1; continue; }
    if (arg === "--scope" || arg.startsWith("--scope=")) {
      const parsed = value(argv, index, "--scope");
      if (!isScope(parsed.value)) throw new UsageError(`--scope must be global, local or both, not ${JSON.stringify(parsed.value)}.`);
      scope = parsed.value;
      index = parsed.next;
      continue;
    }
    if (arg === "--root" || arg.startsWith("--root=")) {
      const parsed = value(argv, index, "--root");
      root = parsed.value;
      index = parsed.next;
      continue;
    }
    if (arg === "--global-dir" || arg.startsWith("--global-dir=")) {
      const parsed = value(argv, index, "--global-dir");
      globalDir = parsed.value;
      index = parsed.next;
      continue;
    }
    if (arg === "--dir-name" || arg.startsWith("--dir-name=")) {
      const parsed = value(argv, index, "--dir-name");
      if (!/^[A-Za-z0-9._-]+$/.test(parsed.value)) throw new UsageError("--dir-name must be a single path segment.");
      dirName = parsed.value;
      index = parsed.next;
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const parsed = value(argv, index, "--limit");
      const parsedLimit = Number.parseInt(parsed.value, 10);
      if (!Number.isFinite(parsedLimit) || parsedLimit < 1) throw new UsageError("--limit must be a positive integer.");
      limit = parsedLimit;
      index = parsed.next;
      continue;
    }
    throw new UsageError(`Unknown option ${JSON.stringify(arg)}. Try "remember help".`);
  }

  const name = versionFlag ? "version" : helpFlag ? "help" : positional[0] ?? "summary";
  if (!COMMANDS.has(name as CommandName)) {
    throw new UsageError(`Unknown command ${JSON.stringify(name)}. Try "remember help".`);
  }
  const command = name as CommandName;
  const rest = command === "summary" ? positional : positional.slice(1);
  const required = REQUIRED_POSITIONAL[command];
  if (required && !rest[0]) throw new UsageError(`remember ${command} needs ${required}.`);

  return { command, positional: rest, scope, root, globalDir, dirName, json, color, limit, wrap, stats };
}
