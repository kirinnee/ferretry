import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A selftest's own scratch directory: made fresh (owner-only, as `mkdtemp` does) and removed whole afterwards. */
export interface TempDirs {
  make(): Promise<string>;
  remove(path: string): Promise<void>;
}

export function nodeTempDirs(): TempDirs {
  return {
    make: async () => await mkdtemp(join(tmpdir(), 'fyd-selftest-')),
    remove: async path => await rm(path, { recursive: true, force: true }),
  };
}
