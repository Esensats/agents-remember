import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import {
  HStack, Input, Key, Markdown, ProcessTerminal, ScrollView, Text, TuiAltScreen, VStack,
  matchesKey, truncateToWidth, visibleWidth,
  type Component, type MarkdownTheme,
} from "@earendil-works/pi-tui";
import type { ScopeFilter } from "../args.ts";
import { createStyle, type Style } from "../render.ts";
import {
  createExplorerState, currentFilter, cycleScope, move, moveTo, selectedItem,
  setQuery, visibleItems,
  type ExplorerData, type ExplorerItem, type ExplorerState,
} from "./model.ts";

const MARKDOWN_ITALIC = (text: string) => `\x1b[3m${text}\x1b[23m`;
const MARKDOWN_STRIKE = (text: string) => `\x1b[9m${text}\x1b[29m`;

function markdownTheme(style: Style): MarkdownTheme {
  return {
    heading: style.heading,
    link: style.accent,
    linkUrl: style.dim,
    code: style.accent,
    codeBlock: (text) => text,
    codeBlockBorder: style.dim,
    quote: style.dim,
    quoteBorder: style.dim,
    hr: style.dim,
    listBullet: style.accent,
    bold: style.bold,
    italic: MARKDOWN_ITALIC,
    strikethrough: MARKDOWN_STRIKE,
    underline: MARKDOWN_ITALIC,
  };
}

class ListPane implements Component {
  private state: ExplorerState;
  private readonly style: Style;

  constructor(style: Style, state: ExplorerState) {
    this.style = style;
    this.state = state;
  }

  setState(state: ExplorerState): void { this.state = state; }
  invalidate(): void {}

  render(width: number): string[] {
    const items = visibleItems(this.state);
    if (items.length === 0) return [this.style.dim("  no matches")];
    const room = Math.max(4, width - 12);
    return items.map((item, index) => {
      const selected = index === this.state.selected;
      const marker = selected ? "▸ " : "  ";
      const id = (item.id ?? "—").padEnd(8);
      const title = item.title.replace(/\s+/g, " ");
      if (selected) {
        // truncateToWidth resets styling before its ellipsis; strip that reset so
        // the row highlight covers the ellipsis and the padding to the pane edge.
        const plain = `${marker}${id}  ${title}`;
        const clipped = visibleWidth(plain) <= width
          ? plain
          : `${truncateToWidth(plain, Math.max(1, width - 1), "").replace(/\x1b\[[0-9;]*m/g, "")}…`;
        return this.style.selected(clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))));
      }
      return `${marker}${this.style.dim(id)}  ${truncateToWidth(title, room, "…")}`;
    });
  }
}

class PreviewPane implements Component {
  private children: Component[] = [];
  private readonly style: Style;

  constructor(style: Style) {
    this.style = style;
    this.setItem(null);
  }

  setHint(text: string): void {
    this.children = [new Text(this.style.dim(text), 0, 0)];
  }

  setItem(item: ExplorerItem | null): void {
    if (!item) {
      this.children = [new Text(this.style.dim("select an entry"), 0, 0)];
      return;
    }
    const meta: string[] = [`${item.kind} · ${item.storeLabel} · ${item.id ?? "no id"}`];
    if (item.kind === "note") {
      meta.push(item.rel ?? item.subtitle);
      meta.push(`created ${item.created} · modified ${item.modified}`);
    } else {
      if (item.created) meta.push(`created ${item.created}`);
      if (item.path) meta.push(item.path);
    }
    const header = new Text(
      `${this.style.bold(item.title)}\n${meta.map((line) => this.style.dim(line)).join("\n")}`,
      0, 0,
    );
    const body: Component | null = item.kind === "note"
      ? (item.body ? new Markdown(item.body, 0, 0, markdownTheme(this.style)) : new Text(this.style.dim("(empty note)"), 0, 0))
      : null;
    this.children = body ? [header, new Text("", 0, 0), body] : [header];
  }

  invalidate(): void {
    for (const child of this.children) child.invalidate();
  }

  render(width: number): string[] {
    return this.children.flatMap((child) => child.render(width));
  }
}

class FilterInput extends Input {
  onChange?: (value: string) => void;
  override handleInput(data: string): void {
    super.handleInput(data);
    this.onChange?.(this.getValue());
  }
}

export interface ExplorerOptions {
  color: boolean;
  initialScope: ScopeFilter;
  /** Rebuild the data after an external editor changed the store. */
  reload?: () => Promise<ExplorerData>;
}

function shellWords(raw: string): string[] {
  return raw.trim().split(/\s+/).filter(Boolean);
}

function editorCommand(): string[] | null {
  const raw = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
  return raw ? shellWords(raw) : null;
}

function pagerCommand(): string[] {
  const raw = process.env.PAGER?.trim();
  return raw ? shellWords(raw) : ["less", "-R"];
}

function restoreSelection(next: ExplorerState, previous: ExplorerState): ExplorerState {
  const key = selectedItem(previous)?.key;
  if (!key) return next;
  const index = visibleItems(next).findIndex((item) => item.key === key);
  return index === -1 ? next : moveTo(next, index);
}

/**
 * Mount the explorer on the alternate screen. Resolves when the user quits;
 * every exit path restores the terminal (pi-tui also registers a last-resort
 * process-exit restore for paths that skip stop()).
 */
export async function runExplorer(data: ExplorerData, options: ExplorerOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("browse needs an interactive terminal; use ls/show/search for scripts.");
  }
  const style = createStyle(options.color);
  let state = createExplorerState(data, options.initialScope);
  let status = "";
  let busy = false;

  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal);
  const header = new Text("", 0, 0);
  const footer = new Text("", 0, 0);
  const list = new ListPane(style, state);
  const preview = new PreviewPane(style);
  const listScroll = new ScrollView(list, { scrollbar: "auto" });
  const previewScroll = new ScrollView(preview, { scrollbar: "auto", primary: true });
  const input = new FilterInput({ prompt: "/ ", placeholder: "filter facts and notes" });

  const main = new HStack([
    { component: listScroll, basis: 0, grow: 2, minSize: 18, shrink: 1 },
    {
      component: previewScroll, basis: 0, grow: 3, minSize: 30, shrink: 1,
      visible: ({ width }) => width >= 72,
    },
  ], { gap: 2 });
  const root = new VStack([
    { component: header, basis: 1, shrink: 0 },
    { component: main, basis: 0, grow: 1, minSize: 3 },
    { component: input, basis: 1, shrink: 0 },
    { component: footer, basis: 1, shrink: 0 },
  ]);
  tui.setLayoutRoot(root);
  tui.setFocus(input);

  function ensureVisible(): void {
    const viewport = listScroll.viewportHeight;
    if (viewport <= 0) return;
    const top = listScroll.scrollTop;
    if (state.selected < top) listScroll.scrollTo(state.selected);
    else if (state.selected >= top + viewport) listScroll.scrollTo(state.selected - viewport + 1);
  }

  function refresh(nextStatus = status): void {
    status = nextStatus;
    list.setState(state);
    list.invalidate();
    const items = visibleItems(state);
    const count = `${items.length}/${state.data.items.length}`;
    const warning = state.data.warnings.length > 0 ? style.warn(" !") : "";
    header.setText(
      `${style.bold("remember")} ${style.dim(state.data.workspace)}  ` +
      `${style.accent(currentFilter(state))}  ${count}${warning}`,
    );
    const item = selectedItem(state);
    const hint = "↑↓ move · enter open · ^g edit · tab scope · esc clear · ^c quit";
    footer.setText(truncateToWidth(
      status ? `${style.warn(status)}  ${style.dim(hint)}` : style.dim(hint),
      400, "…",
    ));
    if (item) preview.setItem(item);
    else if (state.data.items.length === 0) {
      preview.setHint(`No facts or notes in this workspace yet.\n\nLooked for ${state.data.dirName}/memory under ${state.data.workspace}.\n` +
        "Ask an agent to run memory_write or memory_store, or point --root at another workspace.");
    } else preview.setHint(state.query ? "Nothing matches this filter." : "Nothing matches this scope.");
    preview.invalidate();
    previewScroll.scrollTo(0);
    ensureVisible();
    tui.requestRender();
  }

  function runExternal(command: string[], path: string): string | null {
    // Leave no copy of the explorer behind while the editor/pager owns the screen.
    tui.stop({ preserveScreen: true });
    const [bin, ...args] = command;
    const result = spawnSync(bin, [...args, path], { stdio: "inherit" });
    if (result.error) return `cannot run ${bin}: ${result.error.message}`;
    return result.status === 0 ? null : `${bin} exited with ${result.status}`;
  }

  async function openExternal(useEditor: boolean): Promise<void> {
    const item = selectedItem(state);
    if (!item || busy) return;
    if (!item.path) {
      status = "no file path for this entry";
      tui.requestRender();
      return;
    }
    const command = useEditor ? editorCommand() : pagerCommand();
    if (!command) {
      status = "no $VISUAL/$EDITOR set";
      tui.requestRender();
      return;
    }
    busy = true;
    const problem = runExternal(command, item.path);
    let nextStatus = problem ?? `${useEditor ? "edited" : "opened"} ${basename(item.path)}`;
    if (useEditor && options.reload) {
      try {
        state = restoreSelection(createExplorerState(await options.reload(), currentFilter(state)), state);
      } catch (error) {
        nextStatus = `reload failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    tui.start();
    busy = false;
    refresh(nextStatus);
  }

  let finished = false;
  let finish: () => void = () => {};
  const onSignal = (): void => {
    try { tui.stop(); } finally { process.exit(130); }
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);

  const done = new Promise<void>((resolve) => {
    finish = (): void => {
      if (finished) return;
      finished = true;
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
      tui.stop();
      resolve();
    };
  });

  tui.addInputListener((chunk) => {
    if (finished || busy) return { consume: true };
    if (matchesKey(chunk, "ctrl+c")) { finish(); return { consume: true }; }
    if (matchesKey(chunk, Key.up) || matchesKey(chunk, "ctrl+p")) {
      state = move(state, -1);
      refresh("");
      return { consume: true };
    }
    if (matchesKey(chunk, Key.down) || matchesKey(chunk, "ctrl+n")) {
      state = move(state, 1);
      refresh("");
      return { consume: true };
    }
    if (matchesKey(chunk, Key.pageUp)) {
      state = move(state, -(listScroll.viewportHeight || 10));
      refresh("");
      return { consume: true };
    }
    if (matchesKey(chunk, Key.pageDown)) {
      state = move(state, listScroll.viewportHeight || 10);
      refresh("");
      return { consume: true };
    }
    if (matchesKey(chunk, Key.home)) {
      state = moveTo(state, 0);
      refresh("");
      return { consume: true };
    }
    if (matchesKey(chunk, Key.end)) {
      state = moveTo(state, visibleItems(state).length - 1);
      refresh("");
      return { consume: true };
    }
    if (matchesKey(chunk, Key.tab)) {
      state = cycleScope(state);
      refresh("");
      return { consume: true };
    }
    if (matchesKey(chunk, Key.enter) || matchesKey(chunk, Key.return)) {
      void openExternal(false);
      return { consume: true };
    }
    if (matchesKey(chunk, "ctrl+g")) {
      void openExternal(true);
      return { consume: true };
    }
    if (matchesKey(chunk, Key.escape) || matchesKey(chunk, Key.esc)) {
      if (input.getValue()) {
        input.setValue("");
        state = setQuery(state, "");
        refresh("");
      } else {
        finish();
      }
      return { consume: true };
    }
    return undefined;
  });

  input.onChange = (value) => {
    state = setQuery(state, value);
    refresh("");
  };

  try {
    tui.start();
    refresh("");
    await done;
  } finally {
    if (!finished) tui.stop();
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
  }
}
