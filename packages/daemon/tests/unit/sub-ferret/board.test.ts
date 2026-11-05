import { describe, it } from 'bun:test';
import {
  type BoardTaskActionRequestInput,
  BoardTaskActionRequestSchema,
  BoardTaskCreateRequestSchema,
} from '@ferretry/protocol';
import should from 'should';
import { type BoardCaller, BoardError, BoardService, type SessionRoster } from '../../../src/lib/board/index.ts';
import { card, FakeParents, liveSession, MemoryBoardStore, rosterOf, world } from '../board/support.ts';
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

// The card's holder may do these; a sub-ferret that holds neither F2 nor its assignment is refused (F2 is its lead's).
const HOLDER_ONLY_VERBS: readonly [string, BoardTaskActionRequestInput][] = [
  ['move', { action: 'move', to: 'in-progress' }],
  ['focus', { action: 'focus' }],
  ['link a commit', { action: 'link', commit: 'abc123' }],
  ['set the status', { action: 'edit', status: { now: 'writing the route', doneSoFar: '', next: '' } }],
  ['write How to test', { action: 'edit', howToTest: '1. Open the Board' }],
];

const REFUSED_VERBS: readonly [string, BoardTaskActionRequestInput][] = [
  ['block', { action: 'block', reason: 'waiting' }],
  ['unblock', { action: 'unblock' }],
  ['depend', { action: 'depend', task: { machineId: 'machine-1', id: 'F2' } as never }],
  ['drop', { action: 'drop', reason: 'no longer needed' }],
  ['reopen', { action: 'reopen', to: 'todo', reason: 'again', ask: { text: 'again', source: 'owner' } }],
  ['assign', { action: 'assign', assignee: null }],
  ['reparent', { action: 'reparent', parent: null }],
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

  for (const [verb, request] of HOLDER_ONLY_VERBS) {
    it(`should be refused ${verb} on a card it does not hold, and let through on the one it does`, async () => {
      // Arrange
      const service = serviceWith();

      // Act
      const error = await refusal(service.act('F2', action(request), child));
      const held = await refusal(service.act('F1', action(request), child));

      // Assert
      should(error?.code).equal('forbidden');
      should(error?.message).containEql('Your lead holds this card: claim it first: fy task claim &F2');
      should(held?.code).not.equal('forbidden');
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

  it('should be refused a card even under the card it holds (DoD 11: no card without permission)', async () => {
    // Arrange — a sub-card of its own card is still a new card; only its lead or the owner makes one.
    const service = serviceWith();
    const request = BoardTaskCreateRequestSchema.parse({
      kind: 'feature',
      title: 'A part of F1',
      ask: { text: 'x', source: 'owner' },
      parent: { id: 'F1' },
    });

    // Act
    const error = await refusal(service.create(request, child));

    // Assert
    should(error?.code).equal('forbidden');
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

  it('should set the status of its own card, recorded as a field-edited event that names status', async () => {
    // Arrange
    const service = serviceWith();
    const status = { now: 'writing the route', doneSoFar: '- the field', next: '1. the CLI' };

    // Act
    const written = await service.act('F1', action({ action: 'edit', status }), child);

    // Assert
    should(written.task.status).eql(status);
    should(written.task.history.at(-1)).containEql({ type: 'field-edited', field: 'status' });
  });

  it('should write status and How to test in one edit on its own card', async () => {
    // Arrange
    const service = serviceWith();
    const status = { now: 'testing', doneSoFar: '- PR', next: '' };

    // Act
    const written = await service.act(
      'F1',
      action({ action: 'edit', status, howToTest: '1. Open the Board\n2. See the card' }),
      child,
    );

    // Assert
    should(written.task).match({ status, howToTest: '1. Open the Board\n2. See the card' });
    should(written.task.history.filter(event => event.type === 'field-edited').map(event => event.field)).eql([
      'howToTest',
      'status',
    ]);
  });

  it('should have the whole edit refused when it names status or How to test AND another field', async () => {
    // Arrange
    const service = serviceWith();
    const status = { now: 'x', doneSoFar: '', next: '' };

    // Act
    const mixed = await refusal(service.act('F1', action({ action: 'edit', status, summary: 'y' }), child));
    const title = await refusal(service.act('F1', action({ action: 'edit', title: 'y' }), child));
    const visibility = await refusal(
      service.act('F1', action({ action: 'edit', status, visibility: 'private' }), child),
    );
    const test = await refusal(service.act('F1', action({ action: 'edit', howToTest: '1. Look', brief: 'z' }), child));

    // Assert
    for (const error of [mixed, title, visibility, test]) {
      should(error?.code).equal('forbidden');
      should(error?.message).match(REFUSED);
      should(error?.message).containEql("so you can't edit cards");
    }
    should(mixed?.message).containEql(
      'You may note on, set the status and How to test of, and link a PR or branch to your own card',
    );
  });

  it('should leave its lead free to move and note the same card', async () => {
    // Arrange
    const service = serviceWith();

    // Act — into Plan: a design-first card never jumps over that gate to Implement (docs/board.md § Cards show progress)
    const moved = await refusal(service.act('F1', action({ action: 'move', to: 'plan' }), lead));

    // Assert
    should(moved).be.undefined();
  });

  it('should name its sub-ferret grandparent chain by the direct lead only', async () => {
    // Arrange
    const service = serviceWith();

    // Act
    const error = await refusal(service.act('F1', action({ action: 'drop', reason: 'done' }), ferret('grandchild')));

    // Assert
    should(error?.message).equal(
      `You are a sub-ferret, so you can't drop a card outside your own subtree. You may note on, set the status and How to test of, and link a PR or branch to your own card, and drop or reassign cards in your own subtree. For anything else ask your lead: fy send child "…"`,
    );
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

describe('planning inside a subtree', () => {
  // lead > child > grandchild; lead > sibling > cousin; `stranger` is nobody's descendant.
  const PARENTS = { child: 'lead', grandchild: 'child', sibling: 'lead', cousin: 'sibling' };
  const TREE = {
    leadOf: async (sessionId: string) => (PARENTS as Record<string, string | undefined>)[sessionId],
    addressOf: async (sessionId: string) => (sessionId === 'lead' ? 'lizzette' : sessionId),
  };
  const treeWith = (cards: Parameters<typeof card>[0][]) => {
    const ports = world({
      store: new MemoryBoardStore(cards.map(overrides => card(overrides))),
      parents: new FakeParents(PARENTS),
      subFerrets: TREE,
    });
    return { ports, service: new BoardService(ports) };
  };
  const drop = action({ action: 'drop', reason: 'no longer needed' });
  const assignTo = (assignee: string | null) => action({ action: 'assign', assignee });

  it('should let a lead drop and assign a card owned by its grandchild', async () => {
    // Arrange
    const { service } = treeWith([{ owner: 'grandchild' }, { id: 'F2', owner: 'grandchild' }]);

    // Act
    const assigned = await refusal(service.act('F1', assignTo('child'), lead));
    const dropped = await refusal(service.act('F2', drop, lead));

    // Assert
    should([assigned, dropped]).eql([undefined, undefined]);
  });

  it('should let a lead drop and assign a card assigned to a descendant but owned by another party', async () => {
    // Arrange
    const { service, ports } = treeWith([
      { owner: 'stranger', assignee: 'grandchild' },
      { id: 'F2', owner: 'stranger', assignee: 'grandchild' },
    ]);

    // Act
    const assigned = await refusal(service.act('F1', assignTo('child'), lead));
    const dropped = await refusal(service.act('F2', drop, lead));

    // Assert
    should([assigned, dropped]).eql([undefined, undefined]);
    should(ports.store.cards.get('F1')?.assignee).equal('child');
    should(ports.store.cards.get('F2')?.dropped).not.be.null();
  });

  it('should let a sub-ferret that leads a subtree drop and assign cards anywhere in it', async () => {
    // Arrange
    const { service } = treeWith([
      { owner: 'grandchild' },
      { id: 'F2', owner: 'stranger', assignee: 'grandchild' },
      { id: 'F3', owner: 'child', assignee: 'grandchild' },
    ]);

    // Act
    const results = await Promise.all([
      refusal(service.act('F1', assignTo('grandchild'), child)),
      refusal(service.act('F2', drop, child)),
      refusal(service.act('F3', drop, child)),
    ]);

    // Assert
    should(results).eql([undefined, undefined, undefined]);
  });

  it('should refuse a sub-ferret a card outside its subtree, and say what its subtree allows', async () => {
    // Arrange
    const { service, ports } = treeWith([
      { owner: 'cousin' },
      { id: 'F2', owner: 'stranger', assignee: 'cousin' },
      { id: 'F3', owner: 'sibling' },
    ]);

    // Act
    const sideways = await refusal(service.act('F1', drop, child));
    const assigned = await refusal(service.act('F2', assignTo('grandchild'), child));
    const sibling = await refusal(service.act('F3', assignTo('child'), child));

    // Assert
    for (const error of [sideways, assigned, sibling]) {
      should(error?.code).equal('forbidden');
      should(error?.message).match(
        /^You are a sub-ferret, so you can't .+ outside your own subtree\. You may .+ in your own subtree\./,
      );
      should(error?.message).endWith('For anything else ask your lead: fy send lizzette "…"');
    }
    should(sideways?.message).containEql("you can't drop a card outside your own subtree");
    should(sibling?.message).containEql("you can't reassign a card outside your own subtree");
    should([...ports.store.cards.values()].map(each => each.dropped)).eql([null, null, null]);
  });

  it('should refuse a sub-ferret that only holds a card, and a stranger the lead of nothing', async () => {
    // Arrange
    const { service } = treeWith([{ owner: 'lead', assignee: 'grandchild' }]);

    // Act
    const grandchild = await refusal(service.act('F1', drop, ferret('grandchild')));
    const stranger = await refusal(service.act('F1', drop, ferret('stranger')));

    // Assert
    should(grandchild?.message).match(REFUSED_SUBTREE);
    should(stranger?.code).equal('forbidden');
    should(stranger?.message).not.match(/sub-ferret/);
  });

  it('should let a middle lead drop or hand on a card the daemon returned to it', async () => {
    // Arrange — owned by `child`, worked by `grandchild`, who ended: the card comes back to `child`
    const { service, ports } = treeWith([
      { id: 'F2', owner: 'child', assignee: 'grandchild', laneId: 'review' },
      { id: 'F3', owner: 'child', assignee: 'grandchild', laneId: 'review' },
    ]);
    const ended: SessionRoster = rosterOf([
      liveSession('lead'),
      liveSession('child', { lead: 'lead' }),
      liveSession('grandchild', { lead: 'child', status: 'completed' }),
    ]);
    const returnAll = async (id: string) =>
      await service.returnToLead(id, { lead: 'child', from: 'grandchild' }, async work => await work(ended));

    // Act
    const returned = [await returnAll('F2'), await returnAll('F3')];
    const handed = await refusal(service.act('F2', assignTo('sibling'), child));
    const dropped = await refusal(service.act('F3', drop, child));

    // Assert
    should(returned).eql([true, true]);
    should([handed, dropped]).eql([undefined, undefined]);
    should(ports.store.cards.get('F2')?.assignee).equal('sibling');
    should(ports.store.cards.get('F3')?.dropped).not.be.null();
  });

  it('should still refuse a middle lead the board moves that are not drop or assign', async () => {
    // Arrange
    const { service } = treeWith([{ owner: 'grandchild' }]);

    // Act
    const moved = await refusal(service.act('F1', action({ action: 'move', to: 'plan' }), child));

    // Assert
    should(moved?.message).containEql("you can't move cards");
  });
});

const REFUSED_SUBTREE = /^You are a sub-ferret, so you can't .+ outside your own subtree\./;
