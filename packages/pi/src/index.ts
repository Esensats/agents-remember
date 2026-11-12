import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { SnapshotLedger, ensureStoreVersion, readStoreVersion } from "@seangle/remember-core";
import { migrate } from "@seangle/remember-migrators";
import { registerMemoryCommand } from "./command.ts";
import { loadConfig, storesFor, type RememberConfig } from "./context.ts";
import {
  detectForWorkspace,
  formatReport,
  readSnapshotInputs,
  renderSnapshot,
  statusText,
  toolSpecs,
} from "./tools.ts";

/** System-prompt section name; Pi wraps it in a matching <remember> tag. */
const SNAPSHOT_SECTION = "remember";

/** Tools that can change what a snapshot shows. */
const MUTATING = new Set([
  "memory_init", "memory_write", "memory_store", "memory_update",
  "memory_forget", "memory_restore", "memory_migrate",
]);

/**
 * Offer a migration once per workspace and session when a legacy store exists
 * and the target is not initialized. The model asks the user; nothing is
 * written without consent.
 */
async function migrationNotice(cwd: string, config: RememberConfig): Promise<string> {
  try {
    const detection = await detectForWorkspace(cwd, config);
    if (!detection) return "";
    const targetVersion = await readStoreVersion({ dir: detection.target });
    if (targetVersion !== null) return "";
    const where = detection.source === detection.target
      ? `at ${detection.source}, which is missing only remember.json`
      : `at ${detection.source}; no remember store exists at ${detection.target}`;
    return `<remember-migration>\nLegacy memory detected: ${detection.description} ${where}.\nAsk the user whether to migrate. If they agree, call memory_migrate (dryRun first if unsure). If they decline, continue without it and do not ask again this session.\n</remember-migration>`;
  } catch {
    // Detection is advisory; never block injection on it.
    return "";
  }
}

/**
 * Mount the memory engine: ten model-facing tools, a `/memory` command, and one
 * system-prompt section.
 *
 * The section is written once per session and then held byte-identical. A
 * provider caches the request prefix and the system prompt is its first bytes,
 * so re-rendering the section after every memory write would discard that cache
 * every time. Later changes therefore travel as a `<system_reminder>` appended
 * to the end of the conversation, where no earlier byte moves.
 */
export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const ledger = new SnapshotLedger({ maxChars: config.deltaChars, maxSessions: 8 });
  let noticeWorkspace: string | null = null;
  /** Pi runs one session at a time; this is its key and its pending change block. */
  let sessionKey = "session";
  let reminder = "";

  const keyOf = (ctx: { sessionManager?: { getSessionId?: () => string } }): string => {
    try {
      return ctx.sessionManager?.getSessionId?.() ?? sessionKey;
    } catch {
      return sessionKey;
    }
  };

  /** Recompute the change block after a memory write, so the next request is current. */
  const refreshReminder = async (cwd: string): Promise<void> => {
    try {
      const inputs = await readSnapshotInputs(storesFor(cwd, config), config, cwd);
      reminder = ledger.has(sessionKey)
        ? ledger.delta(sessionKey, inputs.state, { globalText: inputs.globalText })
        : "";
    } catch {
      reminder = "";
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    noticeWorkspace = null;
    reminder = "";
    // Adopt a store that already exists without a marker (e.g. a copied tree),
    // and surface an invalid version instead of injecting nothing silently.
    const stores = storesFor(ctx.cwd, config);
    for (const scope of ["global", "local"] as const) {
      try {
        await withFileMutationQueue(stores[scope].memoryFile, () => ensureStoreVersion(stores[scope]));
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`pi-remember: ${scope} memory unavailable: ${String(error)}`, "warning");
      }
    }
  });

  /** A rebuilt conversation head costs the cache anyway: freeze afresh. */
  pi.on("session_compact", async (_event, ctx) => {
    ledger.forget(keyOf(ctx));
    reminder = "";
  });

  pi.on("session_shutdown", async () => {
    ledger.forget(sessionKey);
    reminder = "";
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!config.autoInject) {
      delete event.systemPromptOptions.sections[SNAPSHOT_SECTION];
      return;
    }
    sessionKey = keyOf(ctx);
    const inputs = await readSnapshotInputs(storesFor(ctx.cwd, config), config, ctx.cwd);

    const live = renderSnapshot(inputs, config, basename(ctx.cwd)).text;
    let frozen = ledger.text(sessionKey);
    if (frozen === null) {
      // Freeze only real content: an empty store leaves nothing at the head to
      // protect, and its first real snapshot may then appear without waste.
      if (live !== "") {
        ledger.freeze(sessionKey, inputs.state, live, inputs.globalText);
        frozen = live;
      }
      reminder = "";
    } else {
      reminder = ledger.delta(sessionKey, inputs.state, { globalText: inputs.globalText });
    }

    let notice = "";
    if (noticeWorkspace !== ctx.cwd) {
      notice = await migrationNotice(ctx.cwd, config);
      if (notice) noticeWorkspace = ctx.cwd;
    }
    // The migration notice is not memory: it rides with the reminder, so the
    // section stays byte-identical for the whole session.
    reminder = [notice, reminder].filter((part) => part.trim().length > 0).join("\n\n");

    const text = frozen ?? "";
    if (text) event.systemPromptOptions.sections[SNAPSHOT_SECTION] = text;
    else delete event.systemPromptOptions.sections[SNAPSHOT_SECTION];
  });

  /**
   * One provider request: the change block rides at the end as a context
   * message, which Pi sends as a user message and keeps out of the transcript.
   * Nothing is stored twice, and the block is never appended twice.
   */
  pi.on("context", async (event) => {
    if (!config.autoInject || !reminder) return;
    event.messages.push({
      role: "custom",
      customType: "remember-change",
      content: reminder,
      display: false,
      timestamp: Date.now(),
    } as never);
  });

  for (const spec of toolSpecs({ config })) {
    pi.registerTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      promptSnippet: spec.promptSnippet,
      promptGuidelines: spec.promptGuidelines,
      parameters: spec.parameters,
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        _onUpdate: unknown,
        toolCtx: { cwd: string },
      ) {
        try {
          const result = await (spec.execute as (args: unknown, exec: { cwd: string; signal?: AbortSignal }) => Promise<{ text: string; isError?: boolean }>)(
            params, { cwd: toolCtx.cwd, signal },
          );
          if (result.isError !== true && MUTATING.has(spec.name)) await refreshReminder(toolCtx.cwd);
          return {
            content: [{ type: "text" as const, text: result.text }],
            details: {},
            ...(result.isError ? { isError: true } : {}),
          };
        } catch (error) {
          return {
            content: [{ type: "text" as const, text: `remember: ${(error as Error).message}` }],
            details: {},
            isError: true,
          };
        }
      },
    });
  }

  registerMemoryCommand(pi, {
    status: async (ctx) => statusText(storesFor(ctx.cwd, config), config, ctx.cwd),
    migrate: async (ctx) => {
      const detection = await detectForWorkspace(ctx.cwd, config);
      if (!detection) return `No legacy memory store found for ${ctx.cwd}.`;
      try {
        const report = await migrate({ source: detection.source, target: detection.target });
        return formatReport(report);
      } catch (error) {
        return `Migration refused: ${(error as Error).message}`;
      }
    },
  });
}
