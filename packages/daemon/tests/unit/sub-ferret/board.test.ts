import { describe, it } from 'bun:test';
import {
  type BoardTaskActionRequestInput,
  BoardTaskActionRequestSchema,
  BoardTaskCreateRequestSchema,
} from '@ferretry/protocol';
import should from 'should';
import { type BoardCaller, BoardError, BoardService } from '../../../src/lib/board/index.ts';
import { card, FakeParents, MemoryBoardStore, world } from '../board/support.ts';
import { DIRECTORY, REFUSED } from './support.ts';

const ferret = (sessionId: string): BoardCaller => ({ kind: 'ferret', sessionId });
const lead = ferret('lead');
const child = ferret('child');
const url = 'https://github.com/kirinnee/ferretry/pull/930';
const action = (input: BoardTaskActionRequestInput) => BoardTaskActionRequestSchema.parse(input);

const serviceWith = () => {
  const ports = world({
    store: new MemoryBoardStore([card({ owner: 'lead', assignee: 'child' }), card({ id: 'F2', owner: 'lead' })]),
    subFerrets: DIRECTORY,
  });
  return new BoardService(ports);
};

async function refusal(work: Promise<unknown>): Promise<BoardError | undefined> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  return error instanceof BoardError ? error : undefined;
}

const REFUSED_VERBS: readonly [string, BoardTaskActionRequestInput][] = [
  ['move', { action: 'move', to: 'in-progress' }],
  ['focus', { action: 'focus' }],
  ['block', { action: 'block', reason: 'waiting' }],
  ['unblock', { action: 'unblock' }],
  ['depend', { action: 'depend', task: { machineId: 'machine-1', id: 'F2' } as never }],
  ['drop', { action: 'drop', reason: 'no longer needed' }],
  ['reopen', { action: 'reopen', to: 'todo', reason: 'again', ask: { text: 'again', source: 'owner' } }],
  ['assign', { action: 'assign', assignee: null }],
  ['reparent', { action: 'reparent', parent: null }],
  ['link a commit', { action: 'link', commit: 'abc123' }],
  ['order', { action: 'order', order: 1 }],
];

describe('a sub-ferret on the board', () => {
  for (const [verb, request] of REFUSED_VERBS) {
    it(`should be refused ${verb} and told whom to tell`, async () => {
      // Arrange
      const service = serviceWith();

      // Act
      const error = await refusal(service.act('F1', action(request), child));

      // Assert
      should(error?.code).equal('forbidden');
      should(error?.message).match(REFUSED);
    });
  }

  it('should hand its card down to its own sub-ferret, and nowhere else', async () => {
    // Arrange
    const ports = world({
      store: new MemoryBoardStore([card({ owner: 'lead', assignee: 'child' })]),
      parents: new FakeParents({ child: 'lead', grandchild: 'child', sibling: 'lead' }),
      subFerrets: DIRECTORY,
    });
    const service = new BoardService(ports);
    const to = (assignee: string | null) => action({ action: 'assign', assignee });

    // Act
    const refused = [
      await refusal(service.act('F1', to('sibling'), child)),
      await refusal(service.act('F1', to('lead'), child)),
      await refusal(service.act('F1', to(null), child)),
      await refusal(service.act('F1', to('child'), child)),
    ];
    const notAssignee = await refusal(service.act('F1', to('grandchild'), ferret('sibling')));
    const handed = await refusal(service.act('F1', to('grandchild'), child));

    // Assert
    should(refused.map(error => error?.message.match(REFUSED) !== null)).eql([true, true, true, true]);
    should(notAssignee?.code).equal('forbidden');
    should(handed).be.undefined();
    should(ports.store.cards.get('F1')?.assignee).equal('grandchild');
  });

  it('should be refused a new card', async () => {
    // Arrange
    const service = serviceWith();
    const request = BoardTaskCreateRequestSchema.parse({
      kind: 'feature',
      title: 'More',
      ask: { text: 'x', source: 'owner' },
    });

    // Act
    const error = await refusal(service.create(request, child));

    // Assert
    should(error?.message).match(REFUSED);
  });

  it('should still note on its own card and link its PR and branch', async () => {
    // Arrange
    const service = serviceWith();

    // Act
    const outcomes = await Promise.all(
      [
        { action: 'note', text: 'halfway' },
        { action: 'link', pr: url },
        { action: 'link', branch: 'feat/x' },
      ].map(async request => await refusal(service.act('F1', action(request as BoardTaskActionRequestInput), child))),
    );

    // Assert
    should(outcomes).eql([undefined, undefined, undefined]);
  });

  it('should leave its lead free to move and note the same card', async () => {
    // Arrange
    const service = serviceWith();

    // Act
    const moved = await refusal(service.act('F1', action({ action: 'move', to: 'implement' }), lead));

    // Assert
    should(moved).be.undefined();
  });

  it('should name its sub-ferret grandparent chain by the direct lead only', async () => {
    // Arrange
    const service = serviceWith();

    // Act
    const error = await refusal(service.act('F1', action({ action: 'drop', reason: 'done' }), ferret('grandchild')));

    // Assert
    should(error?.message).equal('Sub-ferrets don\'t drop cards; tell your lead: fy send child "…"');
  });

  it('should not limit the owner', async () => {
    // Arrange
    const service = serviceWith();

    // Act
    const owner = await refusal(service.act('F1', action({ action: 'drop', reason: 'done' }), { kind: 'owner' }));

    // Assert
    should(owner).be.undefined();
  });
});
