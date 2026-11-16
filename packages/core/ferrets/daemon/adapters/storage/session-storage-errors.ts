import type { StateDamage } from '@ferretry/kernel/contract';
import type { SessionId } from '../../lib/session-id.ts';

/**
 * The kinds of a refused document, a fixed vocabulary: the port's damage kinds for a file it could not read, and
 * `refused_write` for a value THIS daemon computed and the declared schema refused before it reached the disk (the file
 * on disk is then not what is wrong).
 */
export type InvalidDocumentKind = StateDamage['reason'] | 'refused_write';

export class InvalidStateDocumentError extends Error {
  constructor(
    readonly file: string,
    readonly reason: string,
    /** The kind, from a fixed vocabulary ({@link InvalidDocumentKind}): safe to log, never a quote of the file. */
    readonly damage: InvalidDocumentKind = 'schema',
    /**
     * The file as last written: the state port's version etag (inode, size and modification time), so the same damage
     * is the same report until the file is written again (any rewrite is a new etag, even of identical bytes; it is a
     * write identity, not a digest of the bytes). `undefined` when the port could not say.
     */
    readonly etag?: string,
  ) {
    super(`invalid JSON document ${file}: ${reason}`);
    this.name = 'InvalidStateDocumentError';
  }
}

export class MissingSessionJournalError extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly file: string,
  ) {
    super(`session ${sessionId} has lost its durable journal ${file}; refusing to treat it as empty`);
    this.name = 'MissingSessionJournalError';
  }
}

export class DurableEventIndexError extends Error {
  readonly durable = true;

  constructor(
    readonly sessionId: SessionId,
    options: ErrorOptions,
  ) {
    super(`event for ${sessionId} is durable in the journal but could not be indexed`, options);
    this.name = 'DurableEventIndexError';
  }
}
