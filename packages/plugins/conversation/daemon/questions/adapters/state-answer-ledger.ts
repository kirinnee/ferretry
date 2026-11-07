import type { StatePort } from '@ferretry/kernel/contract';
import { ANSWERS_STATE } from '../../../contract/index.ts';
import type { SessionId } from '../../seams/ferret-id.ts';
import type { ClockPort } from '../../seams/ports.ts';
import type { AnswerLedger, AnswerOperationRecord } from '../lib/answer-ledger.ts';

/**
 * The answer ledger, one receipt per line in the ferret's own state file; the last line written for a request id is
 * the one that counts. The receipt is written BEFORE any key is driven and read back after a restart, so a request
 * that was accepted but never confirmed is never driven twice.
 */
export class StateAnswerLedger implements AnswerLedger {
  constructor(
    private readonly state: StatePort,
    private readonly clock: ClockPort,
    private readonly appended: (id: SessionId) => void = () => undefined,
  ) {}

  async read(id: SessionId, requestId: string): Promise<AnswerOperationRecord | undefined> {
    return (await this.all(id)).get(requestId);
  }

  async append(id: SessionId, record: AnswerOperationRecord): Promise<void> {
    // A resolution is the same receipt as accepted, with how it resolved, so a reader never mistakes the file for
    // one that records two different promises about one request.
    const durable =
      record.outcome === 'failed' || record.outcome === 'quarantined' || record.outcome === 'acknowledged'
        ? { ...record, outcome: 'accepted', resolution: record.outcome }
        : record;
    await this.state.append<unknown>(ANSWERS_STATE, { ...durable, at: this.clock.now() }, id);
    this.appended(id);
  }

  async all(id: SessionId): Promise<Map<string, AnswerOperationRecord>> {
    const records = new Map<string, AnswerOperationRecord>();
    for await (const line of this.state.lines<unknown>(ANSWERS_STATE, id)) {
      const record = parseRecord(line);
      if (record !== undefined) records.set(record.requestId, record);
    }
    return records;
  }
}

const OUTCOMES = new Set(['accepted', 'confirmed', 'withdrawn', 'failed', 'quarantined', 'acknowledged']);

function parseRecord(value: unknown): AnswerOperationRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.requestId !== 'string' ||
    typeof record.toolUseId !== 'string' ||
    typeof record.fingerprint !== 'string' ||
    typeof record.acceptedAt !== 'string' ||
    typeof record.outcome !== 'string'
  )
    return undefined;
  const resolution =
    record.outcome === 'accepted' &&
    (record.resolution === 'failed' || record.resolution === 'quarantined' || record.resolution === 'acknowledged')
      ? record.resolution
      : undefined;
  const known = OUTCOMES.has(record.outcome) ? (record.outcome as AnswerOperationRecord['outcome']) : undefined;
  const outcome: AnswerOperationRecord['outcome'] = resolution ?? known ?? 'accepted';
  const reason =
    typeof record.reason === 'string'
      ? record.reason
      : known !== undefined
        ? undefined
        : `the answer ledger contains the unrecognized outcome ${JSON.stringify(record.outcome)}; it was quarantined rather than treated as permission to drive`;
  return {
    requestId: record.requestId,
    toolUseId: record.toolUseId,
    fingerprint: record.fingerprint,
    acceptedAt: record.acceptedAt,
    outcome,
    ...(reason === undefined ? {} : { reason }),
  };
}
