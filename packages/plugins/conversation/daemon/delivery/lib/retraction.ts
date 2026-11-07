import type { SessionId } from '../../seams/ferret-id.ts';
import type { SendRecord } from './types.ts';

/**
 * &B153 — PROVING A HARNESS TOOK A DELIVERED POINTER BACK, rather than a person recalling it.
 *
 * On 2026-11-06 a lead's turn-007 pointer was submitted and Claude Code wrote its user record — then, before
 * any reply, rewound it into the composer. The same pointer can sit in the box for a harmless reason too: a
 * person pressed Up and recalled the last prompt, which the agent had long answered. The screen cannot tell
 * the two apart; the transcript can. Every record Claude writes in answer to a prompt chains to it by
 * `parentUuid`, and a rewound prompt is skipped — the next record parents to the one before it. So a delivered
 * pointer is the harness's to finish ONLY when its own user record is in the transcript and NOTHING names it as
 * a parent. Anything less — another harness, a record outside what was read, an unreadable file — is
 * `unknown`, and an unknown is never pressed: the text stays for a person.
 *
 * ONE REPAIR PER SEND. The send path presses a taken-back pointer once; taken back again it is flagged and escalated,
 * never pressed again — its earlier user records are no longer on the ledger to prove anything against.
 *
 * DECLARED GAP: the proof says the RECORD was never answered, not who put the text in the box now. A person who
 * clears a taken-back pointer and types or recalls exactly the same pointer gets it pressed. That text is byte for
 * byte this session's own unanswered turn instruction, so the press does what both meant; any edit breaks the exact
 * match and nothing is pressed.
 */

/** What the transcript proves about the answer to one user record. */
export type ReplyProof = 'answered' | 'unanswered' | 'unknown';

/** How many bytes from a transcript's END the proof reads: the newest turn's records sit there. */
export const RETRACTION_TAIL_BYTES = 8 * 1024 * 1024;

/** A Claude record id: a UUID. Anything else cannot be searched for safely and proves nothing. */
const RECORD_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Reads `tail` — the end of a Claude transcript, possibly starting mid-record — for the record `key` and for any
 * record answering it. `answered` once any record names it as `parentUuid`; `unanswered` when the record itself
 * is there and none does; `unknown` when the record is not in what was read or the key is not a record id.
 */
export function replyProofInTail(tail: string, key: string): ReplyProof {
  if (!RECORD_KEY.test(key)) return 'unknown';
  if (new RegExp(`"parentUuid"\\s*:\\s*"${key}"`, 'iu').test(tail)) return 'answered';
  return new RegExp(`"uuid"\\s*:\\s*"${key}"`, 'iu').test(tail) ? 'unanswered' : 'unknown';
}

/** Reads the end of a session's transcript. */
export interface SendTranscriptTail {
  /** Up to `bytes` from the end of the session's own transcript, or `undefined` when it cannot be read. */
  tail(id: SessionId, bytes: number): Promise<string | undefined>;
}

/** The send path's port: whether a delivered send's user record is proven never answered. */
export interface SendRetractionProof {
  unanswered(id: SessionId, record: SendRecord): Promise<boolean>;
}

/**
 * The proof over a transcript tail. Only a Claude send settled on its own user record can be proven: that is
 * the harness this was seen in and whose records chain by `parentUuid`. Every failure answers `false`.
 */
export class TranscriptRetractionProof implements SendRetractionProof {
  constructor(
    private readonly transcript: SendTranscriptTail,
    private readonly bytes: number = RETRACTION_TAIL_BYTES,
  ) {}

  async unanswered(id: SessionId, record: SendRecord): Promise<boolean> {
    const evidence = record.evidence;
    if (record.fate !== 'delivered' || evidence?.harness !== 'claude' || evidence.proof !== 'normal-user-record')
      return false;
    const tail = await this.transcript.tail(id, this.bytes).catch(() => undefined);
    return tail !== undefined && replyProofInTail(tail, evidence.key) === 'unanswered';
  }
}
