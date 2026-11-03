import { describe, it } from 'bun:test';
import { type BoardTaskActionRequestInput, BoardTaskActionRequestSchema } from '@ferretry/protocol';
import should from 'should';
import {
  type BoardCaller,
  BoardError,
  BoardService,
  claimableFrom,
  claimRefusalMessage,
} from '../../../src/lib/board/index.ts';
import { subFerretRefusal } from '../../../src/lib/sub-ferret/index.ts';
import { card, FakeParents, MemoryBoardStore, world } from './support.ts';

const ferret = (sessionId: string): BoardCaller => ({ kind: 'ferret', sessionId });
const claim = BoardTaskActionRequestSchema.parse({ action: 'claim' });
const action = (input: BoardTaskActionRequestInput) => BoardTaskActionRequestSchema.parse(input);

// lead > child > grandchild; lead > sibling > cousin; `stranger` is nobody's descendant.
const PARENTS = { child: 'lead', grandchild: 'child', sibling: 'lead', cousin: 'sibling', kid: 'stranger' };
const DIRECTORY = {
  leadOf: async (sessionId: string) => (PARENTS as Record<string, string | undefined>)[sessionId],
  addressOf: async (sessionId: string) => (sessionId === 'lead' ? 'lizzette' : sessionId),
};

const treeWith = (...cards: Parameters<typeof card>[0][]) => {
  const ports = world({
    store: new MemoryBoardStore(cards.map(overrides => card(overrides))),
    parents: new FakeParents(PARENTS),
    subFerrets: DIRECTORY,
  });
  return { ports, service: new BoardService(ports) };
};

async function refusal(work: Promise<unknown>): Promise<BoardError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  should(error).be.instanceOf(BoardError);
  return error as BoardError;
}

describe('which lead a ferret may claim a card from', () => {
  it('should be the holder when it is one of the ferret’s own ancestors, and nobody otherwise', () => {
    // Act
    const results = {
      parent: claimableFrom(ferret('child'), { owner: 'lead', assignee: null }, ['lead']),
      grandparent: claimableFrom(ferret('grandchild'), { owner: 'lead', assignee: null }, ['child', 'lead']),
      leadsAssignee: claimableFrom(ferret('grandchild'), { owner: 'other', assignee: 'child' }, ['child', 'lead']),
      sibling: claimableFrom(ferret('child'), { owner: 'lead', assignee: 'sibling' }, ['lead']),
      cousin: claimableFrom(ferret('cousin'), { owner: 'lead', assignee: 'child' }, ['sibling', 'lead']),
      unrelated: claimableFrom(ferret('kid'), { owner: 'lead', assignee: null }, ['stranger']),
      already: claimableFrom(ferret('child'), { owner: 'lead', assignee: 'child' }, ['lead']),
      owner: claimableFrom({ kind: 'owner' }, { owner: 'lead', assignee: null }, []),
      daemon: claimableFrom({ kind: 'daemon' }, { owner: 'lead', assignee: null }, []),
    };

    // Assert
    should(results).eql({
      parent: 'lead',
      grandparent: 'lead',
      leadsAssignee: 'child',
      sibling: undefined,
      cousin: undefined,
      unrelated: undefined,
      already: undefined,
      owner: undefined,
      daemon: undefined,
    });
  });
});

describe('claiming a card', () => {
  it('should take a card its parent holds, and journal who it was claimed from', async () => {
    // Arrange
    const { ports, service } = treeWith({ owner: 'lead' });

    // Act
    const response = await service.act('F1', claim, ferret('child'));

    // Assert
    should(response.task.assignee).equal('child');
    should(ports.store.cards.get('F1')?.history.at(-1)).match({
      type: 'assigned',
      from: null,
      to: 'child',
      claimedFrom: 'lead',
      actor: { kind: 'ferret', sessionId: 'child' },
    });
  });

  it('should take a card its grandparent holds', async () => {
    // Arrange
    const { ports, service } = treeWith({ owner: 'lead' });

    // Act
    await service.act('F1', claim, ferret('grandchild'));

    // Assert
    should(ports.store.cards.get('F1')?.assignee).equal('grandchild');
    should(ports.store.cards.get('F1')?.history.at(-1)).match({ claimedFrom: 'lead' });
  });

  it('should take a card its lead holds as an assignee, whoever owns it', async () => {
    // Arrange
    const { ports, service } = treeWith({ owner: 'stranger', assignee: 'child' });

    // Act
    await service.act('F1', claim, ferret('grandchild'));

    // Assert
    should(ports.store.cards.get('F1')?.assignee).equal('grandchild');
    should(ports.store.cards.get('F1')?.history.at(-1)).match({ from: 'child', claimedFrom: 'child' });
  });

  for (const [name, held, caller] of [
    ['a sibling’s', { owner: 'lead', assignee: 'sibling' }, 'child'],
    ['a cousin’s', { owner: 'lead', assignee: 'child' }, 'cousin'],
    ['an unrelated ferret’s', { owner: 'stranger', assignee: 'stranger' }, 'child'],
    ['a card held by a ferret outside its lineage', { owner: 'lead', assignee: 'kid' }, 'child'],
  ] as const) {
    it(`should refuse ${name} card, change nothing, and say who it is held by`, async () => {
      // Arrange
      const { ports, service } = treeWith(held);

      // Act
      const error = await refusal(service.act('F1', claim, ferret(caller)));

      // Assert
      should(error.code).equal('forbidden');
      should(error.message).containEql(`held by ${held.assignee}`);
      should(ports.store.writes).be.empty();
    });
  }

  it('should refuse a card held by a ferret that is not a lead of the caller, even if it is sibling’s owner', async () => {
    // Arrange — `lead` owns the card and is the sibling's lead too, but the sibling holds it.
    const { service } = treeWith({ owner: 'lead', assignee: 'sibling' });

    // Act
    const error = await refusal(service.act('F1', claim, ferret('child')));

    // Assert
    should(error.message).match(/only a ferret below the ferret holding &F1 may claim it/u);
  });

  it('should refuse the owner (a person) and the daemon, who assign instead', async () => {
    // Arrange
    const { service } = treeWith({ owner: 'lead' });

    // Act
    const byOwner = await refusal(service.act('F1', claim, { kind: 'owner' }));
    const byDaemon = await refusal(service.act('F1', claim, { kind: 'daemon' }));

    // Assert
    should(byOwner.message).equal("claim is a ferret's: &F1 is taken with `fy task assign &F1 <ferret>`");
    should(byDaemon.code).equal('forbidden');
  });

  it('should say a card is already yours, and that an owner takes its own card with assign', async () => {
    // Arrange
    const { service } = treeWith(
      { owner: 'lead', assignee: 'child' },
      { id: 'F2', owner: 'child', assignee: 'grandchild' },
    );

    // Act
    const mine = await refusal(service.act('F1', claim, ferret('child')));
    const owned = await refusal(service.act('F2', claim, ferret('child')));

    // Assert
    should(mine.message).equal('&F1 is already yours');
    should(owned.message).equal('you own &F2: take it with `fy task assign &F2 child`');
  });

  it('should leave a claimed card to move only through its daemon triggers, never a sub-ferret’s move', async () => {
    // Arrange
    const { service } = treeWith({ owner: 'lead' });
    await service.act('F1', claim, ferret('child'));

    // Act
    const moved = await refusal(service.act('F1', action({ action: 'move', to: 'plan' }), ferret('child')));

    // Assert
    should(moved.code).equal('forbidden');
  });
});

describe('what a refused sub-ferret is told about a card its lead holds', () => {
  it('should say to claim it first on a move and a focus, naming the command', async () => {
    // Arrange
    const { service } = treeWith({ owner: 'lead' });

    // Act
    const refused = [
      await refusal(service.act('F1', action({ action: 'move', to: 'plan' }), ferret('child'))),
      await refusal(service.act('F1', action({ action: 'focus' }), ferret('child'))),
    ];

    // Assert
    for (const error of refused) {
      should(error.message).match(
        /^You are a sub-ferret, so you can't .+\. You may .+\. Your lead holds this card: claim it first: fy task claim &F1$/u,
      );
      should(error.message).not.containEql('fy send');
    }
  });

  it('should keep telling the sub-ferret to ask its lead for a card it cannot claim', async () => {
    // Arrange
    const { service } = treeWith({ owner: 'lead', assignee: 'sibling' });

    // Act
    const error = await refusal(service.act('F1', action({ action: 'move', to: 'plan' }), ferret('child')));

    // Assert
    should(error.message).endWith('For anything else ask your lead: fy send lizzette "…"');
  });

  it('should word the tail from the claim command when one is given', async () => {
    // Act
    const message = await subFerretRefusal(DIRECTORY, 'child', 'move cards', undefined, 'fy task claim &F7');

    // Assert
    should(message).endWith('Your lead holds this card: claim it first: fy task claim &F7');
  });
});

describe('the refusal text of a claim', () => {
  it('should name the holder and send a ferret outside the lineage to its lead', () => {
    // Act
    const text = claimRefusalMessage({ id: 'F3', owner: 'lead', assignee: 'sibling' }, ferret('child'));

    // Assert
    should(text).equal(
      'only a ferret below the ferret holding &F3 may claim it (held by sibling); a card held by a ferret outside your lineage is theirs: ask your lead',
    );
  });
});
