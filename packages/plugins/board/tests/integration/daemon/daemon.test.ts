import { describe, expect, test } from 'bun:test';
import { sourceKey } from '@ferretry/core-asks/contract/testing';
import type { AskAnswer } from '@ferretry/core-asks/contract';
import { as, boot, makeCard, NEW_CARD } from './harness.ts';

describe('board daemon half', () => {
  test('the owner makes a card and the board lists it', async () => {
    const { host } = await boot();
    const made = await makeCard(host);
    const card = made;
    expect(card.id).toMatch(/^F[1-9][0-9]*$/);

    const board = await host.request('GET', '/v1/board', { headers: as('owner') });
    expect(board.status).toBe(200);
    expect(board.json<{ cards: { id: string }[] }>().cards.map(each => each.id)).toContain(card.id);

    const one = await host.request('GET', `/v1/board/cards/${card.id}`, { headers: as('owner') });
    expect(one.json<{ card: { title: string } }>().card.title).toBe('Badge colour');
  });

  test('ids are never reused: the second card is a new number', async () => {
    const { host } = await boot();
    const first = await makeCard(host);
    const second = await makeCard(host);
    expect(first.id).not.toBe(second.id);
  });

  test('a card is stored one file per card, format first', async () => {
    const { host } = await boot();
    const made = await makeCard(host);
    const id = made.id;
    const text = host.state('board').files.get(`cards/${id}.json`);
    expect(text).toBeDefined();
    expect(JSON.parse(text as string).format).toBe(1);
  });

  test('a body that is not a card is a 400 and writes nothing', async () => {
    const { host } = await boot();
    const refused = await host.request('POST', '/v1/board/cards', { body: { kind: 'nope' }, headers: as('owner') });
    expect(refused.status).toBe(400);
    expect(refused.json<{ code: string }>().code).toBe('invalid');
  });

  test('an unknown card is a 404', async () => {
    const { host } = await boot();
    const missing = await host.request('GET', '/v1/board/cards/F999', { headers: as('owner') });
    expect(missing.status).toBe(404);
  });

  test('a card id that is not an id is a 400', async () => {
    const { host } = await boot();
    const refused = await host.request('GET', '/v1/board/cards/nonsense', { headers: as('owner') });
    expect(refused.status).toBe(400);
  });

  test('the card_progress tool writes the parts it names and keeps the rest', async () => {
    const { host } = await boot();
    const made = await makeCard(host, { assignee: 'f1' });
    const id = made.id;
    const first = await host.tool('card_progress', { card: id, now: 'writing it', next: 'test it' });
    const second = await host.tool('card_progress', { card: id, doneSoFar: 'wrote it' });
    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    const read = await host.request('GET', `/v1/board/cards/${id}`, { headers: as('owner') });
    expect(read.json<{ card: { progress?: { now: string; doneSoFar: string; next: string } } }>().card.progress).toEqual({
      now: 'writing it',
      doneSoFar: 'wrote it',
      next: 'test it',
    });
  });

  test('a board is off until the owner switches it, and only the owner switches it', async () => {
    const { host } = await boot();
    const read = await host.request('GET', '/v1/board/projects/unfiled/switch', { headers: as('owner') });
    expect(read.json<{ on: boolean; setBy: string }>()).toMatchObject({ on: false, setBy: 'default' });

    const byFerret = await host.request('PUT', '/v1/board/projects/unfiled/switch', {
      body: { on: true },
      headers: as('ferret:f1'),
    });
    expect(byFerret.status).toBe(403);
    expect(byFerret.json<{ code: string }>().code).toBe('owner-only');

    const byOwner = await host.request('PUT', '/v1/board/projects/unfiled/switch', {
      body: { on: true },
      headers: as('owner'),
    });
    expect(byOwner.json<{ on: boolean; setBy: string }>()).toMatchObject({ on: true, setBy: 'owner' });
  });

  test('the Unfiled board has lanes, and a project that does not exist has none', async () => {
    const { host } = await boot();
    const lanes = await host.request('GET', '/v1/board/projects/unfiled/lanes', { headers: as('owner') });
    expect(lanes.status).toBe(200);
    const unknown = await host.request('GET', '/v1/board/projects/6f2c2f1e-0000-4000-8000-000000000000/lanes', {
      headers: as('owner'),
    });
    expect(unknown.status).toBe(404);
  });

  test('#1552 a card that reaches a gate lane raises ONE obligation through Asks, source card; a second write raises no more; leaving withdraws it', async () => {
    const { asks, host } = await boot();
    const made = await makeCard(host, { howToTest: 'Open the badge and look at its colour.' });
    const move = async (to: string) =>
      await host.request('POST', `/v1/board/cards/${made.id}`, {
        body: { action: 'move', to, reason: 'for the test' },
        headers: as('owner'),
      });
    const toTest = await move('doing');
    expect(toTest.status).toBe(200);
    expect((await move('to-test')).status).toBe(200);
    await host.settle();
    const open = await asks.open({ source: sourceKey('card') });
    expect(open).toHaveLength(1);
    expect(open[0]?.entry.startsWith(`gate:${made.id}:to-test:`)).toBe(true);
    expect(open[0]?.kind).toBe('choice');

    // Another write of the same card, still at the gate, asks nothing new.
    await host.request('POST', `/v1/board/cards/${made.id}`, { body: { action: 'note', text: 'still here' }, headers: as('owner') });
    await host.settle();
    expect(await asks.open({ source: sourceKey('card') })).toHaveLength(1);

    // The owner moving it on the board takes the question back, quietly.
    expect((await move('doing')).status).toBe(200);
    await host.settle();
    expect(await asks.open({ source: sourceKey('card') })).toHaveLength(0);
  });

  test('#1552 the owner Done moves the card FIRST (the source apply), and the same answer applied twice moves nothing more', async () => {
    const { asks, host, apply } = await boot();
    const made = await makeCard(host, { howToTest: 'Open the badge and look at its colour.' });
    const move = async (to: string) =>
      await host.request('POST', `/v1/board/cards/${made.id}`, { body: { action: 'move', to, reason: 'for the test' }, headers: as('owner') });
    await move('doing');
    await move('to-test');
    await host.settle();
    const [ask] = await asks.open({ source: sourceKey('card') });
    if (ask === undefined) throw new Error('no ask was raised');
    const answer = (id: string, choice: string, text?: string): AskAnswer =>
      ({
        id,
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

    expect(await apply(answer('an_000000000000000000000001', 'Done'))).toBe('applied');
    const after = await host.request('GET', `/v1/board/cards/${made.id}`, { headers: as('owner') });
    expect(after.json<{ card: { laneId: string } }>().card.laneId).toBe('closed');
    const history = after.json<{ card: { history: { type: string }[] } }>().card.history.length;

    // A replay of the same answer finds the card gone from that gate: nothing moves, nothing is written.
    await apply(answer('an_000000000000000000000001', 'Done'));
    const again = await host.request('GET', `/v1/board/cards/${made.id}`, { headers: as('owner') });
    expect(again.json<{ card: { history: unknown[] } }>().card.history.length).toBe(history);
  });

  test('#1552 an answer to a gate the card has left is refused in words, and the card is not moved', async () => {
    const { asks, host, apply } = await boot();
    const made = await makeCard(host, { howToTest: 'Open the badge and look at its colour.' });
    const move = async (to: string) =>
      await host.request('POST', `/v1/board/cards/${made.id}`, { body: { action: 'move', to, reason: 'for the test' }, headers: as('owner') });
    await move('doing');
    await move('to-test');
    await host.settle();
    const [ask] = await asks.open({ source: sourceKey('card') });
    if (ask === undefined) throw new Error('no ask was raised');
    await move('doing');
    const refused = await apply({
      id: 'an_000000000000000000000002',
      ferret: ask.ferret,
      ask: ask.id,
      source: 'card',
      entry: ask.entry,
      effect: 'choose',
      choice: 'Done',
      by: { kind: 'host' },
      at: '2026-11-07T09:00:00.000Z',
    } as unknown as AskAnswer);
    expect(refused).toMatchObject({ refused: expect.stringContaining('no longer at that question') });
    const read = await host.request('GET', `/v1/board/cards/${made.id}`, { headers: as('owner') });
    expect(read.json<{ card: { laneId: string } }>().card.laneId).toBe('doing');
  });

  test('a card survives a restart, and a damaged card file is quarantined: listed, never served, never overwritten', async () => {
    const { host } = await boot();
    const kept = await makeCard(host);
    host.state('board').files.set('cards/F77.json', '{ this is not a card');
    const again = await host.restart();
    const board = await again.request('GET', '/v1/board', { headers: as('owner') });
    const body = board.json<{ cards: { id: string }[]; quarantined: { id: string }[] }>();
    expect(body.cards.map(each => each.id)).toContain(kept.id);
    expect(body.quarantined.map(each => each.id)).toEqual(['F77']);
    expect(again.state('board').files.get('cards/F77.json')).toBe('{ this is not a card');
    // The damaged card's number is skipped, never handed out again.
    const next = await again.request('POST', '/v1/board/cards', { body: NEW_CARD, headers: as('owner') });
    expect(next.status).toBe(200);
    expect(next.json<{ card: { id: string } }>().card.id).not.toBe('F77');
  });

  test('the sweep and the GitHub watch are jobs of the kernel, and the gates reconcile once at start', async () => {
    const { host } = await boot();
    expect(host.jobIds()).toEqual(expect.arrayContaining(['board-sweep', 'board-gates', 'board-github-watch']));
  });
});
