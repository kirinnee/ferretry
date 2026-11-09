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

/** An Asks that refuses every notice, remembering the entries it was asked to post. */
class RefusingAsks extends FakeAsks {
  readonly attempts: string[] = [];
  override async notify(...[notice]: Parameters<FakeAsks['notify']>): ReturnType<FakeAsks['notify']> {
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
} {
  const all = Array.isArray(card) ? card : [card as CardView];
  const reads: number[] = [];
  const board: BoardApi = {
    ...fakeBoard(),
    orphanedCards: async () => {
      reads.push(reads.length + 1);
      return { cards: all, laneSets: [lanes(PROJECT)] };
    },
  };
  return { board, reads };
}

interface WardenOptions {
  /** A live auto ferret `lead` the card's owner is, so the sweep can type to it. */
  readonly liveOwner?: boolean;
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
  const run = async () => await host.request('POST', '/v1/warden/run', { body: { spawn: false }, as: owner() });
  /** The notices standing on a ferret's board, as `source`/`entry` pairs. */
  const notices = async (ferret: string) =>
    (await fake.open({ ferret: ferretId(ferret), state: 'open' })).map(ask => String(ask.entry));
  const later = async (minutes: number) => await host.clock.advance(minutes * 60_000);
  return { run, later, typed, notices, attempts: fake instanceof RefusingAsks ? fake.attempts : [] };
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
    const { run, typed, notices } = await wardenWith(board);

    // Act
    const ran = await run();

    // Assert
    expect(ran.status).toBe(200);
    expect(reads.length).toBeGreaterThan(0);
    expect(kinds(ran.json())).toContainEqual(['orphaned_card', 'worker']);
    // Its owner ferret is not on this machine, so nobody is typed to: the notice goes on the assignee's board.
    expect(typed).toEqual([]);
    expect(await notices('worker')).toEqual(['f.worker.warden-orphan:F1']);
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

  test('a message Conversation refused is told by a notice on the owner’s board, and not typed again', async () => {
    // Arrange
    const { board } = boardWithOrphan(ownedByLead);
    const { run, typed, notices } = await wardenWith(board, { liveOwner: true, sendRefused: true });

    // Act
    await run();
    await run();

    // Assert
    expect(await notices('lead')).toEqual(['f.lead.warden-orphan:F1']);
    expect(typed).toHaveLength(1);
  });

  test('Agenda off: the card is not remembered as told, so it is tried again after the wait (not every sweep) and spends nothing', async () => {
    // Arrange
    const { board } = boardWithOrphan();
    const { run, later, typed, attempts, notices } = await wardenWith(board, { agendaOff: true });

    // Act
    await run();
    await run();
    const sameWait = attempts.length;
    await later(5);
    await run();

    // Assert
    expect(sameWait).toBe(1);
    expect(attempts).toEqual(['f.worker.warden-orphan:F1', 'f.worker.warden-orphan:F1']);
    expect(await notices('worker')).toEqual([]);
    expect(typed).toEqual([]);
  });
});
