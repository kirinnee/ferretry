import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ClockPort } from '../../../lib/ports.ts';
import type { AnswerLedger, AnswerOperationRecord } from '../../../lib/session/question/answer-ledger.ts';
import type { SessionId } from '../../../lib/session-id.ts';

/**
 * The durable answer receipt, as an append-only log beside the session it belongs to.
 *
 * APPEND-ONLY, LAST-WRITE-WINS, exactly as the send ledger is, and for the same reason: an answer is
 * recorded before anything is typed, so this file must survive a daemon that dies mid-keystroke — and
 * a log that is only ever appended to cannot be corrupted by one. Settling a receipt writes a NEW
 * line for the same request id and the last one wins, so a human reading the file after the fact sees
 * the whole history of an answer rather than its final opinion. A truncated final line — the exact
 * signature of a crash during the append — is skipped rather than allowed to poison the ledger.
 *
 * READ-MODIFY-WRITE IS SAFE HERE because every caller holds the session's own answer queue: the
 * coordinator takes it before reading and keeps it until the answer settles. This class takes no lock
 * of its own, which would be a second lock ordering to reason about for no benefit.
 *
 * SESSION SCOPE IS THE FILE'S LOCATION rather than a field, so a request id minted by a client of a
 * different daemon, or for a different session, cannot address this one.
 */
export class FileAnswerLedger implements AnswerLedger {
  constructor(
    private readonly sessionDirectory: (id: SessionId) => string,
    private readonly clock: ClockPort,
  ) {}

  file(id: SessionId): string {
    return join(this.sessionDirectory(id), 'channel', 'answers.jsonl');
  }

  async read(id: SessionId, requestId: string): Promise<AnswerOperationRecord | undefined> {
    return (await this.all(id)).get(requestId);
  }

  async append(id: SessionId, record: AnswerOperationRecord): Promise<void> {
    const file = this.file(id);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await appendFile(file, `${JSON.stringify({ ...record, at: this.clock.now() })}\n`, { mode: 0o600 });
  }

  /** Every answer this session has a receipt for, keyed by request id, latest line winning. */
  async all(id: SessionId): Promise<Map<string, AnswerOperationRecord>> {
    const records = new Map<string, AnswerOperationRecord>();
    const contents = await readFile(this.file(id), 'utf8').catch(() => undefined);
    if (contents === undefined) return records;
    for (const line of contents.split('\n')) {
      const record = parseRecord(line);
      if (record !== undefined) records.set(record.requestId, record);
    }
    return records;
  }
}

/** One line of the ledger, or nothing at all: a half-written final line is a crash, not a receipt. */
function parseRecord(line: string): AnswerOperationRecord | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  // The four fields nothing downstream can work without. A line missing any of them is not a receipt
  // this daemon wrote, and guessing at the rest would let a fabricated record authorize a second
  // drive of a live form.
  if (
    typeof record.requestId !== 'string' ||
    typeof record.toolUseId !== 'string' ||
    typeof record.fingerprint !== 'string' ||
    (record.outcome !== 'accepted' && record.outcome !== 'confirmed' && record.outcome !== 'withdrawn')
  )
    return undefined;
  return record as unknown as AnswerOperationRecord;
}
