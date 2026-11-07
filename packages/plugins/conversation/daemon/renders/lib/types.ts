import type { Instant } from '@ferretry/std';
import type { StoredRenderMeta } from '../../../contract/index.ts';

/** The clock a save is stamped with. */
export interface RenderClock {
  now(): Instant;
}

/**
 * Where renders are kept. A render is two records: the payload, then the meta that points at it, written
 * in that order so a crash can leave an unreferenced payload but never meta that points at nothing.
 */
export interface RenderRepository {
  /** Every render's meta that parses. A damaged record is skipped here and never served. */
  listMetas(): Promise<readonly StoredRenderMeta[]>;
  /** The payload text, or `undefined` when there is none. */
  readPayload(id: string): Promise<string | undefined>;
  /** Writes the payload and then the meta. Writing the same render again is the same write. */
  write(meta: StoredRenderMeta, payload: string): Promise<void>;
}

export type RenderErrorCode =
  | 'invalid'
  | 'supersedes_not_found'
  | 'quota_exceeded'
  | 'not_found'
  | 'damaged'
  | 'id_space_exhausted'
  | 'busy';

/** The refusal for a save past the in-flight bound: the same sentence from the mount's early check and the service's own. */
export const busyError = (): RenderError => new RenderError('busy', 'too many pictures are being saved at once; retry');

/** A render refusal the HTTP mount turns into a status. The message is the sentence the saver reads. */
export class RenderError extends Error {
  constructor(
    readonly code: RenderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

/** Runs saves one at a time: the collision check and the quotas read the whole store. */
export interface RenderExecutor {
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
}

/** The one-at-a-time queue a render store saves through (today's `KeyedSerialExecutor.runExclusive`, for the one key). */
export function serialExecutor(): RenderExecutor {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    runExclusive: <T>(work: () => Promise<T>): Promise<T> => {
      const run = tail.then(work, work);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}
