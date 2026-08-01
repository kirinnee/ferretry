import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ClockPort } from '../../../lib/ports.ts';
import type { SessionId } from '../../../lib/session-id.ts';
import type { SendLedger, SendRecord } from '../../../lib/session/send/types.ts';

/**
 * The durable send ledger, as an append-only log beside the session it belongs to.
 *
 * APPEND-ONLY, LAST-WRITE-WINS. A send is accepted before anything is typed, so the file must survive
 * a daemon that dies mid-keystroke — and a log that is only ever appended to cannot be corrupted by
 * one. A revision or a withdrawal writes a NEW line for the same `sendId` and the last one wins, so
 * the history of a send stays legible to a human reading the file after the fact. A truncated final
 * line — the signature of a crash during the append — is skipped rather than allowed to poison the
 * whole ledger.
 *
 * READ-MODIFY-WRITE IS SAFE HERE because every caller holds the session's own serial lock: the send
 * service takes it before accepting, revising or withdrawing. This class does not take one of its
 * own, which would be a second lock ordering to reason about for no benefit.
 */
export class FileSendLedger implements SendLedger {
  constructor(
    private readonly sessionDirectory: (id: SessionId) => string,
    private readonly clock: ClockPort,
  ) {}

  file(id: SessionId): string {
    return join(this.sessionDirectory(id), 'channel', 'sends.jsonl');
  }

  async accept(id: SessionId, record: SendRecord): Promise<{ record: SendRecord; created: boolean }> {
    const existing = (await this.all(id)).get(record.sendId);
    // The whole of idempotency: a retried request finds the first record and nothing is typed twice.
    if (existing !== undefined) return { record: existing, created: false };
    await this.append(id, record);
    return { record, created: true };
  }

  async revise(
    id: SessionId,
    sendId: string,
    patch: Partial<Pick<SendRecord, 'path' | 'matchText' | 'payloadFile' | 'held' | 'turn'>>,
  ): Promise<SendRecord | undefined> {
    const current = (await this.all(id)).get(sendId);
    // Only a LIVE accepted record may be revised. Revising a withdrawn or delivered one would rewrite
    // a settled fate as though it were still in flight.
    if (current === undefined || current.fate !== 'accepted') return undefined;
    const next: SendRecord = { ...current, ...patch };
    await this.append(id, next);
    return next;
  }

  async withdraw(id: SessionId, sendId: string, reason: string): Promise<SendRecord | undefined> {
    const current = (await this.all(id)).get(sendId);
    if (current === undefined || current.fate !== 'accepted') return undefined;
    const next: SendRecord = { ...current, fate: 'withdrawn' };
    await this.append(id, next, reason);
    return next;
  }

  /** Every send this session has a record of, keyed by id, with the latest line for each winning. */
  async all(id: SessionId): Promise<Map<string, SendRecord>> {
    const records = new Map<string, SendRecord>();
    const contents = await readFile(this.file(id), 'utf8').catch(() => undefined);
    if (contents === undefined) return records;
    for (const line of contents.split('\n')) {
      const record = parseRecord(line);
      if (record !== undefined) records.set(record.sendId, record);
    }
    return records;
  }

  private async append(id: SessionId, record: SendRecord, reason?: string): Promise<void> {
    const file = this.file(id);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ ...record, at: this.clock.now(), ...(reason === undefined ? {} : { reason }) });
    await appendFile(file, `${line}\n`, { mode: 0o600 });
  }
}

/** One line of the ledger, or nothing at all: a half-written final line is a crash, not a record. */
function parseRecord(line: string): SendRecord | undefined {
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
  // The three fields nothing downstream can work without. A line missing any of them is not a send
  // this daemon wrote, and guessing at the rest would put a fabricated record in front of a human.
  if (typeof record.sendId !== 'string' || typeof record.path !== 'string' || typeof record.fate !== 'string')
    return undefined;
  return record as unknown as SendRecord;
}
