import { describe, it } from 'bun:test';
import should from 'should';
import { BoardError, BoardService, type CardMoveInput } from '../../../daemon/lib/board/index.ts';
import { card, MemoryBoardStore, world } from './support.ts';

/**
 * `card.moving` is asked at the board service's ONE write, so every path that changes a card's lane — an owner's
 * act, a daemon trigger (the watcher, a release), a gate answer, a refile, the sweep — is asked, not only the route's
 * move; and `board.card-moved` is told once the move landed.
 */
const setup = (verdict: (input: CardMoveInput) => { allow: true } | { allow: false; reason: string }) => {
  const store = new MemoryBoardStore([card({ laneId: 'implement' })]);
  const asked: CardMoveInput[] = [];
  const moved: Omit<CardMoveInput, 'by'>[] = [];
  const service = new BoardService(
    world({
      store,
      moving: async input => {
        asked.push(input);
        return verdict(input);
      },
      moved: input => {
        moved.push(input);
      },
    }),
  );
  return { store, asked, moved, service };
};

describe('card.moving at the one write of a card', () => {
  it('should ask it of a daemon trigger’s move, and leave the card where it is on a no', async () => {
    const { store, asked, moved, service } = setup(() => ({ allow: false, reason: 'frozen for the release' }));

    await service.trigger('F1', 'pr.opened', { ferret: 'child', reason: 'PR #930 opened' }).then(
      () => should.fail(undefined, undefined, 'a refused move was written'),
      (error: unknown) => should(error).be.instanceOf(BoardError).and.match({ code: 'forbidden' }),
    );

    should(asked).match([{ card: 'F1', from: 'implement', to: 'review', by: { kind: 'daemon' } }]);
    should(store.cards.get('F1')?.laneId).equal('implement');
    should(moved).be.empty();
  });

  it('should ask it of the owner’s move and tell board.card-moved once the move landed', async () => {
    const { asked, moved, service } = setup(() => ({ allow: true }));

    await service.act('F1', { action: 'move', to: 'review', reason: 'ready' }, { kind: 'owner' });

    should(asked).match([{ from: 'implement', to: 'review', by: { kind: 'owner' } }]);
    should(moved).eql([{ card: 'F1', from: 'implement', to: 'review' }]);
  });

  it('should not ask it of a write that leaves the lane alone', async () => {
    const { asked, moved, service } = setup(() => ({ allow: false, reason: 'no' }));

    await service.act('F1', { action: 'note', text: 'still going' }, { kind: 'owner' });

    should(asked).be.empty();
    should(moved).be.empty();
  });
});

describe('an answer to a `card` entry that is not a gate’s', () => {
  it('should be refused, so Asks keeps the ask open, never reported applied with no card moved', async () => {
    const { boot } = await import('../../integration/daemon/harness.ts');
    const world_ = await boot();
    const raised = await world_.asks.raise({
      source: 'card',
      ref: { card: 'F1' },
      entry: 'not-a-gate',
      kind: 'yesno',
      subject: 'Something else',
      why: 'for the test',
      raisedBy: { kind: 'daemon' },
      ferret: 'f1',
    } as never);

    const outcome = await world_.apply({
      id: 'an_000000000000000000000077',
      ferret: raised.ferret,
      ask: raised.id,
      source: 'card',
      entry: 'not-a-gate',
      effect: 'choose',
      choice: 'Yes',
      by: { kind: 'host' },
      at: '2026-11-07T09:00:00.000Z',
    } as never);

    should(outcome).match({ refused: /not a card’s gate/u });
  });
});
