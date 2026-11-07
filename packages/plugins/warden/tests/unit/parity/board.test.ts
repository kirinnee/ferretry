import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId, T0 } from '@ferretry/core-ferrets/contract/testing';
import { fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import type { BoardApi, CardView } from '@ferretry/plugin-board/contract';
import { fakeBoard } from '@ferretry/plugin-board/contract/testing';
import type { ConversationApi } from '@ferretry/plugin-conversation/contract';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import daemon from '../../../daemon/index.ts';
import { cardView } from '../board-fixtures.ts';

/** `F1`, owned by a ferret no longer on this machine, its assignee `worker` stopped: Board calls it orphaned. */
const orphaned: CardView = cardView({ owner: 'gone', assignee: 'worker' }, { activity: 'orphaned' });

/** Board's contract fake, answering one orphaned card, recording every read of the cards. */
function boardWithOrphan(): { readonly board: BoardApi; readonly reads: number[] } {
  const reads: number[] = [];
  const board: BoardApi = {
    ...fakeBoard(),
    cards: async () => {
      reads.push(reads.length + 1);
      return [orphaned];
    },
  };
  return { board, reads };
}

/** The real daemon half, Board on (`uses.board` given) or off (omitted), with a stopped `worker`. */
async function wardenWith(board: BoardApi | undefined) {
  const ferrets = new FakeFerrets();
  const base = fakeConversation();
  const typed: string[] = [];
  const conversation: ConversationApi = {
    ...base,
    send: async (ferret, caller, request) => {
      typed.push(`${ferret}: ${request.message}`);
      return await base.send(ferret, caller, request);
    },
  };
  const host = await testHost({
    plugins: [daemon],
    fakes: { ferrets, asks: new FakeAsks(), conversation },
    ...(board === undefined ? {} : { uses: { board } }),
    clock: fixedClock('2026-11-07T12:00:00.000Z'),
  });
  ferrets.add({ id: ferretId('worker'), mode: 'auto', state: 'stopped', stateAt: T0 });
  const run = async () => await host.request('POST', '/v1/warden/run', { body: { spawn: false }, as: owner() });
  return { run, typed };
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
    const { run, typed } = await wardenWith(board);

    // Act
    const ran = await run();

    // Assert
    expect(ran.status).toBe(200);
    expect(reads.length).toBeGreaterThan(0);
    expect(kinds(ran.json())).toContainEqual(['orphaned_card', 'worker']);
    // Its owner ferret is not on this machine, so nobody is typed to: the owner gets a notice instead.
    expect(typed).toEqual([]);
  });
});
