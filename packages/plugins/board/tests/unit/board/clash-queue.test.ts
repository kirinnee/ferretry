import { describe, it } from 'bun:test';
import { type BoardProjectId, type Card, type CardActionRequestInput, CardActionRequestSchema, CardCreateRequestSchema, type LaneSet, MAX_BOARD_DEPENDENCIES, type PrLink, PrLinkSchema } from '../../../contract/index.ts';
import should from 'should';
import {
  type BoardCaller,
  BoardError,
  BoardIndex,
  BoardService,
  DEPENDENCY_SECTION,
} from '../../../daemon/lib/board/index.ts';
import {
  CLASH_QUEUED_PREFIX,
  claimsClash,
  normaliseClaim,
  planClashes,
  queueBehindClashes,
} from '../../../daemon/lib/board/clash-queue.ts';
import {
  card,
  lanes,
  MACHINE,
  MemoryBoardStore,
  NOW,
  OTHER_PROJECT,
  PROJECT,
  type ServiceWorld,
  world,
} from './support.ts';

const ferret = (ferret: string): BoardCaller => ({ kind: 'ferret', ferret });
const lead = ferret('lead');
const child = ferret('child');
const action = (input: CardActionRequestInput) => CardActionRequestSchema.parse(input);
const laneSets: ReadonlyMap<BoardProjectId, LaneSet> = new Map([[PROJECT as BoardProjectId, lanes()]]);

const serviceWith = (cards: readonly Card[], overrides: Partial<ServiceWorld> = {}) => {
  const ports = world({ store: new MemoryBoardStore(cards), ...overrides });
  return { ports, service: new BoardService(ports) };
};
const stored = (ports: ServiceWorld, id = 'F1'): Card => ports.store.cards.get(id) as Card;
const plan = (subject: Card, claimed: readonly string[], cards: readonly Card[]) =>
  planClashes(subject, claimed, new BoardIndex([subject, ...cards], MACHINE), laneSets);

describe('claimsClash', () => {
  it('should clash on the same path, however it is spelled', () => {
    should(claimsClash('knip.json', './knip.json')).be.true();
    should(claimsClash('packages/daemon/bin/fyd.ts', 'packages//daemon/bin/fyd.ts')).be.true();
  });

  it('should clash when one claim is a folder the other sits inside', () => {
    should(claimsClash('packages/daemon/', 'packages/daemon/bin/fyd.ts')).be.true();
    should(claimsClash('packages/daemon/bin/fyd.ts', 'packages/daemon')).be.true();
  });

  it('should not clash on a shared prefix that is not a folder boundary', () => {
    should(claimsClash('packages/daemon', 'packages/daemon-x/a.ts')).be.false();
    should(claimsClash('packages/pwa/src/a.ts', 'packages/daemon/src/a.ts')).be.false();
  });

  it('should read the repository root as holding every path', () => {
    should(normaliseClaim('./')).equal('');
    should(normaliseClaim('.')).equal('');
    should(claimsClash('.', 'anything/at/all.ts')).be.true();
  });

  it('should read dot segments inside a path as the path they name', () => {
    should(normaliseClaim('packages/daemon/./src/../src/a.ts')).equal('packages/daemon/src/a.ts');
    should(claimsClash('packages/daemon/./src/a.ts', 'packages/daemon/src/a.ts')).be.true();
    should(normaliseClaim('../outside.ts')).equal('../outside.ts');
    should(claimsClash('../outside.ts', 'outside.ts')).be.false();
  });
});

describe('planClashes', () => {
  it('should queue a claim behind an open card on the same board that claims an overlapping path', () => {
    // Arrange
    const first = card({ id: 'F2', laneId: 'implement', files: ['packages/daemon/'] });

    // Act
    const result = plan(card(), ['packages/daemon/bin/fyd.ts'], [first]);

    // Assert
    should(result.waits).eql([{ card: { id: 'F2' }, ours: 'packages/daemon/bin/fyd.ts', theirs: 'packages/daemon/' }]);
    should(result.unqueued).eql([]);
  });

  it('should count a backlog card, which claimed the area first', () => {
    const result = plan(card(), ['knip.json'], [card({ id: 'F2', laneId: 'todo', files: ['knip.json'] })]);
    should(result.waits.map(wait => wait.card.id)).eql(['F2']);
  });

  it('should skip cards whose work has shipped, dropped cards, and cards on another board', () => {
    // Arrange
    const others = [
      card({ id: 'F2', laneId: 'merged', files: ['knip.json'] }),
      card({ id: 'F3', laneId: 'closed', files: ['knip.json'] }),
      card({ id: 'F4', files: ['knip.json'], dropped: { reason: 'not needed', at: NOW } }),
      card({ id: 'F5', projectId: OTHER_PROJECT as Card['projectId'], files: ['knip.json'] }),
    ];

    // Act
    const result = plan(card(), ['knip.json'], others);

    // Assert
    should(result).eql({ waits: [], unqueued: [] });
  });

  it("should skip the card's ancestors and descendants, which overlap it by design", () => {
    // Arrange
    const parent = card({ id: 'F2', files: ['packages/daemon/'] });
    const subject = card({ parent: { id: 'F2' } });
    const grandchild = card({ id: 'F4', parent: { id: 'F3' }, files: ['packages/daemon/x.ts'] });
    const childCard = card({ id: 'F3', parent: { id: 'F1' }, files: ['packages/daemon/y.ts'] });

    // Act
    const result = plan(subject, ['packages/daemon/z.ts'], [parent, childCard, grandchild]);

    // Assert
    should(result).eql({ waits: [], unqueued: [] });
  });

  it('should skip a card it already depends on, or took out of its queue on purpose', () => {
    // Arrange
    const subject = card({
      dependsOn: [{ task: { id: 'F2' }, until: 'released' }],
      history: [
        { seq: 1, at: NOW, actor: { kind: 'ferret', ferret: 'lead' }, type: 'created', laneId: 'todo' },
        {
          seq: 2,
          at: NOW,
          actor: { kind: 'ferret', ferret: 'lead' },
          type: 'undepended',
          task: { id: 'F3' },
          reason: 'F1 goes first',
        },
      ],
    });
    const others = [card({ id: 'F2', files: ['knip.json'] }), card({ id: 'F3', files: ['knip.json'] })];

    // Act
    const result = plan(subject, ['knip.json'], others);

    // Assert
    should(result).eql({ waits: [], unqueued: [] });
  });

  it("should not read removing another machine's card as removing the local card with the same id", () => {
    // Arrange
    const subject = card({
      id: 'F3',
      history: [
        { seq: 1, at: NOW, actor: { kind: 'ferret', ferret: 'lead' }, type: 'created', laneId: 'todo' },
        {
          seq: 2,
          at: NOW,
          actor: { kind: 'ferret', ferret: 'lead' },
          type: 'undepended',
          task: { id: 'F2', machineId: 'machine-2' },
          reason: 'that one is elsewhere',
        },
      ],
    });

    // Act
    const result = plan(subject, ['x.ts'], [card({ id: 'F2', laneId: 'implement', files: ['x.ts'] })]);

    // Assert
    should(result.waits.map(wait => wait.card.id)).eql(['F2']);
  });

  it('should report, not add, a clash whose dependency would close a cycle', () => {
    // Arrange
    const other = card({ id: 'F2', files: ['knip.json'], dependsOn: [{ task: { id: 'F1' }, until: 'shipped' }] });

    // Act
    const result = plan(card(), ['knip.json'], [other]);

    // Assert
    should(result.waits).eql([]);
    should(result.unqueued.map(clash => clash.card.id)).eql(['F2']);
    should(result.unqueued[0]?.why).containEql('already waits on this card');
  });

  it('should stop adding at the most dependencies a card may hold', () => {
    // Arrange
    const full = Array.from({ length: MAX_BOARD_DEPENDENCIES }, (_, n) => ({
      task: { id: `F${String(100 + n)}` as Card['id'] },
      until: 'shipped' as const,
    }));
    const subject = card({ dependsOn: full });

    // Act
    const result = plan(subject, ['knip.json'], [card({ id: 'F2', files: ['knip.json'] })]);

    // Assert
    should(result.waits).eql([]);
    should(result.unqueued[0]?.why).containEql('most dependencies');
  });
});

describe('planClashes and merge units', () => {
  const prLink = (number: number): PrLink =>
    PrLinkSchema.parse({
      url: `https://github.com/kirinnee/ferretry/pull/${String(number)}`,
      number,
      repo: 'kirinnee/ferretry',
      state: 'open',
      draft: false,
      checks: 'passing',
      mergedAt: null,
      mergeSha: null,
      releasedIn: null,
      polledAt: NOW,
    });
  const linking = (...prs: PrLink[]): Pick<Card, 'links'> => ({
    links: { prs, branch: null, commits: [], docs: [] },
  });

  it('should never queue a card behind one that ships in the same PR', () => {
    // Arrange
    const subject = card({ id: 'F2', ...linking(prLink(42)) });
    const first = card({ id: 'F1', files: ['knip.json'], ...linking(prLink(42)) });

    // Act
    const result = plan(subject, ['knip.json'], [first]);

    // Assert
    should(result).eql({ waits: [], unqueued: [] });
  });

  it("should queue behind the card whose PR ships a helper's claim, not the helper that closes early", () => {
    // Arrange
    const lead = card({ id: 'F1', laneId: 'implement', ...linking(prLink(42)) });
    const helper = card({ id: 'F2', parent: { id: 'F1' }, files: ['knip.json'] });

    // Act
    const result = plan(card({ id: 'F3' }), ['knip.json'], [lead, helper]);

    // Assert
    should(result.waits).eql([{ card: { id: 'F1' }, via: { id: 'F2' }, ours: 'knip.json', theirs: 'knip.json' }]);
  });

  it("should queue once per shipping card, and not behind the claimer's own lead", () => {
    // Arrange — two helpers of F1 clash with the claimer; the claimer's sibling ships with it.
    const lead = card({ id: 'F1', ...linking(prLink(42)) });
    const helpers = [
      card({ id: 'F2', parent: { id: 'F1' }, files: ['knip.json'] }),
      card({ id: 'F4', parent: { id: 'F1' }, files: ['knip.json'] }),
    ];
    const sibling = card({ id: 'F6', parent: { id: 'F5' }, files: ['knip.json'] });
    const claimerLead = card({ id: 'F5' });
    const subject = card({ id: 'F7', parent: { id: 'F5' } });

    // Act
    const result = plan(subject, ['knip.json'], [lead, ...helpers, claimerLead, sibling]);

    // Assert
    should(result.waits.map(wait => wait.card.id)).eql(['F1']);
  });
});

describe('planClashes across shipping units (review round 2)', () => {
  const prLink = (number: number, state: 'open' | 'merged' = 'open'): PrLink =>
    PrLinkSchema.parse({
      url: `https://github.com/kirinnee/ferretry/pull/${String(number)}`,
      number,
      repo: 'kirinnee/ferretry',
      state,
      draft: false,
      checks: 'passing',
      mergedAt: state === 'merged' ? NOW : null,
      mergeSha: state === 'merged' ? 'a'.repeat(40) : null,
      releasedIn: null,
      polledAt: NOW,
    });
  const linking = (...prs: PrLink[]): Pick<Card, 'links'> => ({
    links: { prs, branch: null, commits: [], docs: [] },
  });

  it("should count a finished helper's claims while its lead's PR is open", () => {
    // Arrange
    const lead = card({ id: 'F1', laneId: 'implement', ...linking(prLink(42)) });
    const helper = card({ id: 'F2', parent: { id: 'F1' }, laneId: 'closed', files: ['knip.json'] });

    // Act
    const result = plan(card({ id: 'F3' }), ['knip.json'], [lead, helper]);

    // Assert
    should(result.waits.map(wait => wait.card.id)).eql(['F1']);
  });

  it('should refuse a wait that would close a cycle between two PRs through their helpers', () => {
    // Arrange — F2 (a helper of F1, PR 42) already waits on F3 (PR 43); F4, a helper of F3, now claims what F2 claims.
    const cards = [
      card({ id: 'F1', laneId: 'implement', ...linking(prLink(42)) }),
      card({ id: 'F2', parent: { id: 'F1' }, files: ['x.ts'], dependsOn: [{ task: { id: 'F3' }, until: 'shipped' }] }),
      card({ id: 'F3', laneId: 'implement', ...linking(prLink(43)) }),
    ];
    const subject = card({ id: 'F4', parent: { id: 'F3' } });

    // Act
    const result = plan(subject, ['x.ts'], cards);

    // Assert
    should(result.waits).eql([]);
    should(result.unqueued[0]?.why).containEql("PR already waits on this card's PR");
  });

  it('should queue a child with its own PR behind the PR that ships its sibling helper', () => {
    // Arrange
    const lead = card({ id: 'F1', laneId: 'implement', ...linking(prLink(42)) });
    const helper = card({ id: 'F2', parent: { id: 'F1' }, files: ['x.ts'] });
    const subject = card({ id: 'F3', parent: { id: 'F1' }, ...linking(prLink(43)) });

    // Act
    const result = plan(subject, ['x.ts'], [lead, helper]);

    // Assert
    should(result.waits).eql([{ card: { id: 'F1' }, via: { id: 'F2' }, ours: 'x.ts', theirs: 'x.ts' }]);
  });

  it('should still queue two cards that only share an old, merged PR', () => {
    // Arrange
    const first = card({
      id: 'F1',
      laneId: 'implement',
      files: ['x.ts'],
      ...linking(prLink(40, 'merged'), prLink(42)),
    });
    const subject = card({ id: 'F2', ...linking(prLink(40, 'merged'), prLink(43)) });

    // Act
    const result = plan(subject, ['x.ts'], [first]);

    // Assert
    should(result.waits.map(wait => wait.card.id)).eql(['F1']);
  });
});

describe('planClashes and the board service (review round 3)', () => {
  const prLink = (number: number): PrLink =>
    PrLinkSchema.parse({
      url: `https://github.com/kirinnee/ferretry/pull/${String(number)}`,
      number,
      repo: 'kirinnee/ferretry',
      state: 'open',
      draft: false,
      checks: 'passing',
      mergedAt: null,
      mergeSha: null,
      releasedIn: null,
      polledAt: NOW,
    });
  const linking = (...prs: PrLink[]): Pick<Card, 'links'> => ({
    links: { prs, branch: null, commits: [], docs: [] },
  });

  it('should see a cycle through two cards that share one PR', async () => {
    // Arrange — F1 and F2 ship PR 42 together; F3 ships PR 43.
    const { ports, service } = serviceWith([
      card({ id: 'F1', laneId: 'implement', ...linking(prLink(42)) }),
      card({ id: 'F2', laneId: 'implement', files: ['x.ts'], ...linking(prLink(42)) }),
      card({ id: 'F3', laneId: 'implement', files: ['y.ts'], ...linking(prLink(43)) }),
    ]);

    // Act — F1 queues behind F3 (y.ts); then F3 claims x.ts, which F2 holds in PR 42.
    await service.act('F1', action({ action: 'file', path: 'y.ts' }), lead);
    await service.act('F3', action({ action: 'file', path: 'x.ts' }), lead);

    // Assert
    should(stored(ports, 'F1').dependsOn).eql([{ task: { id: 'F3' }, until: 'shipped' }]);
    should(stored(ports, 'F3').dependsOn).eql([]);
    should(stored(ports, 'F3').history.at(-1)).match({ type: 'note' });
    should((stored(ports, 'F3').history.at(-1) as { text: string }).text).containEql(
      "PR already waits on this card's PR",
    );
  });

  for (const order of ['F2 first', 'F3 first'] as const) {
    it(`should queue behind the lead's PR whatever the store order (${order})`, () => {
      // Arrange — F2 and F3 are helpers of F1 (PR 42) claiming x.ts; F4, under F2, ships its own PR 43.
      const lead = card({ id: 'F1', laneId: 'implement', ...linking(prLink(42)) });
      const f2 = card({ id: 'F2', parent: { id: 'F1' }, files: ['x.ts'] });
      const f3 = card({ id: 'F3', parent: { id: 'F1' }, files: ['x.ts'] });
      const subject = card({ id: 'F4', parent: { id: 'F2' }, ...linking(prLink(43)) });

      // Act
      const result = plan(subject, ['x.ts'], order === 'F2 first' ? [lead, f2, f3] : [lead, f3, f2]);

      // Assert
      should(result.waits.map(wait => wait.card.id)).eql(['F1']);
    });
  }

  it('should queue behind a lead on another board whose lanes this read does not hold', () => {
    // Arrange
    const lead = card({
      id: 'F1',
      projectId: OTHER_PROJECT as Card['projectId'],
      laneId: 'implement',
      ...linking(prLink(42)),
    });
    const helper = card({ id: 'F2', parent: { id: 'F1' }, files: ['x.ts'] });

    // Act
    const result = plan(card({ id: 'F3' }), ['x.ts'], [lead, helper]);

    // Assert
    should(result.waits.map(wait => wait.card.id)).eql(['F1']);
  });
});

describe('queueBehindClashes', () => {
  it("should add the dependency and a note, both the daemon's, for the claiming session", () => {
    // Arrange
    const first = card({ id: 'F2', files: ['knip.json'] });
    const subject = card();

    // Act
    const queued = queueBehindClashes(subject, ['knip.json'], {
      index: new BoardIndex([subject, first], MACHINE),
      laneSets,
      now: NOW,
      actor: { kind: 'ferret', ferret: 'lead' },
    });

    // Assert
    should(queued.dependsOn).eql([{ task: { id: 'F2' }, until: 'shipped' }]);
    should(queued.history.slice(1)).eql([
      {
        seq: 2,
        at: NOW,
        actor: { kind: 'daemon', ferret: 'lead' },
        type: 'depended',
        task: { id: 'F2' },
        until: 'shipped',
      },
      {
        seq: 3,
        at: NOW,
        actor: { kind: 'daemon', ferret: 'lead' },
        type: 'note',
        text: `${CLASH_QUEUED_PREFIX} &F2 to merge: both claim knip.json. It can be built now; its PR merges after &F2 ships.`,
      },
    ]);
  });

  it('should leave a card that clashes with nothing unchanged', () => {
    const subject = card();
    const queued = queueBehindClashes(subject, ['knip.json'], {
      index: new BoardIndex([subject], MACHINE),
      laneSets,
      now: NOW,
      actor: { kind: 'owner' },
    });
    should(queued).equal(subject);
  });
});

describe('the board service queues clashing claims', () => {
  it('should queue a card behind an open card when its file claim clashes, inside the dependency section', async () => {
    // Arrange
    const { ports, service } = serviceWith([
      card({ laneId: 'implement' }),
      card({ id: 'F2', laneId: 'implement', files: ['packages/protocol/src/lib/daemon-features.ts'] }),
    ]);

    // Act
    const response = await service.act(
      'F1',
      action({ action: 'file', path: 'packages/protocol/src/lib/daemon-features.ts' }),
      lead,
    );

    // Assert
    should(stored(ports).files).eql(['packages/protocol/src/lib/daemon-features.ts']);
    should(stored(ports).dependsOn).eql([{ task: { id: 'F2' }, until: 'shipped' }]);
    should(response.card.blockedBy).eql([{ id: 'F2' }]);
    should(ports.sections).eql([DEPENDENCY_SECTION]);
  });

  it('should not queue on a release, nor take the dependency section for it', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ files: ['knip.json'] }), card({ id: 'F2', files: ['knip.json'] })]);

    // Act
    await service.act('F1', action({ action: 'file', path: 'knip.json', release: true }), lead);

    // Assert
    should(stored(ports).dependsOn).eql([]);
    should(ports.sections).eql([]);
  });

  it('should queue a card created with claims behind the open card that claimed first', async () => {
    // Arrange
    const { ports, service } = serviceWith([card({ id: 'F1', files: ['packages/daemon/bin/fyd.ts'] })]);

    // Act
    const response = await service.create(
      CardCreateRequestSchema.parse({
        kind: 'feature',
        title: 'Wire a plugin',
        ask: { text: 'wire it', source: 'owner' },
        files: ['packages/daemon/bin/'],
      }),
      lead,
    );

    // Assert
    should(response.card.id).equal('F2');
    should(response.card.dependsOn).eql([{ task: { id: 'F1' }, until: 'shipped' }]);
    should(response.card.blockedBy).eql([{ id: 'F1' }]);
    should(stored(ports, 'F2').history.at(-1)).match({ type: 'note', actor: { kind: 'daemon', ferret: 'lead' } });
    should(ports.sections).eql([DEPENDENCY_SECTION]);
  });

  it('should create a card without claims outside the dependency section', async () => {
    const { ports, service } = serviceWith([card({ files: ['knip.json'] })]);
    await service.create(
      CardCreateRequestSchema.parse({ kind: 'feature', title: 'Other', ask: { text: 'x', source: 'owner' } }),
      lead,
    );
    should(ports.sections).eql([]);
  });

  it('should name the cards it could not read when it answers the merge gate', async () => {
    // Arrange
    const ports = world({ store: new MemoryBoardStore([card()], [{ id: 'F9', reason: 'torn file' }]) });

    // Act
    const answer = await new BoardService(ports).mergeGate('https://github.com/kirinnee/ferretry/pull/42');

    // Assert
    should(answer.unreadable).eql(['F9']);
  });

  it('should refuse a merge gate for something that is not a PR URL', async () => {
    const { service } = serviceWith([]);
    const refused = await service.mergeGate('F12').then(
      () => undefined,
      (error: unknown) => error,
    );
    should((refused as BoardError).code).equal('invalid');
  });

  it('should let a helper claim files on the card it holds, and on no other', async () => {
    // Arrange
    const helpers = {
      leadOf: async (id: string) => (id === 'child' ? 'lead' : undefined),
      addressOf: async (id: string) => id,
    };
    const { ports, service } = serviceWith([card({ assignee: 'child' }), card({ id: 'F2' })], { helpers });

    // Act
    await service.act('F1', action({ action: 'file', path: 'knip.json' }), child);
    const refused = await service.act('F2', action({ action: 'file', path: 'knip.json' }), child).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(stored(ports).files).eql(['knip.json']);
    should(refused).be.instanceOf(BoardError);
    should((refused as BoardError).code).equal('forbidden');
  });
});
