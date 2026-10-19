import type { SendRecord as SendRecordView } from '@ferretry/protocol';
import type { TranscriptBatch, TranscriptIssueCode } from '../../transcript/types.ts';
import type { SessionTranscriptReader, TranscriptTarget } from '../transcript/reader.ts';
import type { SendEvidenceReading, SendEvidenceSource } from './tracker.ts';
import type { SendRecord } from './types.ts';

/**
 * A ledger record as the wire carries it.
 *
 * The payload file and the matched text are PRIVATE — paths inside the state home and the exact
 * instruction typed — and never cross the API. A withdrawn record is still served, as a tombstone, so
 * a reader holding the accepted row sees it retract rather than keep its chip forever.
 */
export function sendRecordView(record: SendRecord): SendRecordView {
  const withdrawn = record.fate === 'withdrawn';
  return {
    v: 1,
    sendId: record.sendId,
    acceptedAt: record.acceptedAt,
    acceptedTurn: record.acceptedTurn,
    path: record.path,
    message: record.message,
    attachmentIds: [...(record.attachmentIds ?? [])],
    fate: withdrawn ? 'accepted' : record.fate,
    ...(withdrawn ? { withdrawn: true } : {}),
    ...optional('turn', record.turn),
    ...optional('from', record.from),
    ...optional('fromName', record.fromName),
    ...optional('senderKind', record.senderKind),
    ...optional('replyExpected', record.replyExpected),
    ...optional('held', record.held),
    ...optional('fateAt', record.fateAt),
    ...optional('evidence', record.evidence),
    ...optional('unaccountedReason', record.unaccountedReason),
    ...optional('queuedAt', record.queuedAt),
    ...optional('queueProof', record.queueProof),
    ...optional('attempt', record.attempt),
    ...optional('attemptAt', record.attemptAt),
    ...optional('deadlineAt', record.deadlineAt),
    ...optional('retryable', record.retryable),
  };
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * Issues that make a transcript read BLIND to its newest records — the only ones a send could be
 * proven by. A read with one of these can prove presence of what it did see, never absence.
 */
const BLIND: ReadonlySet<TranscriptIssueCode> = new Set([
  'source-missing',
  'source-read-failed',
  'source-truncated',
  'oversized-record',
]);

/**
 * The tracker's evidence, read through the SAME provenance-resolved transcript reader every other
 * transcript surface uses, so a send is never proven by some other session's file.
 */
export class TranscriptSendEvidence implements SendEvidenceSource {
  constructor(
    private readonly target: (id: string) => Promise<TranscriptTarget | undefined>,
    private readonly reader: Pick<SessionTranscriptReader, 'read' | 'bound'>,
  ) {}

  async read(id: string): Promise<SendEvidenceReading> {
    const target = await this.target(id);
    const batch: TranscriptBatch | undefined = target === undefined ? undefined : await this.reader.read(target);
    if (batch === undefined) {
      // Told apart because the person's remedy differs: an unproven transcript never becomes readable
      // by waiting, while a proved one that failed to read may on the next look.
      const bound = target === undefined || (await this.reader.bound(target));
      return bound ? { readable: false, inputs: [] } : { readable: false, unbound: true, inputs: [] };
    }
    return { readable: !batch.issues.some(issue => BLIND.has(issue.code)), inputs: batch.observedInputs };
  }
}
