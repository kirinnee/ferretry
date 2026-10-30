import { describe, it } from 'bun:test';
import { type BoardTask, type PrLink, type ReleasedIn, UNFILED_PROJECT_ID } from '@ferretry/protocol';
import should from 'should';
import { BoardService } from '../../../src/lib/board/index.ts';
import {
  GH_MISSING_WARNING,
  type GhOutcome,
  GitHubWatcher,
  type GitHubWatcherPorts,
  ghSignedOutWarning,
  MAX_COMPARES_PER_TICK,
  POLL_IDLE_MS,
  POLL_OPEN_MS,
  UnfiledRefiler,
  WATCH_FIRST_TICK_MS,
  WATCH_TICK_MS,
} from '../../../src/lib/board-github/index.ts';
import type { TranscriptTailResult } from '../../../src/lib/session/reads/service.ts';
import type { TranscriptEvent } from '../../../src/lib/transcript/types.ts';
import { card, FakeLanes, lanes, MemoryBoardStore, NOW, OTHER_PROJECT, PROJECT, world } from '../board/support.ts';
import { answer, prNode, prUrl, REPO, SHA } from './support.ts';

const RELEASE: ReleasedIn = { version: '4.110.0', tag: 'v4.110.0', at: '2026-10-30T09:30:00Z' };

const link = (number: number, overrides: Partial<PrLink> = {}): PrLink => ({
  url: prUrl(number),
  number,
  repo: REPO,
  state: 'unknown',
  draft: false,
  checks: 'none',
  mergedAt: null,
  mergeSha: null,
  releasedIn: null,
  polledAt: null,
  ...overrides,
});

const withLinks = (prs: readonly PrLink[], overrides: Partial<BoardTask> = {}): BoardTask =>
  card({
    laneId: 'implement',
    workflow: 'quick',
    links: { prs: [...prs], branch: null, commits: [], docs: [] },
    ...overrides,
  });

const field = (args: readonly string[], name: string): string | undefined =>
  args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);

/** Answers `gh` by what it was asked: a repository's GraphQL poll, or a compare. */
class FakeGh {
  readonly calls: string[][] = [];
  constructor(
    public graphql: (repo: string, args: readonly string[]) => GhOutcome = () => ({ kind: 'ok', stdout: answer({}) }),
    public compare: (tag: string) => GhOutcome = () => ({ kind: 'ok', stdout: 'behind\n' }),
  ) {}

  async run(args: readonly string[]): Promise<GhOutcome> {
    this.calls.push([...args]);
    if (args[1] === 'graphql') return this.graphql(`${field(args, 'owner')}/${field(args, 'name')}`, args);
    return this.compare(decodeURIComponent(args[1]?.split('...')[1] ?? ''));
  }

  polls(): number {
    return this.calls.filter(args => args[1] === 'graphql').length;
  }

  compares(): string[] {
    return this.calls
      .filter(args => args[1] !== 'graphql')
      .map(args => decodeURIComponent(args[1]?.split('...')[1] ?? ''));
  }
}

interface Rig {
  readonly watcher: GitHubWatcher;
  readonly store: MemoryBoardStore;
  readonly gh: FakeGh;
  readonly warnings: string[];
  readonly nudges: { sessionId: string; message: string }[];
  readonly timers: { ms: number; run: () => Promise<void>; cancelled: boolean }[];
  readonly clock: { ms: number };
  readonly stored: (id?: string) => BoardTask;
}

interface RigOptions {
  readonly cards: readonly BoardTask[];
  readonly gh?: FakeGh;
  readonly folders?: Readonly<Record<string, { readonly repo: string | null; readonly branch: string | null }>>;
  readonly cwds?: Readonly<Record<string, string>>;
  readonly projects?: readonly { readonly id: string; readonly name: string; readonly path: string }[];
  readonly listProjects?: () => Promise<
    readonly { readonly id: string; readonly name: string; readonly path: string }[]
  >;
  readonly transcripts?: Readonly<Record<string, TranscriptTailResult>>;
  readonly version?: string;
  readonly failingNudges?: boolean;
  readonly board?: (service: BoardService) => GitHubWatcherPorts['board'];
  readonly lanes?: FakeLanes;
  /** The board each session's folder names, for the Unfiled refile; absent is none. */
  readonly sessionBoards?: Readonly<Record<string, string>>;
}

const rig = (options: RigOptions): Rig => {
  const store = new MemoryBoardStore(options.cards);
  const service = new BoardService(
    world({
      store,
      lanes:
        options.lanes ??
        new FakeLanes(
          new Map([
            [PROJECT, lanes(PROJECT)],
            [OTHER_PROJECT, lanes(OTHER_PROJECT, 'pr')],
            [UNFILED_PROJECT_ID, lanes(UNFILED_PROJECT_ID, 'quick')],
          ]),
        ),
    }),
  );
  const gh = options.gh ?? new FakeGh();
  const warnings: string[] = [];
  const nudges: { sessionId: string; message: string }[] = [];
  const timers: { ms: number; run: () => Promise<void>; cancelled: boolean }[] = [];
  const clock = { ms: Date.parse(NOW) };
  const folders = options.folders ?? { '/p': { repo: REPO, branch: 'main' } };
  const board = options.board?.(service) ?? service;
  const copies = {
    repositoryOf: async (path: string) => folders[path]?.repo ?? null,
    branchOf: async (path: string) => folders[path]?.branch ?? null,
  };
  const projects = {
    projects: options.listProjects ?? (async () => options.projects ?? [{ id: PROJECT, name: 'Ferretry', path: '/p' }]),
  };
  const diagnostics = { warn: (message: string) => warnings.push(message) };
  const now = () => new Date(clock.ms).toISOString();
  const watcher = new GitHubWatcher({
    board,
    gh,
    copies,
    sessions: {
      cwdOf: async sessionId => {
        if (sessionId === 'broken') throw new Error('no config');
        return options.cwds?.[sessionId] ?? null;
      },
    },
    projects,
    transcripts: {
      tail: async sessionId => {
        if (sessionId === 'broken') throw new Error('unreadable');
        return options.transcripts?.[sessionId] ?? { kind: 'unresolved' };
      },
    },
    nudges: {
      send: async (sessionId, message) => {
        if (options.failingNudges === true) throw new Error('session gone');
        nudges.push({ sessionId, message });
      },
    },
    timers: {
      after: (ms, run) => {
        const timer = { ms, run, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    },
    clock: { now, random: () => 0.5 },
    diagnostics,
    unfiled: new UnfiledRefiler({
      board,
      sessions: { boardOf: async sessionId => options.sessionBoards?.[sessionId] ?? null },
      projects,
      copies,
      clock: { now },
      diagnostics,
    }),
    version: options.version ?? '4.114.0',
  });
  return {
    watcher,
    store,
    gh,
    warnings,
    nudges,
    timers,
    clock,
    stored: (id = 'F1') => store.cards.get(id) as BoardTask,
  };
};

const repoAnswer =
  (fields: Parameters<typeof answer>[0]): ((repo: string) => GhOutcome) =>
  () => ({
    kind: 'ok',
    stdout: answer(fields),
  });

const events = (...pairs: readonly [string, string][]): TranscriptTailResult => ({
  kind: 'read',
  events: pairs.flatMap(([command, output], index) => [
    { kind: 'tool-call', call: { id: String(index), name: 'Bash', input: { command } } },
    { kind: 'tool-result', result: { callId: String(index), content: output, isError: false } },
  ]) as unknown as TranscriptEvent[],
});

describe('GitHubWatcher: polling', () => {
  it('should poll a repository once for its linked PRs, move the card, and wait a minute while one is open', async () => {
    const subject = rig({
      cards: [withLinks([link(940)]), withLinks([link(941)], { id: 'F2' })],
      gh: new FakeGh(repoAnswer({ prs: { 940: prNode(940), 941: prNode(941, { draft: true }) } })),
    });
    const report = await subject.watcher.tick();
    should(report).deepEqual({ polled: [REPO], written: ['F1', 'F2'], refiled: [], reachable: true });
    should(subject.gh.polls()).equal(1);
    should(subject.stored().laneId).equal('review');
    should(subject.stored().links.prs[0]).match({ state: 'open', checks: 'pending', polledAt: NOW });
    should(subject.stored('F2').links.prs[0]?.draft).be.true();
    // Not due again until the minute is up.
    should((await subject.watcher.tick()).polled).be.empty();
    subject.clock.ms += POLL_OPEN_MS;
    should((await subject.watcher.tick()).polled).deepEqual([REPO]);
    // Nothing new: no card is written again.
    should(subject.store.writes).have.length(2);
  });

  it('should back off to the idle pace when nothing in the repository is open', async () => {
    const merged = link(940, { state: 'merged', mergedAt: '2026-10-30T09:00:00Z', mergeSha: SHA, polledAt: NOW });
    const subject = rig({
      cards: [withLinks([merged], { laneId: 'merged' })],
      gh: new FakeGh(repoAnswer({ prs: { 940: prNode(940, { state: 'MERGED' }) }, releases: [] })),
    });
    await subject.watcher.tick();
    subject.clock.ms += POLL_OPEN_MS;
    should((await subject.watcher.tick()).polled).be.empty();
    subject.clock.ms += POLL_IDLE_MS;
    should((await subject.watcher.tick()).polled).deepEqual([REPO]);
  });

  it('should poll nothing for cards that cannot change: closed, dropped, or with nothing left to learn', async () => {
    const done = link(940, {
      state: 'merged',
      mergedAt: '2026-10-30T09:00:00Z',
      mergeSha: SHA,
      releasedIn: RELEASE,
      polledAt: NOW,
    });
    const subject = rig({
      cards: [
        withLinks([link(1)], { laneId: 'closed' }),
        withLinks([link(2)], { id: 'F2', dropped: { reason: 'gone', at: NOW } }),
        withLinks([done], { id: 'F3', laneId: 'tested' }),
        withLinks([link(4, { state: 'closed', polledAt: NOW })], { id: 'F4' }),
      ],
    });
    should(await subject.watcher.tick()).deepEqual({ polled: [], written: [], refiled: [], reachable: true });
    should(subject.gh.calls).be.empty();
  });

  it('should say once that gh is missing, keep PR state unknown, and look again at the idle pace', async () => {
    const gh = new FakeGh(() => ({ kind: 'missing' }));
    const subject = rig({ cards: [withLinks([link(940)])], gh });
    should((await subject.watcher.tick()).reachable).be.false();
    should(subject.stored().links.prs[0]?.state).equal('unknown');
    subject.clock.ms += POLL_OPEN_MS;
    should(subject.gh.polls()).equal(1);
    await subject.watcher.tick();
    should(subject.gh.polls()).equal(1);
    subject.clock.ms += POLL_IDLE_MS;
    await subject.watcher.tick();
    should(subject.gh.polls()).equal(2);
    should(subject.warnings).deepEqual([GH_MISSING_WARNING]);
    // Once it works again, a later loss is reported again.
    gh.graphql = repoAnswer({ prs: { 940: prNode(940) } });
    subject.clock.ms += POLL_IDLE_MS;
    should((await subject.watcher.tick()).reachable).be.true();
    gh.graphql = () => ({ kind: 'unauthenticated', detail: 'You are not logged into any GitHub hosts' });
    subject.clock.ms += POLL_IDLE_MS;
    await subject.watcher.tick();
    should(subject.warnings).deepEqual([
      GH_MISSING_WARNING,
      ghSignedOutWarning('You are not logged into any GitHub hosts'),
    ]);
  });

  it('should use what a failed call still answered, and warn once about a repository it could not read', async () => {
    const gh = new FakeGh(() => ({
      kind: 'failed',
      detail: 'Could not resolve to a PullRequest with the number of 941',
      stdout: answer({ prs: { 940: prNode(940) } }),
    }));
    const subject = rig({ cards: [withLinks([link(940), link(941)])], gh });
    await subject.watcher.tick();
    should(subject.stored().links.prs.map(pr => pr.state)).deepEqual(['open', 'unknown']);
    gh.graphql = () => ({ kind: 'failed', detail: 'HTTP 502', stdout: '' });
    for (const _ of [1, 2]) {
      subject.clock.ms += POLL_IDLE_MS;
      await subject.watcher.tick();
    }
    gh.graphql = () => ({ kind: 'ok', stdout: '{"data":{"repository":null}}' });
    subject.clock.ms += POLL_IDLE_MS;
    await subject.watcher.tick();
    should(subject.warnings).deepEqual([`GitHub watcher: could not poll ${REPO}: HTTP 502`]);
    gh.graphql = repoAnswer({ prs: { 940: prNode(940) } });
    subject.clock.ms += POLL_IDLE_MS;
    await subject.watcher.tick();
    gh.graphql = () => ({ kind: 'ok', stdout: '{"data":{"repository":null}}' });
    subject.clock.ms += POLL_OPEN_MS;
    await subject.watcher.tick();
    should(subject.warnings.at(-1)).equal(`GitHub watcher: could not poll ${REPO}: GitHub answered with no repository`);
  });

  it('should skip a repository name that is not owner/name, and poll at most eight repositories a tick', async () => {
    const repos = Array.from({ length: 10 }, (_, index) => `owner/repo-${String(index)}`);
    const subject = rig({
      cards: [
        withLinks([], { links: { prs: [], branch: 'feat/x', commits: [], docs: [] } }),
        ...repos.map((repo, index) =>
          withLinks([{ ...link(index + 1), url: prUrl(index + 1, repo), repo }], { id: `F${String(index + 2)}` }),
        ),
      ],
      folders: { '/p': { repo: 'not-a-repo', branch: null } },
    });
    should((await subject.watcher.tick()).polled).have.length(8);
    should((await subject.watcher.tick()).polled).have.length(2);
    should(subject.gh.calls.some(args => field(args, 'owner') === 'not-a-repo')).be.false();
  });
});

describe('GitHubWatcher: auto-link', () => {
  it("should link an open PR from the card's branch, and a merge newer than the card, but not an old or closed one", async () => {
    const subject = rig({
      cards: [withLinks([], { links: { prs: [], branch: 'feat/x', commits: [], docs: [] } })],
      gh: new FakeGh(
        repoAnswer({
          branches: [
            [
              prNode(950, { head: 'feat/x' }),
              prNode(951, { head: 'feat/x', state: 'MERGED', mergedAt: '2026-10-30T11:00:00Z' }),
              prNode(952, { head: 'feat/x', state: 'MERGED', mergedAt: '2026-10-01T00:00:00Z' }),
              prNode(953, { head: 'feat/x', state: 'CLOSED' }),
            ],
          ],
        }),
      ),
    });
    await subject.watcher.tick();
    const task = subject.stored();
    should(task.links.prs.map(pr => pr.number)).deepEqual([950, 951]);
    should(
      task.history.filter(event => event.type === 'note').map(event => (event as { text: string }).text),
    ).deepEqual([
      "PR #950 linked automatically: its head branch feat/x is the card's branch",
      "PR #951 linked automatically: its head branch feat/x is the card's branch",
    ]);
    should(task.laneId).equal('review');
    should(field(subject.gh.calls[0] ?? [], 'b0')).equal('feat/x');
  });

  it("should link from the assignee's checked-out branch only when it is that session's one card", async () => {
    const answerWith = repoAnswer({ branches: [[prNode(960, { head: 'feat/w' })]] });
    const alone = rig({
      cards: [withLinks([], { assignee: 'worker' })],
      cwds: { worker: '/w' },
      folders: { '/p': { repo: REPO, branch: 'main' }, '/w': { repo: REPO, branch: 'feat/w' } },
      gh: new FakeGh(answerWith),
    });
    await alone.watcher.tick();
    should(alone.stored().links.prs.map(pr => pr.number)).deepEqual([960]);
    should(alone.stored().history.at(2)).match({
      type: 'note',
      text: 'PR #960 linked automatically: its head branch feat/w is checked out where worker works',
    });

    const shared = rig({
      cards: [withLinks([], { assignee: 'worker' }), withLinks([], { id: 'F2', assignee: 'worker' })],
      cwds: { worker: '/w' },
      folders: { '/p': { repo: REPO, branch: 'main' }, '/w': { repo: REPO, branch: 'feat/w' } },
      gh: new FakeGh(answerWith),
    });
    await shared.watcher.tick();
    should(shared.gh.calls).be.empty();
  });

  it('should look for no branch where the session sits on a shared branch, has no folder, or cannot be read', async () => {
    const subject = rig({
      cards: [
        withLinks([], { assignee: 'on-main' }),
        withLinks([], { id: 'F2', assignee: 'nowhere' }),
        withLinks([], { id: 'F3', assignee: 'broken' }),
        withLinks([], { id: 'F4', links: { prs: [], branch: 'main', commits: [], docs: [] } }),
      ],
      cwds: { 'on-main': '/m' },
      folders: { '/p': { repo: REPO, branch: 'main' }, '/m': { repo: REPO, branch: 'main' } },
    });
    await subject.watcher.tick();
    should(subject.gh.calls).be.empty();
  });

  it("should link the PRs a session's own gh pr create printed, unless another card has them", async () => {
    const created = events(['gh pr create --fill', prUrl(970)], ['gh pr create --fill', prUrl(971)]);
    const subject = rig({
      cards: [withLinks([], { assignee: 'worker' }), withLinks([link(971)], { id: 'F2', laneId: 'closed' })],
      transcripts: { worker: created },
    });
    await subject.watcher.tick();
    should(subject.stored().links.prs.map(pr => pr.url)).deepEqual([prUrl(970)]);
    should(subject.stored().links.prs[0]?.state).equal('unknown');
    should(subject.stored().history.at(2)).match({
      text: 'PR #970 linked automatically: worker opened it with gh pr create',
    });
  });

  it('should read nothing from a transcript it cannot read', async () => {
    const subject = rig({
      cards: [withLinks([], { assignee: 'broken' }), withLinks([], { id: 'F2', assignee: 'gone' })],
      transcripts: { gone: { kind: 'unreadable' } },
    });
    should((await subject.watcher.tick()).written).be.empty();
  });
});

describe('GitHubWatcher: releases', () => {
  const merged = (overrides: Partial<PrLink> = {}) =>
    link(940, {
      state: 'merged',
      checks: 'passing',
      mergedAt: '2026-10-30T09:00:00Z',
      mergeSha: SHA,
      polledAt: NOW,
      ...overrides,
    });
  const releases = [
    { tagName: 'v4.112.0', publishedAt: '2026-10-30T12:00:00Z' },
    { tagName: 'v4.111.0', publishedAt: '2026-10-30T11:00:00Z' },
    { tagName: 'v4.110.0', publishedAt: '2026-10-30T10:00:00Z' },
    { tagName: 'v4.109.0', publishedAt: '2026-10-30T08:00:00Z' },
  ];
  const polled = repoAnswer({ prs: { 940: prNode(940, { state: 'MERGED', rollup: 'SUCCESS' }) }, releases });

  it('should cache the first release containing the merge, and move the card on as far as this machine runs', async () => {
    const gh = new FakeGh(polled, tag => ({ kind: 'ok', stdout: tag === 'v4.110.0' ? 'behind\n' : 'ahead\n' }));
    const subject = rig({ cards: [withLinks([merged()], { laneId: 'merged' })], gh, version: '4.111.0' });
    await subject.watcher.tick();
    should(gh.compares()).deepEqual(['v4.110.0', 'v4.111.0']);
    should(subject.stored().links.prs[0]?.releasedIn).deepEqual({
      version: '4.111.0',
      tag: 'v4.111.0',
      at: '2026-10-30T11:00:00Z',
    });
    should(subject.stored().laneId).equal('tested');
  });

  it('should wait in Released when this machine runs an older version, or a development build', async () => {
    for (const version of ['4.100.0', 'dev']) {
      const subject = rig({
        cards: [withLinks([merged()], { laneId: 'merged' })],
        gh: new FakeGh(polled, () => ({ kind: 'ok', stdout: 'ahead' })),
        version,
      });
      await subject.watcher.tick();
      should(subject.stored().laneId).equal('released');
    }
  });

  it('should compare each tag with a merge once, at most three per PR, and stop at an answer it cannot read', async () => {
    const gh = new FakeGh(polled);
    const subject = rig({ cards: [withLinks([merged()], { laneId: 'merged' })], gh });
    await subject.watcher.tick();
    should(gh.compares()).deepEqual(['v4.110.0', 'v4.111.0', 'v4.112.0']);
    should(subject.stored().links.prs[0]?.releasedIn).be.null();
    subject.clock.ms += POLL_IDLE_MS;
    await subject.watcher.tick();
    should(gh.compares()).have.length(3);

    const unreadable = new FakeGh(polled, () => ({ kind: 'failed', detail: 'HTTP 404', stdout: '' }));
    const other = rig({ cards: [withLinks([merged()], { laneId: 'merged' })], gh: unreadable });
    await other.watcher.tick();
    should(unreadable.compares()).deepEqual(['v4.110.0']);
  });

  it('should find the release of a PR that merged on this very poll', async () => {
    const gh = new FakeGh(polled, () => ({ kind: 'ok', stdout: 'identical' }));
    const subject = rig({ cards: [withLinks([link(940)], { laneId: 'review' })], gh });
    await subject.watcher.tick();
    should(subject.stored().links.prs[0]?.releasedIn?.version).equal('4.110.0');
    should(subject.stored().laneId).equal('tested');
  });

  it(`should spend at most ${String(MAX_COMPARES_PER_TICK)} compares a tick across every card`, async () => {
    // Each its own merge commit: a tag known not to contain one merge says nothing of another.
    const sha = (index: number) => String(index).repeat(40);
    const cards = Array.from({ length: 5 }, (_, index) =>
      withLinks([{ ...merged({ mergeSha: sha(index) }), url: prUrl(940 + index), number: 940 + index }], {
        id: `F${String(index + 1)}`,
        laneId: 'merged',
      }),
    );
    const prs = Object.fromEntries(
      cards.map((_, index) => [
        940 + index,
        prNode(940 + index, { state: 'MERGED', rollup: 'SUCCESS', sha: sha(index) }),
      ]),
    );
    const gh = new FakeGh(repoAnswer({ prs, releases }));
    const subject = rig({ cards, gh });
    await subject.watcher.tick();
    should(gh.compares()).have.length(MAX_COMPARES_PER_TICK);
  });

  it('should catch a stale card up on the next poll, with no event for it to wait on', async () => {
    const settled = link(940, { state: 'merged', mergedAt: '2026-10-30T09:00:00Z', mergeSha: SHA, polledAt: NOW });
    const subject = rig({
      cards: [withLinks([settled], { laneId: 'implement' })],
      gh: new FakeGh(repoAnswer({ prs: { 940: prNode(940, { state: 'MERGED' }) }, releases: [] })),
    });
    should((await subject.watcher.tick()).written).deepEqual(['F1']);
    should(subject.stored().laneId).equal('merged');
    const [event] = subject.stored().history.filter(entry => entry.type === 'moved');
    should(event).match({ auto: true, trigger: 'pr.merged', reason: 'PR #940 merged', actor: { kind: 'daemon' } });
  });

  it('should reconcile a card whose PRs need no polling at all, on every tick', async () => {
    const shipped = link(940, {
      state: 'merged',
      mergedAt: '2026-10-30T09:00:00Z',
      mergeSha: SHA,
      releasedIn: RELEASE,
      polledAt: NOW,
    });
    const subject = rig({
      cards: [
        withLinks([shipped], { laneId: 'implement' }),
        withLinks([{ ...shipped, url: prUrl(941), number: 941 }], { id: 'F2', laneId: 'plan' }),
      ],
      version: '4.109.0',
    });
    await subject.watcher.tick();
    should(subject.stored().laneId).equal('released');
    should(subject.stored('F2').laneId).equal('released');
    should(subject.gh.calls).be.empty();
    // The release reaches this machine: the next tick finds it, with nothing new from GitHub.
    const running = rig({ cards: [subject.stored(), subject.stored('F2')], version: '4.110.0' });
    await running.watcher.tick();
    should(running.stored().laneId).equal('tested');
    should(running.stored('F2').laneId).equal('tested');
  });

  it('should leave a card the owner sent back after its PR merged where it was sent', async () => {
    const settled = link(940, { state: 'merged', mergedAt: '2026-10-30T09:00:00Z', mergeSha: SHA, polledAt: NOW });
    const base = withLinks([settled], { laneId: 'implement' });
    const sentBack = {
      ...base,
      history: [
        ...base.history,
        {
          seq: 2,
          at: '2026-10-30T09:30:00Z',
          actor: { kind: 'owner' as const },
          type: 'moved' as const,
          from: 'tested',
          to: 'implement',
          backward: true,
          reason: 'not good',
        },
      ],
    };
    const subject = rig({
      cards: [sentBack],
      gh: new FakeGh(repoAnswer({ prs: { 940: prNode(940, { state: 'MERGED' }) }, releases: [] })),
    });
    await subject.watcher.tick();
    should(subject.stored().laneId).equal('implement');
  });

  it('should look at a PR it has never asked about at once, not when its repository is next due', async () => {
    const subject = rig({
      cards: [
        withLinks([link(940, { state: 'merged', mergedAt: '2026-10-30T09:00:00Z', mergeSha: SHA, polledAt: NOW })]),
      ],
      gh: new FakeGh(
        repoAnswer({
          prs: { 940: prNode(940, { state: 'MERGED' }), 941: prNode(941, { state: 'MERGED' }) },
          releases: [],
        }),
      ),
    });
    await subject.watcher.tick();
    should(subject.gh.polls()).equal(1);
    // The repository is now idle for ten minutes. A card imported or linked with an unknown PR is looked at anyway.
    subject.store.cards.set('F2', withLinks([link(941)], { id: 'F2' }));
    should((await subject.watcher.tick()).polled).deepEqual([REPO]);
    should(subject.stored('F2').laneId).equal('merged');
    // And only once: a PR GitHub left unknown waits for the cadence like any other.
    subject.store.cards.set('F3', withLinks([link(942)], { id: 'F3' }));
    await subject.watcher.tick();
    should(subject.gh.polls()).equal(3);
    should((await subject.watcher.tick()).polled).be.empty();
  });

  it('should pull a card in To test back to Review/CI on the next poll when an open PR sits beside the shipped one', async () => {
    const shipped = link(1008, {
      state: 'merged',
      mergedAt: '2026-10-30T09:00:00Z',
      mergeSha: SHA,
      releasedIn: RELEASE,
      polledAt: NOW,
    });
    const subject = rig({
      cards: [withLinks([shipped, link(1013)], { laneId: 'tested' })],
      gh: new FakeGh(
        repoAnswer({
          prs: {
            1008: prNode(1008, { state: 'MERGED' }),
            1013: prNode(1013, { rollup: 'FAILURE', createdAt: '2026-10-30T10:00:00Z' }),
          },
          releases: [],
        }),
      ),
      version: '4.110.0',
    });
    should((await subject.watcher.tick()).written).deepEqual(['F1']);
    should(subject.stored().laneId).equal('review');
    const moved = subject.stored().history.filter(entry => entry.type === 'moved');
    should(moved.at(-1)).match({
      from: 'tested',
      to: 'review',
      backward: true,
      auto: true,
      trigger: 'pr.ready',
      reason: 'moved back to Review/CI: PR #1013 ready for review',
    });
    // Settled: a later tick does not move it again, and does not fight it.
    subject.clock.ms += POLL_OPEN_MS * 2;
    await subject.watcher.tick();
    should(subject.stored().laneId).equal('review');
    should(subject.stored().history.filter(entry => entry.type === 'moved')).have.length(moved.length);
  });

  it('should pull a card in To test back for a parallel PR opened before the merge, and for one with no open time', async () => {
    const shipped = link(1008, {
      state: 'merged',
      mergedAt: '2026-10-30T09:00:00Z',
      mergeSha: SHA,
      releasedIn: RELEASE,
      polledAt: NOW,
    });
    const stale = rig({
      cards: [withLinks([shipped, link(1005)], { laneId: 'tested' })],
      gh: new FakeGh(
        repoAnswer({ prs: { 1008: prNode(1008, { state: 'MERGED' }), 1005: prNode(1005) }, releases: [] }),
      ),
      version: '4.110.0',
    });
    await stale.watcher.tick();
    should(stale.stored().laneId).equal('review');
    const unsaid = rig({
      cards: [withLinks([shipped, link(1013)], { laneId: 'tested' })],
      gh: new FakeGh(
        repoAnswer({
          prs: { 1008: prNode(1008, { state: 'MERGED' }), 1013: prNode(1013, { createdAt: null }) },
          releases: [],
        }),
      ),
      version: '4.110.0',
    });
    await unsaid.watcher.tick();
    should(unsaid.stored().laneId).equal('review');
  });

  it('should move a released card to To test without asking GitHub anything', async () => {
    const subject = rig({ cards: [withLinks([merged({ releasedIn: RELEASE })], { laneId: 'released' })] });
    should((await subject.watcher.tick()).written).deepEqual(['F1']);
    should(subject.stored().laneId).equal('tested');
    should(subject.gh.calls).be.empty();
  });
});

describe('GitHubWatcher: nudges and refiling', () => {
  it('should nudge the owner ferret when a PR closes unmerged, and report a nudge it could not send', async () => {
    const closed = repoAnswer({ prs: { 940: prNode(940, { state: 'CLOSED' }) } });
    const subject = rig({
      cards: [withLinks([link(940, { state: 'open', polledAt: NOW })], { laneId: 'review' })],
      gh: new FakeGh(closed),
    });
    await subject.watcher.tick();
    should(subject.nudges.map(nudge => nudge.sessionId)).deepEqual(['lead']);
    const failing = rig({
      cards: [withLinks([link(940, { state: 'open', polledAt: NOW })], { laneId: 'review' })],
      gh: new FakeGh(closed),
      failingNudges: true,
    });
    await failing.watcher.tick();
    should(failing.warnings).deepEqual(['GitHub watcher: could not nudge lead about &F1: session gone']);
  });

  it('should refile an Unfiled card to the project that owns its PR at once, and only the first such project', async () => {
    const done = link(940, { state: 'closed', polledAt: NOW });
    const subject = rig({
      cards: [withLinks([done], { projectId: UNFILED_PROJECT_ID, laneId: 'doing' })],
      projects: [
        { id: OTHER_PROJECT, name: 'Nothing', path: '/none' },
        { id: PROJECT, name: 'Ferretry', path: '/p' },
        { id: OTHER_PROJECT, name: 'Clone', path: '/clone' },
      ],
      folders: { '/p': { repo: REPO, branch: 'main' }, '/clone': { repo: REPO, branch: 'main' } },
    });
    should((await subject.watcher.tick()).refiled).deepEqual(['F1']);
    should(subject.stored()).match({ projectId: PROJECT, laneId: 'implement' });
    should(subject.stored().history.at(-1)).match({ type: 'refiled', actor: { kind: 'daemon' }, toProject: PROJECT });
  });

  it('should move a merged card on the Unfiled board to To test when no project claims it', async () => {
    // Arrange: a PR in a repository no project owns, and a ferret whose folder names no board.
    const elsewhere = link(96, {
      url: prUrl(96, 'AtomiCloud/nix-registry'),
      repo: 'AtomiCloud/nix-registry',
      state: 'merged',
      mergedAt: '2026-10-30T09:00:00Z',
      mergeSha: SHA,
      polledAt: NOW,
    });
    const subject = rig({
      cards: [withLinks([elsewhere], { projectId: UNFILED_PROJECT_ID, laneId: 'doing' })],
      gh: new FakeGh(repoAnswer({ prs: { 96: prNode(96, { repo: 'AtomiCloud/nix-registry', state: 'MERGED' }) } })),
    });

    // Act
    const report = await subject.watcher.tick();

    // Assert
    should(report.refiled).deepEqual([]);
    should(subject.stored()).match({ projectId: UNFILED_PROJECT_ID, laneId: 'to-test' });
    should(subject.stored().history.at(-1)).match({ type: 'moved', to: 'to-test', trigger: 'pr.merged' });
  });

  it('should refile an Unfiled card with no PR to the board its ferret’s folder names', async () => {
    // Arrange
    const subject = rig({
      cards: [card({ projectId: UNFILED_PROJECT_ID, laneId: 'doing', workflow: 'quick' })],
      sessionBoards: { lead: OTHER_PROJECT },
    });

    // Act / Assert
    should((await subject.watcher.tick()).refiled).deepEqual(['F1']);
    should(subject.stored()).match({ projectId: OTHER_PROJECT, laneId: 'implement' });
  });

  it('should warn once about a card it cannot refile, and about projects it cannot list', async () => {
    const subject = rig({
      cards: [
        withLinks([link(940, { state: 'closed', polledAt: NOW })], {
          projectId: UNFILED_PROJECT_ID,
          laneId: 'doing',
        }),
      ],
      lanes: new FakeLanes(new Map([[UNFILED_PROJECT_ID, lanes(UNFILED_PROJECT_ID, 'quick')]])),
    });
    await subject.watcher.tick();
    await subject.watcher.tick();
    should(subject.warnings).have.length(1);
    should(subject.warnings[0]).match(/^Unfiled board: could not refile &F1: /u);

    const unlisted = rig({ cards: [], listProjects: async () => Promise.reject(new Error('registry damaged')) });
    await unlisted.watcher.tick();
    unlisted.clock.ms += POLL_IDLE_MS;
    await unlisted.watcher.tick();
    should(unlisted.warnings).deepEqual(['GitHub watcher: could not list the projects: registry damaged']);
  });

  it('should warn once about a card it could not write, and leave a card on a board without lanes alone', async () => {
    const subject = rig({
      cards: [
        withLinks([link(940)]),
        withLinks([link(941)], { id: 'F2', projectId: '33333333-3333-4333-8333-333333333333' }),
      ],
      gh: new FakeGh(repoAnswer({ prs: { 940: prNode(940), 941: prNode(941) } })),
      board: service => ({
        snapshot: async () => await service.snapshot(),
        act: async (...parameters) => await service.act(...parameters),
        recordPullRequests: async () => Promise.reject(new Error('disk full')),
      }),
    });
    await subject.watcher.tick();
    subject.clock.ms += POLL_OPEN_MS;
    await subject.watcher.tick();
    should(subject.warnings).deepEqual(['GitHub watcher: could not update &F1: disk full']);
  });
});

describe('GitHubWatcher: the loop', () => {
  it('should look first shortly after boot, then every half minute after each look, until it is stopped', async () => {
    const subject = rig({ cards: [] });
    const stop = subject.watcher.arm();
    should(subject.timers.map(timer => timer.ms)).deepEqual([WATCH_FIRST_TICK_MS]);
    await subject.timers[0]?.run();
    should(subject.timers.map(timer => timer.ms)).deepEqual([WATCH_FIRST_TICK_MS, WATCH_TICK_MS]);
    stop();
    should(subject.timers[1]?.cancelled).be.true();
    // A timer that fires anyway, after the stop, schedules nothing more.
    await subject.timers[1]?.run();
    should(subject.timers).have.length(2);
  });

  it('should write nothing more once stopped in the middle of a tick', async () => {
    let stop: () => void = () => undefined;
    const gh = new FakeGh((_, __) => {
      stop();
      return { kind: 'ok', stdout: answer({ prs: { 940: prNode(940) } }) };
    });
    const subject = rig({
      cards: [
        withLinks([link(940)]),
        withLinks([link(1, { repo: 'other/repo', url: prUrl(1, 'other/repo') })], { id: 'F2' }),
      ],
      gh,
    });
    stop = subject.watcher.arm();
    should(await subject.watcher.tick()).match({ polled: [REPO], written: [], refiled: [] });
    should(subject.gh.polls()).equal(1);
  });

  it('should report a tick that failed and carry on', async () => {
    const subject = rig({
      cards: [],
      board: service => ({
        snapshot: async () => Promise.reject(new Error('store locked')),
        act: async (...parameters) => await service.act(...parameters),
        recordPullRequests: async (...parameters) => await service.recordPullRequests(...parameters),
      }),
    });
    should(await subject.watcher.run()).be.null();
    should(subject.warnings).deepEqual(['GitHub watcher: a tick failed: store locked']);
    const healthy = rig({ cards: [] });
    should(await healthy.watcher.run()).deepEqual({ polled: [], written: [], refiled: [], reachable: true });
  });
});
