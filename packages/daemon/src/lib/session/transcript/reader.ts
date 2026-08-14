/**
 * Reading one session's transcript — the capability the whole provenance record exists to enable.
 *
 * `TranscriptSource.read` takes an exact FILE. That is why it was unreachable: nothing in the
 * daemon could name one. With provenance persisted this is the join that makes it reachable, and
 * it is deliberately small — resolve the file, pick the source that speaks that harness, read.
 *
 * A SESSION WITH NO TRANSCRIPT READS AS EMPTY, NOT AS AN ERROR. That is the honest projection of
 * "the daemon cannot prove which file is yours", and every consumer already has to handle a
 * transcript with no matching evidence in it. What must never happen instead is a fallback to some
 * other session's file.
 */

import type { ConversationMessagePoint } from '@ferretry/protocol';
import type { TranscriptBatch, TranscriptEvent, TranscriptHarness, TranscriptSource } from '../../transcript/types.ts';
import {
  type ConversationDigest,
  ConversationDigestError,
  digestConversation,
  type PortableConversationRow,
  portableConversationRows,
} from './digest.ts';

/** The session facts a transcript read needs, projected out of whatever served them. */
export interface TranscriptTarget {
  readonly sessionId: string;
  readonly harness: TranscriptHarness;
}

/** Resolves a session's transcript file, discovering it when the record allows. */
export interface TranscriptFileResolver {
  file(sessionId: string): Promise<string | undefined>;
}

/** Proves the session's daemon-owned journal is present before a restartable digest is made. */
export interface TranscriptDigestJournal {
  assertReadable(sessionId: string): Promise<void>;
}

/** The most recent window of a transcript, which is all any in-flight question needs. */
export const DEFAULT_TRANSCRIPT_TAIL = 400;

export class SessionTranscriptReader {
  private readonly bySource: ReadonlyMap<TranscriptHarness, TranscriptSource>;

  constructor(
    sources: readonly TranscriptSource[],
    private readonly resolver: TranscriptFileResolver,
    private readonly journal?: TranscriptDigestJournal,
  ) {
    this.bySource = new Map(sources.map(source => [source.harness, source]));
  }

  /**
   * The tail of a session's transcript, or nothing.
   *
   * A read that throws — the file was deleted between resolution and open, the harness home was
   * unmounted — answers empty for the same reason an unresolved session does: this is evidence, and
   * missing evidence is not a reason to fail the operation that asked for it. The caller sees the
   * same shape either way and reports the absence in its own vocabulary.
   */
  async tail(target: TranscriptTarget, limit = DEFAULT_TRANSCRIPT_TAIL): Promise<readonly TranscriptEvent[]> {
    const batch = await this.read(target);
    return batch?.events.slice(-limit) ?? [];
  }

  /**
   * A complete, provenance-resolved transcript batch for a durable consumer.
   *
   * Unlike `tail`, this preserves parser issues so callers that need a complete conversation can
   * refuse rather than mistake a bounded or damaged read for an empty suffix.
   */
  async read(target: TranscriptTarget): Promise<TranscriptBatch | undefined> {
    const file = await this.resolver.file(target.sessionId).catch(() => undefined);
    if (file === undefined) return undefined;
    return await this.readFile(target, file);
  }

  /**
   * The same read, against a file the caller has ALREADY resolved.
   *
   * The resolution step is separated because it is not free of consequence: the discovering resolver
   * correlates a rollout and records that attribution back into the session, so a caller that must
   * resolve once, re-read the session's persisted configuration, and only then read the transcript
   * cannot go back through `resolver.file` without doing it twice. This is one byte read of exactly
   * the file it was handed, and it discovers nothing.
   */
  private async readFile(target: TranscriptTarget, file: string): Promise<TranscriptBatch | undefined> {
    const source = this.bySource.get(target.harness);
    if (source === undefined) return undefined;
    return await source.read(file, { sessionId: target.sessionId }).catch(() => undefined);
  }

  /**
   * The portable prefix ending at a durable message coordinate.
   *
   * This does not follow a running harness. The underlying source reads the exact transcript file
   * provenance recorded for this session, and `digestConversation` refuses every incomplete batch.
   */
  async digest(target: TranscriptTarget, through: ConversationMessagePoint): Promise<ConversationDigest> {
    if (this.journal === undefined)
      throw new ConversationDigestError(
        'incomplete_transcript',
        `session ${target.sessionId} has no daemon journal proof for a restartable transcript digest`,
      );
    await this.journal.assertReadable(target.sessionId);
    const batch = await this.read(target);
    if (batch === undefined)
      throw new ConversationDigestError(
        'incomplete_transcript',
        `transcript for ${target.sessionId} cannot be resolved and read completely`,
      );
    return digestConversation(target.sessionId, batch, through);
  }

  /**
   * Every portable message of this session's transcript, each bound to the commitment for the
   * physical record it came from.
   *
   * ONE read serves the whole page. The rows a caller may select and the evidence it binds them
   * with come from the same complete batch, so nothing here can offer a row whose prefix it did not
   * see. A batch that carries no record bytes refuses inside the digest rather than being served
   * without evidence.
   *
   * `undefined` keeps the reader's existing distinction: the daemon cannot name or read a transcript
   * for this session at all, which is missing evidence rather than damaged evidence. A transcript
   * that EXISTS and cannot honestly yield rows throws `ConversationDigestError` instead, and the two
   * answers stay distinct all the way to the caller.
   */
  async portableRows(target: TranscriptTarget): Promise<readonly PortableConversationRow[] | undefined> {
    await this.requireJournalProof(target);
    const file = await this.resolver.file(target.sessionId).catch(() => undefined);
    if (file === undefined) return undefined;
    return this.rowsOf(target, await this.readFile(target, file));
  }

  /**
   * The same page, against an ALREADY-RESOLVED transcript file: journal proof, then ONE byte read.
   *
   * This is the operation production composes with, because resolution has to happen first and
   * separately — the discovering resolver may persist an attribution, and the caller re-reads the
   * session's completed configuration, provenance and incarnation before it reads a single
   * transcript byte. Coming back through the resolver here would resolve a second time, against
   * facts the caller has already pinned.
   */
  async portableRowsFromFile(
    target: TranscriptTarget,
    file: string,
  ): Promise<readonly PortableConversationRow[] | undefined> {
    await this.requireJournalProof(target);
    return this.rowsOf(target, await this.readFile(target, file));
  }

  private rowsOf(
    target: TranscriptTarget,
    batch: TranscriptBatch | undefined,
  ): readonly PortableConversationRow[] | undefined {
    return batch === undefined ? undefined : portableConversationRows(target.sessionId, batch);
  }

  private async requireJournalProof(target: TranscriptTarget): Promise<void> {
    if (this.journal === undefined)
      throw new ConversationDigestError(
        'incomplete_transcript',
        `session ${target.sessionId} has no daemon journal proof for a restartable transcript read`,
      );
    await this.journal.assertReadable(target.sessionId);
  }
}
