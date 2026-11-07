import { describe, it } from 'bun:test';
import { type CardActionRequestInput, CardActionRequestSchema } from '../../../contract/index.ts';
import should from 'should';
import {
  type BoardCaller,
  BoardError,
  BoardService,
  claimableFrom,
  claimRefusalMessage,
} from '../../../daemon/lib/board/index.ts';
import { helperRefusal as subFerretRefusal } from '../../../daemon/lib/board/index.ts';
import { card, FakeParents, MemoryBoardStore, world } from './support.ts';

const ferret = (ferret: string): BoardCaller => ({ kind: 'ferret', ferret });
const claim = CardActionRequestSchema.parse({ action: 'claim' });
const action = (input: CardActionRequestInput) => CardActionRequestSchema.parse(input);

// lead > child > grandchild; lead > sibling > cousin; `stranger` is nobody's descendant.
const PARENTS = { child: 'lead', grandchild: 'child', sibling: 'lead', cousin: 'sibling', kid: 'stranger' };
const DIRECTORY = {
  leadOf: async (ferret: string) => (PARENTS as Record<string, string | undefined>)[ferret],
  addressOf: async (ferret: string) => (ferret === 'lead' ? 'lizzette' : ferret),
};

const treeWith = (...cards: Parameters<typeof card>[0][]) => {
  const ports = world({
    store: new MemoryBoardStore(cards.map(overrides => card(overrides))),
    parents: new FakeParents(PARENTS),
    helpers: DIRECTORY,
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
    should(response.card.assignee).equal('child');
    should(ports.store.cards.get('F1')?.history.at(-1)).match({
      type: 'assigned',
      from: null,
      to: 'child',
      claimedFrom: 'lead',
      actor: { kind: 'ferret', ferret: 'child' },
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
    should(byOwner.message).equal("claim is a ferret's: &F1 is taken with `fy card assign &F1 <ferret>`");
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
    should(owned.message).equal('you own &F2: take it with `fy card assign &F2 child`');
  });

  it('should let the claimer move the card it now holds, and journal the move as the ferret’s', async () => {
    // Arrange
    const { ports, service } = treeWith({ owner: 'lead' });
    await service.act('F1', claim, ferret('child'));

    // Act
    const moved = await service.act('F1', action({ action: 'move', to: 'plan' }), ferret('child'));

    // Assert
    should(moved.card.laneId).equal('plan');
    should(ports.store.cards.get('F1')?.history.at(-1)).match({ actor: { kind: 'ferret', ferret: 'child' } });
  });

  it('should let the claimer focus on and link a commit or doc to the card it now holds', async () => {
    // Arrange
    const { ports, service } = treeWith({ owner: 'lead' });
    await service.act('F1', claim, ferret('child'));

    // Act
    await service.act('F1', action({ action: 'focus' }), ferret('child'));
    const linked = await service.act('F1', action({ action: 'link', commit: 'abc1234' }), ferret('child'));
    const documented = await service.act('F1', action({ action: 'link', doc: 'docs/board.md' }), ferret('child'));

    // Assert
    should(linked.card.links.commits.length).equal(1);
    should(documented.card.links.docs.length).equal(1);
    should(ports.focus.focused.get('child')).deepEqual({ id: 'F1' });
  });

  it('should keep the claimer to its own card: other holders stay refused for a move, a focus and a link', async () => {
    // Arrange — the sibling holds F1, the lead holds F2, and the claimer holds nothing it did not take.
    const { ports, service } = treeWith({ owner: 'lead', assignee: 'sibling' }, { id: 'F2', owner: 'lead' });
    await service.act('F2', claim, ferret('child'));

    // Act
    const refused = [
      await refusal(service.act('F1', action({ action: 'move', to: 'plan' }), ferret('child'))),
      await refusal(service.act('F1', action({ action: 'focus' }), ferret('child'))),
      await refusal(service.act('F1', action({ action: 'link', commit: 'abc1234' }), ferret('child'))),
    ];

    // Assert
    for (const error of refused) should(error.code).equal('forbidden');
    should(ports.store.cards.get('F1')?.laneId).equal('todo');
  });

  it('should not let a claim widen a helper beyond move, focus and link', async () => {
    // Arrange
    const { service } = treeWith({ owner: 'lead' });
    await service.act('F1', claim, ferret('child'));

    // Act
    const blocked = await refusal(service.act('F1', action({ action: 'edit', title: 'Renamed' }), ferret('child')));
    const dropped = await refusal(service.act('F1', action({ action: 'drop', reason: 'not needed' }), ferret('child')));

    // Assert
    should(blocked.code).equal('forbidden');
    should(blocked.message).not.containEql('claim it first');
    should(dropped.code).equal('forbidden');
  });

  it('should keep the owner gate and the dependency check on a claimer’s move', async () => {
    // Arrange — the claimer holds F1, which depends on an unfinished F2.
    const { service } = treeWith(
      { owner: 'lead', dependsOn: [{ task: { id: 'F2' }, until: 'shipped' }] },
      { id: 'F2', owner: 'lead' },
    );
    await service.act('F1', claim, ferret('child'));

    // Act
    const gated = await refusal(service.act('F1', action({ action: 'move', to: 'closed' }), ferret('child')));
    const blocked = await refusal(service.act('F1', action({ action: 'move', to: 'plan' }), ferret('child')));

    // Assert
    should(gated.code).equal('owner-gate');
    should(blocked.code).equal('blocked-by');
  });
});

describe('what a refused helper is told about a card its lead holds', () => {
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
        /^You are a helper, so you can't .+\. You may .+\. Your lead holds this card: claim it first: fy card claim &F1$/u,
      );
      should(error.message).not.containEql('fy send');
    }
  });

  it('should say to claim it first when a note or a PR link on a lead’s card is refused', async () => {
    // Arrange
    const { service } = treeWith({ owner: 'lead' });

    // Act
    const refused = [
      await refusal(service.act('F1', action({ action: 'note', text: 'progress' }), ferret('child'))),
      await refusal(
        service.act(
          'F1',
          action({ action: 'link', pr: 'https://github.com/kirinnee/ferretry/pull/1' }),
          ferret('child'),
        ),
      ),
    ];

    // Assert
    for (const error of refused) should(error.message).endWith('your lead holds it: claim it first: fy card claim &F1');
  });

  it('should keep telling the helper to ask its lead for a card it cannot claim', async () => {
    // Arrange
    const { service } = treeWith({ owner: 'lead', assignee: 'sibling' });

    // Act
    const error = await refusal(service.act('F1', action({ action: 'move', to: 'plan' }), ferret('child')));

    // Assert
    should(error.message).endWith('For anything else ask your lead: fy send lizzette "…"');
  });

  describe('a refused assign', () => {
    const assignTo = (assignee: string | null) => action({ action: 'assign', assignee });

    it('should offer the claim only for a descendant of the caller that the daemon’s lineage proves', async () => {
      // Arrange: lead > child > grandchild; the lead holds the card.
      const { service } = treeWith({ owner: 'lead' });

      // Act
      const error = await refusal(service.act('F1', assignTo('grandchild'), ferret('child')));

      // Assert
      should(error.message).endWith('Your lead holds this card: claim it first: fy card claim &F1');
    });

    for (const [name, assignee] of [
      ['nobody', null],
      ['its lead (upward)', 'lead'],
      ['a sibling (sideways)', 'sibling'],
      ['a cousin (another line)', 'cousin'],
      ['itself', 'child'],
    ] as const) {
      it(`should keep telling the helper to ask its lead when the assign is to ${name}`, async () => {
        // Arrange
        const { service } = treeWith({ owner: 'lead' });

        // Act
        const error = await refusal(service.act('F1', assignTo(assignee), ferret('child')));

        // Assert
        should(error.message).endWith('For anything else ask your lead: fy send lizzette "…"');
        should(error.message).not.containEql('claim it first');
      });
    }

    it('should not offer a claim when the card is held by a ferret outside the caller’s lineage', async () => {
      // Arrange
      const { service } = treeWith({ owner: 'lead', assignee: 'sibling' });

      // Act
      const error = await refusal(service.act('F1', assignTo('grandchild'), ferret('child')));

      // Assert
      should(error.message).not.containEql('claim it first');
    });
  });

  it('should word the tail from the claim command when one is given', async () => {
    // Act
    const message = await subFerretRefusal(DIRECTORY, 'child', 'move cards', undefined, 'fy card claim &F7');

    // Assert
    should(message).endWith('Your lead holds this card: claim it first: fy card claim &F7');
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
