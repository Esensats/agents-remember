import { piRememberV1 } from "./pi-remember.ts";
import type { MemoryMigrator, MigrationDetection, MigrationPlan, MigrationReport } from "./types.ts";

export * from "./types.ts";
export { piRememberV1 } from "./pi-remember.ts";

/** Registered strategies, in the order a host should offer them. */
export const migrators: MemoryMigrator[] = [piRememberV1];

/** Default locations for one workspace root. */
export function defaultLocations(workspace: string): { source: string; target: string } {
  return { source: `${workspace}/.pi/memory`, target: `${workspace}/.agents/memory` };
}

/** Every strategy that recognizes the source and can write to an absent target. */
export async function detectMigrations(source: string, target: string): Promise<MigrationDetection[]> {
  const found: MigrationDetection[] = [];
  for (const migrator of migrators) {
    const version = await migrator.detect(source);
    if (version === null) continue;
    found.push({
      migrator: migrator.id,
      description: migrator.description,
      source,
      target,
      sourceVersion: version,
    });
  }
  return found;
}

/** Plan with one strategy (or the first that recognizes the source) and apply it. */
export async function migrate(options: {
  source: string;
  target: string;
  migrator?: string;
  dryRun?: boolean;
}): Promise<MigrationReport & { plan: MigrationPlan }> {
  const candidates = options.migrator
    ? migrators.filter((candidate) => candidate.id === options.migrator)
    : migrators;
  for (const migrator of candidates) {
    if (await migrator.detect(options.source) === null) continue;
    const plan = await migrator.plan(options.source, options.target);
    const report = await migrator.apply(plan, { dryRun: options.dryRun });
    return { ...report, plan };
  }
  throw new Error(`No migrator recognizes ${JSON.stringify(options.source)}${options.migrator ? ` (requested ${options.migrator})` : ""}.`);
}
