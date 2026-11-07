import type { StatePort } from '@ferretry/kernel/contract';
import { SENDS_STATE } from '../../../contract/index.ts';
import { deepFreezeJson, type JsonValue } from '../../seams/json.ts';
import type { ClockPort } from '../../seams/ports.ts';
import type { SessionId } from '../../seams/ferret-id.ts';
import type { SendLedger, SendRecord, SendSettlement } from '../lib/types.ts';

/**
 * The durable send ledger, as an append-only log in the ferret's own state file.
 *
 * APPEND-ONLY, LAST-WRITE-WINS. A send is accepted before anything is typed, so the file must survive a daemon that
 * dies mid-keystroke. A revision or a withdrawal writes a NEW line for the same `sendId` and the last one wins, so the
 * history of a send stays legible to a human reading the file after the fact.
 *
 * READ-MODIFY-WRITE IS ONE TRANSACTION, serialized per ferret HERE: the send service writes under its ferret lock, but
 * the tracker writes under its own, and a tracker write that read a record before the service counted an Enter used to
 * append after it and put the count back (B144). Every accept, revise, withdraw and settle reads the latest record and
 * appends its successor with no other write to that ferret between. It is a leaf lock: nothing is awaited under it but
 * the state file.
 */
export class StateSendLedger implements SendLedger {
  /** One read-modify-append per ferret at a time: the tail of each ferret's chain of writes. */
  private readonly writing = new Map<SessionId, Promise<unknown>>();

  constructor(
    private readonly state: StatePort,
    private readonly clock: ClockPort,
  ) {}

  async accept(id: SessionId, record: SendRecord): Promise<{ record: SendRecord; created: boolean }> {
    return await this.transaction(id, async () => {
      const existing = (await this.all(id)).get(record.sendId);
      if (existing !== undefined && existing.fate !== 'withdrawn') return { record: existing, created: false };
      await this.append(id, record);
      return { record, created: true };
    });
  }

  async revise(
    id: SessionId,
    sendId: string,
    patch: Partial<Pick<SendRecord, 'path' | 'matchText' | 'payloadFile' | 'held' | 'turn'>>,
  ): Promise<SendRecord | undefined> {
    return await this.transaction(id, async () => {
      const current = (await this.all(id)).get(sendId);
      if (current === undefined || current.fate !== 'accepted') return undefined;
      const next: SendRecord = { ...current, ...patch };
      await this.append(id, next);
      return next;
    });
  }

  async withdraw(id: SessionId, sendId: string, reason: string): Promise<SendRecord | undefined> {
    return await this.transaction(id, async () => {
      const current = (await this.all(id)).get(sendId);
      if (current === undefined || current.fate !== 'accepted') return undefined;
      const next: SendRecord = { ...current, fate: 'withdrawn' };
      await this.append(id, next, reason);
      return next;
    });
  }

  async list(id: SessionId): Promise<readonly SendRecord[]> {
    return [...(await this.all(id)).values()];
  }

  async settle(id: SessionId, sendId: string, patch: SendSettlement): Promise<SendRecord | undefined> {
    return await this.transaction(id, async () => {
      const current = (await this.all(id)).get(sendId);
      if (current === undefined || current.fate === 'withdrawn') return undefined;
      if (current.fate === 'cancelled' && patch.fate !== 'delivered') return undefined;
      const merged: Record<string, unknown> = { ...current, ...patch };
      for (const [key, value] of Object.entries(patch)) if (value === undefined) delete merged[key];
      const next = merged as unknown as SendRecord;
      await this.append(id, next);
      return next;
    });
  }

  /** The latest line for each send, oldest acceptance first. */
  async all(id: SessionId): Promise<Map<string, SendRecord>> {
    const records = new Map<string, SendRecord>();
    for await (const line of this.state.lines<unknown>(SENDS_STATE, id)) {
      const record = parseRecord(line);
      if (record !== undefined) records.set(record.sendId, frozen(record));
    }
    return records;
  }

  private async transaction<T>(id: SessionId, work: () => Promise<T>): Promise<T> {
    const previous = this.writing.get(id) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
    this.writing.set(id, result);
    try {
      return await result;
    } finally {
      if (this.writing.get(id) === result) this.writing.delete(id);
    }
  }

  private async append(id: SessionId, record: SendRecord, reason?: string): Promise<void> {
    await this.state.append<unknown>(
      SENDS_STATE,
      { ...record, at: this.clock.now(), ...(reason === undefined ? {} : { reason }) },
      id,
    );
  }
}

const frozen = (record: SendRecord): SendRecord =>
  deepFreezeJson(record as unknown as JsonValue) as unknown as SendRecord;

function parseRecord(value: unknown): SendRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Partial<SendRecord>;
  if (Array.isArray(value)) return undefined;
  // The three fields nothing downstream can work without. A line missing any of them is not a send this daemon wrote.
  return typeof record.sendId === 'string' && typeof record.path === 'string' && typeof record.fate === 'string'
    ? (record as SendRecord)
    : undefined;
}
