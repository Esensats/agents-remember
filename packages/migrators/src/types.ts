/** One legacy store discovered at a source path. */
export interface MigrationDetection {
  migrator: string;
  description: string;
  source: string;
  target: string;
  sourceVersion: number;
}

export interface PlannedNote {
  rel: string;
  text: string;
  id: string;
  description: string;
}

export interface SkippedItem {
  rel: string;
  reason: string;
}

export interface MigrationPlan {
  migrator: string;
  source: string;
  target: string;
  /** True when source and target are the same directory (marker-only conversion). */
  inPlace: boolean;
  facts: number;
  memoryText: string;
  notes: PlannedNote[];
  skipped: SkippedItem[];
  warnings: string[];
}

export interface MigrationReport {
  ok: true;
  migrator: string;
  source: string;
  target: string;
  dryRun: boolean;
  facts: number;
  notes: number;
  skipped: SkippedItem[];
  warnings: string[];
  wrote: string[];
}

export interface MigrationOptions {
  dryRun?: boolean;
}

/**
 * A migration strategy. `detect` is cheap and read-only; `plan` validates the
 * whole source before anything is written; `apply` publishes the plan.
 */
export interface MemoryMigrator {
  id: string;
  description: string;
  detect(source: string): Promise<number | null>;
  plan(source: string, target: string): Promise<MigrationPlan>;
  apply(plan: MigrationPlan, options?: MigrationOptions): Promise<MigrationReport>;
}

export class MigrationError extends Error {
  constructor(message: string) { super(message); this.name = "MigrationError"; }
}
