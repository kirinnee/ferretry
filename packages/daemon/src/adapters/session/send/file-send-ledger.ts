import { appendFile, mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ClockPort } from '../../../lib/ports.ts';
import type { SendLedger, SendRecord, SendSettlement } from '../../../lib/session/send/types.ts';
import { deepFreezeJson, type JsonValue } from '../../../lib/json.ts';
import type { SessionId } from '../../../lib/session-id.ts';

/** How many sessions' ledgers are kept read; the one read longest ago is let go first and read whole if asked again. */
export const SEND_LEDGERS_KEPT = 256;

/** What one session's ledger file said up to its last complete line, and which file that was. */
interface ReadLedger {
  /** Device and inode: a file put in its place is another file, read from its start. */
  readonly file: string;
  /** The bytes read so far, always just past a newline. */
  offset: number;
  size: number;
  modifiedAtMs: number;
  readonly records: Map<string, SendRecord>;
}

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
 *
 * READS ARE INCREMENTAL. The tracker, the service and every chat page's poll read the whole ledger, and a
 * long-lived lead's was 5.9 MB, parsed line by line on every look. What was parsed is kept per session with
 * the byte offset it reached, and a read parses only the lines appended since. The file stays the truth:
 * every read opens it and checks it first, and reads it whole again when it is another file (a new inode),
 * shorter than what was read, or rewritten in place (same size, new mtime). A complete last line without its
 * newline is answered but not kept, so the next read still sees the line its newline completes. Records are
 * frozen, because every reader shares them; nothing is kept on disk, so a restart starts from the file, and at most
 * {@link SEND_LEDGERS_KEPT} sessions are kept at once.
 */
export class FileSendLedger implements SendLedger {
  private readonly read = new Map<SessionId, ReadLedger>();
  /** One read of a session's file at a time, so two never move the same offset. */
  private readonly reading = new Map<SessionId, Promise<unknown>>();

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
    // A WITHDRAWN record is the one exception — nothing was ever typed for it, so the same id may
    // honestly start over, which is what the withdrawal promised its caller.
    if (existing !== undefined && existing.fate !== 'withdrawn') return { record: existing, created: false };
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

  async list(id: SessionId): Promise<readonly SendRecord[]> {
    return [...(await this.all(id)).values()];
  }

  async settle(id: SessionId, sendId: string, patch: SendSettlement): Promise<SendRecord | undefined> {
    const current = (await this.all(id)).get(sendId);
    // A tombstone is never settled again, and neither is a cancelled send — a tracker look that began
    // before the cancel must not write a stale fate over it — EXCEPT by proof it was delivered: then
    // the cancel came too late, and saying so is the truth rather than a stale fate.
    if (current === undefined || current.fate === 'withdrawn') return undefined;
    if (current.fate === 'cancelled' && patch.fate !== 'delivered') return undefined;
    const merged: Record<string, unknown> = { ...current, ...patch };
    // `undefined` in a patch CLEARS a field: a re-attempt must not carry the previous attempt's
    // deadline or reason forward, and JSON would silently keep the old value otherwise.
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete merged[key];
    const next = merged as unknown as SendRecord;
    await this.append(id, next);
    return next;
  }

  /** Every send this session has a record of, keyed by id, with the latest line for each winning. */
  async all(id: SessionId): Promise<Map<string, SendRecord>> {
    const previous = this.reading.get(id) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(async () => await this.caughtUp(id));
    this.reading.set(id, result);
    try {
      return await result;
    } finally {
      if (this.reading.get(id) === result) this.reading.delete(id);
    }
  }

  /** Every record, from what was read before and the bytes appended since. A missing file is no sends. */
  private async caughtUp(id: SessionId): Promise<Map<string, SendRecord>> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.file(id), 'r');
    } catch {
      this.read.delete(id);
      return new Map();
    }
    try {
      const information = await handle.stat();
      const file = `${String(information.dev)}:${String(information.ino)}`;
      const known = this.read.get(id);
      const same =
        known !== undefined &&
        known.file === file &&
        information.size >= known.offset &&
        (information.size !== known.size || information.mtimeMs === known.modifiedAtMs);
      const ledger: ReadLedger = same ? known : { file, offset: 0, size: 0, modifiedAtMs: 0, records: new Map() };
      const unread = information.size - ledger.offset;
      let tail: SendRecord | undefined;
      if (unread > 0) {
        const bytes = Buffer.alloc(unread);
        const { bytesRead } = await handle.read(bytes, 0, unread, ledger.offset);
        const read = bytes.subarray(0, bytesRead);
        const end = read.lastIndexOf(0x0a) + 1;
        for (const line of read.subarray(0, end).toString('utf8').split('\n')) {
          const record = parseRecord(line);
          if (record !== undefined) ledger.records.set(record.sendId, frozen(record));
        }
        ledger.offset += end;
        tail = parseRecord(read.subarray(end).toString('utf8'));
      }
      ledger.size = information.size;
      ledger.modifiedAtMs = information.mtimeMs;
      // Most recently read last, so the first key is the one to let go.
      this.read.delete(id);
      this.read.set(id, ledger);
      if (this.read.size > SEND_LEDGERS_KEPT) {
        const oldest = this.read.keys().next().value;
        if (oldest !== undefined) this.read.delete(oldest);
      }
      const records = new Map(ledger.records);
      if (tail !== undefined) records.set(tail.sendId, frozen(tail));
      return records;
    } finally {
      await handle.close();
    }
  }

  private async append(id: SessionId, record: SendRecord, reason?: string): Promise<void> {
    const file = this.file(id);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ ...record, at: this.clock.now(), ...(reason === undefined ? {} : { reason }) });
    await appendFile(file, `${line}\n`, { mode: 0o600 });
  }
}

const frozen = (record: SendRecord): SendRecord =>
  deepFreezeJson(record as unknown as JsonValue) as unknown as SendRecord;

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
