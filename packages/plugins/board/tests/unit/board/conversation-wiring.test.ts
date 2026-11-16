import { describe, expect, test } from 'bun:test';
import type { AskAnswer } from '@ferretry/core-asks/contract';
import { sourceKey } from '@ferretry/core-asks/contract/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { as, boot, makeCard } from '../../integration/daemon/harness.ts';

/**
 * Board -> Conversation (optional `uses`, lead decision D2 #12): with Conversation on, what Board owes a ferret is typed
 * through Conversation's ordinary send as the owner's; with it off, it is held with a warning and nothing fails.
 * Ferrets' `ferret.started` makes a started ferret's card (today's `SessionCards.open`).
 */

const gateAnswer = (ask: { ferret?: string; id: string; entry: string }, choice: string, text?: string): AskAnswer =>
  ({
    id: 'an_000000000000000000000009',
    ferret: ask.ferret,
    ask: ask.id,
    source: 'card',
    entry: ask.entry,
    effect: 'choose',
    choice,
    ...(text === undefined ? {} : { text }),
    by: { kind: 'host' },
    at: '2026-11-07T09:00:00.000Z',
  }) as unknown as AskAnswer;

const atTryIt = async (world: Awaited<ReturnType<typeof boot>>) => {
  const made = await makeCard(world.host, { howToTest: 'Open the badge and look at its colour.' });
  for (const to of ['doing', 'to-test'])
    await world.host.request('POST', `/v1/board/cards/${made.id}`, {
      body: { action: 'move', to, reason: 'for the test' },
      headers: as('owner'),
    });
  await world.host.settle();
  const [ask] = await world.asks.open({ source: sourceKey('card') });
  if (ask === undefined) throw new Error('no ask was raised');
  return { made, ask };
};

describe('D2 #12 Board talks to ferrets through Conversation', () => {
  test('a Not good reopen is typed to the card’s ferret through Conversation, as the owner, once', async () => {
    const conversation = fakeConversation();
    const world = await boot({ uses: { conversation } });
    const { ask } = await atTryIt(world);

    expect(await world.apply(gateAnswer(ask, 'Not good', 'the badge is clipped'))).toBe('applied');
    await world.host.settle();

    const sent = (await conversation.sends('f1' as never)).sends;
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message).toContain('the badge is clipped');
    expect(sent[0]?.senderKind).toBe('human');
  });

  test('with Conversation off the reopen is held with a warning: the card still moves and nothing throws', async () => {
    const world = await boot();
    const { made, ask } = await atTryIt(world);

    expect(await world.apply(gateAnswer(ask, 'Not good', 'the badge is clipped'))).toBe('applied');

    const read = await world.host.request('GET', `/v1/board/cards/${made.id}`, { headers: as('owner') });
    expect(read.json<{ card: { laneId: string } }>().card.laneId).not.toBe('to-test');
  });

  test('turn.ended runs the turn-end checks and never rejects, with Conversation on or off', async () => {
    const on = await boot({ uses: { conversation: fakeConversation() } });
    const off = await boot();
    const payload = { ferret: 'f1', turn: 't1', outcome: 'completed', endedAt: '2026-11-07T09:00:00.000Z' };

    await on.observe('turn.ended', payload);
    await off.observe('turn.ended', payload);
  });
});

describe('ferret.started makes the started ferret’s card (today’s SessionCards)', () => {
  test('a ferret started with a brief on a board that is on gets its card: the brief its ask, the ferret its holder', async () => {
    const world = await boot();
    await world.host.request('PUT', '/v1/board/projects/unfiled/switch', { body: { on: true }, headers: as('owner') });

    await world.observe('ferret.started', {
      ferret: 'f1',
      name: 'f1',
      role: 'lead',
      folder: '/work',
      by: 'owner',
      brief: 'Make the badge green',
    });

    const board = await world.host.request('GET', '/v1/board', { headers: as('owner') });
    const cards = board.json<{ cards: { title: string; ask?: { text: string } | null }[] }>().cards;
    expect(cards.some(card => card.ask?.text === 'Make the badge green')).toBe(true);
  });

  test('a start the board made itself, or a daemon worker, gets no second card', async () => {
    const world = await boot();
    await world.host.request('PUT', '/v1/board/projects/unfiled/switch', { body: { on: true }, headers: as('owner') });
    const base = { ferret: 'f1', name: 'f1', role: 'lead', folder: '/work', brief: 'Make the badge green' };

    await world.observe('ferret.started', { ...base, by: 'board' });
    await world.observe('ferret.started', { ...base, by: 'owner', label: 'ferretry-learning' });

    const board = await world.host.request('GET', '/v1/board', { headers: as('owner') });
    expect(board.json<{ cards: unknown[] }>().cards).toHaveLength(0);
  });
});
