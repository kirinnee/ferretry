import { join } from 'node:path';

/** Where warden supervision keeps its artefacts inside the state home. */
export interface WardenPaths {
  readonly root: string;
  readonly reports: string;
  /** Jev's checks, one file per UTC day, beside the reports (`jev-checks.ts`). */
  readonly jevChecks: string;
}

export function createWardenPaths(state: string): WardenPaths {
  const root = join(state, 'warden');
  return { root, reports: join(root, 'reports'), jevChecks: join(root, 'jev-checks') };
}
