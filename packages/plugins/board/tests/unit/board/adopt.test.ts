import { describe, it } from 'bun:test';
import { type Card, CardActionRequestSchema } from '../../../contract/index.ts';
import should from 'should';
import {
  applyAction,
  type BoardCaller,
  BoardError,
  BoardIndex,
  BoardService,
  type CardContext,
} from '../../../daemon/lib/board/index.ts';
import {
  card,
  FakeLanes,
  FakeParents,
  FakeSessions,
  lanes,
  liveSession,
  MACHINE,
  MemoryBoardStore,
  NOW,
  OTHER_PROJECT,
  PROJECT,
  rosterOf,
  world,
} from './support.ts';

/**
 * A live lead may ADOPT a card whose owner ferret and assignee have both ended (docs/board.md § An orphaned card is
 * adopted). `gone` and `gone2` are ended ferrets (not in the roster); `lead` and `other` are live leads; `kid` is a
 * live helper of `lead`; `unreadable` is held by the daemon but its record cannot be read.
 */
const ferret = (ferret: string): BoardCaller => ({ kind: 'ferret', ferret });
const adopt = CardActionRequestSchema.parse({ action: 'adopt', reason: 'nobody is left on it' });
const adoptSilently = CardActionRequestSchema.parse({ action: 'adopt' });

const PARENTS = { kid: 'lead' };
const DIRECTORY = {
  leadOf: async (ferret: string) => (PARENTS as Record<string, string | undefined>)[ferret],
  addressOf: async (ferret: string) => ferret,
};

/** An orphaned card: both its ferrets ended. A ferret's own errand, so an adopter may pass its gates. */
const orphan = (overrides: Partial<Card> = {}): Card =>
  card({
    laneId: 'implement',
    owner: 'gone',
    assignee: 'gone2',
    createdBy: { kind: 'daemon', ferret: 'gone' },
    ask: { text: 'review the screenshots', source: 'fy new' },
    askedBy: 'agent',
    ...overrides,
  });

const setup = (
  cards: readonly Card[],
  options: {
    readonly sessions?: FakeSessions;
    readonly lanes?: FakeLanes;
    readonly withLiveness?: boolean;
    readonly helpers?: typeof DIRECTORY;
  } = {},
) => {
  const sessions =
    options.sessions ??
    new FakeSessions(
      rosterOf(
        ['lead', 'other', 'kid'].map(id => liveSession(id)),
        ['unreadable'],
      ),
    );
  const ports = world({
    store: new MemoryBoardStore(cards),
    parents: new FakeParents(PARENTS),
    helpers: options.helpers ?? DIRECTORY,
    ...(options.withLiveness === false ? {} : { liveness: sessions }),
    ...(options.lanes === undefined ? {} : { lanes: options.lanes }),
  });
  return { ports, service: new BoardService(ports), sessions };
};

async function refusal(work: Promise<unknown>): Promise<BoardError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  should(error).be.instanceOf(BoardError);
  return error as BoardError;
}

describe('adopting an orphaned card', () => {
  it('should hand the card to the live lead as its owner and assignee, and record who it came from and why', async () => {
    // Arrange
    const { ports, service } = setup([orphan()]);

    // Act
    const response = await service.act('F1', adopt, ferret('lead'));

    // Assert
    should(response.card.owner).equal('lead');
    should(response.card.assignee).equal('lead');
    should(ports.store.cards.get('F1')?.history.at(-1)).match({
      type: 'assigned',
      from: 'gone2',
      to: 'lead',
      adopted: { from: 'gone', reason: 'nobody is left on it' },
      actor: { kind: 'ferret', ferret: 'lead' },
    });
  });

  it('should write the reason itself when the lead gives none, naming the ended ferrets', async () => {
    // Arrange
    const { ports, service } = setup([orphan()]);

    // Act
    await service.act('F1', adoptSilently, ferret('lead'));

    // Assert
    should(ports.store.cards.get('F1')?.history.at(-1)).match({
      adopted: { from: 'gone', reason: 'owner ferret gone and assignee gone2 ended' },
    });
  });

  it('should adopt a card whose owner held it itself (no assignee)', async () => {
    // Arrange
    const { ports, service } = setup([orphan({ assignee: null })]);

    // Act
    await service.act('F1', adoptSilently, ferret('other'));

    // Assert
    should(ports.store.cards.get('F1')).match({ owner: 'other', assignee: 'other' });
  });

  it('should let the adopter assign, drop and close it afterwards, as an owner ferret does', async () => {
    // Arrange
    const { ports, service } = setup([orphan({ id: 'F1' }), orphan({ id: 'F2' }), orphan({ id: 'F3' })]);
    await service.act('F1', adopt, ferret('lead'));
    await service.act('F2', adopt, ferret('lead'));
    await service.act('F3', adopt, ferret('lead'));

    // Act
    await service.act('F1', CardActionRequestSchema.parse({ action: 'assign', assignee: 'kid' }), ferret('lead'));
    await service.act(
      'F2',
      CardActionRequestSchema.parse({ action: 'drop', reason: 'not needed' }),
      ferret('lead'),
    );
    await service.act('F3', CardActionRequestSchema.parse({ action: 'move', to: 'closed' }), ferret('lead'));

    // Assert
    should(ports.store.cards.get('F1')?.assignee).equal('kid');
    should(ports.store.cards.get('F2')?.dropped).not.be.null();
    should(ports.store.cards.get('F3')?.laneId).equal('closed');
  });

  it('should still leave a public (owner-asked) card’s gate to the owner after adopting it', async () => {
    // Arrange
    const { ports, service } = setup([
      orphan({ ask: { text: 'build it', source: 'owner' }, askedBy: 'person', createdBy: { kind: 'owner' } }),
    ]);
    await service.act('F1', adopt, ferret('lead'));

    // Act
    const error = await refusal(
      service.act('F1', CardActionRequestSchema.parse({ action: 'move', to: 'closed' }), ferret('lead')),
    );

    // Assert
    should(error.code).equalOneOf('owner-gate', 'forbidden');
    should(ports.store.cards.get('F1')?.laneId).equal('implement');
  });

  describe('refused, with nothing written', () => {
    const unchanged = (ports: ReturnType<typeof setup>['ports']) => should(ports.store.writes).be.empty();

    it('should refuse while the owner ferret is still alive', async () => {
      // Arrange
      const { ports, service } = setup([orphan({ owner: 'other' })]);

      // Act
      const error = await refusal(service.act('F1', adopt, ferret('lead')));

      // Assert
      should(error.code).equal('forbidden');
      should(error.message).containEql('is not orphaned: other has not ended');
      unchanged(ports);
    });

    it('should refuse while the assignee is still alive', async () => {
      // Arrange
      const { ports, service } = setup([orphan({ assignee: 'kid' })]);

      // Act
      const error = await refusal(service.act('F1', adopt, ferret('other')));

      // Assert
      should(error.message).containEql('is not orphaned: kid has not ended');
      unchanged(ports);
    });

    it('should not take a ferret the daemon cannot read for an ended one', async () => {
      // Arrange
      const { ports, service } = setup([orphan({ assignee: 'unreadable' })]);

      // Act
      const error = await refusal(service.act('F1', adopt, ferret('lead')));

      // Assert
      should(error.message).containEql('unreadable has not ended');
      unchanged(ports);
    });

    it('should refuse a helper: it asks its lead', async () => {
      // Arrange
      const { ports, service } = setup([orphan()]);

      // Act
      const error = await refusal(service.act('F1', adopt, ferret('kid')));

      // Assert
      should(error.code).equal('forbidden');
      should(error.message).containEql("You are a helper, so you can't adopt cards");
      unchanged(ports);
    });

    it('should refuse a caller the roster says was started by another, though the directory cannot tell', async () => {
      // Arrange
      const unreadableDirectory = {
        leadOf: async (): Promise<string | undefined> => {
          throw new Error('registry unreadable');
        },
        addressOf: async (ferret: string) => ferret,
      };
      const sessions = new FakeSessions(rosterOf([liveSession('lead'), liveSession('kid', { lead: 'lead' })]));
      const { ports, service } = setup([orphan()], { sessions, helpers: unreadableDirectory });

      // Act
      const error = await refusal(service.act('F1', adopt, ferret('kid')));

      // Assert
      should(error.code).equal('forbidden');
      should(error.message).containEql('only a lead may adopt &F1: kid was started by lead');
      unchanged(ports);
    });

    it('should refuse a caller the roster holds but cannot read', async () => {
      // Arrange
      const { ports, service } = setup([orphan()]);

      // Act
      const error = await refusal(service.act('F1', adopt, ferret('unreadable')));

      // Assert
      should(error.message).containEql('only a live ferret may adopt &F1');
      unchanged(ports);
    });

    it('should refuse a caller whose configuration was not read: no proven lineage, so not a lead', async () => {
      // Arrange
      const { configRead: _unread, ...unproven } = liveSession('lead');
      const sessions = new FakeSessions(rosterOf([unproven, liveSession('other')]));
      const { ports, service } = setup([orphan()], { sessions });

      // Act
      const error = await refusal(service.act('F1', adopt, ferret('lead')));

      // Assert
      should(error.code).equal('forbidden');
      should(error.message).containEql('who started lead cannot be read, so it is not shown to be a lead');
      unchanged(ports);
    });

    it('should judge the orphan on the roster read inside the hold: an owner that resumed in the gap is not orphaned', async () => {
      // Arrange
      const sessions = new FakeSessions(rosterOf(['lead', 'other'].map(id => liveSession(id))));
      const resumed = rosterOf(['lead', 'gone'].map(id => liveSession(id)));
      const settled = sessions.settled.bind(sessions);
      sessions.settled = async (ids, work) => {
        sessions.current = resumed;
        return await settled(ids, work);
      };
      const { ports, service } = setup([orphan()], { sessions });

      // Act
      const error = await refusal(service.act('F1', adopt, ferret('lead')));

      // Assert
      should(error.message).containEql('is not orphaned: gone has not ended');
      should(sessions.holds).eql([['gone', 'gone2', 'lead']]);
      unchanged(ports);
    });

    it('should refuse a card that changed hands between naming the holders and writing it', async () => {
      // Arrange
      const { ports, service, sessions } = setup([orphan()]);
      const settled = sessions.settled.bind(sessions);
      sessions.settled = async (ids, work) => {
        ports.store.cards.set('F1', orphan({ assignee: 'gone3' }));
        return await settled(ids, work);
      };

      // Act
      const error = await refusal(service.act('F1', adopt, ferret('lead')));

      // Assert
      should(error.code).equal('version-conflict');
      should(error.message).containEql('changed hands while it was being adopted');
      should(ports.store.cards.get('F1')?.owner).equal('gone');
    });

    it('should refuse a ferret that is not alive', async () => {
      // Arrange
      const { ports, service } = setup([orphan()]);

      // Act
      const error = await refusal(service.act('F1', adopt, ferret('ghost')));

      // Assert
      should(error.message).containEql('only a live ferret may adopt &F1');
      unchanged(ports);
    });

    it('should refuse a lead working on another board', async () => {
      // Arrange
      const lanes = new FakeLanes(undefined, new Map([['other', OTHER_PROJECT]]));
      const { ports, service } = setup([orphan({ projectId: PROJECT })], { lanes });

      // Act
      const error = await refusal(service.act('F1', adopt, ferret('other')));

      // Assert
      should(error.message).containEql('is on another board than the one you work on');
      unchanged(ports);
    });

    it('should refuse the owner and the daemon, who assign instead', async () => {
      // Arrange
      const { ports, service } = setup([orphan()]);

      // Act
      const byOwner = await refusal(service.act('F1', adopt, { kind: 'owner' }));
      const byDaemon = await refusal(service.act('F1', adopt, { kind: 'daemon' }));

      // Assert
      should(byOwner.message).containEql('fy card assign &F1 <ferret>');
      should(byDaemon.code).equal('forbidden');
      unchanged(ports);
    });

    it('should refuse a dropped card and a closed one: there is nothing to adopt', async () => {
      // Arrange
      const { ports, service } = setup([
        orphan({ id: 'F1', dropped: { reason: 'no', at: '2026-10-30T10:00:00.000Z' } }),
        orphan({ id: 'F2', laneId: 'closed' }),
      ]);

      // Act
      const dropped = await refusal(service.act('F1', adopt, ferret('lead')));
      const closed = await refusal(service.act('F2', adopt, ferret('lead')));

      // Assert
      should(dropped.message).containEql('is dropped');
      should(closed.message).containEql('is closed');
      unchanged(ports);
    });

    it('should refuse everything where the daemon cannot tell which ferrets are alive', async () => {
      // Arrange
      const { ports, service } = setup([orphan()], { withLiveness: false });

      // Act
      const error = await refusal(service.act('F1', adopt, ferret('lead')));

      // Assert
      should(error.message).containEql('cannot be shown to be orphaned');
      unchanged(ports);
    });
  });
});

describe('the adopt rule itself', () => {
  const context = (overrides: Partial<CardContext>): CardContext => ({
    now: NOW,
    actor: { kind: 'ferret', ferret: 'lead' },
    standing: 'reader',
    laneSet: lanes(PROJECT),
    index: new BoardIndex([], MACHINE),
    laneSets: new Map(),
    ...overrides,
  });

  it('should refuse unless the service proved the orphan and a ferret is asking', () => {
    // Act
    const unproved = (): unknown => applyAction(orphan(), adoptSilently, context({}));
    const byOwner = (): unknown =>
      applyAction(orphan(), adoptSilently, context({ actor: { kind: 'owner' }, adoptedFrom: 'gone' }));

    // Assert
    should(unproved).throw(/only a live lead may adopt &F1/u);
    should(byOwner).throw(/only a live lead may adopt &F1/u);
  });
});
