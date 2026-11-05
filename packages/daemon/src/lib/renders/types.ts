import type { StoredRenderMeta } from '@ferretry/protocol';

/** The clock a save is stamped with. */
export interface RenderClock {
  now(): string;
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
