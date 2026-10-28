import { basename } from "node:path";
import type { Context } from "@opencode/plugin";
import { ensureStoreVersion, readStoreVersion } from "@seangle/remember-core";
import { migrate } from "@seangle/remember-migrators";
import { loadConfig, storesFor, type RememberConfig } from "./context.ts";
import { detectForWorkspace, formatReport, snapshotFor, statusText, toolSpecs } from "./tools.ts";

/**
 * Offer a migration once per session when a legacy store exists and the target
 * is not initialized. The model asks the user; nothing is written without
 * consent.
 */
function createMigrationNotice() {
  const noticed = new Set<string>();
  return async function migrationNotice(sessionID: string, cwd: string, config: RememberConfig): Promise<string> {
    if (noticed.has(sessionID)) return "";
    try {
      const detection = await detectForWorkspace(cwd, config);
      if (!detection) return "";
      const targetVersion = await readStoreVersion({ dir: detection.target });
      if (targetVersion !== null) return "";
      noticed.add(sessionID);
      const where = detection.source === detection.target
        ? `at ${detection.source}, which is missing only remember.json`
        : `at ${detection.source}; no remember store exists at ${detection.target}`;
      return `<remember-migration>\nLegacy memory detected: ${detection.description} ${where}.\nAsk the user whether to migrate. If they agree, call memory_migrate (dryRun first if unsure). If they decline, continue without it and do not ask again this session.\n</remember-migration>`;
    } catch {
      // Detection is advisory; never block injection on it.
      return "";
    }
  };
}

/**
 * Mount the memory engine: ten model-facing tools, a `/memory` command, and a
 * system snapshot rebuilt for every model request. OpenCode assembles the
 * system prompt per call and never persists it, so appending the block is both
 * duplicate-free and cache-stable between writes without any session bookkeeping.
 */
export default {
  id: "remember",
  async setup(ctx: Context) {
    const config = loadConfig(ctx.options);
    const migrationNotice = createMigrationNotice();

    /** The session's workspace, not the plugin's location: sessions can move. */
    const cwdOf = async (sessionID: string): Promise<string> => {
      const session = await ctx.session.get({ sessionID });
      return session.location.directory;
    };

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "memory",
        description: "Persistent plain-file memory: facts, notes, lexical search, and recovery.",
      });
      for (const spec of toolSpecs({ config, cwdOf: (exec) => cwdOf(exec.sessionID) })) {
        editor.add({
          // "memory" is the namespace, so the effective name stays memory_write.
          name: spec.name.replace(/^memory_/, ""),
          options: { namespace: "memory" },
          description: spec.description,
          input: spec.parameters,
          execute: async (args, toolCtx) => {
            try {
              const result = await spec.execute(args as never, { sessionID: toolCtx.sessionID, signal: toolCtx.signal });
              return result.isError
                ? { content: result.text, metadata: { isError: true } }
                : { content: result.text };
            } catch (error) {
              return { content: `remember: ${(error as Error).message}`, metadata: { isError: true } };
            }
          },
        });
      }
    });

    await ctx.command.transform((editor) => {
      editor.add({
        name: "memory",
        description: "Show memory status, or migrate a legacy store with /memory migrate",
        execute: async ({ sessionID, prompt }) => {
          const input = prompt.text.trim().toLowerCase();
          const reply = async (text: string) => ctx.session.synthetic({ sessionID, text });
          if (input !== "" && input !== "status" && input !== "migrate") {
            return reply("Usage: /memory [status|migrate]");
          }
          let cwd: string;
          try {
            cwd = await cwdOf(sessionID);
          } catch (error) {
            return reply(`remember: cannot resolve this session's workspace: ${(error as Error).message}`);
          }
          if (input === "migrate") {
            try {
              const detection = await detectForWorkspace(cwd, config);
              if (!detection) return reply(`No legacy memory store found for ${cwd}.`);
              const report = await migrate({ source: detection.source, target: detection.target });
              return reply(formatReport(report));
            } catch (error) {
              return reply(`Migration refused: ${(error as Error).message}`);
            }
          }
          return reply(await statusText(storesFor(cwd, config), config, cwd));
        },
      });
    });

    await ctx.session.hook("context", async (event) => {
      if (!config.autoInject) return;
      try {
        const cwd = await cwdOf(event.sessionID);
        const stores = storesFor(cwd, config);

        // Adopt a copied tree that is missing only its marker; a failure
        // downgrades to "inject nothing", never to a broken request.
        for (const scope of ["global", "local"] as const) {
          try {
            await ensureStoreVersion(stores[scope]);
          } catch {
            return;
          }
        }

        const notice = await migrationNotice(event.sessionID, cwd, config);
        const snapshot = await snapshotFor(stores, config, basename(cwd));
        const text = [notice, snapshot.text].filter((part) => part.trim().length > 0).join("\n\n");
        if (!text) return;
        event.system.push({ type: "text", text });
      } catch {
        // Memory is background knowledge; a failed read must not fail a model call.
      }
    });
  },
};
