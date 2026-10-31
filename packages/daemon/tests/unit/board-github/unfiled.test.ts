import { describe, it } from 'bun:test';
import { type BoardProjectId, type BoardTask, type LaneSet, type PrLink, UNFILED_PROJECT_ID } from '@ferretry/protocol';
import should from 'should';
import { BoardService } from '../../../src/lib/board/index.ts';
import {
  type ProjectRemote,
  readProjectRemotes,
  SESSION_BOARD_RETRY_MS,
  type SessionBoards,
  UnfiledRefiler,
  type UnfiledRefilerPorts,
} from '../../../src/lib/board-github/index.ts';
import {
  card,
  FakeLanes,
  lanes,
  MemoryBoardStore,
  NOW,
  OTHER_PROJECT,
  PROJECT,
  templateLanes,
  world,
} from '../board/support.ts';
import { prUrl, REPO } from './support.ts';

const merged = (number: number, repo = REPO): PrLink => ({
  url: prUrl(number, repo),
  number,
  repo,
  state: 'merged',
  draft: false,
  checks: 'passing',
  mergedAt: '2026-10-30T09:00:00Z',
  mergeSha: 'a'.repeat(40),
  releasedIn: null,
  polledAt: NOW,
});

const unfiled = (overrides: Partial<BoardTask> = {}): BoardTask =>
  card({ projectId: UNFILED_PROJECT_ID, laneId: 'doing', workflow: 'quick', ...overrides });

const withPrs = (prs: readonly PrLink[], overrides: Partial<BoardTask> = {}): BoardTask =>
  unfiled({ links: { prs: [...prs], branch: null, commits: [], docs: [] }, ...overrides });

const REMOTES: readonly ProjectRemote[] = [
  { id: PROJECT, name: 'Ferretry', repo: REPO },
  { id: OTHER_PROJECT, name: 'Docs', repo: 'kirinnee/docs' },
];

/** A session-board source that counts how often each session is asked. */
class Boards implements SessionBoards {
  readonly asked: string[] = [];
  constructor(readonly answers: Readonly<Record<string, BoardProjectId | null | Error>> = {}) {}
  async boardOf(sessionId: string): Promise<BoardProjectId | null> {
    this.asked.push(sessionId);
    const answer = this.answers[sessionId] ?? null;
    if (answer instanceof Error) throw answer;
    return answer;
  }
}

interface RigOptions {
  readonly cards: readonly BoardTask[];
  readonly sessions?: Boards;
  readonly board?: (service: BoardService) => UnfiledRefilerPorts['board'];
  readonly projects?: UnfiledRefilerPorts['projects'];
  /** Whether a proposal for a project with no lanes succeeds (default) or fails, or throws. */
  readonly propose?: 'ok' | 'refused' | 'throws';
}

const rig = (options: RigOptions) => {
  const store = new MemoryBoardStore(options.cards);
  const sets = new Map<BoardProjectId, LaneSet>([
    [PROJECT, lanes(PROJECT)],
    [OTHER_PROJECT, lanes(OTHER_PROJECT, 'pr')],
    [UNFILED_PROJECT_ID, lanes(UNFILED_PROJECT_ID, 'quick')],
  ]);
  const service = new BoardService(
    world({
      store,
      lanes: new FakeLanes(sets),
    }),
  );
  const proposals: { projectId: string; sessionId: string }[] = [];
  const warnings: string[] = [];
  const clock = { ms: Date.parse(NOW) };
  const sessions = options.sessions ?? new Boards();
  const refiler = new UnfiledRefiler({
    board: options.board?.(service) ?? service,
    sessions,
    lanes: {
      laneSet: async projectId => sets.get(projectId) ?? null,
      propose: async (projectId, sessionId) => {
        proposals.push({ projectId, sessionId });
        if (options.propose === 'throws') throw new Error('lane store damaged');
        if (options.propose === 'refused') return null;
        const proposed = { ...templateLanes(projectId, 'pr-release-verify'), confirmedBy: null };
        sets.set(projectId, proposed);
        return proposed;
      },
    },
    projects: options.projects ?? { projects: async () => [{ id: PROJECT, name: 'Ferretry', path: '/p' }] },
    copies: { repositoryOf: async path => (path === '/p' ? REPO : null) },
    clock: { now: () => new Date(clock.ms).toISOString() },
    diagnostics: { warn: message => warnings.push(message) },
  });
  return {
    refiler,
    store,
    sessions,
    warnings,
    clock,
    proposals,
    sets,
    stored: (id = 'F1') => store.cards.get(id) as BoardTask,
  };
};

describe('UnfiledRefiler: a linked PR in a project’s repository', () => {
  it('should refile at once, and let the PR facts place the card on the new board', async () => {
    // Arrange
    const subject = rig({ cards: [withPrs([merged(985)], { createdAt: NOW })] });

    // Act
    const refiled = await subject.refiler.run(REMOTES);

    // Assert
    should(refiled).deepEqual(['F1']);
    should(subject.stored()).match({ projectId: PROJECT, laneId: 'merged' });
    should(subject.stored().history.find(event => event.type === 'refiled')).match({
      actor: { kind: 'daemon' },
      toProject: PROJECT,
      reason: "&F1's PR #985 is in kirinnee/ferretry, which Ferretry owns",
    });
    should(subject.sessions.asked).be.empty();
  });

  it('should read the projects’ repositories itself when the boot run is handed none', async () => {
    // Arrange
    const subject = rig({ cards: [withPrs([merged(985)])] });

    // Act / Assert
    should(await subject.refiler.run()).deepEqual(['F1']);
    should(subject.stored().projectId).equal(PROJECT);
  });
});

describe('UnfiledRefiler: the folder the card’s ferret works in', () => {
  it('should refile to the board the owner ferret’s folder names, asking each ferret once per run', async () => {
    // Arrange
    const sessions = new Boards({ lead: OTHER_PROJECT });
    const subject = rig({
      cards: [unfiled(), unfiled({ id: 'F2' }), withPrs([merged(3, 'someone/else')], { id: 'F3' })],
      sessions,
    });

    // Act
    const refiled = await subject.refiler.run(REMOTES);

    // Assert
    should(refiled).deepEqual(['F1', 'F2', 'F3']);
    should(sessions.asked).deepEqual(['lead']);
    should(subject.stored('F2')).match({ projectId: OTHER_PROJECT, laneId: 'implement' });
    should(subject.stored('F3').history.find(event => event.type === 'refiled')).match({
      reason: "&F3's ferret lead works in Docs, so the card belongs on its board",
    });
  });

  it('should name a project it has no remote for as that project', async () => {
    // Arrange
    const subject = rig({ cards: [unfiled()], sessions: new Boards({ lead: OTHER_PROJECT }) });

    // Act
    await subject.refiler.run([]);

    // Assert
    should(subject.stored().history.find(event => event.type === 'refiled')).match({
      reason: "&F1's ferret lead works in that project, so the card belongs on its board",
    });
  });

  it('should leave a card whose ferret works nowhere, and ask that ferret again only after a while', async () => {
    // Arrange
    const sessions = new Boards({ lead: null, other: UNFILED_PROJECT_ID });
    const subject = rig({ cards: [unfiled(), unfiled({ id: 'F2', owner: 'other' })], sessions });

    // Act
    const first = await subject.refiler.run(REMOTES);
    const second = await subject.refiler.run(REMOTES);
    subject.clock.ms += SESSION_BOARD_RETRY_MS;
    const third = await subject.refiler.run(REMOTES);

    // Assert
    should([first, second, third]).deepEqual([[], [], []]);
    should(sessions.asked).deepEqual(['lead', 'other', 'lead', 'other']);
    should(subject.stored().projectId).equal(UNFILED_PROJECT_ID);
  });

  it('should warn once about a ferret it cannot place, and leave its card', async () => {
    // Arrange
    const sessions = new Boards({ lead: new Error('config unreadable') });
    const subject = rig({ cards: [unfiled()], sessions });

    // Act
    await subject.refiler.run(REMOTES);
    subject.clock.ms += SESSION_BOARD_RETRY_MS;
    await subject.refiler.run(REMOTES);

    // Assert
    should(subject.warnings).deepEqual(['Unfiled board: could not tell where lead works: config unreadable']);
    should(subject.stored().projectId).equal(UNFILED_PROJECT_ID);
  });
});

describe('UnfiledRefiler: what it leaves alone', () => {
  it('should leave a card that is closed, dropped, filed already, or put on the Unfiled board on purpose', async () => {
    // Arrange
    const back = withPrs([merged(985)], { id: 'F4' });
    const onPurpose: BoardTask = {
      ...back,
      history: [
        ...back.history,
        {
          seq: 2,
          at: NOW,
          actor: { kind: 'owner' },
          type: 'refiled',
          fromProject: PROJECT,
          toProject: UNFILED_PROJECT_ID,
          toLane: 'doing',
          reason: 'not ferretry work',
        },
      ],
    };
    const sessions = new Boards({ lead: PROJECT });
    const subject = rig({
      cards: [
        withPrs([merged(985)], { laneId: 'closed' }),
        withPrs([merged(985)], { id: 'F2', dropped: { reason: 'not needed', at: NOW } }),
        card({ id: 'F3', laneId: 'implement' }),
        onPurpose,
      ],
      sessions,
    });

    // Act / Assert
    should(await subject.refiler.run(REMOTES)).deepEqual([]);
    should(sessions.asked).be.empty();
    should(subject.stored('F4').projectId).equal(UNFILED_PROJECT_ID);
  });

  it('should be idempotent: a second run finds nothing to refile', async () => {
    // Arrange
    const subject = rig({ cards: [withPrs([merged(985)])], sessions: new Boards({ lead: PROJECT }) });
    await subject.refiler.run(REMOTES);
    const written = subject.store.writes.length;

    // Act / Assert
    should(await subject.refiler.run(REMOTES)).deepEqual([]);
    should(subject.store.writes).have.length(written);
  });

  it('should join a run already going rather than start a second one', async () => {
    // Arrange
    let snapshots = 0;
    const subject = rig({
      cards: [withPrs([merged(985)])],
      board: service => ({
        snapshot: async () => {
          snapshots += 1;
          return await service.snapshot();
        },
        act: async (...parameters) => await service.act(...parameters),
      }),
    });

    // Act
    const [left, right] = await Promise.all([subject.refiler.run(REMOTES), subject.refiler.run(REMOTES)]);

    // Assert
    should(left).deepEqual(['F1']);
    should(right).deepEqual(['F1']);
    should(snapshots).equal(1);
    should(subject.store.cards.get('F1')?.history.filter(event => event.type === 'refiled')).have.length(1);
  });
});

describe('UnfiledRefiler: failures', () => {
  it('should warn once about a card it cannot refile, and say when that clears', async () => {
    // Arrange
    let failing = true;
    const subject = rig({
      cards: [withPrs([merged(985)])],
      board: service => ({
        snapshot: async () => await service.snapshot(),
        act: async (...parameters) => {
          if (failing) throw new Error('store busy');
          return await service.act(...parameters);
        },
      }),
    });

    // Act
    await subject.refiler.run(REMOTES);
    await subject.refiler.run(REMOTES);
    failing = false;
    const refiled = await subject.refiler.run(REMOTES);

    // Assert
    should(subject.warnings).deepEqual(['Unfiled board: could not refile &F1: store busy']);
    should(refiled).deepEqual(['F1']);
  });

  it('should warn once when the board or the projects cannot be read, and refile nothing it cannot place', async () => {
    // Arrange
    const unreadable = rig({
      cards: [],
      board: () => ({
        snapshot: async () => Promise.reject(new Error('board damaged')),
        act: async () => Promise.reject(new Error('unreachable')),
      }),
    });
    const unlisted = rig({
      cards: [withPrs([merged(985)])],
      projects: { projects: async () => Promise.reject('registry damaged') },
    });

    // Act
    await unreadable.refiler.run();
    await unreadable.refiler.run();
    await unlisted.refiler.run();
    await unlisted.refiler.run();

    // Assert
    should(unreadable.warnings).deepEqual(['Unfiled board: could not look for cards to refile: board damaged']);
    should(unlisted.warnings).deepEqual(['Unfiled board: could not list the projects: registry damaged']);
    should(unlisted.stored().projectId).equal(UNFILED_PROJECT_ID);
  });

  it('should skip the projects entirely when no card is on the Unfiled board', async () => {
    // Arrange
    let listed = 0;
    const subject = rig({
      cards: [card()],
      projects: {
        projects: async () => {
          listed += 1;
          return [];
        },
      },
    });

    // Act / Assert
    should(await subject.refiler.run()).deepEqual([]);
    should(listed).equal(0);
  });
});

describe('readProjectRemotes', () => {
  it('should pair every project with the repository its folder names', async () => {
    // Act
    const remotes = await readProjectRemotes(
      {
        projects: async () => [
          { id: PROJECT, name: 'Ferretry', path: '/p' },
          { id: OTHER_PROJECT, name: 'Notes', path: '/notes' },
        ],
      },
      { repositoryOf: async path => (path === '/p' ? REPO : null) },
    );

    // Assert
    should(remotes).deepEqual([
      { id: PROJECT, name: 'Ferretry', repo: REPO },
      { id: OTHER_PROJECT, name: 'Notes', repo: null },
    ]);
  });
});

describe('UnfiledRefiler: the live audit after 4.147.0', () => {
  const NIX_REGISTRY = '33333333-3333-4333-8333-333333333333';
  const released = (number: number, version: string): PrLink => ({
    ...merged(number),
    releasedIn: { version, tag: `v${version}`, at: '2026-10-30T14:45:03Z' },
  });

  it('should give a project with no lanes its inferred lanes as the card’s ferret, then refile, in one pass (&I26)', async () => {
    // Arrange: nix-registry was registered before projects got lanes; its ferret's folder is in it.
    const i26 = withPrs([merged(96, 'AtomiCloud/nix-registry')], { id: 'I26', kind: 'infra', owner: 'mvuk89us' });
    const i1 = withPrs([merged(98, 'AtomiCloud/nix-registry')], { id: 'I1', kind: 'infra', owner: 'mvuk89us' });
    const subject = rig({ cards: [i26, i1], sessions: new Boards({ mvuk89us: NIX_REGISTRY }) });

    // Act
    const refiled = await subject.refiler.run([...REMOTES, { id: NIX_REGISTRY, name: 'nix-registry', repo: null }]);

    // Assert
    should(refiled).deepEqual(['I26', 'I1']);
    should(subject.proposals).deepEqual([{ projectId: NIX_REGISTRY, sessionId: 'mvuk89us' }]);
    should(subject.sets.get(NIX_REGISTRY)?.confirmedBy).be.null();
    should(subject.stored('I26')).match({ projectId: NIX_REGISTRY, laneId: 'merged' });
    should(subject.warnings).be.empty();
  });

  it('should leave the cards Unfiled and say so once when the proposal is refused, and report one that throws', async () => {
    // Arrange
    const cards = [unfiled({ owner: 'mvuk89us' }), unfiled({ id: 'F2', owner: 'mvuk89us' })];
    const refused = rig({ cards, sessions: new Boards({ mvuk89us: NIX_REGISTRY }), propose: 'refused' });
    const throws = rig({ cards, sessions: new Boards({ mvuk89us: NIX_REGISTRY }), propose: 'throws' });

    // Act
    await refused.refiler.run(REMOTES);
    refused.clock.ms += SESSION_BOARD_RETRY_MS;
    await refused.refiler.run(REMOTES);
    await throws.refiler.run(REMOTES);

    // Assert
    should(refused.warnings).deepEqual([
      `Unfiled board: could not propose lanes for project ${NIX_REGISTRY}, so its cards stay Unfiled for now`,
    ]);
    should(refused.stored().projectId).equal(UNFILED_PROJECT_ID);
    should(throws.warnings).deepEqual([
      'Unfiled board: could not refile &F1: lane store damaged',
      'Unfiled board: could not refile &F2: lane store damaged',
    ]);
  });

  it('should refile a card whose merged PRs are in a project’s repository by its PRs, at boot (&F116)', async () => {
    // Arrange: three merged, released PRs in kirinnee/ferretry; its ferret's folder names nothing.
    const f116 = withPrs([released(990, '4.128.0'), released(1048, '4.140.0'), released(1063, '4.142.0')], {
      id: 'F116',
      owner: 'mvuzx42l',
      laneId: 'to-test',
    });
    const subject = rig({ cards: [f116] });

    // Act: the boot run reads the projects' repositories itself.
    const refiled = await subject.refiler.run();

    // Assert
    should(refiled).deepEqual(['F116']);
    should(subject.stored('F116')).match({ projectId: PROJECT, laneId: 'released' });
    should(subject.stored('F116').history.find(event => event.type === 'refiled')).match({
      reason: "&F116's PR #990 is in kirinnee/ferretry, which Ferretry owns",
    });
    should(subject.sessions.asked).be.empty();
  });
});
