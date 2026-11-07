import { describe, it } from 'bun:test';
import type { Card, CardEvent, Lane, PrLink } from '../../../contract/index.ts';
import should from 'should';
import {
  ACTIVE_WINDOW_MS,
  type ActivityInputs,
  BoardIndex,
  type CardAsks,
  cardStaleAfterMs,
  deriveActivities,
  isWorking,
  LivenessActivityDeriver,
  presenceOf,
  type FerretRoster,
  staleAfterMsOf,
  strongSignalAt,
} from '../../../daemon/lib/board/index.ts';
import { card, FakeSessions, lanes, liveSession, MACHINE, NOW, PROJECT, rosterOf } from './support.ts';

const NOW_MS = Date.parse(NOW);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(NOW_MS - ms).toISOString();

const laneSets = new Map([[PROJECT, lanes(PROJECT)]]);

const created = (at: string, ferret = 'lead'): CardEvent => ({
  seq: 1,
  at,
  actor: { kind: 'ferret', ferret },
  type: 'created',
  laneId: 'todo',
});

/** A card created (and last touched) `age` ago. */
const aged = (age: number, overrides: Partial<Card> = {}): Card =>
  card({ createdAt: ago(age), history: [created(ago(age))], ...overrides });

const inputsFor = (
  cards: readonly Card[],
  asks: ReadonlyMap<string, CardAsks> = new Map(),
  sets: ActivityInputs['laneSets'] = laneSets,
): ActivityInputs => ({ cards, index: new BoardIndex(cards, MACHINE), laneSets: sets, asks });

const everyoneIdle = rosterOf(['lead', 'child', 'grandchild'].map(id => liveSession(id)));

const derive = (
  cards: readonly Card[],
  roster: FerretRoster = everyoneIdle,
  asks?: ReadonlyMap<string, CardAsks>,
) => deriveActivities(inputsFor(cards, asks), roster, NOW_MS);

const merged = (mergedAt: string): PrLink => ({
  url: 'https://github.com/kirinnee/ferretry/pull/930',
  number: 930,
  repo: 'kirinnee/ferretry',
  state: 'merged',
  draft: false,
  checks: 'passing',
  mergedAt,
  mergeSha: 'a'.repeat(40),
  releasedIn: null,
  polledAt: mergedAt,
});

describe('session presence and work', () => {
  it('should read a session as dead when it is gone or finished, unknown when unreadable, else alive', () => {
    // Arrange
    const roster = rosterOf([liveSession('lead'), liveSession('done', { status: 'stopped' })], ['damaged']);

    // Assert
    should(presenceOf(roster, 'lead')).equal('alive');
    should(presenceOf(roster, 'done')).equal('dead');
    should(presenceOf(roster, 'pruned')).equal('dead');
    should(presenceOf(roster, 'damaged')).equal('unknown');
  });

  it('should call a session working while it thinks, runs a tool or works its turn, and never once finished', () => {
    // Assert
    should(isWorking(liveSession('a', { status: 'working' }))).be.true();
    should(isWorking(liveSession('a', { status: 'working' }))).be.true();
    should(isWorking(liveSession('a', { turnState: 'working' }))).be.true();
    should(isWorking(liveSession('a', { subprocessSince: ago(MINUTE) }))).be.true();
    should(isWorking(liveSession('a'))).be.false();
    should(isWorking(liveSession('a', { status: 'stopped', turnState: 'working' }))).be.false();
  });

  it('should take the latest strong signal, skipping what does not parse', () => {
    // Arrange
    const session = liveSession('a', {
      lastActivityAt: ago(HOUR),
      lastTranscriptAt: ago(3 * MINUTE),
      lastTokenAdvanceAt: 'not an instant',
      lastSubprocessAt: ago(2 * HOUR),
      subprocessSince: ago(DAY),
    });

    // Assert
    should(strongSignalAt(session)).equal(ago(3 * MINUTE));
    should(strongSignalAt(liveSession('b'))).be.undefined();
  });
});

describe('stale thresholds', () => {
  const lane = (overrides: Partial<Lane>): Lane => ({ id: 'x', name: 'X', category: 'active', ...overrides });

  it('should prefer the lane, never stale a release wait, verify or closed, and default by category', () => {
    // Assert
    should(staleAfterMsOf(lane({ staleAfter: '30m' }))).equal(30 * MINUTE);
    should(staleAfterMsOf(lane({ category: 'shipped', enterOn: ['release.published'] }))).be.null();
    should(staleAfterMsOf(lane({ category: 'shipped', enterOn: ['pr.merged'] }))).equal(3 * DAY);
    should(staleAfterMsOf(lane({ category: 'backlog' }))).equal(3 * DAY);
    should(staleAfterMsOf(lane({ category: 'active' }))).equal(2 * HOUR);
    should(staleAfterMsOf(lane({ category: 'review' }))).equal(DAY);
    should(staleAfterMsOf(lane({ category: 'verify' }))).be.null();
    should(staleAfterMsOf(lane({ category: 'closed' }))).be.null();
  });

  it("should read a card's threshold from its lane, and none for lanes this build does not know", () => {
    // Assert
    should(cardStaleAfterMs(card({ laneId: 'implement' }), { laneSets })).equal(2 * HOUR);
    should(cardStaleAfterMs(card({ laneId: 'gone' }), { laneSets })).be.null();
    should(cardStaleAfterMs(card(), { laneSets: new Map() })).be.null();
  });
});

describe('last touched', () => {
  it('should attribute a session only to its focus card, never to every card it owns', () => {
    // Arrange
    const cards = [aged(DAY, { id: 'F1' }), aged(DAY, { id: 'F2' })];
    const roster = rosterOf([liveSession('lead', { focusCard: { id: 'F2' }, lastTranscriptAt: ago(MINUTE) })]);

    // Act
    const activity = derive(cards, roster);

    // Assert
    should(activity.get('F1')).eql({ lastTouchedAt: ago(DAY), touchedBy: 'lead', activity: 'idle' });
    should(activity.get('F2')).eql({ lastTouchedAt: ago(MINUTE), touchedBy: 'lead', activity: 'active' });
  });

  it('should ignore a focus on another machine and a session with no signals', () => {
    // Arrange
    const cards = [aged(HOUR, { id: 'F1' })];
    const roster = rosterOf([
      liveSession('child', { focusCard: { id: 'F1', machineId: 'mac' }, lastTranscriptAt: ago(MINUTE) }),
      liveSession('lead', { focusCard: { id: 'F1' } }),
    ]);

    // Act
    const activity = derive(cards, roster);

    // Assert
    should(activity.get('F1')).eql({ lastTouchedAt: ago(HOUR), touchedBy: 'lead', activity: 'idle' });
  });

  it('should count every history event, a daemon one by nobody, and a PR merge', () => {
    // Arrange
    const noted = aged(DAY, {
      id: 'F1',
      history: [created(ago(DAY)), { seq: 2, at: ago(HOUR), actor: { kind: 'daemon' }, type: 'note', text: 'polled' }],
    });
    const shipped = aged(DAY, {
      id: 'F2',
      links: { prs: [merged(ago(MINUTE * 30))], branch: null, commits: [], docs: [] },
    });
    const unmerged = aged(DAY, {
      id: 'F3',
      links: {
        prs: [{ ...merged(ago(MINUTE)), state: 'open', mergedAt: null, mergeSha: null }],
        branch: null,
        commits: [],
        docs: [],
      },
    });

    // Act
    const activity = derive([noted, shipped, unmerged]);

    // Assert
    should(activity.get('F1')).match({ lastTouchedAt: ago(HOUR), touchedBy: null });
    should(activity.get('F2')).match({ lastTouchedAt: ago(MINUTE * 30), touchedBy: null });
    should(activity.get('F3')).match({ lastTouchedAt: ago(DAY), touchedBy: 'lead' });
  });

  it('should roll every live descendant up into the parent, but no dropped one', () => {
    // Arrange
    const parent = aged(DAY, { id: 'F1' });
    const child = aged(DAY, { id: 'F2', parent: { id: 'F1' }, assignee: 'child' });
    const grandchild = aged(DAY, { id: 'F3', parent: { id: 'F2' }, assignee: 'grandchild' });
    const dropped = aged(MINUTE, {
      id: 'F4',
      parent: { id: 'F1' },
      dropped: { reason: 'superseded', at: ago(MINUTE) },
    });
    const roster = rosterOf([
      liveSession('lead'),
      liveSession('child'),
      liveSession('grandchild', { focusCard: { id: 'F3' }, lastTokenAdvanceAt: ago(10 * MINUTE) }),
    ]);

    // Act
    const activity = derive([parent, child, grandchild, dropped], roster);

    // Assert
    should(activity.get('F1')).eql({ lastTouchedAt: ago(10 * MINUTE), touchedBy: 'grandchild', activity: 'idle' });
    should(activity.get('F2')).match({ lastTouchedAt: ago(10 * MINUTE), touchedBy: 'grandchild' });
  });

  it('should make the parent active while any descendant works', () => {
    // Arrange
    const parent = aged(DAY, { id: 'F1', laneId: 'implement' });
    const child = aged(DAY, { id: 'F2', parent: { id: 'F1' }, assignee: 'child' });
    const roster = rosterOf([
      liveSession('lead'),
      liveSession('child', { focusCard: { id: 'F2' }, status: 'working' }),
    ]);

    // Act
    const activity = derive([parent, child], roster);

    // Assert
    should(activity.get('F1')?.activity).equal('active');
    should(activity.get('F2')?.activity).equal('active');
  });

  it('should walk a loop in parent once and still answer for every card', () => {
    // Arrange
    const one = aged(HOUR, { id: 'F1', parent: { id: 'F2' } });
    const two = aged(2 * HOUR, { id: 'F2', parent: { id: 'F1' } });

    // Act
    const activity = derive([one, two]);

    // Assert
    should(activity.get('F1')?.lastTouchedAt).equal(ago(HOUR));
    should(activity.get('F2')?.lastTouchedAt).equal(ago(HOUR));
  });
});

describe('two sessions on one card', () => {
  it('should be touched by whichever of them signalled last', () => {
    // Arrange
    const roster = rosterOf([
      liveSession('lead', { focusCard: { id: 'F1' }, lastTranscriptAt: ago(HOUR) }),
      liveSession('child', { focusCard: { id: 'F1' }, lastTranscriptAt: ago(30 * MINUTE) }),
    ]);

    // Act
    const activity = derive([aged(DAY)], roster);

    // Assert
    should(activity.get('F1')).match({ lastTouchedAt: ago(30 * MINUTE), touchedBy: 'child' });
  });
});

describe('the activity state', () => {
  it('should be active within two minutes of a strong signal, and idle after', () => {
    // Arrange
    const cards = [aged(HOUR, { id: 'F1', laneId: 'implement' }), aged(HOUR, { id: 'F2', laneId: 'implement' })];
    const roster = rosterOf([
      liveSession('lead', { focusCard: { id: 'F1' }, lastTranscriptAt: ago(ACTIVE_WINDOW_MS) }),
      liveSession('child', { focusCard: { id: 'F2' }, lastTranscriptAt: ago(ACTIVE_WINDOW_MS + 1) }),
    ]);

    // Act
    const activity = derive(cards, roster);

    // Assert
    should(activity.get('F1')?.activity).equal('active');
    should(activity.get('F2')?.activity).equal('idle');
  });

  it('should never wait (docs/board.md § Cards show progress): a block, an unfinished blocker or an open card ask leave it idle, never stale', () => {
    // Arrange
    const ask = { ferret: 'lead', id: 'A9' };
    const cards = [
      aged(5 * DAY, { id: 'F1', blocked: { on: 'external', reason: 'vendor', since: ago(DAY) } }),
      aged(5 * DAY, { id: 'F2', dependsOn: [{ task: { id: 'F5' }, until: 'shipped' }] }),
      aged(5 * DAY, { id: 'F3' }),
      aged(5 * DAY, { id: 'F4' }),
      aged(HOUR, { id: 'F5' }),
    ];
    const asks = new Map([
      ['F3', { open: [ask], asking: [ask] }],
      ['F4', { open: [ask], asking: [] }],
    ]);

    // Act
    const activity = derive(cards, everyoneIdle, asks);

    // Assert
    should(['F1', 'F2', 'F3', 'F4'].map(id => activity.get(id)?.activity)).eql(['idle', 'idle', 'idle', 'stale']);
  });

  it("should go stale past its lane's threshold, never in verify, a release wait, closed or dropped", () => {
    // Arrange
    const cards = [
      aged(4 * DAY, { id: 'F1', laneId: 'todo' }),
      aged(DAY, { id: 'F2', laneId: 'todo' }),
      aged(3 * HOUR, { id: 'F3', laneId: 'implement' }),
      aged(30 * DAY, { id: 'F4', laneId: 'tested' }),
      aged(30 * DAY, { id: 'F5', laneId: 'released' }),
      aged(30 * DAY, { id: 'F6', laneId: 'closed' }),
      aged(30 * DAY, { id: 'F7', dropped: { reason: 'no', at: ago(DAY) } }),
      aged(4 * DAY, { id: 'F8', laneId: 'merged' }),
    ];

    // Act
    const activity = derive(cards);

    // Assert
    should(cards.map(each => activity.get(each.id)?.activity)).eql([
      'stale',
      'idle',
      'stale',
      'idle',
      'idle',
      'idle',
      'idle',
      'stale',
    ]);
  });

  it('should never be stale on a board whose lanes this build does not know', () => {
    // Act
    const activity = deriveActivities(inputsFor([aged(30 * DAY)], new Map(), new Map()), everyoneIdle, NOW_MS);

    // Assert
    should(activity.get('F1')?.activity).equal('idle');
  });

  it('should orphan an active or review card whose ferret is gone and that has no live descendant', () => {
    // Arrange
    const roster = rosterOf([liveSession('lead'), liveSession('done', { status: 'stopped' })], ['damaged']);
    const cards = [
      aged(MINUTE, { id: 'F1', laneId: 'implement', assignee: 'done' }),
      aged(MINUTE, { id: 'F2', laneId: 'review', assignee: 'pruned' }),
      aged(MINUTE, { id: 'F3', laneId: 'implement', assignee: 'done' }),
      aged(MINUTE, { id: 'F4', parent: { id: 'F3' }, assignee: 'lead' }),
      aged(MINUTE, { id: 'F5', laneId: 'implement', assignee: 'damaged' }),
      aged(4 * DAY, { id: 'F6', laneId: 'todo', assignee: 'done' }),
      aged(MINUTE, {
        id: 'F7',
        laneId: 'implement',
        assignee: 'done',
        blocked: { on: 'external', reason: 'vendor', since: NOW },
      }),
      aged(MINUTE, { id: 'F8', laneId: 'implement', assignee: 'done' }),
      aged(MINUTE, {
        id: 'F9',
        parent: { id: 'F8' },
        assignee: 'lead',
        dropped: { reason: 'no', at: NOW },
      }),
    ];

    // Act
    const activity = derive(cards, roster);

    // Assert
    should(['F1', 'F2', 'F3', 'F5', 'F6', 'F7', 'F8'].map(id => activity.get(id)?.activity)).eql([
      'orphaned',
      'orphaned',
      'idle',
      'idle',
      'stale',
      'orphaned',
      'orphaned',
    ]);
  });

  it('should orphan a card whose only child is an unassigned Todo card, but not one with an assigned or started child', () => {
    // Arrange — the lead owns every card and is alive; the reviewer finished.
    const roster = rosterOf([liveSession('lead'), liveSession('reviewer', { status: 'stopped' })]);
    const cards = [
      aged(MINUTE, { id: 'F1', laneId: 'review', assignee: 'reviewer' }),
      aged(MINUTE, { id: 'F2', parent: { id: 'F1' } }),
      aged(MINUTE, { id: 'F3', laneId: 'review', assignee: 'reviewer' }),
      aged(MINUTE, { id: 'F4', parent: { id: 'F3' }, assignee: 'lead' }),
      aged(MINUTE, { id: 'F5', laneId: 'review', assignee: 'reviewer' }),
      aged(MINUTE, { id: 'F6', parent: { id: 'F5' }, laneId: 'implement' }),
    ];

    // Act
    const activity = derive(cards, roster);

    // Assert
    should(['F1', 'F3', 'F5'].map(id => activity.get(id)?.activity)).eql(['orphaned', 'idle', 'idle']);
  });

  it('should read active before waiting', () => {
    // Arrange
    const cards = [aged(HOUR, { blocked: { on: 'external', reason: 'vendor', since: NOW } })];
    const roster = rosterOf([liveSession('lead', { focusCard: { id: 'F1' }, status: 'working' })]);

    // Act
    const activity = derive(cards, roster);

    // Assert
    should(activity.get('F1')?.activity).equal('active');
  });
});

describe('the liveness activity deriver', () => {
  it('should read the roster once per derivation and judge it at the clock', async () => {
    // Arrange
    const sessions = new FakeSessions(rosterOf([liveSession('lead')]));
    const deriver = new LivenessActivityDeriver({ sessions, clock: { now: () => NOW } });
    const cards = [aged(4 * DAY, { id: 'F1' }), aged(HOUR, { id: 'F2' }), aged(HOUR, { id: 'F3' })];

    // Act
    const activity = await deriver.derive(inputsFor(cards));

    // Assert
    should(sessions.reads).equal(1);
    should(activity.get('F1')?.activity).equal('stale');
    should(activity.get('F2')?.activity).equal('idle');
  });
});
