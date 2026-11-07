import { describe, expect, test } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import {
  ANSWERS_STATE,
  AnswerLineSchema,
  CONVERSATION_STATE,
  INBOX_STATE,
  InboxLineSchema,
  OUTBOX_STATE,
  OutboxLineSchema,
  QUEUE_STATE,
  QueueEventSchema,
  SENDS_STATE,
  SendLineSchema,
  SendRecordSchema,
} from '../../contract/index.ts';
import { StateSendChannel, StateSendLedger } from '../../daemon/delivery/adapters/index.ts';
import { StateQueueStore } from '../../daemon/queue/adapters/index.ts';
import { StateAnswerLedger } from '../../daemon/questions/adapters/index.ts';
import { parseSessionId } from '../../daemon/seams/ferret-id.ts';
import { memoryStatePort } from '../support/state.ts';

/**
 * The line schemas the contract exports are what the stores really write: every line a store appends parses, whole and
 * strict, so the doc comments that used to describe the WIRE VIEW as "one entry of the file" no longer have to.
 */

const ID = parseSessionId('f1');
const AT = '2026-11-07T09:00:00.000Z' as Instant;
const clock = { now: () => AT };

const linesOf = async (state: StatePort, file: Parameters<StatePort['lines']>[0]): Promise<unknown[]> => {
  const lines: unknown[] = [];
  for await (const line of state.lines(file, 'f1')) lines.push(line);
  return lines;
};

describe('the queue file is a log of events', () => {
  test('every event the store appends parses as a QueueEventSchema line', async () => {
    const state = memoryStatePort(CONVERSATION_STATE);
    const store = new StateQueueStore(state);
    await store.append(ID, {
      v: 1,
      kind: 'enqueued',
      at: AT,
      message: {
        v: 1,
        id: 'm1',
        sender: 'agent',
        from: 'f2',
        by: { kind: 'ferret', name: 'lead' },
        text: 'hello',
        attachmentIds: [],
        label: 'action',
        holdUntil: AT,
        enqueuedAt: AT,
        state: 'queued',
        stateAt: AT,
        revision: 1,
      },
    });
    await store.append(ID, { v: 1, kind: 'edited', at: AT, id: 'm1', text: 'hello again', revision: 2 });
    await store.append(ID, { v: 1, kind: 'waiting', at: AT, id: 'm1', reason: 'draft', behind: 'send-1' });
    await store.append(ID, { v: 1, kind: 'moved', at: AT, id: 'm1', state: 'typing', batch: 'm1' });
    await store.append(ID, { v: 1, kind: 'moved', at: AT, id: 'm1', state: 'failed', failure: 'no pane' });

    const lines = await linesOf(state, QUEUE_STATE);

    expect(lines).toHaveLength(5);
    for (const line of lines) expect(QueueEventSchema.parse(line)).toEqual(line as never);
    expect(QueueEventSchema.safeParse({ v: 1, kind: 'moved', at: AT, id: 'm1', state: 'sent' }).success).toBe(false);
  });
});

describe('the send ledger file is the daemon’s own record, not the wire view', () => {
  test('every record the ledger appends parses as a SendLineSchema line, with the daemon’s bookkeeping', async () => {
    const state = memoryStatePort(CONVERSATION_STATE);
    const ledger = new StateSendLedger(state, clock);
    await ledger.accept(ID, {
      sendId: 'k1',
      acceptedAt: AT,
      acceptedTurn: 2,
      path: 'native-file',
      message: 'text',
      matchText: 'Read the file',
      attachmentIds: ['att_1'],
      from: 'f2',
      fromName: 'lead',
      senderKind: 'agent',
      by: { kind: 'ferret', name: 'lead', sections: ['fyi'] },
      batch: [{ queueId: 'k1', from: 'f2' }],
      replyExpected: true,
      payloadFile: '/state/queued-k1.md',
      fate: 'accepted',
    });
    await ledger.settle(ID, 'k1', {
      fate: 'unaccounted',
      fateAt: AT,
      unaccountedReason: 'timeout',
      attempt: 2,
      attemptAt: AT,
      deadlineAt: AT,
      typedNotSent: true,
      submitNudges: 1,
      busyTyped: true,
      untyped: false,
      noticesOwed: [{ from: 'f2', sendId: 'k1' }],
    } as never);
    await ledger.accept(ID, {
      sendId: 'k2',
      acceptedAt: AT,
      acceptedTurn: 2,
      path: 'direct',
      message: 'x',
      fate: 'accepted',
    });
    await ledger.withdraw(ID, 'k2', 'the pane refused it');

    const lines = await linesOf(state, SENDS_STATE);

    expect(lines).toHaveLength(4);
    for (const line of lines) expect(SendLineSchema.parse(line)).toEqual(line as never);
    expect(lines.at(-1)).toMatchObject({ sendId: 'k2', fate: 'withdrawn', reason: 'the pane refused it', at: AT });
  });

  test('a line is not the wire view: SendRecordSchema (v: 1, no withdrawn, no bookkeeping) refuses it', async () => {
    const state = memoryStatePort(CONVERSATION_STATE);
    await new StateSendLedger(state, clock).accept(ID, {
      sendId: 'k1',
      acceptedAt: AT,
      acceptedTurn: 1,
      path: 'direct',
      message: 'x',
      fate: 'accepted',
    });
    const [line] = await linesOf(state, SENDS_STATE);
    expect(SendRecordSchema.safeParse(line).success).toBe(false);
  });
});

describe('the answer file holds receipts, never the answer’s words', () => {
  test('every receipt the answer ledger appends parses as an AnswerLineSchema line', async () => {
    const state = memoryStatePort(CONVERSATION_STATE);
    const ledger = new StateAnswerLedger(state, clock);
    for (const outcome of ['accepted', 'confirmed', 'withdrawn', 'failed', 'quarantined', 'acknowledged'] as const)
      await ledger.append(ID, {
        requestId: `r-${outcome}`,
        toolUseId: 'toolu_1',
        fingerprint: 'selection:Yes',
        acceptedAt: AT,
        outcome,
        ...(outcome === 'withdrawn' ? { reason: 'refused before any key' } : {}),
      });

    const lines = await linesOf(state, ANSWERS_STATE);

    expect(lines).toHaveLength(6);
    for (const line of lines) expect(AnswerLineSchema.parse(line)).toEqual(line as never);
    expect(lines.map(line => (line as { resolution?: string }).resolution)).toEqual([
      undefined,
      undefined,
      undefined,
      'failed',
      'quarantined',
      'acknowledged',
    ]);
  });
});

describe('the inbox and outbox hold one line per message', () => {
  test('every line the channel appends parses as an InboxLineSchema or OutboxLineSchema line', async () => {
    const state = memoryStatePort(CONVERSATION_STATE);
    const channel = new StateSendChannel(state);
    await channel.recordInbound(ID, {
      at: AT,
      message: 'hi',
      turn: 3,
      queueId: 'q1',
      queued: true,
      queuedForRevive: false,
      reason: 'busy',
      from: 'f2',
      fromName: 'lead',
    });
    await channel.recordInbound(ID, { at: AT, message: 'bare' });
    await channel.recordOutbound(ID, {
      at: AT,
      to: 'f2',
      from: 'f1',
      fromName: 'worker',
      disposition: 'queued',
      message: 'hi',
    });

    for (const line of await linesOf(state, INBOX_STATE)) expect(InboxLineSchema.parse(line)).toEqual(line as never);
    for (const line of await linesOf(state, OUTBOX_STATE)) expect(OutboxLineSchema.parse(line)).toEqual(line as never);
    expect(await linesOf(state, INBOX_STATE)).toHaveLength(2);
    expect(await linesOf(state, OUTBOX_STATE)).toHaveLength(1);
  });
});
