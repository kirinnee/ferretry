import { describe, it } from 'bun:test';
import { type BoardTask, BoardTaskActionRequestSchema } from '@ferretry/protocol';
import should from 'should';
import {
  type BoardCaller,
  BoardError,
  BoardService,
  type BoardStanding,
  type CardAudience,
  mayPassGate,
} from '../../../src/lib/board/index.ts';
import { card, MemoryBoardStore, world } from './support.ts';

/**
 * WHO PASSES A GATE (docs/board.md § Gates ask the owner): the owner always; on an INTERNAL card (a ferret's own
 * errand) its owner ferret and the leads above it too; nobody else. Every standing × audience × kind of lane.
 */

const STANDINGS: readonly BoardStanding[] = ['owner-human', 'owner', 'ancestor', 'assignee', 'daemon', 'reader'];

describe('mayPassGate', () => {
  it('lets only the owner pass an external card’s gate', () => {
    for (const standing of STANDINGS) should(mayPassGate(standing, 'external')).equal(standing === 'owner-human');
  });

  it('lets the owner, the owner ferret and its leads pass an internal card’s gate', () => {
    const keepers = new Set<BoardStanding>(['owner-human', 'owner', 'ancestor']);
    for (const standing of STANDINGS) should(mayPassGate(standing, 'internal')).equal(keepers.has(standing));
  });
});

/** The card's owner ferret is `child`, started by `lead`; `grandchild` works it; `stranger` is nobody to it. */
const CALLERS: Readonly<Record<Exclude<BoardStanding, 'daemon'>, BoardCaller>> = {
  'owner-human': { kind: 'owner' },
  owner: { kind: 'ferret', sessionId: 'child' },
  ancestor: { kind: 'ferret', sessionId: 'lead' },
  assignee: { kind: 'ferret', sessionId: 'grandchild' },
  reader: { kind: 'ferret', sessionId: 'stranger' },
};

/** An external card is one a person asked for (its ask names the owner); an internal one is `child`'s own errand. */
const cardFor = (audience: CardAudience, laneId: string): BoardTask =>
  card({
    laneId,
    owner: 'child',
    assignee: 'grandchild',
    createdBy: { kind: 'ferret', sessionId: 'child' },
    ask:
      audience === 'external' ? { text: 'build it', source: 'owner' } : { text: 'build it', source: 'session:child' },
    history: [
      {
        seq: 1,
        at: '2026-10-30T10:00:00.000Z',
        actor: { kind: 'ferret', sessionId: 'child' },
        type: 'created',
        laneId,
      },
    ],
  });

/** The three kinds of move: out of an ordinary lane, out of an owner gate, and into the gated closed lane. */
const MOVES = [
  { kind: 'ordinary', from: 'implement', to: 'review' },
  { kind: 'gate', from: 'plan', to: 'implement' },
  { kind: 'close', from: 'tested', to: 'closed' },
] as const;

const allowed = (standing: BoardStanding, audience: CardAudience, kind: (typeof MOVES)[number]['kind']): boolean => {
  if (kind === 'ordinary') return standing !== 'reader';
  return mayPassGate(standing, audience);
};

describe('moving a card through a gate, by standing and audience', () => {
  for (const audience of ['external', 'internal'] as const) {
    for (const move of MOVES) {
      for (const [standing, caller] of Object.entries(CALLERS) as [Exclude<BoardStanding, 'daemon'>, BoardCaller][]) {
        const expected = allowed(standing, audience, move.kind);
        it(`${expected ? 'lets' : 'refuses'} ${standing} on an ${audience} card: ${move.from} → ${move.to}`, async () => {
          // Arrange
          const store = new MemoryBoardStore([cardFor(audience, move.from)]);
          const service = new BoardService(world({ store }));
          const request = BoardTaskActionRequestSchema.parse({ action: 'move', to: move.to });

          // Act
          const outcome = await service.act('F1', request, caller).then(
            () => undefined,
            (error: unknown) => error,
          );

          // Assert
          if (expected) {
            should(outcome).be.undefined();
            should(store.cards.get('F1')?.laneId).equal(move.to);
          } else {
            should(outcome).be.instanceOf(BoardError);
            should((outcome as BoardError).code).equalOneOf('owner-gate', 'forbidden');
            should(store.cards.get('F1')?.laneId).equal(move.from);
          }
        });
      }
    }
  }

  it('tells a ferret refused at an external gate that the owner is asked in the Inbox', async () => {
    // Arrange
    const store = new MemoryBoardStore([cardFor('external', 'plan')]);
    const service = new BoardService(world({ store }));

    // Act
    const error = await service
      .act('F1', BoardTaskActionRequestSchema.parse({ action: 'move', to: 'implement' }), CALLERS.ancestor)
      .then(
        () => undefined,
        (thrown: unknown) => thrown as BoardError,
      );

    // Assert
    should(error?.code).equal('owner-gate');
    should(error?.message).containEql('the daemon asks them in the Inbox');
    should(error?.allowed).eql(['owner-human']);
  });

  it('names the owner ferret and its leads when an internal card’s assignee is refused', async () => {
    // Arrange
    const store = new MemoryBoardStore([cardFor('internal', 'plan')]);
    const service = new BoardService(world({ store }));

    // Act
    const error = await service
      .act('F1', BoardTaskActionRequestSchema.parse({ action: 'move', to: 'implement' }), CALLERS.assignee)
      .then(
        () => undefined,
        (thrown: unknown) => thrown as BoardError,
      );

    // Assert
    should(error?.code).equal('owner-gate');
    should(error?.allowed).eql(['owner-human', 'owner', 'ancestor']);
  });

  it('keeps a lead’s move of its internal card recorded as the lead’s', async () => {
    // Arrange
    const store = new MemoryBoardStore([cardFor('internal', 'tested')]);
    const service = new BoardService(world({ store }));

    // Act
    await service.act('F1', BoardTaskActionRequestSchema.parse({ action: 'move', to: 'closed' }), CALLERS.ancestor);

    // Assert
    should(store.cards.get('F1')?.history.at(-1)).match({
      type: 'moved',
      from: 'tested',
      to: 'closed',
      actor: { kind: 'ferret', sessionId: 'lead' },
    });
  });
});
