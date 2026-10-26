export interface InjectOptions {
  maxGlobalChars: number;
  maxLocalChars: number;
  /** Enclosing tag; adapters brand the block without changing its bytes otherwise. */
  tag?: string;
  /** Override the one-paragraph explanation that precedes the scopes. */
  intro?: string;
  /**
   * Omit the outer `<tag>` lines. Hosts that wrap the block themselves (Pi's
   * named system-prompt sections) would otherwise nest two tags around it.
   * Everything inside the wrapper is byte-identical either way.
   */
  wrap?: boolean;
}

const DEFAULT_TAG = "remember";
const DEFAULT_INTRO =
  "Persistent memory: one-line facts plus a note catalogue derived from frontmatter (description, ID, dates, path). " +
  "Note bodies are NOT included; read them by ID or path when needed. Global = user/machine facts; Project = this workspace. " +
  "This snapshot is stable between turns and refreshes only when the store changes.";

export interface Snapshot {
  text: string;
  globalChars: number;
  localChars: number;
}

/** Keep head and tail, cut the middle. Recent and oldest facts survive. */
export function middleTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.2);
  const tail = maxChars - head;
  return (
    text.slice(0, head) +
    `\n...[truncated ${text.length - maxChars} chars]...\n` +
    text.slice(-tail)
  );
}

/**
 * Build the byte-stable injection block. Same input files => same output bytes,
 * so provider prefix caches stay valid across turns within a session.
 */
export function buildSnapshot(
  globalText: string,
  localText: string,
  projectName: string,
  opts: InjectOptions,
): Snapshot {
  const g = middleTruncate(globalText, opts.maxGlobalChars).trim();
  const l = middleTruncate(localText, opts.maxLocalChars).trim();
  if (!g && !l) return { text: "", globalChars: 0, localChars: 0 };
  const tag = opts.tag ?? DEFAULT_TAG;
  const parts: string[] = [opts.intro ?? DEFAULT_INTRO];
  if (g) parts.push("## Global memory", g);
  if (l) parts.push(`## Project memory (${projectName})`, l);
  const body = parts.join("\n\n");
  const text = opts.wrap === false ? body : `<${tag}>\n\n${body}\n\n</${tag}>`;
  return { text, globalChars: g.length, localChars: l.length };
}
