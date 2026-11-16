import { afterEach, describe, expect, it } from 'bun:test';
import { ferretStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { AskNotTypedError, type AskDelivery } from '../../../contract/index.ts';
import { AGENDA_REPLY_RECHECK_MS } from '../../../daemon/lib/agenda/index.ts';
import { asksHalf } from '../../support/daemon/asks-half.ts';

const BOARD = 'POST /v1/ferrets/:ferretId/agenda';
const REPLIES = 'POST /v1/ferrets/:ferretId/agenda/replies';
const F1 = { ferretId: 'f1' };

const halves: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(halves.splice(0).map(async half => await half.close()));
});

/**
 * What Conversation's `ask.delivery:ferret` does, seen from Asks (the adapter itself, and its refusal mapping, are
 * proved in the Conversation plugin: another package is reached only through its contract): ONE message per send id,
 * and "not typed, retry" while a draft is in the way.
 */
function sendPath(options: { refuse?: boolean } = {}) {
  const typed = new Map<string, { ferret: string; message: string }>();
  const calls: string[] = [];
  const state = { refuse: options.refuse === true };
  const delivery: AskDelivery = {
    send: async (ferret, message, sendId) => {
      calls.push(sendId);
      if (state.refuse) throw new AskNotTypedError('the composer holds a draft');
      if (!typed.has(sendId)) typed.set(sendId, { ferret, message });
    },
    composer: async () => 'empty',
    receipt: async (_ferret, sendId) => (typed.has(sendId) ? { state: 'delivered' } : { state: 'pending' }),
  };
  return { delivery, typed, calls, state };
}

async function world(providers: Record<string, unknown> = {}) {
  const half = await asksHalf(providers);
  halves.push(half);
  return half;
}

const raiseAsk = async (half: Awaited<ReturnType<typeof world>>) => {
  await half.call(
    BOARD,
    F1,
    {
      action: 'add',
      title: 'Release unblock',
      subject: 'Ship it?',
      why: 'The release is ready.',
      premise: 'A ferret needs the owner.',
      context: 'The work waits on this answer.',
      howToResolve: 'Answer yes or no.',
      ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
    },
    ferretStanding('f1' as FerretId),
  );
  return 'A1';
};
const answer = (half: Awaited<ReturnType<typeof world>>, id: string) =>
  half.call(
    BOARD,
    F1,
    { action: 'resolve', id, response: { kind: 'multiple-choice', choice: 'Yes' } },
    ownerStanding('ui'),
  );

describe('R-0334 V-0032 the owner’s answer reaches the ferret through ask.delivery', () => {
  it('types one queued message carrying the answer, and the outbox empties', async () => {
    const path = sendPath();
    const half = await world({ 'ask.delivery:ferret': path.delivery });
    await answer(half, await raiseAsk(half));

    const replied = await half.call(REPLIES, F1, {}, ownerStanding('ui'));
    expect(replied.status).toBe(200);
    for (let look = 0; look < 3; look += 1) {
      await half.clock.advance(AGENDA_REPLY_RECHECK_MS);
      await Bun.sleep(30);
    }

    expect(path.typed.size).toBe(1);
    const [only] = [...path.typed.values()];
    expect(only?.ferret).toBe('f1');
    expect(only?.message).toContain('[answer to !A1 «Ship it?»] Yes');
    const board = (await half.call('GET /v1/ferrets/:ferretId/agenda', F1)).json<{ delivery?: unknown }>();
    expect(board.delivery).toBeUndefined();
  });

  it('a send id repeated by the batcher types nothing twice', async () => {
    const path = sendPath();
    const half = await world({ 'ask.delivery:ferret': path.delivery });
    await answer(half, await raiseAsk(half));
    await half.call(REPLIES, F1, {});
    await half.clock.advance(AGENDA_REPLY_RECHECK_MS);
    await Bun.sleep(30);
    expect(new Set(path.calls).size).toBe(path.typed.size);
    expect(path.typed.size).toBe(1);
  });

  it('holds the answer while a draft is in the way and types it once the way is clear', async () => {
    const path = sendPath({ refuse: true });
    const half = await world({ 'ask.delivery:ferret': path.delivery });
    await answer(half, await raiseAsk(half));
    await half.call(REPLIES, F1, {});
    expect(path.typed.size).toBe(0);

    path.state.refuse = false;
    for (let look = 0; look < 3; look += 1) {
      await half.clock.advance(AGENDA_REPLY_RECHECK_MS);
      await Bun.sleep(30);
    }
    expect(path.typed.size).toBe(1);
  });

  it('holds the answer while Conversation is off, and delivers it once Conversation starts', async () => {
    const path = sendPath();
    const providers: Record<string, unknown> = {};
    const half = await world(providers);
    await answer(half, await raiseAsk(half));
    const held = await half.call(REPLIES, F1, {});
    expect(held.status).toBe(200);
    expect(path.typed.size).toBe(0);

    providers['ask.delivery:ferret'] = path.delivery;
    for (let look = 0; look < 3; look += 1) {
      await half.clock.advance(AGENDA_REPLY_RECHECK_MS);
      await Bun.sleep(30);
    }
    expect(path.typed.size).toBe(1);
  });
});
