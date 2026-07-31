import { join } from 'node:path';

/** Where warden supervision keeps its artefacts inside the state home. */
export interface WardenPaths {
  readonly root: string;
  readonly reports: string;
}

export function createWardenPaths(state: string): WardenPaths {
  const root = join(state, 'warden');
  return { root, reports: join(root, 'reports') };
}
