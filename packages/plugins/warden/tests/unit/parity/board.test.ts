import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId, T0 } from '@ferretry/core-ferrets/contract/testing';
import { fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import { err } from '@ferretry/std';
import type { BoardApi, CardView } from '@ferretry/plugin-board/contract';
import { fakeBoard } from '@ferretry/plugin-board/contract/testing';
import type { ConversationApi } from '@ferretry/plugin-conversation/contract';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import daemon from '../../../daemon/index.ts';
import { lanes, PROJECT } from '../../support/board.ts';
import { cardView } from '../board-fixtures.ts';

/** `F1`, owned by a ferret no longer on this machine, its assignee `worker` stopped: Board calls it orphaned. */
const orphaned: CardView = cardView({ owner: 'gone', assignee: 'worker' }, { activity: 'orphaned' });

/** An Asks that refuses the standing notice, remembering the entries it was asked to keep. */
class RefusingAsks extends FakeAsks {
  readonly attempts: string[] = [];
  override async standing(...[notice]: Parameters<FakeAsks['standing']>): ReturnType<FakeAsks['standing']> {
    this.attempts.push(String(notice.entry));
    throw new Error('Asks is off');
  }
}

/** The same card, owned by `lead`, a live auto ferret that the Warden may type to. */
const ownedByLead: CardView = cardView({ owner: 'lead', assignee: 'worker' }, { activity: 'orphaned' });

/**
 * Board's contract fake, answering the orphaned cards given (one by default) in one snapshot, recording every read.
 * Its lane sets are the classic ones, so a lane reads by name.
 */
function boardWithOrphan(card: CardView | readonly CardView[] = orphaned): {
  readonly board: BoardApi;
  readonly reads: number[];
  /** Change which cards the board calls orphaned, between two runs. */
  readonly set: (next: readonly CardView[]) => void;
} {
  let all: readonly CardView[] = Array.isArray(card) ? card : [card as CardView];
  const reads: number[] = [];
  const board: BoardApi = {
    ...fakeBoard(),
    orphanedCards: async () => {
      reads.push(reads.length + 1);
      return { cards: [...all], laneSets: [lanes(PROJECT)] };
    },
  };
  return {
    board,
    reads,
    set: next => {
      all = next;
    },
  };
}

interface WardenOptions {
  /** A live auto ferret `lead` the card's owner is, so the sweep can type to it. */
  readonly liveOwner?: boolean;
  /** A finished ferret `lead` beside `worker`, so cards of two ferrets can be orphaned. */
  readonly stoppedLead?: boolean;
  /** Conversation refuses every send. */
  readonly sendRefused?: boolean;
  /** The Agenda refuses every notice (Asks off or failing). */
  readonly agendaOff?: boolean;
}

/** The real daemon half, Board on (`uses.board` given) or off (omitted), with a stopped `worker`. */
async function wardenWith(board: BoardApi | undefined, options: WardenOptions = {}) {
  const ferrets = new FakeFerrets();
  const base = fakeConversation();
  const typed: string[] = [];
  const conversation: ConversationApi = {
    ...base,
    send: async (ferret, caller, request) => {
      typed.push(`${ferret}: ${request.message}`);
      if (options.sendRefused === true) return err({ code: 'refused', message: 'the composer refused' });
      return await base.send(ferret, caller, request);
    },
  };
  const fake = options.agendaOff === true ? new RefusingAsks() : new FakeAsks();
  const host = await testHost({
    plugins: [daemon],
    fakes: { ferrets, asks: fake, conversation },
    ...(board === undefined ? {} : { uses: { board } }),
    clock: fixedClock('2026-11-07T12:00:00.000Z'),
  });
  ferrets.add({ id: ferretId('worker'), mode: 'auto', state: 'stopped', stateAt: T0 });
  if (options.liveOwner === true) ferrets.add({ id: ferretId('lead'), mode: 'auto', state: 'idle', stateAt: T0 });
  if (options.stoppedLead === true) ferrets.add({ id: ferretId('lead'), mode: 'auto', state: 'stopped', stateAt: T0 });
  const run = async () => await host.request('POST', '/v1/warden/run', { body: { spawn: false }, as: owner() });
  /** The notices standing on a ferret's board, as `source`/`entry` pairs. */
  const notices = async (ferret: string) =>
    (await fake.open({ ferret: ferretId(ferret), state: 'open' })).map(ask => String(ask.entry));
  /** The ONE item of orphaned cards on the machine board: its entries (an ask each), and what its newest wording says. */
  const machineItem = async () => {
    const open = await fake.open({ ferret: ferretId('machine-agenda'), state: 'open' });
    const subjects = (await fake.snapshots({ ferret: 'machine-agenda' }))[0]?.items.map(item => item.subject) ?? [];
    return { entries: open.map(ask => String(ask.entry)), subjects };
  };
  /** The ids of the open items on the machine board: a recreated item is a new id. */
  const machineIds = async () =>
    (await fake.open({ ferret: ferretId('machine-agenda'), state: 'open' })).map(ask => String(ask.id));
  /** The owner taps "Got it" on the machine item. */
  const closeItem = async () => {
    for (const ask of await fake.open({ ferret: ferretId('machine-agenda'), state: 'open' }))
      await fake.close({ ferret: ask.ferret ?? 'machine-agenda', id: ask.id }, 'dismissed');
  };
  const later = async (minutes: number) => await host.clock.advance(minutes * 60_000);
  return {
    run,
    later,
    typed,
    notices,
    machineItem,
    machineIds,
    boardWrites: () => fake.boardWrites,
    closeItem,
    attempts: fake instanceof RefusingAsks ? fake.attempts : [],
  };
}

const kinds = (body: { readonly flags: readonly { readonly kind: string; readonly ferret: string }[] }) =>
  body.flags.map(flag => [flag.kind, flag.ferret]);

describe('Board, an optional use of the Warden', () => {
  test('Board off: the board-dependent flag (orphaned_card) does not run', async () => {
    // Arrange
    const { run, typed } = await wardenWith(undefined);

    // Act
    const ran = await run();

    // Assert
    expect(ran.status).toBe(200);
    expect(kinds(ran.json())).not.toContainEqual(['orphaned_card', 'worker']);
    expect(typed).toEqual([]);
  });

  test('Board on: a card Board calls orphaned is flagged orphaned_card, read through Board’s contract', async () => {
    // Arrange
    const { board, reads } = boardWithOrphan();
    const { run, typed, notices, machineItem } = await wardenWith(board);

    // Act
    const ran = await run();

    // Assert
    expect(ran.status).toBe(200);
    expect(reads.length).toBeGreaterThan(0);
    expect(kinds(ran.json())).toContainEqual(['orphaned_card', 'worker']);
    // Its owner ferret is not on this machine, so nobody is typed to: the card is a row of the machine item, and no
    // ask is raised on the assignee's board.
    expect(typed).toEqual([]);
    expect(await notices('worker')).toEqual([]);
    expect(await machineItem()).toEqual({ entries: ['warden.orphans'], subjects: ['A card has nobody working on it'] });
  });

  test('the owner’s message names the binary a ferret types (`fy`), never the product name', async () => {
    // Arrange
    const { board } = boardWithOrphan(ownedByLead);
    const { run, typed } = await wardenWith(board, { liveOwner: true });

    // Act
    const ran = await run();

    // Assert
    expect(ran.status).toBe(200);
    expect(typed).toHaveLength(1);
    expect(typed[0]).toStartWith('lead: ');
    expect(typed[0]).toContain('`fy resume worker`');
    expect(typed[0]).toContain('`fy task assign F1 <ferret>`');
    expect(typed[0]).toContain('`fy task drop F1 --reason "<why>"`');
    expect(typed[0]).not.toContain('Ferretry resume');
  });

  test('the owner’s message names the lane by its name, from Board’s lane sets (“waiting in Implement”)', async () => {
    // Arrange
    const { board } = boardWithOrphan(ownedByLead);
    const { run, typed } = await wardenWith(board, { liveOwner: true });

    // Act
    await run();

    // Assert
    expect(typed).toHaveLength(1);
    expect(typed[0]).toContain('It is waiting in Implement,');
    expect(typed[0]).not.toContain('waiting in implement');
  });

  test('more than one page of orphaned cards: every one is flagged, once, from one read', async () => {
    // Arrange: 1,203 cards, more than two pages of 500
    const cards = Array.from({ length: 1203 }, (_, each) =>
      cardView({ id: `F${String(each + 1)}`, owner: 'gone', assignee: 'worker' }, { activity: 'orphaned' }),
    );
    const { board, reads } = boardWithOrphan(cards);
    const { run } = await wardenWith(board);

    // Act
    const ran = await run();

    // Assert
    expect(ran.status).toBe(200);
    expect(reads).toHaveLength(1);
    expect(kinds(ran.json()).filter(([kind]) => kind === 'orphaned_card')).toHaveLength(1203);
  });

  test('a message Conversation refused is a row of the machine item, and not typed again', async () => {
    // Arrange
    const { board } = boardWithOrphan(ownedByLead);
    const { run, typed, notices, machineItem } = await wardenWith(board, { liveOwner: true, sendRefused: true });

    // Act
    await run();
    await run();

    // Assert
    expect(await notices('lead')).toEqual([]);
    expect(await machineItem()).toEqual({ entries: ['warden.orphans'], subjects: ['A card has nobody working on it'] });
    expect(typed).toHaveLength(1);
  });

  test('31 orphaned cards of several ferrets are ONE item on the machine board, and no ask on any ferret board', async () => {
    // Arrange — one board holds at most twenty unresolved items: 31 per-card asks were all refused.
    const cards = Array.from({ length: 31 }, (_, each) =>
      cardView(
        { id: `F${String(each + 1)}`, owner: 'gone', assignee: each % 2 === 0 ? 'worker' : 'lead' },
        { activity: 'orphaned' },
      ),
    );
    const { board } = boardWithOrphan(cards);
    const { run, notices, machineItem } = await wardenWith(board, { stoppedLead: true });

    // Act
    await run();
    await run();

    // Assert
    expect(await notices('worker')).toEqual([]);
    expect(await notices('lead')).toEqual([]);
    expect(await machineItem()).toEqual({
      entries: ['warden.orphans'],
      subjects: ['31 cards have nobody working on them'],
    });
  });

  test('the same orphaned cards on every run are the SAME item, and the board is written once', async () => {
    // Arrange
    const { board } = boardWithOrphan(
      Array.from({ length: 4 }, (_, each) =>
        cardView({ id: `F${String(each + 1)}`, owner: 'gone', assignee: 'worker' }, { activity: 'orphaned' }),
      ),
    );
    const { run, machineIds, boardWrites } = await wardenWith(board);

    // Act
    await run();
    const first = await machineIds();
    const written = boardWrites();
    for (let again = 0; again < 4; again += 1) await run();

    // Assert
    expect(first).toHaveLength(1);
    expect(await machineIds()).toEqual(first);
    expect(boardWrites()).toBe(written);
  });

  test('a changed list restates the SAME item, and all recovered closes it', async () => {
    // Arrange
    const card = (id: string, activity: 'orphaned' | 'active') =>
      cardView({ id, owner: 'gone', assignee: 'worker' }, { activity });
    const { board, set } = boardWithOrphan([card('F1', 'orphaned'), card('F2', 'orphaned')]);
    const { run, machineIds, machineItem } = await wardenWith(board);
    await run();
    const first = await machineIds();

    // Act
    set([card('F1', 'orphaned'), card('F2', 'active'), card('F3', 'orphaned'), card('F4', 'orphaned')]);
    await run();
    const changed = { ids: await machineIds(), item: await machineItem() };
    set([card('F1', 'active'), card('F3', 'active'), card('F4', 'active')]);
    await run();

    // Assert
    expect(changed.ids).toEqual(first);
    expect(changed.item).toEqual({ entries: ['warden.orphans'], subjects: ['3 cards have nobody working on them'] });
    expect(await machineItem()).toEqual({ entries: [], subjects: [] });
  });

  test('the owner closing the item ("Got it") is respected: the same orphaned card does not raise it again', async () => {
    // Arrange
    const { board } = boardWithOrphan();
    const { run, machineItem, closeItem } = await wardenWith(board);
    await run();

    // Act
    await closeItem();
    await run();
    await run();

    // Assert
    expect(await machineItem()).toEqual({ entries: [], subjects: [] });
  });

  test('Agenda off: the one item is tried again every sweep — one attempt, never one per card — and spends nothing', async () => {
    // Arrange
    const { board } = boardWithOrphan(
      Array.from({ length: 5 }, (_, each) =>
        cardView({ id: `F${String(each + 1)}`, owner: 'gone', assignee: 'worker' }, { activity: 'orphaned' }),
      ),
    );
    const { run, typed, attempts, notices } = await wardenWith(board, { agendaOff: true });

    // Act
    await run();
    await run();

    // Assert
    expect(attempts).toEqual(['warden.orphans', 'warden.orphans']);
    expect(await notices('worker')).toEqual([]);
    expect(typed).toEqual([]);
  });
});
