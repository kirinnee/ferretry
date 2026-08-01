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

import type { TranscriptEvent, TranscriptHarness, TranscriptSource } from '../../transcript/types.ts';

/** The session facts a transcript read needs, projected out of whatever served them. */
export interface TranscriptTarget {
  readonly sessionId: string;
  readonly harness: TranscriptHarness;
}

/** Resolves a session's transcript file, discovering it when the record allows. */
export interface TranscriptFileResolver {
  file(sessionId: string): Promise<string | undefined>;
}

/** The most recent window of a transcript, which is all any in-flight question needs. */
export const DEFAULT_TRANSCRIPT_TAIL = 400;

export class SessionTranscriptReader {
  private readonly bySource: ReadonlyMap<TranscriptHarness, TranscriptSource>;

  constructor(
    sources: readonly TranscriptSource[],
    private readonly resolver: TranscriptFileResolver,
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
    const source = this.bySource.get(target.harness);
    if (source === undefined) return [];
    const file = await this.resolver.file(target.sessionId).catch(() => undefined);
    if (file === undefined) return [];
    const batch = await source.read(file, { sessionId: target.sessionId }).catch(() => undefined);
    if (batch === undefined) return [];
    return batch.events.slice(-limit);
  }
}
