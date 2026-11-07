/**
 * `@ferretry/kernel/worker`: what a plugin's worker thread imports to open the declared sqlite state files its half
 * granted at `kernel.workers.start(url, { state })`. The kernel resolved each inside the plugin's state folder on the
 * main thread; the worker can open those and nothing else, with the same format check, WAL and mode as the main
 * thread's `kernel.state.sqlite`.
 */
import { workerData } from 'node:worker_threads';
import type { StateFileDef } from './contract/define.ts';
import type { SqliteHandle } from './contract/ports.ts';
import { nodeSqliteFiles, openSqlite } from './host/state/sqlite-store.ts';

/** One file the half granted, as the kernel resolved it. */
export interface WorkerSqliteGrant {
  readonly file: { readonly name: string; readonly path: string; readonly store: string; readonly format: number };
  readonly name?: string;
  readonly path: string;
  readonly label: string;
}

/** The key the kernel puts its grants under in the worker's `workerData`. */
export const WORKER_STATE_KEY = 'ferretryState';

export interface WorkerStatePort {
  /** Opens a granted sqlite file; one the half did not grant (or granted under another shape) throws. */
  sqlite(def: StateFileDef, name?: string): SqliteHandle;
}

/** The grants this worker was started with (`data` is for a test of the worker module; a worker passes nothing). */
export function workerState(data: unknown = workerData): WorkerStatePort {
  const raw = (data as Record<string, unknown> | null | undefined)?.[WORKER_STATE_KEY];
  const grants: readonly WorkerSqliteGrant[] = Array.isArray(raw) ? (raw as WorkerSqliteGrant[]) : [];
  return {
    sqlite(def, name) {
      const grant = grants.find(
        g =>
          g.file.name === def.name &&
          g.file.path === def.path &&
          g.file.store === def.store &&
          g.file.format === def.format &&
          g.name === name,
      );
      if (grant === undefined)
        throw new TypeError(`state ${def.name}${name === undefined ? '' : ` ${name}`}: not granted to this worker`);
      return openSqlite(def, grant.path, grant.label, nodeSqliteFiles);
    },
  };
}
