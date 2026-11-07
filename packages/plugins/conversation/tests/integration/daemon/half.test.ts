import { describe, expect, test } from 'bun:test';
import { fixedClock, MemoryStateFolder, owner, testHost } from '@ferretry/kernel/testing';
import { instantFromEpochMs } from '@ferretry/std';
import { ANSWERS_STATE, CONVERSATION_STATE, INBOX_STATE, QUEUE_STATE, SENDS_STATE } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import { StateAnswerLedger } from '../../../daemon/questions/adapters/index.ts';
import { StateQueueStore } from '../../../daemon/queue/adapters/index.ts';
import { StateSendChannel, StateSendLedger } from '../../../daemon/delivery/adapters/index.ts';
import { parseSessionId } from '../../../daemon/seams/ferret-id.ts';
import type { SendRecord } from '../../../daemon/delivery/lib/index.ts';

const clock = { now: () => instantFromEpochMs(1_794_052_800_000) };
const f1 = parseSessionId('f1');

describe('conversation state adapters, on the kernel state port', () => {
  test('the queue store appends events and reads them back in order, skipping an event it does not know', async () => {
    const state = new MemoryStateFolder().port(CONVERSATION_STATE);
    const store = new StateQueueStore(state);
    await state.append<unknown>(QUEUE_STATE, { v: 1, kind: 'bogus' }, 'f1');
    await store.append(f1, {
      v: 1,
      kind: 'moved',
      at: clock.now(),
      id: 'm1',
      state: 'cancelled',
    });
    const events = await store.read(f1);
    expect(events.map(event => event.kind)).toEqual(['moved']);
  });

  test('the send ledger is last-write-wins per send and refuses a second accept of the same send', async () => {
    const state = new MemoryStateFolder().port(CONVERSATION_STATE);
    const ledger = new StateSendLedger(state, clock);
    const record = {
      sendId: 's1',
      path: 'direct',
      fate: 'accepted',
      message: 'hello',
      acceptedAt: clock.now(),
      acceptedTurn: 1,
    } as unknown as SendRecord;
    expect((await ledger.accept(f1, record)).created).toBe(true);
    expect((await ledger.accept(f1, record)).created).toBe(false);
    const settled = await ledger.settle(f1, 's1', { fate: 'delivered' } as never);
    expect(settled?.fate).toBe('delivered');
    expect((await ledger.list(f1)).map(entry => entry.fate)).toEqual(['delivered']);
    expect(await ledger.withdraw(f1, 's1', 'late')).toBeUndefined();
    const lines: unknown[] = [];
    for await (const line of state.lines<unknown>(SENDS_STATE, 'f1')) lines.push(line);
    expect(lines).toHaveLength(2);
  });

  test('a withdrawn send can be accepted again, and an unusable line is skipped', async () => {
    const state = new MemoryStateFolder().port(CONVERSATION_STATE);
    const ledger = new StateSendLedger(state, clock);
    await state.append<unknown>(SENDS_STATE, { nothing: true }, 'f1');
    const record = { sendId: 's2', path: 'direct', fate: 'accepted', message: 'm' } as unknown as SendRecord;
    await ledger.accept(f1, record);
    expect((await ledger.withdraw(f1, 's2', 'changed my mind'))?.fate).toBe('withdrawn');
    expect((await ledger.accept(f1, record)).created).toBe(true);
  });

  test('the answer ledger keeps the last receipt per request, and records a resolution as an accepted receipt', async () => {
    const state = new MemoryStateFolder().port(CONVERSATION_STATE);
    const ledger = new StateAnswerLedger(state, clock);
    const base = { requestId: 'r1', toolUseId: 't1', fingerprint: 'fp', acceptedAt: clock.now() };
    await ledger.append(f1, { ...base, outcome: 'accepted' });
    await ledger.append(f1, { ...base, outcome: 'failed', reason: 'pane gone' });
    const read = await ledger.read(f1, 'r1');
    expect(read?.outcome).toBe('failed');
    const lines: unknown[] = [];
    for await (const line of state.lines<unknown>(ANSWERS_STATE, 'f1')) lines.push(line);
    expect(lines.at(-1)).toMatchObject({ outcome: 'accepted', resolution: 'failed' });
  });

  test('the channel writes what reached a ferret to its inbox', async () => {
    const state = new MemoryStateFolder().port(CONVERSATION_STATE);
    await new StateSendChannel(state).recordInbound(f1, { at: clock.now(), message: 'hi' } as never);
    const lines: unknown[] = [];
    for await (const line of state.lines<unknown>(INBOX_STATE, 'f1')) lines.push(line);
    expect(lines).toEqual([{ at: clock.now(), type: 'message', message: 'hi' }]);
  });
});

describe('conversation daemon half, through the kernel test host', () => {
  const ferrets = { get: async () => ({ id: 'f1' }) };
  const boot = async () =>
    await testHost({
      plugins: [daemon],
      fakes: { ferrets, asks: {} },
      clock: fixedClock('2026-11-06T09:00:00Z'),
    });

  test('an empty queue reads as no messages', async () => {
    const host = await boot();
    const response = await host.request('GET', '/v1/ferrets/f1/queue', { as: owner() });
    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ messages: [] });
  });

  test('a send says plainly that the ferret’s terminal is not connected yet', async () => {
    const host = await boot();
    const response = await host.request('POST', '/v1/ferrets/f1/send', {
      as: owner(),
      headers: { 'x-fy-request-id': 'req-1' },
      body: { message: 'hello' },
    });
    expect(response.status).toBe(503);
    expect(response.json()).toMatchObject({ code: 'conversation_terminal_unavailable' });
  });

  test('the shared draft refuses a caller Gate gave no actor to, rather than guessing it is the owner', async () => {
    const host = await boot();
    const read = await host.request('GET', '/v1/ferrets/f1/shared-draft', { as: owner() });
    expect(read.status).toBe(403);
  });
});

describe('the merged half', () => {
  const boot = async () =>
    await testHost({
      plugins: [daemon],
      fakes: {
        ferrets: { get: async () => ({ id: 'f1' }), list: async () => [] },
        asks: { get: async () => undefined, open: async () => [] },
      },
      clock: fixedClock('2026-11-06T09:00:00Z'),
    });

  test('the pending question reads as none, and a transcript says the harness is not connected yet', async () => {
    const host = await boot();
    const question = await host.request('GET', '/v1/ferrets/f1/question', { as: owner() });
    expect(question.status).toBe(200);
    expect(question.json()).toEqual({ question: null });
    const logs = await host.request('GET', '/v1/ferrets/f1/logs', { as: owner() });
    expect(logs.status).toBe(503);
    expect(logs.json()).toMatchObject({ code: 'conversation_harness_unavailable' });
  });

  test('a render saved is served back, and a link listing says the harness is not connected yet', async () => {
    const host = await boot();
    const links = await host.request('GET', '/v1/links/conversations', { as: owner() });
    expect(links.status).toBe(503);
    const unknown = await host.request('GET', '/v1/renders/rd_000000000000000000000000/meta', { as: owner() });
    expect([400, 404]).toContain(unknown.status);
  });
});
