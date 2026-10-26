import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { ensureStoreVersion, readStoreVersion } from "@seangle/remember-core";
import { migrate } from "@seangle/remember-migrators";
import { registerMemoryCommand } from "./command.ts";
import { loadConfig, storesFor, type RememberConfig } from "./context.ts";
import { detectForWorkspace, formatReport, snapshotFor, statusText, toolSpecs } from "./tools.ts";

/** System-prompt section name; Pi wraps it in a matching <remember> tag. */
const SNAPSHOT_SECTION = "remember";

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
 * system-prompt section rebuilt at each run start. Pi patches the section only
 * when its bytes change, so the snapshot stays cache-stable between runs.
 */
export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  let noticeWorkspace: string | null = null;

  pi.on("session_start", async (_event, ctx) => {
    noticeWorkspace = null;
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

  pi.on("before_agent_start", async (event, ctx) => {
    if (!config.autoInject) {
      delete event.systemPromptOptions.sections[SNAPSHOT_SECTION];
      return;
    }
    const stores = storesFor(ctx.cwd, config);
    const snapshot = await snapshotFor(stores, config, basename(ctx.cwd));

    let notice = "";
    if (noticeWorkspace !== ctx.cwd) {
      notice = await migrationNotice(ctx.cwd, config);
      if (notice) noticeWorkspace = ctx.cwd;
    }

    const text = [notice, snapshot.text].filter((part) => part.trim().length > 0).join("\n\n");
    if (text) event.systemPromptOptions.sections[SNAPSHOT_SECTION] = text;
    else delete event.systemPromptOptions.sections[SNAPSHOT_SECTION];
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
