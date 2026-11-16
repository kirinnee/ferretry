import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import { ferretId } from '@ferretry/core-ferrets/contract/testing';
import { BoardPort, CardCreateRequestSchema, type CardCreateRequestInput } from '../../../contract/index.ts';
import { boardConformance } from '../../../contract/testing/index.ts';
import manifest from '../../../manifest.ts';
import { boot, TEST_IDENTITY } from '../../integration/daemon/harness.ts';

/**
 * The reads other plugins make of Board (the Warden's: lane sets, a ferret's focus card, and a cursor past one page),
 * through the real daemon half's `BoardPort`.
 */

const PERSON_ASK = { text: 'make the badge green', source: 'owner (board)' } as const;
const create = (input: Partial<CardCreateRequestInput> = {}) =>
  CardCreateRequestSchema.parse({ kind: 'feature', title: 'Badge colour', ask: PERSON_ASK, assignee: 'f1', ...input });

const FOCUS = manifest.data.state.find(file => file.name === 'focus');
const f1 = ferretId('f1') as FerretId;

// The same suite the fake passes, on the real daemon half: the fake and the real board cannot drift apart unseen.
boardConformance('the real Board daemon half', async () => (await boot()).host.provided(BoardPort));

const world = async () => {
  const { host, ferrets } = await boot();
  const board = host.provided(BoardPort);
  const made = async (by: 'owner' | FerretId, input: Partial<CardCreateRequestInput> = {}) => {
    const result = await board.create(by, create(input));
    if (!result.ok) throw new Error(`create refused: ${result.error.message}`);
    return result.value;
  };
  /** Plants the focus file: ferret → the card it works on, as a stored ref. */
  const plantFocus = (entries: Record<string, { id: string; machineId?: string } | null>): void => {
    host.state('board').plant(
      FOCUS as never,
      JSON.stringify({
        format: 1,
        ferrets: Object.fromEntries(
          Object.entries(entries).map(([ferret, card]) => [ferret, { card, anchor: null, skip: null }]),
        ),
      }),
    );
  };
  return { host, ferrets, board, made, plantFocus };
};

describe('BoardApi.laneSets', () => {
  test('lists the lane set of every project that has a card, and nothing when there is no card', async () => {
    // Arrange
    const { board, made } = await world();
    expect(await board.laneSets()).toEqual([]);

    // Act
    const card = await made('owner');
    const sets = await board.laneSets();

    // Assert
    expect(sets).toHaveLength(1);
    expect(sets[0]?.projectId).toBe(card.projectId);
    expect(sets[0]?.lanes.some(lane => lane.id === card.laneId)).toBe(true);
  });
});

describe('BoardApi.cardsPage', () => {
  test('reads past one page: the cursor leads to the next page and is null on the last', async () => {
    // Arrange
    const { board, made } = await world();
    for (let each = 0; each < 3; each += 1) await made('owner', { title: `Badge ${String(each)}` });

    // Act
    const first = await board.cardsPage({ state: 'open', limit: 2 });
    const second = await board.cardsPage({ state: 'open', limit: 2, cursor: first.nextCursor ?? undefined });

    // Assert
    expect(first.cards).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(second.cards).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.cards, ...second.cards].map(card => card.id)).size).toBe(3);
  });

  test('the whole read still agrees with `cards`', async () => {
    // Arrange
    const { board, made } = await world();
    await made('owner');

    // Act / Assert
    expect((await board.cardsPage({ state: 'open', limit: 100 })).cards).toEqual(
      await board.cards({ state: 'open', limit: 100 }),
    );
  });
});

describe('BoardApi.focusOf', () => {
  test('is the card a ferret works on, in full', async () => {
    // Arrange
    const { board, made, plantFocus } = await world();
    const card = await made('owner');
    plantFocus({ f1: { id: card.id } });

    // Act
    const focus = await board.focusOf(f1);

    // Assert
    expect(focus?.card.id).toBe(card.id);
    expect(focus?.card.title).toBe('Badge colour');
  });

  test('comes with the lane set of the card’s board, as the card read does', async () => {
    // Arrange
    const { board, made, plantFocus } = await world();
    const card = await made('owner');
    plantFocus({ f1: { id: card.id } });

    // Act
    const focus = await board.focusOf(f1);
    const sets = await board.laneSets();

    // Assert
    expect(focus?.laneSet).not.toBeNull();
    expect(focus?.laneSet).toEqual(sets.find(set => set.projectId === card.projectId));
  });

  test('a ferret that wrote to a card is focused on it', async () => {
    // Arrange
    const { board, made } = await world();
    const card = await made('owner');
    expect(await board.focusOf(f1)).toBeUndefined();

    // Act
    const wrote = await board.progress(f1, card.id, { now: 'colouring' });
    expect(wrote.ok).toBe(true);

    // Assert
    expect((await board.focusOf(f1))?.card.id).toBe(card.id);
  });

  test('a ferret with no focus gets none', async () => {
    // Arrange
    const { board } = await world();

    // Act / Assert
    expect(await board.focusOf(ferretId('nobody') as FerretId)).toBeUndefined();
  });

  test('a private card is answered to its own ferret’s focus, as the resume brief always did', async () => {
    // Arrange: the owner makes the card private
    const { board, made, plantFocus } = await world();
    const card = await made('owner');
    const hidden = await board.act('owner', card.id, { action: 'visibility', visibility: 'private' });
    expect(hidden.ok).toBe(true);
    plantFocus({ f1: { id: card.id } });

    // Act
    const focus = await board.focusOf(f1);

    // Assert
    expect(focus?.card.id).toBe(card.id);
    expect(focus?.card.visibility).toBe('private');
  });

  test('a card of another machine, or one that is gone, is not answered', async () => {
    // Arrange
    const { board, made, plantFocus } = await world();
    const card = await made('owner');

    // Act / Assert
    plantFocus({ f1: { id: card.id, machineId: 'fy_daemon_someone-else' } });
    expect(await board.focusOf(f1)).toBeUndefined();
    plantFocus({ f1: { id: 'F999' } });
    expect(await board.focusOf(f1)).toBeUndefined();
    // …and this machine's own id still answers.
    plantFocus({ f1: { id: card.id, machineId: TEST_IDENTITY.daemonId } });
    expect((await board.focusOf(f1))?.card.id).toBe(card.id);
  });
});

describe('BoardApi.orphanedCards', () => {
  test('lists an open card whose ferret has ended, with the lanes that name it, and not a card with a live ferret', async () => {
    // Arrange: two cards on the implement lane; the ferret of one has stopped
    const { board, made, ferrets } = await world();
    ferrets.add({ id: ferretId('f2') as FerretId });
    const ended = await made('owner', { title: 'Ended', assignee: 'f1', laneId: 'doing' });
    const live = await made('owner', { title: 'Live', assignee: 'f2', laneId: 'doing' });
    ferrets.setState(f1, 'stopped');

    // Act
    const read = await board.orphanedCards();

    // Assert
    expect(read.cards.map(card => card.id)).toEqual([ended.id]);
    expect(read.cards.every(card => card.activity === 'orphaned')).toBe(true);
    expect(read.cards.map(card => card.id)).not.toContain(live.id);
    expect(read.laneSets.map(set => set.projectId)).toEqual([ended.projectId]);
  });

  test('is empty when no card is orphaned', async () => {
    // Arrange
    const { board, made } = await world();
    await made('owner');

    // Act / Assert
    expect((await board.orphanedCards()).cards).toEqual([]);
  });
});
