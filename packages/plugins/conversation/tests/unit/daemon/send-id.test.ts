import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { StatePort } from '@ferretry/kernel/contract';
import { fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import { CONVERSATION_STATE, ConversationPort, QUEUE_STATE, SENDS_STATE } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import { StateSendLedger } from '../../../daemon/delivery/adapters/index.ts';
import { StateQueueStore } from '../../../daemon/queue/adapters/index.ts';
import { parseSessionId } from '../../../daemon/seams/ferret-id.ts';
import { memoryStatePort } from '../../support/state.ts';

const F1 = ferretId('f1');
const AT = '2026-11-07T09:00:00.000Z' as Instant;
const clock = { now: () => AT };

/** The real daemon half on the test host over a given state, so a second host over the same state is "another run". */
async function conversation(state: StatePort = memoryStatePort(CONVERSATION_STATE)) {
  const ferrets = new FakeFerrets();
  ferrets.add({ id: F1, state: 'working' });
  const implementation = {
    ...daemon,
    build: (ctx: Parameters<NonNullable<typeof daemon.build>>[0]) => {
      const build = daemon.build;
      if (build === undefined) throw new Error('the conversation daemon half has no build');
      return build({ ...ctx, kernel: { ...ctx.kernel, state } });
    },
  } as typeof daemon;
  const host = await testHost({
    plugins: [implementation],
    fakes: { ferrets, asks: new FakeAsks() },
    clock: fixedClock('2026-11-07T09:00:00Z'),
  });
  return { host, state, api: () => host.provided(ConversationPort) };
}

const ledgered = async (state: StatePort, sendId: string, over: Record<string, unknown> = {}) =>
  await new StateSendLedger(state, clock).accept(parseSessionId('f1'), {
    sendId,
    acceptedAt: AT,
    acceptedTurn: 1,
    path: 'direct',
    message: 'once',
    fate: 'delivered',
    ...over,
  } as never);

describe('the same send id twice is one message, across daemon runs', () => {
  test('a send whose id the ledger already holds is answered as that send, and nothing is typed or recorded again', async () => {
    const { host, state, api } = await conversation();
    await ledgered(state, 'board-reopen-1');

    const again = await api().send(F1, { kind: 'owner' }, { message: 'once', sendId: 'board-reopen-1' });

    expect(again).toEqual({
      ok: true,
      value: { ferret: F1, disposition: 'delivered', sendId: 'board-reopen-1', fate: 'delivered' },
    });
    expect((await api().sends(F1)).sends).toHaveLength(1);
    await host.stop();
  });

  test('a message still waiting in the queue is answered as queued, with why', async () => {
    const { host, state, api } = await conversation();
    await new StateQueueStore(state).append(parseSessionId('f1'), {
      v: 1,
      kind: 'enqueued',
      at: AT,
      message: {
        v: 1,
        id: 'board-check-1',
        sender: 'human',
        text: 'wait',
        attachmentIds: [],
        enqueuedAt: AT,
        state: 'queued',
        stateAt: AT,
        revision: 1,
      },
    });
    await new StateQueueStore(state).append(parseSessionId('f1'), {
      v: 1,
      kind: 'waiting',
      at: AT,
      id: 'board-check-1',
      reason: 'busy',
    });

    const again = await api().send(F1, { kind: 'owner' }, { message: 'wait', sendId: 'board-check-1' });

    expect(again).toEqual({
      ok: true,
      value: { ferret: F1, disposition: 'queued', sendId: 'board-check-1', fate: 'accepted', waitReason: 'busy' },
    });
    expect((await api().queue(F1)).messages).toHaveLength(1);
    await host.stop();
  });

  test('another run of the daemon over the same state finds the first run’s message', async () => {
    const first = await conversation();
    await ledgered(first.state, 'board-done-9', { fate: 'queued', path: 'native-inline' });
    await first.host.stop();

    const second = await conversation(first.state);
    const again = await second.api().send(F1, { kind: 'owner' }, { message: 'once', sendId: 'board-done-9' });

    expect(again).toMatchObject({ ok: true, value: { sendId: 'board-done-9', disposition: 'queued', fate: 'queued' } });
    await second.host.stop();
  });

  test('a message delivered inside a combined turn is answered with the turn’s row, as its own id', async () => {
    const { host, state, api } = await conversation();
    await ledgered(state, 'lead-id', { fate: 'delivered' });
    const store = new StateQueueStore(state);
    const message = (id: string) => ({
      v: 1 as const,
      id,
      sender: 'agent' as const,
      text: id,
      attachmentIds: [],
      enqueuedAt: AT,
      state: 'queued' as const,
      stateAt: AT,
      revision: 1,
    });
    await store.append(parseSessionId('f1'), { v: 1, kind: 'enqueued', at: AT, message: message('lead-id') });
    await store.append(parseSessionId('f1'), { v: 1, kind: 'enqueued', at: AT, message: message('member-id') });
    await store.append(parseSessionId('f1'), {
      v: 1,
      kind: 'moved',
      at: AT,
      id: 'member-id',
      state: 'typing',
      batch: 'lead-id',
    });

    const again = await api().send(F1, { kind: 'owner' }, { message: 'member-id', sendId: 'member-id' });

    expect(again).toMatchObject({ ok: true, value: { sendId: 'member-id', fate: 'delivered' } });
    await host.stop();
  });

  test('an id the ledger does not hold, or holds for another ferret, is a new send', async () => {
    const { host, state, api } = await conversation();
    await new StateSendLedger(state, clock).accept(parseSessionId('f2'), {
      sendId: 'board-reopen-1',
      acceptedAt: AT,
      acceptedTurn: 1,
      path: 'direct',
      message: 'for f2',
      fate: 'delivered',
    });

    const result = await api().send(F1, { kind: 'owner' }, { message: 'for f1', sendId: 'board-reopen-1' });

    // new: it goes to the terminal seam; this Ferrets offers no harness, so it refuses in words and keeps nothing
    expect(result).toMatchObject({ ok: false, error: { code: 'plugin_unavailable' } });
    expect((await api().sends(F1)).sends).toEqual([]);
    await host.stop();
  });

  test('a withdrawn send typed nothing: with an empty queue a retry with the same id is a new send, and it reaches deliver', async () => {
    const { host, state, api } = await conversation();
    await ledgered(state, 'r-1', { fate: 'withdrawn' });

    const retry = await api().send(F1, { kind: 'owner' }, { message: 'again', sendId: 'r-1' });

    // new: it goes to the terminal seam (this Ferrets offers no harness), not answered "queued" for a message that is nowhere
    expect(retry).toMatchObject({ ok: false, error: { code: 'plugin_unavailable' } });
    expect((await api().queue(F1)).messages).toEqual([]);
    await host.stop();
  });

  test('a withdrawn send whose message the queue still holds under that id is answered by the queue', async () => {
    const { host, state, api } = await conversation();
    await ledgered(state, 'r-2', { fate: 'withdrawn' });
    await new StateQueueStore(state).append(parseSessionId('f1'), {
      v: 1,
      kind: 'enqueued',
      at: AT,
      message: {
        v: 1,
        id: 'r-2',
        sender: 'human',
        text: 'back in the queue',
        attachmentIds: [],
        enqueuedAt: AT,
        state: 'queued',
        stateAt: AT,
        revision: 1,
      },
    });

    const again = await api().send(F1, { kind: 'owner' }, { message: 'back in the queue', sendId: 'r-2' });

    expect(again).toMatchObject({ ok: true, value: { sendId: 'r-2', disposition: 'queued', fate: 'accepted' } });
    await host.stop();
  });

  test('the route reads the id from the header, and a body that names another one is refused', async () => {
    const { host, state } = await conversation();
    await ledgered(state, 'req-1');
    const send = async (body: object, key = 'req-1') =>
      await host.request('POST', '/v1/ferrets/f1/send', { as: owner(), headers: { 'x-fy-request-id': key }, body });

    const kept = await send({ message: 'once', sendId: 'req-1' });
    expect(kept.status).toBe(200);
    expect(kept.json()).toMatchObject({ sendId: 'req-1', disposition: 'delivered' });

    const clash = await send({ message: 'once', sendId: 'req-2' });
    expect(clash.status).toBe(400);
    expect(clash.json()).toMatchObject({ code: 'invalid_request' });
    await host.stop();
  });
});

describe('the stores keep the send id as the message’s own id', () => {
  test('the queue holds one message for a repeated id, and the ledger one row', async () => {
    const state = memoryStatePort(CONVERSATION_STATE);
    const ledger = new StateSendLedger(state, clock);
    const first = await ledger.accept(parseSessionId('f1'), {
      sendId: 'k',
      acceptedAt: AT,
      acceptedTurn: 1,
      path: 'direct',
      message: 'a',
      fate: 'accepted',
    });
    const second = await ledger.accept(parseSessionId('f1'), {
      sendId: 'k',
      acceptedAt: AT,
      acceptedTurn: 1,
      path: 'direct',
      message: 'b',
      fate: 'accepted',
    });
    expect([first.created, second.created]).toEqual([true, false]);
    expect(second.record.message).toBe('a');
    const lines: unknown[] = [];
    for await (const line of state.lines(SENDS_STATE, 'f1')) lines.push(line);
    expect(lines).toHaveLength(1);
    const queued: unknown[] = [];
    for await (const line of state.lines(QUEUE_STATE, 'f1')) queued.push(line);
    expect(queued).toHaveLength(0);
  });
});
